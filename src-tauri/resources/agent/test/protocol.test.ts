import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, CONTRACT_VERSION, isQueuePausingError, SCHEMA_VERSION, SDK_VERSION, validateCommand } from "../src/protocol.ts";
import { Database } from "../src/store/db.ts";
import { payloadHash } from "../src/store/commands.ts";
import { decide } from "../src/interaction/access.ts";
import { exactIdentity, readGrant, storedGrant } from "../src/interaction/grants.ts";
import { LineReader, parseSupervisorMessage } from "../src/control/channel.ts";

const model = { providerID: "deepseek", modelID: "deepseek-chat" };

it("validates every command kind and normalizes payloads", () => {
  const prompt = validateCommand({ id: "c1", kind: "prompt", sessionID: "s", directory: "/p", payload: { parts: [{ type: "text", text: "hi" }], model, extra: "dropped", source: "queue", sourceId: "q1" } });
  expect(prompt).toEqual({ id: "c1", kind: "prompt", sessionID: "s", directory: "/p", payload: { parts: [{ type: "text", text: "hi" }], model, source: "queue", sourceId: "q1" } });
  expect(validateCommand({ id: "c2", kind: "compact", sessionID: "s", directory: "/p", payload: {} })).toMatchObject({ kind: "compact" });
  expect(validateCommand({ id: "c3", kind: "model.transition", sessionID: "s", directory: "/p", payload: { model, budget: -1 } })).toBeTypeOf("string");
  expect(validateCommand({ id: "c4", kind: "prompt", sessionID: "s", directory: "/p", payload: { parts: [{ type: "file", mime: "image/png", url: "https://x" }], model } })).toBeTypeOf("string");
});

// Regression: runtime-lock.json said dataSchema 2 while the store migrates to 3,
// so artifact metadata could not pair with the backups the runtime receipts.
it("runtime-lock artifact metadata equals the wire/schema/SDK constants the runtime speaks", () => {
  const lock = JSON.parse(fs.readFileSync(new URL("../runtime-lock.json", import.meta.url), "utf8")) as { contract: number; dataSchema: number; sdk: { version: string } };
  expect({ contract: lock.contract, dataSchema: lock.dataSchema, sdk: lock.sdk.version }).toEqual({ contract: CONTRACT_VERSION, dataSchema: SCHEMA_VERSION, sdk: SDK_VERSION });
  const migrations = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "enki-schema-")), "runtime.sqlite"));
  try { expect(migrations.db.prepare("PRAGMA user_version").get()?.user_version).toBe(lock.dataSchema); } finally { migrations.close(); }
});

it("payload hashes ignore key order but not content", () => {
  const a = { id: "c", kind: "abort" as const, sessionID: "s", directory: "/p", payload: {} };
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  expect(payloadHash(a)).toBe(payloadHash({ ...a }));
  expect(payloadHash(a)).not.toBe(payloadHash({ ...a, directory: "/q" }));
});

it("classifies only fatal provider errors and explicit stops as queue-pausing", () => {
  expect(isQueuePausingError("Insufficient balance")).toBe(true);
  expect(isQueuePausingError("invalid api key")).toBe(true);
  expect(isQueuePausingError("request aborted")).toBe(true);
  expect(isQueuePausingError("context length exceeded")).toBe(false);
  expect(isQueuePausingError("connection reset")).toBe(false);
});

it("access decisions: presets, external paths and session grants", () => {
  const ask = [{ permission: "*", pattern: "*", action: "ask" as const }, { permission: "read", pattern: "*", action: "allow" as const }];
  const base = { grants: [], fallback: "ask" as const, cwd: "/project" };
  expect(decide({ ...base, rules: ask, tool: "read", input: { path: "a.ts" } }).decision).toBe("allow");
  expect(decide({ ...base, rules: ask, tool: "bash", input: { command: "ls" } }).decision).toBe("ask");
  expect(decide({ ...base, rules: ask, tool: "read", input: { path: "../../etc/passwd" } })).toMatchObject({ decision: "ask", permission: "external_directory" });
  // A saved "always" grant is the typed exact observed-action identity from the
  // asked verdict, stored and read back through the real row format.
  const observed = (verdict: { permission: string; identity: string }) => {
    const row = storedGrant({ permission: verdict.permission, identity: verdict.identity });
    return readGrant(row.permission, row.pattern)!;
  };
  const askedLs = decide({ ...base, rules: ask, tool: "bash", input: { command: "ls" } });
  expect(askedLs).toMatchObject({ decision: "ask", permission: "bash", identity: exactIdentity("bash", { tool: "bash", input: { command: "ls" } }) });
  const lsGrant = observed(askedLs);
  expect(lsGrant).toEqual({ permission: "bash", pattern: "", identity: askedLs.identity });
  expect(decide({ ...base, rules: ask, grants: [lsGrant], tool: "bash", input: { command: "ls" } }).decision).toBe("allow");
  // Exact: a different input or a different action stays "ask".
  expect(decide({ ...base, rules: ask, grants: [lsGrant], tool: "bash", input: { command: "ls -la" } }).decision).toBe("ask");
  expect(decide({ ...base, rules: ask, grants: [lsGrant], tool: "bash", input: { command: "ls", timeout: 5 } }).decision).toBe("ask");
  expect(decide({ ...base, rules: ask, grants: [lsGrant], tool: "some_mcp_tool", input: { command: "ls" } }).decision).toBe("ask");
  // File grants cover the exact tool and resolved target only.
  const askedWrite = decide({ ...base, rules: ask, tool: "write", input: { path: "a.ts", content: "x" } });
  expect(askedWrite).toMatchObject({ decision: "ask", permission: "edit" });
  const writeGrant = observed(askedWrite);
  expect(decide({ ...base, rules: ask, grants: [writeGrant], tool: "write", input: { path: "a.ts", content: "y" } }).decision).toBe("allow");
  expect(decide({ ...base, rules: ask, grants: [writeGrant], tool: "write", input: { path: "b.ts", content: "x" } }).decision).toBe("ask");
  expect(decide({ ...base, rules: ask, grants: [writeGrant], tool: "edit", input: { path: "a.ts", oldText: "x", newText: "y" } }).decision).toBe("ask");
  // Raw legacy/untyped rows never silently authorize, directly or via the row reader.
  expect(decide({ ...base, rules: ask, grants: [{ permission: "bash", pattern: "ls" }], tool: "bash", input: { command: "ls" } }).decision).toBe("ask");
  expect(decide({ ...base, rules: ask, grants: [{ permission: "bash", pattern: "*" }], tool: "bash", input: { command: "ls" } }).decision).toBe("ask");
  expect(readGrant("bash", "ls")).toBeNull();
  expect(readGrant("bash", askedLs.identity)).toBeNull();
  expect(readGrant(storedGrant({ permission: "bash", identity: askedLs.identity }).permission, "ls")).toBeNull();
  expect(() => storedGrant({ permission: "bash", identity: "ls" })).toThrow();
  // Authored rule globs remain glob authority, distinct from observed grants.
  const gitGlob = [...ask, { permission: "bash", pattern: "git *", action: "allow" as const }];
  expect(decide({ ...base, rules: gitGlob, tool: "bash", input: { command: "git status" } }).decision).toBe("allow");
  expect(decide({ ...base, rules: gitGlob, tool: "bash", input: { command: "rm -rf ." } }).decision).toBe("ask");
  expect(decide({ ...base, rules: [], fallback: "read", tool: "write", input: { path: "x" } }).decision).toBe("deny");
  expect(decide({ ...base, rules: [], fallback: "ask", tool: "some_future_tool", input: {} }).decision).toBe("ask");
  expect(decide({ ...base, rules: [{ permission: "*", pattern: "*", action: "allow" }], tool: "bash", input: { command: "rm" } }).decision).toBe("allow");
});

it("control channel accepts only well-formed supervisor messages and splits on newline only", () => {
  // Authentic configure DTO: 43-char supervisor generation and a UUIDv4 requestId.
  const generation = "g".repeat(43), requestId = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
  const configure = { type: "configure", generation, requestId, token: "t".repeat(43), origins: ["tauri://localhost"], version: "0.3.0" };
  expect(parseSupervisorMessage(JSON.stringify(configure))).toEqual(configure);
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, initialMaintenance: true }))).toEqual({ ...configure, initialMaintenance: true });
  // Malformed fields, scopes and generations are rejected.
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, token: "short", origins: [], version: "x" }))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, origins: ["javascript:alert(1)"], version: "x" }))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, initialMaintenance: "yes" }))).toBeNull();
  const { generation: _g, ...noGeneration } = configure, { requestId: _r, ...noRequest } = configure;
  expect(parseSupervisorMessage(JSON.stringify(noGeneration))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, generation: "g".repeat(42) }))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, generation: "g".repeat(42) + "/" }))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify(noRequest))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, requestId: "not-a-uuid" }))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify({ ...configure, requestId: "3f2b8c1e-9a4d-1e7b-8c2a-1d5e6f7a8b9c" }))).toBeNull();
  expect(parseSupervisorMessage(JSON.stringify([configure]))).toBeNull();
  expect(parseSupervisorMessage("{not json")).toBeNull();
  const lines: string[] = [];
  const reader = new LineReader((line) => lines.push(line));
  reader.push('{"a":"x y"}\n{"b":');
  reader.push('1}\r\n');
  expect(lines).toEqual(['{"a":"x y"}', '{"b":1}']);
});
