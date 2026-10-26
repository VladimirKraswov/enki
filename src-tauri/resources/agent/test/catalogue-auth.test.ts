import { expect, it, vi } from "vitest";
import { catalogueRequest, type SdkModel, type SdkModelRuntime } from "../src/sdk/adapter.ts";

const model = { id: "model", provider: "cloud", api: "openai-completions", baseUrl: "https://api.example/v1" } as SdkModel;
function fake(source: string, headers?: Record<string, string>) {
  const getAuth = vi.fn(async () => ({ auth: { apiKey: "private-test-key", headers: { Authorization: null, "X-Public": "value" } } }));
  const runtime = { getProviderAuthStatus: () => ({ configured: true, source }), getRegisteredProviderConfig: () => ({ headers }), getAuth, isUsingSubscription: () => false } as unknown as SdkModelRuntime;
  return { runtime, getAuth };
}
it("never resolves command-backed keys or command-backed headers just to populate a picker", async () => {
  const key = fake("models_json_command");
  expect(await catalogueRequest(key.runtime, model, new AbortController().signal)).toBeNull(); expect(key.getAuth).not.toHaveBeenCalled();
  const header = fake("stored", { "X-Custom": "!never execute this" });
  expect(await catalogueRequest(header.runtime, model, new AbortController().signal)).toBeNull(); expect(header.getAuth).not.toHaveBeenCalled();
});
it("accepts a literal configured key and preserves an explicit nullable header override", async () => {
  const f = fake("models_json_key");
  const request = await catalogueRequest(f.runtime, model, new AbortController().signal);
  expect(f.getAuth).toHaveBeenCalledTimes(1);
  expect(request?.baseURL).toBe(model.baseUrl); expect(request?.headers).toEqual({ "X-Public": "value" });
});
