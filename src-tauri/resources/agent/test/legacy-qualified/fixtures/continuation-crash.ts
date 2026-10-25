import fs from "node:fs";
import { setup } from "../continuation-fixture.ts";
const root = process.argv[2]; if (!root) throw new Error("Explicit owned fixture root required");
const f = setup(root, true), link = fs.linkSync;
fs.linkSync = (from, to) => {
  link(from, to);
  fs.writeSync(1, "ENKI_CONTINUATION_PUBLICATION_FAULT\n");
  process.kill(process.pid, "SIGKILL");
};
await f.importer.continue(f.record(), f.reader, { directory: f.project });
throw new Error("Expected owned child crash did not occur");
