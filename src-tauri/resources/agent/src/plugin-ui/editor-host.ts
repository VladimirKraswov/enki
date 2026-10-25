import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Editor, isFocusable, type Component, type EditorComponent, type TUI,
  type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { EditorDraftCas, isDraft, type DraftSnapshot } from "./draft-cas.ts";
import { MAX_DRAFT_BYTES, boundedText, integer, UiProtocolError } from "./protocol.ts";
import { AutocompletePipeline } from "./autocomplete.ts";
import { ComponentLifetimes, requireComponent } from "./component-lifetime.ts";
import { asError, type EditorHostPorts, type EditorResources, type PendingEditorChange,
  type RuntimeUiCompatibility, type SubmitRequest } from "./host-ports.ts";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
export type EditorPort = Pick<ExtensionUIContext, "setEditorText" | "getEditorText" | "pasteToEditor"
  | "setEditorComponent" | "getEditorComponent" | "addAutocompleteProvider">;
interface EditorBinding {
  component: EditorComponent;
  changed?: (text: string) => void;
  submitted?: (text: string) => void;
  release(): void;
  generation: number;
}
function requireEditor(value: EditorComponent): void {
  requireComponent(value);
  if (typeof value.getText !== "function" || typeof value.setText !== "function" || typeof value.handleInput !== "function") {
    throw new TypeError("Фабрика не вернула настоящий EditorComponent.");
  }
}

/** One actual SDK editor, projected from one durable canonical draft; no second text store. */
export class WorkerEditorHost implements Component {
  readonly api: EditorPort;
  readonly base: Editor;
  private active: EditorBinding;
  private factory: EditorFactory | undefined;
  private readonly baseRelease: () => void;
  private readonly autocomplete: AutocompletePipeline;
  private readonly history: string[];
  private generation = 0;
  private depth = 0;
  private suppress = false;
  private dirty = false;
  private submitted: string | null = null;
  private pendingChange: PendingEditorChange | null = null;
  private submitting = false;
  private uncertainSubmission: { request: SubmitRequest; binding: EditorBinding } | null = null;
  private stopped = false;
  private rawListeners = 0;
  private focusValue = false;

  constructor(private readonly tui: TUI, private readonly compat: RuntimeUiCompatibility,
    private readonly draft: EditorDraftCas, private readonly ports: EditorHostPorts,
    resources: EditorResources, private readonly lifetimes: ComponentLifetimes) {
    this.autocomplete = new AutocompletePipeline(resources.autocomplete);
    this.history = [...resources.history].slice(-100);
    this.base = new Editor(tui, compat.editorTheme);
    this.baseRelease = lifetimes.hold(this.base, "base-editor");
    this.base.setText(draft.current().text);
    this.base.setAutocompleteProvider(this.autocomplete);
    for (const item of this.history) this.base.addToHistory(item);
    this.active = this.bind(this.base, lifetimes.hold(this.base, "active-base-editor"));
    this.api = {
      setEditorText: text => this.setEditorText(text),
      getEditorText: () => this.getEditorText(),
      pasteToEditor: text => this.pasteToEditor(text),
      setEditorComponent: factory => this.setEditorComponent(factory),
      getEditorComponent: () => this.factory,
      addAutocompleteProvider: factory => { this.alive(); this.autocomplete.add(factory);
        this.active.component.setAutocompleteProvider?.(this.autocomplete); this.tui.requestRender(); },
    };
  }

  get children(): Component[] { return [this.active.component]; }
  /** Unacknowledged durable projections are visible state, not active work. */
  activity(): number { return this.submitting ? 1 : 0; }
  get component(): EditorComponent { return this.active.component; }
  get focused(): boolean { return this.focusValue; }
  set focused(value: boolean) {
    this.focusValue = value;
    if (isFocusable(this.active.component)) this.active.component.focused = value;
  }
  get wantsKeyRelease(): boolean | undefined { return this.active.component.wantsKeyRelease; }
  render(width: number): string[] { return this.active.component.render(width); }
  invalidate(): void { this.active.component.invalidate(); }
  handleInput(data: string): void { this.mutate("user", () => this.active.component.handleInput(data)); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    let result: TuiMouseEventResult | undefined;
    this.mutate("user", () => { result = this.active.component.handleMouse?.(event); });
    return result;
  }

  getEditorText(): string { this.alive(); return this.expanded(); }
  setEditorText(text: string): void {
    this.checkText(text); this.mutate("extension", () => this.active.component.setText(text));
  }
  pasteToEditor(text: string): void {
    this.checkText(text);
    if (text.includes("\x1b[201~")) throw new UiProtocolError("paste-control", "Текст содержит управляющий конец вставки.");
    this.mutate("extension", () => this.active.component.handleInput(`\x1b[200~${text}\x1b[201~`));
  }
  setEditorComponent(factory: EditorFactory | undefined): void {
    this.alive(); this.noPending();
    const previous = this.active, text = this.expanded(), wasFocused = this.focusValue;
    const editor = factory ? factory(this.tui, this.compat.editorTheme, this.compat.keybindings) : this.base;
    requireEditor(editor);
    if (editor === previous.component) { this.factory = factory; return; }
    const release = this.lifetimes.hold(editor, editor === this.base ? "active-base-editor" : "custom-editor");
    try {
      editor.setText(text);
      editor.setAutocompleteProvider?.(this.autocomplete);
      if (editor !== this.base) for (const item of this.history) editor.addToHistory?.(item);
    } catch (error) { release(); throw error; }
    this.autocomplete.cancel();
    previous.component.onChange = previous.changed;
    previous.component.onSubmit = previous.submitted;
    this.active = this.bind(editor, release);
    this.factory = factory;
    if (wasFocused) this.tui.setFocus(this);
    try { previous.component.setAutocompleteProvider?.(this.autocomplete); }
    catch (error) { this.ports.fault({ operation: "old-editor-autocomplete", error: asError(error) }); }
    finally { previous.release(); }
    this.ports.modeChanged({ custom: factory !== undefined, terminalInput: this.rawListeners > 0 });
    this.tui.requestRender(true);
  }

  /** Trusted native storage projection. It is never reinterpreted as another edit command. */
  hydrate(snapshot: DraftSnapshot): void {
    this.alive(); this.draft.hydrate(snapshot); this.restore(snapshot.text);
    if (this.pendingChange) {
      this.pendingChange = { ...this.pendingChange, committed: this.draft.current() };
      this.ports.pending(structuredClone(this.pendingChange));
    }
    this.tui.requestRender();
  }
  retryPending(): void {
    this.alive();
    const pending = this.pendingChange;
    if (!pending) return;
    // Same mutation ID and payload: durable receipt lookup settles a lost ACK.
    this.draft.hydrate(this.ports.readCommitted());
    this.restore(this.draft.current().text);
    this.pendingChange = { ...pending, committed: this.draft.current() };
    this.ports.pending(structuredClone(this.pendingChange));
    this.draft.replace({ id: pending.id, baseRevision: pending.baseRevision,
      origin: pending.origin, text: pending.text });
    this.draft.hydrate(this.ports.readCommitted());
    this.pendingChange = null; this.ports.pending(null);
    this.restore(this.draft.current().text); this.tui.requestRender();
  }
  /** Explicit user retry only; the admission service deduplicates the original ID. */
  retrySubmission(): void {
    this.alive();
    if (!this.uncertainSubmission || this.submitting) return;
    const { request, binding } = this.uncertainSubmission;
    this.dispatchSubmission(request, binding);
  }
  restorePendingSubmission(value: unknown): void {
    this.alive();
    if (!value || typeof value !== "object" || !("id" in value) || !boundedText(value.id, 240, false)
      || !("text" in value) || !boundedText(value.text, MAX_DRAFT_BYTES) || !("draft" in value) || !isDraft(value.draft))
      throw new Error("Сохранённая неподтверждённая отправка повреждена.");
    if (this.submitting || this.uncertainSubmission) throw new Error("Отправка уже восстанавливается.");
    this.uncertainSubmission = { request: { id: value.id, text: value.text, draft: structuredClone(value.draft) }, binding: this.active };
    this.ports.pendingSubmission(structuredClone(this.uncertainSubmission.request));
  }
  restorePendingChange(value: unknown): void {
    this.alive();
    if (!value || typeof value !== "object" || !("id" in value) || !boundedText(value.id, 240, false)
      || !("baseRevision" in value) || !integer(value.baseRevision, 0) || !("origin" in value)
      || (value.origin !== "user" && value.origin !== "extension") || !("text" in value) || !boundedText(value.text, MAX_DRAFT_BYTES))
      throw new Error("Сохранённое неподтверждённое изменение повреждено.");
    if (this.pendingChange) throw new Error("Изменение черновика уже восстанавливается.");
    this.pendingChange = { id: value.id, baseRevision: value.baseRevision, origin: value.origin,
      text: value.text, committed: this.draft.current() };
    this.ports.pending(structuredClone(this.pendingChange));
  }
  /** Only an authenticated explicit user conflict-resolution command may call this. */
  resolvePending(choice: { kind: "discard" } | { kind: "replace"; id: string; baseRevision: number; text: string }): void {
    this.alive(); if (!this.pendingChange) return;
    this.draft.hydrate(this.ports.readCommitted());
    this.restore(this.draft.current().text);
    if (choice.kind === "replace") {
      this.checkText(choice.text);
      try { this.draft.replace({ id: choice.id, baseRevision: choice.baseRevision, origin: "user", text: choice.text }); }
      catch (error) {
        this.pendingChange = { id: choice.id, baseRevision: choice.baseRevision, origin: "user",
          text: choice.text, committed: this.draft.current() };
        this.ports.pending(structuredClone(this.pendingChange)); throw error;
      }
    }
    this.pendingChange = null; this.ports.pending(null);
    this.restore(this.draft.current().text); this.tui.requestRender();
  }
  setRawInputListenerCount(count: number): void {
    this.rawListeners = count;
    this.ports.modeChanged({ custom: this.factory !== undefined, terminalInput: count > 0 });
  }
  setBaseAutocomplete(provider: EditorResources["autocomplete"]): void {
    this.alive(); this.autocomplete.setBase(provider); this.active.component.setAutocompleteProvider?.(this.autocomplete);
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true; this.generation += 1;
    this.autocomplete.dispose();
    this.active.component.onChange = this.active.changed;
    this.active.component.onSubmit = this.active.submitted;
    // Public setter cancels Editor's outstanding autocomplete/debounce timers.
    try { this.active.component.setAutocompleteProvider?.(this.autocomplete); }
    catch (error) { this.ports.fault({ operation: "editor-autocomplete-dispose", error: asError(error) }); }
    try { this.base.setAutocompleteProvider(this.autocomplete); }
    finally { this.active.release(); this.baseRelease(); }
  }

  private bind(component: EditorComponent, release: () => void): EditorBinding {
    const binding: EditorBinding = { component, release, generation: ++this.generation,
      changed: component.onChange, submitted: component.onSubmit };
    component.onChange = () => {
      if (this.stopped || this.suppress || this.active?.generation !== binding.generation) return;
      this.dirty = true;
      if (this.depth === 0) this.flush("user");
    };
    component.onSubmit = text => {
      if (this.stopped || this.suppress || this.active?.generation !== binding.generation) return;
      this.submitted = text;
      if (this.depth === 0) this.flush("user");
    };
    return binding;
  }
  private mutate(origin: "user" | "extension", action: () => void): void {
    this.alive(); this.noPending(); this.depth += 1;
    try { action(); }
    finally { this.depth -= 1; if (this.depth === 0) this.flush(origin); }
  }
  private flush(origin: "user" | "extension"): void {
    if (this.suppress || this.stopped) return;
    if (this.submitted !== null) {
      const text = this.submitted; this.submitted = null; this.dirty = false;
      // pi-tui clears onChange before onSubmit; do not commit that provisional clear.
      this.restore(this.draft.current().text);
      this.submit(text);
      return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const text = this.expanded(), before = this.draft.current();
    if (text === before.text) return;
    const id = this.ports.nextMutationId();
    try {
      this.draft.replace({ id, baseRevision: before.revision, origin, text });
    } catch (error) {
      this.pendingChange = { id, baseRevision: before.revision, origin, text, committed: before };
      this.restore(before.text);
      this.ports.pending(structuredClone(this.pendingChange));
      this.ports.fault({ operation: "editor-draft", error: asError(error) });
      throw error;
    }
    try { this.active.changed?.(this.active.component.getText()); }
    catch (error) { this.ports.fault({ operation: "editor-change-handler", error: asError(error) }); }
    this.tui.requestRender();
  }
  private submit(text: string): void {
    if (this.submitting) return;
    if (this.uncertainSubmission) {
      this.ports.fault({ operation: "editor-submit-pending", error: new UiProtocolError("submit-pending",
        "Доставка прежнего запроса не подтверждена. Сначала проверьте его отправку; новый черновик сохранён.") });
      return;
    }
    const snapshot = this.draft.current(), binding = this.active;
    const id = this.ports.nextMutationId();
    this.dispatchSubmission({ id, text, draft: snapshot }, binding);
  }
  private dispatchSubmission(request: SubmitRequest, binding: EditorBinding): void {
    const { text, draft: snapshot } = request;
    this.submitting = true;
    void Promise.resolve().then(() => {
      if (this.stopped) throw new Error("Отправка отменена закрытием worker до admission.");
      return this.ports.submit(structuredClone(request));
    }).then(receipt => {
      if (this.stopped) return;
      if (!receipt || typeof receipt.accepted !== "boolean" || !receipt.commandId) throw new Error("Сервис не подтвердил доставку редактора.");
      this.uncertainSubmission = null;
      this.ports.pendingSubmission(null);
      if (!receipt.accepted) return;
      this.history.push(text); if (this.history.length > 100) this.history.shift();
      this.active.component.addToHistory?.(text);
      if (this.active.component !== this.base) this.base.addToHistory(text);
      const latest = this.draft.current();
      try {
        if (latest.revision === snapshot.revision && latest.text === snapshot.text) this.setEditorText("");
        if (this.active.generation === binding.generation) binding.submitted?.(text);
      } catch (error) { this.ports.fault({ operation: "editor-after-accepted-submit", error: asError(error) }); }
    }).catch(error => {
      if (!this.stopped) {
        this.uncertainSubmission = { request: structuredClone(request), binding };
        this.ports.pendingSubmission(structuredClone(request));
        this.ports.fault({ operation: "editor-submit-uncertain", error: asError(error) });
      }
    }).finally(() => { this.submitting = false; });
  }
  private restore(text: string): void {
    const previous = this.suppress; this.suppress = true;
    try { this.active.component.setText(text); }
    finally { this.suppress = previous; }
  }
  private expanded(): string {
    const value = this.active.component.getExpandedText?.() ?? this.active.component.getText();
    this.checkText(value);
    return value;
  }
  private checkText(text: string): void {
    if (!boundedText(text, MAX_DRAFT_BYTES)) throw new UiProtocolError("editor-limit", "Текст редактора превышает допустимый размер.");
  }
  private noPending(): void {
    if (this.pendingChange) throw new UiProtocolError("editor-pending", "Неподтверждённый текст сохранён отдельно. Сначала восстановите черновик.");
  }
  private alive(): void { if (this.stopped) throw new Error("Редактор относится к закрытому сеансу."); }
}
