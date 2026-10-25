import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup, seed } from "./continuation-fixture.ts";
import { validatePiBytes } from "../../src/legacy/pi-jsonl.ts";
import type { SessionRecord } from "../../src/sessions/catalog.ts";
/** The archive's continuation link; any other origin kind is itself a failure. */
function continuedBy(record: SessionRecord): string | undefined {
  if (record.origin.kind !== "opencode") throw new Error(`Source origin changed to ${record.origin.kind}`);
  return record.origin.continuedBy;
}
type RmSync = typeof fs.rmSync;
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-continuation-publish-")), f = setup(root);
  const databases = new Set([f.db]);
  t.after(() => {
    for (const database of databases) if (database.db.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ...f, root, trackDatabase(database: typeof f.db) { databases.add(database); } };
}
test("continuation commits a genuine user-only seed, source link, workshop transfer and exact entry map together", async t => {
  const f = fixture(t), made = await f.importer.continue(f.record(), f.reader, { directory: f.project });
  assert.equal(made.origin.kind, "continuation"); assert.equal(made.workshop, true); assert.equal(f.record().workshop, false);
  assert.equal(continuedBy(f.record()), made.id);
  const parsed = validatePiBytes(fs.readFileSync(made.sessionFile!), { id: made.id, cwd: f.project });
  assert.equal(parsed.entries.filter(e => e.type === "message").length, 1); assert.equal((parsed.entries.find(e => e.type === "message")?.message as { role: string }).role, "user");
  assert.equal(f.db.all("SELECT * FROM legacy_map WHERE pi_session=?", made.id).length, 1);
  assert.equal(f.db.get("SELECT state FROM migration_journal WHERE kind='continuation'")?.state, "committed");
  assert.deepEqual(fs.readdirSync(f.staging), []);
  assert.equal((await f.importer.continue(f.record(), f.reader, { directory: f.project })).id, made.id);
});
test("catalog failure removes only owned seed and rolls back source/workshop/mapping atomically", async t => {
  const f = fixture(t); f.db.db.exec("CREATE TRIGGER fail_mapping BEFORE INSERT ON legacy_map BEGIN SELECT RAISE(ABORT,'SYNTHETIC_MAPPING_FAILURE'); END;");
  await assert.rejects(f.importer.continue(f.record(), f.reader, { directory: f.project }), /SYNTHETIC_MAPPING_FAILURE/);
  assert.equal(f.catalog.all().length, 1); assert.equal(f.record().workshop, true); assert.equal(continuedBy(f.record()), undefined);
  assert.deepEqual(fs.readdirSync(f.sessions).filter(name => name.endsWith(".jsonl")), []); assert.deepEqual(f.db.all("SELECT * FROM legacy_map"), []);
  assert.equal(f.db.get("SELECT state FROM migration_journal WHERE kind='continuation'")?.state, "failed");
});
test("deleted continuation is never resurrected on an idempotent repeat", async t => {
  const f = fixture(t), made = await f.importer.continue(f.record(), f.reader, { directory: f.project }); f.catalog.remove(made.id);
  await assert.rejects(f.importer.continue(f.record(), f.reader, { directory: f.project }), /удалено/); assert.equal(f.catalog.get(made.id), null);
});
test("concurrent continuation/recovery is fenced while the first bounded projection awaits", async t => {
  const f = fixture(t), first = f.importer.continue(f.record(), f.reader, { directory: f.project });
  await assert.rejects(f.importer.continue(f.record(), f.reader, { directory: f.project }), /уже выполняется/);
  assert.throws(() => f.importer.recover(), /ещё создаётся/); await first;
});
test("a source revision changed during projection cannot publish a stale continuation", async t => {
  const f = fixture(t), first = f.importer.continue(f.record(), f.reader, { directory: f.project }), prior = f.record();
  assert.equal(prior.origin.kind, "opencode"); if (prior.origin.kind !== "opencode") throw new Error("Origin");
  f.catalog.update(prior.id, { origin: { ...prior.origin, archive: "b".repeat(64) }, touch: false });
  await assert.rejects(first, /Источник изменился/); assert.equal(f.catalog.all().length, 1); assert.deepEqual(fs.readdirSync(f.sessions).filter(name => name.endsWith(".jsonl")), []);
});
test("failure of a post-commit observer cannot delete a registered session", async t => {
  const f = fixture(t), insert = f.catalog.insert.bind(f.catalog);
  t.mock.method(f.catalog, "insert", (...args: Parameters<typeof insert>) => { const value = insert(...args); f.db.afterCommit(() => { throw new Error("SYNTHETIC_OBSERVER_FAILURE"); }); return value; });
  const made = await f.importer.continue(f.record(), f.reader, { directory: f.project });
  assert.ok(fs.existsSync(made.sessionFile!)); assert.equal(f.catalog.get(made.id)?.origin.kind, "continuation");
});
test("post-commit staging cleanup failure recovers without deleting the live file", async t => {
  const f = fixture(t), remove = fs.rmSync, fault = t.mock.method(fs, "rmSync", (...[file, options]: Parameters<RmSync>) => { if (String(file).startsWith(f.staging + path.sep)) throw Object.assign(new Error("Synthetic cleanup"), { code: "EACCES" }); return remove(file, options); });
  const made = await f.importer.continue(f.record(), f.reader, { directory: f.project }); assert.equal(fs.readdirSync(f.staging).length, 1); fault.mock.restore();
  const before = fs.readFileSync(made.sessionFile!); f.importer.recover(); assert.deepEqual(fs.readFileSync(made.sessionFile!), before); assert.deepEqual(fs.readdirSync(f.staging), []);
});
test("failed cleanup retains the original storage error and the durable recovery phase", async t => {
  const f = fixture(t); f.db.db.exec("CREATE TRIGGER fail_mapping BEFORE INSERT ON legacy_map BEGIN SELECT RAISE(ABORT,'ORIGINAL_STORAGE_FAILURE'); END;");
  const remove = fs.rmSync, fault = t.mock.method(fs, "rmSync", (...[file, options]: Parameters<RmSync>) => { if (String(file).startsWith(f.sessions + path.sep)) throw Object.assign(new Error("Cleanup must not replace cause"), { code: "EACCES" }); return remove(file, options); });
  await assert.rejects(f.importer.continue(f.record(), f.reader, { directory: f.project }), /ORIGINAL_STORAGE_FAILURE/); fault.mock.restore();
  const row = f.db.get("SELECT detail FROM migration_journal WHERE kind='continuation'"); assert.equal(typeof row?.detail, "string"); const detail = JSON.parse(String(row?.detail));
  assert.equal(detail.lastPhase, "published"); assert.ok(detail.cleanup.length > 0); f.importer.recover();
  assert.deepEqual(fs.readdirSync(f.sessions).filter(name => name.endsWith(".jsonl")), []); assert.equal(f.catalog.all().length, 1);
});
test("child death immediately after filesystem publication rolls back the verified orphan on restart", async t => {
  const f = fixture(t); f.db.close();
  const child = fileURLToPath(new URL("./fixtures/continuation-crash.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-transform-types", child, f.root], { env: process.env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /^ENKI_CONTINUATION_PUBLICATION_FAULT$/m);
  if (process.platform === "win32") {
    // TerminateProcess does not provide a POSIX signal. The phase marker and
    // exact orphan/journal checks below still prove the abrupt publication gap.
    assert.equal(result.signal, null); assert.notEqual(result.status, null); assert.notEqual(result.status, 0);
  } else assert.equal(result.signal, "SIGKILL", result.stderr);
  const recovered = setup(f.root, true); f.trackDatabase(recovered.db);
  assert.equal(fs.readdirSync(recovered.sessions).filter(name => name.endsWith(".jsonl")).length, 1); recovered.importer.recover();
  assert.deepEqual(fs.readdirSync(recovered.sessions).filter(name => name.endsWith(".jsonl")), []); assert.equal(recovered.catalog.all().length, 1);
  assert.equal(recovered.db.get("SELECT state FROM migration_journal WHERE kind='continuation'")?.state, "rolled_back");
  assert.equal((await recovered.importer.continue(recovered.record(), recovered.reader, { directory: recovered.project })).origin.kind, "continuation");
});
