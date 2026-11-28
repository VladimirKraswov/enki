/**
 * A window that renders nothing is unreportable: the person sees white, no text,
 * no button, nothing to retry. This guard turns that state into a visible,
 * actionable panel: any uncaught error or rejection while `#root` is still empty
 * (and a timeout with no error at all) is shown in place of the white window.
 *
 * It never invents a cause and never hides the app: as soon as React owns the
 * root the panel is removed.
 */
export const STARTUP_FAILURE_ID = "startup-failure";

/** After this long with an empty root and no error, the window is stuck, not slow. */
export const STARTUP_TIMEOUT_MS = 12_000;

const MAX_DETAIL = 600;

export function startupDetail(reason: unknown): string {
  if (reason instanceof Error) {
    const stack = reason.stack?.split("\n").slice(0, 4).join(" ← ") ?? "";
    return `${reason.name}: ${reason.message}${stack ? ` (${stack})` : ""}`.slice(0, MAX_DETAIL);
  }
  return String(reason ?? "").slice(0, MAX_DETAIL);
}

export function shouldReportBlankWindow(root: Element | null): boolean {
  return !!root && root.childElementCount === 0;
}

/** Renders the failure panel in place of the empty app root. Idempotent. */
export function showStartupFailure(doc: Document, detail: string): void {
  const root = doc.getElementById("root");
  if (!root || !shouldReportBlankWindow(root)) return;
  const existing = doc.getElementById(STARTUP_FAILURE_ID);
  const panel = existing ?? doc.createElement("div");
  panel.id = STARTUP_FAILURE_ID;
  panel.setAttribute("role", "alert");
  panel.style.cssText = "padding:32px;max-width:760px;margin:0 auto;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#ddd8cd;background:#1d1c19;min-height:100vh";
  panel.replaceChildren();
  const title = doc.createElement("h1");
  title.textContent = "Интерфейс Enki не запустился";
  title.style.cssText = "font-size:18px;margin:0 0 12px";
  const text = doc.createElement("p");
  text.textContent =
    "Окно открылось, но приложение не показало ни одного экрана. Ниже — ошибка, из-за которой это произошло; она не выдумана и не скрыта. Данные, чаты и настройки не пострадали.";
  const pre = doc.createElement("pre");
  pre.textContent = detail || "Ошибка не сообщена";
  pre.style.cssText = "white-space:pre-wrap;word-break:break-word;padding:12px;background:#262520;border:1px solid #3a3934;border-radius:8px;color:#e8b964";
  const retry = doc.createElement("button");
  retry.textContent = "Загрузить интерфейс заново";
  retry.style.cssText = "margin-top:16px;padding:8px 14px;border-radius:8px;border:1px solid #e2aa36;background:transparent;color:#e2aa36;font:inherit;cursor:pointer";
  retry.addEventListener("click", () => doc.defaultView?.location.reload());
  panel.append(title, text, pre, retry);
  if (!existing) {
    // Keep `#root`: React owns it, and the panel must be removable if the
    // interface eventually paints.
    doc.body.append(panel);
  }
}

/** An app that rendered after a transient error keeps its window. */
export function clearStartupFailure(doc: Document): void {
  const panel = doc.getElementById(STARTUP_FAILURE_ID);
  const root = doc.getElementById("root");
  if (panel && root && !shouldReportBlankWindow(root)) panel.remove();
}

export interface StartupGuard {
  /** Current panel detail, `null` when the interface is healthy. */
  detail(): string | null;
  dispose(): void;
}

/**
 * Watches the first seconds of the window. Every report is deferred so React has
 * a chance to mount: only an empty root is ever replaced.
 */
export function installStartupGuard(doc: Document, win: Window): StartupGuard {
  let firstError: string | null = null;
  let panelOpen = false;
  const errors: string[] = [];

  const maybeShow = () => {
    const root = doc.getElementById("root");
    if (!root) return;
    if (!shouldReportBlankWindow(root)) { clearStartupFailure(doc); panelOpen = false; return; }
    if (!firstError) return;
    showStartupFailure(doc, errors.join("\n"));
    panelOpen = true;
  };
  const record = (reason: unknown) => {
    const text = startupDetail(reason);
    if (!text) return;
    errors.push(text);
    firstError ??= text;
    setTimeout(maybeShow, 250);
  };
  const onError = (event: ErrorEvent) => record(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => record(event.reason);
  const onLoad = () => setTimeout(maybeShow, 0);

  win.addEventListener("error", onError, true);
  win.addEventListener("unhandledrejection", onRejection);
  win.addEventListener("load", onLoad);

  const timeout = setTimeout(() => {
    if (!shouldReportBlankWindow(doc.getElementById("root"))) return;
    errors.push("За отведённое время интерфейс не отрисовал ни одного элемента и не сообщил ошибку.");
    firstError ??= errors[0];
    maybeShow();
  }, STARTUP_TIMEOUT_MS);

  return {
    detail: () => (panelOpen ? errors.join("\n") : null),
    dispose() {
      clearTimeout(timeout);
      win.removeEventListener("error", onError, true);
      win.removeEventListener("unhandledrejection", onRejection);
      win.removeEventListener("load", onLoad);
    },
  };
}
