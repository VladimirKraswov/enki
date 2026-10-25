// Private synthetic regression cases. Never opens an owner DB or loads SDK/model code.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { legacySessionId, OpenCodeImporter, type ArchiveManifest } from "../../src/legacy/opencode-import.ts";
import { ArchiveDataError } from "../../src/legacy/opencode-reader.ts";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import { SessionCatalog } from "../../src/sessions/catalog.ts";

const fixtureSql = fileURLToPath(new URL("./fixtures/legacy/v1.sql", import.meta.url));
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-import-hardening-"));
  const legacy = path.join(root, "archives"), staging = path.join(root, "staging"), source = path.join(root, "source.sqlite");
  fs.mkdirSync(legacy, { mode: 0o700 }); fs.mkdirSync(staging, { mode: 0o700 });
  const writer = new DatabaseSync(source);
  try { writer.exec(fs.readFileSync(fixtureSql, "utf8")); } finally { writer.close(); }
  const db = new Database(path.join(root, "runtime.sqlite"));
  const catalog = new SessionCatalog(db, new EventJournal(db));
  const importer = new OpenCodeImporter(db, catalog, legacy, staging);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, legacy, staging, source, db, catalog, importer };
}
function mutateSource(file: string): void {
  const writer = new DatabaseSync(file);
  try {
    writer.prepare("UPDATE session SET title=title||' source changed' WHERE id=?").run("ses_fixture_main");
    writer.exec("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) SELECT 'ses_fixture_new',project_id,'new','/enki-fixtures/new','New source chat',version,time_created+10000,time_updated+10000 FROM session WHERE id='ses_fixture_main'");
  } finally { writer.close(); }
}
function writeManifest(file: string, manifest: ArchiveManifest): void {
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  fs.chmodSync(file, 0o400);
}
function pendingRecovery(db: Database, archive: string, origin: string): string {
  const job = randomUUID();
  db.run("INSERT INTO migration_journal(id,kind,state,detail,started,updated) VALUES(?,?,?,?,?,?)", job, "opencode", "publishing",
    JSON.stringify({ version: 2, origin, archive }), Date.now(), Date.now());
  return job;
}

test("deleted legacy identity stays tombstoned while a changed source admits unrelated new chats", async t => {
  const f = setup(t), origin = "hardening-tombstone";
  await f.importer.import(f.source, { origin });
  const removed = legacySessionId(origin, "ses_fixture_main"), kept = legacySessionId(origin, "ses_fixture_windows");
  f.catalog.remove(removed);
  const deletedBefore = f.db.get("SELECT deleted,origin FROM sessions WHERE id=?", removed);
  f.catalog.update(kept, { title: "Owner title must survive", permission: [{ permission: "bash", pattern: "*", action: "ask" }] });
  mutateSource(f.source);
  const before = hash(f.source);
  const imported = await f.importer.import(f.source, { origin });
  assert.equal(imported.created, true);
  assert.equal(imported.imported, 1);
  assert.equal(imported.updated, 2);
  assert.equal(f.catalog.get(removed), null, "do not resurrect the owner's deleted chat");
  assert.deepEqual(f.db.get("SELECT deleted,origin FROM sessions WHERE id=?", removed), deletedBefore);
  assert.equal(f.catalog.get(kept)?.title, "Owner title must survive");
  assert.deepEqual(f.catalog.get(kept)?.permission, [{ permission: "bash", pattern: "*", action: "ask" }]);
  assert.ok(f.catalog.get(legacySessionId(origin, "ses_fixture_new")));
  assert.equal(f.catalog.all().length, 3);
  assert.equal(f.importer.archives().length, 2);
  assert.equal(hash(f.source), before);
});

test("a tombstone owned by a different origin kind is a collision, not an identity to silently skip", async t => {
  const f = setup(t), origin = "hardening-tombstone-collision";
  await f.importer.import(f.source, { origin });
  const id = legacySessionId(origin, "ses_fixture_main");
  f.catalog.remove(id);
  f.db.run("UPDATE sessions SET origin=? WHERE id=?", JSON.stringify({ kind: "pi" }), id);
  mutateSource(f.source);
  await assert.rejects(f.importer.import(f.source, { origin }), /занят|другой|источник/i);
  assert.equal(f.catalog.get(id), null);
  assert.equal(f.importer.archives().length, 1);
  assert.equal(f.catalog.get(legacySessionId(origin, "ses_fixture_new")), null);
});

test("recovery rejects rewritten snapshot plus self-consistent disk SHA under an old archive id", async t => {
  const f = setup(t), origin = "hardening-rehashed-snapshot";
  const imported = await f.importer.import(f.source, { origin });
  const file = f.importer.archiveFile(imported.archive.id), manifestFile = path.join(path.dirname(file), "manifest.json");
  const trusted = String(f.db.get("SELECT manifest FROM legacy_archives WHERE id=?", imported.archive.id)?.manifest);
  const manifest: ArchiveManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.chmodSync(file, 0o600);
  const writer = new DatabaseSync(file);
  try { writer.prepare("UPDATE session SET title=? WHERE id=?").run("REPLACED_ARCHIVE", "ses_fixture_main"); } finally { writer.close(); }
  fs.chmodSync(file, 0o400);
  manifest.snapshot.sha256 = hash(file); manifest.snapshot.size = fs.statSync(file).size;
  writeManifest(manifestFile, manifest);
  const job = pendingRecovery(f.db, imported.archive.id, origin);
  assert.throws(() => f.importer.recover(), /идентификатор|SHA256|источник|архив/i);
  assert.equal(f.db.get("SELECT state FROM migration_journal WHERE id=?", job)?.state, "publishing");
  assert.equal(f.db.get("SELECT manifest FROM legacy_archives WHERE id=?", imported.archive.id)?.manifest, trusted);
  assert.ok(fs.existsSync(file), "an untrusted mismatched archive must not be deleted during recovery");
});

test("committed recovery checks trusted DB metadata even when content-addressed snapshot identity is intact", async t => {
  const f = setup(t), origin = "hardening-trusted-manifest";
  const imported = await f.importer.import(f.source, { origin });
  const file = f.importer.archiveFile(imported.archive.id), manifestFile = path.join(path.dirname(file), "manifest.json");
  const manifest: ArchiveManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const originalSha = hash(file);
  manifest.sessions += 1;
  writeManifest(manifestFile, manifest);
  const job = pendingRecovery(f.db, imported.archive.id, origin);
  assert.throws(() => f.importer.recover(), /метаданные|реестр|архив/i);
  assert.equal(hash(file), originalSha);
  assert.equal(f.db.get("SELECT state FROM migration_journal WHERE id=?", job)?.state, "publishing");
});

test("a cleanup failure retains the original validation error and journals its last phase for later recovery", async t => {
  const f = setup(t);
  const writer = new DatabaseSync(f.source);
  try { writer.prepare("UPDATE part SET data=? WHERE id=?").run("{known-primary-json-failure", "prt_fixture_010_text"); } finally { writer.close(); }
  const before = hash(f.source), remove = fs.rmSync;
  let failedCleanup = false;
  const mock = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (String(args[0]).startsWith(f.staging + path.sep) && !failedCleanup) {
      failedCleanup = true;
      throw Object.assign(new Error("SYNTHETIC_CLEANUP_FAILURE"), { code: "EACCES" });
    }
    return remove(...args);
  });
  try {
    await assert.rejects(f.importer.import(f.source), (error: unknown) => {
      assert.ok(error instanceof ArchiveDataError, "the cleanup exception cannot replace the original archive error");
      assert.match(error.message, /prt_fixture_010_text|JSON/i);
      assert.ok(!error.message.includes("SYNTHETIC_CLEANUP_FAILURE"));
      return true;
    });
  } finally { mock.mock.restore(); }
  assert.equal(failedCleanup, true);
  const row = f.db.get("SELECT state,detail FROM migration_journal WHERE kind='opencode'");
  assert.equal(row?.state, "failed");
  const detail: { lastPhase: string; cleanup: string[]; error: string } = JSON.parse(String(row?.detail));
  assert.equal(detail.lastPhase, "snapshotted");
  assert.deepEqual(detail.cleanup, ["staging:EACCES"]);
  assert.match(detail.error, /prt_fixture_010_text|JSON/i);
  assert.equal(f.importer.archives().length, 0);
  assert.equal(f.catalog.all().length, 0);
  assert.equal(hash(f.source), before);
  f.importer.recover();
  assert.deepEqual(fs.readdirSync(f.staging), []);
  assert.equal(f.db.get("SELECT state FROM migration_journal WHERE kind='opencode'")?.state, "rolled_back");
});

test("live import ownership fences recovery and a second importer on the same Database", async t => {
  const f = setup(t);
  const pending = f.importer.import(f.source);
  const second = new OpenCodeImporter(f.db, f.catalog, f.legacy, f.staging);
  assert.throws(() => f.importer.recover(), /импорт.*выполняется|восстановление/i);
  assert.throws(() => second.recover(), /импорт.*выполняется|восстановление/i);
  await assert.rejects(second.import(f.source), /импорт.*выполняется/i);
  assert.equal((await pending).imported, 3);
  assert.doesNotThrow(() => second.recover(), "a completed import must not leave a permanent recovery gate");
});

test("late tampering with an owned staging snapshot during a page yield cannot publish a complete archive", async t => {
  const f = setup(t), chmod = fs.chmodSync;
  const before = hash(f.source);
  let scheduled = false, mutated = false;
  let mutationError: unknown;
  const mock = t.mock.method(fs, "chmodSync", (...args: Parameters<typeof fs.chmodSync>) => {
    chmod(...args);
    const file = String(args[0]);
    if (scheduled || args[1] !== 0o400 || !file.startsWith(f.staging + path.sep) || path.basename(file) !== "snapshot.sqlite") return;
    scheduled = true;
    setImmediate(() => {
      try {
        const replacement = path.join(path.dirname(file), "replacement.sqlite");
        fs.copyFileSync(file, replacement); chmod(replacement, 0o600);
        const writer = new DatabaseSync(replacement);
        try { writer.prepare("UPDATE session SET title=? WHERE id=?").run("LATE_REPLACEMENT", "ses_fixture_main"); } finally { writer.close(); }
        chmod(replacement, 0o400);
        if (process.platform === "win32") {
          // Windows can deny replacing an open SQLite file. Exercise an actual
          // late write instead; integrity/metadata must reject it just as well.
          chmod(file, 0o600); fs.writeFileSync(file, fs.readFileSync(replacement));
        } else fs.renameSync(replacement, file);
        mutated = true;
      } catch (error) { mutationError = error; }
    });
  });
  try { await assert.rejects(f.importer.import(f.source), /снимок.*измен|снимок.*подмен/i); }
  finally { mock.mock.restore(); }
  assert.equal(scheduled, true);
  assert.equal(mutationError, undefined);
  assert.equal(mutated, true, "the test actually tampered with staging while its old SQLite handle was open");
  assert.equal(f.importer.archives().length, 0);
  assert.equal(f.catalog.all().length, 0);
  assert.equal(hash(f.source), before);
});
