// Moving a chat between projects changes its canonical directory, so the
// transcript must travel to the target directory's owned shard. The file is
// never overwritten and a session with a running worker is never moved.
import fs from "node:fs";
import path from "node:path";
import type { SessionRecord } from "./catalog.ts";

export function moveSessionTranscript(record: SessionRecord, sourceDir: string, targetDir: string): string | null {
  const source = record.sessionFile;
  if (!source) return null;
  if (path.dirname(source) !== sourceDir)
    throw new Error("Транскрипт сессии находится вне её каталога Enki; перенос отменён.");
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Транскрипт сессии не является обычным файлом; перенос отменён.");
  const target = path.join(targetDir, path.basename(source));
  if (path.resolve(target) === path.resolve(source)) return source;
  if (fs.existsSync(target)) throw new Error("В целевом проекте уже есть транскрипт с таким именем; перенос отменён.");
  fs.renameSync(source, target);
  return target;
}
