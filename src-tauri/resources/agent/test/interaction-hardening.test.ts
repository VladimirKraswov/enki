import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, outsideDirectory } from "../src/interaction/access.ts";
import { exactIdentity, permissionPreview } from "../src/interaction/grants.ts";
import { prepareToolPaths, normalizeToolPath } from "../src/interaction/access-paths.ts";
import { InteractionBroker } from "../src/interaction/broker.ts";
import { Database } from "../src/store/db.ts";
import { EventJournal } from "../src/store/events.ts";

const fixtures: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of fixtures.splice(0)) close(); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "enki-permission-fixture-")));
  const project = path.join(root, "project"), external = path.join(root, "external");
  fs.mkdirSync(project); fs.mkdirSync(external);
  const db = new Database(path.join(root, "metadata.sqlite")), events = new EventJournal(db);
  const broker = new InteractionBroker(db, events, 50);
  fixtures.push(() => { try { broker.cancelAll(); } catch { /* RED baseline cleanup. */ } db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project, external, db, events, broker };
}
const denyExternal = [{ permission: "external_directory", pattern: "*", action: "deny" as const }];

it("default-read denies an external write before any approval can be requested", () => {
  const f = fixture();
  expect(decide({ rules: [], grants: [], fallback: "read", cwd: f.project, tool: "write", input: { path: path.join(f.external, "new.txt"), content: "NO" } }).decision).toBe("deny");
});
it("custom edit deny dominates external ask", () => {
  const f = fixture();
  const rules = [{ permission: "external_directory", pattern: "*", action: "ask" as const }, { permission: "edit", pattern: "*", action: "deny" as const }];
  expect(decide({ rules, grants: [], fallback: "ask", cwd: f.project, tool: "edit", input: { path: path.join(f.external, "new.txt") } }).decision).toBe("deny");
});
it("literal question mark remembered grant cannot authorize a different filename", async () => {
  const f = fixture(), input = { path: path.join(f.project, "report?.txt") };
  const first = decide({ rules: [{ permission: "read", pattern: "*", action: "ask" }], grants: [], fallback: "ask", cwd: f.project, tool: "read", input });
  const pending = f.broker.askPermission({ sessionID: "fixture-session", directory: f.project, tool: "read", callID: "call1", title: "Read", summary: "Read exact target", permission: first.permission, pattern: first.pattern,
    ...("identity" in first ? { identity: String(first.identity) } : {}) });
  f.broker.replyPermission(f.broker.pendingPermissions()[0].id, "always"); await pending;
  const second = decide({ rules: [{ permission: "read", pattern: "*", action: "ask" }], grants: f.broker.grants("fixture-session"), fallback: "ask", cwd: f.project, tool: "read", input: { path: path.join(f.project, "report1.txt") } });
  expect(second.decision).toBe("ask");
});
it("distinct long commands retain distinct permission identity", () => {
  const f = fixture(), prefix = "x".repeat(2100);
  const a = decide({ rules: [], grants: [], fallback: "ask", cwd: f.project, tool: "bash", input: { command: prefix + " FIRST" } });
  const b = decide({ rules: [], grants: [], fallback: "ask", cwd: f.project, tool: "bash", input: { command: prefix + " SECOND" } });
  expect(a.pattern).not.toBe(b.pattern);
});
it("tilde, file URL and symlink targets obey external-directory deny", () => {
  const f = fixture();
  vi.spyOn(os, "homedir").mockReturnValue(f.root);
  fs.writeFileSync(path.join(f.external, "target.txt"), "fixture only");
  fs.symlinkSync(f.external, path.join(f.project, "link"));
  for (const target of ["~/fixture-unread-secret.txt", new URL(`file://${f.external}/target.txt`).href, "link/target.txt", "link/new/child.txt"]) {
    const verdict = decide({ rules: denyExternal, grants: [], fallback: "ask", cwd: f.project, tool: "read", input: { path: target } });
    expect(verdict.decision, target).toBe("deny");
  }
  expect(outsideDirectory(f.project, { path: "..valid-local-name" })).toBeNull();
});
it("reply event storage failure settles the waiting tool and clears its timer", async () => {
  const f = fixture(), pending = f.broker.askPermission({ sessionID: "fixture-session", directory: f.project, permission: "edit", pattern: "file.txt", tool: "write", callID: "call", title: "Write", summary: "fixture" });
  const observed = pending.then(value => value, () => "storage-failed");
  const id = f.broker.pendingPermissions()[0].id;
  vi.spyOn(f.events, "append").mockImplementation(() => { throw new Error("synthetic durable write failure"); });
  try { f.broker.replyPermission(id, "once"); } catch { /* HTTP may report a truthful storage error. */ }
  const outcome = await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("HUNG"), 100))]);
  expect(outcome).toBe("storage-failed"); expect(f.broker.pendingPermissions()).toEqual([]);
});
it("asked-event storage failure cannot leave orphan pending requests", async () => {
  const f = fixture();
  vi.spyOn(f.events, "append").mockImplementation(() => { throw new Error("synthetic durable write failure"); });
  await expect(f.broker.askDialog("fixture-session", f.project, { method: "confirm", title: "Confirm", message: "fixture" })).rejects.toThrow();
  expect(f.broker.pendingDialogs()).toEqual([]);
});

function ask(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  return f.broker.askPermission({ sessionID: "fixture-session", directory: f.project, permission: "edit", pattern: "file.txt", identity: exactIdentity("edit", "fixture"), tool: "write", callID: "call", title: "Write", summary: "fixture", signal });
}
it("always grant and reply event roll back atomically on storage failure, preserving the cause", async () => {
  const f = fixture(), pending = ask(f), result = pending.catch(error => error);
  const id = f.broker.pendingPermissions()[0].id, failure = new Error("synthetic sqlite failure");
  vi.spyOn(f.events, "append").mockImplementation(() => { throw failure; });
  expect(() => f.broker.replyPermission(id, "always")).toThrow("Не удалось сохранить ответ");
  expect((await result).cause).toBe(failure);
  expect(f.broker.grants("fixture-session")).toEqual([]);
  expect(f.db.all("SELECT * FROM permission_grants")).toEqual([]);
  expect(f.db.all("SELECT * FROM events WHERE type='permission.replied'")).toEqual([]);
  expect(f.broker.replyPermission(id, "once")).toBe(false);
});
it("rollback of an enclosing request transaction clears pending and rejects instead of hanging", async () => {
  const f = fixture();
  let result: Promise<unknown> | undefined;
  expect(() => f.db.transaction(() => { result = ask(f).catch(error => error); throw new Error("outer rollback"); })).toThrow("outer rollback");
  expect(await result).toMatchObject({ name: "InteractionStorageError" });
  expect(f.broker.pendingPermissions()).toEqual([]);
  expect(f.db.all("SELECT * FROM events WHERE type='permission.asked'")).toEqual([]);
});
it("rollback of an enclosing reply transaction cannot approve, leave a grant or hang a tool", async () => {
  const f = fixture(), pending = ask(f), result = pending.catch(error => error);
  const id = f.broker.pendingPermissions()[0].id;
  expect(() => f.db.transaction(() => { expect(f.broker.replyPermission(id, "always")).toBe(true); throw new Error("outer rollback"); })).toThrow("outer rollback");
  expect(await result).toMatchObject({ name: "InteractionStorageError" });
  expect(f.broker.hasPending("fixture-session")).toBe(false);
  expect(f.db.all("SELECT * FROM permission_grants")).toEqual([]);
  expect(f.db.all("SELECT * FROM events WHERE type='permission.replied'")).toEqual([]);
});
it.each(["deadline", "abort", "stop"] as const)("%s write failure rejects safely, clears timers and listeners", async method => {
  vi.useFakeTimers();
  const f = fixture(), controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const result = ask(f, controller.signal).catch(error => error), failure = new Error("synthetic reply failure");
  vi.spyOn(f.events, "append").mockImplementation(() => { throw failure; });
  if (method === "deadline") await vi.advanceTimersByTimeAsync(51);
  else if (method === "abort") controller.abort();
  else f.broker.cancelSession("fixture-session");
  expect(await result).toMatchObject({ name: "InteractionStorageError", cause: failure });
  expect(f.broker.pendingPermissions()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  await vi.advanceTimersByTimeAsync(1000);
});
it("a post-commit observer failure cannot revoke a durable approval", async () => {
  const f = fixture(), pending = ask(f), append = f.events.append.bind(f.events);
  vi.spyOn(f.events, "append").mockImplementation((...args) => { const value = append(...args); f.db.afterCommit(() => { throw new Error("synthetic observer failure"); }); return value; });
  expect(f.broker.replyPermission(f.broker.pendingPermissions()[0].id, "always")).toBe(true);
  expect(await pending).toBe("always"); expect(f.broker.grants("fixture-session")).toHaveLength(1);
  expect(f.db.all("SELECT * FROM events WHERE type='permission.replied'")).toHaveLength(1);
});
it("once never creates persistent authority; legacy untyped rows cannot authorize arbitrary future tools", async () => {
  const f = fixture(), pending = ask(f);
  f.broker.replyPermission(f.broker.pendingPermissions()[0].id, "once"); expect(await pending).toBe("once");
  expect(f.db.all("SELECT * FROM permission_grants")).toEqual([]);
  f.db.run("INSERT INTO permission_grants VALUES(?,?,?,?)", "fixture-session", "bash", "*", Date.now());
  expect(f.broker.grants("fixture-session")).toEqual([]);
  expect(decide({ rules: [], grants: f.broker.grants("fixture-session"), fallback: "ask", cwd: f.project, tool: "bash", input: { command: "echo test" } }).decision).toBe("ask");
});
it("remembered MCP permission binds all arguments, is scoped to the session, and cannot override a later deny", async () => {
  const f = fixture(), input = { path: "report.txt", operation: "read" };
  const first = decide({ rules: [], grants: [], fallback: "ask", cwd: f.project, tool: "plugin_data", input });
  const pending = f.broker.askPermission({ sessionID: "fixture-session", directory: f.project, tool: "plugin_data", callID: "call", title: "Plugin", summary: "fixture", permission: first.permission, pattern: first.pattern, identity: first.identity });
  f.broker.replyPermission(f.broker.pendingPermissions()[0].id, "always"); await pending;
  const query = { rules: [], grants: f.broker.grants("fixture-session"), fallback: "ask" as const, cwd: f.project, tool: "plugin_data", input };
  expect(decide(query).decision).toBe("allow");
  expect(decide({ ...query, input: { ...input, operation: "delete" } }).decision).toBe("ask");
  expect(decide({ ...query, grants: f.broker.grants("other-session") }).decision).toBe("ask");
  expect(decide({ ...query, rules: [{ permission: "plugin_data", pattern: "*", action: "deny" }] }).decision).toBe("deny");
});
it("authored relative path rules keep last-match and glob meaning after canonicalization", () => {
  const f = fixture(), input = { path: "source/example.ts" };
  prepareToolPaths("write", input, f.project);
  const query = { rules: [{ permission: "edit", pattern: "*", action: "deny" as const }, { permission: "edit", pattern: "source/*.ts", action: "allow" as const }], grants: [], fallback: "ask" as const, cwd: f.project, tool: "write", input };
  expect(decide(query).decision).toBe("allow");
  expect(decide({ ...query, rules: [...query.rules, { permission: "edit", pattern: "source/example.ts", action: "deny" }] }).decision).toBe("deny");
});
it("approved symlink aliases cannot redirect an SDK target while the user answers", () => {
  const f = fixture(), original = path.join(f.project, "original");
  fs.mkdirSync(original); fs.symlinkSync(original, path.join(f.project, "link"));
  const input = { path: "link/new.txt", content: "test" };
  prepareToolPaths("write", input, f.project);
  fs.unlinkSync(path.join(f.project, "link")); fs.symlinkSync(f.external, path.join(f.project, "link"));
  prepareToolPaths("write", input, f.project);
  expect(input.path).toBe(path.join(original, "new.txt"));
});
it("normalization matches SDK Windows drive and user-space conventions without rewriting unknown plugin arguments", () => {
  const options = { platform: "win32" as const, home: "C:\\Users\\fixture" };
  expect(normalizeToolPath("/c/example/file.txt", options)).toBe("C:\\example\\file.txt");
  const f = fixture(), input = { path: "~/opaque-plugin-value" };
  prepareToolPaths("custom_extension", input, f.project); expect(input.path).toBe("~/opaque-plugin-value");
});
it("permission preview removes encoded credential query and userinfo while identity stays distinct", () => {
  const a = "curl 'https://firstsecret:secondsecret@example.invalid/api?api%5Fkey=thirdsecret&token=fourthsecret' Bearer fifthsecret";
  const preview = permissionPreview(a);
  for (const secret of ["firstsecret", "secondsecret", "thirdsecret", "fourthsecret", "fifthsecret"]) expect(preview).not.toContain(secret);
  expect(exactIdentity("fetch", a)).not.toBe(exactIdentity("fetch", a.replace("thirdsecret", "different")));
  const malformed = permissionPreview("https://usersecret:passsecret@[invalid/?api%5fkey=querysecret");
  for (const secret of ["usersecret", "passsecret", "querysecret"]) expect(malformed).not.toContain(secret);
});
it("normal extension confirms remain interactive even when tool access is full", async () => {
  const f = fixture(), pending = f.broker.askDialog("fixture-session", f.project, { method: "confirm", title: "Plugin confirm", message: "Proceed?" });
  expect(f.broker.pendingDialogs()).toHaveLength(1);
  f.broker.replyDialog(f.broker.pendingDialogs()[0].id, { confirmed: false });
  expect(await pending).toEqual({ confirmed: false });
});

it("canonical target preparation preserves Unicode spaces inherited from the SDK working directory", () => {
  const f = fixture(), cwd = path.join(f.root, "non\u00a0breaking"); fs.mkdirSync(cwd);
  const input = { path: "new.txt", content: "test" }; prepareToolPaths("write", input, cwd);
  expect(input.path).toBe("new.txt");
  const verdict = decide({ rules: [], grants: [], fallback: "ask", cwd, tool: "write", input });
  expect(verdict.permission).toBe("edit"); expect(verdict.pattern).toBe(path.join(cwd, "new.txt"));
});
