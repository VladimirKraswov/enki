# SDK-RESULT — bounded SDK/model-context corrections (Opus 5.5)

Source editing only. **No command, test, typecheck, build, install, git, app or
browser was executed. Every check below is NOT RUN.** No version bump; SDK
0.85.1 pins untouched; no SDK patches, no second agent loop.

Note: `../TODO-FOR-OPUS-sdk-environment.md` and `../TODO-FOR-OPUS-model-context.md`
are outside the permitted directories and were not readable; the task text was
used as the specification.

## 1. Shell plugins no longer masked

Cause (confirmed in source): `ScopedResources.reload()` unshifted the host
prelude (`projectShells`) before configured extensions; the SDK ExtensionRunner
resolves the FIRST registration of a tool name, so host `bash`/`powershell`
masked explicitly selected plugins. The adapter comment claimed the opposite.

Edits:
- `src/plugin-ui/scoped-resources.ts`: the prelude stays first (earliest
  event/security setup unchanged). After file plugins, trusted project
  extensions and mandatory inline extensions are loaded, every tool name they
  supply is deleted from the HOST prelude's own `tools` map only (plugins are
  never touched; mandatory inline policy unchanged). Recomputed on every
  `reload()`, therefore identical for SDK `reload()` and `newSession()` (each
  runs the factory → fresh `ScopedResources.reload()`). New
  `hostToolResolution()` reports `{ fallbacks, shadowed }`.
- `src/sdk/adapter.ts`: corrected comment; prelude named
  `<enki-host:project-shells>`. Default shells still use the public
  `spawnHook` → `projectToolEnvironment()`, restoring the original
  `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, `GOOGLE_APPLICATION_CREDENTIALS` while
  all other env (SDK `PI_SESSION_*`, `HOME`) passes through.

## 2. One model-transition authority

Public SDK semantics used (0.85.1 declarations): `AgentSession.compact()`
summarizes with the session's CURRENT model and persists a compaction entry
(full transcript retained); `setModel()` switches and persists the model;
`getContextUsage().tokens` is `null` right after compaction; `estimateTokens()`
(chars/4), `systemPrompt`, `getActiveToolNames()`, `getAllTools()`, `messages`
are public. Therefore the order is: estimate → (if not fitting) lease source →
`compact()` on source → verify bounded estimate → lease target → `setModel()`
→ prompt.

`src/sessions/worker.ts`:
- `prepareModel()` + `fitTarget()` are now the only path that changes the SDK
  model; used by `startPrompt` (manual, queue, timer — all via the dispatcher),
  `setModel` and `transition`. `select()` is only called from there (once).
- `targetBudget()`: limit = contextWindow − min(maxTokens, window/2) from
  actual model metadata; caller budget can only lower it; NaN/±Infinity/negative
  → typed `invalid_budget`; huge values are clamped.
- Fit = max(SDK usage, system+tools+messages estimate) + pending prompt
  (text/4 + 1600 per image). Unknown usage uses the bounded message estimate;
  post-compaction uses max(estimate, `estimatedTokensAfter`).
- Source cannot hold history → `handoff_required` (no summary attempt, no
  feeding history to the small model). Compaction error → `compaction_failed`
  (retry/handoff); not fitting after summary → `does_not_fit`. All are
  `ContextTransitionError { code, recovery[], compacted, recoverable }`;
  target never selected, history retained, nothing deleted or reset.
- Every await is fenced by the operation epoch (Stop/close) → `cancelled`; no
  resume after cancel, no replay, single `setModel`.
- Progress: `session.context_transition { operation, phase, source, target,
  tokens/limit/window/outputReserve/code/recovery }`, phases `planning →
  summary_model → summarizing → verifying → target_model → ready|failed|cancelled`,
  plus `session.status waiting` text before target readiness.
- `currentModel()` added.

`src/execution/dispatcher.ts`:
- `readiness()` passes Hub readiness into the worker: `summary` leases the
  CURRENT model only when it must summarize; `target` leases the target only for
  prompts (`hubRoute` respected). A direct (unrouted) next model releases any
  stale lease, so no lease names a model the SDK is not using.
- `compact`: current-model operation; a payload model different from the SDK
  model is refused (pointing to `model.transition`); the lease names the
  current SDK model, never the payload.
- `model.set`: same transition; `failed` (not `rejected`) once a summary was
  persisted. `model.transition`: no pre-gate on the catalog model; budget passed
  through unchanged (`undefined` = derive).

## Remaining narrow callers (outside my scope)
- Frontend: replace the old `transferContext` orchestration (compact with source
  then `model.set`) with a single `model.transition`; project
  `session.context_transition` phases and `ContextTransitionError` recovery
  (`retry` / `larger_model` / `new_session_handoff`). The ledger carries only the
  message; code/recovery are in the `failed` progress event.
- Server/routes or registry: an explicit bounded "new chat with handoff" action
  for `new_session_handoff` (seed a new session from the last summary only).
- `protocol.ts` could type `session.context_transition`; not edited.
- Extensions that call SDK `pi.setModel()` directly still bypass Enki (SDK API).

## Tests written (all NOT RUN)
- `test/sdk-shell-fallback.node.ts` (guarded real SDK): file Bash + file
  PowerShell plugins execute, fallback markers absent; inline Bash override wins
  across worker reload, SDK `reload()` and `newSession()` with
  `{fallbacks:["powershell"], shadowed:["bash"]}` exactly; no-override path runs
  host Bash with restored env, `PI_SESSION_ID`, `HOME`.
- `test/integration/model-context.test.ts`: large→small ordinary prompt
  (source summary before target call, transcript retained), queued + scheduled
  prompt, `model.set`, summary that does not fit (no target call), failed
  summary then single retry, unknown usage after manual compaction, budget
  clamp/NaN/negative/Infinity unit checks.
- `test/integration/model-context-hub.test.ts`: source lease before summary,
  routed target leased only after summary and Stop while loading (cancelled, no
  target call, release), Stop during summary then retry once, manual compact
  refuses different model, huge budget cannot enlarge window.
- `test/integration/model-transition.test.ts`: fixture only — shorter kept tail
  because system prompt/tool schemas now count; assertions unchanged.

Checks NOT RUN: unit/integration (vitest), guarded node SDK suites, tsc
typecheck, lint, build, packaging, Mac acceptance.
