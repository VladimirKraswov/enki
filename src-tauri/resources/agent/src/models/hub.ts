// Whole-turn Hub reservations owned by the runtime.
//
// The Hub coordinates shared GPU models. A turn that uses a Hub-routed model
// must hold a ready lease for its exact target before the first token is sent,
// keep it renewed while the turn (including tool calls) runs, and release it
// when the session settles. A known Hub route never falls back to direct
// inference: if the Hub cannot confirm readiness, the turn is not dispatched.
// Ported from the former UI-owned coordinator; transport is the native broker.

import { randomUUID } from "node:crypto";
import type { Broker } from "../control/broker.ts";
import type { ModelRef } from "../protocol.ts";
import { text, type Database } from "../store/db.ts";

export interface HubRoute { service: string; label: string; providerID: string; modelID: string; agent: string; target: string }
/** A fresh catalog's exact equivalence, kept only for this transition. */
export interface HubModelAlias {
  from: ModelRef; model: ModelRef; scope: string; service: string; target: string;
  /** In-memory SDK availability predicate; never persisted or sent to Hub. */
  available(candidate: ModelRef): boolean;
}
export interface SwitchStatus {
  schema: 1; operation_id: string | null; phase: string; ready: boolean; active_model: string | null; target_model: string | null;
  elapsed_seconds: number; active_requests: number; error: string | null;
  loader: { phase: string; unit: "bytes" | null; current: number; total: number } | null;
  detail?: string;
}
interface Lease { ticket: string; owner: string; route: HubRoute; scope: string; since: number }

export function validRoute(value: unknown): value is HubRoute {
  if (!value || typeof value !== "object") return false;
  const r = value as HubRoute;
  return [r.service, r.label, r.providerID, r.modelID, r.target, r.agent].every((v) => typeof v === "string" && v.length > 0 && v.length <= 200);
}

export function validStatus(value: unknown): value is SwitchStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as SwitchStatus;
  const textOrNull = (v: unknown) => v === null || typeof v === "string";
  const counter = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return s.schema === 1 && typeof s.ready === "boolean" && typeof s.phase === "string" && textOrNull(s.operation_id)
    && textOrNull(s.active_model) && textOrNull(s.target_model) && textOrNull(s.error) && counter(s.elapsed_seconds)
    && counter(s.active_requests) && (s.loader === null || (!!s.loader && typeof s.loader.phase === "string" && counter(s.loader.current) && counter(s.loader.total)));
}

const RUNTIME_AGENT = "pi";
const READY_DEADLINE = 31 * 60_000;
/** A successful catalog read of the connected Hub answers "not Hub-owned" for this long. */
const DISCOVERY_TTL = 60_000;
const DISCOVERY_DEADLINE = 20_000;

/** Codes of the native broker's bounded failure envelope
 * `ENKI_HUB_ERROR:{"code","status"}` (src-tauri/src/hub/errors.rs). */
export type HubFailureCode = "lease_expired" | "timeout" | "network" | "tls" | "interrupted" | "http" | "transport";
const FAILURE_CODES: readonly HubFailureCode[] = ["lease_expired", "timeout", "network", "tls", "interrupted", "http", "transport"];
export interface HubFailure { code: HubFailureCode; status: number | null }

/** Only the bounded envelope is machine-readable; anything else is not guessed. */
export function hubFailure(error: unknown): HubFailure | null {
  if (error instanceof HubRequestError) return error.failure;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.length > 512 || !message.startsWith("ENKI_HUB_ERROR:")) return null;
  try {
    const parsed = JSON.parse(message.slice("ENKI_HUB_ERROR:".length)) as { code?: unknown; status?: unknown };
    const code = FAILURE_CODES.find((known) => known === parsed.code);
    if (!code) return null;
    const raw = parsed.status ?? null;
    let status: number | null = null;
    if (raw !== null) {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 100 || raw > 599) return null;
      status = raw;
    }
    return { code, status };
  } catch { return null; }
}

function failureText(failure: HubFailure): string {
  const { code, status } = failure;
  if (code === "lease_expired") return "Срок заявки на модель истёк. Требуется новая заявка Hub.";
  if (code === "timeout") return "Hub не ответил вовремя.";
  if (code === "network") return "Не удалось установить соединение с Hub. Проверьте сеть, доступность сервера и разрешение Enki на доступ к локальной сети.";
  if (code === "tls") return "Не удалось проверить TLS-сертификат Hub. Проверьте адрес, сертификат и дату на компьютере.";
  if (code === "interrupted") return "Соединение с Hub оборвалось при получении ответа.";
  if (code === "transport") return "Не удалось выполнить запрос к Hub. Проверьте настройки подключения.";
  if (status === 401) return "Hub отклонил ключ устройства. Проверьте ключ в настройках Hub.";
  if (status === 403) return "Hub запретил эту операцию. Проверьте права устройства.";
  if (status === 409) return "Заявка конфликтует с текущим состоянием Hub (HTTP 409).";
  if (status === 429) return "Hub ограничил частоту запросов. Повторите позже.";
  if (status !== null && status >= 500) return `Временная ошибка сервера Hub (HTTP ${status}).`;
  return `Hub отклонил запрос (HTTP ${status ?? "—"}).`;
}

/** A decoded Hub failure: readable Russian text, never the raw envelope. */
export class HubRequestError extends Error {
  constructor(readonly failure: HubFailure) {
    super(`${failureText(failure)} Запрос агенту не отправлен.`);
    this.name = "HubRequestError";
  }
}

/** The request may have reached the Hub without its answer reaching us (or the
 * Hub answered a transient failure). Only a retry with the SAME requestKey is
 * safe then: the Hub dedupes per (device, requestKey). A definite answer —
 * TLS, 4xx incl. a generic 409, an expired key — is never retried as is. */
function sameKeyRetryable(error: unknown): boolean {
  const failure = hubFailure(error);
  if (!failure) return true; // undecoded broker/transport failure (socket, broker timeout)
  if (failure.code === "network" || failure.code === "timeout" || failure.code === "interrupted" || failure.code === "transport") return true;
  return failure.code === "http" && failure.status !== null && (failure.status === 408 || failure.status === 429 || failure.status >= 500);
}
const expiredKey = (error: unknown): boolean => hubFailure(error)?.code === "lease_expired";

/** The Hub is connected but its catalog could not be read: ownership of the model is unknown. */
export class HubDiscoveryError extends Error {
  constructor(detail: string) {
    super(`Не удалось получить каталог моделей Hub (${detail.slice(0, 300)}). Неизвестно, управляет ли Hub этой моделью, поэтому запрос не отправлен напрямую. Повторите позже.`);
    this.name = "HubDiscoveryError";
  }
}

export class HubLeases {
  private routes: HubRoute[] = [];
  private scope: string | null = null;
  private leases = new Map<string, Lease>();
  private timer?: ReturnType<typeof setInterval>;
  private states = new Map<string, SwitchStatus>();
  private admission = true;
  private operations = 0;
  private renewing = false;
  /** Last authoritative catalog read in THIS process (scope null = Hub not connected). */
  private discovered: { at: number; scope: string | null } | null = null;
  private discovering?: Promise<void>;
  private readonly stopping = new AbortController();
  private discoverySignal(): AbortSignal { return AbortSignal.any([this.stopping.signal, AbortSignal.timeout(DISCOVERY_DEADLINE)]); }

  constructor(
    private readonly broker: Broker,
    private readonly db: Database,
    private readonly active: (owner: string) => boolean,
    private readonly onStatus: (owner: string, status: SwitchStatus) => void,
    /** A running owner's reservation was explicitly ended or replaced at the
     * Hub. It is NEVER silently re-prepared mid-turn; the owner stops the turn. */
    private readonly onLost: (owner: string, message: string) => void = () => {},
  ) {
    try {
      const stored: unknown = JSON.parse(text(db.get("SELECT value FROM meta WHERE key='hub_routes'"), "value") || "[]");
      if (Array.isArray(stored)) this.routes = stored.filter(validRoute);
    } catch { this.routes = []; }
    for (const row of db.all("SELECT body FROM hub_leases")) {
      try {
        const lease = JSON.parse(text(row, "body")) as Lease;
        if (validRoute(lease.route) && /^[a-f0-9-]{36}$/.test(lease.ticket) && typeof lease.owner === "string") this.leases.set(lease.owner, lease);
      } catch { /* A corrupt lease grants nothing; the Hub expires it. */ }
    }
  }

  /** A model the Hub has ever routed stays Hub-gated, even while the Hub is unreachable. */
  route(providerID: string, modelID: string): HubRoute | undefined {
    return this.routes.find((r) => r.providerID === providerID && r.modelID === modelID && r.agent === RUNTIME_AGENT)
      ?? this.routes.find((r) => r.providerID === providerID && r.modelID === modelID);
  }

  status(owner: string): SwitchStatus | undefined { return this.states.get(owner); }
  setAdmission(allowed: boolean): void { this.admission = allowed; }
  activeCount(): number { return this.operations; }
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (!this.admission) throw new Error("Enki Runtime готовится к обновлению; новая операция Hub не начата.");
    this.operations++;
    try { return await work(); } finally { this.operations--; }
  }

  private async request<T>(path: string, body: unknown, scope: string, signal?: AbortSignal): Promise<T> {
    try { return await this.broker.call<T>("hub.request", { path: `model-services/${path}`, body: body ?? null, scope }, signal, 60_000); }
    catch (error) {
      const failure = hubFailure(error);
      throw failure ? new HubRequestError(failure) : error;
    }
  }

  private aliasOpen(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.stopping.signal.throwIfAborted();
    if (!this.admission) throw new Error("Enki Runtime готовится к обновлению; смена модели не выполнена.");
  }

  private aliasError(): Error {
    return new Error("Сохранённая модель отсутствует в каталоге Pi, а Hub не подтвердил единственную эквивалентную модель в текущем подключении. Выберите доступную модель в этом чате; запрос не отправлен.");
  }

  private async aliasIdentity(signal: AbortSignal): Promise<{ scope: string | null }> {
    try { return await this.broker.call<{ scope: string | null }>("hub.identity", {}, signal); }
    catch { this.aliasOpen(signal); throw this.aliasError(); }
  }

  /** Never use merged/persisted routes as migration authority. Each lookup is
   * authenticated to one current Hub and fenced again after its catalog read. */
  private async aliasCatalog(signal: AbortSignal): Promise<{ scope: string; routes: HubRoute[] }> {
    this.aliasOpen(signal);
    if (!this.broker.available()) throw this.aliasError();
    const bounded = AbortSignal.any([signal, this.stopping.signal, AbortSignal.timeout(DISCOVERY_DEADLINE)]);
    const before = await this.aliasIdentity(bounded);
    this.aliasOpen(bounded);
    if (typeof before.scope !== "string" || !before.scope) throw this.aliasError();
    let catalog: { schema: number; routes: unknown[] };
    try { catalog = await this.request("catalog", undefined, before.scope, bounded); }
    catch (error) {
      this.aliasOpen(bounded);
      throw new HubDiscoveryError(error instanceof HubRequestError ? error.message : "актуальный каталог недоступен; проверьте подключение к Hub");
    }
    this.aliasOpen(bounded);
    if (catalog.schema !== 1 || !Array.isArray(catalog.routes) || !catalog.routes.every(validRoute)) throw this.aliasError();
    await this.aliasScope(before.scope, bounded);
    // Ownership remains fail-closed on later ordinary turns if Hub disconnects.
    // This cache is NEVER read by aliasChoice/aliasRoute as equivalence proof.
    this.rememberRoutes(catalog.routes);
    return { scope: before.scope, routes: catalog.routes };
  }

  private async aliasScope(scope: string, signal: AbortSignal): Promise<void> {
    this.aliasOpen(signal);
    const current = await this.aliasIdentity(signal);
    this.aliasOpen(signal);
    if (current.scope !== scope) throw new Error("Подключение к Hub изменилось во время выбора модели. Выберите модель заново; запрос не отправлен.");
  }

  /** Only a missing SDK choice may migrate, from one legacy OpenCode route to
   * ONE available Pi choice with the exact service AND target. No name/URL
   * heuristics, historical cache, default model or credential reuse. */
  async resolveMissing(model: ModelRef, available: (candidate: ModelRef) => boolean, signal: AbortSignal): Promise<HubModelAlias> {
    return this.operation(async () => {
      const fresh = await this.aliasCatalog(signal);
      const canonical = this.aliasChoice(fresh.routes, model, available);
      this.aliasOpen(signal);
      return { from: { providerID: model.providerID, modelID: model.modelID }, model: { providerID: canonical.providerID, modelID: canonical.modelID },
        scope: fresh.scope, service: canonical.service, target: canonical.target, available };
    });
  }

  private aliasChoice(routes: HubRoute[], model: ModelRef, available: (candidate: ModelRef) => boolean): HubRoute {
    const legacy = routes.filter(r => r.agent === "opencode" && r.providerID === model.providerID && r.modelID === model.modelID);
    if (legacy.length !== 1) throw this.aliasError();
    const source = legacy[0], choices = new Map<string, HubRoute>();
    for (const route of routes) {
      if (route.agent !== RUNTIME_AGENT || route.service !== source.service || route.target !== source.target) continue;
      const candidate = { providerID: route.providerID, modelID: route.modelID };
      if (available(candidate)) choices.set(JSON.stringify(candidate), route);
    }
    if (choices.size !== 1) throw this.aliasError();
    const canonical = [...choices.values()][0];
    if (routes.some(r => r.agent === RUNTIME_AGENT && r.providerID === canonical.providerID && r.modelID === canonical.modelID
      && (r.service !== source.service || r.target !== source.target))) throw this.aliasError();
    return canonical;
  }

  private async aliasRoute(alias: HubModelAlias, signal: AbortSignal): Promise<HubRoute> {
    const fresh = await this.aliasCatalog(signal);
    if (fresh.scope !== alias.scope) throw new Error("Подключение к Hub изменилось во время выбора модели. Выберите модель заново; запрос не отправлен.");
    const route = this.aliasChoice(fresh.routes, alias.from, alias.available);
    if (route.providerID !== alias.model.providerID || route.modelID !== alias.model.modelID || route.service !== alias.service || route.target !== alias.target) throw this.aliasError();
    return route;
  }

  /** Pure model.set/transition still revalidates alias provenance before select. */
  async checkAlias(alias: HubModelAlias, signal: AbortSignal): Promise<void> {
    return this.operation(async () => { await this.aliasRoute(alias, signal); });
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    return this.operation(() => this.refreshImpl(signal));
  }
  private async refreshImpl(signal?: AbortSignal): Promise<void> {
    const identity = await this.broker.call<{ scope: string | null }>("hub.identity", {}, signal);
    if (!identity.scope) { this.scope = null; this.discovered = { at: Date.now(), scope: null }; return; }
    if (identity.scope !== this.scope) { this.scope = identity.scope; }
    let catalog: { schema: number; routes: unknown[] };
    try { catalog = await this.request<{ schema: number; routes: unknown[] }>("catalog", undefined, identity.scope, signal); }
    catch (error) { throw new HubDiscoveryError(error instanceof Error ? error.message : String(error)); }
    if (catalog.schema !== 1 || !Array.isArray(catalog.routes) || !catalog.routes.every(validRoute)) throw new HubDiscoveryError("Hub вернул неподдерживаемый каталог сервисов");
    this.rememberRoutes(catalog.routes.filter(validRoute));
    this.discovered = { at: Date.now(), scope: identity.scope };
  }

  private rememberRoutes(fresh: HubRoute[]): void {
    // Keep previously known routes: their models stay gated even if removed later.
    const merged = [...this.routes.filter((old) => !fresh.some((r) => r.providerID === old.providerID && r.modelID === old.modelID && r.agent === old.agent)), ...fresh];
    this.routes = merged;
    this.db.run("INSERT INTO meta(key,value) VALUES('hub_routes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(merged));
  }

  /**
   * The direct-vs-Hub decision for one model, made only AFTER trusted
   * discovery. A known route is returned at once and stays fail-closed even
   * while the Hub is unreachable. An unknown model on a fresh runtime first
   * reads the connected Hub's catalog (bounded, shared by concurrent callers):
   * - Hub unavailable (no broker, no identity, identity call fails): genuine
   *   direct providers keep working;
   * - Hub connected but catalog unreadable: HubDiscoveryError — ownership is
   *   unknown, so nothing is sent directly;
   * - catalog read and the model absent: direct.
   * Ordinary callers pass no flag; tests do not need to pre-seed the cache.
   */
  async resolve(providerID: string, modelID: string, signal: AbortSignal): Promise<HubRoute | undefined> {
    const known = this.route(providerID, modelID);
    if (known) return known;
    if (!this.broker.available()) return undefined;
    if (this.discovered && Date.now() - this.discovered.at < DISCOVERY_TTL) return undefined;
    this.discovering ??= this.refresh(this.discoverySignal()).finally(() => { this.discovering = undefined; });
    const shared = this.discovering;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    });
    cancelled.catch(() => undefined);
    try { await Promise.race([shared, cancelled]); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof HubDiscoveryError) throw error;
      // The identity request itself failed: the Hub is not reachable at all.
    } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
    return this.route(providerID, modelID);
  }

  /** Background bootstrap at startup/reconnect; the dispatcher still awaits resolve(). */
  discover(): void {
    if (!this.broker.available() || !this.admission) return;
    this.discovered = null;
    this.discovering ??= this.refresh(this.discoverySignal()).finally(() => { this.discovering = undefined; });
    void this.discovering.catch(() => undefined);
  }

  /** Prepare and hold a "run" lease for `owner` (a session). Throws when not ready. */
  async ensureRun(providerID: string, modelID: string, owner: string, signal: AbortSignal, alias?: HubModelAlias): Promise<void> {
    return this.operation(() => this.ensureRunImpl(providerID, modelID, owner, signal, alias));
  }
  private async ensureRunImpl(providerID: string, modelID: string, owner: string, signal: AbortSignal, alias?: HubModelAlias): Promise<void> {
    if (!this.broker.available()) throw new Error("Модель управляется Hub, но Enki с доступом к Hub не подключён. Запрос не отправлен.");
    if (alias && (alias.model.providerID !== providerID || alias.model.modelID !== modelID)) throw this.aliasError();
    if (!alias) await this.refresh(signal).catch((error) => { if (!this.route(providerID, modelID)) throw error; });
    const route = alias ? await this.aliasRoute(alias, signal) : this.route(providerID, modelID);
    if (!route) throw new Error("Модель недоступна агенту в каталоге Hub.");
    const scope = alias?.scope ?? this.scope;
    if (!scope) throw new Error("Hub не подключён. Запрос не отправлен.");
    const existing = this.leases.get(owner);
    if (existing && existing.scope === scope && existing.route.target === route.target && existing.route.service === route.service) {
      // ensureRun runs inside the dispatcher's gate, before the SDK call: no
      // turn of this owner is using `existing` now (an inactive lease).
      let state: unknown = null;
      try { state = await this.request<SwitchStatus>("status", { ticket: existing.ticket }, scope, signal); }
      catch (error) {
        signal.throwIfAborted();
        // Only an EXPLICITLY expired ticket may be replaced. An unreachable Hub,
        // a generic 409 or any other failure proves nothing: keep the lease and
        // refuse — never start a second reservation on an unproven state.
        if (!expiredKey(error)) throw error;
        this.forget(owner);
      }
      if (state !== null) {
        if (validStatus(state) && state.ready && state.phase === "ready" && state.active_model === route.target && state.operation_id === existing.ticket) {
          if (alias) await this.aliasScope(alias.scope, signal);
          this.publish(owner, state);
          return;
        }
        // The Hub explicitly reports OUR ticket as not holding the target.
        await this.release(owner).catch(() => {});
      }
    } else if (existing) await this.release(owner).catch(() => {});
    // The Hub deduplicates reservations by (device, requestKey). A lost
    // acknowledgement is recovered by asking ONCE more with the SAME key: the
    // Hub answers with the same reservation, never a second one. Only an
    // explicitly expired key is refreshed, once, under a NEW key.
    let requestKey = randomUUID();
    const prepare = () => this.request<SwitchStatus>("prepare", { providerID, modelID, agent: route.agent, mode: "run", requestKey }, scope, signal);
    const sameKey = async (): Promise<SwitchStatus> => {
      try { return await prepare(); }
      catch (error) {
        signal.throwIfAborted();
        if (!sameKeyRetryable(error)) throw error;
        return await prepare();
      }
    };
    let state: SwitchStatus;
    try { state = await sameKey(); }
    catch (error) {
      signal.throwIfAborted();
      if (!expiredKey(error)) throw error;
      requestKey = randomUUID();
      state = await prepare();
    }
    if (!validStatus(state)) throw new Error("Hub вернул неподдерживаемый статус модели.");
    const ticket = state.operation_id;
    if (!ticket) throw new Error("Hub не выдал заявку на модель; запрос не отправлен.");
    const deadline = Date.now() + READY_DEADLINE;
    try {
      for (;;) {
        signal.throwIfAborted();
        this.publish(owner, state);
        if (state.operation_id !== ticket || state.target_model !== route.target) throw new Error("Hub изменил заявку; запрос агенту не отправлен.");
        if (state.error || state.phase === "failed") throw new Error(state.error || "Загрузка модели не удалась.");
        if (state.ready && state.phase === "ready" && state.active_model === route.target) break;
        if (Date.now() >= deadline) throw new Error("Истекло время ожидания модели; запрос сохранён и не отправлен.");
        await new Promise((resolve) => setTimeout(resolve, 800));
        signal.throwIfAborted();
        const next = await this.request<SwitchStatus>("status", { ticket }, scope, signal);
        if (!validStatus(next)) throw new Error("Hub вернул неподдерживаемый статус модели.");
        state = next;
      }
      if (alias) await this.aliasScope(alias.scope, signal);
    } catch (error) {
      await this.request("release", { ticket }, scope).catch(() => {});
      throw error;
    }
    const lease: Lease = { ticket, owner, route, scope, since: Date.now() };
    this.leases.set(owner, lease);
    this.db.run("INSERT INTO hub_leases(owner,body) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body", owner, JSON.stringify(lease));
  }

  async release(owner: string): Promise<void> {
    const lease = this.forget(owner);
    if (!lease) return;
    await this.request("release", { ticket: lease.ticket }, lease.scope);
  }

  /** Drop the local record only (the Hub already ended this ticket). */
  private forget(owner: string): Lease | undefined {
    const lease = this.leases.get(owner);
    if (!lease) return undefined;
    this.leases.delete(owner);
    this.db.run("DELETE FROM hub_leases WHERE owner=?", owner);
    return lease;
  }

  private publish(owner: string, state: SwitchStatus): void {
    this.states.set(owner, state);
    this.onStatus(owner, state);
  }

  /** Renew leases of running sessions; release those that settled. */
  start(): void {
    if (this.timer) return;
    this.discover();
    this.timer = setInterval(() => void this.renew(), 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopping.abort(new Error("Enki Runtime останавливается."));
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async renew(): Promise<void> {
    if (!this.admission || this.renewing) return;
    this.renewing = true;
    try { await this.operation(() => this.renewImpl()); }
    finally { this.renewing = false; }
  }
  private async renewImpl(): Promise<void> {
    for (const lease of [...this.leases.values()]) {
      if (!this.active(lease.owner)) { await this.release(lease.owner).catch(() => {}); continue; }
      if (!this.broker.available()) continue;
      let state: unknown = null, expired = false;
      try { state = await this.request<SwitchStatus>("status", { ticket: lease.ticket }, lease.scope); }
      catch (error) { expired = expiredKey(error); }
      if (this.leases.get(lease.owner) !== lease) continue;
      const valid = validStatus(state) ? state : null;
      if (valid) this.publish(lease.owner, valid);
      // Explicit proof only: the Hub ended this ticket, or reports another
      // ticket/model as active. An unreachable Hub or an unreadable answer
      // keeps the reservation (the turn's own requests fail if the Hub is gone).
      const replaced = valid !== null && (valid.operation_id !== lease.ticket || (valid.active_model !== null && valid.active_model !== lease.route.target));
      if (!expired && !replaced) continue;
      this.forget(lease.owner);
      try {
        this.onLost(lease.owner, "Hub завершил заявку на модель во время работы агента. Ход остановлен, чтобы не продолжить его на другой модели; заявка не заменялась автоматически. Повторите запрос.");
      } catch { /* The lost reservation is already recorded; never mask the loop. */ }
    }
  }
}
