// SSE admission: a finite server-wide budget plus a per-window (principal)
// budget. Two windows each get their own share, a third stream of one window
// gets backpressure (429) without starving the other, and closing a stream
// releases its slot. Loopback server owned by this test only.
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEFAULT_EVENT_STREAMS, DEFAULT_EVENT_STREAMS_PER_CLIENT, openEventStream, Router, startServer, STREAMING } from "../src/server/http.ts";
import { ownedRequest, type OwnedRequest } from "./helpers.ts";

const TOKEN = "t".repeat(40);
let stop: (() => Promise<void>) | undefined;
// Each stream owns its socket; all are destroyed and their close awaited
// BEFORE the listener stops, so no pooled client reconnects to a closed port.
const open: OwnedRequest[] = [];
afterEach(async () => { await Promise.allSettled(open.splice(0).map((c) => c.close())); await stop?.(); stop = undefined; });

async function server(maxEventStreams: number, maxEventStreamsPerClient: number) {
  const router = new Router();
  router.add("GET", "/stream", (request) => { const stream = openEventStream(request); stream.send(null, { type: "hello" }); return STREAMING; });
  const started = await startServer(router, { credentials: { current: TOKEN, previous: null }, allowedOrigins: () => [], maxBody: 1024, maxEventStreams, maxEventStreamsPerClient });
  stop = () => started.close(1000);
  return started.port;
}
async function connect(port: number, client: string): Promise<number> {
  let resolveStatus!: (status: number) => void;
  const status = new Promise<number>((resolve) => { resolveStatus = resolve; });
  const request = ownedRequest(`http://127.0.0.1:${port}/stream`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Enki-Client": client } },
    (response) => { resolveStatus(response.statusCode ?? 0); response.resume(); }, () => resolveStatus(0));
  open.push(request);
  const code = await status;
  if (code !== 200) await request.close();
  return code;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

it("keeps practical multi-window defaults finite", () => {
  expect(DEFAULT_EVENT_STREAMS_PER_CLIENT).toBeGreaterThanOrEqual(4); // directory + global + plugin UI + one terminal
  expect(DEFAULT_EVENT_STREAMS).toBeGreaterThanOrEqual(2 * DEFAULT_EVENT_STREAMS_PER_CLIENT);
  expect(Number.isFinite(DEFAULT_EVENT_STREAMS)).toBe(true);
});

it("two windows get independent shares; overflow is backpressure; closing releases the slot", async () => {
  const port = await server(4, 2);
  const a = randomUUID(), b = randomUUID();
  expect(await connect(port, a)).toBe(200);
  expect(await connect(port, a)).toBe(200);
  expect(await connect(port, a)).toBe(429); // per-window bound
  expect(await connect(port, b)).toBe(200); // the other window is not starved
  expect(await connect(port, b)).toBe(200);
  expect(await connect(port, randomUUID())).toBe(429); // server-wide bound
  // Close one of window A's streams (the first one opened): its slot is released.
  await open[0]!.close();
  await settle();
  expect(await connect(port, a)).toBe(200);
});
