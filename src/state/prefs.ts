import type { BrowserPreferences } from "../browser/integration";
import { DEFAULT_APPEARANCE, normalizeAppearance, type Appearance } from "./appearance";
import type { RemoteHost } from "../native/hosts";
import type { Session, PermissionRule } from "../api/types";
import type { QueuedPrompt } from "./queue";
import type { AccessMode } from "./access";
import { defaultAsr, type AsrSettings } from "../voice/asr";
import { DEFAULT_HELPER_ENDPOINT } from "../attachments/helper";
// Persisted shell preferences. The shell owns theme/layout/directories/drafts;
// the Enki Runtime owns sessions, queues, schedules, models and credentials.

/**
 * Metadata the former Pi CLI bridge kept for its chats. Read only once, to
 * register those transcripts with the runtime (`/v1/migrations/pi-cli`).
 */
export interface PiSessionMeta {
  id: string;
  directory: string;
  title: string;
  created: number;
  updated: number;
  archived?: number;
  /** Set when this chat was carried over from another engine. */
  handoffFrom?: string;
  permission?: PermissionRule[];
}

/** Enki-side agent preferences; runtime settings themselves live in the runtime. */
export interface AgentPrefs {
  /** Absolute language-server paths tried before the built-in candidates. */
  lspServerPaths?: string[];
  /** One-time imports already performed for this workspace. */
  migrated?: { opencode?: number; piCli?: number; piAgent?: number; queues?: number; schedules?: number;
    /** Per workspace: the pre-2.0 inherited tool policy was carried into the runtime default once. */
    policy?: Record<string, number> };
}

/**
 * Settings of the former Pi CLI bridge. Read only to carry LSP paths and the
 * tool policy into the runtime once; never used to launch anything.
 */
export interface PiSettings {
  /** Absolute path override when Pi is not in a known location. */
  program?: string;
  /** Optional absolute Node.js executable for an env-node Pi installation. */
  nodeProgram?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  /** Absolute paths of Pi extensions to load (e.g. the LSP extension). */
  extensions?: string[];
  lspEnabled?: boolean;
  /**
   * Approval policy for Pi's built-in tools. "ask" is the safe default and the
   * value used when this is unset; "full" is only ever set by an explicit,
   * informed choice in settings.
   */
  toolPolicy?: "ask" | "full";
  /**
   * Explicit `provider/model` the user pinned, used even when Pi's bundled
   * catalog does not list it (Pi itself accepts such ids as custom models).
   */
  customModel?: string;
  /** `provider/model` that answered a real request; evidence, not a promise. */
  verifiedModel?: string;
  /** Models that answered a real Pi request, keyed by provider/model. */
  verifiedModels?: Record<string, number>;
  /**
   * Absolute paths to language servers, tried before the built-in candidates.
   * Needed on macOS, where an app launched from Finder inherits neither
   * `/opt/homebrew/bin` nor `~/.cargo/bin`.
   */
  lspServerPaths?: string[];
}

export interface Prefs {
  workshop?: import("../workshop/workspace").WorkshopRecord;
  recoveredOperations?: string[];
  /** Audio is removed only after its text and receipt are durably saved together. */
  dictationReceipts?: string[];
  modelServices?: import("../models/services").ModelService[];
  /** Local application of the shared Hub model catalog; the catalog itself lives on Hub. */
  hubModels?: import("../models/catalog").HubModelsPrefs;
  appearance: Appearance;
  /** Local browser lifecycle and executable choice; engines retain their own permissions. */
  browser?: BrowserPreferences;
  /** Explicit browser-task profiles; selected model/permissions remain independent. */
  browserTasks?: Record<string, { previousVariant?: string | null; appliedVariant?: string | null; providerID: string; modelID: string }>;
  /** Legacy (read for one-time import only). */
  piSessions?: Record<string, PiSessionMeta>;
  /** Where a chat's starting context came from (handoff provenance banner). */
  handoffOrigins?: Record<
    string,
    {
      from: string;
      fromEngine: string;
      title: string;
      directory: string;
      omitted: number;
    }
  >;
  /** Legacy (read for one-time import only). */
  pi?: PiSettings;
  agent?: AgentPrefs;
  // Stable workspace identity, independent of the runtime's ephemeral port.
  workspaceKey?: string;
  /** Stable identity of this computer's workspace (kept from earlier versions). */
  localWorkspace?: string;
  activeHost?: string;
  /** Legacy: the old local engine origin, used only to derive `localWorkspace`. */
  localEndpoint?: string;
  remoteHosts?: RemoteHost[];
  projectlessDirectories?: string[];
  projectlessSessions?: Session[];
  projectlessRoot?: string;
  newChatMode?: "project" | "projectless";
  // Completion attention belongs to this server and survives app restarts.
  unreadSessions?: Record<string, { time: number; directory?: string }>;

  /** Legacy UI-owned queues: backup kept per item until its runtime cutover receipt is accepted/resolved. */
  queues?: Record<string, QueuedPrompt[]>;
  newAccess?: AccessMode;
  asr?: AsrSettings;
  helperEndpoint?: string;
  endpointState?: Record<string, Partial<Prefs>>;
  pinnedProjects?: string[];
  /** Once per workspace: retire empty native-task pins left by the old control API. */
  projectPinCleanup?: Record<string, boolean>;
  hiddenProjects?: string[];
  expandedProjects?: Record<string, boolean>;
  endpoint: string;
  theme: "light" | "dark" | "system";
  selectedDirectory: string | null;
  lastSessionByDir: Record<string, string>;
  drafts: Record<string, string>;
  layout: {
    sidebarOpen: boolean;
    sidebarWidth: number;
    rightWidth: number;
    browserWidth: number;
    bottomHeight: number;
    rightOpen: boolean;
    bottomOpen: boolean;
    rightTab: "files" | "changes";
  };
  modelChoice: Record<
    string,
    { providerID: string; modelID: string; variant?: string | null }
  >; // by directory for new chats, or session:<id> for an existing chat
  agentChoice: Record<string, string>; // same key scheme as modelChoice
  ptyIds: Record<string, string>; // directory -> shell created by this app (never hijack foreign PTYs)
}

export const DEFAULT_PREFS: Prefs = {
  appearance: DEFAULT_APPEARANCE,
  endpoint: "http://127.0.0.1:4096",
  theme: "dark",
  asr: defaultAsr,
  helperEndpoint: DEFAULT_HELPER_ENDPOINT,
  selectedDirectory: null,
  lastSessionByDir: {},
  drafts: {},
  layout: {
    sidebarOpen: true,
    sidebarWidth: 252,
    rightWidth: 380,
    browserWidth: 420,
    bottomHeight: 260,
    rightOpen: false,
    bottomOpen: false,
    rightTab: "changes",
  },
  modelChoice: {},
  agentChoice: {},
  ptyIds: {},
};

const KEY = "ocdesktop.prefs.v1";

function restoredWorkshop(value: Prefs["workshop"]): Prefs["workshop"] {
  return value && typeof value.directory === "string" && !!value.directory &&
    value.session && typeof value.session.id === "string" && !!value.session.id &&
    value.session.directory === value.directory && typeof value.session.title === "string" &&
    value.session.time && Number.isFinite(value.session.time.created) && Number.isFinite(value.session.time.updated) &&
    (value.sourceDirectory === null || typeof value.sourceDirectory === "string") ? value : undefined;
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    localStorageHadPrefs = true;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      workshop: restoredWorkshop(parsed.workshop),
      appearance: normalizeAppearance(parsed.appearance),
      asr: parsed.asr?.endpoint?.trim() ? parsed.asr : defaultAsr,
      layout: { ...DEFAULT_PREFS.layout, ...(parsed.layout ?? {}) },
      lastSessionByDir: parsed.lastSessionByDir ?? {},
      drafts: parsed.drafts ?? {},
      modelChoice: parsed.modelChoice ?? {},
      agentChoice: parsed.agentChoice ?? {},
      ptyIds: parsed.ptyIds ?? {},
      queues: Object.fromEntries(
        Object.entries(parsed.queues ?? {}).map(([id, list]) => [
          id,
          list.map((item) =>
            item.state === "sending"
              ? { ...item, state: "uncertain" as const }
              : item,
          ),
        ]),
      ),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPrefs: Prefs | null = null;
export function flushPrefs(): boolean {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const prefs = pendingPrefs;
  if (!prefs) return true;
  try {
    const keys = Object.keys(prefs.drafts);
    const drafts =
      keys.length > 200
        ? Object.fromEntries(keys.slice(-200).map((k) => [k, prefs.drafts[k]]))
        : prefs.drafts;
    localStorage.setItem(KEY, JSON.stringify({ ...prefs, drafts }));
    pendingPrefs = null;
    return true;
  } catch {
    /* Keep pending state available for a later retry. */
    return false;
  }
}
export function savePrefs(prefs: Prefs): void {
  pendingPrefs = prefs;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPrefs, 400);
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPrefs);
  import.meta.hot?.dispose(() => {
    flushPrefs();
    window.removeEventListener("pagehide", flushPrefs);
  });
}

/**
 * Stable key of this computer's workspace. Earlier versions keyed it by the
 * local engine origin; keeping that value preserves drafts, attachments,
 * unread markers and imported chats (which keep their original ids).
 */
export function localWorkspaceKey(prefs: Pick<Prefs, "localWorkspace" | "localEndpoint" | "workspaceKey" | "endpoint">, fresh: string): string {
  if (prefs.localWorkspace) return prefs.localWorkspace;
  if (prefs.localEndpoint) return prefs.localEndpoint;
  if (prefs.workspaceKey && !prefs.workspaceKey.startsWith("ssh:")) return prefs.workspaceKey;
  return localStorageHadPrefs ? prefs.endpoint : fresh;
}
let localStorageHadPrefs = false;

export function draftKey(
  sessionId: string | null,
  directory: string | null,
): string {
  return sessionId ?? `new::${directory ?? ""}`;
}

/**
 * Before 2.0 the local workspace snapshot was keyed by the old local engine
 * origin (`localWorkspace`/`localEndpoint`, e.g. an OpenCode URL); 2.0 keys it
 * by the stable local runtime key. When the user was on a remote host at
 * upgrade time, a later remote→local switch must find that snapshot by its
 * stable identity. Never crosses local/remote: SSH keys are never candidates.
 */
export function legacyLocalSnapshotKey(prefs: Prefs, localKey: string): string | null {
  if (localKey.startsWith("ssh:") || prefs.endpointState?.[localKey]) return null;
  for (const candidate of [prefs.localWorkspace, prefs.localEndpoint])
    if (candidate && candidate !== localKey && !candidate.startsWith("ssh:") && prefs.endpointState?.[candidate]) return candidate;
  return null;
}

/** Copy (not move) a saved snapshot to its new stable key; the old entry stays as a backup. */
export function adoptSnapshot(prefs: Prefs, from: string, to: string): Prefs {
  const saved = prefs.endpointState?.[from];
  if (!saved || prefs.endpointState?.[to]) return prefs;
  return { ...prefs, endpointState: { ...prefs.endpointState, [to]: { ...saved } } };
}

/** Server-owned IDs and drafts never migrate into another endpoint's workspace. */
export function switchEndpointPrefs(
  prefs: Prefs,
  endpoint: string,
  workspaceKey = endpoint,
): Prefs {
  const { endpointState = {}, ...current } = prefs;
  const saved = endpointState[workspaceKey];
  return {
    ...DEFAULT_PREFS,
    layout: prefs.layout,
    ...saved,
    workshop: restoredWorkshop(saved?.workshop),
    // The CPU helper, speech recognizer, browser and legacy Pi metadata belong
    // to this computer, not to one runtime workspace.
    asr: prefs.asr,
    helperEndpoint: prefs.helperEndpoint,
    modelServices: prefs.modelServices,
    pi: prefs.pi,
    agent: prefs.agent,
    browser: prefs.browser,
    browserTasks: prefs.browserTasks,
    piSessions: prefs.piSessions,
    handoffOrigins: prefs.handoffOrigins,
    // Appearance belongs to the app, not to a cached remote workspace.
    theme: prefs.theme,
    appearance: normalizeAppearance(prefs.appearance),
    queues: Object.fromEntries(
      Object.entries(saved?.queues ?? {}).map(([id, list]) => [
        id,
        list.map((item) =>
          item.state === "sending"
            ? { ...item, state: "uncertain" as const }
            : item,
        ),
      ]),
    ),
    endpoint,
    workspaceKey,
    activeHost: prefs.activeHost,
    localEndpoint: prefs.localEndpoint,
    localWorkspace: prefs.localWorkspace,
    remoteHosts: prefs.remoteHosts,
    endpointState: {
      ...endpointState,
      [prefs.workspaceKey ?? prefs.endpoint]: current,
    },
  };
}
