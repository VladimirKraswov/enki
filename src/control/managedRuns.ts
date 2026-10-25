// Durable state for explicitly managed long-running agent tasks.
//
// The Enki Runtime owns the transcript and execution. Desktop persists only the small
// supervision contract needed to survive a UI restart: where the task lives,
// its completion marker and bounded recovery counters. No prompt, tool output,
// credential or permission answer is copied into this store.

export interface ManagedRun {
  version: 1;
  serverKey: string;
  sessionId: string;
  directory: string;
  boundaryMessageId: string | null;
  turnBoundaryMessageId: string | null;
  recoveredMessageIds: string[];
  malformedAttempts: number;
  continuationAttempts: number;
  maxContinuations: number;
  completionMarker: string | null;
  checkpointPath: string | null;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "ocdesktop.managed-runs.v1";
const MAX_RECORDS = 100;
const MAX_RECOVERED_IDS = 32;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const COMPLETION_MARKER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_CHECKPOINT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/ -]{1,240}$/;
let memoryFallback: Record<string, ManagedRun> = {};

function key(serverKey: string, sessionId: string): string {
  return `${serverKey.length}:${serverKey}${sessionId}`;
}

function validRun(value: unknown): value is ManagedRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<ManagedRun>;
  const boundedString = (item: unknown, max: number) =>
    typeof item === "string" && item.length > 0 && item.length <= max;
  const boundedInteger = (item: unknown, min: number, max: number) =>
    Number.isInteger(item) && (item as number) >= min && (item as number) <= max;
  return (
    run.version === 1 &&
    boundedString(run.serverKey, 4096) &&
    boundedString(run.sessionId, 512) &&
    boundedString(run.directory, 4096) &&
    (run.boundaryMessageId === null || boundedString(run.boundaryMessageId, 512)) &&
    (run.turnBoundaryMessageId === null || boundedString(run.turnBoundaryMessageId, 512)) &&
    Array.isArray(run.recoveredMessageIds) &&
    run.recoveredMessageIds.length <= MAX_RECOVERED_IDS &&
    run.recoveredMessageIds.every((id) => boundedString(id, 512)) &&
    boundedInteger(run.malformedAttempts, 0, 2) &&
    boundedInteger(run.continuationAttempts, 0, 20) &&
    boundedInteger(run.maxContinuations, 0, 20) &&
    (run.continuationAttempts as number) <= (run.maxContinuations as number) &&
    (run.completionMarker === null ||
      (typeof run.completionMarker === "string" && COMPLETION_MARKER.test(run.completionMarker))) &&
    (run.checkpointPath === null ||
      (typeof run.checkpointPath === "string" && SAFE_CHECKPOINT_PATH.test(run.checkpointPath))) &&
    typeof run.createdAt === "number" &&
    Number.isFinite(run.createdAt) &&
    run.createdAt >= 0 &&
    typeof run.updatedAt === "number" &&
    Number.isFinite(run.updatedAt) &&
    run.updatedAt >= run.createdAt
  );
}

function readAll(now = Date.now()): Record<string, ManagedRun> {
  let parsed: unknown = memoryFallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // The in-memory copy still gives deterministic behavior for this process.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const entries = Object.entries(parsed)
    .filter((entry): entry is [string, ManagedRun] => validRun(entry[1]))
    .filter(([, run]) => now - run.updatedAt <= MAX_AGE_MS)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_RECORDS);
  return Object.fromEntries(entries);
}

function writeAll(runs: Record<string, ManagedRun>): void {
  memoryFallback = runs;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  } catch {
    // A storage failure must not turn a bounded foreground wait into a crash.
  }
}

export function getManagedRun(serverKey: string, sessionId: string): ManagedRun | null {
  return readAll()[key(serverKey, sessionId)] ?? null;
}

export function putManagedRun(run: ManagedRun): ManagedRun {
  const normalized: ManagedRun = {
    ...run,
    recoveredMessageIds: [...new Set(run.recoveredMessageIds)].slice(-MAX_RECOVERED_IDS),
    updatedAt: Date.now(),
  };
  const runs = readAll();
  runs[key(run.serverKey, run.sessionId)] = normalized;
  const bounded = Object.fromEntries(
    Object.entries(runs)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_RECORDS),
  );
  writeAll(bounded);
  return normalized;
}

export function removeManagedRun(serverKey: string, sessionId: string): void {
  const runs = readAll();
  delete runs[key(serverKey, sessionId)];
  writeAll(runs);
}

export function listManagedRuns(serverKey: string): ManagedRun[] {
  return Object.values(readAll())
    .filter((run) => run.serverKey === serverKey)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function managedRunSummary(run: ManagedRun | null) {
  if (!run) return null;
  return {
    completionMarker: run.completionMarker,
    checkpointPath: run.checkpointPath,
    malformedAttempts: run.malformedAttempts,
    continuationAttempts: run.continuationAttempts,
    maxContinuations: run.maxContinuations,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function resetManagedRunsForTest(): void {
  memoryFallback = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Tests without DOM storage use only the fallback.
  }
}
