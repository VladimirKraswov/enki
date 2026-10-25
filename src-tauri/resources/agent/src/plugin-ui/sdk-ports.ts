import type {
  AgentSession, ExtensionCommandContextActions, ExtensionUIContext, ExtensionWidgetOptions,
  KeybindingsManager, Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { PluginSurfaceState } from "./surface-state.ts";

export type WidgetFactory = Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], undefined>;
export type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];
export type CustomFactory<T> = (tui: TUI, theme: Theme, keybindings: KeybindingsManager,
  done: (value: T) => void) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;
type Bindings = Parameters<AgentSession["bindExtensions"]>[0];

/** Every method is mandatory. The actual worker must supply real SDK/TUI objects. */
export interface ComponentUiPort {
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setWidget(key: string, content: WidgetFactory | undefined, options?: ExtensionWidgetOptions): void;
  setHeader: ExtensionUIContext["setHeader"];
  setFooter: ExtensionUIContext["setFooter"];
  custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T>;
  onTerminalInput: ExtensionUIContext["onTerminalInput"];
}
export interface PluginHostPorts {
  state: PluginSurfaceState;
  dialogs: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "editor">;
  components: ComponentUiPort;
  editor: Pick<ExtensionUIContext, "setEditorText" | "getEditorText" | "pasteToEditor"
    | "setEditorComponent" | "getEditorComponent" | "addAutocompleteProvider">;
  themes: Pick<ExtensionUIContext, "theme" | "getAllThemes" | "getTheme" | "setTheme">;
  notify: ExtensionUIContext["notify"];
  /** Stop/close this worker only. Handler signatures remain the SDK's exact types. */
  lifecycle: Required<Pick<Bindings, "abortHandler" | "shutdownHandler" | "onError">>;
  commands: ExtensionCommandContextActions;
}

/* Port obligations:
 * - components invoke factories worker-locally, manage focus/dispose/epoch/done<T>;
 * - dialogs validate authenticated owner/scope/method/deadline, settle on every failure;
 * - editor is the real EditorComponent with synchronous expanded text and durable draft CAS;
 * - themes.theme is a safe initialized stable Theme reference (SDK spreads ui at bind);
 * - state.project applies actual native/TUI render state, not just an unconsumed event;
 * - commands call actual runtime methods with registry/leases and fresh withSession ctx;
 * - none of these ports may return fake success, an empty editor, or silently drop a factory.
 */
