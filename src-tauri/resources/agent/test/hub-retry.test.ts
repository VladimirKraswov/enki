// Bounded Hub retries inside the existing reservation, before dispatch: a
// transient failure may not masquerade as a permanent refusal, and a permanent
// one must still refuse with the last real error. Same command id throughout;
// the ledger stays "accepted" while attempts continue.
import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/execution/dispatcher.ts";
import type { CommandReceipt, CommandRequest } from "../src/protocol.ts";

const receipt = (request: CommandRequest, state: CommandReceipt["state"], error?: string): CommandReceipt =>
  ({ id: request.id, kind: request.kind, sessionID: request.sessionID, state, entryId: null, error: error ?? null as never, createdAt: 1, updatedAt: 2 });

function harness(hubBehavior: (attempt: number) => Promise<unknown>) {
  const receipts = new Map<string, CommandReceipt>();
  const calls = { resolve: 0, ensureRun: 0 };
  let resolveDone!: (r: CommandReceipt) => void;
  const settled = new Promise<CommandReceipt>((r) => { resolveDone = r; });
  const request: CommandRequest = {
    id: "cmd_1", kind: "prompt", sessionID: "s1", directory: "/d",
    payload: { parts: [{ type: "text", text: "x" }], model: { providerID: "hub-p", modelID: "m" } },
  } as CommandRequest;
  const ledger = {
    begin: (req: CommandRequest) => { const r = receipt(req, "accepted"); receipts.set(req.id, r); return { kind: "new" as const, receipt: r }; },
    update: (id: string, state: CommandReceipt["state"], extra?: { error?: string }) => {
      const r = { ...(receipts.get(id) ?? receipt(request, state)), state, error: extra?.error ?? null as never, updatedAt: 2 };
      receipts.set(id, r);
      return r;
    },
    get: (id: string) => receipts.get(id) ?? null,
  };
  const hub = {
    resolve: async () => { calls.resolve += 1; const outcome = await hubBehavior(calls.resolve); if (outcome instanceof Error) throw outcome; return outcome; },
    resolveMissing: async () => { throw new Error("unused"); },
    ensureRun: async () => { calls.ensureRun += 1; },
    release: async () => {},
    checkAlias: async () => {},
  };
  const worker = {
    currentModel: () => undefined,
    startPrompt: async (cmd: CommandRequest, readiness?: { target?: (m: unknown) => Promise<void> }) => {
      try { await readiness?.target?.({ providerID: "hub-p", modelID: "m" }); }
      catch (error) { return ledger.update(cmd.id, "rejected", { error: error instanceof Error ? error.message : String(error) })!; }
      ledger.update(cmd.id, "running");
      return ledger.get(cmd.id)!;
    },
  };
  const dispatcher = new Dispatcher(
    { worker: async () => worker, live: () => null } as never,
    { get: (id: string) => ({ id, directory: "/d", origin: { kind: "enki" } }) } as never,
    ledger as never,
    hub as never,
    { append: () => {} } as never,
    () => false,
    [1, 1],
  );
  dispatcher.onReceipt((r) => { if (r.state !== "accepted") resolveDone(r); });
  return { dispatcher, request, calls, settled };
}

describe("bounded Hub retries before dispatch", () => {
  it("a transient Hub failure is retried with the same command and then proceeds", async () => {
    const h = harness(async (attempt) => (attempt < 3 ? Error("нет связи с Hub") : { model: { providerID: "hub-p", modelID: "m" }, signature: "sig" }));
    expect(h.dispatcher.submit(h.request).status).toBe(202);
    const result = await h.settled;
    expect(h.calls.resolve).toBe(3);
    expect(h.calls.ensureRun).toBe(1);
    expect(result.state).toBe("running");
  });

  it("a Hub authority/scope change is not retried and refuses with its exact message", async () => {
    const h = harness(async () => Error("Подключение к Hub изменилось во время выбора модели. Выберите модель заново; запрос не отправлен."));
    h.dispatcher.submit(h.request);
    const result = await h.settled;
    expect(h.calls.resolve).toBe(1);
    expect(result.state).toBe("rejected");
    expect(result.error).toContain("Подключение к Hub изменилось");
  });

  it("a persistent failure refuses with the last error after the bounded attempts", async () => {
    const h = harness(async () => Error("Credential store read failed for local-qwen: Enki Runtime готовится к обновлению"));
    h.dispatcher.submit(h.request);
    const result = await h.settled;
    expect(h.calls.resolve).toBe(3);
    expect(result.state).toBe("rejected");
    expect(result.error).toContain("Credential store read failed");
  });
});
