// Types for session.mjs, consumed by runtime tests of the browser daemon's
// session ownership (the daemon itself is an untyped .mjs entry).
export interface BrowserSessionIdentity { engine: "opencode" | "pi"; sessionID: string }
export function browserSession(value: unknown): BrowserSessionIdentity;
export function stripSession(params: { arguments?: Record<string, unknown>; _meta?: Record<string, unknown>; [key: string]: unknown }): {
  session: BrowserSessionIdentity | undefined; params: Record<string, unknown>; access?: "full";
};
export interface EvictionCandidate { key: string; busy?: number; context?: unknown; composition?: unknown; lastUsed: number }
export function evictableSession<T extends EvictionCandidate>(sessions: Iterable<T>, selectedKey: string | null): T | undefined;
export function sessionKey(directory: string, value: unknown): string;
