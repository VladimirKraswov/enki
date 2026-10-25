// Diagnostic scratch branch only; not a replacement/relaxation of any public
// assertion. Actual Runtime + pinned SDK + deterministic public faux provider,
// private SDK profile from the existing Vitest globalSetup, no real provider.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { AttachmentStore } from "../../src/store/attachments.ts";
import { Database } from "../../src/store/db.ts";
import { harness, newSession, promptCommand, tempDir, type Harness } from "../helpers.ts";
import type { CommandReceipt } from "../../src/protocol.ts";

let h: Harness | undefined;
const roots: string[] = [];
function safe(value: unknown): string {
  let result = String(value);
  for (const root of roots) result = result.split(root).join("<owned-root>");
  return result.replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>").slice(0, 6_000);
}
function errorInfo(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== "object") return { message: safe(error) };
  const fields = error as Record<string, unknown>;
  return Object.fromEntries(["name", "code", "errno", "syscall", "message", "stack"]
    .filter((key) => typeof fields[key] === "string" || typeof fields[key] === "number")
    .map((key) => [key, typeof fields[key] === "number" ? fields[key] as number : safe(fields[key])]));
}
function emit(type: string, detail: Record<string, unknown>): void {
  console.log("ENKI_WINDOWS_DIAGNOSTIC " + JSON.stringify({ type, ...detail }));
}
function receiptInfo(receipt: CommandReceipt | null | undefined): Record<string, unknown> {
  return receipt ? { state: receipt.state, error: receipt.error == null ? receipt.error ?? null : safe(receipt.error) } : { state: "missing" };
}
async function canonicalMetadata(scope: string, input: string): Promise<void> {
  // Metadata for these fresh owned directories only; never emit full paths.
  const sync = fs.realpathSync(input), native = fs.realpathSync.native(input), asyncPath = await fs.promises.realpath(input);
  const stats = [input, sync, native, asyncPath].map(value => fs.lstatSync(value, { bigint: true }));
  emit("owned-canonical-paths", {
    scope, inputEqualsSync: input === sync, inputEqualsNative: input === native, inputEqualsAsync: input === asyncPath,
    syncEqualsNative: sync === native, syncEqualsAsync: sync === asyncPath, nativeEqualsAsync: native === asyncPath,
    samePhysicalDirectory: stats.every(stat => stat.isDirectory() && !stat.isSymbolicLink()
      && stat.dev === stats[0]!.dev && stat.ino === stats[0]!.ino),
    keyConfigParentEqualsInput: scope === "agentDir" ? path.dirname(path.join(input, "keybindings.json")) === input : null,
  });
}
function traceRealFsync(): void {
  // Forward the exact syscall unchanged; capture its actual throw and caller
  // before a runtime outcome handler can turn it into a receipt or timeout.
  const actual = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    try { return actual(fd); }
    catch (error) {
      emit("actual-fsync-error", { error: errorInfo(error), callSite: safe(new Error("real fsync caller").stack) });
      throw error;
    }
  });
}

afterEach(async () => {
  try { await h?.stop(); }
  finally {
    h = undefined;
    vi.restoreAllMocks();
    for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true });
  }
});

it("diagnostic: direct AttachmentStore.put preserves its real syscall error", () => {
  const root = tempDir("windows-diagnostic-attachment"); roots.push(root);
  const db = new Database(path.join(root, "runtime.db"));
  traceRealFsync();
  try {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const attachment = new AttachmentStore(db, root);
    const ref = attachment.put(data, "owned.png", "owned-diagnostic");
    emit("attachment", { state: "stored", size: ref.size });
    expect(attachment.dataUrl(ref.id)).toBe(data);
  } catch (error) {
    emit("attachment-error", { error: errorInfo(error) });
    throw error;
  } finally { db.close(); }
});

it("diagnostic: an ordinary real SDK prompt exposes receipt state/error before asserting completion", async () => {
  traceRealFsync();
  let stage = "harness";
  const id = "windows-diagnostic-prompt";
  try {
    h = await harness(); roots.push(h.data);
    const directory = h.project("windows-diagnostic"); roots.push(directory);
    stage = "owned-canonical-metadata";
    await canonicalMetadata("agentDir", h.runtime.paths.agentDir);
    await canonicalMetadata("projectParent", directory);
    stage = "session";
    const sessionID = await newSession(h, directory);
    h.scripted.setResponses([fauxAssistantMessage("OWNED_WINDOWS_DIAGNOSTIC")]);
    stage = "command";
    const accepted = await h.command(promptCommand(h, id, sessionID, directory, "owned diagnostic"));
    emit("accepted", { status: accepted.status, ...receiptInfo(accepted.body) });
    stage = "receipt";
    const receipt = await h.waitReceipt(id, ["completed", "failed", "rejected", "cancelled"]);
    emit("receipt", { ...receiptInfo(receipt), providerCalls: h.scripted.calls() });
    expect(receipt.state).toBe("completed");
    expect(h.scripted.calls()).toBe(1);
  } catch (error) {
    emit("prompt-error", { stage, error: errorInfo(error), receipt: receiptInfo(h?.runtime.ledger.get(id)), providerCalls: h?.scripted.calls() ?? null });
    throw error;
  }
});
