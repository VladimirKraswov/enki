import { expect, it } from "vitest";
import { questionProblem, QUESTION_LIMITS } from "../src/interaction/broker.ts";

it("accepts a bounded recap of the work and rejects an oversized or non-string context", () => {
  const base = { question: "Что делаем дальше?", context: "Логи собраны, причина найдена; нужен выбор каталога для сборки." };
  expect(questionProblem([base])).toBeNull();
  expect(questionProblem([{ ...base, context: "x".repeat(QUESTION_LIMITS.context + 1) }])).toBe("Некорректный контекст вопроса.");
  expect(questionProblem([{ ...base, context: 42 }])).toBe("Некорректный контекст вопроса.");
  expect(questionProblem([{ question: "Ок?" }])).toBeNull(); // questions without context stay valid
});
