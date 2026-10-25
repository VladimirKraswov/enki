import { ApiError, ConnectionError } from "../api/http";
export function errText(e: unknown): string {
  if (e instanceof ApiError)
    return e.status === 404 ? e.detail || "Не найдено в среде выполнения Enki" : e.detail;
  if (e instanceof ConnectionError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
