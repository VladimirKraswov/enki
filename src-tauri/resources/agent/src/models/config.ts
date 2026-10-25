// Active imported Pi configuration, projected into memory before any provider
// request. The native authority owns the head; this module only verifies the
// sanitized immutable generation on disk (hash, size, no links) and resolves
// its secret bindings through the local broker into private maps. Values are
// never returned by status(), never serialized and never handed to SDK config
// interpolation: API keys reach the SDK as stored credentials, headers are
// injected by the host hook (see sdk/adapter.ts).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Broker } from "../control/broker.ts";

export interface ConfigBinding { vaultId: string; provider: string | null; kind: "api-key" | "header" | "credential"; pointer: string }
export interface ConfigSnapshot {
  configRevision: number; generationId: string | null; manifestHash?: string; directory?: string;
  files?: Array<{ name: string; sha256: string; size: number }>; bindings?: ConfigBinding[]; deferred?: string[];
}
export type ConfigState = "none" | "ready" | "shadowed" | "blocked";
export interface ConfigStatus {
  state: ConfigState; code: string | null; configRevision: number; generationId: string | null; deferred: string[];
  /** Present only after this process committed a newer generation: it is NOT
   * active (status above still describes the running projection) until restart. */
  pendingRestart?: { configRevision: number; generationId: string };
}

export class ConfigUnavailable extends Error {
  constructor(readonly code: string, message = "Импортированные настройки моделей недоступны: ключ отсутствует в хранилище ОС. Запрос к провайдеру не отправлен.") {
    super(`${code}: ${message}`);
    this.name = "ConfigUnavailable";
  }
}

interface HeaderRule { provider: string; model: string | null; name: string; value: string | null }
const MAX_FILE = 4 * 1024 * 1024;
const PROVIDER = /^[A-Za-z0-9._-]{1,128}$/;
/** Behavior settings projected into SettingsManager.inMemory; UI-only keys stay inert. */
const PROJECTED_SETTINGS = ["defaultThinkingLevel", "transport", "steeringMode", "followUpMode", "thinkingBudgets", "retry",
  "branchSummary", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "enabledModels", "modelThinkingLevels", "hideThinkingBlock"] as const;

function verifiedFile(directory: string, file: { name: string; sha256: string; size: number }): Buffer {
  if (!["models.json", "settings.json", "keybindings.json"].includes(file.name) || file.size > MAX_FILE) throw new ConfigUnavailable("CONFIG_GENERATION_CORRUPT", "Сохранённое поколение настроек повреждено.");
  const full = path.join(directory, file.name);
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== file.size) throw new ConfigUnavailable("CONFIG_GENERATION_CORRUPT", "Сохранённое поколение настроек повреждено.");
    const bytes = fs.readFileSync(fd);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new ConfigUnavailable("CONFIG_GENERATION_CORRUPT", "Сохранённое поколение настроек повреждено.");
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Planner pointers → header rule target. Unknown shapes are refused, never guessed. */
export function headerTarget(pointer: string, models: unknown): { provider: string; model: string | null; name: string } | null {
  const base = /^\/models\/providers\/([A-Za-z0-9._-]{1,128})\/(.+)$/.exec(pointer);
  if (!base) return null;
  const [, provider, rest] = base;
  // Header names are HTTP tokens (no "/"), so the LAST "/headers/" separates
  // a model id that may itself contain slashes from the header name.
  const at = rest.startsWith("headers/") ? -1 : rest.lastIndexOf("/headers/");
  const scope = at === -1 ? (rest.startsWith("headers/") ? "" : null) : rest.slice(0, at);
  const name = at === -1 ? rest.slice("headers/".length) : rest.slice(at + "/headers/".length);
  if (scope === null || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
  if (!scope) return { provider, model: null, name };
  const override = /^modelOverrides\/(.+)$/.exec(scope);
  if (override) return { provider, model: override[1], name };
  const indexed = /^models\/(\d+)$/.exec(scope);
  const list = (models as { providers?: Record<string, { models?: Array<{ id?: unknown }> }> } | undefined)?.providers?.[provider]?.models;
  const id = indexed ? list?.[Number(indexed[1])]?.id : undefined;
  return typeof id === "string" ? { provider, model: id, name } : null;
}

/** Owner-edited agentDir/models.json with providers (or unreadable: still the owner's). */
export function userModelsPresent(agentDir: string): boolean {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const providers = (value as { providers?: unknown } | null)?.providers;
    return !!providers && typeof providers === "object" && Object.keys(providers).length > 0;
  } catch (error) {
    // Absent is "no user models"; an unreadable/malformed file is still the
    // owner's canonical config and must shadow the import rather than vanish.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function projectSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of PROJECTED_SETTINGS) if (key in value) out[key] = structuredClone((value as Record<string, unknown>)[key]);
  return Object.freeze(out);
}

/** Imported Pi `defaultProvider` + `defaultModel` as a typed request only. It
 * is never written into SDK settings; Runtime.configDefaults() validates it
 * against the live catalog and admission before anything uses it. */
export interface ImportedDefaultModel { providerID: string; modelID: string }
function importedDefault(value: unknown): ImportedDefaultModel | null {
  const v = value as { defaultProvider?: unknown; defaultModel?: unknown } | null;
  if (!v || typeof v !== "object" || typeof v.defaultProvider !== "string" || typeof v.defaultModel !== "string") return null;
  if (!PROVIDER.test(v.defaultProvider) || !v.defaultModel || v.defaultModel.length > 256) return null;
  return Object.freeze({ providerID: v.defaultProvider, modelID: v.defaultModel });
}

export class ConfigProjection {
  private constructor(
    readonly snapshot: ConfigSnapshot,
    readonly state: ConfigState,
    readonly code: string | null,
    /** Immutable generation models.json for ModelRuntime, or null to keep agentDir/models.json. */
    readonly modelsPath: string | null,
    private readonly rules: readonly HeaderRule[],
    private readonly keys: ReadonlyMap<string, string>,
    /** Providers that must not reach the network unless their bindings resolved. */
    private readonly bound: ReadonlySet<string>,
    private readonly blockAll: boolean,
    readonly settings: Readonly<Record<string, unknown>>,
    /** Unvalidated imported default model selector (see importedDefault). */
    readonly defaultModel: ImportedDefaultModel | null = null,
  ) { Object.freeze(this); }

  static none(): ConfigProjection {
    return new ConfigProjection({ configRevision: 0, generationId: null }, "none", null, null, [], new Map(), new Set(), false, {});
  }

  /** Verified-but-unresolved generations keep their catalog visible (so the
   * refusal is explainable) while every bound provider is refused. */
  private static blocked(snapshot: ConfigSnapshot, code: string, all: boolean, modelsPath: string | null = null, defaultModel: ImportedDefaultModel | null = null): ConfigProjection {
    const bound = new Set((snapshot.bindings ?? []).flatMap(b => b.provider ? [b.provider] : []));
    return new ConfigProjection(snapshot, "blocked", code, modelsPath, [], new Map(), bound, all, {}, defaultModel);
  }

  /**
   * Restart path: verified committed snapshot → bindings resolved in memory.
   * Any failure is fail-closed for the affected providers (or for all model
   * access when the authority itself cannot be read), never an ambient key.
   */
  static async load(broker: Broker, options: { agentDir: string; signal?: AbortSignal }): Promise<ConfigProjection> {
    let snapshot: ConfigSnapshot;
    try { snapshot = await broker.call<ConfigSnapshot>("config.current", {}, options.signal, 20_000); }
    catch { return ConfigProjection.blocked({ configRevision: 0, generationId: null }, "CONFIG_UNAVAILABLE", true); }
    if (!snapshot.generationId) return new ConfigProjection(snapshot, "none", null, null, [], new Map(), new Set(), false, {});
    const { directory, files, bindings } = snapshot;
    if (!directory || !path.isAbsolute(directory) || !Array.isArray(files) || !Array.isArray(bindings))
      return ConfigProjection.blocked(snapshot, "CONFIG_GENERATION_CORRUPT", true);
    const parsed = new Map<string, unknown>();
    try {
      for (const file of files) parsed.set(file.name, JSON.parse(verifiedFile(directory, file).toString("utf8")));
    } catch { return ConfigProjection.blocked(snapshot, "CONFIG_GENERATION_CORRUPT", false); }
    const models = parsed.get("models.json");
    const modelsPath = models ? path.join(directory, "models.json") : null;
    if (models && userModelsPresent(options.agentDir))
      // Deterministic precedence: a models.json the owner edits in Enki stays
      // canonical; imported endpoints/headers/keys are not mixed into it.
      return new ConfigProjection(snapshot, "shadowed", "CONFIG_GENERATION_SHADOWED", null, [], new Map(), new Set(), false,
        projectSettings(parsed.get("settings.json")), importedDefault(parsed.get("settings.json")));
    const rules: HeaderRule[] = [], keys = new Map<string, string>();
    try {
      for (const binding of bindings) {
        if (binding.kind === "credential") continue; // provider credential rows, read via CredentialStore
        if (!binding.provider || !PROVIDER.test(binding.provider)) throw new ConfigUnavailable("CONFIG_BINDING_UNSUPPORTED");
        const read = await broker.call<{ value: string }>("config.secretRead", { configRevision: snapshot.configRevision, logicalId: binding.vaultId }, options.signal, 20_000);
        const value: unknown = JSON.parse(read.value);
        if (binding.kind === "api-key") {
          if (typeof value !== "string" || binding.pointer !== `/models/providers/${binding.provider}/apiKey`) throw new ConfigUnavailable("CONFIG_BINDING_UNSUPPORTED");
          keys.set(binding.provider, value);
        } else {
          const target = headerTarget(binding.pointer, models);
          if (!target || target.provider !== binding.provider || !(typeof value === "string" || value === null)) throw new ConfigUnavailable("CONFIG_BINDING_UNSUPPORTED");
          rules.push({ ...target, value });
        }
      }
    } catch (error) {
      // Partial values are dropped with the local maps; nothing was exposed.
      // The default is kept so its refusal stays explainable (configDefaults).
      return ConfigProjection.blocked(snapshot, error instanceof ConfigUnavailable ? error.code : "CONFIG_SECRET_UNAVAILABLE", false, modelsPath, importedDefault(parsed.get("settings.json")));
    }
    const bound = new Set(bindings.flatMap(b => b.provider && b.kind !== "credential" ? [b.provider] : []));
    return new ConfigProjection(snapshot, "ready", null, modelsPath,
      Object.freeze(rules), keys, bound, false, projectSettings(parsed.get("settings.json")), importedDefault(parsed.get("settings.json")));
  }

  /**
   * Mandatory preflight before ANY session/request for `provider` (including
   * ephemeral model checks). The SDK swallows header-hook exceptions, so this
   * check — not the hook — is what keeps a missing binding off the network.
   */
  assertAdmissible(provider: string | undefined): void {
    if (this.state !== "blocked") return;
    if (this.blockAll || (provider !== undefined && this.bound.has(provider))) throw new ConfigUnavailable(this.code ?? "CONFIG_SECRET_UNAVAILABLE");
  }

  /** Literal header values for one provider+model; later rules win case-insensitively, null deletes. */
  headersFor(provider: string, model: string | undefined): Array<[string, string | null]> {
    if (this.state !== "ready") return [];
    const merged = new Map<string, [string, string | null]>();
    const apply = (rule: HeaderRule) => merged.set(rule.name.toLowerCase(), [rule.name, rule.value]);
    for (const rule of this.rules) if (rule.provider === provider && rule.model === null) apply(rule);
    for (const rule of this.rules) if (rule.provider === provider && rule.model !== null && rule.model === model) apply(rule);
    return [...merged.values()];
  }

  /** models.json literal key: a fallback AFTER any stored provider credential (SDK precedence). */
  apiKey(provider: string): string | undefined {
    return this.state === "ready" ? this.keys.get(provider) : undefined;
  }

  needsHeaders(): boolean { return this.rules.length > 0; }

  /** Sanitized DTO: no values, header literals, key material or source paths. */
  status(): ConfigStatus {
    return { state: this.state, code: this.code, configRevision: this.snapshot.configRevision, generationId: this.snapshot.generationId,
      deferred: [...(this.snapshot.deferred ?? [])] };
  }
}

/** In-place header mutation for the public before_provider_headers hook. */
export function applyHeaders(target: Record<string, string | null | undefined>, headers: Array<[string, string | null]>): void {
  for (const [name, value] of headers) {
    for (const key of Object.keys(target)) if (key.toLowerCase() === name.toLowerCase()) delete target[key];
    target[name] = value;
  }
}
