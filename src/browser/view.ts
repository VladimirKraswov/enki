export interface BrowserFrame {
  browserOpen: boolean; busy: boolean; mode?: "fast" | "human";
  tabs: { id?: string; index: number; url: string; title: string; active: boolean }[];
  url?: string; title?: string; image?: string; width?: number; height?: number;
  pageId?: string; revision?: number;
  scope?: { directory: string; engine: string; sessionID: string } | null;
  scopeKey?: string;
  cursor?: { x: number; y: number; owner: "agent" | "user"; action: string; at: number } | null;
  /** A page that cannot paint or answer: a native dialog is open or its renderer crashed. */
  blocked?: { kind: "dialog" | "crash"; type?: string } | null;
  /** The daemon kept the last painted frame because the page did not answer in time. */
  stale?: boolean;
  staleReason?: string;
}
export function parseFrame(value: unknown): BrowserFrame {
  if (!value || typeof value !== "object") throw new Error("Некорректный кадр браузера.");
  const f = value as BrowserFrame;
  if (typeof f.browserOpen !== "boolean" || typeof f.busy !== "boolean" || !Array.isArray(f.tabs)
      || f.tabs.length > 128 || f.tabs.some(t => !t || !Number.isInteger(t.index) || t.index < 0 || t.index >= 128 || (t.id !== undefined && (typeof t.id !== "string" || !/^[0-9]{1,20}$/.test(t.id))) || typeof t.title !== "string" || typeof t.url !== "string" || typeof t.active !== "boolean")
      || new Set(f.tabs.map(t => t.index)).size !== f.tabs.length)
    throw new Error("Некорректные вкладки браузера.");
  const ids = f.tabs.flatMap(t => t.id ? [t.id] : []);
  if (new Set(ids).size !== ids.length) throw new Error("Повторяющиеся страницы браузера.");
  if (f.image !== undefined && (typeof f.image !== "string" || f.image.length > 8_000_000 || !/^[A-Za-z0-9+/=]+$/.test(f.image)
      || !Number.isFinite(f.width) || !Number.isFinite(f.height) || f.width! < 1 || f.width! > 1920 || f.height! < 1 || f.height! > 1200))
    throw new Error("Некорректное изображение браузера.");
  if (f.mode !== undefined && !["fast", "human"].includes(f.mode)) throw new Error("Некорректный режим браузера.");
  if (f.url !== undefined && typeof f.url !== "string") throw new Error("Некорректный адрес.");
  if (f.title !== undefined && typeof f.title !== "string") throw new Error("Некорректный заголовок.");
  if (f.scope != null && (typeof f.scope !== "object" || !["opencode", "pi"].includes(f.scope.engine)
      || typeof f.scope.directory !== "string" || typeof f.scope.sessionID !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(f.scope.sessionID))) throw new Error("Некорректная сессия браузера.");
  if (f.scopeKey !== undefined && (typeof f.scopeKey !== "string" || f.scopeKey.length > 10000)) throw new Error("Некорректная привязка браузера.");
  if (f.pageId !== undefined && (typeof f.pageId !== "string" || !Number.isSafeInteger(f.revision) || f.revision! < 0)) throw new Error("Некорректное состояние страницы.");
  if (f.cursor && (!Number.isFinite(f.cursor.x) || !Number.isFinite(f.cursor.y) || !["agent", "user"].includes(f.cursor.owner)))
    throw new Error("Некорректный курсор.");
  if (f.blocked != null && (typeof f.blocked !== "object" || !["dialog", "crash"].includes(f.blocked.kind)
      || (f.blocked.type !== undefined && typeof f.blocked.type !== "string"))) throw new Error("Некорректное состояние страницы.");
  if (f.stale !== undefined && typeof f.stale !== "boolean") throw new Error("Некорректный признак устаревшего кадра.");
  return f;
}
export function browserPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, frame: BrowserFrame) {
  if (!frame.width || !frame.height || rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) * frame.width / rect.width;
  const y = (clientY - rect.top) * frame.height / rect.height;
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height ? { x, y } : null;
}

/** Missing/foreign scope never renders a legacy shared browser in a chat. */
export function frameForSession(frame: BrowserFrame, engine: string, sessionID: string | null) {
  return !!sessionID && frame.scope?.engine === engine && frame.scope?.sessionID === sessionID;
}
