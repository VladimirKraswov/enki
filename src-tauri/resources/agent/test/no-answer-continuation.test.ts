import { expect, it } from "vitest";
import { needsContinuation, runOutcome } from "../src/sessions/worker.ts";

const facts = (last: unknown) => ({ produced: false, compaction: null, retryError: null, last }) as never;
const reply = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, stopReason });

it("asks once more only for a reasoning-only or empty stop that the model itself ended", () => {
  expect(needsContinuation(facts(reply([{ type: "reasoning", text: "…" }])), false)).toBe(true);
  expect(needsContinuation(facts(reply([])), false)).toBe(true);
  // Пользователь остановил — никакого автоповтора.
  expect(needsContinuation(facts(reply([{ type: "reasoning", text: "…" }])), true)).toBe(false);
  // Нормальный ответ / вызов инструмента / обрыв по длине / нет ответа модели.
  expect(needsContinuation(facts(reply([{ type: "text", text: "готово" }])), false)).toBe(false);
  expect(needsContinuation(facts(reply([{ type: "toolCall", name: "bash" }])), false)).toBe(false);
  expect(needsContinuation(facts(reply([{ type: "reasoning", text: "…" }], "length")), false)).toBe(false);
  expect(needsContinuation(facts(reply([{ type: "reasoning", text: "…" }], "error")), false)).toBe(false);
  expect(needsContinuation(facts(undefined), false)).toBe(false);
});

it("still reports the honest no_answer outcome when the continuation produced nothing", () => {
  const outcome = runOutcome("c1", facts(reply([{ type: "reasoning", text: "…" }])), true);
  expect(outcome.reason).toBe("no_answer");
  expect(outcome.state).toBe("failed");
  expect(outcome.error).toContain("не дала ответа");
});
