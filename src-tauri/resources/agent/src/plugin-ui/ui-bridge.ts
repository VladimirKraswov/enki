import type { AgentSession, ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import type { CustomFactory, CustomOptions, PluginHostPorts, WidgetFactory } from "./sdk-ports.ts";

/** Complete method surface; all execution is delegated to mandatory real worker ports. */
export function createPluginUiBridge(ports: PluginHostPorts): ExtensionUIContext {
  function setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  function setWidget(key: string, content: WidgetFactory | undefined, options?: ExtensionWidgetOptions): void;
  function setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: ExtensionWidgetOptions): void {
    if (typeof content === "function") ports.components.setWidget(key, content, options);
    else ports.components.setWidget(key, content, options);
  }
  return {
    select: (title, options, opts) => ports.dialogs.select(title, options, opts),
    confirm: (title, message, opts) => ports.dialogs.confirm(title, message, opts),
    input: (title, placeholder, opts) => ports.dialogs.input(title, placeholder, opts),
    editor: (title, prefill) => ports.dialogs.editor(title, prefill),
    notify: (message, type) => ports.notify(message, type),
    onTerminalInput: handler => ports.components.onTerminalInput(handler),
    setStatus: (key, text) => ports.state.setStatus(key, text),
    setWorkingMessage: message => ports.state.setWorkingMessage(message),
    setWorkingVisible: visible => ports.state.setWorkingVisible(visible),
    setWorkingIndicator: indicator => ports.state.setWorkingIndicator(indicator),
    setHiddenThinkingLabel: label => ports.state.setHiddenThinkingLabel(label),
    setWidget,
    setFooter: factory => ports.components.setFooter(factory),
    setHeader: factory => ports.components.setHeader(factory),
    setTitle: title => ports.state.setTitle(title),
    custom: <T>(factory: CustomFactory<T>, options?: CustomOptions) => ports.components.custom(factory, options),
    pasteToEditor: text => ports.editor.pasteToEditor(text),
    setEditorText: text => ports.editor.setEditorText(text),
    getEditorText: () => ports.editor.getEditorText(),
    addAutocompleteProvider: factory => ports.editor.addAutocompleteProvider(factory),
    setEditorComponent: factory => ports.editor.setEditorComponent(factory),
    getEditorComponent: () => ports.editor.getEditorComponent(),
    get theme() { return ports.themes.theme; },
    getAllThemes: () => ports.themes.getAllThemes(),
    getTheme: name => ports.themes.getTheme(name),
    setTheme: theme => ports.themes.setTheme(theme),
    getToolsExpanded: () => ports.state.current().toolsExpanded,
    setToolsExpanded: expanded => ports.state.setToolsExpanded(expanded),
  };
}

/** No SDK default command actions. Calling code must wire the real per-session runtime. */
export async function bindPluginUi(session: AgentSession, ports: PluginHostPorts): Promise<void> {
  await session.bindExtensions({ uiContext: createPluginUiBridge(ports), mode: "tui",
    commandContextActions: ports.commands, abortHandler: ports.lifecycle.abortHandler,
    shutdownHandler: ports.lifecycle.shutdownHandler, onError: ports.lifecycle.onError });
}
