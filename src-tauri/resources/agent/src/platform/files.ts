// Read-only project file browsing for the review panel.
// Every path is resolved inside the project directory; symbolic links that
// leave it are refused. Content is bounded and binary files are not decoded.

import fs from "node:fs";
import path from "node:path";

export interface FileEntryDTO { name: string; path: string; absolute: string; type: "file" | "directory"; ignored?: boolean }

const MAX_TEXT = 2 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", "target", ".DS_Store"]);

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveInside(directory: string, relativePath: string): string {
  const root = fs.realpathSync(directory);
  const target = path.resolve(root, relativePath || ".");
  if (!inside(root, target)) throw new Error("Путь вне папки проекта.");
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
  if (!inside(root, real)) throw new Error("Ссылка ведёт за пределы папки проекта.");
  return real;
}

export function listFiles(directory: string, relativePath: string): FileEntryDTO[] {
  const root = fs.realpathSync(directory);
  const dir = resolveInside(directory, relativePath);
  if (!fs.statSync(dir).isDirectory()) throw new Error("Это не папка.");
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .slice(0, 5000)
    .map((entry) => {
      const absolute = path.join(dir, entry.name);
      let type: "file" | "directory" = entry.isDirectory() ? "directory" : "file";
      if (entry.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(absolute);
          if (!inside(root, real)) return null;
          type = fs.statSync(real).isDirectory() ? "directory" : "file";
        } catch { return null; }
      }
      return { name: entry.name, path: path.relative(root, absolute).split(path.sep).join("/"), absolute, type, ...(SKIP.has(entry.name) ? { ignored: true } : {}) };
    })
    .filter((entry): entry is FileEntryDTO => entry !== null)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
}

export function fileContent(directory: string, relativePath: string): { type: "text" | "binary"; content?: string; size: number; truncated?: boolean } {
  const file = resolveInside(directory, relativePath);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Это не файл.");
  const fd = fs.openSync(file, "r");
  try {
    const length = Math.min(stat.size, MAX_TEXT);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    if (buffer.includes(0)) return { type: "binary", size: stat.size };
    const truncated = stat.size > MAX_TEXT;
    try {
      // A truncated read may end inside a multi-byte character: stream mode
      // drops only that incomplete tail instead of calling the file binary.
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: truncated });
      return { type: "text", content, size: stat.size, ...(truncated ? { truncated: true } : {}) };
    } catch { return { type: "binary", size: stat.size }; }
  } finally { fs.closeSync(fd); }
}
