import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import { SessionCatalog } from "../../src/sessions/catalog.ts";
import { PiCliImporter, legacyPiSessionId, legacyPiDigest, type PiCliMeta, type PiManifest } from "../../src/legacy/pi-cli.ts";
import { validatePiBytes, runtimePiBytes, PiArchiveError, type ObjectValue } from "../../src/legacy/pi-jsonl.ts";
import { planPiAgentImport, importPiAgent, PiConfigError } from "../../src/legacy/pi-agent.ts";

const fixture = fileURLToPath(new URL("./fixtures/legacy/oldPi.jsonl", import.meta.url));
const corrupt = fileURLToPath(new URL("./fixtures/legacy/corruptPi.jsonl", import.meta.url));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const raw = () => fs.readFileSync(fixture);
const records = () => raw().toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as ObjectValue);
const encode = (rows: ObjectValue[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
function setup(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "enki-pi-import-"))), source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, raw(), { mode: 0o600 });
  const db = new Database(path.join(root, "runtime.sqlite")), catalog = new SessionCatalog(db, new EventJournal(db));
  const roots = { archives: path.join(root, "archives"), staging: path.join(root, "staging"), sessions: path.join(root, "sessions") };
  const importer = new PiCliImporter(db, catalog, roots);
  const meta: PiCliMeta = { id: "fixture.pi.old", directory: "/enki-fixtures/pi", title: "Imported Pi", created: 1767225600000, updated: 1767225609000, archived: 1767225610000,
    permission: [{ permission: "bash", pattern: "*", action: "ask" }] };
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, db, catalog, roots, importer, meta, origin: "synthetic-pi-installation" };
}

test("strict V2 reader preserves every tree entry and dot session id, converts only runtime copy", () => {
  const bytes = raw(), parsed = validatePiBytes(bytes), copied = runtimePiBytes(parsed, "runtime.pi.copy", "fixture-origin");
  assert.equal(parsed.sessionId, "fixture.pi.old"); assert.equal(parsed.entries.length, 10); assert.equal(parsed.leafId, "0000000e");
  assert.equal(parsed.version, 2); assert.equal((parsed.entries[5].message as ObjectValue).role, "hookMessage");
  const runtime = validatePiBytes(copied.bytes);
  assert.equal(runtime.version, 3); assert.equal((runtime.entries[5].message as ObjectValue).role, "custom");
  assert.deepEqual(runtime.entries.map(entry => entry.id), parsed.entries.map(entry => entry.id));
  assert.equal(runtime.entries[7].parentId, "ffffffff", "alternate branch must not be flattened into tool branch");
  assert.deepEqual(fs.readFileSync(fixture), bytes);
});
test("valid JSONL tail without newline is accepted without repairing original", () => {
  const bytes = raw().subarray(0, raw().length - 1), hash = sha(bytes);
  assert.equal(validatePiBytes(bytes).entries.length, 10); assert.equal(sha(bytes), hash);
});
test("malformed middle JSONL line cannot become a complete successful history", () => {
  assert.throws(() => validatePiBytes(fs.readFileSync(corrupt)), (error: unknown) => error instanceof PiArchiveError && error.code === "malformed_json" && error.line === 3);
});
const mutations: Array<[string, (rows: ObjectValue[]) => void, string]> = [
  ["future version", rows => { rows[0].version = 4; }, "unsupported_version"],
  ["missing cwd", rows => { delete rows[0].cwd; }, "invalid_header"],
  ["duplicate entry id", rows => { rows[3].id = rows[2].id; }, "duplicate_entry_id"],
  ["missing parent", rows => { rows[3].parentId = "missing.parent"; }, "missing_or_forward_parent"],
  ["cycle", rows => { rows[2].parentId = rows[3].id; }, "missing_or_forward_parent"],
  ["unknown role", rows => { (rows[2].message as ObjectValue).role = "system"; }, "unsupported_role"],
  ["compaction on foreign branch", rows => { rows[7].firstKeptEntryId = rows[8].id; }, "compaction_not_ancestor"],
  ["missing label target", rows => { rows[9].targetId = "not.a.real.entry"; }, "label_target_missing"],
  ["foreign tool result", rows => { rows[4].parentId = rows[2].id; }, "tool_result_not_on_branch"],
  ["invalid user body", rows => { (rows[2].message as ObjectValue).content = null; }, "invalid_content"],
];
for (const [name, mutate, code] of mutations) test(`strict reader rejects ${name}`, () => {
  const rows = records(); mutate(rows);
  assert.throws(() => validatePiBytes(encode(rows)), (error: unknown) => error instanceof PiArchiveError && error.code === code);
});
test("V1 conversion creates deterministic ids and compaction mapping without executing SDK", () => {
  const rows = records(), header = { ...rows[0], version: 1 };
  const user = { ...rows[2] }; delete user.id; delete user.parentId;
  const assistant = { ...rows[5] }; delete assistant.id; delete assistant.parentId;
  const compaction: ObjectValue = { ...rows[7], firstKeptEntryIndex: 1 }; delete compaction.id; delete compaction.parentId; delete compaction.firstKeptEntryId;
  const bytes = encode([header, user, assistant, compaction]);
  const parsed = validatePiBytes(bytes), first = runtimePiBytes(parsed, "runtime.pi.v1", "origin-v1"), second = runtimePiBytes(parsed, "runtime.pi.v1", "origin-v1");
  assert.deepEqual(first.bytes, second.bytes); assert.equal(parsed.version, 1);
  const target = validatePiBytes(first.bytes);
  assert.equal(target.entries[1].parentId, target.entries[0].id); assert.equal(target.entries[2].firstKeptEntryId, target.entries[0].id);
  assert.deepEqual(parsed.entries.map(entry => entry.id), [undefined, undefined, undefined]);
});
test("invalid UTF8 is explicit and foreign Windows cwd remains opaque", () => {
  assert.throws(() => validatePiBytes(Buffer.from([0xff, 0xfe, 0x00])), /invalid_utf8/);
  const rows = records(); rows[0].cwd = "C:\\Users\\Fixture\\project";
  assert.equal(validatePiBytes(encode(rows)).cwd, "C:\\Users\\Fixture\\project");
});

test("import preserves immutable original, separately owns v3 runtime and retains owner edits on restart", async t => {
  const f = setup(t), before = fs.readFileSync(f.source);
  const result = await f.importer.import(f.source, f.meta, { origin: f.origin });
  assert.equal(result.created, true); assert.equal(result.id, legacyPiSessionId(f.origin, f.meta.id));
  assert.deepEqual(fs.readFileSync(f.importer.archiveFile(result.archive)), before);
  assert.deepEqual(fs.readFileSync(f.source), before);
  assert.equal(fs.statSync(f.importer.archiveFile(result.archive)).mode & 0o777, 0o400);
  const working = f.importer.runtimeFile(result.id), parsed = validatePiBytes(fs.readFileSync(working));
  assert.equal(parsed.version, 3); assert.equal(parsed.sessionId, result.id);
  fs.appendFileSync(working, JSON.stringify({ type: "message", id: "new.user.entry", parentId: parsed.leafId, timestamp: "2026-01-01T00:00:11.000Z", message: { role: "user", content: "new runtime-owned entry", timestamp: 1767225611000 } }) + "\n");
  const modified = fs.readFileSync(working);
  f.catalog.update(result.id, { title: "Owner title", permission: [{ permission: "*", pattern: "*", action: "deny" }] });
  const restarted = new PiCliImporter(f.db, f.catalog, f.roots);
  assert.equal((await restarted.import(f.source, f.meta, { origin: f.origin })).skipped, "already-imported");
  assert.deepEqual(fs.readFileSync(working), modified); assert.equal(f.catalog.get(result.id)?.title, "Owner title");
  assert.deepEqual(f.catalog.get(result.id)?.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
  assert.equal(f.catalog.all().length, 1); assert.equal(f.db.all("SELECT id FROM legacy_archives").length, 1);
});
test("corrupt middle JSONL produces no registration or successful archive", async t => {
  const f = setup(t); fs.writeFileSync(f.source, fs.readFileSync(corrupt));
  const before = fs.readFileSync(f.source);
  await assert.rejects(f.importer.import(f.source, { ...f.meta, id: "fixture.pi.corrupt", directory: "/enki-fixtures/pi-corrupt" }, { origin: f.origin }), /malformed_json/);
  assert.equal(f.catalog.all().length, 0); assert.equal(f.db.all("SELECT id FROM legacy_archives").length, 0);
  assert.deepEqual(fs.readFileSync(f.source), before); assert.deepEqual(fs.readdirSync(f.roots.archives), []);
});
test("metadata cwd mismatch cannot register a transcript in a different project", async t => {
  const f = setup(t);
  await assert.rejects(f.importer.import(f.source, { ...f.meta, directory: "/enki-fixtures/other" }, { origin: f.origin }), /directory_identity_mismatch/);
  assert.equal(f.catalog.all().length, 0);
});
test("existing target corruption is diagnosed instead of skipped or overwritten", async t => {
  const f = setup(t), imported = await f.importer.import(f.source, f.meta, { origin: f.origin });
  const target = f.importer.runtimeFile(imported.id); fs.writeFileSync(target, "CORRUPT TARGET\n");
  await assert.rejects(f.importer.import(f.source, f.meta, { origin: f.origin }), /рабочая копия.*повреждена/);
  assert.equal(fs.readFileSync(target, "utf8"), "CORRUPT TARGET\n"); assert.equal(f.catalog.all().length, 1);
});
test("two installations with identical legacy ids have isolated namespace and originals", async t => {
  const f = setup(t), first = await f.importer.import(f.source, f.meta, { origin: "fixture-installation-1" });
  const second = await f.importer.import(f.source, f.meta, { origin: "fixture-installation-2" });
  assert.notEqual(first.id, second.id); assert.notEqual(first.archive, second.archive); assert.equal(f.catalog.all().length, 2);
  assert.deepEqual(fs.readFileSync(f.importer.archiveFile(first.archive)), fs.readFileSync(f.importer.archiveFile(second.archive)));
});
test("delete then change original then reimport never resurrects the tombstone", async t => {
  const f = setup(t), first = await f.importer.import(f.source, f.meta, { origin: f.origin });
  f.catalog.remove(first.id); const row = f.db.get("SELECT origin,deleted FROM sessions WHERE id=?", first.id);
  const rows = records(); (rows[2].message as ObjectValue).content = "changed original later"; fs.writeFileSync(f.source, encode(rows));
  const result = await f.importer.import(f.source, f.meta, { origin: f.origin });
  assert.equal(result.skipped, "tombstone"); assert.deepEqual(f.db.get("SELECT origin,deleted FROM sessions WHERE id=?", first.id), row);
  assert.equal(f.catalog.all().length, 0); assert.equal(f.db.all("SELECT id FROM legacy_archives").length, 1);
});
test("tombstone from another origin kind is not silently treated as a matching import", async t => {
  const f = setup(t), first = await f.importer.import(f.source, f.meta, { origin: f.origin });
  f.catalog.remove(first.id); f.db.run("UPDATE sessions SET origin=? WHERE id=?", JSON.stringify({ kind: "pi" }), first.id);
  await assert.rejects(f.importer.import(f.source, f.meta, { origin: f.origin }), /занята другой/);
  assert.equal(f.catalog.get(first.id), null);
});
test("source changed after import never overwrites runtime continuation", async t => {
  const f = setup(t), first = await f.importer.import(f.source, f.meta, { origin: f.origin }), target = f.importer.runtimeFile(first.id), before = fs.readFileSync(target);
  const rows = records(); (rows[2].message as ObjectValue).content = "changed original later"; fs.writeFileSync(f.source, encode(rows));
  await assert.rejects(f.importer.import(f.source, f.meta, { origin: f.origin }), /Автоматическое слияние/);
  assert.deepEqual(fs.readFileSync(target), before); assert.equal(f.db.all("SELECT id FROM legacy_archives").length, 1);
});
test("same Database active import fences recovery and second importer", async t => {
  const f = setup(t), pending = f.importer.import(f.source, f.meta, { origin: f.origin });
  assert.throws(() => f.importer.recover(), /ещё выполняется/);
  const other = new PiCliImporter(f.db, f.catalog, f.roots);
  await assert.rejects(other.import(f.source, f.meta, { origin: f.origin }), /ещё выполняется/);
  await pending; f.importer.recover();
});
test("owned staging replacement before publication fails identity/hash verification", async t => {
  const f = setup(t), originalChmod = fs.chmodSync;
  let replaced = false;
  const mocked = t.mock.method(fs, "chmodSync", (file: fs.PathLike, mode: fs.Mode) => {
    originalChmod(file, mode);
    if (String(file).endsWith("original.jsonl") && String(file).includes("staging")) setImmediate(() => {
      const rows = records(); (rows[2].message as ObjectValue).content = "REPLACED_STAGED_ORIGINAL";
      const replacement = `${file}.replacement`; fs.writeFileSync(replacement, encode(rows), { mode: 0o400 }); fs.renameSync(replacement, file); replaced = true;
    });
  });
  await assert.rejects(f.importer.import(f.source, f.meta, { origin: f.origin }), /изменилась|подмен/);
  mocked.mock.restore(); assert.equal(replaced, true); assert.equal(f.catalog.all().length, 0); assert.equal(f.db.all("SELECT id FROM legacy_archives").length, 0);
});
test("cleanup failure does not replace the original validation failure", async t => {
  const f = setup(t); fs.writeFileSync(f.source, fs.readFileSync(corrupt));
  const originalRm = fs.rmSync;
  const mocked = t.mock.method(fs, "rmSync", (file: fs.PathLike, options?: fs.RmOptions) => {
    if (String(file).startsWith(fs.realpathSync(f.roots.staging))) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
    originalRm(file, options);
  });
  await assert.rejects(f.importer.import(f.source, { ...f.meta, id: "fixture.pi.corrupt", directory: "/enki-fixtures/pi-corrupt" }, { origin: f.origin }), error => error instanceof PiArchiveError && error.code === "malformed_json");
  mocked.mock.restore();
  const row = f.db.get("SELECT detail FROM migration_journal WHERE kind='pi-cli'");
  const detail = JSON.parse(String(row?.detail)); assert.equal(detail.lastPhase, "snapshotted"); assert.deepEqual(detail.cleanup, ["staging:EACCES"]);
  f.importer.recover(); assert.deepEqual(fs.readdirSync(f.roots.staging), []);
});
test("post-commit staging cleanup failure stays recoverable without deleting the committed chat", async t => {
  const f = setup(t), originalRm = fs.rmSync;
  const mocked = t.mock.method(fs, "rmSync", (file: fs.PathLike, options?: fs.RmOptions) => {
    if (String(file).startsWith(fs.realpathSync(f.roots.staging))) throw Object.assign(new Error("synthetic cleanup EACCES"), { code: "EACCES" });
    originalRm(file, options);
  });
  await assert.rejects(f.importer.import(f.source, f.meta, { origin: f.origin }), error => error instanceof Error && error.message === "synthetic cleanup EACCES");
  mocked.mock.restore();
  assert.equal(f.catalog.all().length, 1); assert.equal(f.db.all("SELECT id FROM legacy_archives").length, 1);
  assert.equal(f.db.get("SELECT state FROM migration_journal WHERE kind='pi-cli'")?.state, "cleanup_pending");
  f.importer.recover(); assert.equal(f.catalog.all().length, 1); assert.deepEqual(fs.readdirSync(f.roots.staging), []);
  assert.equal(f.db.get("SELECT state FROM migration_journal WHERE kind='pi-cli'")?.state, "committed");
});
for (const crashPhase of ["archive", "working"] as const) test(`process death after ${crashPhase} rename recovers ownership journal and permits one retry`, async t => {
  const f = setup(t), child = path.join(f.root, "crash-child.ts");
  const modules = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
  const crashRoot = crashPhase === "archive" ? f.roots.archives : f.roots.sessions;
  fs.writeFileSync(child, `import fs from 'node:fs';\nimport { Database } from ${modules("../../src/store/db.ts")};\nimport { EventJournal } from ${modules("../../src/store/events.ts")};\nimport { SessionCatalog } from ${modules("../../src/sessions/catalog.ts")};\nimport { PiCliImporter } from ${modules("../../src/legacy/pi-cli.ts")};\nconst options=JSON.parse(process.argv[2]);\nconst db=new Database(options.db);\nconst original=fs.renameSync;\nfs.renameSync=(from,to)=>{original(from,to);if(String(to).startsWith(${JSON.stringify(crashRoot)}+'/'))process.exit(77);};\nawait new PiCliImporter(db,new SessionCatalog(db,new EventJournal(db)),options.roots).import(options.source,options.meta,{origin:options.origin});\nprocess.exit(78);\n`);
  const childResult = spawnSync(process.execPath, ["--experimental-transform-types", child, JSON.stringify({ db: f.db.file, roots: f.roots, source: f.source, meta: f.meta, origin: f.origin })], { encoding: "utf8", timeout: 20000 });
  assert.equal(childResult.status, 77, childResult.stderr); assert.equal(f.db.get("SELECT state FROM migration_journal WHERE kind='pi-cli'")?.state, "publishing");
  assert.equal(f.catalog.all().length, 0); assert.equal(fs.readdirSync(f.roots.archives).length, 1);
  f.importer.recover(); assert.deepEqual(fs.readdirSync(f.roots.archives), []); assert.deepEqual(fs.readdirSync(f.roots.staging), []);
  const result = await f.importer.import(f.source, f.meta, { origin: f.origin }); assert.equal(result.created, true); assert.equal(f.catalog.all().length, 1);
});
test("rewritten archive with updated disk SHA cannot reuse its old content-addressed identity", async t => {
  const f = setup(t), first = await f.importer.import(f.source, f.meta, { origin: f.origin });
  const original = f.importer.archiveFile(first.archive), manifestFile = path.join(path.dirname(original), "manifest.json");
  const manifest: PiManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const rows = records(); (rows[2].message as ObjectValue).content = "REHASHED_IMPOSTOR_ORIGINAL";
  const bytes = encode(rows); fs.chmodSync(original, 0o600); fs.writeFileSync(original, bytes); fs.chmodSync(original, 0o400);
  manifest.source.sha256 = sha(bytes); manifest.source.size = bytes.length;
  fs.chmodSync(manifestFile, 0o600); fs.writeFileSync(manifestFile, JSON.stringify(manifest)); fs.chmodSync(manifestFile, 0o400);
  f.db.run("UPDATE migration_journal SET state='publishing' WHERE kind='pi-cli'");
  assert.throws(() => f.importer.recover(), /Привязка архива/); assert.equal(f.catalog.all().length, 1);
});
test("unregistered existing runtime path remains untouched instead of being adopted", async t => {
  const f = setup(t), id = legacyPiSessionId(f.origin, f.meta.id), file = f.importer.runtimeFile(id);
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, "FOREIGN OWNED FILE");
  await assert.rejects(f.importer.import(f.source, f.meta, { origin: f.origin }), /без доверенной регистрации/);
  assert.equal(fs.readFileSync(file, "utf8"), "FOREIGN OWNED FILE"); assert.equal(f.catalog.all().length, 0); assert.equal(f.db.all("SELECT id FROM legacy_archives").length, 0);
});
test("committed recovery refuses disk manifest tamper against trusted DB", async t => {
  const f = setup(t), first = await f.importer.import(f.source, f.meta, { origin: f.origin });
  const file = path.join(path.dirname(f.importer.archiveFile(first.archive)), "manifest.json"), m: PiManifest = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.chmodSync(file, 0o600); m.createdAt += 1; fs.writeFileSync(file, JSON.stringify(m)); fs.chmodSync(file, 0o400);
  f.db.run("UPDATE migration_journal SET state='publishing' WHERE kind='pi-cli'");
  assert.throws(() => f.importer.recover(), /доверенным реестром/); assert.equal(f.catalog.all().length, 1);
});
test("legacy directory digest matches Rust FNV-1a UTF8 bytes", () => {
  assert.equal(legacyPiDigest(""), "cbf29ce484222325"); assert.equal(legacyPiDigest("a"), "af63dc4c8601ec8c");
  assert.match(legacyPiDigest("/Ёж/🦔"), /^[0-9a-f]{16}$/);
});

function configSetup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-pi-config-"));
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, write };
}
test("Pi configuration removes inline keys, headers and OAuth from every plaintext file", t => {
  const f = configSetup(t);
  f.write("models.json", { providers: { fixture: { baseUrl: "http://localhost:8080/v1", api: "openai-completions", apiKey: "sk-synthetic-inline-only", headers: { Authorization: "Bearer synthetic-secret" }, models: [{ id: "fixture", input: ["text", "image"], contextWindow: 8192, maxTokens: 2048, headers: { "X-Secret": "synthetic-model-secret" } }] } } });
  f.write("auth.json", { oauthfixture: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 123456, accountId: "synthetic-account" } });
  const original = fs.readFileSync(path.join(f.root, "models.json"));
  const plan = planPiAgentImport(f.root, { origin: "fixture-config-origin" });
  const plaintext = plan.files.map(file => file.content).join("\n");
  for (const value of ["sk-synthetic-inline-only", "Bearer synthetic-secret", "synthetic-model-secret", "synthetic-access", "synthetic-refresh", "synthetic-account"])
    assert.equal(plaintext.includes(value), false, value);
  assert.equal(plan.secrets.length, 4); assert.equal(plan.bindings.length, 4); assert.equal(plan.files.some(file => String(file.name) === "auth.json"), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "models.json")), original);
});
test("resource and command settings remain deferred and cannot enable ambient discovery", t => {
  const f = configSetup(t);
  f.write("settings.json", { defaultModel: "fixture-model", retry: { enabled: true, maxRetries: 3 }, extensions: ["/DO_NOT_DISCOVER"], packages: ["npm:do-not-install"], skills: ["/DO_NOT_LOAD"], shellCommandPrefix: "DO_NOT_EXECUTE", defaultProjectTrust: "trusted" });
  const plan = planPiAgentImport(f.root, { origin: "fixture-config" });
  assert.deepEqual(JSON.parse(plan.files[0].content), { defaultModel: "fixture-model", retry: { enabled: true, maxRetries: 3 } });
  assert.equal(plan.deferred.length, 5); assert.equal(JSON.stringify(plan.files).includes("DO_NOT_"), false);
  assert.deepEqual(plan.discovery, { extensions: false, skills: false, prompts: false, packages: false, project: false });
});
test("secret expressions are never evaluated or persisted through an SDK config", t => {
  const f = configSetup(t), marker = path.join(f.root, "must-not-exist");
  f.write("models.json", { providers: { fixture: { apiKey: `!touch ${marker}` } } });
  assert.throws(() => planPiAgentImport(f.root, { origin: "fixture-config" }), /secret_expression_requires_explicit_resolver/);
  assert.equal(fs.existsSync(marker), false);
  f.write("models.json", { providers: { fixture: { apiKey: "$AMBIENT_SECRET_MUST_NOT_READ" } } });
  assert.throws(() => planPiAgentImport(f.root, { origin: "fixture-config" }), /secret_expression_requires_explicit_resolver/);
});
test("unknown settings and credential-bearing URLs fail closed without values in errors", t => {
  const f = configSetup(t), secret = "sk-unknown-setting-secret";
  f.write("settings.json", { unknownSecret: secret });
  assert.throws(() => planPiAgentImport(f.root, { origin: "fixture-config" }), error => error instanceof PiConfigError && !error.message.includes(secret) && !error.message.includes("unknownSecret"));
  fs.rmSync(path.join(f.root, "settings.json"));
  f.write("models.json", { providers: { fixture: { baseUrl: "https://user:synthetic-secret@example.invalid/v1?token=other" } } });
  assert.throws(() => planPiAgentImport(f.root, { origin: "fixture-config" }), /url_requires_explicit_secret_transform/);
});
test("config cannot claim import success without actual native vault plus commit port", async t => {
  const f = configSetup(t); f.write("auth.json", { fixture: { type: "api_key", key: "sk-only-memory-fixture" } });
  const plan = planPiAgentImport(f.root, { origin: "fixture-config" });
  await assert.rejects(importPiAgent(plan, null), /native_vault_and_journal_commit_required/);
  await assert.rejects(importPiAgent(plan, { commit: async () => ({ receiptId: "incomplete", files: [], vaultIds: [] }) }), /incomplete_commit_receipt/);
  assert.deepEqual(fs.readdirSync(f.root), ["auth.json"]);
});
test("config commit accepts only immutable internally validated plans, never a deserialized wire object", async t => {
  const f = configSetup(t); f.write("settings.json", { defaultModel: "fixture" });
  const plan = planPiAgentImport(f.root, { origin: "fixture-config" });
  assert.equal(Object.isFrozen(plan.files[0]), true); assert.equal(Object.isFrozen(plan.secrets), true);
  await assert.rejects(importPiAgent(JSON.parse(JSON.stringify(plan)), null), /internal_validated_plan_required/);
});
test("dangling config symlinks are rejected rather than silently skipped", t => {
  const f = configSetup(t); fs.symlinkSync(path.join(f.root, "missing.json"), path.join(f.root, "auth.json"));
  assert.throws(() => planPiAgentImport(f.root, { origin: "fixture-config" }));
  assert.deepEqual(fs.readdirSync(f.root), ["auth.json"]);
});
