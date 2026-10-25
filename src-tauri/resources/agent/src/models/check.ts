// Explicit, user-triggered proof that a model answers: the smallest real
// request in an in-memory, tool-less session that leaves no transcript.
// A configured catalog entry proves nothing about credentials or entitlement.

import { findModel, openAgentSession, shutdownSession, type SdkAssistantMessage, type SdkModelRuntime, type SettingsSpec } from "../sdk/adapter.ts";

export async function checkModelAccess(runtime: SdkModelRuntime, options: { providerID: string; modelID: string; cwd: string; agentDir: string; settings: SettingsSpec; signal: AbortSignal }): Promise<string> {
  const model = findModel(runtime, options.providerID, options.modelID);
  if (!model) throw new Error(`Модель ${options.providerID}/${options.modelID} не найдена в каталоге Pi.`);
  const opened = await openAgentSession({
    cwd: options.cwd, agentDir: options.agentDir, sessionDir: options.cwd, modelRuntime: runtime, settings: { ...options.settings, retry: { enabled: false } },
    resources: { extensions: [], extensionPaths: [], skillPaths: [], promptPaths: [], noDiscoveredExtensions: true, projectTrusted: async () => false },
    model, ephemeral: true,
  });
  const session = opened.session;
  const abort = () => { void session.abort(); };
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 60_000);
  try {
    await session.prompt("Reply with exactly: OK", { source: "rpc", expandPromptTemplates: false });
    const last = [...session.messages].reverse().find((m): m is SdkAssistantMessage => m.role === "assistant");
    const text = last?.content.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    if (options.signal.aborted) throw new Error("Проверка отменена.");
    if (!last || last.stopReason === "error" || last.stopReason === "aborted" || !text)
      throw new Error(last?.errorMessage ? `Модель не ответила: ${last.errorMessage.slice(0, 300)}` : "Модель не ответила на тестовый запрос за 60 с.");
    return "Модель ответила на тестовый запрос.";
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    await shutdownSession(session, "quit").catch(() => undefined);
  }
}
