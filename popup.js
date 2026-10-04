const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const limitEl = document.getElementById("limit");
const limitRow = document.getElementById("limitRow");
const stripEl = document.getElementById("strip");
const unwrapEl = document.getElementById("unwrap");

// Запоминаем настройки между открытиями попапа
chrome.storage.local.get(
	{ ui_mode: "new", ui_limit: 10, ui_strip: false, ui_unwrap: false },
	(data) => {
		modeEl.value = data.ui_mode;
		limitEl.value = data.ui_limit;
		stripEl.checked = data.ui_strip;
		unwrapEl.checked = data.ui_unwrap;
		limitRow.style.display = modeEl.value === "last" ? "block" : "none";
	},
);

modeEl.addEventListener("change", () => {
	limitRow.style.display = modeEl.value === "last" ? "block" : "none";
	chrome.storage.local.set({ ui_mode: modeEl.value });
});

limitEl.addEventListener("change", () => {
	chrome.storage.local.set({ ui_limit: Number(limitEl.value) || 10 });
});

stripEl.addEventListener("change", () => {
	chrome.storage.local.set({ ui_strip: stripEl.checked });
});

unwrapEl.addEventListener("change", () => {
	chrome.storage.local.set({ ui_unwrap: unwrapEl.checked });
});

// Прогресс от content script во время прокрутки
chrome.runtime.onMessage.addListener((msg) => {
	if (msg.action === "PROGRESS") {
		statusEl.innerText = `Листаю чат... загружено ответов: ${msg.count}`;
	}
});

async function getActiveTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
}

document.getElementById("grabBtn").addEventListener("click", async () => {
	statusEl.innerText = "Листаю чат (не закрывай попап)...";

	try {
		const tab = await getActiveTab();
		if (!tab) {
			statusEl.innerText = "Вкладка не найдена";
			return;
		}

		const request = {
			action: "GET_MESSAGES",
			mode: modeEl.value,
			limit: Number(limitEl.value) || 10,
			strip: stripEl.checked,
			unwrap: unwrapEl.checked,
		};

		chrome.tabs.sendMessage(tab.id, request, (response) => {
			if (chrome.runtime.lastError) {
				console.error("Ошибка связи:", chrome.runtime.lastError);
				statusEl.innerText = "Ошибка связи. Обнови (F5) страницу Gemini";
				return;
			}

			if (response && response.error === "NO_CHAT") {
				statusEl.innerText =
					"Не нашёл окно чата. Открой переписку в Gemini и обнови страницу.";
				return;
			}

			if (response && response.error === "NO_NEW") {
				statusEl.innerText = `Новых ответов нет (загружено: ${response.totalInChat}).`;
				return;
			}

			if (response && response.error === "NO_MESSAGES") {
				statusEl.innerText = "Ответы модели не найдены.";
				return;
			}

			if (response && response.error === "EXCEPTION") {
				statusEl.innerText = "Ошибка: " + response.detail;
				return;
			}

			if (response && response.messages && response.messages.length > 0) {
				const count = response.messages.length;
				const finalText = response.messages.join("\n\n---\n\n");

				navigator.clipboard.writeText(finalText).then(() => {
					let note = `Готово! Скопировано: ${count} из ${response.totalInChat} загруженных ответов.`;
					if (modeEl.value === "all" && !response.reachedStart) {
						note += "\n(остановился по лимиту времени — возможно, собрано не всё)";
					}
					statusEl.innerText = note;
				});
			} else {
				statusEl.innerText = "Ответы модели не найдены.";
			}
		});
	} catch (e) {
		statusEl.innerText = "Ошибка системы.";
		console.error(e);
	}
});

document.getElementById("resetBtn").addEventListener("click", async () => {
	const tab = await getActiveTab();
	if (!tab) return;

	chrome.tabs.sendMessage(tab.id, { action: "RESET_STATE" }, () => {
		if (chrome.runtime.lastError) {
			statusEl.innerText = "Ошибка связи. Обнови (F5) страницу Gemini";
			return;
		}
		statusEl.innerText =
			"Отметка сброшена — следующий сбор «только новые» возьмёт весь чат.";
	});
});
