import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { ModelInfoDTO } from "../protocol.ts";
import { catalogueRequest, type SdkModel, type SdkModelRuntime } from "../sdk/adapter.ts";

type Access = NonNullable<ModelInfoDTO["access"]>;
type Fetch = typeof fetch;
interface Entry { until: number; checkedAt: number; rows: Map<string, "paid" | "free">; account: boolean; allowFree: boolean }
const caches = new WeakMap<SdkModelRuntime, Map<string, Entry>>();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const modelKey = (p: string, m: string) => JSON.stringify([p, m]);

export function localApi(base: string): boolean {
  try {
    const u = new URL(base), h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return !u.username && !u.password && (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")
      || isIP(h) === 6 && (h === "::1" || /^(?:fc|fd|fe80:)/.test(h))
      || isIP(h) === 4 && /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(h));
  } catch { return false; }
}

/** Pricing must be declared by this authenticated discovery response. Missing
 * SDK prices, a zero placeholder or a free account's paid models prove nothing. */
export function declaredFree(row: Record<string, unknown>): boolean {
  const p = row.pricing;
  const zero = (v: unknown) => (typeof v === "number" || typeof v === "string" && v.trim() !== "") && Number(v) === 0;
  return object(p) && zero(p.prompt) && zero(p.completion) && Object.values(p).every(zero);
}

async function read(url: URL, headers: Record<string, string>, signal: AbortSignal, request: Fetch): Promise<unknown> {
  const response = await request(url, { method: "GET", headers, signal, redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`API HTTP ${response.status}`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Пустой ответ API");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 4 * 1024 * 1024) throw new Error("Каталог API слишком большой"); parts.push(next.value); }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

async function discover(base: string, api: string, headers: Record<string, string>, signal: AbortSignal, request: Fetch): Promise<Omit<Entry, "until">> {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Не подтверждён защищённый адрес API");
  const deepseek = url.origin === "https://api.deepseek.com";
  if (deepseek && !headers.Authorization && headers["x-api-key"]) headers = { ...headers, Authorization: `Bearer ${headers["x-api-key"]}` };
  const router = url.origin === "https://openrouter.ai" && url.pathname.replace(/\/+$/, "") === "/api/v1";
  const target = new URL(url);
  target.pathname = deepseek ? "/models" : `${url.pathname.replace(/\/+$/, "")}${api === "anthropic-messages" && !url.pathname.replace(/\/+$/, "").endsWith("/v1") ? "/v1" : ""}/models${router ? "/user" : ""}`;
  let account = true, allowFree = true;
  if (deepseek) {
    const balance = await read(new URL("/user/balance", url), headers, signal, request);
    account = object(balance) && balance.is_available === true;
  }
  if (router) {
    const key = await read(new URL("/api/v1/key", url), headers, signal, request);
    if (!object(key) || !object(key.data) || key.data.is_management_key === true) throw new Error("Ключ не предназначен для запросов модели");
    // Free and paid entitlement are distinct. A spent paid limit must not
    // turn paid models into free ones or erase genuine free routes.
    const remaining = key.data.limit_remaining;
    const expired = typeof key.data.expires_at === "string" && (!Number.isFinite(Date.parse(key.data.expires_at)) || Date.parse(key.data.expires_at) <= Date.now());
    allowFree = !expired && (remaining === null || remaining === undefined || Number.isFinite(Number(remaining)) && Number(remaining) >= 0);
    account = !expired && key.data.is_free_tier !== true && (remaining === null || remaining === undefined || Number.isFinite(Number(remaining)) && Number(remaining) > 0);
  }
  const raw = await read(target, headers, signal, request);
  const list = object(raw) ? (api === "google-generative-ai" ? raw.models : raw.data) : undefined;
  if (!Array.isArray(list) || list.length > 16000) throw new Error("Неизвестный формат каталога API");
  const rows = new Map<string, "paid" | "free">();
  for (const row of list) if (object(row)) {
    const id = api === "google-generative-ai" && typeof row.name === "string" ? row.name.replace(/^models\//, "") : row.id;
    if (typeof id === "string" && id.length <= 512) rows.set(id, declaredFree(row) ? "free" : "paid");
  }
  return { rows, account, allowFree, checkedAt: Date.now() };
}

/** Bounded read-only discovery. No completions, GPU loading, session creation,
 * key commands, redirects or credentials in DTOs/logs. Cache is per runtime and
 * exact request identity, so replacing a key cannot reuse old entitlement. */
export async function catalogueAccess(runtime: SdkModelRuntime, models: readonly SdkModel[], signal: AbortSignal,
  managed: (provider: string, model: string) => boolean, request: Fetch = fetch): Promise<Map<string, Access>> {
  let cache = caches.get(runtime); if (!cache) { cache = new Map(); caches.set(runtime, cache); }
  const available = new Set(runtime.getAvailableSnapshot().map(m => modelKey(m.provider, m.id)));
  const out = new Map<string, Access>(); let cursor = 0;
  const pending = new Map<string, Promise<Entry>>();
  const worker = async () => {
    for (;;) {
      const model = models[cursor++]; if (!model) return;
      const id = modelKey(model.provider, model.id);
      if (!available.has(id)) { out.set(id, { state: "unavailable", reason: "Нет настроенного доступа" }); continue; }
      if (managed(model.provider, model.id) || localApi(model.baseUrl)) { out.set(id, { state: "available", kind: "local" }); continue; }
      try {
        const privateRequest = await catalogueRequest(runtime, model, signal);
        signal.throwIfAborted();
        if (!privateRequest) { out.set(id, { state: "unknown", reason: "Проверьте доступ в настройках провайдера" }); continue; }
        const { baseURL, headers, subscription } = privateRequest;
        const key = createHash("sha256").update(JSON.stringify([model.provider, model.api, baseURL, headers])).digest("hex");
        let entry = cache!.get(key);
        if (!entry || entry.until <= Date.now()) {
          let job = pending.get(key);
          if (!job) {
            job = discover(baseURL, model.api, headers, AbortSignal.any([signal, AbortSignal.timeout(8000)]), request)
              .then(result => ({ ...result, until: Date.now() + 5 * 60_000 }))
              .catch(() => {
                signal.throwIfAborted();
                return { rows: new Map<string, "paid" | "free">(), account: false, allowFree: false, checkedAt: Date.now(), until: Date.now() + 60_000 };
              });
            pending.set(key, job);
          }
          entry = await job; signal.throwIfAborted();
          if (cache!.size >= 64) cache!.delete(cache!.keys().next().value!); cache!.set(key, entry);
        }
        const kind = entry.rows.get(model.id), usable = !!kind && (kind === "free" ? entry.allowFree : entry.account);
        out.set(id, { state: usable ? "available" : "unavailable", ...(kind ? { kind: subscription ? "subscription" : kind } : {}), checkedAt: entry.checkedAt, ...(!usable ? { reason: "API не подтвердил доступ к этой модели" } : {}) });
      } catch {
        signal.throwIfAborted();
        out.set(id, { state: "unavailable", reason: "Не удалось подтвердить доступ к API. Обновите список или проверьте настройки." });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

export function accessFor(access: Map<string, Access>, provider: string, model: string): Access | undefined { return access.get(modelKey(provider, model)); }

/** Owned by Runtime, including shutdown. GET /providers reads a memory snapshot;
 * slow providers never block navigation. One bounded background refresh publishes
 * a public notification, with a generation fence for key/config replacement. */
export class CatalogueAccess {
  private value = new Map<string, Access>();
  private lastAt = 0;
  private pending: Promise<void> | undefined;
  private jobs = new Set<Promise<void>>();
  private controller = new AbortController();
  private generation = 0;
  private stopped = false;
  constructor(private runtime: SdkModelRuntime, private managed: (p: string, m: string) => boolean,
    private changed: () => void, private allowNetwork: boolean, private request: Fetch = fetch) {}
  get checking(): boolean { return !!this.pending; }
  snapshot(): Map<string, Access> {
    const result = new Map<string, Access>();
    for (const model of this.runtime.getAvailableSnapshot()) {
      const key = modelKey(model.provider, model.id);
      const local = this.managed(model.provider, model.id) || localApi(model.baseUrl);
      result.set(key, local ? { state: "available", kind: "local" } : this.lastAt && Date.now() - this.lastAt < 5 * 60_000 ? this.value.get(key) ?? { state: "unknown" } : { state: "unknown" });
    }
    return result;
  }
  invalidate(): void {
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    this.pending = undefined; this.lastAt = 0; this.value.clear(); caches.delete(this.runtime);
  }
  refresh(force = false): Promise<void> {
    if (this.stopped || !this.allowNetwork) return Promise.resolve();
    if (force) this.invalidate();
    if (this.pending) return this.pending;
    if (Date.now() - this.lastAt < 5 * 60_000) return Promise.resolve();
    const generation = this.generation;
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    let notify = false;
    const work = catalogueAccess(this.runtime, this.runtime.getModels(), signal, this.managed, this.request).then(value => {
      if (generation !== this.generation || this.stopped) return;
      this.value = value; this.lastAt = Date.now(); notify = true;
    }).catch(() => { if (generation === this.generation && !this.stopped) { this.value.clear(); this.lastAt = Date.now(); notify = true; } }).finally(() => {
      this.jobs.delete(work); if (this.pending === work) this.pending = undefined;
      if (notify && generation === this.generation && !this.stopped) this.changed();
    });
    this.jobs.add(work); this.pending = work; return work;
  }
  cancel(): void { this.stopped = true; this.controller.abort(); }
  async settled(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (!this.pending) return;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
    try { await Promise.race([this.pending, cancelled]); signal.throwIfAborted(); }
    finally { signal.removeEventListener("abort", abort); }
  }
  async close(): Promise<void> { this.cancel(); await Promise.allSettled(this.jobs); }
}
