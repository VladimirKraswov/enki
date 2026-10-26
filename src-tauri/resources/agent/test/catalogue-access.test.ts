import { afterEach, expect, it, vi } from "vitest";
import type { SdkModel, SdkModelRuntime } from "../src/sdk/adapter.ts";
const privateAuth = vi.hoisted(() => vi.fn());
vi.mock("../src/sdk/adapter.ts", () => ({ catalogueRequest: privateAuth }));
import { accessFor, CatalogueAccess, catalogueAccess, declaredFree } from "../src/models/access.ts";

const model = (id: string, baseUrl = "https://api.deepseek.com", provider = "deepseek") => ({ id, baseUrl, provider, api: "openai-completions" }) as SdkModel;
function runtime(models: SdkModel[], available = models): SdkModelRuntime {
  return { getModels: () => models, getAvailableSnapshot: () => available } as unknown as SdkModelRuntime;
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

it("checks the DeepSeek account and actual model IDs with GET only; credits do not mean free pricing", async () => {
  const m = model("flash"), r = runtime([m, model("missing")]);
  privateAuth.mockImplementation(async (_r, model) => ({ baseURL: model.baseUrl, headers: { Authorization: "Bearer private-test-key" }, subscription: false }));
  const request = vi.fn(async (url: URL, init: RequestInit) => {
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("error"); expect(init.body).toBeUndefined(); expect(url.search).toBe("");
    return url.pathname === "/user/balance" ? json({ is_available: true }) : json({ data: [{ id: "flash" }] });
  }) as unknown as typeof fetch;
  const result = await catalogueAccess(r, [m], new AbortController().signal, () => false, request);
  expect(accessFor(result, "deepseek", "flash")).toMatchObject({ state: "available", kind: "paid" });
  expect(JSON.stringify([...result])).not.toContain("private-test-key");
  const cached = await catalogueAccess(r, [model("missing")], new AbortController().signal, () => false, request);
  expect(accessFor(cached, "deepseek", "missing")?.state).toBe("unavailable");
  expect(request).toHaveBeenCalledTimes(2);
});

it("an invalid replacement key cannot reuse a prior successful entitlement or leak the API error body", async () => {
  const m = model("flash"), r = runtime([m]); let key = "first-private-key";
  privateAuth.mockImplementation(async () => ({ baseURL: m.baseUrl, headers: { Authorization: `Bearer ${key}` }, subscription: false }));
  const request = vi.fn(async (_url, init) => init.headers.Authorization.endsWith("first-private-key") ? (_url.pathname === "/models" ? json({ data: [{ id: "flash" }] }) : json({ is_available: true })) : json({ error: "DO NOT EXPOSE replacement-private-key" }, 401)) as unknown as typeof fetch;
  expect(accessFor(await catalogueAccess(r, [m], new AbortController().signal, () => false, request), "deepseek", "flash")?.state).toBe("available");
  key = "replacement-private-key";
  const denied = await catalogueAccess(r, [m], new AbortController().signal, () => false, request);
  expect(accessFor(denied, "deepseek", "flash")?.state).toBe("unavailable");
  expect(JSON.stringify([...denied])).not.toContain(key); expect(JSON.stringify([...denied])).not.toContain("DO NOT EXPOSE");
});

it("only explicit zero API pricing establishes a free route; spent paid limits hide paid routes", async () => {
  expect(declaredFree({})).toBe(false); expect(declaredFree({ pricing: { prompt: "0" } })).toBe(false);
  expect(declaredFree({ pricing: { prompt: "0", completion: "0", request: "0.1" } })).toBe(false);
  const models = [model("paid", "https://openrouter.ai/api/v1", "router"), model("free", "https://openrouter.ai/api/v1", "router")], r = runtime(models);
  privateAuth.mockImplementation(async () => ({ baseURL: models[0].baseUrl, headers: { Authorization: "Bearer test" }, subscription: false }));
  const request = vi.fn(async (url: URL) => url.pathname.endsWith("/key") ? json({ data: { limit_remaining: 0 } }) : json({ data: [{ id: "free", pricing: { prompt: "0", completion: "0", request: "0" } }, { id: "paid", pricing: { prompt: "1", completion: "2" } }] })) as unknown as typeof fetch;
  const result = await catalogueAccess(r, models, new AbortController().signal, () => false, request);
  expect(accessFor(result, "router", "paid")?.state).toBe("unavailable");
  expect(accessFor(result, "router", "free")).toMatchObject({ state: "available", kind: "free" });
});

it("keeps an unloaded Hub model selectable without a direct provider request and hides missing credentials", async () => {
  const a = model("gpu", "https://hub.example/v1", "mesh"), b = model("no-key"), r = runtime([a, b], [a]);
  const request = vi.fn() as unknown as typeof fetch;
  const result = await catalogueAccess(r, [a, b], new AbortController().signal, p => p === "mesh", request);
  expect(accessFor(result, "mesh", "gpu")).toEqual({ state: "available", kind: "local" });
  expect(accessFor(result, "deepseek", "no-key")?.state).toBe("unavailable"); expect(request).not.toHaveBeenCalled(); expect(privateAuth).not.toHaveBeenCalled();
});

it("navigation reads a snapshot immediately while an API is slow; invalidation fences the late response and shutdown joins it", async () => {
  const m = model("flash"), r = runtime([m]); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  privateAuth.mockImplementation(async () => { await gate; return { baseURL: m.baseUrl, headers: {}, subscription: false }; });
  const changed = vi.fn(), request = vi.fn() as unknown as typeof fetch;
  const service = new CatalogueAccess(r, () => false, changed, true, request);
  const pending = service.refresh();
  expect(accessFor(service.snapshot(), "deepseek", "flash")?.state).toBe("unknown");
  service.invalidate(); release(); await pending; await service.close();
  expect(changed).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(accessFor(service.snapshot(), "deepseek", "flash")?.state).toBe("unknown");
});

it("does not confuse public names resembling LAN addresses with local inference", async () => {
  const { localApi } = await import("../src/models/access.ts");
  expect(localApi("https://10.example.org/v1")).toBe(false);
  expect(localApi("http://192.168.1.4/v1")).toBe(true);
  expect(localApi("http://[::1]:1234/v1")).toBe(true);
});
it("coalesces provider discovery and negative caching across a large unavailable catalogue", async () => {
  const models = Array.from({ length: 50 }, (_, i) => model(`cloud-${i}`)), r = runtime(models);
  privateAuth.mockImplementation(async () => ({ baseURL: models[0].baseUrl, headers: { Authorization: "Bearer fixture" }, subscription: false }));
  const request = vi.fn(async () => json({}, 401)) as unknown as typeof fetch;
  const result = await catalogueAccess(r, models, new AbortController().signal, () => false, request);
  expect([...result.values()].every(row => row.state === "unavailable")).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  await catalogueAccess(r, models, new AbortController().signal, () => false, request);
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([{ is_free_tier: true }, { expires_at: "2000-01-01T00:00:00Z" }, { limit_remaining: -1 }])("hides paid routes with an ineligible OpenRouter key: %j", async key => {
  const m = model("paid", "https://openrouter.ai/api/v1", "router"), r = runtime([m]);
  privateAuth.mockImplementation(async () => ({ baseURL: m.baseUrl, headers: { Authorization: "Bearer fixture" }, subscription: false }));
  const request = vi.fn(async (url: URL) => url.pathname.endsWith("/key") ? json({ data: key }) : json({ data: [{ id: "paid", pricing: { prompt: "1", completion: "1" } }] })) as unknown as typeof fetch;
  expect(accessFor(await catalogueAccess(r, [m], new AbortController().signal, () => false, request), "router", "paid")?.state).toBe("unavailable");
});
it("settled recovery observes the completed snapshot even when the startup event was missed", async () => {
  const m = model("flash"), r = runtime([m]);
  privateAuth.mockImplementation(async () => ({ baseURL: m.baseUrl, headers: {}, subscription: false }));
  const request = vi.fn(async (url: URL) => url.pathname === "/user/balance" ? json({ is_available: true }) : json({ data: [{ id: "flash" }] })) as unknown as typeof fetch;
  let service: CatalogueAccess;
  const changed = vi.fn(() => expect(service.checking).toBe(false));
  service = new CatalogueAccess(r, () => false, changed, true, request);
  void service.refresh(); await service.settled(new AbortController().signal);
  expect(accessFor(service.snapshot(), "deepseek", "flash")?.state).toBe("available");
  expect(changed).toHaveBeenCalledTimes(1); await service.close();
});
