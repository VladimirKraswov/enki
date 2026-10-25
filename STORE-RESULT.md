# Store + registry/engines pass — SOURCE ONLY, NOT VERIFIED

Nothing was executed: no install, build, typecheck, lint, test or app run.
Tests/build/typecheck: **NOT RUN**. The frontend migration is **not complete**.

## Edited / created in this pass

- `src/agent/registry.ts` — rewritten. No descriptor catalogue. `connectRuntime(target)`
  builds the single `RuntimeBackend`: local via `localConnection()` (native supervisor),
  remote via `remoteConnection(host)` (strict SSH). The refresh connector re-resolves the
  *same* target only, so there is no remote→local fallback. `workspaceKey()`
  (`enki-runtime:local` / `ssh:<target>:<port>`), `isKnownBackend()`, `DEFAULT_BACKEND_ID`.
- `src/state/engines.ts` — single engine (`"pi"` = `RUNTIME_AGENT_ID`). Former per-folder/
  per-chat selections ignored for execution. `modelScope` writes plain keys (read first by
  `chooseModel`); `legacyModelScope` = `pi::<key>` fallback. `piAvailability`/`engineOptions`
  kept for existing callers (runtime runs local or remote).
- `src/state/runtimeSync.ts` — new (pure routing): `queue.updated`, `dialog.asked/replied/
  expired`, `schedule.updated/removed`, `extension.notify/error`, `broker.request`, other
  runtime-only events kept out of the chat reducer; `AgentDialogs`; `applySnapshot`.
- `src/state/store.ts` — incremental edits:
  - imports: removed `api/client`, `asOpenCodeClient`, `PiBackend/piDescriptor/piBridge`,
    `startLocalServerIfNative`, `refreshGlobalPolicy`, `applyGlobalPlugins`, `configureShared`,
    `ownWork`, schedule preflight, `connectSsh/prepareChat/hostHeaders/remoteKey`.
  - `runtime: RuntimeBackend | null`; `backend` getter throws `ConnectionError` before the
    first connection (no stand-in); `client` → `RuntimeClient`. Instance replaced on each
    (re)connect so `backend === this.backend` guards keep working.
  - engine compat methods (`engine`, `conversation`, `isPiSession`, `engineReady`,
    `setSessionEngine` refuses other engines visibly), `isLegacySession`,
    `continueLegacySession` (runtime `/continue`; `continueOnEngine` delegates).
  - connection: `connect(endpoint?)` (URL ignored → local runtime), `connectLocal()`,
    `connectHost(id)` → `connectRuntime`, `doConnect(runtime, target)` (health only,
    no external start; legacy local OpenCode workspace adopted in place), token-rotation
    watch, one-time legacy prefs queue migration (`migrateLegacyQueues`), snapshot restore.
  - metadata: providers + runtime settings (compaction); no agent catalogue.
  - LSP via native `runtime_setup_lsp`; browser via adapted `configureLocalBrowser`
    (`syncRuntime` → `PUT /settings browserEnabled`); shared tools → runtime `/extensions`
    MCP pool + `McpNotices`; tool policy → runtime `defaultPolicy`.
  - dialogs: `answerAgentDialog` (+ `answerPiDialog` compat) → `POST /dialogs/:id/reply`;
    broker relay for remote runtimes (`relayBroker` → `/broker/:id`, deduped).
  - PromptQueueController wired to the new host (runtime dispatches; no local loop):
    `prepareParts` reuses the direct-send attachment pipeline, `queued` stages original
    images under the stable item id. Removed `drainQueue`, `dispatchQueued`, `queueArmed/
    Locks/Stops`, `writeQueue`. Store wrappers: enqueue, edit/apply/cancel, reorder,
    remove, pause/resume (async), steer, `acknowledgeQueued`, `queuePausedReason`.
  - schedules: `runScheduledTask` and `scheduledLocks` removed (runtime scheduler).
  - sidebar/recent/session list: single runtime list; recent uses runtime cursor.
  - history window: overlap by position in `messageOrder` (random SDK ids), no `id < first`.
  - projectless chat folder via runtime `/workspaces/chat` (local and SSH alike).
  - models: `chooseModel`; catalogue/options from runtime providers; access check via
    `/models/check`; refresh via `/providers/refresh`.
  - send: stable `messageID` always (ledger id + timing key), image refs local-only,
    PDF/audio/video converted; read-only archive chats refused with explicit message.
  - Stop: `backend.abort` (runtime fence) + queue refresh; delivery reconcile via ledger
    `GET /commands/:id`.
  - events: directory stream `onReset` → resync + snapshot; global stream routes other
    folders' runtime-only events; Pi stream removed.
- `test/runtime-store-sync.test.ts` — new (written, not run).

## Remaining caller migration (next bounded pass)

Typecheck will fail until these are migrated:

- `store.client` used as `OpenCodeClient` / OpenCode paths (`/mcp`, `/skill`,
  `/experimental/tool/ids`, PTY, file/vcs): `components/OpenCodeSettings.tsx`,
  `ComputerSettings.tsx`, `TerminalPanel.tsx`, `RightPanel.tsx`, `ContextPanel.tsx`,
  `HostDialogs.tsx`, `HandoffDialog.tsx`, `InformationDialog.tsx`,
  `AgentControlSettings.tsx`, `CapabilitiesSettings.tsx`, `usage/sources.ts`
  → `RuntimeClient` methods (`fileList/fileContent/vcs*/pty*/extensions/sessionDiff/usage`).
- `components/PiDialog.tsx`, `updates/runtime.tsx`: `ui.piDialog` → `ui.agentDialog`
  (`DialogRequestDTO`), call `store.answerAgentDialog(answer, dialog.id)`.
- `components/EngineSwitchDialog.tsx` (`ui.engineSwitch` gone) — delete/replace with a
  legacy-continuation action; `TopBar.tsx` (`PI_BACKEND_ID`, `continueOnEngine`) →
  `isLegacySession` + `continueLegacySession`.
- `SettingsScreen.tsx`: `setLocalOpenCodeProgram` removed, endpoint field, `connect(url)`;
  `Dialogs.tsx`: `connect(endpoint)`; `Composer.tsx` engine picker; `PiSettings.tsx`
  program/node fields → runtime settings; `UsageSettings.tsx`.
- `schedules/Runtime.tsx` still calls removed `store.runScheduledTask` → delete the UI tick
  (runtime scheduler) or turn it into a list refresh.
- `PromptQueue.tsx`: `resumeQueue` now returns a Promise; add uncertain-item
  acknowledge buttons (`store.acknowledgeQueued`).
- Prefs: legacy `endpointState` keyed by old OpenCode URLs other than the active one are
  not renamed (only the active local workspace is adopted in place).
- Old tests asserting two engines: `test/engines.test.ts`, `test/engine-routing.test.ts`
  and tests importing `agent/opencode`, `agent/pi/*`, `native/localServer`.
- Delete list (unreferenced by store/registry now; verify other importers first):
  `src/agent/opencode.ts`, `src/agent/pi/*`, `src/agent/ids.ts` (if unused),
  `src/native/localServer.ts`, `src/api/configReload.ts`, `src/capabilities/globalPolicy.ts`,
  `src/operations/ownership.ts`, `src/schedules/preflight.ts`, `src/api/client.ts`.
