import { expect, it } from "vitest";
import type { AssistantMessage, UserMessage } from "../src/api/types";
import { describeMessageError, isModelConnectionError, sessionBannerError } from "../src/chat/errors";

const raw = "Cannot connect to API: Unable to connect. Is the computer able to access the url?";
const error = { name: "APIError", data: { message: raw, isRetryable: true,
  metadata: { url: "http://user:secret@127.0.0.1:18021/v1/chat/completions?key=private" } } };
const failed: AssistantMessage = { id: "a", sessionID: "s", role: "assistant", time: { created: 1 }, error };
const user: UserMessage = { id: "u", sessionID: "s", role: "user", time: { created: 2 } };

it("explains a loopback model transport failure without exposing private URL data", () => {
  expect(isModelConnectionError(error)).toBe(true);
  const text = describeMessageError(error);
  expect(text).toContain("API модели"); expect(text).toContain("SSH-туннель");
  expect(text).not.toMatch(/secret|private|user|18021|OpenCode/);
  expect(describeMessageError({ ...error, data: { message: raw } })).toContain("подключение к сервису");
});
it("does not relabel HTTP refusal, engine disconnect, balance or tool errors as model transport", () => {
  for (const value of [
    { ...error, data: { ...error.data, statusCode: 403 } },
    { name: "APIError", data: { message: "Insufficient Balance", isRetryable: true } },
    { name: "ConnectionError", message: "Cannot reach OpenCode server" },
    { name: "ToolError", data: { message: raw } },
  ]) expect(isModelConnectionError(value)).toBe(false);
  for (const value of [null, 42, {}, "failure", { data: null }]) expect(() => describeMessageError(value)).not.toThrow();
  expect(describeMessageError({ name: "MessageAbortedError" })).toBe("Ответ остановлен.");
});
it("deduplicates only the last visible assistant error and accepts legacy raw banners", () => {
  expect(sessionBannerError(describeMessageError(error), [failed])).toBeNull();
  expect(sessionBannerError(raw, [failed])).toBeNull();
  expect(sessionBannerError(describeMessageError({ name: "APIError", data: { message: raw } }), [failed])).toBeNull();
  expect(sessionBannerError("Different error", [failed])).toBe("Different error");
  expect(sessionBannerError(raw, [failed, user])).toBe(raw);
  expect(sessionBannerError(raw, [])).toBe(raw);
  expect(sessionBannerError(null, [failed])).toBeNull();
});
