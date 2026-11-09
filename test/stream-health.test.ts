import { expect, it } from "vitest";
import { STREAM_GRACE_MS, streamStalled } from "../src/state/streamHealth";

it("keeps a short reconnect silent and reports only a lasting one", () => {
  const t0 = 1_000_000;
  // Открытый поток и первичное подключение — не повод для тревоги.
  expect(streamStalled("open", null, t0)).toBe(false);
  expect(streamStalled("connecting", null, t0)).toBe(false);
  expect(streamStalled("idle", t0, t0 + 60_000)).toBe(false);
  // Мимолётное переподключение (навигация, рестарт рантайма, короткий разрыв).
  expect(streamStalled("reconnecting", t0, t0 + 1_000)).toBe(false);
  expect(streamStalled("error", t0, t0 + STREAM_GRACE_MS - 1)).toBe(false);
  // Реальный простой дольше паузы — показываем.
  expect(streamStalled("reconnecting", t0, t0 + STREAM_GRACE_MS)).toBe(true);
  expect(streamStalled("closed", t0, t0 + 30_000)).toBe(true);
  // Без отметки времени ничего не выдумываем.
  expect(streamStalled("reconnecting", null, t0)).toBe(false);
  expect(streamStalled("reconnecting", Number.NaN, t0)).toBe(false);
});
