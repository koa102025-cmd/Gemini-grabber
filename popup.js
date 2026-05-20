document.getElementById("grabBtn").addEventListener("click", async () => {
	const status = document.getElementById("status");
	status.innerText = "Листаю чат до начала (подождите)...";

	try {
		// 1. Находим активную вкладку
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});

		if (!tab) {
			status.innerText = "Вкладка не найдена";
			return;
		}

		// 2. Посылаем запрос
		chrome.tabs.sendMessage(tab.id, { action: "GET_MESSAGES" }, (response) => {
			// Проверяем на ошибки связи
			if (chrome.runtime.lastError) {
				console.error("Ошибка связи:", chrome.runtime.lastError);
				status.innerText = "Ошибка связи. Обнови (F5) страницу чата";
				return;
			}

			// 3. Обрабатываем ответ
			if (response && response.messages && response.messages.length > 0) {
				const count = response.messages.length;
				status.innerText = `Успешно! Собрано: ${count}`;

				// Склеиваем текст
				const finalText = response.messages.join("\n\n---\n\n");

				// Копируем в буфер
				navigator.clipboard.writeText(finalText).then(() => {
					alert("Готово! Все ответы в буфере обмена.");
				});
			} else {
				status.innerText = "Сообщения не найдены. Чат пуст?";
			}
		});
	} catch (e) {
		status.innerText = "Ошибка системы.";
		console.error(e);
	}
});
