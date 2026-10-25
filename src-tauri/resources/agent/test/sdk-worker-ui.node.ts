// Run only through the private pre-import network/owner-path guard. This suite
// uses real high-level SDK sessions, SQLite, workers and virtual TUI surfaces.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ModelRuntime, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Editor, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Database } from "../src/store/db.ts";
import { EventJournal } from "../src/store/events.ts";
import { CommandLedger } from "../src/store/commands.ts";
import { SessionCatalog } from "../src/sessions/catalog.ts";
import { InteractionBroker } from "../src/interaction/broker.ts";
import { ToolJournal } from "../src/execution/tools.ts";
import { SessionWorker, type WorkerDeps, type RunOutcome } from "../src/sessions/worker.ts";
import { SessionRegistry } from "../src/sessions/registry.ts";
import { branchSessionFile, openAgentSession, openSessionReader } from "../src/sdk/adapter.ts";
import { shutdownPluginUi } from "../src/plugin-ui/runtime.ts";
import type { PromptCommand } from "../src/protocol.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string) { const stop = Date.now() + 3000; while (!check()) { if (Date.now() > stop) throw new Error(`Timeout ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function foundation(t: TestContext, extensions: InlineExtension[] = []) {
  const harness = process.env.ENKI_SDK_HARNESS_ROOT; assert.ok(harness);
  const root = fs.mkdtempSync(path.join(harness, "tmp/review-worker-"));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), sessionDir = path.join(root, "sessions");
  for (const directory of [cwd, agentDir, sessionDir]) fs.mkdirSync(directory, { mode: 0o700 });
  // The process-global SDK profile is the immutable one installed by the runner
  // preload (as main.ts does); this fixture's writable agentDir is passed
  // explicitly through WorkerDeps, never by mutating PI_CODING_AGENT_DIR.
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), authPath: path.join(agentDir, "unused-auth.json"),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: `private-${randomUUID()}`, api: `private-${randomUUID()}`, tokensPerSecond: 100000,
    models: [{ id: "a", name: "A", reasoning: false, contextWindow: 8192, maxTokens: 512 }, { id: "b", name: "B", reasoning: false, contextWindow: 4096, maxTokens: 512 }] });
  runtime.registerNativeProvider(faux.provider);
  const db = new Database(path.join(root, "state.sqlite")), journal = new EventJournal(db), ledger = new CommandLedger(db, journal), catalog = new SessionCatalog(db, journal);
  const record = catalog.insert({ id: randomUUID(), directory: cwd, title: "Fixture", created: Date.now(), updated: Date.now(),
    archived: null, permission: null, parentId: null, sessionFile: null, origin: { kind: "pi" }, workshop: false,
    model: { providerID: faux.provider.id, modelID: "a" } });
  const outcomes: RunOutcome[] = [], workers = new Set<SessionWorker>();
  let active: SessionWorker | undefined, loseAck = false;
  const deps: WorkerDeps = { catalog, journal, ledger, interactions: new InteractionBroker(db, journal, 1000), tools: new ToolJournal(db),
    modelRuntime: runtime, agentDir, sessionDir: () => sessionDir, settings: () => ({ inMemory: true, retry: { enabled: false }, compaction: { enabled: false } }),
    resources: async () => ({ extensions, extensionPaths: [], skillPaths: [], promptPaths: [], noDiscoveredExtensions: true, projectTrusted: async () => false }),
    onSettled: (_id, outcome) => { outcomes.push(outcome); }, onUndelivered: (_id, _cwd, texts) => { assert.ok(Array.isArray(texts)); },
    ui: { db, hostId: "private-host", authorize: (principal, id, directory) => principal === "owner" && id === record.id && directory === cwd,
      native: { copySelection: async () => { throw new Error("Native clipboard is not authorized in this fixture"); },
        openUrl: async () => { throw new Error("Native links are not authorized in this fixture"); },
        requestPaste: async () => { throw new Error("Native paste is not authorized in this fixture"); }, readGitBranch: async () => undefined },
      submit: async command => {
        const begun = ledger.begin(command); if (begun.kind === "conflict") throw new Error("ID conflict");
        if (begun.kind === "new") { assert.ok(active); void active.startPrompt(command); }
        if (loseAck) { loseAck = false; throw new Error("SYNTHETIC_ADMISSION_ACK_LOST"); }
        return begun.receipt;
      },
    },
  };
  t.after(async () => {
    for (const worker of workers) await worker.close("quit");
    await shutdownPluginUi(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = async () => { active = await SessionWorker.open(catalog.get(record.id)!, deps); workers.add(active); return active; };
  const command = (id = randomUUID(), model = "a"): PromptCommand => ({ id, kind: "prompt", sessionID: record.id, directory: cwd,
    payload: { parts: [{ type: "text", text: "actual SDK request" }], model: { providerID: faux.provider.id, modelID: model } } });
  return { root, cwd, agentDir, sessionDir, runtime, db, journal, ledger, catalog, record, deps, open, command, faux, outcomes,
    track: (worker: SessionWorker) => { workers.add(worker); }, loseNextAck: () => { loseAck = true; } };
}

test("read-only history and branching preserve original bytes without repairing its missing newline", async t => {
  const f = await foundation(t), file = path.join(f.sessionDir, "source.jsonl");
  const source = [{ type: "session", version: 3, id: "original", timestamp: new Date().toISOString(), cwd: f.cwd },
    { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "original", timestamp: 1 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: fauxAssistantMessage("preserved") }].map(value => JSON.stringify(value)).join("\n");
  fs.writeFileSync(file, source, { mode: 0o400 }); const before = fs.statSync(file);
  assert.deepEqual(openSessionReader(file, f.sessionDir).branch().map(entry => entry.id), ["u1", "a1"]);
  const branch = branchSessionFile(file, f.sessionDir, "u1", f.cwd, "branched");
  assert.equal(openSessionReader(branch, f.sessionDir).id, "branched");
  assert.deepEqual(openSessionReader(branch, f.sessionDir).branch().map(entry => entry.id), ["u1"]);
  assert.equal(fs.readFileSync(file, "utf8"), source); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});

test("high-level factory uses explicit resources and preserves settings across actual SDK reload", async t => {
  const f = await foundation(t); fs.mkdirSync(path.join(f.cwd, ".pi/extensions"), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, ".pi/extensions/forbidden.js"), "throw Error('AMBIENT_PROJECT_EXTENSION_RAN')");
  const opened = await openAgentSession({ cwd: f.cwd, agentDir: f.agentDir, sessionDir: f.sessionDir, modelRuntime: f.runtime,
    settings: { compaction: { enabled: false }, retry: { enabled: false } }, resources: await f.deps.resources(f.record) });
  t.after(() => opened.runtime.dispose());
  assert.deepEqual(opened.extensionErrors, []); assert.equal(opened.session.autoCompactionEnabled, false);
  await opened.session.reload(); assert.equal(opened.session.autoCompactionEnabled, false);
  assert.equal(opened.session.settingsManager.getRetrySettings().enabled, false); assert.equal(f.faux.state.callCount, 0);
});

test("Stop during actual asynchronous model selection fences the prompt before SDK dispatch", async t => {
  const entered = deferred<void>(), gate = deferred<void>(); let armed = false;
  t.after(() => gate.resolve());
  const f = await foundation(t, [pi => { pi.on("model_select", async () => { if (armed) { entered.resolve(); await gate.promise; } }); }]);
  const worker = await f.open(), command = f.command(randomUUID(), "b"); f.ledger.begin(command); armed = true;
  assert.deepEqual(worker.extensionErrors, []);
  const preparing = worker.startPrompt(command);
  await Promise.race([entered.promise, preparing.then(receipt => { throw new Error(`Selection did not start: ${JSON.stringify(receipt)}`); }), new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error("Selection handler was never entered")), 2000).unref(); })]);
  await worker.abort(); gate.resolve(); const receipt = await preparing;
  assert.equal(receipt.state, "cancelled"); assert.equal(f.faux.state.callCount, 0);
  assert.equal(worker.history().length, 0); assert.equal(f.outcomes.length, 0);
});

test("a real SDK run settles once and correlates its receipt with the actual persisted user entry", async t => {
  const f = await foundation(t), worker = await f.open(), command = f.command();
  f.faux.setResponses([fauxAssistantMessage("completed")]); f.ledger.begin(command);
  await worker.startPrompt(command); await until(() => f.ledger.get(command.id)?.state === "completed", "real worker completion");
  assert.equal(f.outcomes.length, 1); assert.equal(f.faux.state.callCount, 1);
  const receipt = f.ledger.get(command.id); assert.ok(receipt?.entryId);
  const file = worker.sessionFile(); assert.ok(file);
  assert.ok(openSessionReader(file, f.sessionDir).all().some(entry => entry.id === receipt.entryId));
  assert.equal(worker.busy(), false);
});

test("staged UI is attachable during session_start, viewer cannot control input and detach does not stop work", async t => {
  const entered = deferred<void>(); let current: SessionWorker | undefined;
  const f = await foundation(t, [pi => { pi.on("session_start", async (_event, ctx) => {
    const waiting = ctx.ui.custom<string>((_tui, _theme, _keys, done) => ({ render: () => ["CUSTOM_REAL"], invalidate: () => {}, handleInput: value => done(value) }));
    entered.resolve(); assert.equal(await waiting, "x");
  }); }]);
  const opening = SessionWorker.open(f.record, f.deps, worker => { current = worker; });
  await entered.promise; assert.ok(current); const surface = current.ui();
  assert.equal(surface.attachment("owner").controllerLeaseId, null);
  const attachment = surface.control("owner"); assert.ok(attachment.controllerLeaseId);
  assert.throws(() => surface.input("viewer", { ...attachment.scope, type: "ui.input", controllerLeaseId: attachment.controllerLeaseId, baseStreamEpoch: attachment.streamEpoch, inputSeq: 1, data: "x" }));
  surface.input("owner", { ...attachment.scope, type: "ui.input", controllerLeaseId: attachment.controllerLeaseId, baseStreamEpoch: attachment.streamEpoch, inputSeq: 1, data: "x" });
  const worker = await opening; f.track(worker);
  const attached = surface.attach("owner", { frame: frame => assert.equal(frame.sessionId, f.record.id), reset: value => assert.equal(value.scope.sessionId, f.record.id), closed: reason => assert.ok(reason) });
  attached.detach(); assert.equal(worker.busy(), false); assert.equal(f.faux.state.callCount, 0);
});

test("uncertain editor admission survives worker reopen, retries same durable ID and does not run twice", async t => {
  const f = await foundation(t); let worker = await f.open();
  f.faux.setResponses([fauxAssistantMessage("one actual invocation")]); f.loseNextAck();
  worker.ui().host.editor.api.setEditorText("original editor prompt");
  const attachment = worker.ui().control("owner"); assert.ok(attachment.controllerLeaseId);
  worker.ui().input("owner", { ...attachment.scope, type: "ui.input", controllerLeaseId: attachment.controllerLeaseId,
    baseStreamEpoch: attachment.streamEpoch, inputSeq: 1, data: "\r" });
  await until(() => f.outcomes.length === 1, "original admission execution");
  assert.equal(f.faux.state.callCount, 1);
  worker.ui().host.editor.api.setEditorText("newer draft"); await worker.close("quit");
  worker = await f.open(); assert.ok(worker.ui().snapshot("owner").pendingSubmission);
  worker.ui().retrySubmission("owner");
  await until(() => worker.ui().snapshot("owner").pendingSubmission === null, "same-ID receipt reconciliation");
  assert.equal(f.faux.state.callCount, 1); assert.equal(worker.ui().host.editor.api.getEditorText(), "newer draft");
});

test("registry shutdown while open awaits resources never publishes a late worker", async t => {
  const f = await foundation(t), gate = deferred<void>(), entered = deferred<void>();
  const original = f.deps.resources; f.deps.resources = async record => { entered.resolve(); await gate.promise; return original(record); };
  const registry = new SessionRegistry(f.catalog, { ...f.deps, retained: () => false, legacyHistory: () => null, trashDir: path.join(f.root, "trash") });
  const opening = registry.worker(f.record.id); const rejected = assert.rejects(opening, /отмен|закры/);
  await entered.promise; const stopping = registry.shutdown(); gate.resolve(); await rejected; await stopping;
  assert.equal(registry.live(f.record.id), undefined); await assert.rejects(registry.worker(f.record.id), /закры/);
});

test("actual SDK tool execution preserves arguments and replaces every provisional message with history IDs", async t => {
  const f = await foundation(t, [pi => { pi.registerTool({ name: "echo", label: "Echo", description: "Private deterministic echo",
    parameters: Type.Object({ value: Type.String() }), execute: async (_id, input) => ({ content: [{ type: "text", text: input.value }], details: { recorded: true } }) }); }]);
  const worker = await f.open(), command = f.command();
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("echo", { value: "kept argument" }, { id: "call_echo" })], { stopReason: "toolUse" }), fauxAssistantMessage("after tool")]);
  f.ledger.begin(command); await worker.startPrompt(command);
  await until(() => f.ledger.get(command.id)?.state === "completed", "tool worker completion");
  const history = worker.history(), part = history.flatMap(message => message.parts).find(value => value.type === "tool");
  assert.ok(part); assert.deepEqual(part.state?.input, { value: "kept argument" }); assert.equal(part.state?.status, "completed");
  assert.equal(part.state?.output, "kept argument"); assert.equal(f.outcomes.length, 1);
  const events = f.journal.replay({ all: true }, 0, 5000); assert.ok(events);
  const provisional = events.flatMap(event => event.event.type === "message.updated" && typeof event.event.properties.info === "object"
    && event.event.properties.info !== null && "id" in event.event.properties.info && typeof event.event.properties.info.id === "string"
    && event.event.properties.info.id.startsWith("live-") ? [event.event.properties.info.id] : []);
  for (const id of new Set(provisional)) assert.ok(events.some(event => event.event.type === "message.removed" && event.event.properties.messageID === id));
  assert.ok(history.every(message => !message.info.id.startsWith("live-")));
});

test("SDK reload and newSession invoke real fresh UI factories exactly once and preserve the old transcript", async t => {
  let starts = 0, disposals = 0;
  const f = await foundation(t, [pi => { pi.on("session_start", (_event, ctx) => {
    starts += 1; ctx.ui.setHeader(() => new Text(`START_${starts}`));
    ctx.ui.setEditorComponent((tui, theme) => Object.assign(new Editor(tui, theme), { dispose: () => { disposals += 1; } }));
  }); }]);
  const worker = await f.open(); assert.equal(starts, 1);
  const epoch = worker.ui().scope.sessionEpoch;
  await worker.ui().actions.reload(); assert.equal(starts, 2); assert.equal(disposals, 1);
  assert.ok(worker.ui().scope.sessionEpoch > epoch);
  const command = f.command(); f.faux.setResponses([fauxAssistantMessage("original transcript")]); f.ledger.begin(command);
  await worker.startPrompt(command); await until(() => f.ledger.get(command.id)?.state === "completed", "before new session");
  const old = worker.sessionFile(); assert.ok(old);
  const original = fs.readFileSync(old, "utf8"); let fresh = false;
  const result = await worker.ui().actions.newSession({ withSession: async ctx => { fresh = true; ctx.ui.setEditorText("fresh context"); } });
  assert.equal(result.cancelled, false); assert.equal(fresh, true); assert.equal(starts, 3); assert.equal(disposals, 2);
  assert.notEqual(worker.sessionFile(), old); assert.equal(fs.readFileSync(old, "utf8"), original);
  assert.equal(worker.ui().host.editor.api.getEditorText(), "fresh context");
  const replacement = worker.sessionFile(); assert.ok(replacement); assert.ok(fs.existsSync(replacement));
  const sdkId = openSessionReader(replacement, f.sessionDir).id;
  await worker.close("quit"); const reopened = await f.open();
  assert.equal(openSessionReader(reopened.sessionFile()!, f.sessionDir).id, sdkId);
});

test("resource compatibility fails closed on package hash drift before executing changed code", async t => {
  const f = await foundation(t);
  // No package mutation: the checked UI boundary accepts a private fake package
  // path solely to prove rejection before any module side effect can run.
  const { resourceCompat } = await import("../src/plugin-ui/resource-compat.ts");
  const root = path.join(f.root, "changed-sdk"); fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"@earendil-works/pi-coding-agent","version":"0.85.1"}');
  fs.writeFileSync(path.join(root, "dist/index.js"), "throw Error('MUST_NOT_RUN')");
  const { pathToFileURL } = await import("node:url");
  await assert.rejects(resourceCompat(pathToFileURL(path.join(root, "dist/index.js"))), /адаптация|провер|SDK/);
});

test("shutdown cancels a staged real custom factory and disposes the editor and extension once", async t => {
  const entered = deferred<void>(); let shutdowns = 0, disposals = 0, cancellations = 0;
  const f = await foundation(t, [pi => {
    pi.on("session_shutdown", () => { shutdowns++; });
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setEditorComponent((tui, theme) => Object.assign(new Editor(tui, theme), { dispose: () => { disposals++; } }));
      const waiting = ctx.ui.custom<string>(() => new Text("waiting for shutdown")); entered.resolve();
      await assert.rejects(waiting, /закры/); cancellations++;
    });
  }]);
  const registry = new SessionRegistry(f.catalog, { ...f.deps, retained: () => false, legacyHistory: () => null, trashDir: path.join(f.root, "trash") });
  const opening = registry.worker(f.record.id); const rejected = assert.rejects(opening, /закры|отмен/);
  await entered.promise; assert.equal(registry.activity().opening, 1); assert.equal(registry.activity().ui, 1); assert.equal(registry.idle(), false);
  await registry.shutdown(); await rejected; await registry.shutdown();
  assert.equal(shutdowns, 1); assert.equal(disposals, 1); assert.equal(cancellations, 1); assert.equal(registry.live(f.record.id), undefined);
});

test("host-wide real theme is broadcast, explicit themes load, and closing one chat preserves the other's UI", async t => {
  const f = await foundation(t);
  const themeFile = path.join(f.agentDir, "enki-theme.json");
  const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(sdkRoot, "dist/modes/interactive/theme/dark.json"), "utf8"));
  assert.ok(raw && typeof raw === "object"); fs.writeFileSync(themeFile, JSON.stringify({ ...raw, name: "enki-explicit-fixture" }));
  const original = f.deps.resources; f.deps.resources = async record => ({ ...await original(record), themePaths: [themeFile] });
  const first = await f.open();
  const secondRecord = f.catalog.insert({ ...f.record, id: randomUUID(), title: "Second", sessionFile: null });
  const second = await SessionWorker.open(secondRecord, f.deps); f.track(second);
  assert.ok(first.ui().themes.getTheme("enki-explicit-fixture"));
  assert.equal(first.ui().themes.setTheme("enki-explicit-fixture").success, true);
  assert.equal(first.ui().state.current().themeName, "enki-explicit-fixture");
  assert.equal(second.ui().state.current().themeName, "enki-explicit-fixture");
  assert.equal(second.ui().themes.theme.name, "enki-explicit-fixture");
  await first.close("quit"); assert.equal(second.ui().themes.setTheme("light").success, true);
  assert.equal(second.ui().state.current().themeName, "light");
  assert.ok(second.ui().themes.getTheme("enki-explicit-fixture"));
});

test("maintenance fences mutation synchronously while retaining authenticated snapshots and SSE", async t => {
  const f = await foundation(t); let held = false; f.deps.ui.admit = () => !held;
  const registry = new SessionRegistry(f.catalog, { ...f.deps, retained: () => false, legacyHistory: () => null, trashDir: path.join(f.root, "trash") });
  t.after(() => registry.shutdown());
  const worker = await registry.worker(f.record.id); const surface = worker.ui();
  const attachment = surface.control("owner"); assert.ok(surface.snapshot("owner").nativeScope);
  let frames = 0; const listener = surface.attach("owner", { reset: () => { frames++; }, frame: () => { frames++; }, closed: () => { throw new Error("Authenticated reader should stay connected during maintenance"); } });
  held = true; registry.setAdmission(false);
  assert.equal(registry.idle(), true); assert.equal(surface.snapshot("owner").draft.text, "");
  assert.throws(() => surface.input("owner", { ...attachment.scope, type: "ui.input", controllerLeaseId: attachment.controllerLeaseId,
    baseStreamEpoch: attachment.streamEpoch, inputSeq: 1, data: "blocked" }), /обслуж/);
  assert.throws(() => registry.create({ directory: f.cwd }), /обслуж/);
  await assert.rejects(registry.worker(f.record.id), /обслуж/);
  surface.resync("owner"); assert.ok(frames > 0); listener.detach();
  held = false; registry.setAdmission(true); assert.equal(await registry.worker(f.record.id), worker);
});

test("failed mandatory inline Enki policy never admits a worker or invokes a model", async t => {
  const f = await foundation(t, [() => { throw new Error("SYNTHETIC_REQUIRED_POLICY_FAILURE"); }]);
  const registry = new SessionRegistry(f.catalog, { ...f.deps, retained: () => false, legacyHistory: () => null, trashDir: path.join(f.root, "trash") });
  t.after(() => registry.shutdown());
  await assert.rejects(registry.worker(f.record.id), /обязательное расширение/);
  assert.equal(registry.live(f.record.id), undefined); assert.equal(registry.activity().opening, 0);
  assert.equal(f.faux.state.callCount, 0); assert.equal(f.catalog.get(f.record.id)?.sessionFile, null);
});
