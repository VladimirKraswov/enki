import type { ModelInfo, PromptPartInput, TextPartInput } from "../api/types";
import type { AsrSettings } from "../voice/asr";
import { transcribeAudio } from "../voice/asr";
import { convertFile, type Conversion, type HelperAsset } from "./helper";
import type { DraftAttachment } from "./drafts";
import { archivePart, type ArchiveStager } from './archive';

export type PreparedPart = PromptPartInput | TextPartInput;
const textExtensions = /\.(txt|md|markdown|json|jsonc|csv|tsv|log|yml|yaml|xml|html|css|js|jsx|ts|tsx|py|rs|go|sh|sql|svg)$/i;
const imageExtensions = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i;
const pdfExtensions = /\.pdf$/i;
const audioExtensions = /\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i;
const videoExtensions = /\.(mp4|mov|m4v|mkv|avi|webm)$/i;

export function fileKind(file: Pick<DraftAttachment, "name" | "mime">): "text" | "image" | "pdf" | "audio" | "video" | "archive" | "unsupported" {
  const mime = file.mime.toLowerCase().split(";")[0];
  if (/\.zip$/i.test(file.name)) return 'archive';
  if (mime === "application/pdf" || pdfExtensions.test(file.name)) return "pdf";
  if (mime.startsWith("image/") || imageExtensions.test(file.name)) return "image";
  if (mime.startsWith("video/") || videoExtensions.test(file.name)) return "video";
  if (mime.startsWith("audio/") || audioExtensions.test(file.name)) return "audio";
  if (mime.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(mime) || textExtensions.test(file.name)) return "text";
  return "unsupported";
}

function base64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
async function uri(blob: Blob, mime: string): Promise<string> {
  return `data:${mime};base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
}
function assetPart(asset: HelperAsset, filename: string): PromptPartInput {
  return { type: "file", filename, mime: asset.mime, url: `data:${asset.mime};base64,${asset.data}` };
}
function textPart(name: string, value: string): PromptPartInput {
  const data = new TextEncoder().encode(value);
  return { type: "file", filename: name, mime: "text/plain", url: `data:text/plain;base64,${base64(data)}` };
}
async function normalizedImage(blob: Blob): Promise<string> {
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    if (!canvas.width || !canvas.height || canvas.width * canvas.height > 40_000_000)
      throw new Error("Изображение слишком большое для преобразования.");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Нет поддержки Canvas.");
    context.drawImage(image, 0, 0);
    return await new Promise<string>((resolve, reject) => canvas.toBlob(output => {
      if (!output) { reject(new Error("Не удалось преобразовать изображение.")); return; }
      void uri(output, "image/png").then(resolve, reject);
    }, "image/png"));
  } finally { image.close(); }
}

async function transcribe(chunks: HelperAsset[], asr: AsrSettings, signal: AbortSignal): Promise<string> {
  if (!chunks.length) return "";
  const lines: string[] = [];
  for (const chunk of chunks) {
    if (signal.aborted) throw signal.reason;
    const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
    const spoken = await transcribeAudio(new Blob([bytes], { type: chunk.mime }), asr, signal);
    lines.push(`[${chunk.label}] ${spoken}`);
  }
  return lines.join("\n");
}

export async function prepareAttachments(
  files: DraftAttachment[], model: ModelInfo, helperEndpoint: string, asr: AsrSettings, signal: AbortSignal,
  onProgress: (label: string) => void = () => {},
  stage?: ArchiveStager,
  options: { imageReferences?: boolean } = {},
): Promise<PreparedPart[]> {
  const input = model.capabilities?.input;
  const parts: PreparedPart[] = [];
  for (const file of files) {
    if (signal.aborted) throw signal.reason;
    const kind = fileKind(file);
    onProgress(`Подготовка: ${file.name}`);
    if (kind === "unsupported") throw new Error(`Формат файла «${file.name}» не поддерживается. Выберите ZIP, изображение, PDF, аудио, видео или текстовый файл.`);
    if (kind === 'archive') {
      if (!stage) throw Error('Для передачи ZIP откройте установленное приложение.');
      parts.push(archivePart(await stage(file)));
      continue;
    }
    if (kind === "text") {
      // The runtime decodes text/plain file parts into the prompt. Guard model context rather than silently truncate.
      const value = await file.blob.text();
      if (value.length > 750_000) throw new Error(`Текст «${file.name}» слишком длинный для одной отправки (до 750 000 символов). Разделите файл.`);
      parts.push(textPart(file.name, value));
      continue;
    }
    if (kind === "image") {
      if (!input?.image && !options.imageReferences) throw new Error(`Модель ${model.name ?? model.id} не принимает изображения.`);
      const direct = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime);
      const mime = direct ? file.mime : "image/png";
      let url: string;
      try { url = direct ? await uri(file.blob, mime) : await normalizedImage(file.blob); }
      catch { throw new Error(`Изображение «${file.name}» не удалось преобразовать в PNG.`); }
      parts.push({ type: "file", filename: direct ? file.name : `${file.name}.png`, mime, url });
      continue;
    }
    if (input?.[kind] === true) {
      const mime = file.mime || (kind === "pdf" ? "application/pdf" : kind === "audio" ? "audio/mp4" : "video/mp4");
      parts.push({ type: "file", filename: file.name, mime, url: await uri(file.blob, mime) });
      continue;
    }
    const converted: Conversion = await convertFile(helperEndpoint, kind, file.blob, signal);
    const summary = [`Имя файла: ${file.name}`, `Тип: ${kind}`, ...converted.notes,
      ...converted.images.map((image, index) => `${kind === "pdf" ? "Страница" : "Кадр"} ${index + 1}: ${image.label}`)].join("\n");
    if (kind !== "audio" && !input?.image && converted.images.length)
      throw new Error(`Модель ${model.name ?? model.id} не принимает изображения, поэтому ${file.name} нельзя передать без потери содержимого.`);
    const spoken = await transcribe(converted.audio, asr, signal);
    if (kind === "audio" && !spoken) throw new Error(`В «${file.name}» не обнаружено аудио для распознавания.`);
    parts.push(textPart(`${file.name}.описание.txt`, [summary, converted.text, spoken].filter(Boolean).join("\n\n")));
    converted.images.forEach((image, index) => parts.push(assetPart(image, `${file.name}.${kind === "pdf" ? "page" : "frame"}-${index + 1}.jpg`)));
  }
  onProgress("");
  return parts;
}

export function pastedTextFile(text: string): File {
  return new File([text], `вставленный-текст-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`, { type: "text/plain" });
}
export const LARGE_PASTE_THRESHOLD = 8000;
