// @vitest-environment jsdom
import { expect, it, vi, afterEach } from "vitest";
import { helperHealth, DEFAULT_HELPER_ENDPOINT } from "../src/attachments/helper";

afterEach(() => vi.unstubAllGlobals());

it("explains a helper outage instead of the raw WebKit 'Load failed'", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));
  await expect(helperHealth(DEFAULT_HELPER_ENDPOINT)).rejects.toThrow(/Сервис подготовки файлов недоступен.*SSH-туннель/);
});

it("keeps the helper's own HTTP error message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Очередь занята" }) })));
  await expect(helperHealth(DEFAULT_HELPER_ENDPOINT)).rejects.toThrow("Помощник: Очередь занята");
});
