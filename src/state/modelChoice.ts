import type { AppState } from './types';
import type { Session } from '../api/types';
export interface ModelChoice { providerID: string; modelID: string; variant?: string | null }
/** Selection policy on already-normalized data. No network, probes, writes or silent fallback. */
export function chooseModel(state: AppState, context: {
  projectless: boolean; activeModel?: Session['model'];
  defaultVariant: (providerID: string, modelID: string) => string | null;
}): ModelChoice | null {
    const dir = context.projectless ? "@chats" : (state.directory ?? "");
    const sessionId = state.activeSessionId;
    const availableDefault = (pid: string, mid: string) => {
      const model = state.providers.find(p => p.id === pid)?.models[mid];
      // Older runtimes may name a valid custom default before listing it.
      // A current explicit denial wins; absence of the additive field keeps
      // the existing default contract rather than erasing the owner's choice.
      return !model?.access || model.access.state === "available";
    };
    const configured = (pid: string, mid: string) => state.connectedProviderIds.includes(pid) ||
      state.providers.some(p => p.id === pid && p.source === "config" && Boolean(p.models[mid])) ||
      state.prefs.modelServices?.some(s => s.providerID === pid && Boolean(s.bindings[mid]));
    const sessionChoice = sessionId
      ? legacyModelChoice(state, `session:${sessionId}`)
      : undefined;
    if (sessionChoice && configured(sessionChoice.providerID, sessionChoice.modelID))
      return sessionChoice;
    const active = sessionId
      ? context.activeModel
      : undefined;
    if (active?.id && configured(active.providerID, active.id)) {
      return {
        providerID: active.providerID,
        modelID: active.id,
        variant: active.variant ?? null,
      };
    }
    const stored = legacyModelChoice(state, dir || "*") ?? legacyModelChoice(state, "*");
    if (stored && configured(stored.providerID, stored.modelID))
      return stored;
    const configuredDefault = state.configModel?.split("/");
    if (
      configuredDefault &&
      configuredDefault.length > 1 &&
      state.connectedProviderIds.includes(configuredDefault[0]) && availableDefault(configuredDefault[0], configuredDefault.slice(1).join("/"))
    ) {
      return {
        providerID: configuredDefault[0],
        modelID: configuredDefault.slice(1).join("/"),
        variant: context.defaultVariant(
          configuredDefault[0],
          configuredDefault.slice(1).join("/"),
        ),
      };
    }
    const defaults = state.providerDefaults;
    if (defaults) {
      for (const [pid, mid] of Object.entries(defaults)) {
        if (state.connectedProviderIds.includes(pid) && availableDefault(pid, mid))
          return {
            providerID: pid,
            modelID: mid,
            variant: context.defaultVariant(pid, mid),
          };
      }
    }
    for (const pid of state.connectedProviderIds) {
      const provider = state.providers.find((p) => p.id === pid);
      const first = provider && Object.values(provider.models).find(m => availableDefault(pid, m.id));
      if (first)
        return {
          providerID: pid,
          modelID: first.id,
          variant: context.defaultVariant(pid, first.id),
        };
    }
    return null;
}

export function parseModelId(
  value: string | undefined | null,
): { providerID: string; modelID: string } | null {
  const parts = (value ?? "").trim().split("/");
  if (parts.length < 2 || !parts[0] || !parts.slice(1).join("/")) return null;
  return { providerID: parts[0], modelID: parts.slice(1).join("/") };
}

/** Choices saved for former Pi CLI chats (`pi::<scope>`) still resolve after the migration. */
export function legacyModelChoice(state: AppState, key: string): ModelChoice | undefined {
  return state.prefs.modelChoice[key] ?? state.prefs.modelChoice[`pi::${key}`];
}
