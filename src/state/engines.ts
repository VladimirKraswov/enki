// Which agent drives a folder or chat.
//
// Since the Pi SDK migration there is exactly one executing agent: the bundled
// Enki Runtime, local or on the selected SSH host. Old preferences that named
// OpenCode or the Pi CLI per folder/chat (`projectEngine`, `sessionEngine`,
// `newChatEngine`) are ignored for execution. Old OpenCode chats are served
// read-only from the imported archive and continue only through an explicit
// continuation, never by re-sending their ids to another engine.

import { RUNTIME_AGENT_ID } from "../agent/runtime/ids";
import type { Prefs } from "./prefs";

export type EngineId = string;

export const DEFAULT_ENGINE: EngineId = RUNTIME_AGENT_ID;

export interface EngineOption {
  id: EngineId;
  label: string;
  available: boolean;
  reason?: string;
}

export function engineForDirectory(
  _prefs: Partial<Prefs>,
  _directory: string | null,
): EngineId {
  return DEFAULT_ENGINE;
}

/** Every chat — new, migrated or continued — runs on the runtime. */
export function engineForSession(
  _prefs: Partial<Prefs>,
  _sessionId: string | null,
  _directory: string | null,
): EngineId {
  return DEFAULT_ENGINE;
}

/**
 * The runtime runs where the workspace is: on this computer, or installed on the
 * selected SSH host. Connection failures are reported by the connection state,
 * not by hiding the agent.
 */
export function piAvailability(_prefs: Pick<Prefs, "activeHost">): {
  available: boolean;
  reason?: string;
} {
  return { available: true };
}

export function engineOptions(
  _prefs: Pick<Prefs, "activeHost">,
  _installed = true,
): EngineOption[] {
  return [{ id: DEFAULT_ENGINE, label: "Enki", available: true }];
}

/**
 * Model preference key. New choices use the plain key, which `chooseModel`
 * reads first; choices saved for former Pi CLI chats (`pi::…`) are still read
 * as a fallback (`legacyModelScope`). An unusable old choice is skipped by the
 * catalogue check, never sent.
 */
export function modelScope(_engine: EngineId, key: string): string {
  return key;
}

export function legacyModelScope(key: string): string {
  return `${RUNTIME_AGENT_ID}::${key}`;
}
