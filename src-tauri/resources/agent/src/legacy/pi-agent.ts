// Migration planner only. No writes, subprocesses, SDK, environment lookup,
// default ~/.pi discovery or plugin execution. Commit requires a real host port.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { directory, readStable, shaBytes, validOrigin } from "./files.ts";
import { object, type Json, type ObjectValue } from "./pi-jsonl.ts";

export interface ConfigSecret { id: string; sourcePointer: string; provider: string | null; value: Json }
export interface SecretBinding { pointer: string; vaultId: string; provider: string | null; kind: "api-key" | "header" | "credential" }
export interface PiAgentPlan {
  version: 1; origin: string;
  /** These are the ONLY plaintext files allowed to be published. */
  files: Array<{ name: "models.json" | "settings.json" | "keybindings.json"; content: string; sha256: string }>;
  sourceHashes: Record<string, string>;
  bindings: SecretBinding[];
  /** In-memory sensitive values. Never JSON.stringify/log/journal this object. */
  secrets: ConfigSecret[];
  /** Key paths only; values and resource paths aren't copied or discovered. */
  deferred: string[];
  discovery: { extensions: false; skills: false; prompts: false; packages: false; project: false };
}
/** Real implementation must use native vault + durable publish journal. */
export interface PiConfigCommitPort {
  commit(plan: PiAgentPlan): Promise<{
    receiptId: string;
    /** Returned only after vault writes and atomically published files are durable. */
    files: Array<{ name: string; sha256: string }>;
    vaultIds: string[];
  }>;
}
export class PiConfigError extends Error {
  readonly pointerHash: string;
  constructor(readonly code: string, pointer: string) {
    // Config contents, names of custom providers/headers and source paths may
    // themselves be sensitive. Logs expose a structural pointer hash only.
    super(`Перенос настроек Pi остановлен: ${code} (${createHash("sha256").update(pointer).digest("hex").slice(0, 12)}). Исходник не изменён.`);
    this.name = "PiConfigError";
    this.pointerHash = createHash("sha256").update(pointer).digest("hex");
  }
}
function reject(code: string, pointer: string): never { throw new PiConfigError(code, pointer); }
const plans = new WeakSet<PiAgentPlan>();
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function exactKeys(value: ObjectValue, allowed: readonly string[], pointer: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reject("unsupported_field", `${pointer}/${key}`);
}
function string(value: Json | undefined, pointer: string): string {
  if (typeof value !== "string" || !value || value.length > 32768 || /[\u0000-\u001f]/.test(value)) reject("invalid_string", pointer);
  return value;
}
function scalarRecord(value: Json | undefined, allowed: Record<string, "boolean" | "number" | "string">, pointer: string): ObjectValue {
  if (!object(value)) reject("invalid_object", pointer);
  exactKeys(value, Object.keys(allowed), pointer);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== allowed[key] || typeof item === "number" && (!Number.isFinite(item) || item < 0)) reject("invalid_value", `${pointer}/${key}`);
  }
  return { ...value };
}
function url(value: Json | undefined, pointer: string): string {
  const raw = string(value, pointer);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { reject("invalid_url", pointer); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    reject("url_requires_explicit_secret_transform", pointer);
  return raw;
}
function literalSecret(value: Json | undefined, pointer: string): string {
  const raw = string(value, pointer);
  // Pi supports !shell and $environment expressions. Migrating those by
  // resolving ambient state would execute code or pull unrelated credentials.
  if (raw.startsWith("!") || raw.startsWith("$")) reject("secret_expression_requires_explicit_resolver", pointer);
  return raw;
}
function addSecret(plan: PiAgentPlan, pointer: string, value: Json, provider: string | null, kind: SecretBinding["kind"]): void {
  const id = `pi-import-${createHash("sha256").update(plan.origin).update("\0").update(pointer).digest("hex")}`;
  plan.secrets.push({ id, sourcePointer: pointer, provider, value });
  plan.bindings.push({ pointer, vaultId: id, provider, kind });
}
function headers(value: Json | undefined, pointer: string, provider: string, plan: PiAgentPlan): void {
  if (!object(value)) reject("invalid_headers", pointer);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) reject("invalid_header_name", pointer);
    if (item === null) addSecret(plan, `${pointer}/${key}`, null, provider, "header");
    else addSecret(plan, `${pointer}/${key}`, literalSecret(item, pointer), provider, "header");
  }
}
function models(value: unknown, plan: PiAgentPlan): ObjectValue {
  if (!object(value) || !object(value.providers)) reject("invalid_models", "/models");
  exactKeys(value, ["providers"], "/models");
  const providers: ObjectValue = Object.create(null);
  const modelKeys = ["id", "name", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens", "headers"];
  for (const [provider, config] of Object.entries(value.providers)) {
    const p = `/models/providers/${provider}`;
    if (!provider || provider.length > 256 || !object(config)) reject("invalid_provider", p);
    exactKeys(config, ["baseUrl", "api", "apiKey", "authHeader", "oauth", "headers", "models", "modelOverrides"], p);
    const sanitized: ObjectValue = Object.create(null);
    for (const [key, item] of Object.entries(config)) {
      const pointer = `${p}/${key}`;
      if (key === "apiKey") addSecret(plan, pointer, literalSecret(item, pointer), provider, "api-key");
      else if (key === "headers") headers(item, pointer, provider, plan);
      else if (key === "baseUrl") sanitized[key] = url(item, pointer);
      else if (key === "api" || key === "oauth") sanitized[key] = string(item, pointer);
      else if (key === "authHeader") { if (typeof item !== "boolean") reject("invalid_auth_header", pointer); sanitized[key] = item; }
      else if (key === "models" || key === "modelOverrides") {
        const items = key === "models" ? Array.isArray(item) ? item.map((model, index) => [String(index), model] as const) : null
          : object(item) ? Object.entries(item) : null;
        if (!items) reject("invalid_models", pointer);
        const output: ObjectValue | Json[] = key === "models" ? [] : Object.create(null);
        for (const [modelId, model] of items) {
          const mp = `${pointer}/${modelId}`;
          if (!object(model)) reject("invalid_model", mp);
          exactKeys(model, modelKeys, mp);
          if (key === "models" && typeof model.id !== "string") reject("missing_model_id", mp);
          const clean: ObjectValue = Object.create(null);
          for (const [field, val] of Object.entries(model)) {
            const fieldPointer = `${mp}/${field}`;
            if (field === "headers") headers(val, fieldPointer, provider, plan);
            else if (field === "baseUrl") clean[field] = url(val, fieldPointer);
            else if (["id", "name", "api"].includes(field)) clean[field] = string(val, fieldPointer);
            else if (field === "reasoning") { if (typeof val !== "boolean") reject("invalid_reasoning", fieldPointer); clean[field] = val; }
            else if (field === "input") {
              if (!Array.isArray(val) || !val.every(v => v === "text" || v === "image")) reject("invalid_input", fieldPointer); clean[field] = val;
            } else if (field === "cost") clean[field] = scalarRecord(val, { input: "number", output: "number", cacheRead: "number", cacheWrite: "number" }, fieldPointer);
            else { if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 1) reject("invalid_model_limit", fieldPointer); clean[field] = val; }
          }
          if (Array.isArray(output)) output.push(clean); else output[modelId] = clean;
        }
        sanitized[key] = output;
      }
    }
    providers[provider] = sanitized;
  }
  return { providers };
}
const resources = ["extensions", "skills", "prompts", "themes", "packages", "defaultProjectTrust", "externalEditor", "shellPath", "shellCommandPrefix", "npmCommand", "sessionDir", "httpProxy", "trackingId"];
const stringSettings = ["defaultProvider", "defaultModel", "theme", "lastChangelogVersion"];
const booleanSettings = ["hideThinkingBlock", "showCacheMissNotices", "quietStartup", "collapseChangelog", "enableInstallTelemetry", "enableAnalytics", "enableSkillCommands", "showHardwareCursor", "fullscreenCopyOnSelect"];
const numberSettings = ["editorPaddingX", "outputPad", "autocompleteMaxVisible", "httpIdleTimeoutMs", "websocketConnectTimeoutMs"];
const enums: Record<string, readonly string[]> = {
  defaultThinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], transport: ["sse", "websocket", "auto"],
  steeringMode: ["all", "one-at-a-time"], followUpMode: ["all", "one-at-a-time"],
  doubleEscapeAction: ["fork", "tree", "none"], treeFilterMode: ["default", "no-tools", "user-only", "labeled-only", "all"],
};
const objectSettings: Record<string, Record<string, "number" | "boolean" | "string">> = {
  compaction: { enabled: "boolean", reserveTokens: "number", keepRecentTokens: "number" },
  branchSummary: { reserveTokens: "number", enabled: "boolean" }, retry: { enabled: "boolean", maxRetries: "number", baseDelayMs: "number", maxDelayMs: "number" },
  thinkingBudgets: { minimal: "number", low: "number", medium: "number", high: "number", xhigh: "number", max: "number" },
};
function settings(value: unknown, plan: PiAgentPlan): ObjectValue {
  if (!object(value)) reject("invalid_settings", "/settings");
  const clean: ObjectValue = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const pointer = `/settings/${key}`;
    if (resources.includes(key)) { plan.deferred.push(pointer); continue; }
    if (stringSettings.includes(key)) clean[key] = string(item, pointer);
    else if (booleanSettings.includes(key)) { if (typeof item !== "boolean") reject("invalid_setting", pointer); clean[key] = item; }
    else if (numberSettings.includes(key)) { if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) reject("invalid_setting", pointer); clean[key] = item; }
    else if (enums[key]) { if (typeof item !== "string" || !enums[key].includes(item)) reject("invalid_setting", pointer); clean[key] = item; }
    else if (objectSettings[key]) clean[key] = scalarRecord(item, objectSettings[key], pointer);
    else if (key === "enabledModels" || key === "defaultTools") { if (!Array.isArray(item) || !item.every(v => typeof v === "string")) reject("invalid_setting", pointer); clean[key] = item; }
    else if (key === "modelThinkingLevels") {
      if (!object(item) || !Object.values(item).every(level => typeof level === "string" && enums.defaultThinkingLevel.includes(level))) reject("invalid_setting", pointer);
      clean[key] = { ...item };
    } else reject("unsupported_setting_requires_transform", pointer);
  }
  // These legacy paths never enable ambient discovery, installation or trust.
  // The SDK host must consume the explicit discovery policy, not defaults.
  return clean;
}
function auth(value: unknown, plan: PiAgentPlan): void {
  if (!object(value)) reject("invalid_auth", "/auth");
  for (const [provider, item] of Object.entries(value)) {
    const pointer = `/auth/${provider}`;
    if (!object(item) || !["api_key", "oauth"].includes(String(item.type))) reject("invalid_credential", pointer);
    if (item.type === "api_key") {
      exactKeys(item, ["type", "key", "env"], pointer);
      if (item.key !== undefined) literalSecret(item.key, pointer);
      if (item.env !== undefined && (!object(item.env) || !Object.values(item.env).every(v => typeof v === "string"))) reject("invalid_provider_env", pointer);
      if (item.key === undefined && item.env === undefined) reject("empty_credential", pointer);
    } else {
      if (typeof item.refresh !== "string" || typeof item.access !== "string" || typeof item.expires !== "number" || !Number.isFinite(item.expires)) reject("invalid_oauth", pointer);
      // OAuth has provider-specific extra fields by its public index signature;
      // the WHOLE credential remains only in the vault, not a JSON sidecar.
    }
    addSecret(plan, pointer, item, provider, "credential");
  }
}
/** Explicit caller-selected directory only; all source files are read-only. */
export function planPiAgentImport(sourceDir: string, options: { origin: string; credentialsOnly?: boolean }): PiAgentPlan {
  if (!validOrigin(options.origin)) reject("invalid_origin", "/");
  const root = directory(sourceDir);
  const plan: PiAgentPlan = { version: 1, origin: options.origin, files: [], sourceHashes: {}, bindings: [], secrets: [], deferred: [],
    discovery: { extensions: false, skills: false, prompts: false, packages: false, project: false } };
  for (const name of ["models.json", "settings.json", "keybindings.json", "auth.json"] as const) {
    if (options.credentialsOnly && name !== "auth.json") continue;
    const file = path.join(root, name);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
    const bytes = readStable(file, 4 * 1024 * 1024);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { reject("malformed_json", `/${name}`); }
    plan.sourceHashes[name] = shaBytes(bytes);
    if (name === "auth.json") { auth(value, plan); continue; }
    let clean: ObjectValue;
    if (name === "models.json") clean = models(value, plan);
    else if (name === "settings.json") clean = settings(value, plan);
    else {
      if (!object(value) || !Object.values(value).every(v => typeof v === "string" || Array.isArray(v) && v.every(key => typeof key === "string"))) reject("invalid_keybindings", "/keybindings");
      clean = value;
    }
    const content = JSON.stringify(clean, null, 2) + "\n";
    plan.files.push({ name, content, sha256: shaBytes(Buffer.from(content)) });
  }
  freeze(plan); plans.add(plan);
  return plan;
}

/** Mandatory port, no concrete/fake vault, filesystem fallback or partial copy. */
export async function importPiAgent(plan: PiAgentPlan, host: PiConfigCommitPort | null): Promise<{ receiptId: string; copied: string[]; credentials: number; deferred: string[] }> {
  if (!plans.has(plan) || !Object.isFrozen(plan)) reject("internal_validated_plan_required", "/");
  if (!host) reject("native_vault_and_journal_commit_required", "/");
  const receipt = await host.commit(plan);
  if (!receipt.receiptId || receipt.files.length !== plan.files.length || receipt.vaultIds.length !== plan.secrets.length
    || !plan.files.every(file => receipt.files.some(item => item.name === file.name && item.sha256 === file.sha256))
    || !plan.secrets.every(secret => receipt.vaultIds.includes(secret.id))) reject("incomplete_commit_receipt", "/");
  return { receiptId: receipt.receiptId, copied: plan.files.map(file => file.name), credentials: plan.secrets.length, deferred: [...plan.deferred] };
}
