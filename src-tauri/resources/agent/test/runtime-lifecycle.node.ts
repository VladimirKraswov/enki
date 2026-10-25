// Actual Runtime/SDK + SQLite + owned loopback transport. Run under the private
// pre-import guard. No real provider, owner resource or external service is used.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, fauxProvider } from "@earendil-works/pi-ai";
import { Runtime, type RuntimeConfig } from "../src/core/runtime.ts";
import { NO_BROKER } from "../src/control/broker.ts";
import { Router, startServer, STREAMING, withStatus } from "../src/server/http.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { DaemonMaintenance } from "../src/daemon-maintenance.ts";
import { acquireStartLease, acquireLease, beginDaemon, beginDaemonMaintenance, endDaemonMaintenance, ensureDaemon, stopDaemon, requestJson, CONTROL, dataHash, DaemonStartupError, type Identity } from "../src/daemon-control.ts";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, SCHEMA_VERSION, SDK_VERSION, type PromptCommand } from "../src/protocol.ts";

function deferred() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
async function until(check: () => boolean, message: string) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error(message); await new Promise(r => setTimeout(r, 5)); } }
async function foundation(t: TestContext, options: Partial<Pick<RuntimeConfig, "capabilities" | "extraExtensions" | "initialMaintenance">> = {}) {
  const harness = process.env.ENKI_SDK_HARNESS_ROOT; assert.ok(harness);
  const root = fs.mkdtempSync(path.join(harness, "tmp/runtime-")), data = path.join(root, "data"), project = path.join(root, "project"), agentDir = path.join(root, "agent");
  for (const dir of [project, agentDir]) fs.mkdirSync(dir, { mode: 0o700 });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), authPath: path.join(agentDir, "unused-auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: `private-${randomUUID()}`, api: `private-${randomUUID()}`, models: [{ id: "one", name: "Private", contextWindow: 8192, maxTokens: 512 }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await Runtime.create({ dataDir: data, agentDir, host: "local", credentials: "memory", broker: NO_BROKER,
    userPiAgentDir: path.join(root, "absent-owner-profile"), legacy: {}, allowModelNetwork: false, version: "private-build",
    modelRuntime, settingsInMemory: true, capabilities: async () => null, ...options });
  const session = options.initialMaintenance
    ? runtime.catalog.insert({ id: randomUUID(), directory: project, title: "Private fixture", model: { providerID: faux.provider.id, modelID: "one" },
      created: Date.now(), updated: Date.now(), archived: null, permission: null, parentId: null, sessionFile: null, origin: { kind: "pi" }, workshop: false })
    : runtime.registry.create({ directory: project, title: "Private fixture", model: { providerID: faux.provider.id, modelID: "one" } });
  const command = (): PromptCommand => ({ id: randomUUID(), kind: "prompt", sessionID: session.id, directory: project, payload: { parts: [{ type: "text", text: "Do not call a real provider" }], model: { providerID: faux.provider.id, modelID: "one" } } });
  let stopped = false;
  t.after(async () => { if (!stopped) await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, data, project, runtime, faux, session, command, markStopped: () => { stopped = true; } };
}
function json(port: number, token: string, method: string, pathname: string, body?: unknown, client?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ hostname: "127.0.0.1", port, method, path: pathname, agent: false,
      headers: { Authorization: `Bearer ${token}`, ...(bytes ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) } : {}), ...(client ? { "X-Enki-Client": client } : {}) } }, response => {
      let data = ""; response.on("data", chunk => { data += chunk; }); response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode!, body: data ? JSON.parse(data) : undefined }));
    }); request.once("error", reject); request.end(bytes);
  });
}

test("retained bearer cannot mutate during maintenance; reads and scoped client identities remain usable", async t => {
  const f = await foundation(t), router = new Router(), token = randomBytes(32).toString("base64url"); let writes = 0;
  router.add("POST", "/write", () => { writes++; return writes; });
  router.add("GET", "/read", request => ({ principal: request.principal, title: f.runtime.catalog.get(f.session.id)?.title }));
  router.add("GET", "/opens", () => f.runtime.registry.worker(f.session.id), { mutation: true });
  const server = await startServer(router, { credentials: { current: token, previous: null }, allowedOrigins: () => [], maxBody: 1024, admit: () => f.runtime.admitMutation() });
  t.after(() => server.close());
  await f.runtime.beginMaintenance();
  assert.equal((await json(server.port, token, "POST", "/write", {})).status, 503);
  assert.equal((await json(server.port, token, "GET", "/opens")).status, 503); assert.equal(writes, 0);
  const client = randomUUID(), a = await json(server.port, token, "GET", "/read", undefined, client), b = await json(server.port, token, "GET", "/read", undefined, client), c = await json(server.port, token, "GET", "/read", undefined, randomUUID());
  assert.equal(a.status, 200); assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  assert.match((a.body as { principal: string }).principal, /^client:[a-f0-9]{64}$/);
  assert.match(((await json(server.port, token, "GET", "/read")).body as { principal: string }).principal, /^authority:/);
  f.runtime.endMaintenance(); assert.equal((await json(server.port, token, "POST", "/write", {})).status, 200); assert.equal(writes, 1);
});

test("an accepted incomplete HTTP body blocks maintenance before its handler starts", async t => {
  const f = await foundation(t), router = new Router(), token = randomBytes(32).toString("base64url"); let writes = 0;
  router.add("POST", "/write", () => ++writes);
  const server = await startServer(router, { credentials: { current: token, previous: null }, allowedOrigins: () => [], maxBody: 1024, admit: () => f.runtime.admitMutation() });
  t.after(() => server.close());
  let request!: http.ClientRequest;
  const result = new Promise<number>((resolve, reject) => { request = http.request({ hostname: "127.0.0.1", port: server.port, path: "/write", method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }); request.on("error", reject); });
  request.write('{"pending":'); await until(() => f.runtime.activity().operations === 1, "body was not reserved");
  await assert.rejects(f.runtime.beginMaintenance(), /busy/); assert.equal(f.runtime.admission.open(), true); assert.equal(writes, 0);
  request.end("true}"); assert.equal(await result, 200); assert.equal(writes, 1);
  await until(() => f.runtime.activity().operations === 0, "HTTP reservation leaked");
});

test("dispatcher reserves real worker opening, rejects concurrent turns and Stop prevents eventual dispatch", async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.open());
  const f = await foundation(t, { capabilities: async () => { entered.open(); await release.promise; return null; } });
  const first = f.command(), second = f.command();
  assert.equal(f.runtime.dispatcher.submit(first).status, 202); await entered.promise;
  assert.equal(f.runtime.dispatcher.inFlight(f.session.id), true); assert.equal(f.runtime.activity().opening, 1);
  assert.equal(f.runtime.dispatcher.submit(second).receipt.state, "rejected");
  await assert.rejects(f.runtime.beginMaintenance(), /busy/);
  await f.runtime.dispatcher.abort(f.session.id); release.open();
  await until(() => f.runtime.ledger.get(first.id)?.state === "cancelled" && f.runtime.dispatcher.preparingCount() === 0, "cancelled preparation did not settle");
  assert.equal(f.faux.state.callCount, 0); assert.equal(f.runtime.registry.history(f.session).length, 0);
});

test("maintenance performs a real private SQLite backup paired with exact schema and build", async t => {
  const f = await foundation(t); await f.runtime.beginMaintenance();
  const id = randomUUID(), receipt = await f.runtime.backupForUpdate(id), target = path.join(f.data, receipt.relativePath);
  assert.equal(receipt.schema, SCHEMA_VERSION); assert.equal(receipt.runtimeVersion, "private-build"); assert.equal(receipt.sdk, SDK_VERSION);
  assert.equal(receipt.sha256, createHash("sha256").update(fs.readFileSync(target)).digest("hex"));
  // Windows chmod exposes the writable/readonly attribute, not POSIX ACL bits.
  // Keep the Unix privacy assertion; the Windows backup must remain writable
  // for its real FlushFileBuffers operation. Content/schema checks apply to both.
  const mode = fs.statSync(target).mode;
  if (process.platform === "win32") assert.equal(mode & 0o200, 0o200);
  else assert.equal(mode & 0o777, 0o600);
  const backup = new DatabaseSync(target, { readOnly: true });
  try { assert.equal(backup.prepare("SELECT title FROM sessions WHERE id=?").get(f.session.id)?.title, "Private fixture"); assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION); }
  finally { backup.close(); }
  await assert.rejects(f.runtime.backupForUpdate(id), /EEXIST/);
  f.runtime.endMaintenance(); await assert.rejects(f.runtime.backupForUpdate(randomUUID()), /обслуживания/);
});

test("UI authority is scoped, reference-counted and independent from the maintenance mutation fence", async t => {
  const f = await foundation(t), principal = "client:" + "a".repeat(64);
  const releaseA = f.runtime.attachUiAuthority(principal, f.session.id, f.project), releaseB = f.runtime.attachUiAuthority(principal, f.session.id, f.project);
  assert.equal(f.runtime.authorizeUi(principal, f.session.id, f.project), true);
  assert.equal(f.runtime.authorizeUi(principal, f.session.id, f.root), false);
  assert.throws(() => f.runtime.attachUiAuthority("authority:" + "a".repeat(64), f.session.id, f.project));
  await f.runtime.beginMaintenance(); assert.equal(f.runtime.authorizeUi(principal, f.session.id, f.project), true); assert.equal(f.runtime.admission.open(), false);
  releaseA(); releaseA(); assert.equal(f.runtime.authorizeUi(principal, f.session.id, f.project), true);
  releaseB(); assert.equal(f.runtime.authorizeUi(principal, f.session.id, f.project), false); f.runtime.endMaintenance();
});

test("daemon maintenance lost ACK is recovered read-only; held OS lease protects stop and backup", async t => {
  const f = await foundation(t), owner = beginDaemon(f.data);
  const identity: Identity = { instance: f.runtime.instance, dataHash: dataHash(f.data), version: "private-build", contract: CONTRACT_VERSION, schema: SCHEMA_VERSION, sdk: SDK_VERSION };
  const router = new Router(), maintenance = new DaemonMaintenance(f.data, identity, f.runtime); let posts = 0, stops = 0;
  router.add("GET", `${CONTROL}/health`, () => ({ identity, state: "ready" }));
  router.add("POST", `${CONTROL}/maintenance`, async request => { posts++; const receipt = await maintenance.execute(request.body); if (posts === 1) { request.response.destroy(); return STREAMING; } return receipt; });
  router.add("GET", `${CONTROL}/maintenance/:id`, request => maintenance.lookup(request.params.id));
  let life!: Lifecycle;
  router.add("POST", `${CONTROL}/shutdown`, request => { maintenance.assertShutdown(request.body); stops++;
    request.response.once("finish", () => { void life.stop(2000).then(result => { owner.close(result); f.markStopped(); }); }); return withStatus(202, { accepted: true, instance: identity.instance }); });
  const server = await startServer(router, { credentials: { current: owner.token, previous: null }, allowedOrigins: () => [], maxBody: 4096, controlPath: p => p.startsWith(CONTROL) });
  life = new Lifecycle({ create: async () => f.runtime, listen: async () => server, ready: () => owner.publish(server.port, identity) }); await life.start();
  t.after(async () => { await server.close(); owner.close(); });
  const lease = acquireStartLease(f.data); t.after(() => lease.release());
  const receipt = await beginDaemonMaintenance(f.data, identity, lease);
  assert.equal(posts, 1); assert.equal(f.runtime.admission.open(), false); assert.equal(receipt.identity.instance, identity.instance);
  assert.equal(fs.existsSync(path.join(f.data, receipt.backup.relativePath)), true);
  await assert.rejects(requestJson(server.port, owner.token, `${CONTROL}/shutdown`, { lease: "z".repeat(43), startOwner: lease.nonce }), /409/); assert.equal(stops, 0);
  await stopDaemon(f.data, identity, { startLease: lease, maintenanceLease: receipt.lease }); assert.equal(stops, 1);
  assert.throws(() => acquireStartLease(f.data), /already held/);
  lease.release();
});

test("maintenance refuses an unheld start nonce and a wrong identity without taking the runtime fence", async t => {
  const f = await foundation(t), identity: Identity = { instance: f.runtime.instance, dataHash: dataHash(f.data), version: "private-build", contract: CONTRACT_VERSION, schema: SCHEMA_VERSION, sdk: SDK_VERSION };
  const maintenance = new DaemonMaintenance(f.data, identity, f.runtime), lease = acquireStartLease(f.data), nonce = lease.nonce; lease.release();
  assert.throws(() => maintenance.execute({ instance: identity.instance, dataHash: identity.dataHash, requestId: randomUUID(), mode: "begin", startOwner: nonce }));
  assert.throws(() => maintenance.execute({ instance: randomUUID(), dataHash: identity.dataHash, requestId: randomUUID(), mode: "begin", startOwner: nonce }));
  assert.equal(f.runtime.admission.open(), true); const free = acquireLease(f.data, "start"); free();
});

test("candidate startup stays fenced through matching health until its installer explicitly commits", async t => {
  const f = await foundation(t, { initialMaintenance: true }), owner = beginDaemon(f.data), lease = acquireStartLease(f.data);
  t.after(() => lease.release());
  const identity: Identity = { instance: f.runtime.instance, dataHash: dataHash(f.data), version: "private-build", contract: CONTRACT_VERSION, schema: SCHEMA_VERSION, sdk: SDK_VERSION };
  const maintenance = new DaemonMaintenance(f.data, identity, f.runtime, lease.nonce), router = new Router(); let mutations = 0;
  router.add("GET", `${CONTROL}/health`, () => ({ identity, state: "ready", maintenance: maintenance.snapshot() })); maintenance.routes(router);
  router.add("POST", "/mutate", () => ++mutations);
  const server = await startServer(router, { credentials: { current: owner.token, previous: null }, allowedOrigins: () => [], maxBody: 4096, admit: () => f.runtime.admitMutation(), controlPath: p => p.startsWith(CONTROL) });
  t.after(() => server.close()); owner.publish(server.port, identity);
  const config = { data: f.data, userPiAgentDir: path.join(f.root, "absent-pi"), startOwner: lease.nonce };
  const actual = await ensureDaemon(config, identity, { executable: process.execPath, entry: fileURLToPath(new URL("../src/main.ts", import.meta.url)), env: {} }, 1000, lease);
  assert.equal(actual.instance, identity.instance); assert.equal(actual.maintenance?.initial, true); assert.ok(actual.maintenance);
  assert.equal((await json(server.port, owner.token, "POST", "/mutate", {})).status, 503); assert.equal(mutations, 0);
  assert.equal(f.runtime.dispatcher.submit(f.command()).receipt.state, "rejected"); assert.equal(f.faux.state.callCount, 0);
  await endDaemonMaintenance(f.data, identity, lease, actual.maintenance);
  assert.equal((await json(server.port, owner.token, "POST", "/mutate", {})).status, 200); assert.equal(mutations, 1);
  await assert.rejects(ensureDaemon(config, identity, { executable: process.execPath, entry: fileURLToPath(new URL("../src/main.ts", import.meta.url)), env: {} }, 1000, lease), /initial maintenance fence/);
  owner.close(); lease.release();
});

test("own daemon child exiting before readiness fails promptly with a typed safe status, not at the deadline", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "enki-ensure-exit-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), crash = path.join(root, "crash.mjs"), reason = path.join(root, "reason.mjs");
  fs.writeFileSync(crash, "process.exit(7);\n");
  fs.writeFileSync(reason, "process.send?.({ type: 'startup-error', message: 'PRIVATE_DB_LOCKED' }, () => process.exit(3));\n");
  const identity = { dataHash: dataHash(data), version: "private-build", contract: CONTRACT_VERSION, schema: SCHEMA_VERSION, sdk: SDK_VERSION };
  const config = { data, userPiAgentDir: path.join(root, "absent-pi") };
  const started = Date.now();
  const error = await ensureDaemon(config, identity, { executable: process.execPath, entry: crash, env: {} }, 15_000).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof DaemonStartupError, String(error));
  assert.equal(error.code, "ENKI_DAEMON_STARTUP_EXITED"); assert.equal(error.exitCode, 7); assert.equal(error.signal, null);
  assert.ok(Date.now() - started < 5_000, "exit must not wait for the 15 s readiness deadline");
  assert.ok(!error.message.includes(crash) && !error.message.includes("--data"), "no argv in the failure");
  const detailed = await ensureDaemon(config, identity, { executable: process.execPath, entry: reason, env: {} }, 15_000).then(() => null, (e: unknown) => e);
  assert.ok(detailed instanceof DaemonStartupError, String(detailed));
  assert.equal(detailed.exitCode, 3); assert.match(detailed.message, /PRIVATE_DB_LOCKED/);
  // The start lease was released by the failed call: a second caller can own it.
  acquireStartLease(data).release();
});
