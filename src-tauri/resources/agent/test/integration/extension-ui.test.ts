// Extension UI bridge: confirm/select/input/editor become runtime dialogs any
// attached client can answer; notify becomes a durable event; status, widgets
// and footer are real plugin-UI surfaces held by the worker's component host.
import { afterEach, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { InteractionBroker } from "../../src/interaction/broker.ts";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import type { EventEnvelope } from "../../src/protocol.ts";
import { extension, harness, newSession, promptCommand, stream, tempDir, type Harness } from "../helpers.ts";
import path from "node:path";

let h: Harness | undefined;
// Clear the reference first: a later test must never inherit a failed harness.
afterEach(async () => { const current = h; h = undefined; await current?.stop(); });

it("routes dialogs to clients, delivers answers back to the extension and hosts status, widget and footer surfaces", async () => {
  const answers: unknown[] = [];
  const footerStatuses: Array<string | undefined> = [];
  h = await harness({ extraExtensions: () => [extension("asks", (pi) => pi.registerTool({
    name: "ask_user", label: "Ask", description: "Asks the user", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      answers.push(await ctx.ui.confirm("Deploy?", "Production"));
      answers.push(await ctx.ui.select("Region", ["eu", "us"]));
      answers.push(await ctx.ui.input("Tag", "v1"));
      ctx.ui.notify("halfway", "warning");
      ctx.ui.setStatus("phase", "asking");
      ctx.ui.setWidget("plan", ["step 1", "step 2"]);
      ctx.ui.setFooter((_tui, _theme, data) => {
        footerStatuses.push(data.getExtensionStatuses().get("phase"));
        return { render: () => ["custom footer"], invalidate: () => undefined };
      });
      return { content: [{ type: "text", text: JSON.stringify(answers) }], details: {} };
    },
  }))] });
  const dir = h.project("ui");
  const sid = await newSession(h, dir, { permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  const client = stream(h, `directory=${encodeURIComponent(dir)}`);
  await client.hello;
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", {})], { stopReason: "toolUse" }), fauxAssistantMessage("thanks")]);
  await h.command(promptCommand(h, "ui-1", sid, dir, "ask me"));
  const reply = async (method: string, answer: Record<string, unknown>) => {
    if (!h) throw new Error("harness released");
    const asked = await client.waitFor((e) => e.event.type === "dialog.asked" && (e.event.properties.dialog as { method: string }).method === method);
    const dialog = asked.event.properties.dialog as { id: string; sessionID: string; directory: string };
    expect(dialog).toMatchObject({ sessionID: sid, directory: dir });
    expect((await h.request("POST", `/dialogs/${dialog.id}/reply`, answer)).status).toBe(204);
  };
  await reply("confirm", { confirmed: true });
  await reply("select", { value: "us" });
  await reply("input", { value: "release-7" });
  await h.waitReceipt("ui-1", ["completed"]);
  expect(answers).toEqual([true, "us", "release-7"]);
  // The durable notify is committed before the receipt; socket delivery may lag
  // HTTP polling, so await the specific event instead of reading the array.
  const isNotify = (e: EventEnvelope) => e.event.type === "extension.notify" && e.event.properties.message === "halfway";
  const notify = await client.waitFor(isNotify);
  expect(notify.event.properties).toMatchObject({ sessionID: sid, level: "warning" });
  expect(client.events.filter(isNotify)).toHaveLength(1);
  // Replay from just before it delivers the same durable event exactly once.
  const replay = stream(h, `directory=${encodeURIComponent(dir)}&after=${notify.seq - 1}`);
  await replay.hello;
  expect((await replay.waitFor((e) => e.seq === notify.seq)).event).toEqual(notify.event);
  expect(replay.events.filter(isNotify)).toHaveLength(1);
  // Status, widget and footer are supported plugin-UI surfaces of this worker.
  const worker = h.runtime.registry.live(sid);
  expect(worker).toBeTruthy();
  const surface = worker!.ui().state.current();
  expect(surface.statuses).toEqual({ phase: "asking" });
  expect(surface.widgets).toEqual([{ key: "plan", kind: "text", placement: "aboveEditor", lines: ["step 1", "step 2"] }]);
  // The footer factory ran once against live footer data that sees the status.
  expect(footerStatuses).toEqual(["asking"]);
  expect(client.events.some((e) => e.event.type === "extension.unsupported")).toBe(false);
  const diagnostics = await h.request<{ sessions: Array<{ sessionID: string; errors: unknown[]; unsupported: string[] }> }>("GET", `/extensions?directory=${encodeURIComponent(dir)}`);
  const own = diagnostics.body.sessions.find((s) => s.sessionID === sid);
  expect(own).toBeTruthy();
  expect(own!.unsupported).not.toContain("setFooter");
  expect(own!.errors).toEqual([]);
  client.close(); replay.close();
});

it("an unanswered dialog is denied at its deadline; silence is never approval", async () => {
  const data = tempDir("dialog-deadline");
  const db = new Database(path.join(data, "runtime.sqlite"));
  try {
    const broker = new InteractionBroker(db, new EventJournal(db), 50);
    expect(await broker.askDialog("s", "/p", { method: "confirm", title: "Allow?" })).toEqual({ cancelled: true });
    const reply = await broker.askPermission({ sessionID: "s", directory: "/p", permission: "bash", pattern: "rm -rf /", tool: "bash", callID: "c", title: "t", summary: "s" });
    expect(reply).toBe("reject");
  } finally {
    db.close();
  }
});
