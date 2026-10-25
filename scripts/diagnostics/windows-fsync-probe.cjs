"use strict";

// Scratch diagnostic only. Exercise the real Node/OS syscalls on files that
// this process exclusively created; do not alter HOME/USERPROFILE or import
// any project/SDK code. A failed syscall stays a failed observation.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "enki-windows-fsync-probe-")));
const file = path.join(root, "owned.txt");
const bytes = Buffer.from("owned Windows fsync diagnostic\n", "utf8");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const sanitize = (value) => String(value).split(root).join("<owned-root>").slice(0, 6_000);
function errorInfo(error) {
  return Object.fromEntries(["name", "code", "errno", "syscall", "message", "stack"]
    .filter((key) => error && ["string", "number"].includes(typeof error[key]))
    .map((key) => [key, typeof error[key] === "number" ? error[key] : sanitize(error[key])]));
}
function emit(type, detail) {
  console.log("ENKI_WINDOWS_DIAGNOSTIC " + JSON.stringify({ type, ...detail }));
}

let failed = false;
try {
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  emit("platform", { platform: process.platform, node: process.version, ownedOnly: true, homeUnchanged: true });
  for (const [kind, target] of [["file", file], ["directory", root]]) {
    for (const flags of ["r", "r+"]) {
      let fd;
      let stage = "open";
      let operationError = null;
      let closeError = null;
      try {
        fd = fs.openSync(target, flags);
        stage = "fsync";
        fs.fsyncSync(fd);
        stage = "complete";
      } catch (error) {
        operationError = errorInfo(error);
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (error) { closeError = errorInfo(error); failed = true; }
        }
      }
      emit("fsync-mode", { kind, flags, stage, ok: operationError === null && closeError === null, error: operationError, closeError });
    }
  }
  const unchanged = fs.readFileSync(file).equals(bytes);
  emit("integrity", { unchanged, sha256: hash(fs.readFileSync(file)) });
  if (!unchanged) throw new Error("The owned probe file changed unexpectedly");
} catch (error) {
  failed = true;
  emit("probe-error", { error: errorInfo(error) });
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: false });
    emit("cleanup", { removed: !fs.existsSync(root) });
    if (fs.existsSync(root)) failed = true;
  } catch (error) {
    failed = true;
    emit("cleanup-error", { error: errorInfo(error) });
  }
}
process.exitCode = failed ? 1 : 0;
