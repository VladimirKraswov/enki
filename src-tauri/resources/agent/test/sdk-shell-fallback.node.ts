// Run only through the private pre-import network/owner-path guard. Real SDK
// sessions/workers with the faux provider: explicitly configured shell plugins
// (file Bash, file PowerShell, inline Bash) must win over the host's project
// shells, which remain fallbacks that restore the original tool environment.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Database } from "../src/store/db.ts";
import { EventJournal } from "../src/store/events.ts";
import { CommandLedger } from "../src/store/commands.ts";
import { SessionCatalog } from "../src/sessions/catalog.ts";
import { InteractionBroker } from "../src/interaction/broker.ts";
import { ToolJournal } from "../src/execution/tools.ts";
import { SessionWorker, type WorkerDeps } from "../src/sessions/worker.ts";
import { openAgentSession, type SdkSession } from "../src/sdk/adapter.ts";
import type { ScopedResources } from "../src/plugin-ui/scoped-resources.ts";
import { projectToolEnvironment, sdkProfileDirectory } from "../src/platform/environment.ts";
import { shutdownPluginUi } from "../src/plugin-ui/runtime.ts";

const pluginSource = (name: string) => `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: ${JSON.stringify(name)}, label: "Plugin ${name}", description: "Configured plugin ${name}",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    execute: async (_id, input) => ({ content: [{ type: "text", text: "PLUGIN_${name.toUpperCase()}:" + input.command }], details: { plugin: true } }) });
}
`;

async function foundation(t: TestContext, options: { files?: string[]; inline?: InlineExtension[] } = {}) {
  const harness = process.env.ENKI_SDK_HARNESS_ROOT; assert.ok(harness);
  const root = fs.mkdtempSync(path.join(harness, "tmp/shell-fallback-"));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), sessionDir = path.join(root, "sessions"), plugins = path.join(root, "plugins");
  for (const directory of [cwd, agentDir, sessionDir, plugins]) fs.mkdirSync(directory, { mode: 0o700 });
  const extensionPaths = (options.files ?? []).map(name => { const file = path.join(plugins, `${name}-plugin.ts`); fs.writeFileSync(file, pluginSource(name)); return file; });
  const previous = process.env.PI_CODING_AGENT_DIR; if (!sdkProfileDirectory()) process.env.PI_CODING_AGENT_DIR = agentDir;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), authPath: path.join(agentDir, "unused-auth.json"),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: `private-${randomUUID()}`, api: `private-${randomUUID()}`, tokensPerSecond: 100000,
    models: [{ id: "a", name: "A", reasoning: false, contextWindow: 32768, maxTokens: 512 }] });
  runtime.registerNativeProvider(faux.provider);
  const db = new Database(path.join(root, "state.sqlite")), journal = new EventJournal(db), ledger = new CommandLedger(db, journal), catalog = new SessionCatalog(db, journal);
  const record = catalog.insert({ id: randomUUID(), directory: cwd, title: "Shells", created: Date.now(), updated: Date.now(),
    archived: null, permission: null, parentId: null, sessionFile: null, origin: { kind: "pi" }, workshop: false, model: { providerID: faux.provider.id, modelID: "a" } });
  const resources = async () => ({ extensions: options.inline ?? [], extensionPaths, skillPaths: [], promptPaths: [], noDiscoveredExtensions: true, projectTrusted: async () => false });
  const workers = new Set<SessionWorker>();
  const deps: WorkerDeps = { catalog, journal, ledger, interactions: new InteractionBroker(db, journal, 1000), tools: new ToolJournal(db),
    modelRuntime: runtime, agentDir, sessionDir: () => sessionDir, settings: () => ({ inMemory: true, retry: { enabled: false }, compaction: { enabled: false } }),
    resources, onSettled: () => undefined, onUndelivered: () => undefined,
    ui: { db, hostId: "private-host", authorize: (principal, id, directory) => principal === "owner" && id === record.id && directory === cwd,
      native: { copySelection: async () => { throw new Error("not authorized"); }, openUrl: async () => { throw new Error("not authorized"); },
        requestPaste: async () => { throw new Error("not authorized"); }, readGitBranch: async () => undefined },
      submit: async () => { throw new Error("Editor admission is not used by this fixture"); } } };
  t.after(async () => {
    for (const worker of workers) await worker.close("quit");
    await shutdownPluginUi(); db.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = async () => { const worker = await SessionWorker.open(catalog.get(record.id)!, deps); workers.add(worker); return worker; };
  /** Real SDK turn: the faux model calls `tool`; returns the persisted tool output. */
  const runTool = async (worker: SessionWorker, tool: string, command: string): Promise<string> => {
    const id = randomUUID(), call = `call_${id.slice(0, 8)}`;
    faux.setResponses([fauxAssistantMessage([fauxToolCall(tool, { command }, { id: call })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const begun = { id, kind: "prompt" as const, sessionID: record.id, directory: cwd, payload: { parts: [{ type: "text" as const, text: `run ${tool}` }], model: { providerID: faux.provider.id, modelID: "a" } } };
    ledger.begin(begun); await worker.startPrompt(begun);
    const stop = Date.now() + 5000;
    while (!["completed", "failed", "rejected", "cancelled"].includes(ledger.get(id)?.state ?? "")) { if (Date.now() > stop) throw new Error("tool turn timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(ledger.get(id)?.state, "completed");
    const part = worker.history().flatMap(message => message.parts).find(value => value.type === "tool" && value.callID === call);
    assert.ok(part && part.type === "tool"); assert.equal(part.tool, tool);
    return part.state?.output ?? "";
  };
  const resolution = async () => {
    const opened = await openAgentSession({ cwd, agentDir, sessionDir, modelRuntime: runtime, settings: { compaction: { enabled: false }, retry: { enabled: false } }, resources: await resources() });
    t.after(() => opened.runtime.dispose());
    const of = (session: SdkSession) => (session.resourceLoader as ScopedResources).hostToolResolution();
    return { opened, of };
  };
  return { root, cwd, record, open, runTool, resolution };
}

test("configured plugin-file Bash and PowerShell execute instead of the host fallback, which never spawns", async t => {
  const f = await foundation(t, { files: ["bash", "powershell"] }), worker = await f.open();
  assert.deepEqual(worker.extensionErrors, []);
  const bashMarker = path.join(f.root, "BASH_FALLBACK_RAN"), pwshMarker = path.join(f.root, "PWSH_FALLBACK_RAN");
  assert.equal(await f.runTool(worker, "bash", `touch '${bashMarker}'`), `PLUGIN_BASH:touch '${bashMarker}'`);
  assert.equal(await f.runTool(worker, "powershell", `New-Item -ItemType File '${pwshMarker}'`), `PLUGIN_POWERSHELL:New-Item -ItemType File '${pwshMarker}'`);
  assert.equal(fs.existsSync(bashMarker), false); assert.equal(fs.existsSync(pwshMarker), false);
});

test("an inline Bash override wins and keeps the same collision result across reload and newSession exactly once", async t => {
  let executions = 0;
  const inline: InlineExtension = { name: "inline-bash", factory: pi => { pi.registerTool({ name: "bash", label: "Inline bash", description: "Inline override",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    execute: async (_id, input) => { executions += 1; return { content: [{ type: "text", text: `INLINE_BASH:${input.command}` }], details: {} }; } }); } };
  const f = await foundation(t, { inline: [inline] }), worker = await f.open();
  const marker = path.join(f.root, "INLINE_FALLBACK_RAN");
  assert.equal(await f.runTool(worker, "bash", `touch '${marker}'`), `INLINE_BASH:touch '${marker}'`);
  await worker.ui().actions.reload();
  assert.equal(await f.runTool(worker, "bash", `touch '${marker}'`), `INLINE_BASH:touch '${marker}'`);
  assert.equal(executions, 2); assert.equal(fs.existsSync(marker), false);
  const { opened, of } = await f.resolution();
  const expected = { fallbacks: ["powershell"], shadowed: ["bash"] };
  assert.deepEqual(of(opened.session), expected); assert.equal(opened.session.getToolDefinition("bash")?.label, "Inline bash");
  await opened.session.reload(); assert.deepEqual(of(opened.session), expected);
  await opened.runtime.newSession(); assert.deepEqual(of(opened.runtime.session), expected);
  assert.equal(opened.runtime.session.getToolDefinition("bash")?.label, "Inline bash");
});

test("without overrides the host Bash fallback spawns with the original environment, PI_SESSION metadata and HOME", async t => {
  const f = await foundation(t), worker = await f.open();
  // Git Bash converts HOME to an MSYS path; compare its native spelling, not
  // a byte format the shell itself changes before executing any command.
  const home = process.platform === "win32" ? '$(cygpath -w "${HOME-unset}")' : '${HOME-unset}';
  const output = await f.runTool(worker, "bash", `printf '%s|%s|%s|%s|%s' "\${PI_CODING_AGENT_DIR-unset}" "\${PI_OFFLINE-unset}" "\${GOOGLE_APPLICATION_CREDENTIALS-unset}" "${home}" "\${PI_SESSION_ID-unset}"`);
  const env = projectToolEnvironment(process.env);
  const expected = [env.PI_CODING_AGENT_DIR ?? "unset", env.PI_OFFLINE ?? "unset", env.GOOGLE_APPLICATION_CREDENTIALS ?? "unset", process.env.HOME ?? "unset", f.record.id].join("|");
  assert.ok(output.includes(expected), `fallback output ${output} lacks ${expected}`);
  const profile = sdkProfileDirectory();
  if (profile) assert.ok(!output.split("|")[0].includes(profile), "SDK bundled profile leaked into the project shell");
  const { opened, of } = await f.resolution();
  assert.deepEqual(of(opened.session), { fallbacks: ["bash", "powershell"], shadowed: [] });
});
