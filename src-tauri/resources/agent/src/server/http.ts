// Loopback HTTP transport for the Enki Runtime API.
//
// - Binds 127.0.0.1 only (never 0.0.0.0, never a LAN interface).
// - Every request except a CORS preflight needs `Authorization: Bearer <token>`;
//   tokens come from the supervisor over stdio, rotate, and are compared in
//   constant time. Tokens are never accepted from URLs.
// - Host must be the loopback address of this listener (DNS-rebinding guard).
// - CORS is answered only for the exact app origins the supervisor allows;
//   there is no wildcard.
// - Bodies are size-bounded JSON; errors never echo request content.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface Credentials {
  current: string | null;
  previous: { token: string; until: number } | null;
}

export interface HttpOptions {
  credentials: Credentials;
  allowedOrigins: () => readonly string[];
  maxBody: number;
  /** Remote daemon: clients arrive through an SSH forward on another port. */
  anyLoopbackPort?: boolean;
  requestTimeoutMs?: number;
  accepting?: () => boolean;
  controlPath?: (pathname: string) => boolean;
  /** Server-wide bound on concurrent SSE streams (all clients together). */
  maxEventStreams?: number;
  /** Bound per authenticated principal (one window = one X-Enki-Client). */
  maxEventStreamsPerClient?: number;
  /** Called synchronously before reading a mutating request body. */
  admit?: () => () => void;
}

/**
 * One window uses a directory stream, the global stream, a plugin UI stream
 * and one stream per open terminal; several windows and an attached remote
 * relay share the runtime. Both bounds stay finite: the 429 is backpressure.
 */
export const DEFAULT_EVENT_STREAMS = 32;
export const DEFAULT_EVENT_STREAMS_PER_CLIENT = 10;

/** `Host` must name loopback; `port` null accepts any explicit port. */
export function loopbackHost(host: string, port: number | null): boolean {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(host);
  if (!match) return false;
  const value = Number(match[2]);
  return value > 0 && value < 65536 && (port === null || value === port);
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  signal: AbortSignal;
  raw: http.IncomingMessage;
  response: http.ServerResponse;
  /** Stable for one bearer authority; never exposes the bearer token. */
  principal: string;
  reserveEventStream?: () => () => void;
}

export type Handler = (request: Request) => Promise<unknown> | unknown;
/** Marker returned by streaming handlers that own the response. */
export const STREAMING = Symbol("streaming");

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; mutation: boolean }

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: { mutation?: boolean } = {}): void {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => { keys.push(key); return "([^/]+)"; })}$`);
    this.routes.push({ method, pattern, keys, handler, mutation: options.mutation ?? !["GET", "HEAD"].includes(method) });
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string>; mutation: boolean } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const found = route.pattern.exec(path);
      if (!found) continue;
      const params: Record<string, string> = {};
      // A malformed escape is the client's error (400), never an internal 500.
      try { route.keys.forEach((key, index) => { params[key] = decodeURIComponent(found[index + 1]); }); }
      catch { throw new HttpError(400, "Некорректный путь запроса."); }
      return { handler: route.handler, params, mutation: route.mutation };
    }
    return null;
  }
}

function authorized(header: string | undefined, credentials: Credentials): boolean {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header ?? "");
  if (!match) return false;
  if (credentials.current && equal(match[1], credentials.current)) return true;
  const previous = credentials.previous;
  return !!previous && previous.until > Date.now() && equal(match[1], previous.token);
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "Запрос слишком велик.");
    chunks.push(buffer);
  }
  if (!size) return undefined;
  const type = request.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "Ожидался JSON.");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "Некорректный JSON."); }
}

export function startServer(router: Router, options: HttpOptions, port = 0): Promise<{ server: http.Server; port: number; stopAdmission(): void; close(deadlineMs?: number): Promise<void> }> {
  let accepting = true;
  let activeEventStreams = 0;
  const streamsByPrincipal = new Map<string, number>();
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer(async (request, response) => {
    const address = server.address() as AddressInfo | null;
    const listening = address?.port ?? 0;
    const origin = request.headers.origin;
    const allowed = origin ? options.allowedOrigins().includes(origin) : false;
    // DNS-rebinding guard: only loopback names. A remote runtime is reached
    // through an SSH forward whose local port differs from `listening`, so
    // the port may be any; the name may not.
    const host = request.headers.host ?? "";
    if (!loopbackHost(host, options.anyLoopbackPort ? null : listening)) {
      response.writeHead(421).end();
      return;
    }
    if (origin && !allowed) {
      response.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Origin not allowed" }));
      return;
    }
    if (allowed && origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Expose-Headers", "X-Next-Cursor, X-Enki-Instance");
    }
    if (request.method === "OPTIONS") {
      if (!allowed) { response.writeHead(403).end(); return; }
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID, X-Enki-Client",
        "Access-Control-Max-Age": "600",
      }).end();
      return;
    }
    if (!authorized(request.headers.authorization, options.credentials)) {
      response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    let url: URL;
    try { url = new URL(request.url ?? "/", `http://127.0.0.1:${listening}`); }
    catch { response.writeHead(400).end(); return; }
    if (url.searchParams.has("token") || url.searchParams.has("access_token")) {
      response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Tokens are not accepted in URLs" }));
      return;
    }
    const abort = new AbortController();
    const disconnected = () => { if (!response.writableFinished) abort.abort(); };
    const incomplete = () => { if (!request.complete) abort.abort(); };
    const cleanup = () => { request.off("close", incomplete); response.off("close", disconnected); response.off("finish", cleanup); };
    request.on("close", incomplete);
    response.on("close", disconnected);
    response.once("close", cleanup);
    response.once("finish", cleanup);
    let release: (() => void) | undefined;
    try {
      const matched = router.match(request.method ?? "GET", url.pathname);
      if (!matched) throw new HttpError(404, "Not found");
      if (matched.mutation && !options.controlPath?.(url.pathname)) {
        if (!accepting || options.accepting?.() === false) throw new HttpError(503, "Enki Runtime останавливается. Запрос не принят.");
        try { release = options.admit?.(); }
        catch { throw new HttpError(503, "Enki Runtime готовится к обновлению. Действие не принято."); }
      }
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : await readBody(request, options.maxBody);
      const principal = (() => {
        const client = request.headers["x-enki-client"];
        const valid = typeof client === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(client);
        return `${valid ? "client" : "authority"}:` + createHash("sha256").update(request.headers.authorization!).update(valid ? "\0" + client : "").digest("hex");
      })();
      const result = await matched.handler({ method: request.method ?? "GET", path: url.pathname, params: matched.params, query: url.searchParams, body, signal: abort.signal, raw: request, response,
        principal,
        reserveEventStream: () => {
          const own = streamsByPrincipal.get(principal) ?? 0;
          if (activeEventStreams >= (options.maxEventStreams ?? DEFAULT_EVENT_STREAMS) || own >= (options.maxEventStreamsPerClient ?? DEFAULT_EVENT_STREAMS_PER_CLIENT))
            throw new HttpError(429, 'Слишком много потоков событий. Закройте лишнее подключение и повторите.');
          activeEventStreams++; streamsByPrincipal.set(principal, own + 1); let released = false;
          return () => {
            if (released) return;
            released = true; activeEventStreams--;
            const left = (streamsByPrincipal.get(principal) ?? 1) - 1;
            if (left > 0) streamsByPrincipal.set(principal, left); else streamsByPrincipal.delete(principal);
          };
        },
      });
      if (result === STREAMING) return;
      if (response.headersSent) return;
      const status = result instanceof Reply ? result.status : 200;
      const payload = result instanceof Reply ? result.body : result;
      if (payload === undefined) { response.writeHead(status === 200 ? 204 : status).end(); return; }
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(payload));
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Internal error";
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ message }));
    } finally { release?.(); }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 60_000;
  server.headersTimeout = 15_000;
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let closing: Promise<void> | undefined;
  const close = (deadlineMs = 1_000): Promise<void> => closing ??= new Promise((resolve, reject) => {
    accepting = false;
    const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, Math.max(0, deadlineMs));
    server.close((error) => { clearTimeout(timer); if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error); else resolve(); });
    server.closeIdleConnections();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port, stopAdmission: () => { accepting = false; }, close });
    });
  });
}

/** A JSON body with an explicit HTTP status (202 receipts, 409 conflicts). */
export class Reply {
  constructor(readonly status: number, readonly body: unknown) {}
}

export function withStatus(status: number, body: unknown): Reply {
  return new Reply(status, body);
}

/** Server-sent events over the response, with heartbeat and backpressure-aware writes. */
export function openEventStream(request: Request, bounds: { maxBufferedBytes?: number; maxEventBytes?: number; stallMs?: number; heartbeatMs?: number; flushMs?: number } = {}): {
  send(id: number | null, data: unknown): boolean;
  /** An already serialized JSON payload (see server/wire.ts) with its seq. */
  sendSerialized(id: number, json: string): boolean;
  close(): void; closed: () => boolean; onClose(callback: () => void): () => void;
} {
  const { response } = request;
  const releaseSlot = request.reserveEventStream?.() ?? (() => {});
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let closed = false;
  let blocked = false;
  const cleanups = new Set<() => void>();
  let stall: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Current DTOs may contain a legal 64MiB request attachment as a data URL.
  // Keep one such event deliverable until the protocol uses attachment refs.
  const eventLimit = bounds.maxEventBytes ?? (64 * 1024 * 1024 + 64 * 1024);
  const budget = bounds.maxBufferedBytes ?? eventLimit;
  const drained = () => { blocked = false; if (stall) clearTimeout(stall); stall = undefined; };
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (stall) clearTimeout(stall);
    request.signal.removeEventListener("abort", close);
    response.off("close", close);
    response.off("error", close);
    response.off("drain", drained);
    for (const callback of cleanups) { try { callback(); } catch { process.stderr.write('Enki: event stream cleanup failed\n'); } }
    cleanups.clear();
    // Stop producing/unsubscribe immediately, but allow the last accepted frame
    // to flush. Destroying on write(false) would cause endless replay of it.
    if (!response.destroyed && !response.writableFinished) {
      const flush = setTimeout(() => { response.destroy(); releaseSlot(); }, bounds.flushMs ?? 1_000);
      const flushed = () => { clearTimeout(flush); releaseSlot(); response.off('finish', flushed); response.off('close', flushed); response.off('error', failed); };
      const failed = () => { response.destroy(); flushed(); };
      response.once('finish', flushed); response.once('close', flushed); response.once('error', failed);
      if (!response.writableEnded) response.end();
    } else releaseSlot();
  };
  const write = (value: string): boolean => {
    if (closed) return false;
    const length = Buffer.byteLength(value);
    if (blocked || length > eventLimit || response.writableLength + length > budget) { close(); return false; }
    const writable = response.write(value);
    if (!writable) { blocked = true; stall = setTimeout(close, bounds.stallMs ?? 5_000); }
    return writable;
  };
  heartbeat = setInterval(() => { if (!closed && !blocked) write(": keepalive\n\n"); }, bounds.heartbeatMs ?? 15_000);
  request.signal.addEventListener("abort", close, { once: true });
  response.once("close", close);
  response.once("error", close);
  response.on("drain", drained);
  if (request.signal.aborted) close();
  return {
    send: (id, data) => {
      if (closed) return false;
      return write(`${id !== null ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    },
    sendSerialized: (id, json) => {
      if (closed) return false;
      return write(`id: ${id}\ndata: ${json}\n\n`);
    },
    close,
    closed: () => closed,
    onClose: (callback) => { if (closed) callback(); else cleanups.add(callback); return () => { cleanups.delete(callback); }; },
  };
}

export const str = (query: URLSearchParams, key: string): string | undefined => {
  const value = query.get(key);
  return value === null || value === "" ? undefined : value;
};
export const int = (query: URLSearchParams, key: string): number | undefined => {
  const value = query.get(key);
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, `Некорректный параметр ${key}.`);
  return parsed;
};
