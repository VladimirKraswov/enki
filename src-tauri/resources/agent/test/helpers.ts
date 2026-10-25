// Integration harness: a real Runtime (real pinned SDK, real SQLite, real
// HTTP server) with the SDK's deterministic scripted provider. Nothing here
// fabricates agent results; responses are scripted model outputs that the SDK
// processes exactly as it would process a provider's.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NO_BROKER, type Broker } from "../src/control/broker.ts";
import { Runtime, type RuntimeConfig } from "../src/core/runtime.ts";
import type { CommandReceipt, CommandRequest, EventEnvelope, ModelRef } from "../src/protocol.ts";
import { buildRoutes } from "../src/server/routes.ts";
import { startServer, type Credentials } from "../src/server/http.ts";
import { scriptedRuntime, type ScriptedRuntime } from "../src/sdk/testing.ts";
import type { SdkExtension, SdkExtensionApi } from "../src/sdk/adapter.ts";

export const ORIGIN = "tauri://localhost";

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `enki-${prefix}-`)));
}

export interface Harness {
  runtime: Runtime;
  scripted: ScriptedRuntime;
  base: string;
  token: string;
  credentials: Credentials;
  data: string;
  model: (id?: "large" | "small" | "medium" | "vision") => ModelRef;
  request<T>(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  command(request: CommandRequest): Promise<{ status: number; body: CommandReceipt }>;
  waitReceipt(id: string, states: string[], timeoutMs?: number): Promise<CommandReceipt>;
  project(name: string): string;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  data?: string;
  broker?: Broker;
  extraExtensions?: RuntimeConfig["extraExtensions"];
  scripted?: ScriptedRuntime;
  ptyModule?: RuntimeConfig["ptyModule"];
  /** Explicit synthetic legacy sources (never the owner's real profile). */
  legacy?: RuntimeConfig["legacy"];
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const data = options.data ?? tempDir("runtime");
  const scripted = options.scripted ?? await scriptedRuntime(path.join(data, "scripted-agent"));
  const runtime = await Runtime.create({
    dataDir: data, host: "local", broker: options.broker ?? NO_BROKER, credentials: "memory", userPiAgentDir: path.join(data, "no-user-pi"),
    legacy: options.legacy ?? {}, allowModelNetwork: false, version: "test", modelRuntime: scripted.modelRuntime, capabilities: async () => null,
    extraExtensions: options.extraExtensions, settingsInMemory: true, ...(options.ptyModule ? { ptyModule: options.ptyModule } : {}),
  });
  const token = randomBytes(32).toString("base64url");
  const credentials: Credentials = { current: token, previous: null };
  const started = await startServer(buildRoutes(runtime, null), { credentials, allowedOrigins: () => [ORIGIN], maxBody: 64 * 1024 * 1024 })
    .catch(async (error: unknown) => { await runtime.shutdown(); throw error; });
  const { server, port } = started;
  const base = `http://127.0.0.1:${port}/v1`;
  const request = <T,>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
    ownedText(`${base}${route}`, { method, body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers } }, h)
      .then(({ status, text }) => ({ status, body: (text ? JSON.parse(text) : undefined) as T }));
  const projects: string[] = [];
  let stopping: Promise<void> | undefined;
  const h: Harness = {
    runtime, scripted, base, token, credentials, data,
    model: (id = "large") => ({ providerID: scripted.provider, modelID: scripted.models[id] }),
    request,
    command: (command) => request<CommandReceipt>("POST", "/commands", command),
    waitReceipt: async (id, states, timeoutMs = 20_000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const receipt = runtime.ledger.get(id);
        if (receipt && states.includes(receipt.state)) return receipt;
        if (Date.now() > until) throw new Error(`receipt ${id} stayed ${receipt?.state ?? "missing"}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    project: (name) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `enki-project-${name}-`)));
      projects.push(dir);
      return dir;
    },
    // Unconditional, idempotent teardown. A failed assertion can skip a test's own
    // client.close(); an open SSE response would keep server.close() pending
    // forever, so every owned request/stream is destroyed AND its socket close
    // awaited BEFORE the listener closes (nothing pooled can reconnect to the
    // expired port), and the runtime (workers, timers, SQLite) is always shut down.
    stop: () => stopping ??= (async () => {
      try {
        await Promise.allSettled([...(owned.get(h) ?? [])].map((item) => item.close()));
        owned.delete(h);
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      } finally {
        await runtime.shutdown();
      }
    })(),
  };
  return h;
}

/** Test-owned HTTP requests/streams of each harness, closed by its stop(). */
export interface OwnedRequest { readonly closed: Promise<void>; close(): Promise<void> }
const owned = new WeakMap<Harness, Set<OwnedRequest>>();

/**
 * One request on its OWN socket (`agent: false`, `Connection: close`): no
 * keep-alive pool exists that could reconnect after the fixture listener
 * closes. `close()` destroys it and resolves once its socket really closed.
 * With an owner harness it is tracked and closed by that harness's stop().
 */
export function ownedRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string },
  onResponse: (response: http.IncomingMessage) => void, onError: (error: Error) => void, owner?: Harness): OwnedRequest {
  const length = init.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(init.body)) };
  const request = http.request(url, { method: init.method ?? "GET", agent: false, headers: { ...init.headers, ...length, Connection: "close" } }, onResponse);
  request.on("error", onError);
  const closed = new Promise<void>((resolve) => request.once("close", () => resolve()));
  const handle: OwnedRequest = { closed, close: () => { request.destroy(); return closed; } };
  if (owner) {
    const set = owned.get(owner) ?? new Set<OwnedRequest>();
    owned.set(owner, set.add(handle));
    void closed.then(() => set.delete(handle));
  }
  request.end(init.body);
  return handle;
}

/** Complete text response over ownedRequest; rejects if closed before its end. */
export function ownedText(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, owner?: Harness): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    ownedRequest(url, init, (response) => {
      const chunks: Buffer[] = []; let ended = false;
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => { ended = true; resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }); });
      response.once("close", () => { if (!ended) reject(new Error("response closed before its end")); });
      response.on("error", reject);
    }, reject, owner);
  });
}

/** Incremental SSE `data:` frames of an owned streaming response. */
export function ownedEvents(url: string, headers: Record<string, string>, onFrame: (data: string) => void, owner: Harness):
  { request: OwnedRequest; status: Promise<number> } {
  let resolveStatus!: (status: number) => void;
  const status = new Promise<number>((resolve) => { resolveStatus = resolve; });
  const request = ownedRequest(url, { headers }, (response) => {
    resolveStatus(response.statusCode ?? 0);
    response.setEncoding("utf8");
    let buffer = "";
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer.slice(0, index).split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        buffer = buffer.slice(index + 2);
        if (data) onFrame(data);
      }
    });
    response.on("error", () => undefined);
  }, () => resolveStatus(0), owner);
  void request.closed.then(() => resolveStatus(0));
  return { request, status };
}

export interface StreamClient {
  events: EventEnvelope[];
  hello: Promise<{ instance: string; head: number }>;
  resets: number;
  close(): void;
  /** Resolves once the stream's socket is really closed. */
  closed: Promise<void>;
  waitFor(predicate: (e: EventEnvelope) => boolean, timeoutMs?: number): Promise<EventEnvelope>;
  last(): number;
}

/** Minimal SSE client on its own socket, the same wire format the WebView uses. */
export function stream(h: Harness, query: string): StreamClient {
  const events: EventEnvelope[] = [];
  let resolveHello!: (value: { instance: string; head: number }) => void;
  const hello = new Promise<{ instance: string; head: number }>((resolve) => { resolveHello = resolve; });
  const { request } = ownedEvents(`${h.base}/events?${query}`, { Authorization: `Bearer ${h.token}` }, (data) => {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.type === "stream.hello") resolveHello({ instance: String(parsed.instance), head: Number(parsed.head) });
    else if (parsed.type === "stream.reset") client.resets++;
    else events.push(parsed as unknown as EventEnvelope);
  }, h);
  const client: StreamClient = {
    events, hello, resets: 0, closed: request.closed,
    close: () => { void request.close(); },
    waitFor: async (predicate, timeoutMs = 20_000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > until) throw new Error("event not observed");
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    last: () => events.reduce((max, e) => Math.max(max, e.seq), 0),
  };
  return client;
}

export function promptCommand(h: Harness, id: string, sessionID: string, directory: string, text: string, model = h.model()): CommandRequest {
  return { id, kind: "prompt", sessionID, directory, payload: { parts: [{ type: "text", text }], model } };
}

export async function newSession(h: Harness, directory: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await h.request<{ id: string }>("POST", "/sessions", { directory, ...extra });
  if (created.status !== 200) throw new Error(`create session failed: ${created.status}`);
  return created.body.id;
}

/** A deferred gate the scripted provider waits on, to hold a turn open. */
export function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

export function extension(name: string, factory: (pi: SdkExtensionApi) => void): SdkExtension {
  return { name, factory };
}
