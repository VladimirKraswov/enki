// Actual owned filesystem descriptors; no provider, SDK loop or external data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncOwnedDirectory, syncOwnedFile } from "../src/platform/owned-sync.ts";
import { openRegular, readStable, writeOwned } from "../src/legacy/files.ts";
import { AttachmentStore } from "../src/store/attachments.ts";
import { Database } from "../src/store/db.ts";

let root = "";
beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "enki-owned-sync-"))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const file = (name = "owned.txt") => path.join(root, name);

it("really flushes owned file and directory without changing bytes or file mode", () => {
  fs.writeFileSync(file(), "own bytes\n", { flag: "wx", mode: 0o600 });
  const before = fs.statSync(file());
  syncOwnedFile(file()); syncOwnedDirectory(root);
  expect(fs.readFileSync(file(), "utf8")).toBe("own bytes\n");
  expect(fs.statSync(file()).mode).toBe(before.mode);
});

it("rejects links and wrong types without following them into another destination", () => {
  const outside = file("other.txt"), link = file("link.txt");
  fs.writeFileSync(outside, "untouched"); fs.symlinkSync(outside, link, "file");
  expect(() => syncOwnedFile(link)).toThrow(/подменён|тип/);
  expect(() => syncOwnedFile(root)).toThrow(/подменён|тип/);
  expect(() => syncOwnedDirectory(outside)).toThrow(/подменён|тип/);
  expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
});

it("propagates the original flush error and closes both file and directory descriptors", () => {
  fs.writeFileSync(file(), "own");
  const actualOpen = fs.openSync;
  const descriptors: number[] = [];
  vi.spyOn(fs, "openSync").mockImplementation((...args) => { const fd = actualOpen(...args); descriptors.push(fd); return fd; });
  const failure = Object.assign(new Error("owned flush failed"), { code: "EIO" });
  vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw failure; });
  expect(() => syncOwnedFile(file())).toThrow(failure);
  expect(() => syncOwnedDirectory(root)).toThrow(failure);
  expect(descriptors).toHaveLength(2);
  for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
});

it("a pathname replaced between lstat and open is refused and the opened descriptor is closed", () => {
  const target = file(), aside = file("original.txt");
  fs.writeFileSync(target, "original");
  const actualOpen = fs.openSync;
  let replaced = false, opened: number | undefined;
  vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    if (String(args[0]) === target && !replaced) {
      replaced = true;
      fs.renameSync(target, aside); fs.writeFileSync(target, "replacement", { flag: "wx" });
      opened = actualOpen(...args); return opened;
    }
    return actualOpen(...args);
  });
  expect(() => syncOwnedFile(target)).toThrow(/изменился/);
  expect(opened).toBeTypeOf("number");
  expect(() => fs.fstatSync(opened!)).toThrow(/EBADF/);
  expect(fs.readFileSync(aside, "utf8")).toBe("original");
  expect(fs.readFileSync(target, "utf8")).toBe("replacement");
});

it("owned immutable outputs flush on their exclusive writer before becoming readonly; source readers stay readonly", () => {
  const target = file(), observedModes: number[] = [], actualSync = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { observedModes.push(fs.fstatSync(fd).mode); actualSync(fd); });
  writeOwned(target, "legacy source copy", true);
  expect(observedModes).toHaveLength(1);
  expect(observedModes[0]! & 0o200).toBe(0o200);
  expect(fs.statSync(target).mode & 0o200).toBe(0);
  const actualOpen = fs.openSync, modes: Array<string | number> = [];
  vi.spyOn(fs, "openSync").mockImplementation((...args) => { modes.push(args[1]); return actualOpen(...args); });
  expect(readStable(target, 1024).toString()).toBe("legacy source copy");
  const fd = openRegular(target); fs.closeSync(fd);
  expect(modes).toHaveLength(2);
  for (const mode of modes) expect(typeof mode === "number" && (mode & 3) === fs.constants.O_RDONLY).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("legacy source copy");
});

it("AttachmentStore closes its exclusive stage when flush fails and publishes no blob or DB reference", () => {
  const db = new Database(file("runtime.sqlite"));
  try {
    const store = new AttachmentStore(db, root), actualOpen = fs.openSync;
    let staged: number | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const fd = actualOpen(...args);
      if (String(args[0]).endsWith(".part")) { expect(args[1]).toBe("wx"); staged = fd; }
      return fd;
    });
    const failure = Object.assign(new Error("attachment fsync failed"), { code: "EIO" });
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw failure; });
    expect(() => store.put("data:image/png;base64,iVBORw0KGgo=", "own.png", "own")).toThrow(failure);
    expect(staged).toBeTypeOf("number");
    expect(() => fs.fstatSync(staged!)).toThrow(/EBADF/);
    expect(fs.readdirSync(file("attachments"))).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.[a-f0-9-]+\.part$/)]);
    expect(db.get("SELECT COUNT(*) AS count FROM attachments")?.count).toBe(0);
  } finally { db.close(); }
});
