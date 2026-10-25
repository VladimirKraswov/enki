import type { ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import { Container, Loader, ScrollView, Text, TuiAltScreen, VStack, setKeybindings,
  type Component, type OverlayHandle, type OverlayOptions, type TuiAltScreenOptions } from "@earendil-works/pi-tui";
import type { ComponentUiPort, CustomFactory, CustomOptions, WidgetFactory } from "./sdk-ports.ts";
import { PluginSurfaceState, type PluginSurfaceSnapshot } from "./surface-state.ts";
import { EnkiVirtualTerminal } from "./virtual-terminal.ts";
import type { EditorDraftCas } from "./draft-cas.ts";
import { boundedText, UiProtocolError } from "./protocol.ts";
import { ComponentLifetimes, GuardedComponent, requireComponent, type DisposableComponent } from "./component-lifetime.ts";
import { WorkerEditorHost } from "./editor-host.ts";
import { asError, UiInteractionCancelled, type BaselineComponents, type EditorHostPorts,
  type EditorResources, type FooterData, type NativeUiHostPorts, type RuntimeUiCompatibility } from "./host-ports.ts";

type HeaderFactory = NonNullable<Parameters<ExtensionUIContext["setHeader"]>[0]>;
type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
interface Mounted { view: GuardedComponent; release(): void }
interface Widget extends Mounted { kind: "text" | "component"; placement: "aboveEditor" | "belowEditor"; signature: string }
interface ActiveCustom {
  mounted: Mounted | null;
  overlay: OverlayHandle | null;
  dynamic: (() => OverlayOptions) | null;
  options: OverlayOptions;
  cancel(reason: Error): void;
}
class HostedTui extends TuiAltScreen {
  beforeFrame: (() => void) | undefined;
  protected override doRender(): void { this.beforeFrame?.(); super.doRender(); }
}
export interface ComponentHostOptions {
  terminal: EnkiVirtualTerminal;
  compat: RuntimeUiCompatibility;
  state: PluginSurfaceState;
  draft: EditorDraftCas;
  editorPorts: EditorHostPorts;
  resources: EditorResources;
  native: NativeUiHostPorts;
  baseline: BaselineComponents;
  footerData: FooterData;
  logDirectory: string;
  /** Worker UI lifetime, never a view-attachment AbortSignal. */
  signal: AbortSignal;
  customTimeoutMs: number;
  defaultWorkingMessage: string;
  /** Shared app Theme is disposed by the host runtime, not an individual chat. */
  ownsThemeWatcher?: boolean;
}

/** Actual public pi-tui renderer/factory host, owned by one isolated SDK worker. */
export class SessionComponentHost implements ComponentUiPort {
  readonly tui: HostedTui;
  readonly editor: WorkerEditorHost;
  private readonly lifetimes: ComponentLifetimes;
  private readonly headerSlot = new Container();
  private readonly above = new Container();
  private readonly below = new Container();
  private readonly center = new Container();
  private readonly footerSlot = new Container();
  private readonly statusSlot = new Container();
  private readonly workingSlot = new Container();
  private readonly widgets = new Map<string, Widget>();
  private readonly customJobs = new Set<ActiveCustom>();
  private readonly inputListeners = new Set<() => void>();
  private readonly primaryJobs: ActiveCustom[] = [];
  private readonly fixed: Mounted[] = [];
  private readonly mountedViews = new Set<Component>();
  private readonly loader: Loader;
  private readonly layoutRoot: VStack;
  private header: Mounted;
  private footer: Mounted;
  private snapshot: PluginSurfaceSnapshot;
  private running = false;
  private started = false;
  private stopped = false;
  private closing = false;
  private loaderIndicator = "";
  private loaderActive = false;
  private title: string | null = null;
  private readonly abort: () => void;

  constructor(private readonly options: ComponentHostOptions) {
    if (options.signal.aborted) throw new UiInteractionCancelled("Сеанс интерфейса уже закрыт.");
    if (!Number.isSafeInteger(options.customTimeoutMs) || options.customTimeoutMs < 1 || options.customTimeoutMs > 86_400_000) {
      throw new RangeError("Некорректный срок жизни custom UI.");
    }
    this.lifetimes = new ComponentLifetimes(fault => options.native.fault(fault));
    // pi-tui keybindings are an explicit host-wide app preference shared by the
    // real renderers, not a per-chat setting or a simulated isolated singleton.
    setKeybindings(options.compat.keybindings);
    const terminalOptions: TuiAltScreenOptions = {
      mouse: true, copyOnSelect: false,
      copySelection: text => options.native.copySelection(text),
      openUrl: url => options.native.openUrl(url),
      onRightClickPaste: () => options.native.requestPaste(),
    };
    this.tui = new HostedTui(options.terminal, true, options.logDirectory, terminalOptions);
    const rollback: (() => void)[] = [];
    try {
    this.editor = new WorkerEditorHost(this.tui, options.compat, options.draft,
      options.editorPorts, options.resources, this.lifetimes);
    rollback.push(() => this.editor.dispose());
    this.header = this.mount(options.baseline.header(), "header");
    rollback.push(() => this.header.release());
    this.footer = this.mount(options.baseline.footer(), "footer");
    rollback.push(() => this.footer.release());
    const transcript = this.mount(options.baseline.transcript, "transcript");
    rollback.push(() => transcript.release());
    this.fixed.push(transcript);
    this.headerSlot.addChild(this.header.view); this.footerSlot.addChild(this.footer.view);
    this.center.addChild(this.editor);
    this.loader = new Loader(this.tui, options.compat.editorTheme.borderColor,
      text => options.compat.sdk.themes.theme.fg("muted", text), options.defaultWorkingMessage);
    this.loader.stop();
    rollback.push(() => this.loader.stop());
    const transcriptView = new ScrollView(transcript.view, { primary: true, follow: "end", overscroll: "contain" });
    this.layoutRoot = new VStack([
      this.headerSlot,
      { component: transcriptView, basis: 0, grow: 1, minSize: 0 },
      this.workingSlot, this.statusSlot, this.above,
      { component: this.center, basis: "auto", minSize: 1, maxSize: 16 },
      this.below, this.footerSlot,
    ]);
    this.tui.setLayoutRoot(this.layoutRoot);
    this.tui.setFocus(this.editor);
    this.tui.beforeFrame = () => {
      for (const job of [...this.customJobs]) if (job.dynamic) {
        try { job.options = this.resolveOptions(job, job.dynamic()); }
        catch (error) { job.cancel(asError(error)); }
      }
    };
    this.snapshot = options.state.current();
    this.applySnapshot(this.snapshot);
    this.abort = () => this.dispose(new UiInteractionCancelled("Сеанс интерфейса закрыт."));
    options.signal.addEventListener("abort", this.abort, { once: true });
    if (options.signal.aborted) { this.abort(); throw new UiInteractionCancelled("Сеанс закрыт во время создания интерфейса."); }
    } catch (error) {
      if (!this.stopped) {
        for (const release of rollback.reverse()) try { release(); } catch (cleanupError) { this.report("constructor-rollback", cleanupError); }
        this.tui.stop(); options.terminal.dispose(); if (options.ownsThemeWatcher !== false) options.compat.sdk.stopThemeWatcher();
        this.stopped = true;
      }
      throw error;
    }
  }

  start(): void {
    this.alive(); if (this.started) return;
    this.started = true; this.tui.start(); this.snapshotFrame();
  }
  snapshotFrame(): void {
    this.alive(); if (!this.started) throw new Error("TUI ещё не запущен.");
    this.options.terminal.beginSnapshot(() => this.tui.renderNow(true));
  }
  setRunning(running: boolean): void { this.alive(); this.running = running; this.applyWorking(); }
  refreshTheme(): void { this.alive(); this.layoutRoot.invalidate(); this.tui.requestRender(true); }
  activity(): number { return this.customJobs.size + this.editor.activity(); }
  beginShutdown(): void {
    this.closing = true;
    for (const job of [...this.customJobs]) job.cancel(new UiInteractionCancelled("Сеанс интерфейса закрывается."));
  }

  /** Called by SurfaceStatePorts.project after its durable CAS, not as a new mutation. */
  applySnapshot(snapshot: PluginSurfaceSnapshot): void {
    this.alive(); this.snapshot = structuredClone(snapshot);
    this.statusSlot.clear();
    if (Object.keys(snapshot.statuses).length) this.statusSlot.addChild(new Text(Object.values(snapshot.statuses).join("\n"), 0, 0));
    this.options.native.applyPresentation({ toolsExpanded: snapshot.toolsExpanded,
      hiddenThinkingLabel: snapshot.hiddenThinkingLabel, themeName: snapshot.themeName });
    if (this.title !== snapshot.title) { this.title = snapshot.title; this.options.terminal.setTitle(snapshot.title); }
    const present = new Set(snapshot.widgets.map(widget => widget.key));
    for (const [key, widget] of this.widgets) if (!present.has(key)) { this.widgets.delete(key); widget.release(); }
    for (const value of snapshot.widgets) {
      const existing = this.widgets.get(value.key);
      const signature = JSON.stringify(value.lines ?? null);
      if (existing?.kind === value.kind && existing.signature === signature) { existing.placement = value.placement; continue; }
      const text = value.kind === "text" ? (value.lines ?? []).join("\n")
        : "[Компонент расширения ожидает повторной привязки после восстановления worker.]";
      const mounted = this.mount(new Text(text, 0, 0), `widget:${value.key}`);
      this.widgets.set(value.key, { ...mounted, kind: value.kind, placement: value.placement, signature });
      existing?.release();
    }
    this.layoutWidgets(); this.applyWorking(); this.layoutRoot.invalidate(); this.tui.requestRender(true);
  }

  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setWidget(key: string, content: WidgetFactory | undefined, options?: ExtensionWidgetOptions): void;
  setWidget(key: string, content: string[] | WidgetFactory | undefined, options: ExtensionWidgetOptions = {}): void {
    this.alive();
    if (!boundedText(key, 2000, false)) throw new UiProtocolError("widget-key", "Некорректный идентификатор виджета.");
    if (content === undefined) {
      this.options.state.clearWidget(key);
      const previous = this.widgets.get(key); this.widgets.delete(key); previous?.release(); this.layoutWidgets(); return;
    }
    const kind = Array.isArray(content) ? "text" : "component";
    const component = Array.isArray(content) ? new Text(content.join("\n"), 0, 0)
      : content(this.tui, this.options.compat.sdk.themes.theme);
    const next = this.mount(component, `widget:${key}`);
    const placement = options.placement ?? "aboveEditor";
    try { this.options.state.setWidget({ key, kind, placement, ...(Array.isArray(content) ? { lines: [...content] } : {}) }); }
    catch (error) { next.release(); throw error; }
    const previous = this.widgets.get(key);
    this.widgets.set(key, { ...next, kind, placement, signature: JSON.stringify(Array.isArray(content) ? content : null) });
    previous?.release(); this.layoutWidgets();
  }
  setHeader(factory: HeaderFactory | undefined): void {
    this.alive();
    const next = this.mount(factory ? factory(this.tui, this.options.compat.sdk.themes.theme) : this.options.baseline.header(), "header");
    const previous = this.header; this.header = next;
    this.headerSlot.clear(); this.headerSlot.addChild(next.view); previous.release(); this.tui.requestRender(true);
  }
  setFooter(factory: FooterFactory | undefined): void {
    this.alive();
    const subscriptions = new Set<() => void>();
    const data: FooterData = {
      getGitBranch: () => this.options.footerData.getGitBranch(),
      getExtensionStatuses: () => new Map(Object.entries(this.options.state.current().statuses)),
      getAvailableProviderCount: () => this.options.footerData.getAvailableProviderCount(),
      onBranchChange: callback => {
        const stop = this.options.footerData.onBranchChange(callback); subscriptions.add(stop);
        return () => { if (subscriptions.delete(stop)) stop(); };
      },
    };
    const clearSubscriptions = () => {
      for (const stop of subscriptions) try { stop(); } catch (error) { this.report("footer-unsubscribe", error); }
      subscriptions.clear();
    };
    let next: Mounted;
    try {
      const component = factory ? factory(this.tui, this.options.compat.sdk.themes.theme, data) : this.options.baseline.footer();
      const mounted = this.mount(component, "footer");
      next = { view: mounted.view, release: () => { clearSubscriptions(); mounted.release(); } };
    } catch (error) { clearSubscriptions(); throw error; }
    const previous = this.footer; this.footer = next;
    this.footerSlot.clear(); this.footerSlot.addChild(next.view); previous.release(); this.tui.requestRender(true);
  }
  onTerminalInput(handler: Parameters<ExtensionUIContext["onTerminalInput"]>[0]): () => void {
    this.alive();
    const remove = this.tui.addInputListener(data => {
      try { return handler(data); }
      catch (error) { this.report("terminal-input", error); return { consume: true }; }
    });
    const stop = () => {
      if (!this.inputListeners.delete(stop)) return;
      remove(); this.editor.setRawInputListenerCount(this.inputListeners.size);
    };
    this.inputListeners.add(stop); this.editor.setRawInputListenerCount(this.inputListeners.size);
    return stop;
  }

  custom<T>(factory: CustomFactory<T>, options: CustomOptions = {}): Promise<T> {
    if (this.closing) return Promise.reject(new UiInteractionCancelled("Сеанс интерфейса закрывается."));
    this.alive();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const focus = this.tui.getFocusedComponent();
      const job: ActiveCustom = { mounted: null, overlay: null, dynamic: null, options: {},
        cancel: reason => finish({ success: false, error: reason }) };
      const timer = setTimeout(() => job.cancel(new UiInteractionCancelled("Время ожидания custom UI истекло.")), this.options.customTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        const overlay = job.overlay; job.overlay = null;
        try { overlay?.hide(); } catch (error) { this.report("custom-overlay-hide", error); }
        this.customJobs.delete(job);
        const index = this.primaryJobs.indexOf(job); if (index >= 0) this.primaryJobs.splice(index, 1);
        const mounted = job.mounted; job.mounted = null;
        try { this.layoutCenter(); } finally { mounted?.release(); }
        if (!this.stopped && !this.tui.hasOverlay()) {
          const top = this.primaryJobs[this.primaryJobs.length - 1];
          const previousAlive = focus !== null && (focus === this.editor || this.mountedViews.has(focus) || this.lifetimes.held(focus));
          this.tui.setFocus(top?.mounted?.view ?? (previousAlive ? focus : this.editor));
        }
        this.tui.requestRender(true);
      };
      const finish = (result: { success: true; value: T } | { success: false; error: Error }) => {
        if (settled) return;
        settled = true;
        try { cleanup(); } catch (error) { this.report("custom-cleanup", error); }
        finally { if (result.success) resolve(result.value); else reject(result.error); }
      };
      const done = (result: T) => finish({ success: true, value: result });
      this.customJobs.add(job);
      let result: ReturnType<CustomFactory<T>>;
      try { result = factory(this.tui, this.options.compat.sdk.themes.theme, this.options.compat.keybindings, done); }
      catch (error) { this.report("custom-factory", error); finish({ success: false, error: asError(error) }); return; }
      void Promise.resolve(result).then(component => {
        requireComponent(component);
        const mounted = this.mount(component, "custom", error => job.cancel(error));
        if (settled || this.stopped) { mounted.release(); return; }
        job.mounted = mounted;
        if (options.overlay) {
          job.dynamic = typeof options.overlayOptions === "function" ? options.overlayOptions : null;
          job.options = this.resolveOptions(job, job.dynamic ? job.dynamic() : typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions ?? {});
          // Public mutable options object is retained by TUI. Getters expose one
          // coherent per-frame snapshot, so the real OverlayHandle never changes.
          const dynamicOptions: OverlayOptions = {
            get width() { return job.options.width; }, get minWidth() { return job.options.minWidth; },
            get maxHeight() { return job.options.maxHeight; }, get anchor() { return job.options.anchor; },
            get offsetX() { return job.options.offsetX; }, get offsetY() { return job.options.offsetY; },
            get row() { return job.options.row; }, get col() { return job.options.col; },
            get margin() { return job.options.margin; }, get visible() { return job.options.visible; },
            get nonCapturing() { return job.options.nonCapturing; },
          };
          const overlay = this.tui.showOverlay(mounted.view, dynamicOptions);
          if (settled || this.stopped) { overlay.hide(); return; }
          job.overlay = overlay;
          options.onHandle?.(job.overlay);
        } else {
          this.primaryJobs.push(job); this.layoutCenter(); this.tui.setFocus(mounted.view);
        }
        this.tui.requestRender(true);
      }).catch(error => { this.report("custom-mount", error); finish({ success: false, error: asError(error) }); });
    });
  }

  dispose(reason: Error = new UiInteractionCancelled("Интерфейс расширений закрыт.")): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.signal.removeEventListener("abort", this.abort);
    for (const job of [...this.customJobs]) job.cancel(reason);
    for (const stop of [...this.inputListeners]) stop();
    this.loader.stop();
    try { this.tui.stop(); } catch (error) { this.report("tui-stop", error); }
    try { this.editor.dispose(); } catch (error) { this.report("editor-dispose", error); }
    for (const widget of this.widgets.values()) widget.release(); this.widgets.clear();
    this.header.release(); this.footer.release(); for (const mounted of this.fixed) mounted.release();
    this.options.terminal.dispose();
    if (this.options.ownsThemeWatcher !== false) this.options.compat.sdk.stopThemeWatcher();
  }
  private mount(component: DisposableComponent, operation: string, failure?: (error: Error) => void): Mounted {
    requireComponent(component);
    const release = this.lifetimes.hold(component, operation);
    const view = new GuardedComponent(component, error => { this.report(operation, error); failure?.(error); });
    this.mountedViews.add(view);
    return { view, release: () => { this.mountedViews.delete(view); release(); } };
  }
  private layoutWidgets(): void {
    this.above.clear(); this.below.clear();
    for (const value of this.widgets.values()) (value.placement === "aboveEditor" ? this.above : this.below).addChild(value.view);
    this.tui.requestRender(true);
  }
  private layoutCenter(): void {
    this.center.clear();
    const active = this.primaryJobs[this.primaryJobs.length - 1]?.mounted?.view;
    this.center.addChild(active ?? this.editor);
  }
  private applyWorking(): void {
    this.workingSlot.clear();
    this.loader.setMessage(this.snapshot.working.message ?? this.options.defaultWorkingMessage);
    const indicator = JSON.stringify(this.snapshot.working.indicator);
    const changed = indicator !== this.loaderIndicator;
    if (changed) { this.loaderIndicator = indicator; this.loader.setIndicator(this.snapshot.working.indicator ?? undefined); }
    const active = this.running && this.snapshot.working.visible;
    if (active) { this.workingSlot.addChild(this.loader); if (!this.loaderActive && !changed) this.loader.start(); }
    else this.loader.stop();
    this.loaderActive = active;
    this.tui.requestRender();
  }
  private report(operation: string, error: unknown): void { this.options.native.fault({ operation, error: asError(error) }); }
  private resolveOptions(job: ActiveCustom, raw: OverlayOptions): OverlayOptions {
    const options = checkedOptions(raw);
    const visible = options.visible;
    if (visible) options.visible = (width, height) => {
      try { return visible(width, height); }
      catch (error) { this.report("overlay-visibility", error); job.cancel(asError(error)); return false; }
    };
    return options;
  }
  private alive(): void { if (this.stopped) throw new Error("Компоненты относятся к закрытому worker UI."); }
}

function checkedOptions(value: OverlayOptions): OverlayOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Overlay options должны быть объектом.");
  const snapshot: OverlayOptions = { width: value.width, minWidth: value.minWidth, maxHeight: value.maxHeight,
    anchor: value.anchor, offsetX: value.offsetX, offsetY: value.offsetY, row: value.row, col: value.col,
    margin: value.margin, visible: value.visible, nonCapturing: value.nonCapturing };
  for (const key of ["minWidth", "offsetX", "offsetY"] as const) {
    if (snapshot[key] !== undefined && !Number.isFinite(snapshot[key])) throw new TypeError("Некорректная геометрия overlay.");
  }
  return snapshot;
}
