// The shared Hub model catalog must merge into opencode.jsonc and Pi models.json
// surgically: catalog providers are added/replaced, previously applied providers
// that disappeared get removed, and everything local (other providers, comments,
// unrelated keys) is preserved byte-for-byte. Re-applying the same version must
// be a no-op.

import { describe, expect, it } from "vitest";
import {
  hubModelsState,
  mergeOpencodeProviders,
  mergePiModels,
  planCatalog,
  stripComments,
  type HubCatalog,
} from "../src/models/catalog";

const provider = (url: string) => ({
  npm: "@ai-sdk/openai-compatible",
  name: "V100",
  options: { baseURL: url, apiKey: "local" },
  models: { "m-1": { name: "M1", limit: { context: 196608, output: 16384 } } },
});

const catalog: HubCatalog = {
  version: 7,
  models: [
    { id: "artemis31-v100", label: "Artemis", opencode: { providerId: "local-artemis", provider: provider("http://127.0.0.1:18021/v1") }, pi: { providerId: "local-artemis", provider: { baseUrl: "http://127.0.0.1:18008/v1", api: "openai-completions", apiKey: "local", models: [{ id: "artemis31-v100", name: "Artemis", contextWindow: 196608 }] } } },
    { id: "gemma31-v100", label: "Gemma", opencode: { providerId: "local-gemma4", provider: provider("http://127.0.0.1:18020/v1") } },
    { id: "excluded-one", label: "Excluded", opencode: { providerId: "local-excluded", provider: provider("http://127.0.0.1:1/v1") } },
  ],
};

const prefs = hubModelsState({
  hubModels: {
    enabled: true,
    excluded: ["excluded-one"],
    appliedVersion: 6,
    appliedOpencode: ["local-artemis", "local-gone", "local-excluded"],
    appliedPi: ["local-artemis"],
  },
});

describe("Hub primary mode", () => {
  it("defaults to Hub as the model source and keeps an explicit direct fallback", () => {
    expect(hubModelsState({})).toMatchObject({ mode: "hub", enabled: true });
    expect(hubModelsState({ hubModels: { mode: "direct" } })).toMatchObject({ mode: "direct", enabled: false });
    expect(hubModelsState({ hubModels: { mode: "direct", enabled: true } })).toMatchObject({ mode: "direct", enabled: false });
  });
});

describe("planCatalog", () => {
  it("keeps non-excluded models and prunes previously applied ids", () => {
    const plan = planCatalog(catalog, prefs);
    expect(Object.keys(plan.opencode).sort()).toEqual(["local-artemis", "local-gemma4"]);
    expect(Object.keys(plan.pi)).toEqual(["local-artemis"]);
    expect(plan.removeOpencode).toEqual(["local-gone", "local-excluded"]);
    expect(plan.removePi).toEqual([]);
  });
  it("rejects duplicate provider ids", () => {
    const doubled: HubCatalog = {
      version: 1,
      models: [
        { id: "a", label: "A", opencode: { providerId: "dup", provider: {} } },
        { id: "b", label: "B", opencode: { providerId: "dup", provider: {} } },
      ],
    };
    expect(() => planCatalog(doubled, prefs)).toThrow(/Двойной providerId/);
  });
});

const jsonc = `{
  // Общие модели управляются каталогом Hub.
  "theme": "dark",
  "provider": {
    // локальный провайдер пользователя
    "local-qwen-next": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://127.0.0.1:18019/v1" }, "models": { "q": {} } },
    "local-artemis": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "V100",
      "options": { "baseURL": "http://127.0.0.1:18021/v1", "apiKey": "local" },
      "models": { "m-1": { "name": "M1", "limit": { "context": 196608, "output": 16384 } } }
    },
    "local-gone": { "npm": "x", "options": { "baseURL": "http://gone" }, "models": { "z": {} } }
  },
  "mcp": { "keep": true }
  // финальный комментарий
}
`;

describe("mergeOpencodeProviders", () => {
  it("applies the catalog while preserving local configuration", () => {
    const plan = planCatalog(catalog, prefs);
    const result = mergeOpencodeProviders(jsonc, plan.opencode, plan.removeOpencode);
    expect(result.error).toBeUndefined();
    expect(result.added).toEqual(["local-gemma4"]);
    expect(result.replaced).toEqual([]);
    expect(result.removed).toEqual(["local-gone"]);
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(stripComments(result.text));
    expect(Object.keys(parsed.provider).sort()).toEqual([
      "local-artemis",
      "local-gemma4",
      "local-qwen-next",
    ]);
    expect(parsed.provider["local-qwen-next"].options.baseURL).toContain("18019");
    expect(parsed.mcp).toEqual({ keep: true });
    // Comments outside the provider block and the untouched provider survive as-is.
    expect(result.text).toContain("// Общие модели управляются каталогом Hub.");
    expect(result.text).toContain("// финальный комментарий");
    expect(result.text).toContain('"local-qwen-next": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://127.0.0.1:18019/v1" }, "models": { "q": {} } }');
    // Idempotent second application changes nothing.
    const again = mergeOpencodeProviders(result.text, plan.opencode, []);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(result.text);
  });

  it("replaces a drifted provider with the catalog definition", () => {
    const drifted = jsonc.replace("http://127.0.0.1:18021/v1", "http://127.0.0.1:9999/v1");
    const result = mergeOpencodeProviders(drifted, { "local-artemis": provider("http://127.0.0.1:18021/v1") }, []);
    expect(result.replaced).toEqual(["local-artemis"]);
    const parsed = JSON.parse(stripComments(result.text));
    expect(parsed.provider["local-artemis"].options.baseURL).toContain("18021");
  });

  it("creates the provider block when it is absent", () => {
    const result = mergeOpencodeProviders(`{\n  "theme": "dark"\n}\n`, { "local-new": provider("http://h/v1") }, ["local-missing"]);
    expect(result.added).toEqual(["local-new"]);
    const parsed = JSON.parse(stripComments(result.text));
    expect(parsed.provider["local-new"].options.baseURL).toBe("http://h/v1");
    expect(parsed.theme).toBe("dark");
  });

  it("refuses to touch a malformed provider block", () => {
    const result = mergeOpencodeProviders(`{\n  "provider": null\n}\n`, { "local-new": provider("http://h/v1") }, []);
    expect(result.error).toMatch(/provider/);
    expect(result.changed).toBe(false);
    expect(result.text).toContain('"provider": null');
  });

  it("keeps comments inside the provider block when removing another entry", () => {
    const result = mergeOpencodeProviders(jsonc, {}, ["local-gone"]);
    expect(result.removed).toEqual(["local-gone"]);
    expect(result.text).toContain("// локальный провайдер пользователя");
    const parsed = JSON.parse(stripComments(result.text));
    expect(Object.keys(parsed.provider).sort()).toEqual(["local-artemis", "local-qwen-next"]);
  });

  it("does not corrupt a root object that ends with a trailing comma", () => {
    const result = mergeOpencodeProviders(`{\n  "theme": "dark",\n}\n`, { "local-new": provider("http://h/v1") }, []);
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(stripComments(result.text));
    expect(parsed.provider["local-new"].options.baseURL).toBe("http://h/v1");
    expect(result.text.match(/,,/g)).toBeNull();
  });

  it("creates a whole configuration document when the file is empty", () => {
    const result = mergeOpencodeProviders("", { "local-new": provider("http://h/v1") }, []);
    expect(result.changed).toBe(true);
    expect(JSON.parse(stripComments(result.text)).provider["local-new"].options.baseURL).toBe("http://h/v1");
  });

  it("leaves valid syntax after removing the last entry with surrounding comments", () => {
    const messy = `{
  "provider": {
    "local-a": { "models": {} },
    // удалённый провайдер
    "local-b": { "models": {} },
  }
}
`;
    const result = mergeOpencodeProviders(messy, {}, ["local-b"]);
    expect(result.removed).toEqual(["local-b"]);
    const parsed = JSON.parse(stripComments(result.text));
    expect(Object.keys(parsed.provider)).toEqual(["local-a"]);
  });
});

describe("mergePiModels", () => {
  it("adds, replaces and removes only catalog providers", () => {
    const content = JSON.stringify(
      { providers: { "local-artemis": { baseUrl: "http://old/v1", models: [] }, "local-user": { baseUrl: "http://user/v1", models: [] } }, other: { keep: 1 } },
      null,
      2,
    );
    const plan = planCatalog(catalog, prefs);
    const result = mergePiModels(content, plan.pi, ["local-gone"]);
    expect(result.added).toEqual([]);
    expect(result.replaced).toEqual(["local-artemis"]);
    expect(result.removed).toEqual([]);
    const parsed = JSON.parse(result.text);
    expect(parsed.providers["local-user"].baseUrl).toBe("http://user/v1");
    expect(parsed.other).toEqual({ keep: 1 });
    expect(parsed.providers["local-artemis"].models[0].contextWindow).toBe(196608);
    const again = mergePiModels(result.text, plan.pi, []);
    expect(again.changed).toBe(false);
  });

  it("creates the file content when empty and reports broken JSON", () => {
    const plan = planCatalog(catalog, prefs);
    const created = mergePiModels("", plan.pi, []);
    expect(created.changed).toBe(true);
    expect(JSON.parse(created.text).providers["local-artemis"].baseUrl).toContain("18008");
    const broken = mergePiModels("{oops", plan.pi, []);
    expect(broken.error).toMatch(/не разобран/);
    expect(broken.changed).toBe(false);
  });
});
