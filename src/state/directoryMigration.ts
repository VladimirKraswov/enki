import type { Prefs } from "./prefs";

/** Apply this host's committed directory moves before opening its saved chat.
 * Other hosts, transcript contents and session IDs are never rewritten. */
export function migrateDirectoryPrefs(prefs: Prefs, aliases: Record<string, string>): Prefs {
  const canonicalKey = (value: string): string => /^[A-Za-z]:[\\/]/.test(value) ? value.replace(/\\/g, '/').toLowerCase() : value;
  const pairs = Object.entries(aliases).filter(([from, to]) => from !== to
    && (/^\//.test(from) || /^[A-Za-z]:[\\/]/.test(from))
    && (/^\//.test(to) || /^[A-Za-z]:[\\/]/.test(to))).sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return prefs;
  const move = (value: string): string => {
    const original = value;
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const current = canonicalKey(value);
      if (seen.has(current)) return original;
      seen.add(current);
      const matches = pairs.filter(([from]) => current === canonicalKey(from) || current.startsWith(canonicalKey(from) + "/") || current.startsWith(canonicalKey(from) + "\\"));
      const match = matches[0];
      if (!match) return value;
      if (matches.some(([from,to]) => canonicalKey(from) === canonicalKey(match[0]) && canonicalKey(to) !== canonicalKey(match[1]))) return original;
      value = match[1] + value.slice(match[0].length);
      // A case/slash-only canonical spelling is a completed move, not a loop.
      if (canonicalKey(value) === current) return value;
    }
    return original;
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
