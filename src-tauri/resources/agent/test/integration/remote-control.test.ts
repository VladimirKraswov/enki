import { expect, it } from "vitest";
import type { Broker } from "../../src/control/broker.ts";
import { harness } from "../helpers.ts";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";

function remoteBroker() {
  const queue: Array<Record<string, unknown>> = [];
  const completed: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const updateActions: string[] = [];
  let watch: string | null = null;
  const broker: Broker = {
    kind: "supervisor", available: () => true,
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (method === "hub.identity") return { scope: "test-hub" } as T;
      if (method === "updates.control") { updateActions.push(String(params.action)); return { nativeVersion: "test", action: params.action } as T; }
      if (method !== "hub.request") throw new Error(`unexpected ${method}`);
      if (params.path === "model-services/catalog") return { schema: 1, routes: [] } as T;
      const body = params.body as Record<string, unknown>;
      if (params.path === "remote/sync") {
        snapshots.push(body);
        const commands = queue.splice(0);
        return { commands, watch } as T;
      }
      if (params.path === "remote/complete") { completed.push(body); return {} as T; }
      throw new Error(`unexpected ${params.path}`);
    },
  };
  return { broker, queue, completed, snapshots, updateActions, watch: (id: string) => { watch = id; } };
}
const wait = async (condition: () => boolean, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (!condition()) { if (Date.now() > until) throw new Error("remote operation not observed"); await new Promise(r => setTimeout(r, 40)); }
};

it("LAN relay creates a session and runs its first prompt through the real Runtime", async () => {
  const remote = remoteBroker(), h = await harness({ broker: remote.broker, remoteControl: true });
  try {
    h.scripted.setResponses([fauxAssistantMessage("Hello from remote")]);
    const directory = h.project("remote-create");
    remote.queue.push({ id: "remote-create-1", session: null, kind: "session.create",
      payload: { directory, model: h.model(), prompt: "Say hello from remote" } });
    await wait(() => remote.completed.some(c => c.id === "remote-create-1"));
    const completed = remote.completed.find(c => c.id === "remote-create-1");
    expect(completed?.ok).toBe(true);
    const result = completed?.result as { session: { id: string }; receipt: { id: string } };
    const sessionID = result.session.id;
    const receipt = await h.waitReceipt("remote-create-1:prompt", ["completed", "failed", "rejected"]);
    expect(receipt.state).toBe("completed");
    const history = h.runtime.registry.historyPage(h.runtime.catalog.get(sessionID)!, 20).messages;
    expect(history.some(m => m.info.role === "user" && m.parts.some(p => p.text === "Say hello from remote"))).toBe(true);
    expect(history.some(m => m.info.role === "assistant" && m.parts.some(p => p.text?.includes("Hello")))).toBe(true);
    await wait(() => remote.snapshots.some(s => ((s.overview as { sessions: Array<{ id: string }> }).sessions.some(x => x.id === sessionID))));
    const snapshot = remote.snapshots.at(-1)?.overview as { sessions: Array<{ id: string }> };
    expect(snapshot.sessions.some(s => s.id === sessionID)).toBe(true);
  } finally { await h.stop(); }
});

it("LAN relay watches history and sends prompts, model changes and settings without another executor", async () => {
  const remote = remoteBroker(), h = await harness({ broker: remote.broker, remoteControl: true });
  try {
    h.scripted.setResponses([fauxAssistantMessage("Remote answer")]);
    const directory = h.project("remote-existing");
    const created = await h.request<{ id: string }>("POST", "/sessions", { directory, model: h.model() });
    const sessionID = created.body.id; remote.watch(sessionID);
    remote.queue.push({ id: "remote-prompt-1", session: sessionID, kind: "prompt", payload: { text: "Remote prompt", model: h.model() } });
    const receipt = await h.waitReceipt("remote-prompt-1", ["completed", "failed", "rejected"]);
    expect(receipt.state).toBe("completed");
    await wait(() => remote.snapshots.some(s => (s.detail as { messages?: unknown[] } | undefined)?.messages?.length));
    const detail = remote.snapshots.map(s => s.detail).filter(Boolean).at(-1) as { messages: Array<{ info: { role: string } }> };
    expect(detail.messages.some(m => m.info.role === "assistant")).toBe(true);
    remote.queue.push({ id: "remote-model-1", session: sessionID, kind: "model.set", payload: { model: h.model("medium") } });
    await h.waitReceipt("remote-model-1", ["completed"]);
    expect(h.runtime.catalog.get(sessionID)?.model?.modelID).toBe(h.model("medium").modelID);
    remote.queue.push({ id: "remote-settings-1", session: null, kind: "settings.update", payload: { patch: { browserEnabled: true, defaultPolicy: "read" } } });
    await wait(() => remote.completed.some(c => c.id === "remote-settings-1"));
    expect(h.runtime.settings().browserEnabled).toBe(true);
    expect(h.runtime.settings().defaultPolicy).toBe("read");
    remote.queue.push({ id: "remote-invalid-1", session: sessionID, kind: "prompt", payload: { text: "", model: h.model() } });
    await wait(() => remote.completed.some(c => c.id === "remote-invalid-1"));
    expect(remote.completed.find(c => c.id === "remote-invalid-1")?.ok).toBe(false);
    for (const action of ["check", "prepare", "apply"]) {
      const id = `remote-update-${action}`;
      remote.queue.push({ id, session: null, kind: `update.${action}`, payload: {} });
      await wait(() => remote.completed.some(c => c.id === id));
      expect(remote.completed.find(c => c.id === id)?.ok).toBe(true);
    }
    expect(remote.updateActions).toEqual(expect.arrayContaining(["status", "check", "prepare", "apply"]));
  } finally { await h.stop(); }
});
