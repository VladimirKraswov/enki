import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { adoptAgentDirCredentials, adoptProviderCredentials, importLegacyCredentials } from "../src/models/import-credentials.ts";
import type { SdkCredential, SdkCredentialStore } from "../src/sdk/adapter.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enki-credential-transfer-")); dirs.push(dir);
  const files = { "auth.json": JSON.stringify({ deepseek: { type: "api_key", key: "fixture-key" }, other: { type: "api_key", key: "old" } }), "models.json": "existing unsupported config", "settings.json": "legacy plugin settings" };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  return { dir, unchanged: () => { for (const [name, bytes] of Object.entries(files)) expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(bytes); } };
}
it("transfers credentials without parsing or changing unrelated legacy configuration, preserves current keys and is restart-idempotent", async () => {
  const f = fixture(), values = new Map<string, SdkCredential>([["other", { type: "api_key", key: "current" }]]);
  const modify = vi.fn(async (id, update) => { const result = await update(values.get(id)); if (result) values.set(id, result); return result; });
  const store = { modify } as unknown as SdkCredentialStore;
  expect(await importLegacyCredentials(f.dir, store, () => false)).toEqual({ imported: ["deepseek"], kept: ["other"], failed: [] });
  expect(values.get("other")).toEqual({ type: "api_key", key: "current" });
  expect(await importLegacyCredentials(f.dir, store, id => values.has(id))).toEqual({ imported: [], kept: ["deepseek", "other"], failed: [] });
  expect(modify).toHaveBeenCalledTimes(2); f.unchanged();
});
it("reports partial storage failure without exposing keys and preserves completed writes for a retry", async () => {
  const f = fixture(), values = new Map<string, SdkCredential>(); let fail = true;
  const store = { modify: async (id: string, update: (value: SdkCredential | undefined) => Promise<SdkCredential>) => {
    if (id === "other" && fail) throw new Error("private-native-diagnostic");
    const result = await update(values.get(id)); values.set(id, result); return result;
  } } as unknown as SdkCredentialStore;
  const first = await importLegacyCredentials(f.dir, store, () => false);
  expect(first.imported).toEqual(["deepseek"]); expect(first.failed.map(x => x.provider)).toEqual(["other"]);
  expect(JSON.stringify(first)).not.toMatch(/fixture-key|private-native-diagnostic/);
  fail = false;
  expect(await importLegacyCredentials(f.dir, store, id => values.has(id))).toEqual({ imported: ["other"], kept: ["deepseek"], failed: [] }); f.unchanged();
});
it("adopts credentials written by the SDK/CLI into the runtime's own auth.json for known providers only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enki-agent-auth-")); dirs.push(dir);
  const auth = JSON.stringify({
    "kimi-coding": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1794167880214 },
    deepseek: { type: "api_key", key: "fixture-key" },
    unrelated: { type: "api_key", key: "unrelated-key" },
  });
  fs.writeFileSync(path.join(dir, "auth.json"), auth, { mode: 0o600 });
  const values = new Map<string, SdkCredential>();
  const store = { modify: vi.fn(async (id: string, update: (v: SdkCredential | undefined) => Promise<SdkCredential>) => {
    const result = await update(values.get(id)); values.set(id, result); return result;
  }) } as unknown as SdkCredentialStore;
  // "unrelated" is not a provider Enki knows: it must never reach the OS vault.
  const result = await adoptAgentDirCredentials(dir, store, new Set(["kimi-coding", "deepseek"]));
  expect(result).toEqual({ imported: ["kimi-coding", "deepseek"], kept: [], failed: [] });
  expect([...values.keys()].sort()).toEqual(["deepseek", "kimi-coding"]);
  expect(values.get("kimi-coding")).toMatchObject({ type: "oauth", access: "fixture-access" });
  expect(fs.readFileSync(path.join(dir, "auth.json"), "utf8")).toBe(auth);
  // A second start is idempotent and never replaces a stored credential.
  values.set("kimi-coding", { type: "oauth", access: "rotated", refresh: "rotated", expires: 1 } as SdkCredential);
  expect(await adoptAgentDirCredentials(dir, store, new Set(["kimi-coding"]))).toEqual({ imported: [], kept: ["kimi-coding"], failed: [] });
  expect(values.get("kimi-coding")).toMatchObject({ access: "rotated" });
});
it("ignores a missing or malformed auth.json and never writes without a known provider", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enki-agent-auth-")); dirs.push(dir);
  const store = { modify: vi.fn() } as unknown as SdkCredentialStore;
  expect(await adoptAgentDirCredentials(dir, store, new Set(["kimi-coding"]))).toEqual({ imported: [], kept: [], failed: [] });
  fs.writeFileSync(path.join(dir, "auth.json"), "{ not json", { mode: 0o600 });
  expect(await adoptAgentDirCredentials(dir, store, new Set(["kimi-coding"]))).toEqual({ imported: [], kept: [], failed: [] });
  expect(await adoptAgentDirCredentials(dir, store, new Set())).toEqual({ imported: [], kept: [], failed: [] });
  expect(store.modify).not.toHaveBeenCalled();
});
it("adopts only providers for which Hub has a credential and never replaces the vault value", async () => {
  const values = new Map<string, SdkCredential>([["deepseek", { type: "api_key", key: "vault" }]]);
  const store = { modify: vi.fn(async (id: string, update: (v: SdkCredential | undefined) => Promise<SdkCredential>) => {
    const result = await update(values.get(id)); if (result) values.set(id, result); return result;
  }) } as unknown as SdkCredentialStore;
  const result = await adoptProviderCredentials(store, ["kimi-coding", "deepseek", "other"], async provider =>
    provider === "kimi-coding" ? { type: "oauth", access: "hub-access", refresh: "hub-refresh", expires: 1 }
      : provider === "deepseek" ? { type: "api_key", key: "hub-key" } : null);
  expect(result.imported).toEqual(["kimi-coding"]);
  expect(values.get("kimi-coding")).toMatchObject({ type: "oauth", access: "hub-access" });
  expect(values.get("deepseek")).toEqual({ type: "api_key", key: "vault" });
  expect(values.has("other")).toBe(false);
});
