// Real public SDK and owned paths: catches the Windows-only private-path
// mismatch and ensures a transcript flush failure is a bounded failed turn.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadSdkUiCompat } from "../../src/plugin-ui/sdk-ui-compat.ts";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness | undefined;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  try { await h?.stop(); }
  finally { h = undefined; for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true }); }
});

it("the real private keybinding path works; an outside config and a symlink still fail closed", async () => {
  h = await harness(); roots.push(h.data);
  const agent = h.runtime.paths.agentDir, outside = h.project("keybinding-outside");
  roots.push(outside);
  const sdk = await loadSdkUiCompat(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")), { agentDir: agent });
  const config = path.join(agent, "keybindings.json");
  expect(sdk.createKeybindings({}, config).getEffectiveConfig()).toBeTypeOf("object");
  expect(() => sdk.createKeybindings({}, path.join(outside, "keybindings.json"))).toThrow(/приватном профиле/);
  const other = path.join(outside, "keybindings.json"); fs.writeFileSync(other, "{}");
  fs.symlinkSync(other, config, "file");
  expect(() => sdk.createKeybindings({}, config)).toThrow(/приватном профиле/);
  expect(fs.readFileSync(other, "utf8")).toBe("{}");
});

it("a real SDK transcript flush error settles as failed, releases the turn, never replays and does not poison the next command", async () => {
  h = await harness(); roots.push(h.data);
  const directory = h.project("transcript-flush"), sessionID = await newSession(h, directory);
  roots.push(directory);
  h.scripted.setResponses([fauxAssistantMessage("first real answer"), fauxAssistantMessage("second real answer")]);
  const actualOpen = fs.openSync, actualClose = fs.closeSync, actualSync = fs.fsyncSync;
  const jsonl = new Set<number>();
  vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = actualOpen(...args);
    // Header creation still uses its real wx writer. Fail only the subsequent
    // owned-transcript flush, not a fake agent/SDK result or another resource.
    if (String(args[0]).endsWith(".jsonl") && typeof args[1] === "number") jsonl.add(fd);
    return fd;
  });
  vi.spyOn(fs, "closeSync").mockImplementation(fd => { jsonl.delete(fd); actualClose(fd); });
  let failures = 0;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (jsonl.has(fd)) { failures++; throw Object.assign(new Error("OWNED_TRANSCRIPT_FSYNC_FAILED"), { code: "EIO" }); }
    actualSync(fd);
  });
  const first = promptCommand(h, "flush-failed", sessionID, directory, "first");
  await h.command(first);
  const receipt = await h.waitReceipt(first.id, ["completed", "failed", "rejected", "cancelled"]);
  expect(failures).toBeGreaterThan(0);
  expect(receipt.state).toBe("failed");
  expect(receipt.error).toContain("OWNED_TRANSCRIPT_FSYNC_FAILED");
  await h.runtime.dispatcher.settled();
  expect(h.runtime.dispatcher.inFlight(sessionID)).toBe(false);
  expect(h.scripted.calls()).toBe(1);
  expect(jsonl.size).toBe(0);
  vi.restoreAllMocks();
  await h.command(promptCommand(h, "flush-next", sessionID, directory, "next"));
  expect((await h.waitReceipt("flush-next", ["completed", "failed", "rejected", "cancelled"])).state).toBe("completed");
  expect((await h.command(first)).body.state).toBe("failed");
  expect(h.scripted.calls()).toBe(2);
});
