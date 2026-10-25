// Caller owns preference loading. Construct fresh transient containers per store.
import type { AppState } from './types';
import type { Prefs } from './prefs';
import { emptyRecentList } from './sidebar';
import { emptyChatRoot } from './chatReducer';

export function initialState(prefs: Prefs): AppState {
  return {
    prefs,
    connection: {
      phase: "unknown",
      version: null,
      error: null,
      streamState: "idle",
      lastEventAt: 0,
      endpoint: prefs.endpoint,
    },
    runtime: null,
    projects: [],
    directory: prefs.selectedDirectory,
    sessions: [],
    archivedSessions: [],
    projectSessionLists: {},
    recentSessionList: emptyRecentList(),
    activeSessionId: prefs.selectedDirectory
      ? (prefs.lastSessionByDir[prefs.selectedDirectory] ?? null)
      : null,
    statuses: {},
    activityStatuses: {},
    chat: emptyChatRoot(),
    providers: [],
    connectedProviderIds: [],
    providerDefaults: null,
    configDefaultAgent: null,
    configModel: null,
    compaction: {},
    agents: [],
    queues: {},
    olderExhausted: {},
    historyCursors: {},
    ui: {
      remoteFolderOpen: false,
      hostDialogOpen: false,
      workspacePreparing: false,
      runtimeLoading: false,
      sessionListLoading: false,
      sessionListError: null,
      historyLoading: false,
      historyError: null,
      sending: false,
      sendError: null,
      vcs: null,
      settingsOpen: false,
      browserOpen: false,
      contextOpen: false,
      revealMessage: null,
      paletteOpen: false,
      confirmDelete: null,
      handoffSource: null,
      toast: null,
      agentDialog: null,
      extensionStatus: {},
    },
    rev: 0,
  };
}
