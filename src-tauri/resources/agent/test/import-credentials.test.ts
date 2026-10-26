import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { importLegacyCredentials } from "../src/models/import-credentials.ts";
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
