// Source-only addition; real SQLite WAL and an owned child crash, no SDK.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OpenCodeImporter, snapshotSource } from "../../src/legacy/opencode-import.ts";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import { SessionCatalog } from "../../src/sessions/catalog.ts";

const sql = fileURLToPath(new URL("./fixtures/legacy/v1.sql", import.meta.url));
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("online backup includes committed WAL and excludes an open writer transaction", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-snapshot-wal-"));
  const source = path.join(root, "source.sqlite"), target = path.join(root, "snapshot.sqlite");
  const writer = new DatabaseSync(source);
  t.after(() => { writer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  writer.exec(fs.readFileSync(sql, "utf8"));
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE coherence(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO coherence VALUES(1,7),(2,7);");
  writer.exec("BEGIN IMMEDIATE; UPDATE coherence SET value=11;");
  const mainHash = digest(source), walHash = digest(`${source}-wal`);
  await snapshotSource(source, target);
  assert.equal(digest(source), mainHash, "backup cannot checkpoint/write the source database");
  assert.equal(digest(`${source}-wal`), walHash, "backup cannot append/rewrite source WAL");
  const snapshot = new DatabaseSync(target, { readOnly: true });
  try {
    assert.deepEqual(snapshot.prepare("SELECT value FROM coherence ORDER BY id").all().map((r) => r.value), [7, 7]);
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM session").get()?.n, 3);
  } finally { snapshot.close(); }
  writer.exec("ROLLBACK;");
  assert.equal(writer.prepare("SELECT value FROM coherence WHERE id=1").get()?.value, 7);
});

test("process death after archive rename recovers its journal and allows one retry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-import-crash-"));
  const source = path.join(root, "source.sqlite");
  const writer = new DatabaseSync(source);
  writer.exec(fs.readFileSync(sql, "utf8")); writer.close();
  fs.mkdirSync(path.join(root, "archives")); fs.mkdirSync(path.join(root, "staging"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ["--experimental-transform-types", fileURLToPath(new URL("./fixtures/crash-after-rename.mjs", import.meta.url)), root],
    { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 86, child.stderr);
  const finalDirs = () => fs.readdirSync(path.join(root, "archives")).filter((name) => /^[a-f0-9]{64}$/.test(name));
  assert.equal(finalDirs().length, 1, "the owned child really died after filesystem publish");
  const db = new Database(path.join(root, "runtime.sqlite"));
  try {
    const catalog = new SessionCatalog(db, new EventJournal(db));
    const importer = new OpenCodeImporter(db, catalog, path.join(root, "archives"), path.join(root, "staging"));
    assert.equal(catalog.all().length, 0);
    importer.recover();
    assert.equal(finalDirs().length, 0);
    assert.equal(catalog.all().length, 0);
    const retried = await importer.import(source);
    assert.equal(retried.imported, 3);
    assert.equal(catalog.all().length, 3);
    assert.equal(finalDirs().length, 1);
    const main = catalog.all().find((r) => r.origin.kind === "opencode" && r.origin.legacyId === "ses_fixture_main");
    const branch = catalog.all().find((r) => r.origin.kind === "opencode" && r.origin.legacyId === "ses_fixture_branch");
    assert.equal(branch?.parentId, main?.id);
  } finally { db.close(); }
});
