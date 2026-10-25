// Child fixture for snapshot-crash.test.ts; only its own temporary root is used.
import fs from "node:fs";
import path from "node:path";
import { OpenCodeImporter } from "../../../src/legacy/opencode-import.ts";
import { Database } from "../../../src/store/db.ts";
import { EventJournal } from "../../../src/store/events.ts";
import { SessionCatalog } from "../../../src/sessions/catalog.ts";

const root = process.argv[2];
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith("enki-import-crash-")) process.exit(90);
const archiveRoot = path.join(root, "archives");
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (path.dirname(String(to)) === archiveRoot && /^[a-f0-9]{64}$/.test(path.basename(String(to)))) process.exit(86);
};
const db = new Database(path.join(root, "runtime.sqlite"));
const catalog = new SessionCatalog(db, new EventJournal(db));
const importer = new OpenCodeImporter(db, catalog, archiveRoot, path.join(root, "staging"));
await importer.import(path.join(root, "source.sqlite"));
process.exit(91); // Fault injection did not hit: the parent must fail, not pass.
