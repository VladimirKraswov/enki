import { MAX_ATTACHMENT_BYTES } from "./drafts";

type FileDetails = { isFile: boolean; isSymlink: boolean; size: number };

/** Tauri reports physical pixels; DOM hit testing uses CSS pixels. Focus is
 * only a fallback on WebViews that cannot hit-test an external drag. */
export function nativeDropTargetsQuestion(position: {x:number; y:number}): boolean {
  const scale = window.devicePixelRatio || 1;
  const target = document.elementFromPoint?.(position.x / scale, position.y / scale);
  return !!(target ?? document.activeElement)?.closest('[data-question-input]');
}

const types: Record<string, string> = {
  zip: "application/zip",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
};

/** The native WebView intercepts Finder drops before HTML DragEvent receives File objects. */
export async function filesFromNativeDrop(
  paths: string[],
  inspect: (path: string) => Promise<FileDetails>,
  read: (path: string) => Promise<Uint8Array>,
): Promise<File[]> {
  if (!paths.length) return [];
  if (paths.length > 12) throw new Error("Можно приложить не более 12 файлов к одному запросу.");
  const details = await Promise.all(paths.map(path => inspect(path)));
  let total = 0;
  for (const item of details) {
    if (!item.isFile || item.isSymlink) throw new Error("Перетащите обычные файлы, а не папки или ссылки.");
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_ATTACHMENT_BYTES)
      throw new Error("Каждый файл должен быть непустым и не больше 50 МБ.");
    total += item.size;
  }
  if (total > MAX_ATTACHMENT_BYTES) throw new Error("Общий размер вложений не должен превышать 50 МБ.");
  const files: File[] = [];
  for (let index = 0; index < paths.length; index++) {
    const bytes = await read(paths[index]);
    if (bytes.byteLength !== details[index].size) throw new Error("Файл изменился во время перетаскивания. Попробуйте снова.");
    const name = paths[index].split(/[\\/]/).pop() || "Вложение";
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    files.push(new File([owned], name, { type: types[extension] ?? "" }));
  }
  return files;
}
