// Turn policy text shared by the runtime (injection, history display) and the UI
// (display of imported history). Moved from src/agent/promptPolicy.ts.
//
// Per-session blocks (language, tool workflow, timers, Мастерская) are now
// appended to the turn's system prompt by the runtime policy extension, so a
// user's text is stored exactly as typed. Steering and wake markers remain in
// the user message because they describe that specific message.
import { legacyToolWorkflowReminder, legacyV2ToolWorkflowReminder, toolWorkflowReminder } from "./toolWorkflow.ts";
import { workshopReminder, workshopVisibleText } from "./workshop.ts";

export const RESPONSE_LANGUAGE_CONTEXT = `Язык общения Enki: все сообщения пользователю, пояснения, вопросы, отчёты об ошибках и итоговые ответы пиши на русском языке. Не переходи на украинский язык вслед за историей, выводом инструментов или документами. Размышления допускаются на английском. Код, команды, пути и собственные имена сохраняй без перевода. Это правило языка, а не разрешение выполнять дополнительные действия.`;
export const USER_WAIT_CONTEXT = `Ожидание пользователя и длительные операции: если для продолжения нужно действие или решение человека (подключить устройство, вставить карту, выбрать папку, разрешить доступ), сначала явно напиши, что именно требуется и почему работа без этого не может продолжаться, затем используй инструмент question и дождись ответа. Не скрывай ожидание человека в shell sleep, циклах проверки устройств или длинной команде. Если человек отменил часть работы, сразу учти это уточнение на следующем доступном шаге. Для долгой самостоятельной операции перед запуском кратко объясни, что сейчас выполняется, какой результат ожидается и приблизительное время, если оно известно. По промежуточным результатам сообщай о значимом прогрессе или препятствии; не выдавай отсутствие вывода за зависание или успех. Для явно порученного фонового наблюдения используй таймеры Enki, сохраняя текущий чат. Используй уже предоставленные разрешения; согласованные действия не требуют нового вопроса.`;
export const userWaitReminder = (sessionId: string) => `<enki-user-wait-v1 session="${encodeURIComponent(sessionId)}">\n${USER_WAIT_CONTEXT}\n</enki-user-wait-v1>`;

export const scheduleReminder = (sessionId: string, directory: string) => `<enki-schedules-v1 session="${encodeURIComponent(sessionId)}">\nТаймеры Enki: если пользователь просит следить, периодически проверять, дождаться чужой работы или выполнить действие позже, используй общий MCP enki-schedules / desktop_schedule (имя может иметь префикс mesh_enki_schedules_). Текущий session_id=${JSON.stringify(sessionId)}, directory=${JSON.stringify(directory)}. Не переключай видимый чат. Для наблюдения mode=repeat, выбери разумный minutes (обычно 5–15, для долгой работы 30–60), для «через час» mode=once, minutes=60; для точного времени run_at — Unix миллисекунды. Задай краткое title, самостоятельный prompt с целью, условием завершения и правилом сообщать только о значимых изменениях. request_key — стабильное уникальное имя задачи; при повторе вызова используй тот же ключ. Сначала list, чтобы не плодить повторы. Не обещай таймер без успешного create. По просьбе прекратить наблюдение найди таймер через list и remove; по завершении наблюдения удали свой таймер. Нельзя создавать новые таймеры из планового пробуждения без новой просьбы человека. Инструменты и разрешения остаются штатными. Таймеры выполняет Enki Runtime этого компьютера: они работают, пока Enki открыта или свёрнута в трей; после полного выхода не работают. Если инструмент отключён/недоступен, честно сообщи, не имитируй ожидание shell sleep.\n</enki-schedules-v1>`;

/** Wording used before the runtime owned timers; kept so old history stays clean. */
const legacyScheduleReminder = (sessionId: string, directory: string) => scheduleReminder(sessionId, directory)
  .replace("Таймеры выполняет Enki Runtime этого компьютера: они работают, пока Enki открыта или свёрнута в трей; после полного выхода не работают.", "Работает, пока Enki открыта или в трее; после полного выхода не работает.");

export const scheduleWakeReminder = (sessionId: string, taskId: string) => `<enki-schedule-wake-v1 session="${encodeURIComponent(sessionId)}" task="${encodeURIComponent(taskId)}">\nЭто плановое пробуждение по ранее сохранённому заданию, а не новая просьба человека. Выполни проверку по текущему контексту. Не создавай дополнительные таймеры. Если наблюдение завершено, удали этот таймер через desktop_schedule. Сообщай владельцу о значимых изменениях, завершении, ошибке или необходимости его решения.\n</enki-schedule-wake-v1>`;

export const languageReminder = (sessionId: string) => `<arvela-response-language-v1 session="${encodeURIComponent(sessionId)}">\n${RESPONSE_LANGUAGE_CONTEXT}\n</arvela-response-language-v1>`;

export const steeringReminder = (sessionId: string) => `<arvela-steering-v1 session="${encodeURIComponent(sessionId)}">\nЭто уточнение текущего задания. Продолжай текущую работу и учти уточнение на следующем шаге. Не начинай независимое задание.\n</arvela-steering-v1>`;

/** Blocks the runtime appends to the system prompt of every turn in a session. */
export function sessionPolicyBlocks(sessionId: string, directory: string, workshop: boolean): string[] {
  return [
    languageReminder(sessionId),
    toolWorkflowReminder(sessionId),
    userWaitReminder(sessionId),
    scheduleReminder(sessionId, directory),
    ...(workshop ? [workshopReminder(sessionId)] : []),
  ];
}

function removeExactBlock(text: string, block: string): string {
  const at = text.indexOf(block), end = at + block.length, attachment = text.indexOf("<attached_file ");
  return at >= 0 && (at === 0 || text.slice(at - 2, at) === "\n\n") && (end === text.length || text.slice(end, end + 2) === "\n\n") && (attachment < 0 || at < attachment)
    ? (text.slice(0, at > 0 ? at - 2 : 0) + text.slice(end + (at === 0 && text.slice(end, end + 2) === "\n\n" ? 2 : 0))).trim()
    : text;
}

/** Hide only exact app-owned, same-session blocks placed before attachments;
 * never strip quoted text, assistant output or file data. */
export function visiblePromptText(text: string, sessionId: string): string {
  for (const reminder of [toolWorkflowReminder(sessionId), legacyV2ToolWorkflowReminder(sessionId), legacyToolWorkflowReminder(sessionId), languageReminder(sessionId), languageReminder(sessionId).replace("Язык общения Enki:", "Язык общения Arvela:"), steeringReminder(sessionId), userWaitReminder(sessionId)])
    text = removeExactBlock(text, reminder);
  const wakePrefix = `<enki-schedule-wake-v1 session="${encodeURIComponent(sessionId)}" task="`;
  const wakeAt = text.indexOf(wakePrefix), quote = wakeAt < 0 ? -1 : text.indexOf('"', wakeAt + wakePrefix.length);
  if (quote >= 0)
    try { text = removeExactBlock(text, scheduleWakeReminder(sessionId, decodeURIComponent(text.slice(wakeAt + wakePrefix.length, quote)))); }
    catch { /* Keep malformed user text. */ }
  const open = `<enki-schedules-v1 session="${encodeURIComponent(sessionId)}">`;
  const at = text.indexOf(open), directoryMatch = at < 0 ? null : text.slice(at).match(/directory=("(?:[^"\\]|\\.)*")/);
  if (directoryMatch)
    try {
      const directory = JSON.parse(directoryMatch[1]) as string;
      text = removeExactBlock(removeExactBlock(text, scheduleReminder(sessionId, directory)), legacyScheduleReminder(sessionId, directory));
    } catch { /* Keep altered/quoted text. */ }
  return workshopVisibleText(text, sessionId);
}

export function steeringText(sessionId: string, text: string): string {
  return `${text}\n\n${steeringReminder(sessionId)}`;
}

export function isSteeringText(text: string, sessionId: string): boolean {
  const attachment = text.indexOf("<attached_file ");
  return (attachment < 0 ? text : text.slice(0, attachment)).split("\n\n").includes(steeringReminder(sessionId));
}

export function wakeText(sessionId: string, taskId: string, prompt: string): string {
  return `${prompt}\n\n${scheduleWakeReminder(sessionId, taskId)}`;
}
