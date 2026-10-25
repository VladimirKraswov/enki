// Real extension UI: native broker dialogs + runtime-owned TUI/editor host.
import type { SdkSession, SdkUiContext } from "../sdk/adapter.ts";
import type { EventJournal } from "../store/events.ts";
import type { InteractionBroker } from "./broker.ts";
import type { SessionUi } from "../plugin-ui/runtime.ts";
import { createPluginUiBridge } from "../plugin-ui/ui-bridge.ts";
import type { PluginHostPorts } from "../plugin-ui/sdk-ports.ts";
export interface UiBridgeScope { sessionID: string; directory: string }
export interface UiDiagnostics { unsupported: Set<string> }
export function createUiBridge(scope: UiBridgeScope, broker: InteractionBroker, journal: EventJournal,
  _diagnostics: UiDiagnostics, current: () => SessionUi,
  lifecycle: PluginHostPorts["lifecycle"]): SdkUiContext {
  return createPluginUiBridge({ get state() { return current().state; }, get components() { return current().host; }, get editor() { return current().host.editor.api; },
    get themes() { return current().themes; }, get commands() { return current().actions; }, lifecycle,
    dialogs: {
    async select(title, options, opts) {
      // Only an option that was actually shown can be chosen.
      const offered = options.slice(0, 64);
      const answer = await broker.askDialog(scope.sessionID, scope.directory, { method: "select", title, options: offered }, { signal: opts?.signal, timeout: opts?.timeout });
      return answer.cancelled || typeof answer.value !== "string" || !offered.includes(answer.value) ? undefined : answer.value;
    },
    async confirm(title, message, opts) {
      const answer = await broker.askDialog(scope.sessionID, scope.directory, { method: "confirm", title, message }, { signal: opts?.signal, timeout: opts?.timeout });
      return answer.confirmed === true && !answer.cancelled;
    },
    async input(title, placeholder, opts) {
      const answer = await broker.askDialog(scope.sessionID, scope.directory, { method: "input", title, ...(placeholder ? { placeholder } : {}) }, { signal: opts?.signal, timeout: opts?.timeout });
      return answer.cancelled ? undefined : answer.value;
    },
    async editor(title, prefill) {
      const answer = await broker.askDialog(scope.sessionID, scope.directory, { method: "editor", title, ...(prefill ? { prefill } : {}) });
      return answer.cancelled ? undefined : answer.value;
    },

    },
    notify(message, type) {
      journal.append(scope.directory, scope.sessionID, { type: "extension.notify",
        properties: { sessionID: scope.sessionID, level: type ?? "info", message: String(message).slice(0, 2000) } });
    },
  });
}
