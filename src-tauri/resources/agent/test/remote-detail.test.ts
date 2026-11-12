import assert from "node:assert/strict";
import { it } from "vitest";
import { fitRemoteDetail } from "../src/remote.ts";
import { REMOTE_DETAIL_BUDGET } from "../src/remote/snapshot.ts";
import type { MessageDTO } from "../src/protocol.ts";

function message(id: string, text: string): MessageDTO {
  return { info: { id, sessionID: "session", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text } as MessageDTO["parts"][number]] };
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

it("remote detail keeps live queue and recent messages within the Hub budget", () => {
  const queue = { sessionID: "session", armed: true, pausedReason: null, items: [], corrections: [] };
  const detail = fitRemoteDetail({ session: "session", queue, status: { type: "idle" },
    messages: Array.from({ length: 1000 }, (_, index) => message(`m-${index}`, "x".repeat(20_000))) });
  assert.ok(bytes(detail) <= REMOTE_DETAIL_BUDGET, `detail was ${bytes(detail)} bytes`);
  assert.deepEqual(detail.queue, queue);
  assert.deepEqual(detail.status, { type: "idle" });
  const messages = detail.messages as MessageDTO[];
  assert.ok(messages.length > 0 && messages.length < 1000);
  assert.equal(messages.at(-1)?.info.id, "m-999");
  assert.match(String(detail.historyError), /сокращённый конец/);
});

it("remote detail preserves small history without a truncation warning", () => {
  const detail = fitRemoteDetail({ session: "session", queue: { items: [] }, messages: [message("small", "Обычный ответ")] });
  assert.equal(detail.historyError, undefined);
  assert.equal((detail.messages as MessageDTO[])[0].parts[0].text, "Обычный ответ");
});

it("pathological history cannot block the live detail envelope", () => {
  const queue = { sessionID: "session", items: [{ id: "current", state: "ready" }] };
  const huge = message("huge", "x".repeat(8_000));
  huge.parts = Array.from({ length: 2000 }, () => ({ type: "text", text: "x".repeat(8_000) } as MessageDTO["parts"][number]));
  const detail = fitRemoteDetail({ session: "session", queue, messages: [huge] });
  assert.ok(bytes(detail) <= REMOTE_DETAIL_BUDGET);
  assert.deepEqual(detail.queue, queue);
  assert.equal((detail.messages as MessageDTO[]).length, 0);
  assert.match(String(detail.historyError), /Актуальные статус и очередь/);
});
