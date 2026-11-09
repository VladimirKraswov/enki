import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { openEventStream } from "../src/server/http.ts";

function fakeRequest() {
  const response = new EventEmitter() as EventEmitter & Record<string, any>;
  response.writeHead = vi.fn();
  response.writableLength = 0; response.writableFinished = false; response.writableEnded = false; response.destroyed = false;
  response.written = [] as string[];
  response.end = vi.fn(() => { response.writableEnded = true; response.writableFinished = true; });
  response.destroy = vi.fn(() => { response.destroyed = true; });
  response.write = vi.fn((value: string) => { response.written.push(value); return response.accept ?? true; });
  return { request: { response, signal: new AbortController().signal }, response };
}

it("queues writes during backpressure and delivers them on drain instead of closing", () => {
  const { request, response } = fakeRequest();
  const stream = openEventStream(request as never, { heartbeatMs: 60_000, stallMs: 60_000, flushMs: 5 });
  response.accept = false;
  expect(stream.send(1, { a: 1 })).toBe(false); // первая запись упёрлась в буфер
  expect(stream.send(2, { a: 2 })).toBe(true);  // вторая — в очередь, не закрытие
  expect(stream.closed()).toBe(false);
  response.accept = true;
  response.emit("drain");
  expect(response.written.filter((v: string) => v.includes('"a":2')).length).toBe(1);
  expect(stream.closed()).toBe(false);
  stream.close();
});

it("still closes when the buffer budget is exhausted or the stall is long", () => {
  const { request, response } = fakeRequest();
  const stream = openEventStream(request as never, { heartbeatMs: 60_000, stallMs: 1, maxBufferedBytes: 200 });
  response.accept = false;
  stream.send(1, { a: 1 });
  expect(stream.send(2, { x: "y".repeat(1000) })).toBe(false);
  expect(stream.closed()).toBe(true);
  stream.close();
});
