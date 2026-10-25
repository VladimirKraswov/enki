// Shared typed fixture for frontend tests of the single Enki Runtime backend.
//
// The production RuntimeBackend and RuntimeClient are used unchanged; only the
// loopback wire is replaced by an in-memory route table. Reads default to empty
// DTOs of the real protocol; every mutation must be routed explicitly by the
// test, otherwise it fails as a visible ApiError and is listed in `unexpected`.
// Nothing here dispatches prompts, drains queues or approves permissions: those
// authorities belong to the runtime and are tested in src-tauri/resources/agent.
import { vi } from "vitest";
import type { DirectoryEvent, EventSubscription } from "../../src/agent/backend";
import { RuntimeBackend } from "../../src/agent/runtime/backend";
import type { RuntimeConnection, RuntimeSettingsDTO, SnapshotDTO } from "../../src/agent/runtime/client";
import { LOCAL_WORKSPACE } from "../../src/agent/runtime/ids";
import type { ServerEvent } from "../../src/api/types";
import type { HealthDTO, ProvidersDTO, QueueStateDTO } from "../../src-tauri/resources/agent/src/protocol";

export const FIXTURE_CONNECTION: RuntimeConnection = { endpoint: "http://127.0.0.1:43123", token: "f".repeat(43), instance: "fixture-instance", version: "test", contract: 1 };

export interface RuntimeCall { method: string; path: string; params: Record<string, string>; query: Record<string, string>; body: unknown;
  /** The request's own abort signal (client timeout or caller cancellation). */
  signal?: AbortSignal }
export type RouteHandler = (call: RuntimeCall) => unknown | Response | Promise<unknown | Response>;

/** Thrown by a handler to answer with an exact HTTP status and runtime message. */
export class RuntimeReply { constructor(readonly status: number, readonly body?: unknown) {} }

export const emptyQueue = (sessionID: string): QueueStateDTO => ({ sessionID, armed: true, pausedReason: null, items: [] });
export const emptySnapshot = (instance = FIXTURE_CONNECTION.instance): SnapshotDTO => ({
  seq: 0, instance, statuses: {}, permissions: [], questions: [], dialogs: [], queues: [], schedules: [],
  activity: { running: 0, queued: 0, pending: 0, idle: true },
});
const health: HealthDTO = { healthy: true, version: "test", contract: 1, schema: 2, sdk: "0.85.1", node: "24", platform: "test", arch: "test",
  instance: FIXTURE_CONNECTION.instance, startedAt: 1, host: "local", draining: false };
const providers: ProvidersDTO = { all: [], connected: [], default: {} };
const settings: RuntimeSettingsDTO = { defaultPolicy: "ask", extensionPaths: [], useUserPiResources: false, noDiscoveredExtensions: false,
  gitProgram: null, compaction: { enabled: true }, browserEnabled: false };

const READS: Array<[string, RouteHandler]> = [
  ["/health", () => health],
  ["/snapshot", () => emptySnapshot()],
  ["/runtime/idle", () => ({ running: 0, queued: 0, pending: 0, idle: true, draining: false })],
  ["/settings", () => settings],
  ["/projects", () => []],
  ["/paths", c => ({ home: "/home/fixture", directory: c.query.directory ?? "/home/fixture", worktree: c.query.directory ?? "/home/fixture", chats: "/home/fixture/.enki/chats" })],
  ["/vcs", () => null],
  ["/sessions", () => []],
  ["/sessions/recent", () => ({ sessions: [], cursor: null })],
  ["/sessions/status", () => ({})],
  ["/sessions/:id/messages", () => ({ messages: [], before: null })],
  ["/sessions/:id/children", () => []],
  ["/sessions/:id/queue", c => emptyQueue(c.params.id)],
  ["/permissions", () => []],
  ["/questions", () => []],
  ["/dialogs", () => []],
  ["/schedules", () => ({ tasks: [] })],
  ["/providers", () => providers],
  ["/extensions", () => ({ sessions: [], mcp: null })],
  ["/migrations", () => ({ archives: [], journal: [], sources: { opencode: null, piCli: null } })],
  ["/pty", () => []],
];

function compile(pattern: string): (path: string) => Record<string, string> | null {
  const names: string[] = [];
  const source = pattern.split("/").map(part => (part.startsWith(":") ? (names.push(part.slice(1)), "([^/]+)") : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  const regex = new RegExp(`^${source}$`);
  return path => {
    const match = regex.exec(path);
    return match ? Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) : null;
  };
}

export interface RuntimeFixture {
  backend: RuntimeBackend;
  calls: RuntimeCall[];
  unexpected: RuntimeCall[];
  /** Route a method+path (`:name` segments) to a handler; later routes win. */
  on(method: string, pattern: string, handler: RouteHandler): void;
  /** Calls of one method+pattern, in order. */
  made(method: string, pattern: string): RuntimeCall[];
  directoryStreams: Array<{ directory: string; subscription: EventSubscription<ServerEvent> }>;
  globalStreams: Array<EventSubscription<DirectoryEvent>>;
  /** Deliver an event to the newest live stream of `directory` (default: newest live stream). */
  emit(event: ServerEvent, directory?: string): void;
  /** Deliver a runtime-wide event as the all-directories stream would. */
  emitGlobal(event: ServerEvent, directory?: string): void;
}

/**
 * Several fixtures may be live at once (this computer plus forwarded SSH
 * runtimes): one stubbed fetch dispatches by origin. After vi.unstubAllGlobals
 * the table starts empty again.
 */
type Server = (input: string, init: RequestInit) => Promise<Response>;
const servers = new Map<string, Server>();
let dispatcher: ((input: string, init?: RequestInit) => Promise<Response>) | null = null;
function serve(origin: string, server: Server): void {
  if (!dispatcher || globalThis.fetch !== dispatcher) {
    servers.clear();
    dispatcher = vi.fn(async (input: string, init: RequestInit = {}) => {
      const target = servers.get(new URL(input).origin);
      if (!target) throw new TypeError(`fixture refuses ${new URL(input).origin}`);
      return target(input, init);
    });
    vi.stubGlobal("fetch", dispatcher);
  }
  servers.set(origin, server);
}

export function runtimeFixture(options: { connection?: Partial<RuntimeConnection>; workspace?: string } = {}): RuntimeFixture {
  const connection = { ...FIXTURE_CONNECTION, ...options.connection };
  const routes: Array<{ method: string; match: ReturnType<typeof compile>; pattern: string; handler: RouteHandler }> = [];
  const calls: RuntimeCall[] = [], unexpected: RuntimeCall[] = [];
  const json = (status: number, body: unknown) => body === undefined ? new Response(null, { status: status === 200 ? 204 : status })
    : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const on = (method: string, pattern: string, handler: RouteHandler) => { routes.unshift({ method, pattern, match: compile(pattern), handler }); };
  for (const [pattern, handler] of READS) on("GET", pattern, handler);
  serve(new URL(connection.endpoint).origin, async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (!url.pathname.startsWith("/v1/")) throw new TypeError(`fixture refuses ${url.origin}${url.pathname}`);
    const method = (init.method ?? "GET").toUpperCase(), path = url.pathname.slice(3);
    const call: RuntimeCall = { method, path, params: {}, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(String(init.body)) : undefined,
      ...(init.signal ? { signal: init.signal } : {}) };
    calls.push(call);
    for (const route of routes) {
      const params = route.method === method ? route.match(path) : null;
      if (!params) continue;
      call.params = params;
      try {
        // Like fetch: an aborted request rejects even while its handler is pending.
        const aborted = init.signal && new Promise<never>((_, reject) => {
          const fail = () => reject(init.signal!.reason ?? new DOMException("Aborted", "AbortError"));
          if (init.signal!.aborted) fail(); else init.signal!.addEventListener("abort", fail, { once: true });
        });
        const handled = Promise.resolve(route.handler(call));
        const result = await (aborted ? Promise.race([handled, aborted]) : handled);
        return result instanceof Response ? result : json(200, result);
      } catch (error) {
        if (error instanceof RuntimeReply) return json(error.status, error.body ?? { message: `HTTP ${error.status}` });
        throw error;
      }
    }
    unexpected.push(call);
    return json(method === "GET" ? 404 : 599, { message: `fixture: unrouted ${method} ${path}` });
  });
  const backend = new RuntimeBackend(connection, async () => connection, options.workspace ?? LOCAL_WORKSPACE);
  const directoryStreams: RuntimeFixture["directoryStreams"] = [], globalStreams: RuntimeFixture["globalStreams"] = [];
  vi.spyOn(backend, "subscribeDirectory").mockImplementation((directory, subscription) => { directoryStreams.push({ directory, subscription }); });
  vi.spyOn(backend, "subscribeAll").mockImplementation(subscription => { globalStreams.push(subscription); });
  const live = <T extends { signal: AbortSignal }>(subscription: T) => !subscription.signal.aborted;
  return {
    backend, calls, unexpected, on, directoryStreams, globalStreams,
    made: (method, pattern) => { const match = compile(pattern); return calls.filter(call => call.method === method && match(call.path)); },
    emit: (event, directory) => {
      const target = [...directoryStreams].reverse().find(s => live(s.subscription) && (directory === undefined || s.directory === directory));
      if (!target) throw new Error(`fixture: no live stream for ${directory ?? "any directory"}`);
      target.subscription.onEvent(event);
    },
    emitGlobal: (event, directory) => {
      const target = [...globalStreams].reverse().find(live);
      if (!target) throw new Error("fixture: no live runtime-wide stream");
      target.onEvent({ directory, payload: event });
    },
  };
}

/**
 * Answer GET /providers with one connected provider and the given models (each
 * with the listed variants), as the runtime's model catalogue would. The store
 * reloads this on every project switch, so tests that send must declare it.
 */
export function withProvider(fixture: RuntimeFixture, providerID = "p", models: string[] = ["m", "other"], variants: string[] = ["low", "medium"]): void {
  fixture.on("GET", "/providers", () => ({
    all: [{ id: providerID, name: providerID, source: "builtin", models: Object.fromEntries(models.map(id => [id, {
      id, providerID, name: id, capabilities: { reasoning: variants.length > 0, input: { text: true, image: false } },
      variants: Object.fromEntries(variants.map(v => [v, {}])),
    }])) }],
    connected: [providerID], default: {},
  } as unknown as ProvidersDTO));
}

/**
 * Bind the fixture's backend as the store's connected runtime. This replaces
 * only the native supervisor handshake (`connectRuntime`), not any store logic.
 */
export function bindStore(store: any, fixture: RuntimeFixture, state: Record<string, unknown> = {}): void {
  const { prefs = {}, connection = {}, ...rest } = state as { prefs?: object; connection?: object };
  store.runtime = fixture.backend;
  store.state = {
    ...store.state,
    ...rest,
    connection: { ...store.state.connection, phase: "connected", streamState: "open", statusError: null, ...connection, endpoint: fixture.backend.endpoint },
    // The bound runtime's identity always wins over a test's prefs patch.
    prefs: { ...store.state.prefs, ...prefs, endpoint: fixture.backend.endpoint, workspaceKey: fixture.backend.workspace },
  };
}
