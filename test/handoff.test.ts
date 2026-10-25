// Handoff to another chat (possibly on another computer) over the actual
// RuntimeBackend. Ported from the OpenCodeClient version: same invariants, now
// expressed as runtime commands (POST /commands, idempotent by id) and routes.
// Retired: the per-session agent override (the runtime has one agent).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../src/api/types";
import { RuntimeBackend } from "../src/agent/runtime/backend";
import { deliverHandoff, handoffConnection, handoffText, prepareHandoff, recipientProfile, type HandoffConnection } from "../src/state/handoff";
import { DEFAULT_PREFS } from "../src/state/prefs";
import { FIXTURE_CONNECTION, RuntimeReply, runtimeFixture, type RuntimeFixture } from "./helpers/runtime-fixture";
const remote = vi.hoisted(() => ({ endpoint: "http://127.0.0.1:4500", token: "r".repeat(43) }));
vi.mock("../src/agent/runtime/connection", async (original) => ({ ...(await original<typeof import("../src/agent/runtime/connection")>()),
  remoteConnection: vi.fn(async () => ({ endpoint: remote.endpoint, token: remote.token, instance: "remote", version: "test", contract: 1 })) }));

const session = (id: string, directory: string, extra: Partial<Session> = {}): Session => ({ id, directory, title: id, projectID: "fixture", time: { created: 1, updated: 1 }, ...extra });
const sourceSession = session("ses_source", "/source"), target = session("ses_target", "/target");
let fx: RuntimeFixture, connection: HandoffConnection, source: { session: Session; connection: HandoffConnection };
let targetDTO: Record<string, unknown>, statuses: Record<string, unknown>, permissions: unknown[];
const receipt = (id: string, state = "accepted") => ({ id, kind: "prompt", sessionID: "x", state, createdAt: 1, updatedAt: 1 });
const prefs = { ...DEFAULT_PREFS, modelChoice: { "session:ses_target": { providerID: "target", modelID: "small", variant: "low" } } };
beforeEach(() => {
  fx = runtimeFixture();
  targetDTO = { ...target }; statuses = {}; permissions = [];
  fx.on("GET", "/sessions/:id", () => targetDTO);
  fx.on("GET", "/sessions/status", () => statuses);
  fx.on("GET", "/permissions", () => permissions);
  fx.on("POST", "/commands", c => receipt((c.body as { id: string }).id));
  connection = { client: fx.backend, key: DEFAULT_PREFS.endpoint, hostId: "local", label: "Mac" };
  source = { session: sourceSession, connection };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const commands = () => fx.made("POST", "/commands").map(c => c.body as { id: string; kind: string; sessionID: string; directory: string; payload: Record<string, unknown> });

it("uses the recipient profile and exact directory, never the source model or permissions", async () => {
  const both = { ...prefs, modelChoice: { ...prefs.modelChoice, "session:ses_source": { providerID: "source", modelID: "large" } } };
  const result = await deliverHandoff(connection, target, source, "Deploy on the second host", "Decision: use port 9090", both);
  expect(result.state).toBe("accepted");
  expect(commands()).toEqual([{ id: result.messageID, kind: "prompt", sessionID: target.id, directory: "/target",
    payload: { parts: [{ type: "text", text: expect.stringContaining("Decision: use port 9090") }], model: { providerID: "target", modelID: "small", variant: "low" }, source: "manual" } }]);
  expect(JSON.stringify(commands()[0])).not.toContain("permission");
  expect(fx.made("GET", "/sessions/:id")[0]).toMatchObject({ path: "/sessions/ses_target", query: { directory: "/target" } });
});

it("without the recipient's own model it refuses instead of borrowing a global or source choice", async () => {
  const global = { ...DEFAULT_PREFS, modelChoice: { "*": { providerID: "source", modelID: "big" } } };
  expect(recipientProfile(global, DEFAULT_PREFS.endpoint, target)).not.toHaveProperty("model");
  await expect(deliverHandoff(connection, target, source, "Task", "Context", global)).rejects.toThrow("не выбрана модель");
  expect(commands()).toEqual([]);
  // The recipient's own runtime session model is its profile.
  expect(recipientProfile(global, DEFAULT_PREFS.endpoint, { ...target, model: { providerID: "own", id: "m", variant: "high" } } as Session))
    .toEqual({ model: { providerID: "own", modelID: "m" }, variant: "high" });
});

it("isolates model preferences for the same session ID on another host", () => {
  const scoped = { ...DEFAULT_PREFS, modelChoice: { "session:ses_target": { providerID: "wrong", modelID: "wrong" } }, endpointState: { "ssh:other:4096": { modelChoice: { "session:ses_target": { providerID: "right", modelID: "right" } } } } };
  expect(recipientProfile(scoped, "ssh:other:4096", target).model?.providerID).toBe("right");
});

it("rejects self-send, archived/moved/read-only/subtask targets and busy recipients without submitting", async () => {
  await expect(deliverHandoff(connection, sourceSession, source, "Task", "Context", prefs)).rejects.toThrow("другую");
  for (const changed of [{ time: { created: 1, updated: 1, archived: 4 } }, { directory: "/moved" }, { parentID: "root" }, { origin: { kind: "opencode" } }]) {
    targetDTO = { ...target, ...changed };
    await expect(deliverHandoff(connection, target, source, "Task", "Context", prefs), JSON.stringify(changed)).rejects.toThrow("Выберите получателя заново");
  }
  targetDTO = { ...target };
  for (const status of [{ type: "busy" }, { type: "retry", attempt: 1 }, { type: "waiting", message: "Ожидает вашего ответа" }]) {
    statuses = { [target.id]: status };
    await expect(deliverHandoff(connection, target, source, "Task", "Context", prefs)).rejects.toThrow("занята");
  }
  expect(commands()).toEqual([]);
});

it("does not bypass a pending permission even when the status is idle", async () => {
  permissions = [{ id: "per_1", sessionID: target.id, permission: "bash", patterns: ["ls"] }];
  await expect(deliverHandoff(connection, target, source, "Task", "Context", prefs)).rejects.toThrow("ожидает ответа");
  expect(commands()).toEqual([]);
});

it("a lost acknowledgement is resolved through the ledger by the same id, never by a second command", async () => {
  let n = 0;
  fx.on("POST", "/commands", () => { n++; throw new TypeError("connection reset"); });
  fx.on("GET", "/commands/:id", c => receipt(c.params.id, "running"));
  const result = await deliverHandoff(connection, target, source, "Task", "Context", prefs);
  expect(result.state).toBe("accepted");
  expect(n).toBeGreaterThanOrEqual(1);
  expect(new Set(commands().map(c => c.id))).toEqual(new Set([result.messageID]));
  expect(fx.made("GET", "/commands/:id").map(c => c.params.id)).toEqual([result.messageID]);
});

it("reports uncertainty rather than success or an automatic resend after an unverifiable timeout", async () => {
  fx.on("POST", "/commands", () => { throw new TypeError("connection reset"); });
  fx.on("GET", "/commands/:id", () => { throw new TypeError("offline"); });
  const result = await deliverHandoff(connection, target, source, "Task", "Context", prefs);
  expect(result.state).toBe("uncertain");
  expect(new Set(commands().map(c => c.id))).toEqual(new Set([result.messageID]));
});

it("surfaces a runtime refusal without claiming delivery or probing the ledger", async () => {
  fx.on("POST", "/commands", () => { throw new RuntimeReply(403, { message: "Denied" }); });
  await expect(deliverHandoff(connection, target, source, "Task", "Context", prefs)).rejects.toThrow("Denied");
  fx.on("POST", "/commands", c => ({ ...receipt((c.body as { id: string }).id, "rejected"), error: "Чат удалён" }));
  await expect(deliverHandoff(connection, target, source, "Task", "Context", prefs)).rejects.toMatchObject({ status: 409, detail: "Чат удалён" });
  expect(fx.made("GET", "/commands/:id")).toEqual([]);
});

it("reuses the visible runtime for the same host and opens the destination's own tunnel otherwise, leaving the source untouched", async () => {
  const hosts = { ...DEFAULT_PREFS, remoteHosts: [{ id: "other", name: "Other host", target: "other", port: 4096 }] };
  expect((await handoffConnection(hosts, fx.backend, "local")).client).toBe(fx.backend);
  await expect(handoffConnection(hosts, fx.backend, "gone")).rejects.toThrow("больше не настроен");
  const destination = runtimeFixture({ connection: { endpoint: remote.endpoint, token: remote.token } });
  const sourceBackend = new RuntimeBackend(FIXTURE_CONNECTION, async () => FIXTURE_CONNECTION, "enki-runtime:local");
  const next = await handoffConnection(hosts, sourceBackend, "other");
  expect(next.client).not.toBe(sourceBackend);
  expect(next).toMatchObject({ key: "ssh:other:4096", hostId: "other", label: "Other host" });
  expect(next.client.endpoint).toBe(remote.endpoint);
  expect(next.client.client.authorization().Authorization).toBe(`Bearer ${remote.token}`);
  expect(destination.made("GET", "/health")).toHaveLength(1);
  expect(sourceBackend.endpoint).toBe(FIXTURE_CONNECTION.endpoint);
  expect(sourceBackend.client.authorization().Authorization).toBe(`Bearer ${FIXTURE_CONNECTION.token}`);
});

function preparation(answer = "Goal; early decision; files; access; tests; next step") {
  let promptID = "";
  fx.on("GET", "/sessions/status", () => ({}));
  fx.on("POST", "/sessions/:id/fork", () => session("ses_preparation", "/source"));
  fx.on("PATCH", "/sessions/:id", c => ({ ...session(c.params.id, "/source"), ...(c.body as object) }));
  fx.on("POST", "/commands", c => { promptID = (c.body as { id: string }).id; return receipt(promptID); });
  fx.on("GET", "/commands/:id", c => receipt(c.params.id, "completed"));
  fx.on("GET", "/sessions/:id/messages", () => ({ messages: [{ info: { id: "msg_answer", sessionID: "ses_preparation", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" },
    parts: [{ id: "part", sessionID: "ses_preparation", messageID: "msg_answer", type: "text", text: answer }] }], before: null }));
  fx.on("POST", "/sessions/:id/stop", () => ({ stopped: true }));
  return { prompt: () => promptID };
}
const profile = { model: { providerID: "p", modelID: "m" } };

it("prepares from a full fork with tools denied, then archives only that fork", async () => {
  preparation();
  const result = await prepareHandoff(source, "Deploy on host B", target, connection, profile, new AbortController().signal, { pollMs: 1, timeoutMs: 1000 });
  expect(result).toContain("early decision");
  expect(fx.made("POST", "/sessions/:id/fork")).toEqual([expect.objectContaining({ path: "/sessions/ses_source/fork", query: { directory: "/source" },
    body: { messageID: null, title: "Подготовка передачи: ses_source" } })]);
  const patches = fx.made("PATCH", "/sessions/:id");
  expect(patches.every(c => c.params.id === "ses_preparation")).toBe(true);
  expect(patches[0].body).toEqual({ permission: [{ permission: "*", pattern: "*", action: "deny" }] });
  expect(patches.at(-1)!.body).toEqual({ time: { archived: expect.any(Number) } });
  expect(commands()).toEqual([expect.objectContaining({ sessionID: "ses_preparation", directory: "/source", payload: expect.objectContaining({ model: { providerID: "p", modelID: "m" } }) })]);
  expect(JSON.stringify(commands()[0].payload.parts)).toContain("ВСЕЙ доступной истории");
  expect(fx.made("POST", "/sessions/:id/stop")).toEqual([]);
});

it("refuses concurrent preparation while the source chat is running a task", async () => {
  preparation();
  fx.on("GET", "/sessions/status", () => ({ ses_source: { type: "busy" } }));
  await expect(prepareHandoff(source, "Task", target, connection, profile, new AbortController().signal)).rejects.toThrow("выполняет задачу");
  expect(fx.made("POST", "/sessions/:id/fork")).toEqual([]);
  expect(commands()).toEqual([]);
});

it("cancels and archives its own preparation without stopping the source", async () => {
  preparation();
  const controller = new AbortController();
  fx.on("GET", "/commands/:id", c => { controller.abort(); return receipt(c.params.id, "running"); });
  await expect(prepareHandoff(source, "Task", target, connection, profile, controller.signal, { pollMs: 1, timeoutMs: 1000 })).rejects.toThrow("отменена");
  expect(fx.made("POST", "/sessions/:id/stop").map(c => [c.params.id, c.query.directory])).toEqual([["ses_preparation", "/source"]]);
  expect(fx.made("PATCH", "/sessions/:id").at(-1)!.body).toEqual({ time: { archived: expect.any(Number) } });
  expect(fx.calls.some(c => c.path.startsWith("/sessions/ses_source/") && c.method !== "GET" && !c.path.endsWith("/fork"))).toBe(false);
});

it("bounds the packet and distinguishes source environment from destination", () => {
  expect(handoffText(source, "Deploy elsewhere", "Use SSH alias machine-a")).toContain('"project":"/source"');
  expect(handoffText(source, "Deploy elsewhere", "context")).toContain("не считай их своим окружением");
  expect(() => handoffText(source, "", "ctx")).toThrow();
  expect(() => handoffText(source, "task", "x".repeat(24001))).toThrow("24 000");
});
