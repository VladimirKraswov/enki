// Explicit read-only-archive -> new SDK-owned session. Publication, catalog
// links and restart recovery are owned here; no historical prompt is sent.
import path from "node:path";
import { seedSession } from "../sdk/adapter.ts";
import type { SessionCatalog, SessionRecord } from "../sessions/catalog.ts";
import type { Database } from "../store/db.ts";
import type { MessageDTO } from "./protocol.ts";
import { convertTranscript, type ContinuationReader } from "./continuation.ts";
import { ContinuationImporter, type ContinueOptions } from "./continuation-import.ts";
import { HASH } from "./files.ts";
export type Conversion = ReturnType<typeof convertTranscript>;

/** Compatibility utility; full archive continuation additionally applies
 * read-only reader metadata (revert, compaction, chronology and pending inbox). */
export function convertLegacy(transcript: readonly MessageDTO[], archive: string): Conversion {
  if (!HASH.test(archive)) throw new Error("Неверный исходный архив.");
  return convertTranscript(transcript);
}
export async function continueLegacy(db: Database, catalog: SessionCatalog, record: SessionRecord, reader: ContinuationReader,
  sessionDir: string, options: ContinueOptions): Promise<SessionRecord> {
  return new ContinuationImporter(db, catalog, sessionDir, path.join(sessionDir, ".legacy-continuations"), seedSession).continue(record, reader, options);
}
/** Call for each app-owned session directory before admitting workers. Only
 * that explicit directory's journal rows/files are recovered. */
export function recoverLegacyContinuations(db: Database, catalog: SessionCatalog, sessionDir: string): void {
  new ContinuationImporter(db, catalog, sessionDir, path.join(sessionDir, ".legacy-continuations"), seedSession).recover();
}
