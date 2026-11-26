// A transcript above the full-read budget must still open, page and branch:
// the newest parent chain is loaded, older entries stay on disk untouched.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openReadableSessionReader } from "../src/sdk/adapter.ts";
import { FULL_READ_BUDGET } from "../src/sessions/tail-scan.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enki-bounded-"));
const header = { type: "session", version: 3, id: "ses-big", timestamp: new Date().toISOString(), cwd: "/work" };
const user = (id: string, parentId: string | null, pad = 0) => ({ type: "message", id, parentId, message: { role: "user", content: `текст ${id} ${"x".repeat(pad)}` } });

function bigFile(name: string, count: number, pad: number) {
  const entries = [header];
  let parent: string | null = null;
  for (let i = 0; i < count; i++) { const id = `m${i}`; entries.push(user(id, parent, pad)); parent = id; }
  const file = path.join(dir, name);
  fs.writeFileSync(file, entries.map(value => JSON.stringify(value)).join("\n") + "\n");
  return file;
}

it("opens an oversized transcript from the tail and keeps a valid parent chain", () => {
  const file = bigFile("oversized.jsonl", 400, 120_000);
  expect(fs.statSync(file).size).toBeGreaterThan(FULL_READ_BUDGET);
  const reader = openReadableSessionReader(file);
  const branch = reader.branch();
  expect(branch.length).toBeGreaterThan(1);
  // Chain is contiguous: every entry's parent is the previous entry.
  for (let i = 1; i < branch.length; i++) expect((branch[i] as { parentId?: string }).parentId).toBe((branch[i - 1] as { id: string }).id);
  // The newest message is present; the oldest is not loaded.
  expect(branch.at(-1)).toMatchObject({ id: "m399" });
  expect(branch.some(entry => (entry as { id?: string }).id === "m0")).toBe(false);
});

it("keeps small transcripts exact", () => {
  const file = bigFile("small.jsonl", 5, 10);
  const reader = openReadableSessionReader(file);
  expect(reader.branch().map(entry => (entry as { id?: string }).id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
});

it("refuses a transcript whose header is damaged instead of inventing a chain", () => {
  const file = path.join(dir, "bad.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ type: "message", id: "x" })}\n${JSON.stringify(user("m1", null, 9_000_000))}\n`);
  expect(() => openReadableSessionReader(file)).toThrow(/Заголовок/);
});
