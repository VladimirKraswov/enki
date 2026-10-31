// Test fixtures may be reopened after harness.stop() by restart/recovery tests.
// Reclaim them when this test worker exits, not when one runtime stops.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const owned = new Set<string>();
process.once("exit", () => {
  for (const directory of owned) {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 }); }
    catch { process.stderr.write("Could not remove an owned Enki test fixture\n"); process.exitCode = 1; }
  }
});

export function tempDir(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `enki-${prefix}-`)));
  owned.add(directory);
  return directory;
}
