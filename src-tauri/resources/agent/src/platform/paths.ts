// Runtime-owned on-disk layout. Every path is derived from the data directory
// the native supervisor passes in; nothing is resolved through the user's PATH
// and no external engine's directory is written.
//
//   <data>/runtime.sqlite            metadata, ledger, journal, queue, schedules
//   <data>/runtime.lock              single-writer ownership
//   <data>/sessions/                 Pi SDK session JSONL files (SESSION_LAYOUT)
//   <data>/attachments/<sha256>      prepared bytes of queued prompts
//   <data>/legacy/<archive-id>/      immutable legacy snapshots + manifests
//   <data>/staging/                  in-progress imports (journaled)
//   <data>/pi-agent/                 default Enki-owned Pi agentDir
//   <data>/../chats/<id>/            projectless chat folders (historical location)

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The ONE SDK-free contract for the LIVE mutable data layout. runtimePaths()
 * derives from it, and the trusted remote installer reads it from the verified
 * daemon-control bundle, so the updater can never preserve/restore a different
 * file than the runtime opens. `update-backups/<id>/state.sqlite` is a BACKUP
 * filename only, never a live database. */
export const DATA_LAYOUT = Object.freeze({
  database: "runtime.sqlite",
  databaseCompanions: Object.freeze(["runtime.sqlite-wal", "runtime.sqlite-shm", "runtime.sqlite-journal"] as const),
  sessions: "sessions",
  backups: "update-backups",
});

/** The ONE mutable layout inside `<data>/sessions`, shared by the SDK session
 * shards, journaled legacy continuations, writable Pi CLI imports and the
 * paired update snapshot (platform/update-snapshot.ts):
 *
 *   <sha16(cwd)>/<file>                      SDK sessions, branches, continuations
 *   <sha16(cwd)>/.legacy-continuations/      journaled continuation staging only
 *   pi-cli/pi-legacy-<48hex>/<file>          writable Pi CLI import: session.jsonl,
 *                                            ownership.json and SDK-created files
 */
export const SESSION_LAYOUT = Object.freeze({
  shard: /^[a-f0-9]{16}$/,
  continuationStaging: ".legacy-continuations",
  piCli: "pi-cli",
  piCliSession: /^pi-legacy-[a-f0-9]{48}$/,
  piCliTranscript: "session.jsonl",
  piCliOwnership: "ownership.json",
  file: /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/,
});

export interface RuntimePaths {
  data: string;
  db: string;
  sessions: string;
  legacy: string;
  staging: string;
  agentDir: string;
  chats: string;
}

export function runtimePaths(data: string, agentDir?: string): RuntimePaths {
  if (!path.isAbsolute(data)) throw new Error("Runtime data directory must be absolute.");
  const paths: RuntimePaths = {
    data,
    db: path.join(data, DATA_LAYOUT.database),
    sessions: path.join(data, DATA_LAYOUT.sessions),
    legacy: path.join(data, "legacy"),
    staging: path.join(data, "staging"),
    agentDir: agentDir && path.isAbsolute(agentDir) ? agentDir : path.join(data, "pi-agent"),
    // Projectless chat folders keep their historical location next to the
    // runtime data (<app data>/chats locally, ~/.local/share/enki/chats remotely).
    chats: path.join(path.dirname(data), "chats"),
  };
  for (const dir of [paths.data, paths.sessions, paths.legacy, paths.staging, paths.agentDir, paths.chats])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return paths;
}

export function directoryKey(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 16);
}

export function sessionDirFor(paths: RuntimePaths, directory: string): string {
  const dir = path.join(paths.sessions, directoryKey(directory));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The Pi CLI integration (≤0.2.115) keyed its session folders by FNV-1a 64. */
export function legacyPiDigest(directory: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(directory, "utf8")) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

/** A project directory must be an existing absolute directory. */
export function validDirectory(directory: string): boolean {
  if (!path.isAbsolute(directory) || directory.length > 4096 || directory.includes("\0")) return false;
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}
