# Frontend + plugin UI + questions + PTY pass — SOURCE ONLY / NOT VERIFIED

Author: Claude Opus 5.5 on Igor (source edits only). Nothing was executed here:
no install, typecheck, lint, format, build, test, app, browser or git.
**Tests / typecheck / build: NOT RUN.** Typecheck is still expected to fail on the
legacy Pi callers listed under "Remaining" (next bounded pass).

## Runtime (src-tauri/resources/agent)

- `platform/pty.ts`: synchronous `activity()` → `{running, starting, unconfirmed}`;
  `setAdmission()` fence (also re-checked after the async node-pty load); `kill()`
  keeps a shell "unconfirmed" until its exit is observed (failed kill stays unknown);
  injectable module loader for tests (no shell spawned).
- `core/runtime.ts`: `activity()` counts PTYs and pending questions; `idle` is false
  while a shell runs; `quiescent` (quit drain only) excludes shells, which
  `shutdown()` terminates. PTY joins `fenceMaintenance`/`stopAdmission`.
  `RuntimeConfig.ptyModule` test hook.
- `interaction/broker.ts`: real bounded questions on the existing `start()` durable
  transaction helper: `askQuestion/replyQuestion/rejectQuestion/pendingQuestions`,
  `question.asked/replied/rejected` events, deadline/abort/cancelSession/cancelAll,
  answer validation (`InteractionInputError`), included in `hasPending`. No grant.
- `extensions/enki.ts`: `question` tool (Typebox schema, `questionTool()`); the gate
  never asks permission to ask, explicit deny rules still win.
- `server/routes.ts`: `/questions*` real; snapshot includes `questions`; capabilities
  `questions:true`, `extensionUi.tui:true`; `GET /sessions` is `{mutation:true}`
  (adopts); obsolete self-waiting `POST /runtime/drain` removed (no replacement path).
- `server/ui-routes.ts` (new): `GET /sessions/:id/ui` (snapshot), `GET …/ui/open`
  (SSE, mutation: opens/adopts the worker, attaches to the staged worker while
  session_start awaits UI), `GET …/ui/events` (SSE, read-only: attaches to a live
  surface or waits with `ui.waiting` holding the authority until a worker starts),
  `POST …/ui/{control,release,input,resize,draft,retry-draft,resolve-draft,
  retry-submission}` (mutations), `POST …/ui/resync` (read-only). Authority via
  `attachUiAuthority` BEFORE any worker startup, held until SSE close, released on
  every early failure; `authority:` principals get 403. Draft CAS conflicts → 409
  with the canonical draft. Stream: `ui.hello/reset/vt/closed/event`, per-stream ids.
- Tests (written): `test/pty-activity.test.ts`, `test/integration/questions.test.ts`,
  `test/integration/plugin-ui-routes.test.ts`; `test/helpers.ts` `ptyModule` option.

## Frontend

- `agent/runtime/client.ts`: per-window UUIDv4 `X-Enki-Client` in `authorization()`
  (all fetch + SSE); questions; `ui*` methods; `uiDraft` returns explicit conflicts;
  `ptyStreamUrl`; `RuntimeActivityDTO` (terminals/questions).
- `agent/runtime/pluginUi/`: `types` (runtime guards, no coercions), `frameConsumer`,
  `surfaceController` (adapted reference; explicit take/release control),
  `session` (SSE watch/open, scope+epoch fence, real `SurfacePort`), `draftSync`
  (shared EditorDraftCas client: one in-flight, same-id lost-ACK retry, explicit
  conflicts keeping local text + stash, IME-safe, per-chat base memory), `active`
  (one stream per window; settles the draft before releasing authority).
- `connection.ts`: `authorizeNativeUi(scope, actions)` → `runtime_ui_authorize`
  (exact six scope keys) from keydown/mousedown capture BEFORE the input it precedes.
- UI: `xtermHost.ts` (shared xterm), `PluginTerminalSurface.tsx`, `PluginUiPanel.tsx`
  (statuses, working, widgets above/below composer, notices, pending submission/draft
  retry/resolve, draft conflict), CSS; mounted in `App.tsx` around `Composer`.
- Callers migrated: `TerminalPanel` (runtime PTY over SSE, cursor resume, ordered
  input), `RightPanel`, `ContextPanel`, `CapabilitiesSettings` + `ComputerSettings` +
  `AgentControlSettings` (shared/reserved registry, live worker `mcp.status`),
  `InformationDialog`, `SettingsScreen` (OpenCode sections removed), `Dialogs`,
  `TopBar` (archive badge + "Продолжить в Enki"), `PiSettings` (runtime settings:
  policy, compaction, git path, extension paths; models; LSP), `PiDialog`
  (`ui.agentDialog`), `updates/runtime` (agentDialog + authoritative runtime idle
  blocker naming open terminals/questions), `schedules/Runtime` (binder only),
  `PromptQueue` (uncertain → "Уже отправлен"/"Вернуть в очередь" via acknowledge),
  `HandoffDialog`, `usage/sources`, `ScheduleSection`, `ModelCatalogSettings`
  (runtime refresh instead of OpenCode restart), `Sidebar`, `Composer` (no engine
  picker/OpenCode profile; IME composition events).
- Store: `maybeBackend()`, `draftFor/setDraftFor`, CAS notifications on edits/clear,
  snapshot questions, `mcpServerStatuses`, schedule events → `taskScheduler().observe`.
- Frontend tests (written): `plugin-ui-surface`, `plugin-ui-draft`,
  `runtime-client-ui`, `runtime-sync-plugin-ui`; adapted `settings-screen`,
  `information-dialog-ui`, `engines`, `model-catalog-bridge`; import fixes in
  `project-error`, `workshop`.
- `MIGRATION_DELETE_PATHS.json`: 15 src files, 3 unreferenced native files, 13 tests.

## Remaining (exact)

1. Legacy callers in `server/routes.ts` (TODO comment there): `importPiCli` →
   `PiCliImporter`; `importPiAgent(dir, agentDir, store)` → `planPiAgentImport` +
   `importPiAgent(plan, PiConfigCommitPort)`; sync `continueLegacy(…, transcript, …)`
   → async with `ContinuationReader` + trusted directory. Windows native build runner.
2. Store-level tests still mocking `OpenCodeClient` (to rewire to RuntimeClient, not
   deleted): `test/workspaces`, `usage`, `sidebar`, `transport-reliability`,
   `handoff`, `activity`, `store-regressions` (also mocks `operations/ownership`);
   translator-fixture tests: `archive-references`, `workshop-policy`,
   `prompt-language`, `task-diagnostics` (need runtime `MessageDTO` fixtures).
3. `main.ts` passes no `maxEventStreams` (default 4): directory + global + plugin UI
   + PTY streams already use 4 per window; raise it (Mac review) before two windows.
4. Computer-use skill path is no longer registered (reserved MCP entry only).
5. `hub/modelCatalog.applyCatalog` still writes per-engine (OpenCode/Pi) config —
   not reviewed in this pass.
6. Existing `test/integration/extension-ui.test.ts` asserts `setFooter` is reported
   unsupported; with the real plugin UI that expectation may be obsolete (not changed).
