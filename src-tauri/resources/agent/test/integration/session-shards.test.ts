// Enki owns exactly ONE transcript shard per real folder, whatever spelling the
// folder is named by. These cases cover the failure the owner hit in the workshop:
// a chat whose row names the canonical folder while its history still sits in the
// shard of the former (symlinked) path was refused every write with
// «Историю можно изменять только в рабочем хранилище Enki». The runtime now repoints
// such a chat to its canonical shard at startup — journaled, restart-safe and
// visible in GET /migrations.
import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../../src/store/db.ts";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, tempDir, type Harness } from "../helpers.ts";

const harnesses: Harness[] = [];
afterEach(async () => { for (const item of harnesses.splice(0).reverse()) await item.stop(); });
async function start(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const created = await harness(options); harnesses.push(created); return created;
}
async function offline<T>(data: string, work: (db: Database) => T): Promise<T> {
  const db = new Database(path.join(data, "runtime.sqlite"));
  try { return work(db); } finally { db.close(); }
}
  const rows = (h: Harness, table: string): string[] => (h.runtime.db.all(`SELECT DISTINCT directory FROM ${table}`) as Array<Record<string, string>>)
    .map(row => String(row.directory)).sort();
/** How runtimes before this change keyed a shard: the literal path string. */
const literalShard = (data: string, directory: string): string =>
  path.join(data, "sessions", createHash("sha256").update(directory).digest("hex").slice(0, 16));
const shard = (data: string, directory: string): string => literalShard(data, fs.realpathSync(directory));
const sha = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** One scripted answer; resolves with its receipt state. */
async function talk(h: Harness, id: string, session: string, directory: string, text: string): Promise<string> {
  h.scripted.setResponses([fauxAssistantMessage(`${text} · ответ`)]);
  await h.command(promptCommand(h, id, session, directory, text));
  return (await h.waitReceipt(id, ["completed", "failed", "rejected"])).state;
}

/** A journaled move of a transcript into `stale`, as a crashed start left it. */
function journalMove(db: Database, plan: { session: string; directory: string; from: string; to: string; state: string }): void {
  db.run("UPDATE sessions SET session_file=? WHERE id=?", plan.from, plan.session);
  db.run("INSERT INTO migration_journal(id,kind,state,detail,started,updated) VALUES(?,?,?,?,?,?)", randomUUID(),
    "session-shard", plan.state,
    JSON.stringify({ version: 1, session: plan.session, directory: plan.directory, previousDirectory: plan.directory,
      from: plan.from, to: plan.to, sha256: sha(plan.from) }), Date.now(), Date.now());
}

it("re-homes a chat whose history sits in the shard of another spelling of its folder", async () => {
  const data = tempDir("shards-misplaced");
  const first = await start({ data });
  const dir = first.project("misplaced");
  // A real symlink alias, like the owner's former app-data folder still linked
  // under its old name.
  const alias = path.join(tempDir("misplaced-alias"), "old-name");
  fs.symlinkSync(dir, alias);
  const sid = await newSession(first, dir, { title: "Мастерская" });
  expect(await talk(first, "home-1", sid, dir, "первый")).toBe("completed");
  // Durable work of this chat, so the move must carry it too: a queued prompt
  // that waits for its owner across the restart.
  const queuedModel = JSON.stringify(first.model());
  const file = first.runtime.catalog.get(sid)!.sessionFile!;
  const bytes = fs.readFileSync(file, "utf8");
  const settled = path.join(shard(data, dir), path.basename(file));
  expect(path.dirname(file)).toBe(shard(data, dir));
  await first.stop(); harnesses.splice(harnesses.indexOf(first), 1);

  // The owner's state: the row names the canonical folder, while the transcript
  // lives in the shard of the alias path a pre-canonical runtime hashed and the
  // durable copies still name that alias. Under the old rule the file was not in
  // «рабочее хранилище» of its own chat at all, so every write was rejected.
  const stale = literalShard(data, alias);
  fs.mkdirSync(stale, { recursive: true });
  const misplaced = path.join(stale, path.basename(file));
  fs.renameSync(file, misplaced);
  expect(path.dirname(misplaced)).not.toBe(shard(data, dir));  await offline(data, db => {
    db.run("UPDATE sessions SET session_file=? WHERE id=?", misplaced, sid);
    db.run("INSERT INTO queue(id,session_id,directory,position,text,attachments,model,state,queued_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "q-home", sid, alias, 1, "отложенное", "[]", queuedModel, "ready", Date.now());
    for (const table of ["queue", "commands", "events"]) db.run(`UPDATE ${table} SET directory=? WHERE directory=?`, alias, dir);
  });

  const h = await start({ data }); harnesses.push(h);
  const record = h.runtime.catalog.get(sid)!;
  expect(record.sessionFile).toBe(settled);
  expect(fs.existsSync(record.sessionFile!)).toBe(true);
  expect(fs.readFileSync(record.sessionFile!, "utf8")).toBe(bytes);
  expect(fs.existsSync(misplaced)).toBe(false);
  expect(fs.existsSync(stale)).toBe(false);                       // the emptied legacy shard is gone
  for (const table of ["queue", "commands", "events"]) expect(rows(h, table)).toEqual([dir]);
  expect(h.runtime.db.get("SELECT directory FROM queue WHERE id='q-home'")?.directory).toBe(dir);
  // The chat is writable again — this is exactly what stayed rejected before.
  expect(await talk(h, "home-2", sid, dir, "второй")).toBe("completed");
  expect((await h.request<{ shards?: unknown[] }>("GET", "/migrations")).body.shards).toEqual([]);
  expect((await h.request<{ journal: Array<{ kind: string; state: string }> }>("GET", "/migrations")).body.journal
    .filter(row => row.kind === "session-shard").every(row => row.state === "committed")).toBe(true);
  await h.stop(); harnesses.splice(harnesses.indexOf(h), 1);
  // Idempotent: another start keeps the settled place and writes again.
  const third = await start({ data }); harnesses.push(third);
  expect(third.runtime.catalog.get(sid)!.sessionFile).toBe(settled);
  expect(await talk(third, "home-3", sid, dir, "третий")).toBe("completed");
});

it("brings a chat adopted through an alias into its canonical folder and shard", async () => {
  const data = tempDir("shards-alias");
  const first = await start({ data });
  const real = first.project("alias-target");
  const alias = path.join(tempDir("alias-parent"), "link");
  fs.symlinkSync(real, alias);
  const sid = await newSession(first, alias, { title: "Через alias" });
  expect(await talk(first, "alias-1", sid, alias, "первый")).toBe("completed");
  const file = first.runtime.catalog.get(sid)!.sessionFile!;
  // One real folder is one shard even while the row still names the alias.
  expect(path.dirname(file)).toBe(shard(data, real));
  expect(fs.existsSync(literalShard(data, alias))).toBe(false);
  await first.stop(); harnesses.splice(harnesses.indexOf(first), 1);

  const h = await start({ data }); harnesses.push(h);
  const record = h.runtime.catalog.get(sid)!;
  expect(record.directory).toBe(fs.realpathSync(real));
  expect(record.sessionFile).toBe(file);
  expect((await h.request<Array<{ id: string }>>("GET", `/sessions?directory=${encodeURIComponent(real)}`))
    .body.map(session => session.id)).toEqual([sid]);
  expect(await talk(h, "alias-2", sid, real, "второй")).toBe("completed");
});

it("settles a move a previous start left half-done, in both directions", async () => {
  const data = tempDir("shards-crash");
  const first = await start({ data });
  const dir = first.project("crash");
  const left = await newSession(first, dir, { title: "Долго" });
  const right = await newSession(first, dir, { title: "Коротко" });
  expect(await talk(first, "crash-1", left, dir, "первый")).toBe("completed");
  expect(await talk(first, "crash-2", right, dir, "второй")).toBe("completed");
  const files = { left: first.runtime.catalog.get(left)!.sessionFile!, right: first.runtime.catalog.get(right)!.sessionFile! };
  await first.stop(); harnesses.splice(harnesses.indexOf(first), 1);

  const stale = path.join(data, "sessions", "0000000000000000");
  fs.mkdirSync(stale, { recursive: true });
  const targets = { left: path.join(shard(data, dir), path.basename(files.left)), right: path.join(shard(data, dir), path.basename(files.right)) };
  await offline(data, db => {
    // A: the link happened, the metadata did not, both copies exist → rollback then redo.
    fs.renameSync(files.left, path.join(stale, path.basename(files.left)));
    journalMove(db, { session: left, directory: dir, from: path.join(stale, path.basename(files.left)), to: targets.left, state: "linked" });
    // B: the commit won and only the cleanup was lost → recovery finishes the move.
    fs.renameSync(files.right, path.join(stale, path.basename(files.right)));
    journalMove(db, { session: right, directory: dir, from: path.join(stale, path.basename(files.right)), to: targets.right, state: "linked" });
    fs.copyFileSync(path.join(stale, path.basename(files.right)), targets.right);
    db.run("UPDATE sessions SET session_file=? WHERE id=?", targets.right, right);
  });

  const h = await start({ data }); harnesses.push(h);
  expect(h.runtime.catalog.get(left)!.sessionFile).toBe(targets.left);
  expect(h.runtime.catalog.get(right)!.sessionFile).toBe(targets.right);
  expect(fs.existsSync(path.join(stale, path.basename(files.left)))).toBe(false);
  expect(fs.existsSync(path.join(stale, path.basename(files.right)))).toBe(false);
  expect(fs.existsSync(stale)).toBe(false);
  expect(await talk(h, "crash-3", left, dir, "третий")).toBe("completed");
  expect(await talk(h, "crash-4", right, dir, "четвёртый")).toBe("completed");
});
