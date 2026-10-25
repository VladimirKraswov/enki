import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { syncOwnedDirectory, syncOwnedFile } from "../platform/owned-sync.ts";

export const HASH = /^[a-f0-9]{64}$/;
export const JOB = /^[a-f0-9-]{36}$/;
export function validOrigin(origin: string): boolean { return !!origin && origin.length <= 512 && !/[\u0000-\u001f]/.test(origin); }
export const shaBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function shaFile(file: string): string {
  const hash = createHash("sha256"), descriptor = openRegular(file);
  try {
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) { const n = fs.readSync(descriptor, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}
export function openRegular(file: string): number {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor), link = fs.lstatSync(file);
    if (!stat.isFile() || !link.isFile() || link.isSymbolicLink() || stat.ino !== link.ino || stat.dev !== link.dev)
      throw new Error("Источник подменён ссылкой или имеет неверный тип.");
    return descriptor;
  } catch (error) { fs.closeSync(descriptor); throw error; }
}
export function readStable(file: string, limit: number): Buffer {
  const descriptor = openRegular(file);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (before.size < 1n || before.size > BigInt(limit)) throw new Error("Размер исходного файла вне допустимых границ.");
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true }), link = fs.lstatSync(file, { bigint: true });
    if (bytes.length > limit || before.size !== BigInt(bytes.length)
      || (["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some(key => before[key] !== after[key] || after[key] !== link[key])
      || link.isSymbolicLink()) throw new Error("Исходный файл изменился во время копирования; повторите после завершения записи.");
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
export function directory(dir: string, create = false): string {
  if (!path.isAbsolute(dir)) throw new Error("Требуется абсолютный каталог.");
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Каталог импорта подменён ссылкой.");
  // macOS /var is a legitimate OS alias. Canonicalize the explicit owned root,
  // then derive every descendant ourselves; never permit a final link itself.
  return fs.realpathSync(dir);
}
export function syncFile(file: string): void {
  syncOwnedFile(file);
}
export function syncDirectory(dir: string): void {
  syncOwnedDirectory(dir);
}
export function writeOwned(file: string, bytes: string | Uint8Array, immutable: boolean): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (immutable) fs.chmodSync(file, 0o400);
}
export function identity(file: string): fs.BigIntStats {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Проверяемый файл подменён.");
  return stat;
}
export function unchanged(file: string, before: fs.BigIntStats, hash: string): void {
  const after = identity(file);
  if ((["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some(key => before[key] !== after[key]) || shaFile(file) !== hash)
    throw new Error("Копия изменилась во время проверки; импорт отменён.");
}
export function cleanupIssue(action: string, error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "ERROR";
  return `${action}:${code}`;
}
