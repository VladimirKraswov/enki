// Authored PermissionRule glob patterns and observed grants are different
// authorities. Only recognised namespaced/versioned rows are observed grants;
// old untyped rows are deliberately NOT guessed to be exact or glob grants.
import { createHash } from "node:crypto";
import { canonicalJson } from "../protocol.ts";

export interface ObservedGrant { permission: string; pattern: string; identity: string; tool?: "bash" }
const PREFIX = "\u0000enki:observed-exact:v1:";
const BASH = "\u0000enki:observed-bash-tool:v1";
const HASH = /^[a-f0-9]{64}$/;
export function exactIdentity(permission: string, value: unknown): string {
  return createHash("sha256").update("enki-observed-action-v1\0").update(permission).update("\0").update(canonicalJson(value)).digest("hex");
}
export function storedGrant(grant: Pick<ObservedGrant, "permission" | "identity">): { permission: string; pattern: string } {
  if (!grant.permission || /[\u0000-\u001f]/.test(grant.permission) || grant.permission.length > 256 || !HASH.test(grant.identity))
    throw new Error("Не удалось безопасно запомнить разрешение действия.");
  return { permission: PREFIX + grant.permission, pattern: grant.identity };
}
/** Explicit new approval only; old exact/untyped rows are never widened. */
export function storedBashGrant(): { permission: string; pattern: string } {
  return { permission: BASH, pattern: "bash" };
}
export function readGrant(permission: string, pattern: string): ObservedGrant | null {
  if (permission === BASH) return pattern === "bash" ? { permission: "bash", pattern: "", identity: "", tool: "bash" } : null;
  if (!permission.startsWith(PREFIX) || !HASH.test(pattern)) return null;
  const name = permission.slice(PREFIX.length);
  if (!name || name.length > 256 || /[\u0000-\u001f]/.test(name)) return null;
  return { permission: name, pattern: "", identity: pattern };
}
/** Presentation only. The complete input is hashed separately, never redacted for identity. */
export function permissionPreview(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = "[credentials]"; url.password = ""; }
        for (const key of [...url.searchParams.keys()]) {
          if (/^(?:api[_-]?key|key|token|access[_-]?token|secret|password|authorization)$/i.test(key)) url.searchParams.set(key, "[redacted]");
        }
        return url.href;
      } catch { return raw; }
    })
    .replace(/(https?:\/\/)[^\s/?#]*@/gi, "$1[credentials]@")
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (raw, separator: string, key: string) => {
      try {
        return /^(?:api[_-]?key|key|token|access[_-]?token|secret|password|authorization)$/i.test(decodeURIComponent(key.replaceAll("+", " ")))
          ? `${separator}${key}=[redacted]` : raw;
      } catch { return raw; }
    })
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]");
}
