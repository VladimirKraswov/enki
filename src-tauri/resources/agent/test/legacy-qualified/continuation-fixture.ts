import fs from "node:fs";
import path from "node:path";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import { SessionCatalog } from "../../src/sessions/catalog.ts";
import { ContinuationImporter, type ContinuationSeed } from "../../src/legacy/continuation-import.ts";
import type { ContinuationReader } from "../../src/legacy/continuation.ts";
export const archive = "a".repeat(64);
export const seed: ContinuationSeed = (cwd, root, id, intro, messages) => {
  const timestamp = "2026-01-01T00:00:00.000Z", content = [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "custom_message", id: "00000001", parentId: null, timestamp, customType: intro.customType, content: intro.text, display: true, details: intro.details },
    ...messages.map((message, i) => ({ type: "message", id: (i + 2).toString(16).padStart(8, "0"), parentId: (i + 1).toString(16).padStart(8, "0"), timestamp, message })),
  ];
  const file = path.join(root, "seed.jsonl"); fs.writeFileSync(file, content.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  return { file, entryIds: messages.map((_message, i) => (i + 2).toString(16).padStart(8, "0")) };
};
export function setup(root: string, existing = false, seedPort = seed) {
  const sessions = path.join(root, "sessions"), staging = path.join(sessions, ".staging"), project = path.join(root, "selected-project");
  fs.mkdirSync(project, { recursive: true });
  const db = new Database(path.join(root, "metadata.sqlite")), events = new EventJournal(db), catalog = new SessionCatalog(db, events);
  if (!existing) catalog.insert({ id: "legacy-original", directory: "/never-open-raw-cwd", title: "Old", created: 1, updated: 2, archived: null, permission: null, parentId: null, sessionFile: null,
    origin: { kind: "opencode", archive, legacyId: "raw-original", readOnly: true }, workshop: true, model: null });
  const reader: ContinuationReader = {
    continuationMetadata: () => ({ format: "v1", contextEpoch: null, pendingInputs: 1, session: { id: "raw-original", directory: "/never-open-raw-cwd", title: "Old", parentId: null, created: 1, updated: 2, archived: null, permission: null } }),
    *messagePages() { yield [{ info: { id: "old-message", sessionID: "raw-original", role: "user", time: { created: 1 } }, parts: [{ id: "old-part", sessionID: "raw-original", messageID: "old-message", type: "text", text: "Archived user-only history" }] }]; },
  };
  return { sessions, staging, project, db, events, catalog, reader, importer: new ContinuationImporter(db, catalog, sessions, staging, seedPort), record: () => { const r = catalog.get("legacy-original"); if (!r) throw new Error("Missing original"); return r; } };
}
