import { ApiError } from "./http";

/** A generic 500 is not proof of a filesystem denial. Never guess the OS cause. */
export function projectErrorText(error: unknown): string {
  if (error instanceof ApiError && error.filesystemDenied)
    return "Среда выполнения Enki не может прочитать папку проекта (отказ доступа). Проверьте разрешения Enki и доступность папки. История и черновик сохранены.";
  if (error instanceof ApiError && error.status >= 500) {
    const ref = error.detail.match(/\(err_[a-zA-Z0-9]{1,64}\)$/)?.[0];
    return `Среда выполнения Enki отвечает, но запрос к проекту завершился ошибкой HTTP ${error.status}. Возможны проблемы доступа к папке.${ref ? " Код: " + ref : ""} История и черновик сохранены.`;
  }
  return error instanceof Error ? error.message : String(error);
}
