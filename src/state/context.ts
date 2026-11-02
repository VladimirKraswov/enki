import type { AssistantMessage, ModelInfo } from "../api/types";
import type { SessionChatState } from "./chatReducer";
import { compactionBudget } from '../../src-tauri/resources/agent/src/context-budget';
export interface CompactionConfig {
  auto?: boolean;
  prune?: boolean;
  reserved?: number;
  preserve_recent_tokens?: number;
  tail_turns?: number;
}
/** Current working context, not the sum of historical usage. Budget is shared
 * with the pinned SDK adapter rather than a retired engine's policy. */
export function contextUsage(
  chat: SessionChatState | undefined,
  model: ModelInfo | null | undefined,
  config: CompactionConfig = {},
) {
  const limit = model?.limit?.context ?? 0;
  const threshold = limit ? compactionBudget({ contextWindow: limit, maxTokens: model?.limit?.output || 32000 },
    { reserveTokens: config.reserved, keepRecentTokens: config.preserve_recent_tokens }).triggerTokens : 0;
  // Rendered on every streamed delta: walk back from the tail without copying
  // the whole transcript; the newest measured reply is usually the last one.
  let latest: AssistantMessage | undefined;
  const order = chat?.messageOrder ?? [];
  for (let i = order.length - 1; i >= 0 && !latest; i--) {
    const m = chat!.messages[order[i]];
    if (m?.role === "assistant" && m.tokens && (m.tokens.total || m.tokens.input || m.tokens.output || m.tokens.cache?.read || m.tokens.cache?.write))
      latest = m;
  }
  // A model switch changes tokenization and the context limit. The last usage
  // measured for a different model is not a valid count for the selected one.
  const measuredForSelected =
    !latest || !model ||
    ((!latest.modelID || latest.modelID === model.id) &&
      (!latest.providerID || latest.providerID === model.providerID));
  // Summary usage describes the old INPUT, not the resulting working context.
  const summaryBoundary = latest?.summary && latest.time.completed && !latest.error;
  const t = measuredForSelected && !summaryBoundary ? latest?.tokens : undefined;
  const used = t
    ? t.total ||
      (t.input ?? 0) +
        (t.output ?? 0) +
        (t.cache?.read ?? 0) +
        (t.cache?.write ?? 0)
    : null;
  const compacting =
    !!chat &&
    chat.messageOrder.some((id) => {
      const m = chat.messages[id];
      return (
        m?.role === "assistant" && m.summary && !m.time.completed && !m.error
      );
    });
  return {
    limit,
    threshold,
    used,
    remaining: used === null ? null : Math.max(0, threshold - used),
    percent:
      limit && used !== null
        ? Math.min(100, Math.round((used / limit) * 100))
        : 0,
    auto: config.auto !== false,
    compacting,
    measuredModel: measuredForSelected ? latest?.modelID : undefined,
  };
}
