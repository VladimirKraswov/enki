// Test source only: creating these temporary databases requires explicit later execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { OpenCodeArchiveReader } from "../../../src/legacy/opencode-reader.ts";
import type { ArchiveDiagnostic, MessageDTO } from "../../../src/legacy/protocol.ts";

const fixtureRoot = fileURLToPath(new URL("../fixtures/legacy/", import.meta.url));
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function contents(directory: string) {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    const stat = fs.statSync(file);
    return { name, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, sha256: digest(fs.readFileSync(file)) };
  });
}

/** Original SQL/expected files are read as data; only a fresh test-owned DB is writable. */
export function fixture(t: TestContext, name: "v1.sql" | "v2.sql", mutate?: (db: DatabaseSync) => void) {
  const original = fs.readFileSync(path.join(fixtureRoot, name));
  const oracle = fs.readFileSync(path.join(fixtureRoot, "expected.json"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "enki-archive-reader-test-"));
  const file = path.join(directory, "synthetic.sqlite");
  let before: ReturnType<typeof contents> | null = null;
  let reader: OpenCodeArchiveReader | null = null;
  t.after(() => {
    try {
      reader?.close();
      if (before !== null) assert.deepEqual(contents(directory), before, "read-only reader changed source bytes, permissions, mtime or sidecars");
      assert.equal(digest(fs.readFileSync(path.join(fixtureRoot, name))), digest(original), "canonical fixture changed");
      assert.equal(digest(fs.readFileSync(path.join(fixtureRoot, "expected.json"))), digest(oracle), "canonical oracle changed");
    } finally {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  // Negative cases intentionally create broken FK rows inside this disposable
  // database. Disable enforcement explicitly; the reader must diagnose them.
  const writable = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  try {
    writable.exec(original.toString("utf8"));
    mutate?.(writable);
  } finally { writable.close(); }
  fs.chmodSync(file, 0o400);
  before = contents(directory);
  return {
    file,
    open(): OpenCodeArchiveReader {
      assert.equal(reader, null, "one owned reader per fixture");
      reader = new OpenCodeArchiveReader(file);
      return reader;
    },
  };
}

export function message(messages: MessageDTO[], id: string): MessageDTO {
  const found = messages.find(value => value.info.id === id);
  assert.ok(found, `missing message ${id}`);
  return found;
}

export function diagnostic(values: readonly ArchiveDiagnostic[], code: string, rowId: string) {
  const found = values.find(value => value.code === code && value.rowId === rowId);
  assert.ok(found, `missing ${code} diagnostic for ${rowId}`);
  return found;
}

export function jsonMessage(db: DatabaseSync, table: "message" | "session_message", id: string,
  transform: (value: Record<string, unknown>) => Record<string, unknown>): void {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
  assert.ok(row && typeof row.data === "string");
  const value: unknown = JSON.parse(row.data);
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(transform({ ...value })), id);
}
