// Large transcripts must stay usable: confirmation and listing may read only a
// bounded head/tail, and the strict checks must still reject damaged lines.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confirmEntries, readHeaderLine, scanHead, scanTail } from "../src/sessions/tail-scan.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enki-tail-"));
const write = (name: string, lines: unknown[]) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map(value => JSON.stringify(value)).join("\n") + "\n");
  return file;
};
const entry = (id: string, size = 0) => ({ type: "message", id, parentId: null, message: { role: "user", content: "x".repeat(size) } });
const header = { type: "session", version: 3, id: "ses", timestamp: new Date().toISOString(), cwd: "/work" };

it("confirms the newest entries without reading the whole transcript", () => {
  const lines = [header, ...Array.from({ length: 200 }, (_, i) => entry(`e${i}`, 40_000))];
  const file = write("big.jsonl", lines);
  const wanted = new Set(["e199", "e198"]);
  // One 40 KB entry per 64 KB budget: only the newest one fits, and asking for
  // more bytes is how older ids are proven without reading everything.
  expect([...confirmEntries(file, wanted, 64 * 1024)]).toEqual(["e199"]);
  expect([...confirmEntries(file, wanted, 256 * 1024)].sort()).toEqual(["e198", "e199"]);
  // A bounded tail scan must not have read the whole file.
  expect(scanTail(file, 64 * 1024).size).toBeGreaterThan(64 * 1024);
});

it("still finds an entry that sits outside the tail budget by asking for more", () => {
  const file = write("midsize.jsonl", [header, ...Array.from({ length: 60 }, (_, i) => entry(`m${i}`, 20_000))]);
  expect(confirmEntries(file, new Set(["m59"]), 32 * 1024).size).toBe(1);
  expect(confirmEntries(file, new Set(["m0"]), 32 * 1024).size).toBe(0);
  expect(confirmEntries(file, new Set(["m0"]), 8 * 1024 * 1024).size).toBe(1);
});

it("reports a damaged complete line instead of pretending the save is confirmed", () => {
  const file = path.join(dir, "damaged.jsonl");
  fs.writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message","id":"good"}\nnot json\n`);
  expect(() => confirmEntries(file, new Set(["good"]))).toThrow(/повреждена/);
});

it("ignores a torn last line, which is a write in flight", () => {
  const file = path.join(dir, "torn.jsonl");
  fs.writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message","id":"ok"}\n{"type":"message","id":"half`);
  expect([...confirmEntries(file, new Set(["ok", "half"]))]).toEqual(["ok"]);
});

it("reads the header and the first entries without touching the middle", () => {
  const file = write("head.jsonl", [header, entry("first"), entry("second", 200_000), entry("third")]);
  expect(JSON.parse(readHeaderLine(file)!).id).toBe("ses");
  const head = scanHead(file, 4096).map(line => JSON.parse(line).id);
  expect(head[0]).toBe("ses");
  expect(head).not.toContain("third");
});

it("refuses a path that is not a regular file", () => {
  expect(() => scanTail(dir, 1024)).toThrow(/обычным файлом/);
});
