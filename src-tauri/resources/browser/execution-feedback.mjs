// Executor-owned terminal markers only. Ordinary log mentions of timeout are not evidence.
// Advisory feedback never changes commands, deadlines, permissions or process lifetime.
// Only the Pi bash tool's own timeout marker is recognized: it is the only executor.
export function executionFeedback(engine, tool, output, isError = false) {
  if (engine !== 'pi' || tool !== 'bash' || typeof output !== 'string' || !isError) return undefined;
  const tail = output.slice(-4096).trimEnd();
  if (!/(?:^|\n)Command timed out after \d+(?:\.\d+)? seconds$/.test(tail)) return undefined;
  return {
    outcome: 'timed_out',
    message: '[Enki: execution timed out]\nКоманда остановлена по таймауту; проверка не завершена успешно. Не повторяй тот же запуск только с увеличенным ожиданием. Сначала проверь последние логи, существование процесса и поддерживаемый способ завершения. Для GUI/сервера нужен наблюдаемый критерий готовности и ограниченный сценарий либо фоновый запуск с отдельной проверкой; не жди закрытия окна как результата теста. Параметры запуска сверяй с --help/исходниками: переменные окружения перед исполняемым файлом и аргументы после него имеют разный смысл. После диагностики исправь причину или обоснуй больший срок для действительно долгой операции. Не перезапускай и не останавливай чужие процессы.',
  };
}
