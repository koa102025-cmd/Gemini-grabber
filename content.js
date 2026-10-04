console.log("--- Gemini Grabber content script LOADED ---");

// Структура и поведение проверены вживую на gemini.google.com:
//
//   infinite-scroller.chat-history — контейнер переписки. Старые сообщения
//     подгружаются порциями по 10 при прокрутке вверх (batchexecute), но
//     уже загруженные из DOM НЕ выгружаются — счётчик растёт монотонно.
//   .conversation-container — одна пара "вопрос-ответ"
//     > user-query     — сообщение пользователя
//     > model-response — ответ модели, текст внутри message-content
//       > model-thoughts — блок рассуждений, в ответ не входит
//
// Две ловушки, на которых ломается наивная реализация:
//
// 1. У .conversation-container стоит content-visibility: auto — Chrome
//    пропускает отрисовку сообщений вне экрана, и innerText возвращает для
//    них пустую строку, хотя текст есть в DOM (textContent его видит).
//    Поэтому на время сбора отрисовку принудительно включаем.
// 2. После подгрузки scrollTop НЕ остаётся нулевым: скроллер удерживает
//    визуальную позицию, подставляя контент сверху. "Дошли до начала"
//    определяется остановкой роста числа сообщений, а не scrollTop === 0.
const SELECTORS = {
	SCROLLER: "infinite-scroller.chat-history",
	SCROLLER_FALLBACK: "infinite-scroller",
	CONTAINER: ".conversation-container",
	RESPONSE: "model-response",
	TEXT: "message-content",
	TEXT_FALLBACK: ".model-response-text",
	THOUGHTS: "model-thoughts",
};

// Слова-лигатуры иконок Material Symbols и подписи кнопок: визуально это
// значки, но в текст они попадают как обычные слова.
const UI_NOISE = new Set([
	"content_copy",
	"thumb_up",
	"thumb_down",
	"more_vert",
	"edit",
	"share",
	"expand_more",
	"expand_less",
	"refresh",
	"volume_up",
	"tune",
	"check",
	"done",
	"copy code",
	"копировать код",
	"развернуть",
	"свернуть",
]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// FNV-1a: короткий отпечаток сообщения, чтобы помнить уже скопированное
// и не хранить в storage весь текст чата.
function hashText(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16);
}

// --- Чтение текста -------------------------------------------------------

// Снимает content-visibility на время чтения, иначе сообщения вне экрана
// не отрисованы и innerText по ним пустой.
function withForcedRendering(fn) {
	const style = document.createElement("style");
	style.id = "gemini-grabber-force-render";
	style.textContent =
		".conversation-container, model-response, message-content" +
		" { content-visibility: visible !important; }";
	document.documentElement.appendChild(style);

	try {
		// innerText синхронно вызывает пересчёт раскладки, поэтому к моменту
		// возврата из fn() текст уже прочитан и стиль можно снимать.
		return fn();
	} finally {
		style.remove();
	}
}

// Запасной обход DOM, если отрисовки всё равно нет. В отличие от innerText
// не зависит от раскладки, но переносы строк приходится расставлять самим.
function textFromDom(root) {
	const BLOCK =
		/^(P|DIV|LI|UL|OL|H[1-6]|PRE|BLOCKQUOTE|TABLE|TR|SECTION|ARTICLE|HEADER|FOOTER|CODE-BLOCK|RESPONSE-ELEMENT|MESSAGE-CONTENT)$/;
	let out = "";

	(function walk(node) {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.nodeValue;
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;

		const tag = node.tagName;
		if (tag === "SCRIPT" || tag === "STYLE") return;
		if (node.getAttribute("aria-hidden") === "true") return;
		if (
			node.classList &&
			(node.classList.contains("material-symbols-outlined") ||
				node.classList.contains("cdk-visually-hidden"))
		) {
			return;
		}

		if (tag === "BR") {
			out += "\n";
			return;
		}

		const isBlock = BLOCK.test(tag);
		if (isBlock && out && !out.endsWith("\n")) out += "\n";
		node.childNodes.forEach(walk);
		if (isBlock && out && !out.endsWith("\n")) out += "\n";
	})(root);

	return out;
}

function readText(el) {
	const rendered = el.innerText;
	if (rendered && rendered.trim()) return rendered;
	return textFromDom(el);
}

function cleanupText(raw) {
	return String(raw || "")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.filter((line) => !UI_NOISE.has(line.trim().toLowerCase()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// Текст одного ответа модели. Вызывать внутри withForcedRendering.
function extractFromContainer(container) {
	const response = container.querySelector(SELECTORS.RESPONSE);
	if (!response) return "";

	let nodes = response.querySelectorAll(SELECTORS.TEXT);
	if (!nodes.length) nodes = response.querySelectorAll(SELECTORS.TEXT_FALLBACK);

	const parts = [];
	nodes.forEach((node) => {
		// Рассуждения модели ("Показать рассуждения") — это не ответ
		if (node.closest(SELECTORS.THOUGHTS)) return;
		const text = cleanupText(readText(node));
		if (text) parts.push(text);
	});

	return parts.join("\n\n").trim();
}

// Все ответы модели из DOM в порядке переписки.
function extractAllResponses() {
	const out = [];
	document.querySelectorAll(SELECTORS.CONTAINER).forEach((container) => {
		const text = extractFromContainer(container);
		if (text) out.push(text);
	});
	return out;
}

// --- Догрузка истории ----------------------------------------------------

function findScroller() {
	const direct =
		document.querySelector(SELECTORS.SCROLLER) ||
		document.querySelector(SELECTORS.SCROLLER_FALLBACK);
	if (direct) return direct;

	// Запасной поиск: ближайший скроллящийся предок сообщений
	let cur = document.querySelector(SELECTORS.CONTAINER);
	while (cur) {
		const style = getComputedStyle(cur);
		if (
			cur.scrollHeight > cur.clientHeight + 5 &&
			/auto|scroll/.test(style.overflowY)
		) {
			return cur;
		}
		cur = cur.parentElement;
	}
	return null;
}

function countContainers() {
	return document.querySelectorAll(SELECTORS.CONTAINER).length;
}

function countResponses() {
	return document.querySelectorAll(SELECTORS.RESPONSE).length;
}

async function waitForGrowth(prevCount, maxMs) {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		await sleep(150);
		if (countContainers() > prevCount) return true;
	}
	return false;
}

// Хватит ли уже загруженного, чтобы не листать дальше вверх?
// Проверки нарочно дешёвые: полное чтение текста дорогое (пересчёт
// раскладки всей переписки), поэтому делаем его один раз в конце.
function enoughLoaded({ mode, limit, knownHashes }) {
	if (mode === "last") {
		return countResponses() >= limit;
	}

	if (mode === "new") {
		const first = document.querySelector(SELECTORS.CONTAINER);
		if (!first) return false;
		// Самое старое из загруженных уже копировали — значит всё, что
		// выше, тоже старое, и листать дальше незачем.
		const text = withForcedRendering(() => extractFromContainer(first));
		return !!text && knownHashes.has(hashText(text));
	}

	return false; // режим "весь чат" — листаем до самого начала
}

function reportProgress(count) {
	try {
		const p = chrome.runtime.sendMessage({ action: "PROGRESS", count });
		if (p && typeof p.catch === "function") p.catch(() => {});
	} catch (e) {
		// попап закрыт — продолжаем работу
	}
}

async function collectAnswers({ mode, limit, strip, unwrap, knownHashes }) {
	const scroller = findScroller();
	if (!scroller) {
		return { error: "NO_CHAT" };
	}

	const deadline = Date.now() + 180000;
	let idle = 0;

	reportProgress(countResponses());

	while (Date.now() < deadline) {
		if (enoughLoaded({ mode, limit, knownHashes })) break;

		const before = countContainers();
		scroller.scrollTop = 0;
		const grew = await waitForGrowth(before, 5000);

		reportProgress(countResponses());

		if (grew) {
			idle = 0;
		} else {
			// Ничего не подгрузилось — вероятно, начало чата.
			// Пробуем ещё раз, прежде чем останавливаться.
			idle++;
			if (idle >= 2) break;
		}
	}

	const reachedStart = idle >= 2;

	const messages = withForcedRendering(() => extractAllResponses());

	// Возвращаем пользователя к свежим сообщениям — мы увели его вверх
	scroller.scrollTop = scroller.scrollHeight;

	if (messages.length === 0) {
		return { error: "NO_MESSAGES" };
	}

	let selected = messages;

	if (mode === "new") {
		let lastKnownIdx = -1;
		messages.forEach((text, i) => {
			if (knownHashes.has(hashText(text))) lastKnownIdx = i;
		});
		selected = messages.slice(lastKnownIdx + 1);

		if (selected.length === 0) {
			return { error: "NO_NEW", totalInChat: messages.length };
		}
	}

	if (mode === "last") {
		selected = selected.slice(-limit);
	}

	// Отпечатки считаем по исходному тексту, а оформление применяем уже к
	// результату — иначе галочки сбивали бы отметку "уже скопировано".
	const hashes = selected.map(hashText);

	let output = selected;
	if (unwrap) output = output.map(unwrapParagraphs);
	if (strip) output = output.map(stripMarkdown);

	return {
		messages: output,
		hashes,
		totalInChat: messages.length,
		reachedStart,
	};
}

// --- Оформление результата ----------------------------------------------

// Склеивает строки, разорванные посреди абзаца: одиночный перенос внутри
// абзаца → пробел, пустая строка между абзацами сохраняется.
function unwrapParagraphs(text) {
	const STARTS_NEW_LINE = /^\s*(?:[-*+>#|•]|\d+[.)]\s|—|–)/;
	const WRAPPED_MIN_LENGTH = 55;

	const lines = text.split("\n");
	const out = [];
	let prevSourceLength = -1;

	lines.forEach((line) => {
		const trimmed = line.trim();
		const canJoin =
			out.length > 0 &&
			prevSourceLength >= WRAPPED_MIN_LENGTH &&
			trimmed.length > 0 &&
			!STARTS_NEW_LINE.test(line);

		if (canJoin) {
			out[out.length - 1] =
				out[out.length - 1].replace(/\s+$/, "") + " " + trimmed;
		} else {
			out.push(line);
		}

		prevSourceLength = trimmed.length;
	});

	return out.join("\n");
}

// Убирает markdown-разметку, если модель выдала её буквально.
function stripMarkdown(text) {
	let out = text;

	out = out.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
	out = out.replace(/`([^`\n]+)`/g, "$1");
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

	// Запрет пробела рядом со звёздочкой, иначе "2 * 3 = 6" станет "2  3 = 6"
	out = out.replace(/\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*/g, "$1");
	out = out.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, "$1");
	out = out.replace(
		/(^|[\s(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[\s).,!?:;]|$)/gm,
		"$1$2",
	);
	out = out.replace(/___(?!\s)([^_\n]+?)(?<!\s)___/g, "$1");
	out = out.replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, "$1");
	out = out.replace(
		/(^|[\s(])_(?!\s)([^_\n]+?)(?<!\s)_(?=[\s).,!?:;]|$)/gm,
		"$1$2",
	);
	out = out.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "$1");

	// Именно [ \t], а не \s: \s включает перенос строки и съедал бы пустые
	// строки между абзацами.
	out = out.replace(/^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
	out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
	out = out.replace(/^[ \t]{0,3}>+[ \t]?/gm, "");
	out = out.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1");

	out = out.replace(/\n{3,}/g, "\n\n");

	return out.trim();
}

// --- Память о скопированном ---------------------------------------------

function storageKey() {
	return "chat:" + location.pathname;
}

function loadKnownHashes() {
	return new Promise((resolve) => {
		const key = storageKey();
		chrome.storage.local.get({ [key]: [] }, (data) => {
			resolve(new Set(data[key] || []));
		});
	});
}

function saveKnownHashes(knownHashes, newHashes) {
	return new Promise((resolve) => {
		const key = storageKey();
		const merged = Array.from(new Set([...knownHashes, ...newHashes])).slice(
			-5000,
		);
		chrome.storage.local.set({ [key]: merged }, resolve);
	});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === "GET_MESSAGES") {
		(async () => {
			try {
				const knownHashes = await loadKnownHashes();
				const result = await collectAnswers({
					mode: request.mode || "all",
					limit: request.limit || 10,
					strip: !!request.strip,
					unwrap: !!request.unwrap,
					knownHashes,
				});

				if (result.messages) {
					await saveKnownHashes(knownHashes, result.hashes);
				}

				sendResponse(result);
			} catch (err) {
				console.error("Ошибка сбора чата:", err);
				sendResponse({ error: "EXCEPTION", detail: String(err) });
			}
		})();
		return true; // ответ придёт асинхронно
	}

	if (request.action === "RESET_STATE") {
		chrome.storage.local.remove(storageKey(), () => sendResponse({ ok: true }));
		return true;
	}

	return true;
});
