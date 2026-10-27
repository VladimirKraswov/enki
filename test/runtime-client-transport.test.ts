// RuntimeClient transport/security matrix ported from the retired OpenCode
// client suite (test/client.test.ts). Wire constants of the old server are not
// carried over; the invariants are: loopback-only origins checked before any
// fetch, ApiError vs ConnectionError, caller abort reason, malformed JSON is an
// API fault, required JSON vs legitimate 204, filesystem-denied flag and error
// redaction, exact directory/ID/cursor scoping, and no blind replay of
// mutations whose outcome is ambiguous.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeConnection } from "../src/agent/runtime/client";
import { ApiError, ConnectionError } from "../src/api/http";

const connection: RuntimeConnection = { endpoint: "http://127.0.0.1:43123", token: "t".repeat(43), instance: "i", version: "test", contract: 1 };
type Call = { url: string; init: RequestInit };
let calls: Call[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function serve(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const client = (refresh: () => Promise<RuntimeConnection> = async () => connection, timeoutMs?: number) => new RuntimeClient(connection, refresh, timeoutMs);
const path = (call: Call) => call.url.replace(connection.endpoint, "");

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("origin validation happens before any network access", () => {
  it("refuses every non-loopback or non-origin endpoint at construction", () => {
    const fetcher = serve(() => json(200, {}));
    for (const endpoint of [
      "https://127.0.0.1:43123", "http://10.0.0.5:43123", "http://example.com", "http://user:pw@127.0.0.1:43123",
      "http://127.0.0.1:43123/v1", "http://127.0.0.1:43123?x=1", "http://127.0.0.1:0", "file:///tmp/sock", "not a url",
    ])
      expect(() => new RuntimeClient({ ...connection, endpoint }, async () => connection), endpoint).toThrow(ConnectionError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a refreshed connection that points off-loopback is refused and never contacted", async () => {
    const fetcher = serve(() => new Response(null, { status: 401 }));
    const c = client(async () => ({ ...connection, endpoint: "http://192.168.1.2:43123", token: "rotated" }));
    await expect(c.health()).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(calls.every(call => call.url.startsWith(connection.endpoint))).toBe(true);
    expect(c.endpoint).toBe(connection.endpoint);
  });
});

describe("error classification", () => {
  it("an HTTP error is an ApiError carrying only the runtime's message", async () => {
    serve(() => json(400, { message: "model not found", secret: "DO_NOT_DISPLAY", stack: "at x" }));
    const error = await client().checkModel("p", "m").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ status: 400, detail: "model not found", filesystemDenied: false });
    expect(String((error as ApiError).message) + (error as ApiError).detail).not.toContain("DO_NOT_DISPLAY");
  });

  it("long error messages are bounded", async () => {
    serve(() => json(500, { message: "x".repeat(5000) }));
    const error = await client().projects().catch((e: unknown) => e) as ApiError;
    expect(error.detail.length).toBeLessThanOrEqual(400);
  });

  it("a filesystem denial is flagged so the UI can explain access instead of a generic failure", async () => {
    serve(() => json(403, { message: "EACCES: permission denied, scandir '/Users/me/Private'" }));
    await expect(client().fileList("/Users/me", "Private")).rejects.toMatchObject({ status: 403, filesystemDenied: true });
  });

  it("an unreachable runtime is a ConnectionError, never an ApiError", async () => {
    serve(() => { throw new TypeError("fetch failed"); });
    const error = await client().health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("a malformed 200 body is an API fault, not an unreachable server", async () => {
    serve(() => new Response("<html>proxy error</html>", { status: 200, headers: { "Content-Type": "application/json" } }));
    const error = await client().projects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect((error as ApiError).message).toContain("GET /projects");
  });

  it("a legitimate empty mutation reply (204) resolves without a body", async () => {
    serve(() => new Response(null, { status: 204 }));
    await expect(client().deleteSession("s1", "/p")).resolves.toBeUndefined();
    await expect(client().replyPermission("per_1", "once")).resolves.toBeUndefined();
  });

  // RequestOptions.empty is enforced: only declared-empty endpoints resolve
  // `undefined`; a JSON-required read never silently yields nothing.
  it("a JSON-required endpoint answering 204 or an empty body is an ApiError", async () => {
    serve(() => new Response(null, { status: 204 }));
    await expect(client().health()).rejects.toBeInstanceOf(ApiError);
    await expect(client().snapshot("/p")).rejects.toBeInstanceOf(ApiError);
  });

  it("endpoints whose runtime handler returns nothing keep accepting 204, while JSON plugin-UI routes do not", async () => {
    serve(() => new Response(null, { status: 204 }));
    await expect(client().deleteSession("s", "/p")).resolves.toBeUndefined();
    await expect(client().replyPermission("perm", "once")).resolves.toBeUndefined();
    await expect(client().removeSchedule("t")).resolves.toBeUndefined();
    await expect(client().uiRelease("s", "/p")).resolves.toBeUndefined();
    await expect(client().uiResolveDraft("s", "/p", { kind: "discard" } as never)).resolves.toBeUndefined();
    await expect(client().uiSnapshot("s", "/p")).rejects.toBeInstanceOf(ApiError);
    await expect(client().uiControl("s", "/p")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("cancellation", () => {
  it("an already-aborted caller signal rejects with its own reason and never fetches", async () => {
    const fetcher = serve(() => json(200, {}));
    const ctrl = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    ctrl.abort(reason);
    await expect(client().health(ctrl.signal)).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborting mid-flight rejects with the caller's reason, not a connection failure", async () => {
    serve((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })));
    const ctrl = new AbortController();
    const pending = client().projects(ctrl.signal).catch((e: unknown) => e);
    const reason = new DOMException("navigated away", "AbortError");
    ctrl.abort(reason);
    const error = await pending;
    expect(error).toBe(reason);
    expect(error).not.toBeInstanceOf(ConnectionError);
  });

  it("a client timeout is a ConnectionError and the request is sent exactly once", async () => {
    vi.useFakeTimers();
    const fetcher = serve((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })));
    // /commands carries its own 120 s deadline; the constructor default does not shorten it.
    const pending = client(async () => connection, 1000).command({ id: "cmd_1", kind: "prompt" } as never).catch((e: unknown) => e);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toBeInstanceOf(ConnectionError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a read times out at the client default and is a ConnectionError naming the request", async () => {
    vi.useFakeTimers();
    serve((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })));
    const pending = client(async () => connection, 1000).projects().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const error = await pending;
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain("GET /projects");
  });
});

describe("exact scoping of directories, identifiers and cursors", () => {
  it("encodes IDs as one path segment and keeps the directory in the query", async () => {
    serve(() => json(200, { messages: [], before: null }));
    const c = client();
    await c.messages("ses/../other", { directory: "/work/a b", limit: 50, before: "opaque cursor/1" });
    await c.getSession("ses?x=1#y", "/work/a");
    await c.editQueued("s1", "/w", "q/../2", { text: "t" });
    expect(path(calls[0])).toBe("/v1/sessions/ses%2F..%2Fother/messages?directory=%2Fwork%2Fa+b&limit=50&before=opaque+cursor%2F1");
    expect(path(calls[1])).toBe("/v1/sessions/ses%3Fx%3D1%23y?directory=%2Fwork%2Fa");
    expect(path(calls[2])).toBe("/v1/sessions/s1/queue/q%2F..%2F2?directory=%2Fw");
  });

  it("returns the runtime's opaque history cursor verbatim instead of inventing one", async () => {
    serve(() => json(200, { messages: [{ info: { id: "m1" }, parts: [] }], before: "server-cursor-7" }));
    const page = await client().messages("s1", { directory: "/p", limit: 1 });
    expect(page.before).toBe("server-cursor-7");
  });

  it("omits absent scope instead of sending empty or 'null' values", async () => {
    serve(() => json(200, { sessions: [], cursor: null }));
    const c = client();
    await c.recentSessions({ archived: false, cursor: 789, limit: 20 });
    await c.recentSessions({ archived: true, directory: "/p" });
    await c.permissions(null);
    expect(Object.fromEntries(new URL(calls[0].url).searchParams)).toEqual({ cursor: "789", limit: "20" });
    expect(Object.fromEntries(new URL(calls[1].url).searchParams)).toEqual({ archived: "true", directory: "/p" });
    expect(new URL(calls[2].url).search).toBe("");
  });

  it("never puts the bearer in a URL, including stream URLs", () => {
    const c = client();
    for (const url of [c.uiStreamUrl("s1", "/p", "open"), c.ptyStreamUrl("pty1", "/p", 3), c.url("/events", { directory: "/p" })])
      expect(url).not.toContain(connection.token);
  });
});

describe("RuntimeBackend normalizes runtime DTOs on the way out", () => {
  it("health keeps only the identity fields the store uses; sessions keep origin, workshop and model", async () => {
    const { RuntimeBackend } = await import("../src/agent/runtime/backend");
    serve(url => path({ url, init: {} }).startsWith("/v1/health")
      ? json(200, { healthy: true, version: "2.0.0", contract: 1, schema: 2, sdk: "0.85.1", node: "24", platform: "darwin", arch: "arm64", instance: "i-1", startedAt: 1, host: "local", draining: false, token: "never-copied" })
      : json(200, [{ id: "s1", directory: "/p", title: "", projectID: "p", time: { created: 1, updated: 2 }, origin: { kind: "opencode", archive: "a" }, workshop: true,
        model: { id: "m", providerID: "p", variant: "high" }, parentID: "root" }]));
    const backend = new RuntimeBackend(connection, async () => connection, "enki-runtime:local");
    expect(await backend.health()).toEqual({ healthy: true, version: "2.0.0", contract: 1, instance: "i-1", sdk: "0.85.1", host: "local" });
    const [s] = await backend.listSessions("/p");
    expect(s).toMatchObject({ id: "s1", directory: "/p", title: "", parentID: "root", workshop: true, origin: { kind: "opencode" }, model: { id: "m", providerID: "p", variant: "high" } });
    expect(await backend.listSessions(null)).toEqual([]);
    expect(calls.map(c => path(c).split("?")[0])).toEqual(["/v1/health", "/v1/sessions"]);
  });

  it("a refused durable command is a definite ApiError (409), never reported as sent", async () => {
    const { RuntimeBackend } = await import("../src/agent/runtime/backend");
    serve(() => json(200, { id: "msg_1", kind: "prompt", sessionID: "s1", state: "rejected", error: "Чат архивирован", createdAt: 1, updatedAt: 1 }));
    const backend = new RuntimeBackend(connection, async () => connection, "enki-runtime:local");
    await expect(backend.prompt("s1", "/p", { messageID: "msg_1", model: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "x" }] } as never))
      .rejects.toMatchObject({ status: 409, detail: "Чат архивирован" });
    await expect(backend.prompt("s1", "/p", { model: { providerID: "p", modelID: "m" }, parts: [] } as never)).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("a lost command acknowledgement is retried once under the same id, so the ledger answers instead of a second turn", async () => {
    const { RuntimeBackend } = await import("../src/agent/runtime/backend");
    let n = 0;
    serve(() => { if (++n === 1) throw new TypeError("connection reset"); return json(200, { id: "msg_2", kind: "prompt", sessionID: "s1", state: "running", createdAt: 1, updatedAt: 1, duplicate: true }); });
    const backend = new RuntimeBackend(connection, async () => connection, "enki-runtime:local");
    await backend.prompt("s1", "/p", { messageID: "msg_2", model: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "x" }] } as never);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.body).toBe(calls[1].init.body);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ id: "msg_2", kind: "prompt", sessionID: "s1", directory: "/p" });
  });
});

describe("no blind replay of ambiguous mutations", () => {
  it("a network failure after sending a mutation is reported once, never re-sent", async () => {
    const fetcher = serve(() => { throw new TypeError("connection reset"); });
    const c = client();
    await expect(c.enqueue("s1", "/p", { id: "q1", text: "x", parts: [], model: { providerID: "p", modelID: "m" } })).rejects.toBeInstanceOf(ConnectionError);
    await expect(c.stop("s1", "/p")).rejects.toBeInstanceOf(ConnectionError);
    await expect(c.replyPermission("per_1", "always")).rejects.toBeInstanceOf(ConnectionError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("a server error on a mutation is not retried", async () => {
    const fetcher = serve(() => json(500, { message: "boom" }));
    await expect(client().steerQueued("s1", "/p", "q1")).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a 401 refreshes once and repeats the identical request; a second 401 is final", async () => {
    let n = 0;
    const fetcher = serve(() => (++n === 1 ? new Response(null, { status: 401 }) : json(200, { id: "cmd_1", state: "accepted" })));
    const refresh = vi.fn(async () => ({ ...connection, token: "r".repeat(43) }));
    const c = client(refresh);
    await c.command({ id: "cmd_1", kind: "prompt" } as never);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(calls[1].init.body).toBe(calls[0].init.body);
    expect(new Headers(calls[1].init.headers).get("Authorization")).toBe(`Bearer ${"r".repeat(43)}`);
    calls = []; n = 0;
    serve(() => new Response(null, { status: 401 }));
    await expect(c.command({ id: "cmd_2", kind: "prompt" } as never)).rejects.toMatchObject({
      status: 401, message: "Не удалось обновить доступ к среде выполнения Enki. Подключитесь снова; история и задания сохранены.",
    });
    expect(calls).toHaveLength(2);
  });

  it("recovers the model catalogue and chat status together with one native refresh", async () => {
    const fresh = { ...connection, token: "n".repeat(43) };
    let release!: (value: RuntimeConnection) => void;
    const refresh = vi.fn(() => new Promise<RuntimeConnection>(resolve => { release = resolve; }));
    serve((_url, init) => new Headers(init.headers).get("Authorization") === `Bearer ${fresh.token}`
      ? json(200, { recovered: true }) : json(401, { message: "Unauthorized" }));
    const c = client(refresh);
    const models = c.request("GET", "/providers");
    const status = c.request("GET", "/sessions/s1/status");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    release(fresh);
    await expect(Promise.all([models, status])).resolves.toEqual([{ recovered: true }, { recovered: true }]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(4);
  });
});
