console.log("--- Content script LOADED (No Duplicates Version) ---");

function collectEverything() {
	// 1. Ищем блоки. Чтобы не было дублей, лучше искать только самый глубокий элемент с текстом.
	// Но так как структура может меняться, мы используем Set для очистки.
	const responseBlocks = document.querySelectorAll(
		"message-content, .model-response-text",
	);

	if (responseBlocks.length === 0) {
		console.log("Блоки не найдены.");
		return [];
	}

	// 2. Используем Set, чтобы хранить только уникальные тексты
	const uniqueMessages = new Set();

	responseBlocks.forEach((block) => {
		const text = block.innerText.trim();
		if (text.length > 0) {
			uniqueMessages.add(text);
		}
	});

	// 3. Превращаем Set обратно в массив
	const results = Array.from(uniqueMessages);

	console.log(`Найдено уникальных сообщений: ${results.length}`);
	return results;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === "GET_MESSAGES") {
		const results = collectEverything();
		sendResponse({ messages: results });
	}
	return true;
});
