import { UiProtocolError, boundedText, byteLength, integer, record, scopeCopy, type UiScope } from "./protocol.ts";

export interface IndicatorState { frames?: string[]; intervalMs?: number }
export interface WidgetState { key: string; placement: "aboveEditor" | "belowEditor"; kind: "text" | "component"; lines?: string[] }
export interface PluginSurfaceSnapshot {
  revision: number;
  statuses: Record<string, string>;
  working: { message: string | null; visible: boolean; indicator: IndicatorState | null };
  hiddenThinkingLabel: string | null;
  title: string;
  toolsExpanded: boolean;
  themeName: string | null;
  widgets: WidgetState[];
}
export interface SurfaceStatePorts {
  /** Durable CAS. Throw before commit if stale; never silently accept a failed write. */
  commit(scope: UiScope, expectedRevision: number, snapshot: PluginSurfaceSnapshot): void;
  /** Applies semantic state to actual TUI/native renderers and publishes a projection. */
  project(scope: UiScope, snapshot: PluginSurfaceSnapshot): void;
  projectionFailure(scope: UiScope, error: unknown): void;
}
export function initialSurfaceState(): PluginSurfaceSnapshot {
  return { revision: 0, statuses: {}, working: { message: null, visible: true, indicator: null },
    hiddenThinkingLabel: null, title: "", toolsExpanded: false, themeName: null, widgets: [] };
}
function validIndicator(value: unknown): boolean {
  return value === null || (record(value)
    && (value.intervalMs === undefined || integer(value.intervalMs, 16, 60000))
    && (value.frames === undefined || (Array.isArray(value.frames) && value.frames.length <= 256
      && value.frames.every(frame => boundedText(frame, 1024)))));
}
export function validSurfaceState(v: unknown): v is PluginSurfaceSnapshot {
  return record(v) && integer(v.revision, 0) && record(v.statuses)
    && Object.entries(v.statuses).length <= 128
    && Object.entries(v.statuses).every(([key, text]) => boundedText(key, 2000, false) && boundedText(text, 16000))
    && record(v.working) && (v.working.message === null || boundedText(v.working.message, 16000))
    && typeof v.working.visible === "boolean" && validIndicator(v.working.indicator)
    && (v.hiddenThinkingLabel === null || boundedText(v.hiddenThinkingLabel, 2000))
    && boundedText(v.title, 2000) && !/[\x00-\x1f\x7f]/.test(v.title) && typeof v.toolsExpanded === "boolean"
    && (v.themeName === null || boundedText(v.themeName, 2000, false))
    && Array.isArray(v.widgets) && v.widgets.length <= 64
    && v.widgets.every(widget => record(widget) && boundedText(widget.key, 2000, false)
      && (widget.placement === "aboveEditor" || widget.placement === "belowEditor")
      && (widget.kind === "text" || widget.kind === "component")
      && (widget.kind === "component" ? widget.lines === undefined : Array.isArray(widget.lines)
        && widget.lines.every(line => boundedText(line, 16000))))
    && new Set(v.widgets.map(widget => record(widget) ? widget.key : undefined)).size === v.widgets.length
    && byteLength(JSON.stringify(v)) <= 1024 * 1024;
}

/** Persisted semantic UI state only. Component instances live in the worker host. */
export class PluginSurfaceState {
  private value: PluginSurfaceSnapshot;
  readonly scope: UiScope;
  constructor(scope: UiScope, snapshot: PluginSurfaceSnapshot, private readonly ports: SurfaceStatePorts) {
    this.scope = scopeCopy(scope);
    if (!validSurfaceState(snapshot)) throw new UiProtocolError("ui-state", "Состояние интерфейса расширения повреждено.");
    this.value = structuredClone(snapshot);
  }
  current(): PluginSurfaceSnapshot { return structuredClone(this.value); }
  setStatus(key: string, text: string | undefined): void {
    if (!boundedText(key, 2000, false)) throw new UiProtocolError("status-key", "Некорректный идентификатор статуса расширения.");
    this.update(next => { if (text === undefined) delete next.statuses[key]; else Object.defineProperty(next.statuses, key, { value: text, enumerable: true, configurable: true, writable: true }); });
  }
  setWorkingMessage(message: string | undefined): void { this.update(next => { next.working.message = message ?? null; }); }
  setWorkingVisible(visible: boolean): void { this.update(next => { next.working.visible = visible; }); }
  setWorkingIndicator(indicator: IndicatorState | undefined): void {
    this.update(next => { next.working.indicator = indicator === undefined ? null : structuredClone(indicator); });
  }
  setHiddenThinkingLabel(label: string | undefined): void { this.update(next => { next.hiddenThinkingLabel = label ?? null; }); }
  setTitle(title: string): void { this.update(next => { next.title = title; }); }
  setToolsExpanded(expanded: boolean): void { this.update(next => { next.toolsExpanded = expanded; }); }
  setThemeName(name: string | null): void { this.update(next => { next.themeName = name; }); }
  setWidget(widget: WidgetState): void {
    this.update(next => { next.widgets = [...next.widgets.filter(old => old.key !== widget.key), structuredClone(widget)]; });
  }
  clearWidget(key: string): void { this.update(next => { next.widgets = next.widgets.filter(widget => widget.key !== key); }); }
  private update(change: (next: PluginSurfaceSnapshot) => void): void {
    const next = this.current();
    change(next);
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    next.revision++;
    if (!validSurfaceState(next)) throw new UiProtocolError("ui-state-limit", "Состояние интерфейса превышает допустимый размер или содержит неверные параметры.");
    this.ports.commit(this.scope, this.value.revision, structuredClone(next));
    this.value = next;
    try { this.ports.project(this.scope, this.current()); }
    catch (error) { this.ports.projectionFailure(this.scope, error); }
  }
}
