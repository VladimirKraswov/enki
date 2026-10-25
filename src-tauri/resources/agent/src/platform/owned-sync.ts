// Flush only paths already owned and validated by the caller (new Enki output,
// its mutable SDK transcript or private publication directory). External source
// readers must stay readonly and must never use these write-access operations.
import fs from "node:fs";

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
function openOwned(file: string, directory: boolean): number {
  const before = fs.lstatSync(file, { bigint: true });
  const valid = (stat: fs.BigIntStats) => !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
  if (!valid(before)) throw new Error("Синхронизируемый путь Enki подменён или имеет неверный тип.");
  // FlushFileBuffers requires a write-access handle on Windows. POSIX keeps
  // the existing readonly flush semantics; no contents are written here.
  const fd = fs.openSync(file, (process.platform === "win32" ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (!valid(opened) || !valid(current) || opened.dev !== before.dev || opened.ino !== before.ino
      || current.dev !== opened.dev || current.ino !== opened.ino)
      throw new Error("Синхронизируемый путь Enki изменился во время открытия.");
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

/** The caller owns the returned descriptor and must close it in finally. */
export function openOwnedFileForSync(file: string): number { return openOwned(file, false); }
export function syncOwnedFile(file: string): void {
  const fd = openOwnedFileForSync(file);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function syncOwnedDirectory(directory: string): void {
  const fd = openOwned(directory, true);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
