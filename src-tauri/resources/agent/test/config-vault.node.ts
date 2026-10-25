// Config/vault import, restart projection and CredentialStore CAS. Synthetic
// sources and a test-only authority model; no owner profile, keychain or
// network beyond a 127.0.0.1 fixture endpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NO_BROKER } from "../src/control/broker.ts";
import { importPiAgent, planPiAgentImport, PiConfigError } from "../src/legacy/pi-agent.ts";
import { CONFIG_CHUNK, NativePiConfigCommitPort } from "../src/legacy/pi-config-commit.ts";
import { checkModelAccess } from "../src/models/check.ts";
import { ConfigProjection, ConfigUnavailable, headerTarget } from "../src/models/config.ts";
import { CredentialConflict, VaultCredentialStore } from "../src/models/credentials.ts";
import { createModelRuntime } from "../src/sdk/adapter.ts";
import { Runtime } from "../src/core/runtime.ts";
import { FakeAuthority } from "./config-authority-fake.ts";

/** Literal secret text, including SDK-interpolation-looking `$VAR`/`${VAR}`. */
const API_KEY = "abc$VAR-literal-SENTINEL";
const HEADER = "Bearer ${SENTINEL_TOKEN}";
const SECRETS = [API_KEY, HEADER, "drop-SENTINEL", "model-SENTINEL", "SENTINEL-access", "SENTINEL-refresh"];

function scan(root: string): string {
  let out = "";
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    out += entry.isDirectory() ? scan(full) : fs.readFileSync(full, "latin1");
  }
  return out;
}
const noSecrets = (text: string, where: string) => { for (const s of [...SECRETS, "SENTINEL"]) assert.equal(text.includes(s), false, `${s} in ${where}`); };

function setup(t: TestContext, baseUrl = "http://127.0.0.1:9/v1") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "enki-config-vault-")));
  const source = path.join(root, "source-pi-agent"), generations = path.join(root, "native"), agentDir = path.join(root, "agent");
  for (const dir of [source, generations, agentDir]) fs.mkdirSync(dir, { mode: 0o700 });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(source, name), JSON.stringify(value), { mode: 0o600 });
  write("models.json", { providers: { fixture: { baseUrl, api: "openai-completions", apiKey: API_KEY,
    headers: { "X-Imported": HEADER, "X-Drop": "drop-SENTINEL" },
    models: [{ id: "fixture-model", name: "Fixture", contextWindow: 8192, maxTokens: 256, input: ["text"], reasoning: false,
      headers: { "X-Model": "model-SENTINEL", "X-Drop": null } }] } } });
  write("auth.json", { oauthfixture: { type: "oauth", access: "SENTINEL-access", refresh: "SENTINEL-refresh", expires: 1 } });
  write("settings.json", { defaultThinkingLevel: "low", retry: { enabled: false }, extensions: ["/DO_NOT_LOAD"], packages: ["npm:DO_NOT_INSTALL"] });
  // Large inert keybindings force several bounded chunks.
  write("keybindings.json", Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`action.${i}`, [`ctrl+${i}`, `alt+shift+${i}`]])));
  const before = Object.fromEntries(fs.readdirSync(source).map(name => [name, fs.readFileSync(path.join(source, name))]));
  const saved = { VAR: process.env.VAR, SENTINEL_TOKEN: process.env.SENTINEL_TOKEN };
  process.env.VAR = "ENV-LEAK"; process.env.SENTINEL_TOKEN = "ENV-LEAK";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const unchanged = () => {
    assert.deepEqual(fs.readdirSync(source).sort(), Object.keys(before).sort());
    for (const [name, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(source, name)), bytes, `source ${name} changed`);
  };
  return { root, source, generations, agentDir, unchanged, broker: new FakeAuthority(generations) };
}
async function imported(t: TestContext, baseUrl?: string) {
  const f = setup(t, baseUrl);
  const plan = planPiAgentImport(f.source, { origin: "fixture-pi" });
  const result = await importPiAgent(plan, new NativePiConfigCommitPort(f.broker));
  return { ...f, plan, result };
}

test("native port commits the frozen plan in bounded frames; values only travel in secretPut", async t => {
  const f = await imported(t);
  assert.equal(f.result.credentials, 6);
  assert.deepEqual(f.result.deferred.sort(), ["/settings/extensions", "/settings/packages"]);
  const chunks = f.broker.calls.filter(c => c.method === "config.fileChunk");
  assert.ok(chunks.length > 3, "large file was chunked");
  for (const call of f.broker.calls) {
    assert.ok(Buffer.byteLength(call.frame) < 1024 * 1024, `${call.method} frame within control limit`);
    if (call.method !== "config.secretPut") noSecrets(call.frame, call.method);
  }
  const begin = JSON.parse(f.broker.calls.find(c => c.method === "config.begin")!.frame);
  assert.deepEqual(begin.params.manifest.discovery, { extensions: false, skills: false, prompts: false, packages: false, project: false });
  assert.equal("secrets" in begin.params.manifest, false);
  assert.ok(chunks.every(c => Buffer.from(JSON.parse(c.frame).params.dataBase64, "base64").length <= CONFIG_CHUNK));
  noSecrets(scan(f.generations), "published generation");
  f.unchanged();
});

test("lost ACK on commit and on a secret reconcile with the same operation; one receipt, no replay", async t => {
  const f = setup(t);
  const plan = planPiAgentImport(f.source, { origin: "fixture-pi" });
  f.broker.loseAck.add("config.commit"); f.broker.loseAck.add("config.secretPut");
  const receipt = await new NativePiConfigCommitPort(f.broker).commit(plan);
  assert.equal(f.broker.ops.size, 1, "never a second import/operation id");
  assert.equal(f.broker.calls.filter(c => c.method === "config.begin").length, 1);
  assert.equal(f.broker.calls.filter(c => c.method === "config.status").length, 1);
  assert.equal(f.broker.calls.filter(c => c.method === "config.secretPut").length, plan.secrets.length + 1, "only the lost frame is resent, same op");
  assert.equal(receipt.configRevision, 1);
  assert.deepEqual([...receipt.vaultIds].sort(), plan.secrets.map(s => s.id).sort());
});

test("native conflict aborts only this job and surfaces a code without values", async t => {
  const f = setup(t);
  const plan = planPiAgentImport(f.source, { origin: "fixture-pi" });
  f.broker.failNext.set("config.commit", "CONFIG_REVISION_CONFLICT: другой импорт зафиксирован");
  await assert.rejects(new NativePiConfigCommitPort(f.broker).commit(plan), (error: unknown) =>
    error instanceof PiConfigError && error.code === "config_revision_conflict" && !SECRETS.some(s => error.message.includes(s)));
  assert.equal([...f.broker.ops.values()][0].phase, "aborted");
  assert.equal(f.broker.vault.size, 0, "own staged refs removed");
  assert.equal(f.broker.head.revision, 0, "previous config stays active");
});

test("inventory budget and identifier contract are enforced before any native call", async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.source, "auth.json"), JSON.stringify({ big: { type: "oauth", access: "a", refresh: "r", expires: 1, extra: "x".repeat(70_000) } }));
  await assert.rejects(new NativePiConfigCommitPort(f.broker).commit(planPiAgentImport(f.source, { origin: "o" })), /secret_exceeds_os_vault_limit/);
  fs.writeFileSync(path.join(f.source, "auth.json"), JSON.stringify({ "bad provider": { type: "api_key", key: "k" } }));
  await assert.rejects(new NativePiConfigCommitPort(f.broker).commit(planPiAgentImport(f.source, { origin: "o" })), /provider_id_requires_explicit_mapping/);
  assert.equal(f.broker.calls.length, 0);
  await assert.rejects(new NativePiConfigCommitPort(NO_BROKER).commit(planPiAgentImport(f.source, { origin: "o" })), /local_native_vault_required/);
});

test("restart projection resolves literal bindings into memory only, with deterministic header merge", async t => {
  const f = await imported(t);
  const projection = await ConfigProjection.load(f.broker, { agentDir: f.agentDir });
  assert.equal(projection.state, "ready");
  assert.ok(projection.modelsPath?.startsWith(f.generations), "SDK reads the immutable generation, not agentDir");
  const headers = Object.fromEntries(projection.headersFor("fixture", "fixture-model"));
  assert.deepEqual(headers, { "X-Imported": HEADER, "X-Drop": null, "X-Model": "model-SENTINEL" }, "literal ${VAR}; model null deletes provider header");
  assert.deepEqual(Object.fromEntries(projection.headersFor("fixture", "other")), { "X-Imported": HEADER, "X-Drop": "drop-SENTINEL" });
  assert.equal(projection.apiKey("fixture"), API_KEY, "embedded $VAR is not expanded from the environment");
  assert.deepEqual(Object.keys(projection.settings).sort(), ["defaultThinkingLevel", "retry"], "resource settings never become ambient discovery");
  const status = JSON.stringify(projection.status());
  noSecrets(status, "status DTO");
  assert.ok(!status.includes("X-Imported") && !status.includes(f.generations));
  assert.deepEqual(projection.status().deferred.sort(), ["/settings/extensions", "/settings/packages"]);
  assert.equal(headerTarget("/models/providers/p/modelOverrides/org/model/headers/X-A", null)?.model, "org/model");
  assert.equal(headerTarget("/models/providers/p/unknown/headers/X-A", null), null);
});

test("missing or changed binding blocks the bound provider before any request; others continue", async t => {
  const f = await imported(t);
  f.broker.vault.clear();
  const projection = await ConfigProjection.load(f.broker, { agentDir: f.agentDir });
  assert.equal(projection.state, "blocked");
  assert.throws(() => projection.assertAdmissible("fixture"), (e: unknown) => e instanceof ConfigUnavailable && e.code === "CONFIG_SECRET_UNAVAILABLE");
  assert.doesNotThrow(() => projection.assertAdmissible("unrelated"));
  const store = new VaultCredentialStore(f.broker, projection);
  await assert.rejects(store.read("fixture"), /CONFIG_SECRET_UNAVAILABLE/);
  // An unreadable authority blocks all model access rather than guessing.
  const broken = await ConfigProjection.load({ kind: "supervisor", available: () => true, call: async () => { throw new Error("x"); } }, { agentDir: f.agentDir });
  assert.throws(() => broken.assertAdmissible("unrelated"), /CONFIG_UNAVAILABLE/);
  // Owner-edited models.json stays canonical; the import is shadowed, not merged.
  fs.writeFileSync(path.join(f.agentDir, "models.json"), JSON.stringify({ providers: { mine: { baseUrl: "http://127.0.0.1:9/v1" } } }));
  const shadowed = await ConfigProjection.load(f.broker, { agentDir: f.agentDir });
  assert.equal(shadowed.state, "shadowed"); assert.equal(shadowed.modelsPath, null);
});

async function endpoint(t: TestContext) {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.headers); request.resume();
    request.on("end", () => {
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}

test("restarted SDK runtime: ephemeral model check gets literal key + imported headers; blocked binding sends nothing", async t => {
  const server = await endpoint(t);
  const f = await imported(t, server.url);
  const projection = await ConfigProjection.load(f.broker, { agentDir: f.agentDir });
  const modelRuntime = await createModelRuntime({ agentDir: f.agentDir, credentials: { kind: "vault", store: new VaultCredentialStore(f.broker, projection) },
    allowNetwork: false, config: projection });
  const check = () => checkModelAccess(modelRuntime, { providerID: "fixture", modelID: "fixture-model", cwd: f.agentDir, agentDir: f.agentDir, settings: { inMemory: true }, signal: AbortSignal.timeout(30_000) });
  assert.match(await check(), /ответила/);
  const sent = server.seen.at(-1)!;
  assert.equal(sent.authorization, `Bearer ${API_KEY}`);
  assert.equal(sent["x-imported"], HEADER); assert.equal(sent["x-model"], "model-SENTINEL"); assert.equal(sent["x-drop"], undefined);
  noSecrets(scan(f.agentDir), "agentDir (models-store/cache/auth)");
  noSecrets(scan(f.generations), "generation");

  f.broker.vault.clear();
  const blocked = await ConfigProjection.load(f.broker, { agentDir: f.agentDir });
  const blockedRuntime = await createModelRuntime({ agentDir: f.agentDir, credentials: { kind: "vault", store: new VaultCredentialStore(f.broker, blocked) },
    allowNetwork: false, config: blocked });
  const requests = server.seen.length;
  await assert.rejects(checkModelAccess(blockedRuntime, { providerID: "fixture", modelID: "fixture-model", cwd: f.agentDir, agentDir: f.agentDir, settings: { inMemory: true }, signal: AbortSignal.timeout(30_000) }), /CONFIG_/);
  assert.equal(server.seen.length, requests, "no HTTP request without the binding");
  await assert.rejects(createModelRuntime({ agentDir: f.agentDir, credentials: { kind: "agent-dir" }, allowNetwork: false, config: projection }), /auth\.json/);
});

function oauth(access: string, refresh: string) { return { type: "oauth" as const, access, refresh, expires: 1 }; }

test("two independent stores: a concurrent OAuth refresh never overwrites the newer token or reruns the callback", async t => {
  const f = setup(t);
  f.broker.credentials.set("oauthp", { revision: 1, account: "pi-ref:seed" });
  f.broker.vault.set("pi-ref:seed", JSON.stringify(oauth("old", "r1")));
  const first = new VaultCredentialStore(f.broker), second = new VaultCredentialStore(f.broker);
  let calls1 = 0, calls2 = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = first.modify("oauthp", async current => { calls1++; await gate; return { ...(current as ReturnType<typeof oauth>), access: "new-1", refresh: "r2" }; });
  await new Promise(resolve => setImmediate(resolve));
  const fast = await second.modify("oauthp", async current => { calls2++; return { ...(current as ReturnType<typeof oauth>), access: "new-2", refresh: "r3" }; });
  release();
  const lost = await slow;
  assert.equal((fast as ReturnType<typeof oauth>).access, "new-2");
  assert.equal((lost as ReturnType<typeof oauth>).access, "new-2", "loser adopts the committed fresher credential");
  assert.deepEqual([calls1, calls2], [1, 1], "refresh callback is never repeated");
  assert.equal(f.broker.credentials.get("oauthp")?.revision, 2);
  assert.equal(JSON.parse(f.broker.vault.get(f.broker.credentials.get("oauthp")!.account!)!).refresh, "r3");
});

test("API key writes conflict explicitly, lost CAS ACK is idempotent, delete is a tombstone", async t => {
  const f = setup(t);
  const a = new VaultCredentialStore(f.broker), b = new VaultCredentialStore(f.broker);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = a.modify("keyp", async () => { await gate; return { type: "api_key", key: "from-a" }; });
  await new Promise(resolve => setImmediate(resolve));
  await b.modify("keyp", async () => ({ type: "api_key", key: "from-b" }));
  release();
  await assert.rejects(slow, (e: unknown) => e instanceof CredentialConflict && !e.message.includes("from-"));
  assert.deepEqual(await a.read("keyp"), { type: "api_key", key: "from-b" }, "preexisting newer value survives");
  f.broker.loseAck.add("vault.compareAndSet");
  await a.modify("keyp", async () => ({ type: "api_key", key: "rotated" }));
  assert.equal(f.broker.credentials.get("keyp")?.revision, 2, "retried with the same operation id: one revision");
  assert.deepEqual(await a.modify("keyp", async () => undefined), { type: "api_key", key: "rotated" }, "undefined callback is unchanged, not a delete");
  assert.equal(f.broker.credentials.get("keyp")?.revision, 2);
  await a.delete("keyp");
  assert.deepEqual(f.broker.credentials.get("keyp"), { revision: 3, account: null }, "delete is its own CAS tombstone");
  assert.equal(await a.read("keyp"), undefined);
  assert.deepEqual(await a.list(), []);
});

test("imported provider credential is adopted only when none exists; stored credential precedes models.json key", async t => {
  const f = setup(t);
  f.broker.credentials.set("oauthfixture", { revision: 1, account: "pi-ref:user" });
  f.broker.vault.set("pi-ref:user", JSON.stringify(oauth("user-access", "user-refresh")));
  const plan = planPiAgentImport(f.source, { origin: "fixture-pi" });
  const receipt = await new NativePiConfigCommitPort(f.broker).commit(plan);
  assert.deepEqual(receipt.conflicts.map(c => c.policy), ["existing-provider-credential-kept"]);
  const projection = await ConfigProjection.load(f.broker, { agentDir: f.agentDir });
  const store = new VaultCredentialStore(f.broker, projection);
  assert.equal((await store.read("oauthfixture") as ReturnType<typeof oauth>).access, "user-access", "existing credential never overwritten");
  assert.deepEqual(await store.read("fixture"), { type: "api_key", key: API_KEY }, "models.json key is the fallback");
  await store.modify("fixture", async () => ({ type: "api_key", key: "user-entered" }));
  assert.deepEqual(await store.read("fixture"), { type: "api_key", key: "user-entered" }, "stored credential wins over imported key");
  f.unchanged();
});

// CONFIG caller integration (final review): the ACTUAL Runtime caller commits
// for restart only. The running projection stays what it was (no old-endpoint/
// new-key mix) and status says a newer generation is pending; after a restart
// that generation is the active one and nothing is pending.
test("Runtime.importPiConfig reports the committed generation as pending until restart, then active", async t => {
  const f = setup(t), data = path.join(f.root, "data");
  const create = () => Runtime.create({ dataDir: data, agentDir: f.agentDir, host: "local", broker: f.broker, credentials: "vault", userPiAgentDir: f.source,
    legacy: {}, allowModelNetwork: false, version: "private-build", settingsInMemory: true, capabilities: async () => null });
  let runtime = await create();
  t.after(() => runtime.shutdown());
  const before = runtime.configStatus();
  assert.equal(before.state, "none"); assert.equal(before.pendingRestart, undefined);
  const imported = await runtime.importPiConfig();
  assert.equal(imported.applies, "restart");
  const pending = runtime.configStatus();
  assert.equal(pending.state, "none", "the running projection is unchanged");
  assert.deepEqual(pending.pendingRestart, { configRevision: imported.receipt.configRevision, generationId: imported.receipt.generationId });
  await runtime.shutdown();
  runtime = await create();
  const active = runtime.configStatus();
  assert.equal(active.generationId, imported.receipt.generationId);
  assert.notEqual(active.state, "none");
  assert.equal(active.pendingRestart, undefined);
  noSecrets(JSON.stringify(active), "status");
  f.unchanged();
});

test("an explicit isolated profile without a configured Pi source refuses the import and reads nothing", async t => {
  const f = setup(t);
  const runtime = await Runtime.create({ dataDir: path.join(f.root, "data"), agentDir: f.agentDir, host: "local", broker: f.broker, credentials: "vault",
    legacy: {}, allowModelNetwork: false, version: "private-build", settingsInMemory: true, capabilities: async () => null });
  t.after(() => runtime.shutdown());
  const configCalls = () => f.broker.calls.filter(c => c.method.startsWith("config.")).length, calls = configCalls();
  await assert.rejects(runtime.importPiConfig(), /^Error: CONFIG_SOURCE_UNCONFIGURED:/);
  assert.equal(configCalls(), calls, "no native config call");
  f.unchanged();
});
