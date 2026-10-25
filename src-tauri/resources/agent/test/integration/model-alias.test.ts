// Real Runtime/SDK scripted provider; only the authenticated Hub broker is a
// fixture. Missing legacy choices migrate by fresh exact service+target, never
// by names, old route caches, another Hub or an arbitrary default SDK model.
import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { Broker, BrokerMethod } from "../../src/control/broker.ts";
import type { HubRoute } from "../../src/models/hub.ts";
import type { ModelRef } from "../../src/protocol.ts";
import { fauxAssistantMessage, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });
const OLD: ModelRef = { providerID: "local-qwen-next", modelID: "qwen38-flash-next" };
const CANONICAL: ModelRef = { providerID: "enki-scripted", modelID: "scripted-large" };
const TICKET = "11111111-1111-1111-1111-111111111111";
const legacy = (): HubRoute => ({ ...OLD, service: "gpu-qwen", target: "qwen-target", agent: "opencode", label: "Old Qwen" });
const pi = (model: ModelRef = CANONICAL): HubRoute => ({ ...model, service: "gpu-qwen", target: "qwen-target", agent: "pi", label: "Renamed Qwen" });
type Call = { path: string; scope: unknown; body: Record<string, unknown> | null };

function fakeHub(model: ModelRef = CANONICAL) {
  const state = { scope: "hub-a" as string | null, connected: true, routes: [legacy(), pi(model)],
    catalogError: false, catalogRead: null as (() => Promise<void>) | null, duringPrepare: null as (() => void) | null };
  const calls: Call[] = [];
  const broker: Broker = {
    kind: "supervisor", available: () => state.connected,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      if (method === "hub.identity") return { scope: state.scope } as T;
      const path = String(params.path).replace("model-services/", "");
      calls.push({ path, scope: params.scope, body: (params.body ?? null) as Record<string, unknown> | null });
      if (path === "catalog") {
        await state.catalogRead?.();
        if (state.catalogError) throw new Error("fixture catalog unavailable");
        return { schema: 1, routes: state.routes.map(route => ({ ...route })) } as T;
      }
      if (path === "release") return {} as T;
      if (path === "prepare") state.duringPrepare?.();
      if (path === "prepare" || path === "status") return { schema: 1, operation_id: TICKET, phase: "ready", ready: true,
        active_model: "qwen-target", target_model: "qwen-target", elapsed_seconds: 0, active_requests: 0, error: null, loader: null } as T;
      throw new Error(`unexpected broker call ${method}/${path}`);
    },
  };
  return { broker, state, calls, preparations: () => calls.filter(call => call.path === "prepare") };
}

function migrations(h: Harness, sid: string) {
  return (h.runtime.journal.replay({ all: true, sessionID: sid }, 0) ?? []).filter(event => event.event.type === "session.model_migrated");
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("fixture condition did not settle");
}

it("an ordinary legacy prompt selects the exact available SDK model, keeps effort and original durable request", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-manual"), sid = await newSession(h, dir, { model: h.model("small") });
  h.scripted.setResponses([fauxAssistantMessage("canonical answer")]);
  const old = { ...OLD, variant: "medium" };
  const command = promptCommand(h, "alias-manual", sid, dir, "continue", old);
  await h.command(command);
  expect((await h.waitReceipt(command.id, ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(h.scripted.calls()).toBe(1);
  expect(h.runtime.catalog.get(sid)?.model).toEqual({ ...CANONICAL, variant: "medium" });
  expect(h.runtime.registry.live(sid)?.currentModel()).toEqual(CANONICAL);
  // currentModel intentionally exposes identity only. Verify effort in the
  // actual SDK-owned transcript, not just Enki's requested model metadata.
  const entries = fs.readFileSync(h.runtime.catalog.get(sid)!.sessionFile!, "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as { type?: unknown; thinkingLevel?: unknown });
  expect(entries.filter(entry => entry.type === "thinking_level_change").map(entry => entry.thinkingLevel)).toEqual(["off", "medium"]);
  expect(h.runtime.ledger.getRequest(command.id)).toEqual(command);
  expect(fake.preparations().map(call => ({ scope: call.scope, providerID: call.body?.providerID, modelID: call.body?.modelID, agent: call.body?.agent })))
    .toEqual([{ scope: "hub-a", ...CANONICAL, agent: "pi" }]);
  expect(migrations(h, sid).map(event => ({ directory: event.directory, properties: event.event.properties })))
    .toEqual([{ directory: dir, properties: { sessionID: sid, from: OLD, to: CANONICAL } }]);
  // Replaying the original request remains an idempotent duplicate, not a
  // changed-payload conflict or another canonical prompt.
  expect((await h.command(command)).body.duplicate).toBe(true);
  expect(h.scripted.calls()).toBe(1);
  expect(migrations(h, sid)).toHaveLength(1);
});

it("a queued old choice uses the same canonical SDK transition and retains its queued model", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-queue"), sid = await newSession(h, dir, { model: h.model("small") });
  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("first"); }, fauxAssistantMessage("queued answer")]);
  try {
    await h.command(promptCommand(h, "alias-held", sid, dir, "hold", h.model("small")));
    await h.waitReceipt("alias-held", ["running"]);
    expect((await h.request("POST", `/sessions/${sid}/queue`, { id: "alias-q", text: "queued", model: OLD })).status).toBe(200);
    hold.open();
    expect((await h.waitReceipt("queue-alias-q-1", ["completed", "failed", "rejected"])).state).toBe("completed");
    expect(h.scripted.calls()).toBe(2);
    expect(h.runtime.catalog.get(sid)?.model?.providerID).toBe(CANONICAL.providerID);
    expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(CANONICAL.modelID);
    expect(h.runtime.ledger.getRequest("queue-alias-q-1")?.payload).toMatchObject({ model: OLD });
    expect(migrations(h, sid)).toHaveLength(1);
    expect(fake.preparations()).toHaveLength(1);
  } finally { hold.open(); }
});

it.each(["model.set", "model.transition"] as const)("%s resolves the alias without inference or a turn lease", async kind => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-select"), sid = await newSession(h, dir, { model: h.model("small") });
  await h.command({ id: kind, kind, sessionID: sid, directory: dir, payload: { model: OLD } });
  expect((await h.waitReceipt(kind, ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(h.scripted.calls()).toBe(0);
  expect(fake.preparations()).toHaveLength(0);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(CANONICAL.modelID);
  expect(migrations(h, sid)).toHaveLength(1);
});

it("a timer's saved legacy choice migrates without rewriting the timer or wake request", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-timer"), sid = await newSession(h, dir, { model: h.model("small") });
  h.scripted.setResponses([fauxAssistantMessage("timer answer")]);
  const result = await h.request<{ id: string; nextAt: number }>("POST", "/schedules", { directory: dir, sessionID: sid,
    title: "legacy wake", prompt: "wake once", minutes: 5, mode: "once", runAt: Date.now() + 10, model: OLD });
  expect(result.status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 30)); h.runtime.scheduler.tick();
  const id = `schedule-${result.body.id}-${result.body.nextAt}`;
  expect((await h.waitReceipt(id, ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(h.runtime.ledger.getRequest(id)?.payload).toMatchObject({ model: OLD });
  expect(h.runtime.scheduler.list({ sessionID: sid }).tasks[0].model).toEqual(OLD);
  expect(h.scripted.calls()).toBe(1);
  expect(migrations(h, sid)).toHaveLength(1);
});

it("a saved reasoning effort unsupported by the canonical alias refuses before lease, select or inference", async () => {
  const canonical: ModelRef = { providerID: "enki-scripted", modelID: "scripted-small" };
  const fake = fakeHub(canonical); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-effort"), sid = await newSession(h, dir, { model: h.model("large") });
  await h.command(promptCommand(h, "alias-effort", sid, dir, "continue", { ...OLD, variant: "medium" }));
  const receipt = await h.waitReceipt("alias-effort", ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected"); expect(receipt.error).toMatch(/Режим «medium» недоступен/);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0); expect(migrations(h, sid)).toEqual([]);
});

it("an aliased timer with unsupported saved effort preserves its intent and gets a durable refusal", async () => {
  const canonical: ModelRef = { providerID: "enki-scripted", modelID: "scripted-small" };
  const fake = fakeHub(canonical); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-timer-effort"), sid = await newSession(h, dir, { model: h.model("large") });
  const model = { ...OLD, variant: "high" };
  const created = await h.request<{ id: string; nextAt: number }>("POST", "/schedules", { directory: dir, sessionID: sid,
    title: "saved effort", prompt: "keep this intent", minutes: 5, mode: "once", runAt: Date.now() + 10, model });
  expect(created.status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 30)); h.runtime.scheduler.tick();
  const id = `schedule-${created.body.id}-${created.body.nextAt}`;
  const receipt = await h.waitReceipt(id, ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected"); expect(receipt.error).toMatch(/Режим «high» недоступен/);
  expect(h.runtime.scheduler.list({ sessionID: sid }).tasks[0]).toMatchObject({ state: "waiting", enabled: true, model, prompt: "keep this intent", detail: expect.stringMatching(/Режим «high» недоступен/) });
  expect(h.runtime.ledger.getRequest(id)?.payload).toMatchObject({ model });
  expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0); expect(migrations(h, sid)).toEqual([]);
});

it("a missing timer choice with malformed effort still pauses before authoritative delivery", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-timer-syntax"), sid = await newSession(h, dir, { model: h.model("small") });
  const task = h.runtime.scheduler.add({ directory: dir, sessionID: sid, title: "bad syntax", prompt: "keep intent",
    minutes: 5, mode: "once", runAt: 1, model: { ...OLD, variant: "turbo" } });
  h.runtime.scheduler.tick();
  expect(h.runtime.scheduler.list({ sessionID: sid }).tasks[0]).toMatchObject({ id: task.id, state: "error", enabled: false,
    prompt: "keep intent", model: { ...OLD, variant: "turbo" }, detail: expect.stringMatching(/Режим «turbo» больше недоступен/) });
  expect(h.runtime.ledger.get(`schedule-${task.id}-${task.nextAt}`)).toBeNull();
  expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0); expect(migrations(h, sid)).toEqual([]);
});

it("a migrated canonical model stays Hub-gated after disconnection instead of becoming a direct provider", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  const dir = h.project("alias-retained-ownership"), sid = await newSession(h, dir, { model: h.model("small") });
  h.scripted.setResponses([fauxAssistantMessage("first canonical answer"), fauxAssistantMessage("must not run directly")]);
  await h.command(promptCommand(h, "alias-first", sid, dir, "continue", OLD));
  expect((await h.waitReceipt("alias-first", ["completed", "failed", "rejected"])).state).toBe("completed");
  await until(() => !h!.runtime.dispatcher.inFlight(sid));
  expect(h.runtime.hub.route(CANONICAL.providerID, CANONICAL.modelID)).toBeDefined();
  fake.state.connected = false;
  await h.command(promptCommand(h, "canonical-offline", sid, dir, "continue", CANONICAL));
  const receipt = await h.waitReceipt("canonical-offline", ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected"); expect(receipt.error).toMatch(/Hub.*не подключён/);
  expect(h.scripted.calls()).toBe(1); expect(migrations(h, sid)).toHaveLength(1);
});

it.each([
  ["different service", [legacy(), { ...pi(), service: "other-gpu" }]],
  ["different target", [legacy(), { ...pi(), target: "other-model" }]],
  ["ambiguous legacy route", [legacy(), { ...legacy(), target: "other-model" }, pi()]],
  ["ambiguous available Pi choices", [legacy(), pi(), pi({ providerID: "enki-scripted", modelID: "scripted-medium" })]],
  ["unavailable Pi choice", [legacy(), pi({ providerID: "absent-provider", modelID: "absent-model" })]],
  ["missing legacy source", [pi()]],
  ["nonlegacy source", [{ ...legacy(), agent: "pi" }, pi()]],
  ["conflicting canonical route", [legacy(), pi(), { ...pi(), service: "another-service" }]],
] as const)("%s refuses before SDK inference, selection or migration", async (_name, routes) => {
  const fake = fakeHub(); fake.state.routes = [...routes]; h = await harness({ broker: fake.broker });
  const dir = h.project("alias-refusal"), sid = await newSession(h, dir, { model: h.model("small") });
  const before = h.model("small");
  await h.command(promptCommand(h, "alias-refuse", sid, dir, "do not dispatch", OLD));
  const receipt = await h.waitReceipt("alias-refuse", ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected"); expect(receipt.error).toMatch(/Выберите доступную модель/);
  expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0);
  expect(h.runtime.catalog.get(sid)?.model).toMatchObject(before); expect(migrations(h, sid)).toEqual([]);
});

it("historical routes from another Hub are not fresh alias authority", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  await h.runtime.hub.refresh();
  expect(h.runtime.hub.route(OLD.providerID, OLD.modelID)).toBeDefined();
  fake.state.scope = "hub-b"; fake.state.routes = [pi()];
  const dir = h.project("alias-scope-cache"), sid = await newSession(h, dir, { model: h.model("small") });
  await h.command(promptCommand(h, "alias-stale", sid, dir, "continue", OLD));
  expect((await h.waitReceipt("alias-stale", ["completed", "failed", "rejected"])).state).toBe("rejected");
  expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0);
  expect(migrations(h, sid)).toEqual([]);
});

it.each(["disconnected", "unreadable", "maintenance"] as const)("%s cannot migrate a missing SDK model", async mode => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  if (mode === "disconnected") fake.state.connected = false;
  if (mode === "unreadable") fake.state.catalogError = true;
  if (mode === "maintenance") h.runtime.hub.setAdmission(false);
  const dir = h.project("alias-unavailable"), sid = await newSession(h, dir, { model: h.model("small") });
  await h.command(promptCommand(h, "alias-nohub", sid, dir, "continue", OLD));
  expect((await h.waitReceipt("alias-nohub", ["completed", "failed", "rejected"])).state).toBe("rejected");
  expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0); expect(migrations(h, sid)).toEqual([]);
});

it("an already available SDK choice does not invoke alias discovery", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  await h.runtime.hub.refresh();
  const reads = fake.calls.filter(call => call.path === "catalog").length;
  const dir = h.project("alias-no-extra"), sid = await newSession(h, dir, { model: h.model("small") });
  h.scripted.setResponses([fauxAssistantMessage("direct answer")]);
  await h.command(promptCommand(h, "already-present", sid, dir, "continue", h.model("small")));
  expect((await h.waitReceipt("already-present", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(fake.calls.filter(call => call.path === "catalog")).toHaveLength(reads);
  expect(migrations(h, sid)).toEqual([]); expect(h.scripted.calls()).toBe(1);
});

it("Stop during alias discovery fences a late catalog result before fit/select/inference", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  await h.runtime.hub.refresh();
  const hold = gate(); let entered = false;
  fake.state.catalogRead = async () => { entered = true; await hold.wait; };
  const dir = h.project("alias-stop"), sid = await newSession(h, dir, { model: h.model("small") });
  try {
    await h.command(promptCommand(h, "alias-stop", sid, dir, "continue", OLD));
    await until(() => entered);
    await h.request("POST", `/sessions/${sid}/stop`, {}); hold.open();
    expect((await h.waitReceipt("alias-stop", ["completed", "failed", "rejected", "cancelled"])).state).toBe("cancelled");
    expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0); expect(migrations(h, sid)).toEqual([]);
    expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  } finally { hold.open(); }
});

it("a Hub scope change while reading the alias catalog is refused", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  await h.runtime.hub.refresh();
  fake.state.catalogRead = async () => { fake.state.scope = "hub-b"; };
  const dir = h.project("alias-read-scope"), sid = await newSession(h, dir, { model: h.model("small") });
  await h.command(promptCommand(h, "alias-read-scope", sid, dir, "continue", OLD));
  const receipt = await h.waitReceipt("alias-read-scope", ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected"); expect(receipt.error).toMatch(/Подключение к Hub изменилось/);
  expect(h.scripted.calls()).toBe(0); expect(fake.preparations()).toHaveLength(0); expect(migrations(h, sid)).toEqual([]);
});

it("a Hub scope change after source compaction cannot lease/select the alias on another Hub", async () => {
  const small: ModelRef = { providerID: "enki-scripted", modelID: "scripted-small" };
  const fake = fakeHub(small); h = await harness({ broker: fake.broker });
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const dir = h.project("alias-summary-scope"), sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("noted ".repeat(800)), fauxAssistantMessage("tail ".repeat(100))]);
  for (const [id, text] of [["long-1", "context ".repeat(4000)], ["long-2", "more ".repeat(2500)]] as const) {
    await h.command(promptCommand(h, id, sid, dir, text, h.model("large"))); await h.waitReceipt(id, ["completed"]);
  }
  const file = h.runtime.catalog.get(sid)!.sessionFile!, before = fs.readFileSync(file, "utf8");
  const hold = gate(); let entered = false;
  const summaries: Array<{ provider: string; model: string; system: boolean; history: boolean; prefix: boolean }> = [];
  const summarize: FauxResponseStep = async (context, _options, _state, model) => {
    const text = JSON.stringify(context.messages);
    summaries.push({ provider: model.provider, model: model.id, system: /context summarization assistant/i.test(context.systemPrompt ?? ""),
      history: text.includes("The messages above are a conversation to summarize"), prefix: text.includes("This is the PREFIX of a turn") });
    expect(model.id).toBe(h!.scripted.models.large); entered = true; await hold.wait; return fauxAssistantMessage("Short task summary.");
  };
  // The real SDK split-turn path summarizes history AND the retained turn's
  // prefix. Both must finish on the source before target readiness can run.
  h.scripted.setResponses([summarize, summarize]);
  try {
    await h.command(promptCommand(h, "alias-summary", sid, dir, "continue", OLD));
    await until(() => entered); fake.state.scope = "hub-b"; hold.open();
    const receipt = await h.waitReceipt("alias-summary", ["completed", "failed", "rejected"]);
    expect(receipt.state).toBe("rejected"); expect(receipt.error).toMatch(/Подключение к Hub изменилось/);
    expect(h.scripted.calls()).toBe(4); expect(fake.preparations()).toHaveLength(0);
    expect(summaries).toEqual([
      { provider: h.scripted.provider, model: h.scripted.models.large, system: true, history: true, prefix: false },
      { provider: h.scripted.provider, model: h.scripted.models.large, system: true, history: false, prefix: true },
    ]);
    expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
    expect(fs.readFileSync(file, "utf8").startsWith(before)).toBe(true); expect(migrations(h, sid)).toEqual([]);
  } finally { hold.open(); }
});

it("a scope change during target preparation refuses after ready and releases the old-scope ticket", async () => {
  const fake = fakeHub(); h = await harness({ broker: fake.broker });
  fake.state.duringPrepare = () => { fake.state.scope = "hub-b"; };
  const dir = h.project("alias-prepare-scope"), sid = await newSession(h, dir, { model: h.model("small") });
  await h.command(promptCommand(h, "alias-prepare-scope", sid, dir, "continue", OLD));
  expect((await h.waitReceipt("alias-prepare-scope", ["completed", "failed", "rejected"])).state).toBe("rejected");
  expect(h.scripted.calls()).toBe(0); expect(migrations(h, sid)).toEqual([]);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  expect(fake.calls.filter(call => call.path === "release").map(call => ({ scope: call.scope, ticket: call.body?.ticket })))
    .toEqual([{ scope: "hub-a", ticket: TICKET }]);
});
