// Source-only proposal, not run. Intended location: agent/test/.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { legacySessionId, OpenCodeImporter } from "../../src/legacy/opencode-import.ts";
import { SessionCatalog } from "../../src/sessions/catalog.ts";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";

const fixtureSql = fileURLToPath(new URL("./fixtures/legacy/v1.sql", import.meta.url));
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-legacy-import-"));
  const legacy = path.join(root, "archives");
  const staging = path.join(root, "staging");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.mkdirSync(staging, { mode: 0o700 });
  let db = new Database(path.join(root, "runtime.sqlite"));
  let journal = new EventJournal(db);
  let catalog = new SessionCatalog(db, journal);
  let importer = new OpenCodeImporter(db, catalog, legacy, staging);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, legacy, staging,
    get db() { return db; }, get catalog() { return catalog; }, get journal() { return journal; },
    get importer() { return importer; },
    source(name = "source.sqlite") {
      const file = path.join(root, name);
      const source = new DatabaseSync(file);
      try { source.exec(fs.readFileSync(fixtureSql, "utf8")); }
      finally { source.close(); }
      return file;
    },
    reopen() {
      db.close();
      db = new Database(path.join(root, "runtime.sqlite"));
      journal = new EventJournal(db);
      catalog = new SessionCatalog(db, journal);
      importer = new OpenCodeImporter(db, catalog, legacy, staging);
      importer.recover();
    },
  };
}

test("archive and source mapping survive repeated import and runtime restart", async (t) => {
  const f = setup(t);
  const source = f.source();
  const before = sha(source);
  const first = await f.importer.import(source);
  assert.equal(first.imported, 3);
  const records = f.catalog.all();
  const ids = records.map((r) => r.id).sort();
  assert.equal(new Set(ids).size, 3);
  f.reopen();
  const repeated = await f.importer.import(source);
  assert.equal(repeated.created, false);
  assert.equal(repeated.archive.id, first.archive.id);
  assert.deepEqual(f.catalog.all().map((r) => r.id).sort(), ids);
  assert.equal(f.importer.archives().length, 1);
  assert.equal(sha(source), before);
});

test("same legacy session ids from two origins never merge", async (t) => {
  const f = setup(t);
  const a = f.source("origin-a.sqlite");
  const b = f.source("origin-b.sqlite");
  const writer = new DatabaseSync(b);
  writer.prepare("UPDATE session SET title=? WHERE id=?").run("Different origin", "ses_fixture_main");
  writer.close();
  const one = await f.importer.import(a);
  const two = await f.importer.import(b);
  assert.notEqual(one.archive.id, two.archive.id);
  const origins = f.catalog.all().filter((r) => r.origin.kind === "opencode" && r.origin.legacyId === "ses_fixture_main");
  assert.equal(origins.length, 2);
  assert.notEqual(origins[0].id, origins[1].id);
});

test("catalog failure after publishing archive can recover and retry", async (t) => {
  const f = setup(t);
  const source = f.source();
  f.db.db.exec("CREATE TRIGGER synthetic_fail_archive BEFORE INSERT ON legacy_archives BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_COMMIT_FAILURE'); END;");
  await assert.rejects(f.importer.import(source), /SYNTHETIC_COMMIT_FAILURE/);
  assert.equal(f.catalog.all().length, 0);
  f.db.db.exec("DROP TRIGGER synthetic_fail_archive;");
  f.reopen();
  const recovered = await f.importer.import(source);
  assert.equal(recovered.imported, 3);
  assert.equal(f.catalog.all().length, 3);
  assert.equal(f.importer.archives().length, 1);
  const finalDirs = fs.readdirSync(f.legacy).filter((name) => fs.statSync(path.join(f.legacy, name)).isDirectory());
  assert.equal(finalDirs.length, 1, "no invisible orphan archives after failed commit");
});

test("projectless history is registered rather than silently skipped", async (t) => {
  const f = setup(t);
  const source = f.source();
  const writer = new DatabaseSync(source);
  writer.prepare("UPDATE session SET directory='' WHERE id=?").run("ses_fixture_main");
  writer.close();
  const imported = await f.importer.import(source);
  assert.equal(imported.imported, 3);
  assert.ok(f.catalog.all().some((r) => r.origin.kind === "opencode" && r.origin.legacyId === "ses_fixture_main"));
});

test("corrupt body cannot produce a successful complete archive manifest", async (t) => {
  const f = setup(t);
  const source = f.source();
  const writer = new DatabaseSync(source);
  writer.prepare("UPDATE part SET data=? WHERE id=?").run("{broken", "prt_fixture_010_text");
  assert.ok(writer.prepare("SELECT COUNT(*) AS n FROM part WHERE data=?").get("{broken")?.n, "fixture corruption must affect a real row");
  writer.close();
  const before = sha(source);
  await assert.rejects(f.importer.import(source), /JSON|поврежд|формат|prt_fixture_010_text/i);
  assert.equal(f.importer.archives().length, 0);
  assert.equal(f.catalog.all().length, 0);
  assert.equal(sha(source), before);
});

test("a later catalog failure emits no imported chat before rollback; retry publishes committed rows", async (t) => {
  const f = setup(t);
  const source = f.source();
  const origin = "fixture-catalog-rollback";
  const branch = legacySessionId(origin, "ses_fixture_branch");
  f.db.db.exec(`CREATE TRIGGER synthetic_fail_second_chat BEFORE INSERT ON sessions WHEN NEW.id='${branch}' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_SECOND_CHAT_FAILURE'); END;`);
  const observer = new DatabaseSync(path.join(f.root, "runtime.sqlite"), { readOnly: true });
  const seen: Array<{ id: string; committed: boolean }> = [];
  const stop = f.journal.subscribe({ all: true }, (envelope) => {
    if (envelope.event.type !== "session.created" || !envelope.sessionID) return;
    const committed = !!observer.prepare("SELECT id FROM sessions WHERE id=?").get(envelope.sessionID);
    seen.push({ id: envelope.sessionID, committed });
  });
  try {
    await assert.rejects(f.importer.import(source, { origin }), /SYNTHETIC_SECOND_CHAT_FAILURE/);
    assert.deepEqual(seen, [], "no phantom first chat can escape a rolled-back archive");
    assert.equal(f.catalog.all().length, 0);
    f.db.db.exec("DROP TRIGGER synthetic_fail_second_chat;");
    const retried = await f.importer.import(source, { origin });
    assert.equal(retried.imported, 3);
    // The earlier deepEqual(seen, []) assertion narrows `seen` to never[]; the
    // subscriber has appended since, so read it through its declared type.
    const observed: ReadonlyArray<{ id: string; committed: boolean }> = seen as Array<{ id: string; committed: boolean }>;
    assert.equal(observed.length, 3);
    assert.ok(observed.every((event) => event.committed), "subscribers see only durable imported chats");
  } finally { stop(); observer.close(); }
});
