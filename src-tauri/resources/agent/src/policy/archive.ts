// ZIP attachment references travel as a marked synthetic text block, so the
// model sees where the original archive lives and history can rebuild the card.
// Pure and shared with the UI renderer (src/attachments/archive.ts re-exports).

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export interface ArchiveReference {
  version: 1; name: string; path: string; url: string; size: number; sha256: string; remote: boolean;
}

export function archiveReference(value: unknown): ArchiveReference | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.name !== "string" || !/\.zip$/i.test(v.name) || v.name.length > 1024
      || typeof v.path !== "string" || v.path.length > 4096 || typeof v.url !== "string" || v.url.length > 16384 || typeof v.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(v.sha256) || typeof v.remote !== "boolean"
      || typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size < 4 || v.size > MAX_ARCHIVE_BYTES) return;
  try {
    const url = new URL(v.url);
    const decoded = decodeURIComponent(url.pathname);
    const localPath = v.path.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
    const urlPath = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
    if (url.protocol !== "file:" || url.host || url.search || url.hash
        || localPath !== urlPath || !/\/attachments\/[a-f0-9-]{36}\/archive\.zip$/i.test(decoded)) return;
  } catch { return; }
  return { version: 1, name: v.name, path: v.path, url: v.url, size: v.size, sha256: v.sha256, remote: v.remote };
}

const marker = /<arvela-attachment-v1>([^\n]{1,32768})<\/arvela-attachment-v1>/g;

/** Persisted prompt text keeps the marker; rebuild the same reference after a restart. */
export function splitArchiveText(text: string): { text: string; references: ArchiveReference[] } {
  const references: ArchiveReference[] = [];
  const visible = text.replace(marker, (original) => {
    if (references.length >= 12) return original;
    try {
      const ref = archiveReference(JSON.parse(original.slice("<arvela-attachment-v1>".length, -"</arvela-attachment-v1>".length)));
      if (ref) { references.push(ref); return ""; }
    } catch { /* Preserve arbitrary user text. */ }
    return original;
  });
  return { text: references.length ? visible.trim() : text, references };
}
