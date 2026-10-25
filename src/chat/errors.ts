import type { Message } from "../api/types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function rawError(error: unknown): string {
  const e = record(error), data = record(e.data);
  if (typeof data.message === "string") return data.message;
  if (typeof e.message === "string") return e.message;
  return typeof error === "string" ? error : "Ответ ассистента завершился ошибкой.";
}

/** A model transport failure is separate from engine connectivity or HTTP rejection. */
export function isModelConnectionError(error: unknown): boolean {
  const e = record(error), data = record(e.data);
  if (e.name !== "APIError" || typeof data.statusCode === "number" && data.statusCode >= 400) return false;
  return /Cannot connect to API|Unable to connect|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT)\b|fetch failed|socket (?:closed|hang up)/i.test(rawError(error));
}

export function describeMessageError(error: unknown): string {
  if (!error) return "";
  const e = record(error);
  if (e.name === "MessageOutputLengthError") return "Достигнут лимит ответа модели. Можно сжать контекст и продолжить работу.";
  if (e.name === "MessageAbortedError") return "Ответ остановлен.";
  if (e.name === "ContextOverflowError") return "История превышает контекст модели. При переходе на меньшую модель сначала сожмите её предыдущей большой моделью через «Сжать сейчас». Полная история сохранена.";
  if (isModelConnectionError(error)) {
    // Inspect only the hostname. Never render credentials, query strings or private URLs.
    const metadata = record(record(e.data).metadata);
    try {
      const url = new URL(typeof metadata.url === "string" ? metadata.url : "");
      if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()))
        return "Нет соединения с API модели. Проверьте сервис модели и SSH-туннель.";
    } catch { /* A missing URL is still a model connection failure. */ }
    return "Нет соединения с API модели. Проверьте подключение к сервису модели.";
  }
  return rawError(error);
}

/** Suppress only a duplicate of the last visible assistant error, not an older failure. */
export function sessionBannerError(lastError: string | null | undefined, visible: readonly Message[]): string | null {
  if (!lastError) return null;
  const latest = visible[visible.length - 1];
  if (latest?.role === "assistant" && latest.error) {
    const equivalent = [describeMessageError(latest.error), rawError(latest.error)];
    // Some session.error events omit the request URL present on message.updated.
    if (isModelConnectionError(latest.error)) equivalent.push(describeMessageError({
      name: "APIError", data: { message: rawError(latest.error) },
    }));
    if (equivalent.includes(lastError)) return null;
  }
  return lastError;
}
