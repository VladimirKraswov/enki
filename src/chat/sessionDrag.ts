// Pointing-device drag for sidebar chats. HTML5 drag-and-drop is unreliable in
// the desktop webview (its `types` list may lack `.includes`, and dragging from
// inside a button may not start), so a chat is moved by tracking the pointer:
// no dataTransfer is involved and the composer never sees a drag.

/** Attribute on a drop area: a project directory, or `recent` for projectless. */
export const SESSION_DROP_ATTRIBUTE = "data-session-drop";

/** The drop area under an element, or null when the pointer is elsewhere. */
export function sessionDropTargetAt(element: Element | null | undefined): { directory: string | null } | null {
  const node = element?.closest?.(`[${SESSION_DROP_ATTRIBUTE}]`);
  if (!node) return null;
  const raw = node.getAttribute(SESSION_DROP_ATTRIBUTE) ?? "";
  return { directory: raw === "" || raw === "recent" ? null : raw };
}

export interface SessionDragOptions {
  /** Movement in CSS pixels before this becomes a drag instead of a click. */
  threshold?: number;
  /** Element under the pointer; injected for tests. */
  targetAt(x: number, y: number): Element | null;
  /** Called with the hovered drop area while dragging (null = none). */
  onHover(directory: string | null | undefined): void;
  /** Called once on release over a drop area. */
  onDrop(directory: string | null): void;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/**
 * Track one pointer gesture. Returns the cleanup function; it is safe to call
 * twice and never leaves global listeners behind. A gesture that stays inside
 * the threshold is a click and reports nothing.
 */
export function startSessionDrag(startX: number, startY: number, options: SessionDragOptions): () => void {
  const win = options.win ?? window;
  const threshold = options.threshold ?? 8;
  let active = false, finished = false;
  const hover = (event: { clientX: number; clientY: number }) => sessionDropTargetAt(options.targetAt(event.clientX, event.clientY));
  const move = (event: PointerEvent) => {
    if (finished) return;
    if (!active && Math.hypot(event.clientX - startX, event.clientY - startY) < threshold) return;
    if (!active) { active = true; document.body.dataset.sessionDragging = "true"; }
    event.preventDefault();
    const target = hover(event);
    // null means "dragging over empty space"; only cancel reports undefined.
    options.onHover(target ? target.directory : null);
  };
  const up = (event: PointerEvent) => {
    if (finished) return;
    const dragged = active;
    cleanup();
    if (!dragged) return;
    const target = hover(event);
    if (target) options.onDrop(target.directory);
  };
  const cancel = () => { if (!finished) { cleanup(); options.onHover(undefined); } };
  function cleanup() {
    if (finished) return;
    finished = true;
    delete document.body.dataset.sessionDragging;
    win.removeEventListener("pointermove", move as EventListener);
    win.removeEventListener("pointerup", up as EventListener);
    win.removeEventListener("pointercancel", cancel as EventListener);
  }
  win.addEventListener("pointermove", move as EventListener);
  win.addEventListener("pointerup", up as EventListener);
  win.addEventListener("pointercancel", cancel as EventListener);
  return cleanup;
}
