import type { Prefs } from "./prefs";

/** Apply this host's committed directory moves before opening its saved chat.
 * Other hosts, transcript contents and session IDs are never rewritten. */
export function migrateDirectoryPrefs(prefs: Prefs, aliases: Record<string, string>): Prefs {
  const pairs = Object.entries(aliases).filter(([from, to]) => from !== to
    && (/^\//.test(from) || /^[A-Za-z]:[\\/]/.test(from))
    && (/^\//.test(to) || /^[A-Za-z]:[\\/]/.test(to))).sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return prefs;
  const move = (value: string): string => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      if (seen.has(value)) return [...seen][0];
      seen.add(value);
      const match = pairs.find(([from]) => value === from || value.startsWith(from + "/") || value.startsWith(from + "\\"));
      if (!match) return value;
      value = match[1] + value.slice(match[0].length);
    }
    return [...seen][0];
  };
  const list = (values?: string[]) => values && [...new Set(values.map(move))];
  const keyed = <T,>(values: Record<string, T> | undefined, drafts = false): Record<string, T> => {
    const out = { ...values };
    for (const [key, value] of Object.entries(values ?? {})) {
      const next = drafts && key.startsWith("new::") ? "new::" + move(key.slice(5)) : move(key);
      if (key === next) continue;
      if (!(next in out)) out[next] = value;
      else if (drafts && value && out[next] !== value) out[next] = [out[next], value].filter(Boolean).join("\n\n") as T;
      delete out[key];
    }
    return out;
  };
  const session = <T extends { directory: string }>(s: T): T => ({ ...s, directory: move(s.directory) });
  const workshop = prefs.workshop && { ...prefs.workshop, directory: move(prefs.workshop.directory),
    sourceDirectory: prefs.workshop.sourceDirectory && move(prefs.workshop.sourceDirectory), session: session(prefs.workshop.session) };
  return { ...prefs, selectedDirectory: prefs.selectedDirectory && move(prefs.selectedDirectory),
    workshop, pinnedProjects: list(prefs.pinnedProjects), hiddenProjects: list(prefs.hiddenProjects),
    expandedProjects: keyed(prefs.expandedProjects), projectlessDirectories: list(prefs.projectlessDirectories),
    projectlessRoot: prefs.projectlessRoot && move(prefs.projectlessRoot), projectlessSessions: prefs.projectlessSessions?.map(session),
    lastSessionByDir: keyed(prefs.lastSessionByDir), drafts: keyed(prefs.drafts, true), modelChoice: keyed(prefs.modelChoice),
    agentChoice: keyed(prefs.agentChoice), ptyIds: keyed(prefs.ptyIds),
    queues: prefs.queues && Object.fromEntries(Object.entries(prefs.queues).map(([id, items]) => [id, items.map(session)])),
    unreadSessions: prefs.unreadSessions && Object.fromEntries(Object.entries(prefs.unreadSessions).map(([id, item]) => [id, { ...item, ...(item.directory ? { directory: move(item.directory) } : {}) }])),
  };
}
