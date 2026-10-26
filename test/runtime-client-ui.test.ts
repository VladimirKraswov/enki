// RuntimeClient: a stable per-window X-Enki-Client id on every request and on
// fetch-based SSE (via authorization()), never the bearer in a URL; typed UI
// routes; explicit draft conflicts; real question replies.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeClient, windowClientId } from "../src/agent/runtime/client";
import { runRuntimeStream } from "../src/agent/runtime/events";

const connection = { endpoint: "http://127.0.0.1:43123", token: "t".repeat(43), instance: "i", version: "test", contract: 1 };
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Call = { url: string; init: RequestInit };
let calls: Call[];
const respond = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });
const headersOf = (call: Call) => new Headers(call.init.headers);

it("every request carries the bearer and the same UUIDv4 window client id; no token in URLs", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(200, { healthy: true }); }));
  const a = new RuntimeClient(connection, async () => connection), b = new RuntimeClient(connection, async () => connection);
  await a.health(); await b.uiSnapshot("s1", "/p");
  expect(windowClientId()).toMatch(UUID_V4);
  for (const call of calls) {
    expect(headersOf(call).get("Authorization")).toBe(`Bearer ${connection.token}`);
    expect(headersOf(call).get("X-Enki-Client")).toBe(windowClientId());
    expect(call.url).not.toContain(connection.token);
  }
  expect(calls[1].url).toBe("http://127.0.0.1:43123/v1/sessions/s1/ui?directory=%2Fp");
  expect(a.authorization()).toEqual({ Authorization: `Bearer ${connection.token}`, "X-Enki-Client": windowClientId() });
});

it("the event stream (fetch SSE) sends the same client id", async () => {
  const abort = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init }); abort.abort();
    return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
  }));
  const client = new RuntimeClient(connection, async () => connection);
  await runRuntimeStream({ client, scope: { all: true }, signal: abort.signal, onEnvelope: () => {}, onState: () => {}, onReset: () => {} });
  expect(headersOf(calls[0]).get("X-Enki-Client")).toBe(windowClientId());
  expect(client.uiStreamUrl("s 1", "/p", "events")).toBe("http://127.0.0.1:43123/v1/sessions/s%201/ui/events?directory=%2Fp");
});

it("a draft conflict returns the canonical draft explicitly; a lost ACK surfaces as an error to retry the same id", async () => {
  const canonical = { revision: 4, text: "plugin", selection: { start: 6, end: 6 }, updatedAt: 1 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/ui/draft")) return respond(409, { code: "draft-conflict", message: "Черновик уже изменился", draft: canonical });
    return respond(200, { scope: {}, draft: canonical, state: { widgets: [], statuses: {} }, attachment: {}, nativeScope: null, pendingDraft: null, pendingSubmission: null });
  }));
  const client = new RuntimeClient(connection, async () => connection);
  const result = await client.uiDraft("s1", "/p", { id: "m-1", baseRevision: 3, text: "mine" });
  expect(result).toEqual({ ok: false, message: "Черновик уже изменился", canonical });
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ id: "m-1", baseRevision: 3, text: "mine" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
  await expect(client.uiDraft("s1", "/p", { id: "m-1", baseRevision: 3, text: "mine" })).rejects.toThrow();
});

it("questions are real runtime endpoints scoped to the folder", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return url.includes("/questions?") ? respond(200, [{ id: "que_1", sessionID: "s1", questions: [] }]) : respond(204); }));
  const client = new RuntimeClient(connection, async () => connection);
  expect(await client.questions("/p")).toHaveLength(1);
  await client.replyQuestion("que_1", [["eu"]], "/p");
  await client.rejectQuestion("que_2", "/p");
  expect(calls.map(c => [c.init.method, c.url.replace(connection.endpoint, "")])).toEqual([
    ["GET", "/v1/questions?directory=%2Fp"],
    ["POST", "/v1/questions/que_1/reply?directory=%2Fp"],
    ["POST", "/v1/questions/que_2/reject?directory=%2Fp"],
  ]);
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ answers: [["eu"]] });
});

it('question files require runtime capability before posting, and the exact prepared parts travel with the answer', async () => {
  let supported = false;
  vi.stubGlobal('fetch', vi.fn(async (url:string, init:RequestInit) => {
    calls.push({url,init}); return url.endsWith('/capabilities') ? respond(200, supported ? {questionAttachments:true} : {}) : respond(204);
  }));
  const client = new RuntimeClient(connection, async () => connection);
  const parts = [{type:'file' as const,mime:'text/plain',filename:'note.txt',url:'data:text/plain;base64,aGk='}];
  await expect(client.replyQuestion('q',[['Документ']],'/p',parts)).rejects.toThrow(/ещё не поддерживает/);
  expect(calls.some(c => c.init.method==='POST')).toBe(false);
  supported = true; await client.replyQuestion('q',[['Документ']],'/p',parts);
  expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({answers:[['Документ']],parts});
});
