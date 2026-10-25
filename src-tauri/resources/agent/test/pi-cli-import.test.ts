// Former Pi CLI chats through the real route → PiCliImporter: the original is
// copied into an immutable archive (never moved/modified), a separate owned
// working copy becomes a writable runtime chat under a namespaced id with the
// full pi-cli origin, re-import is idempotent and a tombstone is not revived.
import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { legacyPiDigest, legacyPiSessionId } from "../src/legacy/pi-cli.ts";
import { restoreSessionSnapshot, snapshotSessions, verifySessionSnapshot } from "../src/platform/update-snapshot.ts";
import { fauxAssistantMessage } from "../src/sdk/testing.ts";
import { harness, newSession, promptCommand, tempDir, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function piFixture(root: string, project: string): string {
  const folder = path.join(root, legacyPiDigest(project));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "2026-10-01T00-00-00_chat-abc.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "chat-abc", timestamp: "2026-10-01T00:00:00.000Z", cwd: project }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-10-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], api: "x", provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } }),
  ].join("\n") + "\n");
  return file;
}

it("imports an Enki-owned Pi CLI transcript into an owned writable copy and keeps the original untouched", async () => {
  const root = tempDir("pi-sessions");
  h = await harness({ legacy: { piCliRoot: root } });
  const project = h.project("picli");
  const file = piFixture(root, project), original = sha(file);
  const meta = { id: "chat-abc", directory: project, title: "Старый чат", created: 1, updated: 2, permission: [{ permission: "bash", pattern: "*", action: "deny" }] };

  const first = await h.request<{ origin: string; results: Array<{ legacyId: string; id?: string; archive?: string; created?: boolean; skipped?: string | null; code?: string }> }>("POST", "/migrations/pi-cli", { sessions: [meta, { id: "missing-chat", directory: project, title: "x", created: 1, updated: 1 }] });
  expect(first.status).toBe(200);
  const [imported, missing] = first.body.results;
  const id = legacyPiSessionId(first.body.origin, "chat-abc");
  expect(imported).toMatchObject({ legacyId: "chat-abc", id, created: true, skipped: null });
  expect(missing).toMatchObject({ legacyId: "missing-chat", code: "source_missing" }); // reported, not silently skipped
  expect(sha(file)).toBe(original);

  const record = h.runtime.catalog.get(id)!;
  expect(record.origin).toEqual({ kind: "pi-cli", source: fs.realpathSync(file), sourceOrigin: first.body.origin, legacyId: "chat-abc", archive: imported.archive, runtimeId: id });
  expect(record.permission).toEqual(meta.permission); // exact explicit deny rule kept
  expect(record.sessionFile).toBe(h.runtime.piCli.runtimeFile(id));
  expect(h.runtime.sessionDirOf(record)).toBe(path.dirname(record.sessionFile!));
  const history = await h.request<{ messages: Array<{ info: { id: string } }> }>("GET", `/sessions/${id}/messages`);
  expect(history.body.messages.map((m) => m.info.id)).toEqual(["e1", "e2"]);

  // The working copy is writable through the ordinary dispatcher; the archive is not touched.
  const archived = h.runtime.piCli.archiveFile(imported.archive!), archivedHash = sha(archived);
  h.scripted.setResponses([fauxAssistantMessage("continued")]);
  await h.command(promptCommand(h, "pi-cli-turn", id, project, "next step"));
  expect((await h.waitReceipt("pi-cli-turn", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(sha(archived)).toBe(archivedHash);
  expect(sha(file)).toBe(original);

  const again = await h.request<{ results: Array<{ created?: boolean; skipped?: string | null }> }>("POST", "/migrations/pi-cli", { sessions: [meta] });
  expect(again.body.results[0]).toMatchObject({ created: false, skipped: "already-imported" });

  // A deleted (tombstoned) import is never resurrected by a repeated import.
  await h.request("DELETE", `/sessions/${id}`);
  const tomb = await h.request<{ results: Array<{ skipped?: string | null }> }>("POST", "/migrations/pi-cli", { sessions: [meta] });
  expect(tomb.body.results[0].skipped).toBe("tombstone");
  expect(h.runtime.catalog.get(id)).toBeNull();
});

it("refuses the profile import without the local native vault authority and reads/writes nothing", async () => {
  // runtime.importPiConfig requires host=local + vault credentials + supervisor
  // broker (NativePiConfigCommitPort). The harness has none: explicit 501 with
  // the structured code, no plaintext auth.json fallback, source untouched.
  const profile = tempDir("pi-profile");
  fs.writeFileSync(path.join(profile, "auth.json"), JSON.stringify({ synthetic: { type: "api_key", key: "synthetic-not-a-secret" } }));
  const before = sha(path.join(profile, "auth.json"));
  h = await harness();
  const result = await h.request<{ message?: string }>("POST", "/migrations/pi-agent", {});
  expect(result.status).toBe(501);
  expect(result.body.message).toMatch(/^CONFIG_NATIVE_UNAVAILABLE:/);
  expect(result.body.message).not.toContain("synthetic-not-a-secret");
  expect(sha(path.join(profile, "auth.json"))).toBe(before);
  expect(fs.existsSync(path.join(h.runtime.paths.agentDir, "auth.json"))).toBe(false);
  // Sanitized status of the (absent) committed generation; no paths or values.
  const status = await h.request<Record<string, unknown>>("GET", "/migrations/pi-agent");
  expect(status.body).toEqual({ state: "none", code: null, configRevision: 0, generationId: null, deferred: [] });
  // Owner models.json stays editable when no generation is active.
  const models = await h.request<{ readOnly: boolean; source: string }>("GET", "/config/models");
  expect(models.body).toMatchObject({ readOnly: false, source: "owner" });
});

// Regression (final runtime review): the eager `sessions/pi-cli` root and the
// continuation staging that startup recovery creates inside every shard made
// EVERY paired update backup fail. The writable import, its ownership metadata
// and ordinary SDK shards must be backed up and restored together, exactly.
it("pairs writable Pi imports and SDK shards in the update backup and restores their exact bytes after a later turn", async () => {
  const root = tempDir("pi-sessions"), legacy = { piCliRoot: root };
  h = await harness({ legacy });
  const project = h.project("picli-backup");
  piFixture(root, project);
  const imported = await h.request<{ results: Array<{ id?: string; created?: boolean }> }>("POST", "/migrations/pi-cli",
    { sessions: [{ id: "chat-abc", directory: project, title: "Старый чат", created: 1, updated: 2 }] });
  expect(imported.body.results[0]).toMatchObject({ created: true });
  const id = imported.body.results[0]!.id!, ordinary = await newSession(h, project);
  for (const [command, session] of [["pi-turn-1", id], ["sdk-turn-1", ordinary]] as const) {
    h.scripted.setResponses([fauxAssistantMessage(`answer ${command}`)]);
    await h.command(promptCommand(h, command, session, project, `prompt ${command}`));
    expect((await h.waitReceipt(command, ["completed", "failed", "rejected"])).state).toBe("completed");
  }
  // Restart: recovery creates `<shard>/.legacy-continuations` (empty staging).
  const data = h.data, scripted = h.scripted, ordinaryFile = h.runtime.catalog.get(ordinary)!.sessionFile!;
  await h.stop(); h = await harness({ data, scripted, legacy });
  expect(fs.readdirSync(path.join(path.dirname(ordinaryFile), ".legacy-continuations"))).toEqual([]);
  const working = h.runtime.piCli.runtimeFile(id), ownership = path.join(path.dirname(working), "ownership.json");
  const before = new Map([working, ownership, ordinaryFile].map(file => [file, fs.readFileSync(file)]));
  type History = { messages: Array<{ info: { id: string } }> };
  const backedUp = (await h.request<History>("GET", `/sessions/${id}/messages`)).body.messages.map(m => m.info.id);
  expect(backedUp.slice(0, 2)).toEqual(["e1", "e2"]);

  await h.runtime.beginMaintenance();
  const backupId = randomUUID(), receipt = await h.runtime.backupForUpdate(backupId);
  const manifest = JSON.parse(fs.readFileSync(path.join(data, "update-backups", backupId, "sessions.json"), "utf8")) as { schema: number; files: Array<{ path: string }> };
  expect(manifest.schema).toBe(2);
  expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining([`pi-cli/${id}/session.jsonl`, `pi-cli/${id}/ownership.json`,
    `${path.basename(path.dirname(ordinaryFile))}/${path.basename(ordinaryFile)}`]));
  expect(receipt.sessions.files).toBe(manifest.files.length);
  expect(verifySessionSnapshot(data, backupId, receipt.sessions)).toHaveLength(manifest.files.length);
  h.runtime.endMaintenance();

  // A later turn really changes the writable import after the backup.
  h.scripted.setResponses([fauxAssistantMessage("after backup")]);
  await h.command(promptCommand(h, "pi-turn-2", id, project, "after backup"));
  expect((await h.waitReceipt("pi-turn-2", ["completed", "failed", "rejected"])).state).toBe("completed");
  const changed = fs.readFileSync(working);
  expect(changed.equals(before.get(working)!)).toBe(false);

  // Installer-side restoration with no live writer: exact bytes back, the newer
  // store preserved aside (never deleted), catalog mapping still valid.
  await h.stop();
  const preserved = path.join(data, `failed-update-${randomUUID()}`);
  restoreSessionSnapshot(data, backupId, receipt.sessions, preserved);
  for (const [file, bytes] of before) expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  expect(fs.readFileSync(path.join(preserved, "sessions", "pi-cli", id, "session.jsonl")).equals(changed)).toBe(true);
  h = await harness({ data, scripted, legacy });
  expect(h.runtime.catalog.get(id)!.sessionFile).toBe(working);
  const history = await h.request<History>("GET", `/sessions/${id}/messages`);
  expect(history.body.messages.map(m => m.info.id)).toEqual(backedUp);
  await h.runtime.beginMaintenance();
  await expect(h.runtime.backupForUpdate(randomUUID())).resolves.toMatchObject({ sessions: { files: manifest.files.length } });
  h.runtime.endMaintenance();
});

it("still fails closed on stray session-store entries and on unrecovered continuation staging", () => {
  const data = tempDir("snapshot-layout"), sessions = path.join(data, "sessions"), shard = path.join(sessions, "0123456789abcdef");
  fs.mkdirSync(path.join(shard, ".legacy-continuations"), { recursive: true });
  fs.writeFileSync(path.join(shard, "chat.jsonl"), "{}\n");
  fs.mkdirSync(path.join(data, "update-backups"));
  const attempt = () => { const id = randomUUID(); fs.mkdirSync(path.join(data, "update-backups", id)); return snapshotSessions(data, id); };
  expect(attempt()).toMatchObject({ files: 1 });
  fs.mkdirSync(path.join(shard, ".legacy-continuations", randomUUID()));
  expect(attempt).toThrow(/продолжение/);
  fs.rmSync(path.join(shard, ".legacy-continuations"), { recursive: true }); fs.mkdirSync(path.join(shard, ".legacy-continuations"));
  fs.mkdirSync(path.join(sessions, "pi-cli", "not-a-pi-id"), { recursive: true });
  expect(attempt).toThrow(/неожиданный элемент/);
  fs.rmSync(path.join(sessions, "pi-cli"), { recursive: true });
  fs.writeFileSync(path.join(sessions, "stray.txt"), "x");
  expect(attempt).toThrow(/неожиданный элемент/);
});
