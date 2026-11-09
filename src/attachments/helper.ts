export const DEFAULT_HELPER_ENDPOINT = "http://127.0.0.1:18107";

export interface HelperAsset { label: string; mime: string; data: string }
export interface Conversion {
  kind: "pdf" | "audio" | "video";
  text: string;
  images: HelperAsset[];
  audio: HelperAsset[];
  notes: string[];
}
export interface HelperHealth {
  ok: boolean;
  version: string;
  services: string[];
  maxInputBytes: number;
}

export function validHelperEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && (url.pathname === "/" || url.pathname === "");
  } catch { return false; }
}

/** A raw WebKit "Load failed" tells the owner nothing: name the helper and
 * what to check. The source attachment always stays available. */
function helperTransportError(error: unknown, endpoint: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/load failed|failed to fetch|networkerror|timed out|aborterror|abort/i.test(message))
    return new Error(`Сервис подготовки файлов недоступен (${endpoint}). Проверьте его запуск и SSH-туннель; исходный файл сохранён.`);
  return error instanceof Error ? error : new Error(message);
}

async function request<T>(endpoint: string, path: string, init: RequestInit, timeout: number): Promise<T> {
  if (!validHelperEndpoint(endpoint)) throw new Error("Адрес помощника должен быть локальным HTTP-адресом без пути и учётных данных.");
  let response: Response;
  try {
    response = await fetch(`${endpoint.replace(/\/$/, "")}${path}`, {
      ...init, credentials: "omit", redirect: "error", signal: AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]),
    });
  } catch (error) {
    throw helperTransportError(error, endpoint);
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(`Помощник: ${message}`);
  }
  return body as T;
}

export async function helperHealth(endpoint: string): Promise<HelperHealth> {
  const result = await request<HelperHealth>(endpoint, "/health", { method: "GET" }, 5000);
  if (result.ok !== true || !Array.isArray(result.services)) throw new Error("Помощник вернул некорректный ответ.");
  return result;
}

export async function convertFile(endpoint: string, kind: Conversion["kind"], blob: Blob, signal: AbortSignal): Promise<Conversion> {
  const result = await request<Conversion>(endpoint, "/v1/convert", {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Kind": kind }, body: blob, signal,
  }, 10 * 60_000);
  if (result.kind !== kind || typeof result.text !== "string" || !Array.isArray(result.images) || !Array.isArray(result.audio) || !Array.isArray(result.notes))
    throw new Error("Помощник вернул некорректное преобразование.");
  for (const asset of [...result.images, ...result.audio]) {
    if (typeof asset.label !== "string" || typeof asset.mime !== "string" || typeof asset.data !== "string" || asset.data.length > 35_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data))
      throw new Error("Помощник вернул некорректный файл.");
  }
  return result;
}
