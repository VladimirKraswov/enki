// State schema only: no singleton, transport, persistence or runtime initialization.
import type { DialogRequestDTO, QueueStateDTO } from '../../src-tauri/resources/agent/src/protocol';
import type { Prefs } from './prefs';
import type { CompactionConfig } from './context';
import type { ChatRootState } from './chatReducer';
import type { SidebarList, RecentList } from './sidebar';
import type { AgentInfo, Project, ProviderInfo, Session, SessionStatus, VcsInfo } from '../api/types';

export type ConnectionPhase =
  | "unknown"
  | "connecting"
  | "connected"
  | "disconnected"
  | "incompatible";

export interface ConnectionState {
  phase: ConnectionPhase;
  version: string | null;
  error: string | null;
  streamState:
    | "idle"
    | "connecting"
    | "open"
    | "reconnecting"
    | "closed"
    | "error";
  statusError?: string | null;
  globalStreamState?: ConnectionState["streamState"];
  lastEventAt: number;
  endpoint: string;
}

/** The connected Enki Runtime, as reported by its health endpoint. */
export interface RuntimeInfo {
  version: string;
  sdk: string;
  host: "local" | "remote";
  instance: string;
  /** Stable identity of this runtime's command ledger (survives restarts). */
  hostId?: string;
}

export interface UiState {
  remoteFolderOpen: boolean;
  hostDialogOpen: boolean;
  workspacePreparing: boolean;
  runtimeLoading: boolean;
  sessionListLoading: boolean;
  sessionListError: string | null;
  historyLoading: boolean;
  historyError: string | null;
  sending: boolean;
  archiveContinuing?: string | null;
  sendError: string | null;
  vcs: VcsInfo | null;
  settingsOpen: boolean;
  browserOpen: boolean;
  contextOpen: boolean;
  revealMessage: { server: string; directory: string | null; sessionID: string; messageID: string } | null;
  paletteOpen: boolean;
  confirmDelete: Session | null;
  handoffSource: Session | null;
  toast: string | null;
  /** Blocking extension dialog (confirm/input/select/editor) awaiting the user. Never auto-answered. */
  agentDialog: DialogRequestDTO | null;
  /** Extension status lines and widgets (text) for the open chat. */
  extensionStatus: Record<string, string>;
}

export interface AppState {
  prefs: Prefs;
  connection: ConnectionState;
  runtime: RuntimeInfo | null;
  projects: Project[];
  directory: string | null;
  sessions: Session[];
  archivedSessions: Session[];
  projectSessionLists: Record<string, SidebarList>;
  recentSessionList: RecentList;
  activeSessionId: string | null;
  statuses: Record<string, SessionStatus>;
  activityStatuses: Record<string, SessionStatus>;
  chat: ChatRootState;
  providers: ProviderInfo[];
  connectedProviderIds: string[];
  modelCatalogChecking?: boolean;
  providerDefaults: Record<string, string> | null;
  configDefaultAgent: string | null;
  configModel: string | null;
  compaction: CompactionConfig;
  agents: AgentInfo[];
  /** Runtime-owned prompt queues, mirrored from snapshots and `queue.updated`. */
  queues: Record<string, QueueStateDTO>;
  olderExhausted: Record<string, boolean>;
  historyCursors: Record<string, string | null>;
  ui: UiState;
  rev: number;
}
