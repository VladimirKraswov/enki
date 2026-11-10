// Compact per-turn policy for small local models: the full blocks are precise
// but long, and a small model follows a short checklist much better. The rules
// stay the same; only the wording is compressed. Cloud models keep full text.

export const compactToolWorkflowReminder = (sessionId: string) => `<arvela-tool-workflow-v1 session="${encodeURIComponent(sessionId)}">
Работа с инструментами: при ошибке сначала прочитай её точную причину. Не повторяй ту же команду, правку или ввод без новых данных. Сохраняй код завершения сборки/теста, даже если сокращаешь вывод. После двух неудач одной гипотезы собери новые данные. Зелёная компиляция не доказывает работу сценария: проверь наблюдаемый результат.
</arvela-tool-workflow-v1>`;

export const compactWorkQualityReminder = (sessionId: string) => `<enki-work-quality-v1 session="${encodeURIComponent(sessionId)}">
Порядок работы: перед действиями напиши план из 2–4 пунктов. Делай один небольшой законченный сценарий и проверяй его. «Готово» — только после проверки именно этого требования (тест, команда, просмотр результата). Разделяй факт и гипотезу. В итоге назови, что проверено и что осталось непроверенным. Не обещай отсутствие багов.
</enki-work-quality-v1>`;

export const compactUserWaitReminder = (sessionId: string) => `<enki-user-wait-v1 session="${encodeURIComponent(sessionId)}">
Если для продолжения нужно действие или решение владельца, напиши, какое именно, и спроси через question. Не жди человека в shell sleep или циклах проверок. Перед долгой операцией коротко скажи, что делаешь и какой результат ожидается. Сообщай о значимом прогрессе и препятствиях.
</enki-user-wait-v1>`;

export const compactScheduleReminder = (sessionId: string, directory: string) => `<enki-schedules-v1 session="${encodeURIComponent(sessionId)}">
Таймеры Enki: для «следи», «дождись» или «сделай позже» используй desktop_schedule (MCP enki-schedules). session_id=${JSON.stringify(sessionId)}, directory=${JSON.stringify(directory)}. Сначала list, затем create: mode=repeat с minutes (обычно 5–15) или mode=once; run_at — Unix миллисекунды; request_key — стабильное имя. По завершении наблюдения удали таймер через remove. Не создавай новые таймеры из планового пробуждения. Таймеры работают, пока Enki открыта или в трее. Если инструмент недоступен — честно скажи, не имитируй ожидание.
</enki-schedules-v1>`;
