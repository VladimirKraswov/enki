// Frontend model choice → ONE durable runtime `model.transition`. Written, NOT RUN.
// Covers: applied, busy → deferred (nothing interrupted), typed failure with
// recovery from session.context_transition, Stop → cancelled, lost ACK →
// receipt lookup under the SAME id (never a second command), 404 → same-id
// resubmit, uncertain → unknown, closing the dialog → detached (no abort sent).
import { describe, expect, it, vi } from "vitest";
import type { CommandReceipt, CommandRequest } from "../src-tauri/resources/agent/src/protocol";
import { ApiError, ConnectionError } from "../src/api/http";
import { parseTransitionProgress, recoveryText, requestModelTransition, transitionText, type ContextTransitionProgress, type TransitionPort } from "../src/state/modelTransition";
import { AgentDialogs, routeRuntimeEvent, type RuntimeSyncHost } from "../src/state/runtimeSync";

const model = { providerID: "local", modelID: "small", variant: null };
const receipt = (state: CommandReceipt["state"], error?: string): CommandReceipt =>
  ({ id: "mt-1", kind: "model.transition", sessionID: "s1", state, ...(error ? { error } : {}), createdAt: 1, updatedAt: 1 });

function port(script: { command: Array<CommandReceipt | Error>; receipt: Array<CommandReceipt | Error> }) {
  const commands: CommandRequest[] = [], lookups: string[] = [];
  const next = <T>(list: Array<T | Error>): T => { const value = list.shift(); if (!value) throw new Error("unexpected call"); if (value instanceof Error) throw value; return value; };
  const p: TransitionPort = {
    command: vi.fn(async (request: CommandRequest) => { commands.push(request); return next(script.command); }),
    receipt: vi.fn(async (id: string) => { lookups.push(id); return next(script.receipt); }),
  };
  return { p, commands, lookups };
}
const input = { id: "mt-1", sessionID: "s1", directory: "/p", model, pollMs: 1 };

describe("requestModelTransition", () => {
  it("submits exactly one model.transition and follows its receipt to completion", async () => {
    const { p, commands } = port({ command: [receipt("accepted")], receipt: [receipt("running"), receipt("completed")] });
    expect(await requestModelTransition(p, input)).toEqual({ kind: "applied" });
    expect(commands).toEqual([{ id: "mt-1", kind: "model.transition", sessionID: "s1", directory: "/p", payload: { model } }]);
  });

  it("a busy chat defers the choice instead of interrupting the running model", async () => {
    const { p, commands } = port({ command: [receipt("rejected", "В этом чате уже выполняется или готовится операция. Дождитесь её завершения либо остановите её.")], receipt: [] });
    expect((await requestModelTransition(p, input)).kind).toBe("deferred");
    expect(commands).toHaveLength(1); // no abort, no compaction, no retry loop
  });

  it("a typed failure carries the runtime's recovery for THIS operation only", async () => {
    const progress: ContextTransitionProgress = { sessionID: "s1", operation: "mt-1", phase: "failed", source: null, target: model, code: "does_not_fit", recovery: ["larger_model", "new_session_handoff"] };
    const { p } = port({ command: [receipt("accepted")], receipt: [receipt("failed", "История не помещается.")] });
    const outcome = await requestModelTransition(p, { ...input, progress: () => progress });
    expect(outcome).toEqual({ kind: "failed", message: "История не помещается.", code: "does_not_fit", recovery: ["larger_model", "new_session_handoff"] });
    const other = port({ command: [receipt("accepted")], receipt: [receipt("failed", "x")] });
    expect(await requestModelTransition(other.p, { ...input, progress: () => ({ ...progress, operation: "another" }) })).toEqual({ kind: "failed", message: "x" });
    expect(recoveryText(["retry"])).toMatch(/повторите/);
  });

  it("Stop in the runtime is cancelled, not failed", async () => {
    const { p } = port({ command: [receipt("accepted")], receipt: [receipt("cancelled", "Подготовка отменена")] });
    expect(await requestModelTransition(p, input)).toEqual({ kind: "cancelled", message: "Подготовка отменена" });
  });

  it("a lost acknowledgement looks the receipt up under the same id and never submits twice", async () => {
    const { p, commands, lookups } = port({ command: [new ConnectionError()], receipt: [receipt("dispatching"), receipt("completed")] });
    expect(await requestModelTransition(p, input)).toEqual({ kind: "applied" });
    expect(commands).toHaveLength(1);
    expect(lookups).toEqual(["mt-1", "mt-1"]);
  });

  it("only a positive 404 from the ledger allows resubmitting, and with the SAME id", async () => {
    const { p, commands } = port({ command: [new ConnectionError(), receipt("completed")], receipt: [new ApiError(404, "нет")] });
    expect(await requestModelTransition(p, input)).toEqual({ kind: "applied" });
    expect(commands.map(c => c.id)).toEqual(["mt-1", "mt-1"]);
    const lost = port({ command: [new ConnectionError()], receipt: [new ConnectionError()] });
    expect((await requestModelTransition(lost.p, input)).kind).toBe("unknown"); // never assumed unsent
  });

  it("an uncertain receipt is unknown and closing the dialog only stops waiting", async () => {
    const uncertain = port({ command: [receipt("accepted")], receipt: [receipt("uncertain")] });
    expect((await requestModelTransition(uncertain.p, input)).kind).toBe("unknown");
    const abort = new AbortController();
    const waiting = port({ command: [receipt("accepted")], receipt: [] });
    const pending = requestModelTransition(waiting.p, { ...input, pollMs: 50, signal: abort.signal });
    abort.abort();
    expect(await pending).toEqual({ kind: "detached" });
    expect(waiting.commands.map(c => c.kind)).toEqual(["model.transition"]); // no abort command was sent
  });
});

describe("session.context_transition projection", () => {
  it("parses strictly and routes to the store, away from the chat reducer", () => {
    const event = { type: "session.context_transition", properties: { sessionID: "s1", operation: "mt-1", phase: "summarizing", source: { providerID: "big", modelID: "b" }, target: model, recovery: ["retry", "bogus"] } };
    const parsed = parseTransitionProgress(event.properties)!;
    expect(parsed).toMatchObject({ phase: "summarizing", operation: "mt-1", recovery: ["retry"] });
    expect(transitionText(parsed)).toMatch(/Сжимаем историю текущей моделью/);
    expect(parseTransitionProgress({ sessionID: "s1", phase: "nope", target: model })).toBeNull();
    const contextTransition = vi.fn();
    const host = { queue: vi.fn(), replaceQueues: vi.fn(), dialog: vi.fn(), schedule: vi.fn(), notice: vi.fn(), broker: vi.fn(), contextTransition } as unknown as RuntimeSyncHost;
    expect(routeRuntimeEvent(event, host, new AgentDialogs())).toBe(true);
    expect(contextTransition).toHaveBeenCalledWith(parsed);
  });
});
