/** OpenAI-compatible multipart transcription; credentials live only in memory. */
export interface AsrSettings {
  endpoint: string;
  model: string;
  language: string;
}
export const defaultAsr: AsrSettings = {
  endpoint: "http://192.168.31.59:8080/api/asr/v1/audio/transcriptions",
  model: "gigaam-v3-e2e-rnnt",
  language: "ru",
};
let secret = "",
  secretEndpoint = "";
export function setAsrKey(endpoint: string, key: string) {
  secretEndpoint = endpoint.trim();
  secret = key;
}
export function getAsrKey(endpoint: string) {
  return endpoint.trim() === secretEndpoint ? secret : "";
}
export function validateAsr(settings: AsrSettings): string | null {
  try {
    const u = new URL(settings.endpoint);
    const local =
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      /^192\.168\.\d+\.\d+$/.test(u.hostname) ||
      /^10\.\d+\.\d+\.\d+$/.test(u.hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(u.hostname);
    if (
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      !u.pathname.endsWith("/audio/transcriptions") ||
      !(u.protocol === "https:" || (u.protocol === "http:" && local))
    )
      return "Нужен полный HTTPS URL /audio/transcriptions; HTTP разрешён только для локальной сети.";
  } catch {
    return "Укажите адрес ASR API в настройках.";
  }
  return settings.model.trim() ? null : "Укажите модель ASR.";
}
export function asrHttpError(status: number): string {
  const hint = status === 400 ? 'Сервис отклонил аудиофрагмент.'
    : status === 401 || status === 403 ? 'Проверьте ключ и доступ к сервису.'
    : status === 404 ? 'Проверьте адрес и модель.'
    : status === 429 ? 'Сервис перегружен; повторите позже.'
    : status >= 500 ? 'Ошибка сервиса распознавания; повторите позже.'
    : 'Не удалось распознать аудиофрагмент.';
  return `ASR HTTP ${status}. ${hint}`;
}
export async function transcribeAudio(
  blob: Blob,
  settings: AsrSettings,
  signal: AbortSignal,
  options: {allowEmpty?:boolean} = {},
): Promise<string> {
  const error = validateAsr(settings);
  if (error) throw new Error(error);
  if (blob.size === 0 || blob.size > 25 * 1024 * 1024)
    throw new Error("Запись пуста или превышает 25 МБ.");
  if (signal.aborted) throw new DOMException("Отменено", "AbortError");
  const mime = blob.type.split(";")[0] || "audio/webm";
  const filename = `dictation.${mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm"}`;
  let text: unknown;
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    text = await invoke<string>("transcribe_audio", {
      endpoint: settings.endpoint,
      model: settings.model,
      language: settings.language,
      apiKey: getAsrKey(settings.endpoint),
      audio: btoa(binary),
      mime,
      filename,
    });
  } else {
    const body = new FormData();
    body.append("file", blob, filename);
    body.append("model", settings.model);
    body.append("response_format", "json");
    if (settings.language.trim())
      body.append("language", settings.language.trim());
    const response = await fetch(settings.endpoint, {
      method: "POST",
      body,
      headers: getAsrKey(settings.endpoint)
        ? { Authorization: `Bearer ${getAsrKey(settings.endpoint)}` }
        : {},
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok)
      throw new Error(
        asrHttpError(response.status),
      );
    const result = await response.json();
    text = result.text;
  }
  if (signal.aborted) throw new DOMException("Отменено", "AbortError");
  if (typeof text !== "string" || (!text.trim() && !options.allowEmpty))
    throw new Error("ASR не вернул распознанный текст.");
  return text.trim();
}
