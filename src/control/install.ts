import { store } from "../state/store";
import { AGENT_CONTROL_SERVER, setReservedServer } from "../capabilities/reserved";
import type { AgentControlStatus } from "../state/agentControl";

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return (await import("@tauri-apps/api/core")).invoke<T>(command, args);
}

/**
 * Install/disable only this app's reserved control MCP in the global shared
 * registry (compare-and-swap). The agent runtime loads it for new sessions.
 */
export async function installAgentControlMcp(enabled: boolean): Promise<string> {
  if (store.currentHost())
    throw new Error("Для регистрации локальной команды выберите «Этот компьютер».");
  if (
    [...Object.values(store.state.activityStatuses), ...Object.values(store.state.statuses)]
      .some((item) => item.type === "busy" || item.type === "retry")
  )
    throw new Error("Дождитесь завершения работающего агента перед изменением подключений.");
  const status = await invoke<AgentControlStatus>("agent_control_status");
  if (!status.ready) throw new Error("Локальный шлюз ещё запускается.");
  const catalog = await setReservedServer(AGENT_CONTROL_SERVER, enabled);
  if (!enabled) return "MCP управления отключён; обычная работа Enki не изменена.";
  return catalog.runtimeReady
    ? "API управления сохранён в общих MCP-подключениях и загрузится в новых чатах агента."
    : "API управления сохранён. Установите общие MCP-инструменты в настройках, чтобы агент мог его загрузить.";
}
