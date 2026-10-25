import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, EditorTheme } from "@earendil-works/pi-tui";
import type { DraftSnapshot } from "./draft-cas.ts";
import type { SdkUiCompat } from "./sdk-ui-compat.ts";

export interface RuntimeUiCompatibility {
  /** Initialized in the isolated worker by the reviewed SDK compatibility loader. */
  sdk: Pick<SdkUiCompat, "themes" | "stopThemeWatcher">;
  keybindings: KeybindingsManager;
  editorTheme: EditorTheme;
}
export interface UiFault { operation: string; error: Error }
export interface PendingEditorChange {
  id: string; baseRevision: number; origin: "user" | "extension";
  text: string; committed: DraftSnapshot;
}
export interface SubmitRequest { id: string; text: string; draft: DraftSnapshot }
export interface SubmitReceipt { accepted: boolean; commandId: string }

/** No defaults: the actual server must provide durable delivery/storage and UI projection. */
export interface EditorHostPorts {
  nextMutationId(): string;
  readCommitted(): DraftSnapshot;
  pending(change: PendingEditorChange | null): void;
  /** Visible uncertain admission, retained until the same request ID is reconciled. */
  pendingSubmission(request: SubmitRequest | null): void;
  /** Durable, idempotent admission: identical IDs must resolve to the same command. */
  submit(request: SubmitRequest): Promise<SubmitReceipt>;
  fault(fault: UiFault): void;
  modeChanged(mode: { custom: boolean; terminalInput: boolean }): void;
}
type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
export type FooterData = Parameters<FooterFactory>[2];

export interface NativeUiHostPorts {
  fault(fault: UiFault): void;
  /** Authorized native clipboard/link/paste handlers; never OSC52 or shell fallbacks. */
  copySelection(text: string): Promise<boolean>;
  openUrl(url: string): void;
  requestPaste(): void;
  applyPresentation(value: { toolsExpanded: boolean; hiddenThinkingLabel: string | null; themeName: string | null }): void;
}
export interface BaselineComponents {
  header(): Component & { dispose?(): void };
  footer(): Component & { dispose?(): void };
  transcript: Component & { dispose?(): void };
}
export interface EditorResources { autocomplete: AutocompleteProvider; history: readonly string[] }

export class UiInteractionCancelled extends Error {
  constructor(message: string) { super(message); this.name = "UiInteractionCancelled"; }
}
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Неизвестная ошибка компонента расширения.");
}
