// Distinguishes "this model cannot do the work right now" from an ordinary
// inference failure. Quota and auth failures are account-level facts: resending
// the same prompt to the same provider repeats the same error, so the correct
// move is to offer another provider's model, not to retry. Provider errors
// arrive as raw SDK/HTTP texts, hence pattern classification (never invented
// statuses). The tiny probe uses only documented minimal request shapes; an
// unknown API stays "unknown" and the normal attempt decides.
import { catalogueRequest, type CatalogProvider, type SdkModel, type SdkModelRuntime } from "../sdk/adapter.ts";

export type AvailabilityKind = "ready" | "quota" | "auth" | "unreachable" | "unknown";

const QUOTA = /\b429\b|\b402\b|exceeded_current_quota|insufficient_quota|rate.?limit|usage limit|payment required|quota|billing/i;
const AUTH = /\b401\b|invalid.?api.?key|unauthorized|token expired|expired token|authentication/i;
const UNREACHABLE = /ECONNREFUSED|ECONNRESET|EHOSTUNHOST|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|fetch failed|failed to fetch|socket hang up|network|connection (?:refused|closed|lost|error)/i;

/** Classify a provider/model failure from its message text. `unknown` means
 * "ordinary failure": existing typed recovery applies, no model offer. */
export function classifyModelFailure(error: unknown): AvailabilityKind {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (UNREACHABLE.test(text)) return "unreachable";
  return "unknown";
}

/** User-readable cause for `kind`, or null when the kind is not a blocking
 * unavailability (ready/unknown). */
export function availabilityProblem(kind: AvailabilityKind): string | null {
  switch (kind) {
    case "quota": return "исчерпан лимит запросов провайдера";
    case "auth": return "доступ к модели потерян (ключ или подписка)";
    case "unreachable": return "сервер модели не отвечает";
    default: return null;
  }
}

export interface ResolvedProbe { baseURL: string; headers: Record<string, string> }

export type ProbeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

function probeRequest(api: string, modelID: string, base: string): { url: string; body: Record<string, unknown> } | null {
  const root = base.replace(/\/+$/, "");
  if (api === "openai-completions")
    return { url: `${root}/chat/completions`, body: { model: modelID, messages: [{ role: "user", content: "ping" }], max_tokens: 1 } };
  if (api === "openai-responses")
    return { url: `${root}/responses`, body: { model: modelID, input: "ping", max_output_tokens: 1 } };
  if (api === "anthropic-messages")
    return { url: `${root}/v1/messages`, body: { model: modelID, max_tokens: 1, messages: [{ role: "user", content: "ping" }] } };
  return null;
}

function fromResponse(status: number, body: string): AvailabilityKind {
  if (status >= 200 && status < 300) return "ready";
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (QUOTA.test(body)) return "quota";
  return "unknown";
}

/** Pure probe over already-resolved access material (unit-testable). */
export async function probeResolvedAvailability(api: string, modelID: string, resolved: ResolvedProbe | null,
  signal: AbortSignal, fetchImpl: ProbeFetch = globalThis.fetch as unknown as ProbeFetch): Promise<AvailabilityKind> {
  if (!resolved) return "unknown";
  const request = probeRequest(api, modelID, resolved.baseURL);
  if (!request) return "unknown";
  try {
    const response = await fetchImpl(request.url, {
      method: "POST", headers: { ...resolved.headers, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request.body), signal,
    });
    return fromResponse(response.status, await response.text().catch(() => ""));
  } catch (error) {
    if (signal.aborted) return "unknown";
    return classifyModelFailure(error) === "unreachable" ? "unreachable" : "unknown";
  }
}

/** Availability of the model's own endpoint before an expensive summary call.
 * `unknown` (no saved access, unsupported API, abort) never blocks the normal
 * attempt; only an explicit quota/auth verdict short-circuits it. A network
 * verdict is reported as `unreachable` so a dead local server is distinguishable. */
export async function probeModelAvailability(runtime: SdkModelRuntime, model: SdkModel, signal: AbortSignal,
  fetchImpl?: ProbeFetch): Promise<AvailabilityKind> {
  if (!signal.aborted) {
    try {
      const resolved = await catalogueRequest(runtime, model, signal);
      if (resolved) return await probeResolvedAvailability(model.api, model.id, resolved, signal, fetchImpl);
    } catch { /* discovery failures must never block the real attempt */ }
  }
  return "unknown";
}

export interface AlternativeCandidate { providerID: string; modelID: string; name: string; contextWindow: number }

/** The summary request must FIT the candidate, so require a window that holds
 * the whole current context plus margin. Quota is account-level: only OTHER
 * providers qualify. Largest window first ("ближайшая, которая точно сможет"),
 * deterministic on ties; unconfigured providers never qualify. */
export function pickCompactionAlternatives(snapshot: readonly CatalogProvider[], source: { providerID: string; modelID: string },
  neededTokens: number, limit = 3): AlternativeCandidate[] {
  const margin = 4096;
  const out: AlternativeCandidate[] = [];
  for (const provider of snapshot) {
    if (!provider.configured || provider.id === source.providerID) continue;
    for (const model of provider.models) {
      if ((model.contextWindow ?? 0) < neededTokens + margin) continue;
      out.push({ providerID: provider.id, modelID: model.id, name: model.name || model.id, contextWindow: model.contextWindow });
    }
  }
  return out.sort((a, b) => b.contextWindow - a.contextWindow
    || a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID)).slice(0, limit);
}
