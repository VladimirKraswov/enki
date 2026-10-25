import { systemCredentials, type CredentialStore } from "./credentials";
import { ApiError, ConnectionError, isAllowedBaseUrl } from "../api/http";
import { publicSources, resolveService, type ModelSource } from "./routing";
import type { HubModelServices } from "./hub";

/** Minimal loopback JSON client for a model-control service (SSH-forwarded). */
class ServiceClient {
  headers: Record<string, string> = {};
  constructor(private readonly origin: string, private readonly timeoutMs: number) {}
  async request<T>(method: "GET" | "POST", path: string, opts: { body?: unknown } = {}): Promise<T> {
    if (!isAllowedBaseUrl(`${this.origin}/`)) throw new ConnectionError("Сервис модели должен быть loopback-адресом.");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.origin}${path}`, {
        method, signal: ctrl.signal, cache: "no-store",
        headers: { ...this.headers, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let detail = text.slice(0, 400);
        try { const parsed = JSON.parse(text) as { message?: unknown }; if (typeof parsed.message === "string") detail = parsed.message.slice(0, 400); } catch { /* plain */ }
        throw new ApiError(res.status, detail);
      }
      return await res.json() as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ConnectionError("Нет соединения с сервисом модели.");
    } finally { clearTimeout(timer); }
  }
}

/** Persisted routing contains no credential and no model-name heuristics. */
export interface ModelService {
  id: string;
  providerID: string;
  endpoint: string;
  bindings: Record<string, string>;
  /** Last-known display metadata only. Never evidence of access or readiness. */
  catalog?: { endpoint: string; models: ServiceModel[] };
}
export interface ServiceModel {
  id: string;
  label: string;
  agents: string[];
  context_window?: number;
}
export interface SwitchStatus {
  detail?: string;
  schema: 1;
  operation_id: string | null;
  phase: string;
  ready: boolean;
  active_model: string | null;
  target_model: string | null;
  elapsed_seconds: number;
  active_requests: number;
  error: string | null;
  loader: {
    phase: string;
    unit: "bytes" | null;
    current: number;
    total: number;
  } | null;
}
export interface ServiceSnapshot {
  revision: number;
  states: Record<string, SwitchStatus>;
  errors: Record<string, string>;
}
const EMPTY: ServiceSnapshot = { revision: 0, states: {}, errors: {} };

function validCatalog(models: unknown): models is ServiceModel[] {
  return Array.isArray(models) && models.every(m => m && typeof m.id === "string" && !!m.id &&
    typeof m.label === "string" && Array.isArray(m.agents) && m.agents.every((a: unknown) => typeof a === "string")) &&
    new Set(models.map(m => m.id)).size === models.length;
}
function displayMetadata(models: ServiceModel[]): ServiceModel[] {
  // Keep only the documented public fields, even if a server adds extra data.
  return models.map(m => ({ id: m.id, label: m.label, agents: [...m.agents],
    ...(Number.isSafeInteger(m.context_window) && m.context_window! > 0 ? { context_window: m.context_window } : {}) }));
}

export function validateServices(services: unknown): string | null {
  if (!Array.isArray(services)) return "Список сервисов повреждён.";
  const ids = new Set<string>(),
    bindings = new Set<string>();
  for (const service of services) {
    if (
      !service ||
      typeof service.id !== "string" ||
      typeof service.providerID !== "string" ||
      typeof service.endpoint !== "string" ||
      !service.bindings ||
      typeof service.bindings !== "object" ||
      Array.isArray(service.bindings)
    )
      return "Настройки сервиса повреждены.";
    if (!service.id.trim() || ids.has(service.id))
      return "У сервисов должны быть разные непустые имена.";
    ids.add(service.id);
    if (!isAllowedBaseUrl(service.endpoint))
      return "Укажите локальный HTTP-адрес SSH-туннеля без пути и учётных данных.";
    if (!service.providerID.trim() || !Object.keys(service.bindings).length)
      return "Укажите провайдера и соответствие моделей.";
    for (const [source, target] of Object.entries(service.bindings)) {
      if (!source.trim() || typeof target !== "string" || !target.trim())
        return "Идентификаторы моделей не могут быть пустыми.";
      const key = `${service.providerID}/${source}`;
      if (bindings.has(key))
        return "Модель может принадлежать только одному сервису.";
      bindings.add(key);
    }
  }
  return null;
}

export function validStatus(value: SwitchStatus): boolean {
  const textOrNull = (v: unknown) => v === null || typeof v === "string";
  const counter = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  return (
    !!value &&
    value.schema === 1 &&
    typeof value.ready === "boolean" &&
    typeof value.phase === "string" &&
    textOrNull(value.operation_id) &&
    textOrNull(value.active_model) &&
    textOrNull(value.target_model) &&
    textOrNull(value.error) &&
    counter(value.elapsed_seconds) &&
    counter(value.active_requests) &&
    (value.loader === null ||
      (!!value.loader &&
        typeof value.loader.phase === "string" &&
        (value.loader.unit === null || value.loader.unit === "bytes") &&
        counter(value.loader.current) &&
        counter(value.loader.total)))
  );
}

export class ModelServices {
  private services: ModelService[] = [];
  private sources = new Map<string, ModelSource[]>();
  private hub?: HubModelServices;
  private hubInitialization?: Promise<void>;
  waitForHub(ready: Promise<void>) {
    this.hubInitialization = ready;
    void ready.catch(() => {});
  }
  attachHub(hub: HubModelServices) {
    this.hub = hub;
    return hub.subscribe(() => this.emit());
  }
  hubRoutes() { return this.hub?.configuredRoutes() ?? []; }
  async refreshHub() { await this.hub?.refresh(); }
  private catalogs = new Map<string, ServiceModel[]>();
  private keys = new Map<string, string>();
  private flights = new Map<
    string,
    { model: string; promise: Promise<void> }
  >();
  private listeners = new Set<() => void>();
  private value = EMPTY;
  private generation = 0;
  private restored = new Map<string, Promise<void>>();
  private credentialRevision = 0;
  constructor(private credentials: CredentialStore = systemCredentials) {}
  private restore(service: ModelService): Promise<void> {
    if (this.keys.has(service.endpoint)) return Promise.resolve();
    let pending = this.restored.get(service.endpoint);
    if (!pending) {
      const gen = this.generation;
      const revision = this.credentialRevision;
      pending = this.credentials.get(service.endpoint).then((key) => {
        if (key && gen === this.generation && revision === this.credentialRevision && !this.keys.has(service.endpoint)) this.keys.set(service.endpoint, key);
      });
      this.restored.set(service.endpoint, pending);
    }
    return pending;
  }
  async saveKey(id: string, key: string): Promise<void> {
    const service = this.services.find((s) => s.id === id);
    if (!service) throw new Error("Сервис не настроен.");
    await this.credentials.set(service.endpoint, key.trim());
    this.setKey(id, key);
  }
  async forgetKey(id: string): Promise<void> {
    const service = this.services.find((s) => s.id === id);
    if (!service) return;
    await this.credentials.delete(service.endpoint);
    this.credentialRevision++;
    this.generation++;
    this.restored.clear();
    this.catalogs.clear();
    this.keys.delete(service.endpoint);
    this.restored.set(service.endpoint, Promise.resolve());
    for (const item of this.services.filter((s) => s.endpoint === service.endpoint)) this.catalogs.delete(item.id);
    this.emit();
  }
  snapshot = () => this.value;
  catalogFor(id: string): readonly ServiceModel[] | undefined {
    return this.catalogs.get(id);
  }
  configuredServices(): ModelService[] { return structuredClone(this.services); }
  setSources(agent: string, models: ModelSource[]): void {
    const next = publicSources(models);
    if (JSON.stringify(this.sources.get(agent)) === JSON.stringify(next)) return;
    this.sources.set(agent, next);
    this.emit();
  }
  private displayCatalog(service: ModelService): readonly ServiceModel[] | undefined {
    return this.catalogs.get(service.id) ?? service.catalog?.models;
  }
  /** Visibility and execution authorization intentionally have different lifetimes. */
  visible(providerID: string, modelID: string, agent: string): boolean {
    if (this.hub?.route(providerID, modelID)) return !!this.hub.route(providerID, modelID, agent);
    const service = this.route(providerID, modelID, agent);
    if (!service) return this.allowed(providerID, modelID, agent);
    const model = this.displayCatalog(service)?.find(m => m.id === service.bindings[modelID]);
    return model ? model.agents.includes(agent) : true;
  }
  configuredModels(agent: string): { providerID: string; modelID: string; label: string }[] {
    return this.services.flatMap(service => Object.entries(service.bindings)
      .filter(([id]) => this.visible(service.providerID, id, agent))
      .map(([id, remote]) => ({ providerID: service.providerID, modelID: id,
        label: this.displayCatalog(service)?.find(m => m.id === remote)?.label ?? id })));
  }
  /** A refresh reads catalogs only; it never loads a model or sends a prompt. */
  async refreshAll(): Promise<void> {
    const services = this.services.filter((s, i, all) => all.findIndex(a => a.endpoint === s.endpoint) === i);
    const results = await Promise.allSettled(services.map(s => this.refresh(s.id)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length) throw new Error(failures.map(r => r.reason instanceof Error ? r.reason.message : "Сервис недоступен.").join("\n"));
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(patch: Partial<ServiceSnapshot> = {}) {
    this.value = { ...this.value, ...patch, revision: this.value.revision + 1 };
    this.listeners.forEach((fn) => fn());
  }
  configure(services: ModelService[]) {
    const error = validateServices(services);
    if (error) throw new Error(error);
    this.generation++;
    this.flights.clear();
    this.services = structuredClone(services).map((service) => ({
      ...service,
      endpoint: new URL(service.endpoint).origin,
      catalog: service.catalog?.endpoint === new URL(service.endpoint).origin && validCatalog(service.catalog.models)
        ? { endpoint: service.catalog.endpoint, models: displayMetadata(service.catalog.models) } : undefined,
    }));
    this.catalogs.clear();
    this.restored.clear();
    for (const endpoint of this.keys.keys()) {
      if (!this.services.some((service) => service.endpoint === endpoint))
        this.keys.delete(endpoint);
    }
    this.emit({ states: {}, errors: {} });
    void this.refreshAll().catch(() => {});
  }
  setKey(id: string, key: string) {
    const service = this.services.find((s) => s.id === id);
    if (!service) throw new Error("Сервис не настроен.");
    this.keys.set(service.endpoint, key.trim());
    for (const item of this.services.filter(
      (s) => s.endpoint === service.endpoint,
    ))
      this.catalogs.delete(item.id);
    this.emit();
  }
  private client(service: ModelService) {
    const client = new ServiceClient(service.endpoint, 5000);
    const key = this.keys.get(service.endpoint);
    if (key) client.headers = { Authorization: `Bearer ${key}` };
    return client;
  }
  private route(providerID: string, modelID: string, agent?: string) {
    return resolveService(this.services, this.sources, providerID, modelID, agent).service;
  }
  statusFor(providerID: string, modelID: string, context?: string, agent?: string) {
    if (this.hub?.route(providerID, modelID)) return this.hub.status(providerID, modelID, context, agent);
    const service = this.route(providerID, modelID);
    return service ? this.value.states[service.id] : undefined;
  }
  errorFor(providerID: string, modelID: string, context?: string, agent?: string) {
    if (this.hub?.route(providerID, modelID)) return this.hub.status(providerID, modelID, context, agent)?.error;
    const service = this.route(providerID, modelID);
    return service ? this.value.errors[service.id] : undefined;
  }
  /** Hub-coordinated model: the runtime must hold a whole-turn Hub lease to run it. */
  hubManaged(providerID: string, modelID: string): boolean {
    return !!this.hub?.route(providerID, modelID);
  }
  manages(providerID: string, modelID: string): boolean {
    if (this.hub?.route(providerID, modelID)) return true;
    const route = resolveService(this.services, this.sources, providerID, modelID);
    return !!route.service || !!route.error;
  }
  allowed(providerID: string, modelID: string, agent: string): boolean {
    if (this.hub?.route(providerID, modelID)) return !!this.hub.route(providerID, modelID, agent);
    const resolved = resolveService(this.services, this.sources, providerID, modelID, agent);
    if (resolved.error) return false;
    const service = resolved.service;
    if (!service) {
      const providerServices = this.services.filter((s) => s.providerID === providerID);
      if (!providerServices.length) return true;
      // Discovery can expose extra IDs from a provider. Registered service models
      // need an explicit routing binding, even when the public ID happens to match.
      if (providerServices.some((s) => !this.catalogs.has(s.id))) return false;
      if (providerServices.some((s) => this.catalogs.get(s.id)?.some((m) => m.id === modelID))) return false;
      return true;
    }
    return (
      this.catalogs
        .get(service.id)
        ?.find((m) => m.id === service.bindings[modelID])
        ?.agents.includes(agent) ?? false
    );
  }
  async refresh(id: string): Promise<ServiceModel[]> {
    const service = this.services.find((s) => s.id === id);
    if (!service) throw new Error("Сервис не настроен.");
    const gen = this.generation;
    try {
      // Browser tests and unmanaged clients have no native vault overhead.
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window || this.credentials !== systemCredentials) await this.restore(service);
      if (gen !== this.generation) return [];
      const catalog = await this.client(service).request<{
        schema: number;
        models: ServiceModel[];
      }>("GET", "/v1/model-control/catalog");
      if (
        catalog.schema !== 1 ||
        !validCatalog(catalog.models)
      )
        throw new Error("Неподдерживаемый каталог сервиса.");
      if (gen !== this.generation) return [];
      for (const item of this.services.filter(
        (s) => s.endpoint === service.endpoint,
      )) {
        this.catalogs.set(item.id, displayMetadata(catalog.models));
        item.catalog = { endpoint: service.endpoint, models: displayMetadata(catalog.models) };
      }
      const errors = { ...this.value.errors };
      for (const item of this.services.filter((s) => s.endpoint === service.endpoint)) delete errors[item.id];
      this.emit({ errors });
      return catalog.models;
    } catch (error) {
      if (gen === this.generation) {
        const errors = { ...this.value.errors };
        for (const item of this.services.filter(s => s.endpoint === service.endpoint))
          errors[item.id] = error instanceof Error ? error.message : "Сервис недоступен.";
        this.emit({ errors });
      }
      throw error;
    }
  }
  /** Observe readiness only: no select, load, inference or retry of a user prompt. */
  async check(providerID: string, modelID: string, agent: string): Promise<void> {
    if (this.hub?.route(providerID, modelID)) return this.hub.check(providerID, modelID, agent);
    const service = this.route(providerID, modelID, agent);
    if (!service) throw new Error("Сервис модели не настроен.");
    const gen = this.generation;
    let serviceFailure = true;
    const current = () => {
      if (gen !== this.generation) throw new Error("Настройки сервиса изменились; повторите проверку.");
    };
    try {
      // Fresh catalog verifies policy after a reconnect; cached labels cannot grant access.
      await this.refresh(service.id); current();
      if (!this.allowed(providerID, modelID, agent)) {
        serviceFailure = false;
        throw new Error("Эта модель недоступна выбранному агенту.");
      }
      const state = await this.client(service).request<SwitchStatus>("GET", "/v1/model-control/status");
      current();
      if (!validStatus(state)) throw new Error("Неподдерживаемое состояние сервиса.");
      this.emit({ states: { ...this.value.states, ...Object.fromEntries(this.services
        .filter(s => s.endpoint === service.endpoint).map(s => [s.id, state])) } });
      if (state.error || state.phase === "failed") throw new Error("Сервис сообщил об ошибке загрузки модели.");
      if (!state.ready || state.phase !== "ready" || state.active_model !== service.bindings[modelID]) {
        serviceFailure = false;
        throw new Error("Сервис доступен, но эта модель сейчас не готова.");
      }
    } catch (error) {
      const failure = error instanceof ConnectionError
        ? new Error("Нет соединения с сервисом модели. Проверьте SSH-туннель.")
        : error instanceof ApiError ? new Error(error.status === 401 || error.status === 403
          ? "Нет доступа к сервису модели. Проверьте ключ в настройках."
          : `Сервис модели вернул HTTP ${error.status}.`) : error;
      if (gen === this.generation && serviceFailure) {
        const errors = { ...this.value.errors };
        for (const item of this.services.filter(s => s.endpoint === service.endpoint))
          errors[item.id] = failure instanceof Error ? failure.message : "Проверка не удалась.";
        this.emit({ errors });
      }
      throw failure;
    }
  }
  /**
   * Local (non-Hub) model service only, right before an actual send to it.
   * Hub-coordinated models are never leased here: the Enki Runtime discovers
   * Hub routes and holds the whole-turn lease itself (no UI execution lease).
   */
  /** Readiness of a local model service; a Hub-routed model is the runtime's (no UI lease). */
  ensure(providerID: string, modelID: string, agent: string, options?: {signal?: AbortSignal}): Promise<void> {
    return this.ensureLocal(providerID, modelID, agent, options);
  }
  async ensureLocal(providerID: string, modelID: string, agent: string, options?: {signal?: AbortSignal}): Promise<void> {
    await this.hubInitialization;
    options?.signal?.throwIfAborted();
    if (this.hub?.route(providerID, modelID)) return;
    return this.ensureService(providerID, modelID, agent);
  }

  private async ensureService(providerID: string, modelID: string, agent: string): Promise<void> {
    const resolved = resolveService(this.services, this.sources, providerID, modelID, agent);
    if (resolved.error) throw new Error(resolved.error);
    const service = resolved.service;
    if (!service) {
      if (!this.allowed(providerID, modelID, agent)) throw new Error("Для этой модели требуется привязка к сервису и проверка агента.");
      return;
    }
    const gen = this.generation;
    const target = service.bindings[modelID],
      flight = this.flights.get(service.endpoint);
    if (flight) {
      if (flight.model === target) {
        await flight.promise;
        if (!this.allowed(providerID, modelID, agent)) throw new Error("Эта модель недоступна выбранному агенту.");
        return;
      }
      // Wait behind a local switch instead of sending a premature inference or
      // issuing a competing select. A failed first switch does not authorize us.
      await flight.promise.catch(() => {});
      if (gen !== this.generation) throw new Error("Настройки сервиса изменились; отправка отменена.");
      return this.ensureService(providerID, modelID, agent);
    }
    const promise = this.prepare(service, modelID, target, agent, gen);
    this.flights.set(service.endpoint, { model: target, promise });
    try {
      await promise;
    } finally {
      if (this.flights.get(service.endpoint)?.promise === promise)
        this.flights.delete(service.endpoint);
    }
  }
  private publish(service: ModelService, state: SwitchStatus) {
    this.emit({ states: { ...this.value.states, ...Object.fromEntries(this.services
      .filter(s => s.endpoint === service.endpoint).map(s => [s.id, state])) } });
  }
  private async prepare(service: ModelService, modelID: string, target: string, agent: string, gen: number) {
    const started = Date.now();
    const errors = { ...this.value.errors };
    for (const item of this.services.filter(s => s.endpoint === service.endpoint)) delete errors[item.id];
    this.emit({ errors });
    this.publish(service, { schema: 1, operation_id: null, phase: "checking", ready: false,
      active_model: null, target_model: target, elapsed_seconds: 0, active_requests: 0, error: null, loader: null });
    const current = () => {
      const route = this.route(service.providerID, modelID, agent);
      if (gen !== this.generation || route?.endpoint !== service.endpoint || route.bindings[modelID] !== target)
        throw new Error("Настройки сервиса изменились; отправка отменена.");
    };
    try {
      // Cached labels never grant permission, including newly discovered aliases.
      await this.refresh(service.id);
      current();
      if (!this.allowed(service.providerID, modelID, agent)) throw new Error("Эта модель недоступна выбранному агенту.");
      await this.switch(service, target, agent, current);
    } catch (error) {
      if (gen === this.generation) {
        const detail = error instanceof ApiError ? (error.status === 401 || error.status === 403
          ? "Нет доступа к сервису модели. Проверьте ключ в настройках." : `Сервис модели вернул HTTP ${error.status}.`)
          : error instanceof ConnectionError ? "Нет соединения с сервисом модели. Проверьте SSH-туннель."
          : error instanceof Error ? error.message : "Не удалось подготовить модель.";
        this.publish(service, { schema: 1, operation_id: null, phase: "failed", ready: false,
          active_model: null, target_model: target, elapsed_seconds: (Date.now() - started) / 1000,
          active_requests: 0, error: detail, loader: null });
        throw new Error(detail);
      }
      throw error;
    }
  }
  private async switch(
    service: ModelService,
    model: string,
    agent: string,
    current: () => void,
  ): Promise<void> {
    const client = this.client(service),
      gen = this.generation;
    const errors = { ...this.value.errors };
    for (const item of this.services.filter((s) => s.endpoint === service.endpoint)) delete errors[item.id];
    this.emit({ errors });
    const publish = (state: SwitchStatus) => {
      current();
      if (gen !== this.generation)
        throw new Error("Настройки сервиса изменились; отправка отменена.");
      if (!validStatus(state))
        throw new Error("Неподдерживаемое состояние сервиса.");
      this.emit({
        states: {
          ...this.value.states,
          ...Object.fromEntries(
            this.services
              .filter((s) => s.endpoint === service.endpoint)
              .map((s) => [s.id, state]),
          ),
        },
      });
    };
    try {
      let state = await client.request<SwitchStatus>(
        "POST",
        "/v1/model-control/select",
        { body: { model, agent } },
      );
      const operation = state.operation_id,
        deadline = Date.now() + 31 * 60_000;
      for (;;) {
        publish(state);
        if (state.error || state.phase === "failed")
          throw new Error(state.error || "Загрузка модели не удалась.");
        if (state.ready && state.phase === "ready" && state.active_model === model) return;
        if (state.operation_id !== operation || state.target_model !== model)
          throw new Error(
            "Модель переключена другим клиентом; запрос не отправлен.",
          );
        if (Date.now() >= deadline)
          throw new Error(
            "Время ожидания истекло. Проверьте сервис; черновик сохранён.",
          );
        await new Promise((resolve) => setTimeout(resolve, 800));
        state = await client.request<SwitchStatus>(
          "GET",
          "/v1/model-control/status",
        );
      }
    } catch (error) {
      if (gen === this.generation)
        this.emit({
          errors: {
            ...this.value.errors,
            [service.id]:
              error instanceof Error
                ? error.message
                : "Не удалось переключить модель.",
          },
        });
      throw error;
    }
  }
}
export const modelServices = new ModelServices();
export const isSwitching = (state?: {phase: string; ready: boolean}) => !!state && !state.ready &&
  ["reconnecting", "checking", "waiting", "draining", "unloading", "loading", "warming"].includes(state.phase);
export const switchPhaseLabels: Record<string, string> = {
  reconnecting: "Восстанавливаем связь с Hub",
  checking: "Проверка сервиса модели",
  waiting: "Ожидание модели: сервис занят другим заданием",
  cancelled: "Подготовка модели отменена",
  unloaded: "Модель выгружена",
  draining: "Ожидание завершения запросов",
  unloading: "Выгрузка модели",
  loading: "Загрузка модели",
  warming: "Прогрев модели",
  ready: "Модель готова",
  failed: "Ошибка загрузки",
};
