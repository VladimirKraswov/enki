// The projection must stay alive and explainable when the page does not
// answer: bounded title reads, cached tab titles, a stale last frame instead of
// a blank panel, and an explicit blocked state for dialogs/crashes.
import { afterEach, expect, it, vi } from "vitest";
import { createView } from "../src-tauri/resources/browser/view.mjs";
import { createToolQueue } from "../src-tauri/resources/browser/actions.mjs";

const listeners = () => {
  const map = new Map<string, ((value: any) => void)[]>();
  return {
    on(name: string, handler: (value: any) => void) { map.set(name, [...(map.get(name) || []), handler]); },
    emit(name: string, value?: any) { for (const handler of map.get(name) || []) handler(value); },
  };
};
function page(options: { title?: () => Promise<string>; screenshot?: () => Promise<Buffer>; url?: string } = {}) {
  const events = listeners();
  return {
    isClosed: () => false,
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: async () => {},
    url: () => options.url ?? "https://example.test/",
    title: vi.fn(options.title ?? (async () => "Example")),
    screenshot: vi.fn(options.screenshot ?? (async () => Buffer.from("frame"))),
    mainFrame: () => null,
    on: events.on,
    emit: events.emit,
  };
}
const contextOf = (...pages: any[]) => ({ pages: () => pages, on: () => {}, newPage: async () => pages[0] });
const view = (context: any) => createView(async () => context);

afterEach(() => { vi.restoreAllMocks(); });

it("does not re-read an unchanged tab title on every frame", async () => {
  const tab = page();
  const browser = view(contextOf(tab));
  await browser.frame(contextOf(tab));
  await browser.frame(contextOf(tab));
  await browser.frame(contextOf(tab));
  expect(tab.title).toHaveBeenCalledTimes(1);
});

it("never lets an unresponsive renderer stall the frame for its title", async () => {
  const tab = page({ title: () => new Promise<string>(() => {}) });
  const browser = view(contextOf(tab));
  const started = Date.now();
  const frame = await browser.frame(contextOf(tab));
  expect(Date.now() - started).toBeLessThan(1200);
  expect(frame.title).toBe("");
  expect(frame.tabs[0].title).toBe("");
});

it("keeps the last painted frame and reports it as stale instead of failing", async () => {
  let fail = false;
  const tab = page({ screenshot: async () => { if (fail) throw new Error("Target closed"); return Buffer.from("frame"); } });
  const browser = view(contextOf(tab));
  const fresh = await browser.frame(contextOf(tab));
  expect(fresh.stale).toBeUndefined();
  fail = true;
  const stale = await browser.frame(contextOf(tab));
  expect(stale.stale).toBe(true);
  expect(stale.staleReason).toBe("capture");
  // The binding to the displayed pixels must not move: input still fails closed.
  expect(stale.pageId).toBe(fresh.pageId);
  expect(stale.revision).toBe(fresh.revision);
  expect(stale.image).toBe(fresh.image);
});

it("reports a blocking dialog and clears it once the dialog is handled", async () => {
  const tab = page();
  const browser = view(contextOf(tab));
  await browser.frame(contextOf(tab));
  tab.emit("dialog", { type: () => "beforeunload" });
  const blocked = await browser.frame(contextOf(tab));
  expect(blocked.blocked).toMatchObject({ kind: "dialog", type: "beforeunload" });
  await browser.after({} as any, { name: "browser_handle_dialog", arguments: { accept: false } }, { content: [] });
  const cleared = await browser.frame(contextOf(tab));
  expect(cleared.blocked).toBeNull();
});

it("reports a crashed renderer instead of pretending the page works", async () => {
  const tab = page();
  const browser = view(contextOf(tab));
  await browser.frame(contextOf(tab));
  tab.emit("crash");
  const frame = await browser.frame(contextOf(tab));
  expect(frame.blocked).toMatchObject({ kind: "crash" });
});

it("exposes queue depth and the running head without changing serialization", async () => {
  const queue = createToolQueue();
  let release!: () => void;
  const first = queue(() => new Promise<void>(resolve => { release = resolve; }));
  const second = queue(() => Promise.resolve("second"));
  await Promise.resolve();
  expect(queue.stats().depth).toBe(2);
  expect(queue.stats().runningSince).toBeGreaterThan(0);
  release();
  await first;
  await expect(second).resolves.toBe("second");
  expect(queue.stats()).toEqual({ depth: 0, runningSince: 0 });
});

it("counts a cancelled queued call exactly once", async () => {
  const queue = createToolQueue();
  let release!: () => void;
  const head = queue(() => new Promise<void>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const queued = queue(() => Promise.resolve("never"), controller.signal);
  await Promise.resolve();
  expect(queue.stats().depth).toBe(2);
  controller.abort();
  await expect(queued).rejects.toThrow();
  release();
  await head;
  expect(queue.stats().depth).toBe(0);
});

it("keeps the daemon alive when the losing side of a frame deadline rejects", async () => {
  // The daemon treats an unhandled rejection as fatal, so a capture that fails
  // after its deadline must not escape as one.
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  let late = false;
  const tab = page({ screenshot: () => late
    ? new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error("late failure")), 2200))
    : Promise.resolve(Buffer.from("frame")) });
  const browser = view(contextOf(tab));
  expect((await browser.frame(contextOf(tab))).stale).toBeUndefined();
  process.on("unhandledRejection", record);
  try {
    late = true;
    const started = Date.now();
    const frame = await browser.frame(contextOf(tab));
    expect(frame.stale).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(unhandled).toHaveLength(0);
  } finally { process.off("unhandledRejection", record); }
});

it("treats a lost browser connection as stale instead of a frozen picture", async () => {
  const tab = page();
  let connected = true;
  const context: any = { pages: () => [tab], on: () => {}, newPage: async () => tab, browser: () => ({ isConnected: () => connected }) };
  const browser = view(context);
  expect((await browser.frame(context)).image).toBeTruthy();
  connected = false;
  const stale = await browser.frame(context);
  expect(stale.stale).toBe(true);
  expect(stale.image).toBeTruthy();
});

it("stops the screencast of a page nobody watches without crashing the service", async () => {
  const sent: string[] = [];
  const handlers = new Map<string, ((value: any) => void)[]>();
  const session = {
    on: (name: string, handler: (value: any) => void) => { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    send: async (command: string) => { sent.push(command); },
    detach: async () => { sent.push("detach"); },
  };
  const tab: any = page();
  tab.context = () => ({ newCDPSession: async () => session });
  const context: any = { pages: () => [tab], on: () => {}, newPage: async () => tab, browser: () => ({ isConnected: () => true }) };
  const browser = view(context);
  await browser.frame(context);
  expect(sent).toContain("Page.startScreencast");
  const errors: unknown[] = [];
  const record = (error: unknown) => errors.push(error);
  process.on("uncaughtException", record);
  try {
    await new Promise(resolve => setTimeout(resolve, 6600));
    expect(errors).toHaveLength(0);
    expect(sent).toContain("Page.stopScreencast");
  } finally { process.off("uncaughtException", record); }
}, 12000);
