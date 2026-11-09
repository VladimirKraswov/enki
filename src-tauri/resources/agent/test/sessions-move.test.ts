import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { moveSessionTranscript } from "../src/sessions/move.ts";
import type { SessionRecord } from "../src/sessions/catalog.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-move-")); dirs.push(root);
  const from = path.join(root, "from"), to = path.join(root, "to");
  fs.mkdirSync(from); fs.mkdirSync(to);
  const file = path.join(from, "chat.jsonl");
  fs.writeFileSync(file, '{"type":"message"}\n');
  const record = { id: "s", sessionFile: file } as SessionRecord;
  return { root, from, to, file, record };
}

it("moves the transcript into the target project shard without leaving a copy behind", () => {
  const f = fixture();
  const moved = moveSessionTranscript(f.record, f.from, f.to);
  expect(moved).toBe(path.join(f.to, "chat.jsonl"));
  expect(fs.existsSync(f.file)).toBe(false);
  expect(fs.readFileSync(moved!, "utf8")).toBe('{"type":"message"}\n');
  // A record without a transcript has nothing to move.
  expect(moveSessionTranscript({ id: "empty", sessionFile: null } as SessionRecord, f.from, f.to)).toBeNull();
});

it("refuses to move a transcript that is outside the session's own shard", () => {
  const f = fixture();
  expect(() => moveSessionTranscript(f.record, path.join(f.root, "other"), f.to)).toThrow(/вне её каталога/);
  expect(fs.existsSync(f.file)).toBe(true);
});

it("never overwrites an existing transcript in the target project", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.to, "chat.jsonl"), "existing");
  expect(() => moveSessionTranscript(f.record, f.from, f.to)).toThrow(/уже есть транскрипт/);
  expect(fs.readFileSync(path.join(f.to, "chat.jsonl"), "utf8")).toBe("existing");
  expect(fs.existsSync(f.file)).toBe(true);
});
