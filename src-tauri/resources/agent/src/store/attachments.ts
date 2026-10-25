// Content-addressed attachment store for queued prompts and schedules.
//
// The UI prepares files (images, decoded text, converted media) before they are
// queued, and the runtime keeps the prepared bytes so a queued item can run
// while no window is open. Files are written atomically and verified by hash.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { integer, text, type Database } from "./db.ts";

const MAX_FILE = 48 * 1024 * 1024;

export interface StoredAttachment { id: string; name: string; mime: string; size: number; sha256: string }

function decodeDataUrl(url: string): { mime: string; bytes: Buffer } {
  const match = /^data:([^;,]{1,200});base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match) throw new Error("Вложение должно быть подготовленным data: URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_FILE) throw new Error("Вложение больше 48 МБ.");
  return { mime: match[1], bytes };
}

export class AttachmentStore {
  private readonly dir: string;

  constructor(private readonly db: Database, root: string) {
    this.dir = path.join(root, "attachments");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  put(url: string, name: string, owner: string): StoredAttachment {
    const { mime, bytes } = decodeDataUrl(url);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = path.join(this.dir, sha256);
    if (!fs.existsSync(file)) {
      const temporary = `${file}.${randomUUID()}.part`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    }
    const id = randomUUID();
    this.db.run("INSERT INTO attachments(id,sha256,name,mime,size,owner,created) VALUES(?,?,?,?,?,?,?)",
      id, sha256, name.slice(0, 512) || "файл", mime, bytes.length, owner, Date.now());
    return { id, name, mime, size: bytes.length, sha256 };
  }

  dataUrl(id: string): string {
    const row = this.db.get("SELECT sha256,mime,size FROM attachments WHERE id=?", id);
    if (!row) throw new Error("Вложение очереди не найдено. Запрос не отправлен.");
    const bytes = fs.readFileSync(path.join(this.dir, text(row, "sha256")));
    if (bytes.length !== integer(row, "size") || createHash("sha256").update(bytes).digest("hex") !== text(row, "sha256"))
      throw new Error("Вложение очереди повреждено. Запрос не отправлен.");
    return `data:${text(row, "mime")};base64,${bytes.toString("base64")}`;
  }

  /** Drop the owner's references; blobs without references are removed. */
  release(owner: string): void {
    const rows = this.db.all("SELECT sha256 FROM attachments WHERE owner=?", owner);
    this.db.run("DELETE FROM attachments WHERE owner=?", owner);
    for (const row of rows) {
      const sha = text(row, "sha256");
      if (!this.db.get("SELECT 1 AS used FROM attachments WHERE sha256=?", sha)) fs.rmSync(path.join(this.dir, sha), { force: true });
    }
  }

  /** Drop one reference of `owner`; the blob goes when nothing else uses it. */
  releaseOne(id: string, owner: string): void {
    const row = this.db.get("SELECT sha256 FROM attachments WHERE id=? AND owner=?", id, owner);
    if (!row) return;
    this.db.run("DELETE FROM attachments WHERE id=?", id);
    const sha = text(row, "sha256");
    if (!this.db.get("SELECT 1 AS used FROM attachments WHERE sha256=?", sha)) fs.rmSync(path.join(this.dir, sha), { force: true });
  }

  /** Move references from one owner to another without copying bytes. */
  transfer(from: string, to: string): void {
    this.db.run("UPDATE attachments SET owner=? WHERE owner=?", to, from);
  }
}
