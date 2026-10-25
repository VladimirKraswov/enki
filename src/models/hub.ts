import {retryHub} from '../hub/retry';
import { capabilityNative } from "../capabilities/integration";
import { hubOrigin } from "../hub/identity";
import { validStatus, type SwitchStatus } from "./services";

export interface HubRoute { service: string; label: string; providerID: string; modelID: string; agent: string; target: string }
export interface ModelHubTransport {
  identity(): Promise<string | null>;
  request<T>(path: string, body: unknown | undefined, scope: string): Promise<T>;
}
const nativeTransport: ModelHubTransport = {
  async identity() {
    const config = await capabilityNative<{enabled: boolean; endpoint: string; certificate: string}>("hub_config", {config: null, key: null, expected: null});
    return config.enabled && config.endpoint ? hubOrigin(config) : null;
  },
  request: (path, body, scope) => capabilityNative("hub_request", {path: `model-services/${path}`, body: body ?? null, expected: scope}),
};
const CACHE = "arvela.model-coordinator.v1";

/**
 * Display + explicit probes of the Hub model catalog. The Enki Runtime owns
 * Hub readiness and the WHOLE-TURN reservation (runtime models/hub.ts); the
 * window never prepares, renews or releases a lease. Reservations an older
 * window cached in localStorage are ignored (the Hub expires them) and never
 * start native control just because the UI loaded.
 */
export class HubModelServices {
  private recoveries = new Map<symbol, string>();
  private routes: HubRoute[] = [];
  private knownRoutes: HubRoute[] = [];
  private scope = "";
  private states = new Map<string, SwitchStatus>();
  private listeners = new Set<() => void>();
  private refreshing?: Promise<void>;
  private generation = 0;
  private enabled = false;
  constructor(private transport: ModelHubTransport = nativeTransport) {}
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach(fn => fn()); }
  configuredRoutes(): readonly HubRoute[] { return this.routes; }
  configured() { return this.enabled; }
  connectionChanged() { this.generation++; this.refreshing = undefined; this.recoveries.clear(); }
  /** A model the Hub has ever routed stays Hub-owned for display (never "direct"). */
  route(providerID: string, modelID: string, agent?: string) {
    return [...this.routes, ...this.knownRoutes].find(r => r.providerID === providerID && r.modelID === modelID && (!agent || r.agent === agent));
  }
  status(providerID: string, modelID: string, context?: string, agent?: string) {
    const route = this.route(providerID, modelID, agent);
    if (!route) return;
    const state = this.states.get(this.stateKey(route, context));
    const notices = [...this.recoveries.values()];
    const detail = notices[notices.length - 1];
    return detail ? {schema: 1 as const, operation_id: null, active_model: null, target_model: route.target,
      elapsed_seconds: 0, active_requests: 0, loader: null, error: null, ...state, phase: 'reconnecting', ready: false, detail} : state;
  }
  private async request<T>(path: 'catalog', body: unknown, scope: string): Promise<T> {
    const generation = this.generation, token = Symbol();
    const current = () => {
      if (generation !== this.generation || scope !== this.scope) throw new Error('Подключение Hub изменилось; повтор отменён.');
    };
    try {
      return await retryHub(() => this.transport.request<T>(path, body, scope), {
        safe: true, current,
        onRetry: (attempt,total) => { this.recoveries.set(token, `Восстанавливаем связь с Hub: попытка ${attempt} из ${total}.`); this.emit(); },
      });
    } finally { if (this.recoveries.delete(token)) this.emit(); }
  }
  private stateKey(route: HubRoute, context?: string) { return JSON.stringify([route.agent, route.providerID, route.modelID, context ?? "@selection"]); }
  private publish(route: HubRoute, value: SwitchStatus, context?: string) {
    if (!validStatus(value)) throw new Error("Hub вернул неподдерживаемый статус модели.");
    this.states.set(this.stateKey(route, context), value); this.emit();
  }
  private save() {
    try { localStorage.setItem(CACHE, JSON.stringify({scope: this.scope, routes: this.knownRoutes})); }
    catch { /* The cache only speeds up display; the runtime keeps its own routes. */ }
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const task = this.load(); this.refreshing = task;
    void task.finally(() => { if (this.refreshing === task) this.refreshing = undefined; }).catch(() => {});
    return task;
  }
  private async load() {
    const generation = this.generation;
    const scope = await this.transport.identity();
    if (generation !== this.generation) throw new Error("Подключение Hub изменилось.");
    this.enabled = !!scope;
    if (!scope) throw new Error("Подключите Hub для переключения этой модели.");
    if (scope !== this.scope) {
      this.scope = scope; this.routes = []; this.knownRoutes = []; this.states.clear();
      try {
        // Routes only. Cached leases/pending keys of older windows are ignored.
        const cache = JSON.parse(localStorage.getItem(CACHE) || "null");
        if (cache?.scope === scope && Array.isArray(cache.routes)) {
          this.routes = cache.routes.filter(validRoute);
          this.knownRoutes = this.routes;
        }
      } catch { /* Corrupt cache grants nothing; the fresh Hub catalog is required. */ }
    }
    const catalog = await this.request<{schema: number; routes: HubRoute[]}>("catalog", undefined, scope);
    if (catalog.schema !== 1 || !Array.isArray(catalog.routes) || !catalog.routes.every(validRoute))
      throw new Error("Hub вернул неподдерживаемый каталог сервисов.");
    if (this.scope !== scope || generation !== this.generation) throw new Error("Подключение Hub изменилось.");
    this.knownRoutes = [...this.knownRoutes.filter(old => !catalog.routes.some(r => r.providerID === old.providerID && r.modelID === old.modelID && r.agent === old.agent)), ...catalog.routes];
    this.routes = catalog.routes; this.save(); this.emit();
  }
  /** Reads the catalog once; there is no renewal timer (the runtime holds leases). */
  start() { void this.refresh().catch(() => {}); }
  dispose() { /* Nothing periodic to stop. */ }
  /** Explicit, read-only readiness probe of one routed model ("inspect" never reserves). */
  async check(providerID: string, modelID: string, agent: string) {
    await this.refresh();
    const route = this.route(providerID, modelID, agent);
    if (!route) throw new Error("У модели нет привязки к Hub.");
    const state = await this.transport.request<SwitchStatus>("inspect", {providerID, modelID, agent}, this.scope);
    this.publish(route, state);
    // A failed loader is terminal for this probe and is reported as such
    // (never as "not ready yet"); the check does not retry or select.
    if (state.error || state.phase === "failed")
      throw new Error(state.error ? `Hub сообщил об ошибке загрузки модели: ${state.error.slice(0, 300)}` : "Hub сообщил об ошибке загрузки модели.");
    if (!state.ready || state.phase !== "ready" || state.active_model !== route.target)
      throw new Error("Сервис доступен, но эта модель сейчас не готова.");
  }
}
function validRoute(value: unknown): value is HubRoute {
  if (!value || typeof value !== "object") return false;
  const r = value as HubRoute;
  return [r.service, r.label, r.providerID, r.modelID, r.target].every(v => typeof v === "string" && v.length > 0 && v.length <= 200)
    && (r.agent === "opencode" || r.agent === "pi");
}
