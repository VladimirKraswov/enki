import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("reclaims only this worker's fixtures at exit, preserving them across runtime stops", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "enki-cleanup-proof-"));
  const keep = path.join(outside, "keep.txt"); fs.writeFileSync(keep, "keep");
  try {
    const module = new URL("./temp-files.ts", import.meta.url).href;
    const code = `import {tempDir} from ${JSON.stringify(module)}; import fs from 'node:fs';
      const dir=tempDir('cleanup-proof'); fs.writeFileSync(dir+'/session.jsonl','preserved-until-exit');
      fs.symlinkSync(${JSON.stringify(outside)},dir+'/outside');
      if(fs.readFileSync(dir+'/session.jsonl','utf8')!=='preserved-until-exit') throw Error('lost fixture');
      console.log(JSON.stringify(dir));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(fs.existsSync(JSON.parse(child.stdout.trim()))).toBe(false);
    expect(fs.readFileSync(keep, "utf8")).toBe("keep");
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
