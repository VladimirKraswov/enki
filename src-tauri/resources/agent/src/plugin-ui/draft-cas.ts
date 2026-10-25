import { createHash } from "node:crypto";
import { MAX_DRAFT_BYTES, UiProtocolError, boundedText, integer, scopeCopy, type UiScope } from "./protocol.ts";

export interface DraftSelection { start: number; end: number }
export interface DraftSnapshot {
  revision: number;
  text: string;
  selection: DraftSelection;
  updatedAt: number;
}
export interface DraftMutation {
  id: string;
  baseRevision: number;
  origin: "user" | "extension" | "restore";
  text: string;
  selection?: DraftSelection;
}
export interface DraftReceipt { digest: string; snapshot: DraftSnapshot }
export interface DraftCasPorts {
  /** Atomic durable CAS + mutation receipt; same ID with another digest must fail. */
  commit(scope: UiScope, expectedRevision: number, mutationId: string, receipt: DraftReceipt): void;
  lookup(scope: UiScope, mutationId: string): DraftReceipt | undefined;
  /** Project committed state, never reinterpret this callback as a replace command. */
  publish(scope: UiScope, snapshot: DraftSnapshot): void;
  projectionFailure(scope: UiScope, error: unknown): void;
}
export interface DraftResult { replayed: boolean; snapshot: DraftSnapshot }

export function isDraft(value: unknown): value is DraftSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<DraftSnapshot>;
  return integer(v.revision, 0) && boundedText(v.text, MAX_DRAFT_BYTES)
    && integer(v.updatedAt, 0) && !!v.selection && integer(v.selection.start, 0)
    && integer(v.selection.end, v.selection.start) && v.selection.end <= v.text.length;
}
function copy(value: DraftSnapshot): DraftSnapshot {
  return { revision: value.revision, text: value.text,
    selection: { start: value.selection.start, end: value.selection.end }, updatedAt: value.updatedAt };
}

/** Canonical committed draft. Unknown/failed persistence never clears the user's text. */
export class EditorDraftCas {
  private value: DraftSnapshot;
  readonly scope: UiScope;
  constructor(scope: UiScope, snapshot: DraftSnapshot, private readonly ports: DraftCasPorts,
    private readonly now: () => number = Date.now) {
    this.scope = scopeCopy(scope);
    if (!isDraft(snapshot)) throw new UiProtocolError("draft", "Сохранённый черновик повреждён.");
    this.value = copy(snapshot);
  }
  current(): DraftSnapshot { return copy(this.value); }

  replace(mutation: DraftMutation): DraftResult {
    if (!boundedText(mutation.id, 240, false) || !integer(mutation.baseRevision, 0)
      || !["user", "extension", "restore"].includes(mutation.origin)
      || !boundedText(mutation.text, MAX_DRAFT_BYTES)) throw new UiProtocolError("draft-mutation", "Некорректное изменение черновика.");
    const selection = mutation.selection ?? { start: mutation.text.length, end: mutation.text.length };
    if (!integer(selection.start, 0) || !integer(selection.end, selection.start) || selection.end > mutation.text.length)
      throw new UiProtocolError("draft-selection", "Положение курсора выходит за границы черновика.");
    const digest = createHash("sha256").update(JSON.stringify({ baseRevision: mutation.baseRevision,
      origin: mutation.origin, text: mutation.text, selection })).digest("hex");
    const previous = this.ports.lookup(this.scope, mutation.id);
    if (previous) {
      if (previous.digest !== digest || !isDraft(previous.snapshot)) throw new UiProtocolError("draft-id-conflict", "Идентификатор изменения черновика уже использован.");
      // Receipt lookup never rolls a newer canonical draft back to the old receipt.
      return { replayed: true, snapshot: copy(previous.snapshot) };
    }
    if (mutation.baseRevision !== this.value.revision) throw new UiProtocolError("draft-cas", "Черновик уже изменился. Ваш текст сохранён на клиенте; синхронизируйте обе версии.");
    const snapshot: DraftSnapshot = { revision: this.value.revision + 1, text: mutation.text,
      selection: { ...selection }, updatedAt: this.now() };
    if (!isDraft(snapshot)) throw new UiProtocolError("draft-clock", "Не удалось сформировать версию черновика.");
    const receipt = { digest, snapshot: copy(snapshot) };
    this.ports.commit(this.scope, this.value.revision, mutation.id, receipt);
    this.value = copy(snapshot);
    try { this.ports.publish(this.scope, copy(snapshot)); }
    catch (error) { this.ports.projectionFailure(this.scope, error); }
    return { replayed: false, snapshot: copy(snapshot) };
  }

  /** Trusted storage reconciliation after another authorized writer won a CAS. */
  hydrate(snapshot: DraftSnapshot): void {
    if (!isDraft(snapshot) || snapshot.revision < this.value.revision) throw new UiProtocolError("draft-revision", "Нельзя восстановить устаревший черновик поверх нового.");
    if (snapshot.revision === this.value.revision && (snapshot.text !== this.value.text
      || snapshot.updatedAt !== this.value.updatedAt || snapshot.selection.start !== this.value.selection.start
      || snapshot.selection.end !== this.value.selection.end))
      throw new UiProtocolError("draft-conflict", "Хранилище вернуло разные данные одной версии черновика.");
    this.value = copy(snapshot);
  }
}
