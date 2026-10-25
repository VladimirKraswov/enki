// Plugin UI transport: real SDK TUI surface (VT frames), shared editor draft CAS
// and controller leases over authenticated HTTP + SSE. No WebSocket, no token in
// URLs, no hidden terminal-only claim.
//
// Authority: a UI principal is `client:<sha256>` derived by the HTTP layer from
// the bearer plus a valid X-Enki-Client UUIDv4. `authority:` callers may read the
// ordinary API but are refused here. The authority registration is made BEFORE a
// worker is opened (session_start may await a custom UI) and is held until the
// SSE stream closes; it is released on every early failure too.
//
// Maintenance: `/ui/open` opens or adopts a worker and therefore is a mutation.
// `/ui/events`, the snapshot and resync only view an already-live surface and
// stay available while the runtime is fenced for an update.

import type { Runtime } from "../core/runtime.ts";
import type { DraftMutation } from "../plugin-ui/draft-cas.ts";
import { UiProtocolError, record as isRecord } from "../plugin-ui/protocol.ts";
import type { SessionUi } from "../plugin-ui/runtime.ts";
import { API_PREFIX, isReadOnlyOrigin } from "../protocol.ts";
import type { SessionRecord } from "../sessions/catalog.ts";
import { HttpError, openEventStream, STREAMING, withStatus, type Request, type Router } from "./http.ts";

const OPEN_DEADLINE_MS = 120_000;

function body(request: Request): Record<string, unknown> {
  if (request.body === undefined) return {};
  if (!isRecord(request.body)) throw new HttpError(400, "Ожидался объект.");
  return request.body;
}

export function addUiRoutes(router: Router, runtime: Runtime, scoped: (request: Request) => SessionRecord): void {
  const add = (method: string, route: string, handler: (request: Request) => unknown, mutation?: boolean) =>
    router.add(method, `${API_PREFIX}/sessions/:id/ui${route}`, handler, mutation === undefined ? {} : { mutation });

  const live = (id: string): SessionUi | null => {
    const worker = runtime.registry.live(id);
    if (!worker || worker.isClosed()) return null;
    try { return worker.ui(); } catch { return null; } // rebinding after reload
  };

  /** The registry publishes a staged worker before session_start; never wait on worker(id) alone. */
  const open = async (id: string, signal: AbortSignal): Promise<SessionUi> => {
    const existing = live(id);
    if (existing) return existing;
    const state: { failure: unknown; settled: boolean } = { failure: null, settled: false };
    // Deduplicated by the registry's opening map: reconnects never launch a second worker.
    runtime.registry.worker(id).then(() => { state.settled = true; }, (error: unknown) => { state.failure = error ?? new Error("open failed"); state.settled = true; });
    const until = Date.now() + OPEN_DEADLINE_MS;
    for (;;) {
      const surface = live(id);
      if (surface) return surface;
      if (state.failure) throw new HttpError(503, state.failure instanceof Error ? state.failure.message.slice(0, 500) : "Не удалось открыть сессию.");
      if (state.settled) throw new HttpError(503, "Интерфейс сессии переподключается. Повторите подключение.");
      if (signal.aborted) throw new HttpError(499, "Клиент отключился.");
      if (Date.now() > until) throw new HttpError(504, "Сессия не открылась вовремя. Повторите подключение.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  /** Explicit, scoped errors instead of message matching inside frozen internals. */
  const call = <T>(request: Request, action: (surface: SessionUi, principal: string) => T, mutation: boolean): T => {
    const current = scoped(request);
    if (!runtime.authorizeUi(request.principal, current.id, current.directory))
      throw new HttpError(403, "Интерфейс сессии не подключён этим окном. Переподключите его.");
    if (mutation && !runtime.admission.open()) throw new HttpError(503, "Интерфейс временно доступен только для просмотра: выполняется обслуживание.");
    const surface = live(current.id);
    if (!surface) throw new HttpError(404, "Интерфейс сессии не запущен.");
    try { return action(surface, request.principal); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message.slice(0, 500) : "Ошибка интерфейса.";
      if (error instanceof UiProtocolError) throw new HttpError(/conflict|cas|revision/.test(error.code) ? 409 : 400, message);
      throw new HttpError(409, message);
    }
  };

  const stream = async (request: Request, opening: boolean): Promise<typeof STREAMING> => {
    const current = scoped(request);
    if (isReadOnlyOrigin(current.origin)) throw new HttpError(409, "Архив доступен только для чтения. Сначала продолжите его.");
    if (opening && !live(current.id) && !runtime.admission.open())
      throw new HttpError(503, "Enki Runtime готовится к обновлению. Интерфейс откроется после обслуживания.");
    let release: () => void;
    try { release = runtime.attachUiAuthority(request.principal, current.id, current.directory); }
    catch (error) { throw new HttpError(403, error instanceof Error ? error.message : "Клиент интерфейса не подтверждён."); }
    let sse: ReturnType<typeof openEventStream> | null = null;
    try {
      const surface = opening ? await open(current.id, request.signal) : live(current.id);
      if (request.signal.aborted) throw new HttpError(499, "Клиент отключился.");
      const events = openEventStream(request, { maxBufferedBytes: 2 * 1024 * 1024, maxEventBytes: 512 * 1024 });
      sse = events;
      let seq = 0;
      const send = (data: Record<string, unknown>) => { if (!events.send(++seq, data)) events.close(); };
      events.onClose(release);
      if (surface) begin(surface, events, send);
      else {
        // Watching without opening: the authority is already registered, so a
        // worker started by a prompt/timer can show its startup UI to this view.
        send({ type: "ui.waiting" });
        const timer = setInterval(() => {
          const found = live(current.id);
          if (!found) return;
          clearInterval(timer);
          try { begin(found, events, send); } catch { events.close(); }
        }, 100);
        events.onClose(() => clearInterval(timer));
      }
      return STREAMING;
    } catch (error) {
      if (sse) sse.close(); else release();
      throw error;
    }

    function begin(surface: SessionUi, events: ReturnType<typeof openEventStream>, send: (data: Record<string, unknown>) => void): void {
      const attached = surface.attach(request.principal, {
        reset: attachment => send({ type: "ui.reset", attachment }),
        frame: frame => send({ type: "ui.vt", frame }),
        closed: reason => { send({ type: "ui.closed", reason }); events.close(); },
      });
      events.onClose(attached.detach);
      // Draft/state/notification projections of THIS session only (scope-fenced by the client).
      events.onClose(runtime.journal.subscribe({ sessionID: current.id, directory: current.directory }, envelope => {
        if (envelope.event.type.startsWith("extension.") || envelope.event.type.startsWith("dialog."))
          send({ type: "ui.event", seq: envelope.seq, event: envelope.event });
      }));
      send({ type: "ui.hello", instance: runtime.instance, snapshot: surface.snapshot(request.principal) });
      // Full redraw for the new view: streamEpoch advances, frames restart at seq 1.
      surface.resync(request.principal);
    }
  };

  add("GET", "/open", request => stream(request, true), true);
  add("GET", "/events", request => stream(request, false), false);
  add("GET", "", request => call(request, (surface, principal) => surface.snapshot(principal), false), false);
  add("POST", "/resync", request => call(request, (surface, principal) => { surface.resync(principal); }, false), false);
  add("POST", "/control", request => call(request, (surface, principal) => surface.control(principal), true));
  add("POST", "/release", request => call(request, (surface, principal) => { surface.release(principal); }, true));
  add("POST", "/input", request => call(request, (surface, principal) => surface.input(principal, request.body), true));
  add("POST", "/resize", request => call(request, (surface, principal) => { surface.resize(principal, request.body); }, true));
  add("POST", "/draft", request => {
    const b = body(request);
    const selection = isRecord(b.selection) && typeof b.selection.start === "number" && typeof b.selection.end === "number"
      ? { start: b.selection.start, end: b.selection.end } : undefined;
    if (typeof b.id !== "string" || typeof b.baseRevision !== "number" || typeof b.text !== "string") throw new HttpError(400, "Некорректное изменение черновика.");
    const mutation: DraftMutation = { id: b.id, baseRevision: b.baseRevision, origin: "user", text: b.text, ...(selection ? { selection } : {}) };
    try { return call(request, (surface, principal) => surface.replaceDraft(principal, mutation), true); }
    catch (error) {
      // Explicit conflict with the canonical draft, never a silent overwrite.
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      const surface = live(scoped(request).id);
      return withStatus(409, { code: "draft-conflict", message: error.message, draft: surface?.readDraft() ?? null });
    }
  });
  add("POST", "/retry-draft", request => call(request, (surface, principal) => { surface.retryDraft(principal); }, true));
  add("POST", "/retry-submission", request => call(request, (surface, principal) => { surface.retrySubmission(principal); }, true));
  add("POST", "/resolve-draft", request => {
    const b = body(request);
    const choice = b.kind === "discard" ? { kind: "discard" as const }
      : b.kind === "replace" && typeof b.id === "string" && typeof b.baseRevision === "number" && typeof b.text === "string"
        ? { kind: "replace" as const, id: b.id, baseRevision: b.baseRevision, text: b.text } : null;
    if (!choice) throw new HttpError(400, "Укажите решение для черновика.");
    return call(request, (surface, principal) => { surface.resolveDraft(principal, choice); }, true);
  });
}
