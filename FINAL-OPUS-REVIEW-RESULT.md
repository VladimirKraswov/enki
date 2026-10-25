# Final integration review — Opus 5.5 (claude-opus-5-5), source only

**ALL CHECKS NOT RUN.** No command, test, typecheck, build, install, git, app,
browser, hook, subprocess, Hub/SSH, model or network was executed. Only
Read/Edit/Write/Glob/Grep inside `project/`, read-only `sdk-reference/`. No version
bump, publish, readiness or "green" claim. No test was deleted, skipped or
excluded; deletions are only proposed in `FINAL-INTEGRATION-DELETE-PATHS.json`.
Owner/stable identity literals (`dev.local.opencodedesktop`, default vault names)
untouched; no owner CLI/service/data touched; deployed service settings unchanged.

Inputs actually read: `FINAL-INTEGRATION-REFERENCE-INDEX.md`; the first entries of
`FINAL-INTEGRATION-REVIEW-INVENTORY.json` and `FINAL-INTEGRATION-QUALIFIED-SOURCE.json`
(structure and header only — **not** used as an exhaustive per-file checklist, see §6);
TODO-FOR-OPUS-{final-runtime-qualified-v2, final-ui-qualified,
final-packaging-qualified, final-native-qualified, final-native-tools-qualified,
final-ui-performance-audit, final-turn-outcome-audit,
final-release-integration-audit, windows-publication-durability,
final-native-return-notes, final-runtime-return-notes, final-ui-return-notes,
test-retirement-gaps}; `native-sdk-upgrade-proposal.md`;
`runtime-delete-proposal.json`; `TEST-CUTOVER-DELETE-PATHS.json`;
`FINAL-UI-REVIEW-RESULT.md` (full). `FINAL-RUNTIME-REVIEW-RESULT.md` and
`FINAL-NATIVE-REVIEW-RESULT.md` were consulted only through targeted searches,
not read in full. SDK references read: pi-ai `providers/faux.d.ts`,
pi-coding-agent `core/extensions/types.d.ts` (InlineExtension, input/command,
session_before_compact) and `index.d.ts` exports.

## 1. Fixes by task item (production source)

**1 Runtime qualification v2**
- `agent/src/interaction/broker.ts`: `askPermission` passes explicit type
  arguments to the generic `start<PermissionRequestDTO, PermissionReply>` (TS2322;
  no cast, `PermissionReply` unchanged). New `hasPendingPermission(sessionID)`.
- **Product defect** `agent/src/server/routes.ts` PATCH `/sessions/:id`: a turn
  PARKED on a tool permission may change its access in place; the exact pending
  call is re-decided once by `reevaluatePermissions` (full→runs, read→refused,
  still-ask→stays). A streaming turn that is not waiting keeps the 409 fence;
  model/directory routes are unchanged. Authentication is the server's.
- `agent/test/turn-policy.test.ts`: narrows `InlineExtension` (`ExtensionFactory |
  {name, factory}`) with a type guard, no cast.
- Fitting-context fixture: `sdk/testing.ts` gains a genuinely fitting smaller
  target `scripted-medium` (16k window, limit 15 488 > 5 915+20); the test asserts
  the budget arithmetic and the live usage. Production `max(usage, estimate)`,
  input/system/tool budgets untouched; busy refusal and no-summary assertions kept.
- **Module boundary**: only `resources/pi/lsp-extension.ts` value-imported a bare
  package (`typebox`, declared/locked only by the agent). Moved to
  `agent/src/extensions/lsp.ts` (inside the package boundary, resolved by public
  Vitest and public native Node alike); the old path is a relative re-export shim
  (proposed for deletion). Every other sibling extension imports bare packages
  for types only (erased). Real LSP defect fixed while moving: a re-check after an
  edit re-sent `didOpen` v1 and returned the CACHED pre-edit diagnostics; now
  `didChange` with an incrementing version, cache invalidated, stale-version
  publishes ignored, wait timers cleared; `file://` → native path via
  `fileURLToPath` (Windows drive letters).

**2 UI qualification**
- `components/ContextPanel.tsx`: the persisted result-card scope uses the typed
  runtime tag `RUNTIME_AGENT_ID` (behaviour identical: `engineIdFor()` always
  returned it); `UsageSettings.tsx` unused `store` import removed.
- Tests only: chat-window mock implements the real `isLegacySession`/
  `isProjectless` port (+ a case proving a legacy archive never shows the
  unconfirmed-stream alert); schedules fixture now expects 6 accepted + exactly
  one quarantined `gone` receipt (`source_not_imported`, retryable, no session/item)
  and asserts the durable accepted journal; image-state broken-pipe test asserts
  the fixture REACHED `fn` with its state and the specific not-saved error (a spawn
  refusal can no longer satisfy it). Held old-module and guard-blocked cases were
  not changed (they are mapped in the deletion proposal or need a qualified harness).

**3 Packaging auditor false negative**
- `agent/build.mjs`: exactly ONE binding per pin (`PINNED_SDK`,
  `PINNED_DATA_SCHEMA`, `PINNED_CONTRACT`), reused by the dependency refusal,
  the protocol guards and the authenticated `runtime-version.json` metadata
  (`sdk` now from the binding, not from `package.json`).
- `scripts/runtime/sdk-contract.mjs` `auditBuildBindings`: each binding AND each
  consumer site is its own field; a second unaudited lock read is drift too.
- `sdk-contract.test.mjs`: the original single-site mutations kept; added the
  three qualification probes and every other consumer/shadow-read mutation, each
  expecting exactly one precise drift. CLI 2.11.5 `./bin` and schema/installer
  cases untouched.

**4 Native** — no cosmetic rewrite of qualified process ownership. Two real
changes in §1 item 7 and §1 item 12 below.

**5 Memory/streaming (performance audit)**
- Runtime transient ring (`agent/src/store/events.ts`): byte budget (8 Mi chars) +
  count; cumulative snapshots of the same session part / SDK queue are
  REPLACEABLE (only the latest retained); a budget-evicted transient event makes
  an older cursor an explicit `stream.reset` (never a silent gap).
- Reasoning streams as linear `message.part.delta` (`partType:"reasoning"`) after
  a typed first snapshot (`sdk/translate.ts`); the reducer keeps the provisional
  part kind. Removes the O(n²) wire/journal/WebView prefix re-send.
- Wire bound (`protocol.ts` `EVENT_WIRE_LIMIT_BYTES`=3 MiB, decoder
  `EVENT_FRAME_CHARACTERS`): `server/wire.ts` sends a larger legal event as a
  same-seq `event.oversized` stub (durable event untouched); the client advances
  and re-reads that chat's history (or resyncs). An older runtime's oversized
  frame is skipped by its announced `id:` and reconciled — no endless replay.
- Replay paging fixed: a gap longer than one 5 000-event page was silently cut
  between the page and the live buffer; now paged (≤8 pages) or an explicit reset.
- Frontend pending-history journal (`state/historyJournal.ts`): part events are
  kept as one compact `{sessionID, partID}` reference per part (the consumers use
  only IDs); overflow is explicit (history error with retry / delayed resync).
- History paging converts only the requested page (`sdk/history.ts entriesPage`,
  `registry/worker.historyPage`) with identical cursor semantics and late
  tool-result linkage; plugin transcript uses the 20-message tail and is skipped
  without a surface; the per-append full JSONL re-read runs only when a command
  correlation is waiting.
- `ChatView`: anchor geometry runs only when the visible window's
  messages/parts/interaction changed (background chats no longer trigger it);
  attachment viewer scans user messages only (`sessionSources`) with a stable list.
- Background slot ≠ loaded history (`historyLoaded`): a chat that only streamed
  loads its page/cursor once on open; bounded LRU of 12 inactive transcripts
  (never active/busy/retrying/waiting chats; evicted ones reload authoritatively).

**6 Turn outcome (no new loop, no synthetic prompt)** — `sessions/worker.ts`:
per-invocation `RunFacts` observed from THIS run's SDK events (last assistant
`message_end`, whether content was produced, compaction result, retry
exhaustion) replace "last assistant in session state". `runOutcome()`:
unrecovered `length` → failed with `OUTPUT_LIMIT_TEXT` (+ compaction reason);
no current answer / empty stop → failed `no_answer`; turn ended on tool calls
(all-tools veto) → failed `terminated`; no model turn (handled input / slash
command) → completed `handled`, independent of an older failed assistant; an
SDK-recovered length (compact+retry → stop) → completed. Stop keeps
cancellation. A durable `session.outcome` event carries state/reason; the reducer
keeps `lastOutcome` (shows `no_answer`/`terminated` as the chat error;
OutputLimitNotice already covers length); the desktop bridge reports idle-after-
failure as `failed`. Queue policy explicit: a failed-length item does not pause
the queue (`isQueuePausingError` false), is not retried or replayed; timer
`sent`/queue receipts stay delivery semantics.

**7 Release integration**
- `src-tauri/src/hub_updates/install.rs`: phase-explicit `Applied::{NotCommitted,
  Interrupted, Committed{warning}}` via `replace_bundle(ops,…)` (injectable
  `BundleOps`). A previous-app record failure after the commit is a warning on an
  INSTALLED result (no false rollback); a failed commit with failed restore is
  `Interrupted` and reopens the intact old bundle at its hidden path; the
  `last-install.json` receipt (now with `phase`/`previous`) failure never blocks
  reopening; the reopened path is always the bundle that exists. Staging is
  removed only for our own pre-commit staging; the old bundle is never deleted.
- UI build stages: `updates/controller.ts` `ACTIVE_BUILD_STAGES` (preparing,
  dependencies, **runtime**, compiling) + localized `BUILD_STAGE_TEXT`; the
  runtime-preparation phase is cancellable and blocks channel/check/build.
- Publisher-secret alias: already fixed (both aliases in `WITHHELD_ENV` with a
  test) — compared, not changed.

**8 Windows publication durability** — `services/hub/durable.py` rewritten
honestly: MoveFileExW write-through is a documented per-rename barrier on local
NTFS, not a universal guarantee; failures are phase-aware: before the rename
`OSError` (old file intact), after it `PublicationUncertain` (POSIX: replace
succeeded, directory fsync failed; Windows: temporary gone after a reported
failure). `releases.py`: an uncertain artifact write is 503 "repeat the same
publication" (immutable identical bytes are accepted again); an uncertain head is
503 "may already be published — check the channel and envelopes before any
retry"; never "old release kept". The publisher's existing `publishAndVerify`
reconciles by reading head/downloads (no blind POST). No directory flush was
disabled; no admin volume flush or copy/delete fallback added.

**9 Typed runtime ports wired**
- `RuntimeClient.refreshCapabilities(directory)` → `POST /v1/capabilities/refresh`
  `{directory?}` → `{reopened, pending}`; `Store.capabilitiesCommitted()` is
  called ONLY after a confirmed registry commit (CapabilitiesSettings save,
  Computer control enable/disable), never for plain checks/folder opens; remote
  hosts excluded (they never read this computer's registry). Notices state real
  counts. `configDefaults()`, `ConfigStatusDTO.pendingRestart`; PiSettings shows
  the import state, imported default model, "applies after restart", and maps
  501 `CONFIG_SOURCE_UNCONFIGURED`/`CONFIG_NATIVE_UNAVAILABLE` to owner text.
  `permission.replied by:"policy"` removes the card (verified in the reducer; no
  client reply). Fork 409 (extension veto): the store's edit-branch path
  propagates the runtime's `ApiError` message unchanged — inspected, not changed,
  not separately tested here.
- HostDialogs + `docs/REMOTE-RUNTIME.md` name `install-remote-entry.mjs` (host
  Node checked before the installer loads). `docs/SDK-UPGRADE.md` merged with the
  native proposal (dataSchema authority, evaluations.yml/runner pins, single
  build bindings, host-Node entry points, entry-based rollback) — union, not
  overwrite.

**10 Explicit resources** — runtime settings `skillPaths`/`promptPaths`
(absolute, ≤64, no NUL, existence-filtered, never discovered) join
`extensionPaths`; `GET /v1/settings/resources` reports which configured paths
exist plus the deferred imported Pi keys; PiSettings lists/edits them, marks
missing paths "не найден, не загружается" and explains that Pi packages are not
downloaded/installed. Native MCP/browser/computer/LSP, voice, images, workshop,
remote endpoints and full-access policy paths were not changed.

**11 One agent loop**
- `scripts/evaluations/runner.mjs`: only `pi-sdk` executes; `opencode`/`pi`
  external CLIs are refused (`EVAL_ENGINE_RETIRED`), their historical event
  parser kept; OpenCode env/config generation removed. Test and docs updated.
- `src/models/hub.ts`: the dead UI Hub prepare/renew/release/lease cache/timer is
  removed (display + read-only `inspect` probe kept; cached pre-2.0 leases are
  ignored, never acted on). Its one runtime-missing invariant was ported first:
  runtime `models/hub.ts` recovers a lost prepare ACK once with the SAME
  `requestKey` (Hub dedupes per device+key). `ModelServices.ensure` is now a
  local-service alias of `ensureLocal` (no Hub lease).
- Duplicate window policy copies: invariants re-homed to
  `agent/test/policy-authority.test.ts`; modules proposed for deletion.

**12 Test retirement** — new real tests close the held gaps: native
`start_once` seam (production path of `RuntimeSupervisor::ensure`) with two
concurrency tests; intentional close + late SDK events; pending-policy busy
fence; session-context/alias invariants (runtime isolation suite); browser
session identity re-home. Full matrix: `FINAL-INTEGRATION-DELETE-PATHS.json`
(every row `deleteNow:false`, `deletableWhenGreen` after the coordinator runs them).

## 2. Tests written or changed (ALL NOT RUN)

New files:
- `agent/test/extension-boundary.node.ts` (3; added to `run-node-suites.mjs`
  REQUIRED together with the existing `config-vault.node.ts`): no runtime bare
  import in sibling extension sources (non-vacuous scanner); native-Node load of
  the extension graph and of the moved LSP module through the old path;
  diagnostics after an edit report the edited text, never the cached pre-edit
  result (own stdio fake LSP child on `process.execPath`).
- `agent/test/event-wire.test.ts` (4): coalesced cumulative snapshots with all
  durable/delta events kept in order; budget eviction → explicit reset only for
  affected scopes; oversized stub shape/size/same seq; a legal 6 MiB durable
  event over real HTTP/SSE: stub, later events, reconnect after it re-sends nothing.
- `agent/test/integration/turn-outcome.test.ts` (pure `runOutcome` cases +
  5 real-SDK cases): terminal length failed with partial text, one provider call,
  `session.outcome`, next prompt normal; vetoed compaction recovery; handled input
  and registered slash command after an older failure (no model call, no entry);
  empty stop = no answer; recovered tool error still completed.
- `agent/test/integration/close-late-events.test.ts` (1), `agent/test/
  resource-settings.test.ts` (2), `agent/test/policy-authority.test.ts` (7).
- Frontend: `test/history-journal.test.ts` (3), `test/history-slot.test.ts` (3),
  `test/capability-refresh.test.ts` (3), `test/browser-session-identity.test.ts` (2).
Added cases: `pending-policy` (busy fence 409), `isolation` (alias/suffix/file
link/per-session rules), `cancel-and-hub` (lost prepare ACK same key),
`sdk-translate` (reasoning deltas; `entriesPage` equals full paging for 6 cursors
and converts nothing outside the page), `sse` (frame id, oversized id,
bound compatibility), `transport-reliability` (stub + legacy oversized frame:
cursor advances once, seq after it replayed, no loop), `hub-updates` (every active
stage cancellable/blocking; UI stage list = build.rs stages), `context-panel-model`
(`sessionSources` = `sessionContext().sources`), `chat-window` (legacy archive),
`host-dialogs` (entry script), Rust `install.rs` (every phase × legacy rename),
Rust `runtime.rs` (2 start-once), Python `test_durable.py` (3) and
`test_releases.py` (2).
Changed assertions with reason: `model-context` fitting case uses the 16k target
(bad fixture, item 1); `schedules` 7→6 accepted + exact quarantine (bad fixture);
`image-state-protocol` generic `toThrow()` → reached-fixture + specific error;
`runner.test.mjs` retired engines now REFUSED (owner requirement: one loop);
`sdk-translate` live-stream case expects reasoning deltas (protocol change, the
reconstructed text is asserted). **Expected RED until retired:**
`test/model-hub.test.ts` (asserts the removed UI lease loop) — mapped in the
deletion proposal; the other 13 held files are unchanged.

## 3. Review ledger (honest depth)

Read in full or in all relevant parts and reviewed: agent `interaction/broker.ts`,
`server/{routes (sessions, events, settings, capabilities), http (event stream),
wire}.ts`, `store/events.ts`, `sdk/{translate, testing}.ts`, `sdk/history.ts`
(conversion/paging), `sdk/adapter.ts` (resources, readers, context estimate),
`sessions/worker.ts` (run/settle/attach/close/history), `sessions/registry.ts`
(history/refresh/recycle/shutdown), `core/runtime.ts` (settings, config import,
capabilities, resources, onSettled), `models/hub.ts`, `extensions/enki.ts`,
`policy/{prompt, workshop}.ts`, `legacy/pi-agent.ts` (settings deferral),
`build.mjs`, `package.json`, `tsconfig.json`, `vitest.config.ts`,
`test/{helpers, run-node-suites, node-guard (head)}`; the whole sibling
`pi/lsp-extension.ts`; frontend `api/sse.ts`, `agent/runtime/{events, client
(settings/extensions/migrations/models)}.ts`, `state/{chatReducer (event cases,
history apply/reconcile), store (select/load history, resync, handleEvent,
shared tools, hub wiring)}.ts`, `components/{ChatView (layout), ContextPanel,
UsageSettings (head), CapabilitiesSettings (save/check), ComputerSettings (apply),
PiSettings, HostDialogs (help), UpdateSettings}`, `render.tsx` (attachment
viewer), `state/taskContext.ts`, `updates/controller.ts`, `models/{hub, services
(ensure)}.ts`, `schedules/tasks.ts` (migrateLegacy), `outcomes/store.ts`,
`control/bridge.ts` (wait); native `hub_updates/{install, build (stages, env)}.rs`,
`runtime.rs` (ensure/start lock); `scripts/runtime/sdk-contract{,.test}.mjs`,
`scripts/evaluations/runner{,.test}.mjs`; Python `services/hub/{durable,
releases (publication)}.py` and their tests; docs `REMOTE-RUNTIME`,
`SDK-UPGRADE`, `EVALUATIONS` (adapter part).
Sweeps over the tree: OpenCode execution spawns (only archive/provenance/
read-only paths and the deployed V100 header default remain), production
importers of the window policy copies / `api/events.ts`, users of
`SseDecoder`/`openEventStream`/`historyJournals`/`RunOutcome`.
Additional targeted security pass: `components/Markdown.tsx` + `chat/highlight.ts`
(escaped highlighter output, `skipHtml`, CSP `img-src 'self' data: blob:` blocks
remote image exfiltration) — one real defect fixed: `util/markdown.ts
safeExternalUrl` resolved RELATIVE links against a placeholder base and opened
`http://invalid.local/...` externally; now absolute http(s) only
(`test/markdown-links.test.ts`).

**NOT reviewed in this pass (honest; no claim that earlier legs covered them
beyond their own ledgers):** native `process`, `control`, `authority`, `browser/*`,
media/voice, tray, workshop, storage, packet/update download/verification (only
`install.rs`/`build.rs` stage+env were read), `hosts.rs`, `capabilities.rs`,
`migration.rs`, `paths.rs`; runtime `http.ts` beyond the event stream,
`queue/*`, `admission`, `maintenance`, `migrations/*`, `models/{catalog, check,
credentials, config}.ts`, `plugin-ui/*`, `mcp/*`, `execution/*`, `legacy/*`
(except the settings deferral), `schedule/*`, `platform/*`; shared
`image-generation*`, `web-search*`, `project-map*`, `registry.mjs`; browser
daemon/actions/stealth; frontend `App.tsx`, voice (`VoiceInput`, `VoiceWaveform`,
chunk recovery), `GeneratedImages`/PBR/ZIP cards, `AttachmentViewer`,
`PdfPreview`, plugin-UI surfaces, sidebar, notifications, access UI,
window-state, `attachments/*`, `images/*`, `memory/*`, `usage/*`, most `hub/*`;
services Hub (beyond durable/releases), images, ASR, helper, Strata, V100; CI
workflows and build/package scripts other than `sdk-contract`. The fresh FILE
inventory was not walked file by file. These remain open for the coordinator's
qualified gates and, where needed, another bounded review.

## 4. Invariant → deletion mapping

See `FINAL-INTEGRATION-DELETE-PATHS.json` (supersedes the `deleteNow:true` flags
of `TEST-CUTOVER-DELETE-PATHS.json`). Summary of gap closures:
| Held gap | Replacement (NOT RUN) |
| --- | --- |
| full-access-loop: pending request + policy change | `pending-policy.test.ts` ×4 (incl. busy 409) + route fix |
| pi-backend (b) close then late events | `close-late-events.test.ts` |
| local-server: native concurrent ensure | `runtime.rs` `start_once` ×2 |
| engine-routing (b) fitting/no summary | `model-context.test.ts` (fixture fixed) |
| browser OpenCode plugin + access-policy | `browser-session-identity.test.ts`, `isolation.test.ts` alias case, existing pi-browser/browser-access/pi-shared-tools cases |
| UI Hub lease loop (model-hub.test.ts) | runtime cancel-and-hub/model-context-hub/hub-discovery + new lost-ACK case |
| window policy copies | `policy-authority.test.ts`, `turn-policy.test.ts` |
| agent-backend false flags | retired premise (one runtime, constant capabilities); real refusals in attachments/fork-veto |
| pi-live | retired; ordinary SDK + Qwen Medium real Hub acceptance is a separate release gate |
Remaining documented gap: expired existing Hub lease replacement has no
dedicated runtime test (rationale in the JSON).

## 5. Remaining precise limitations

- Nothing was compiled or run (TypeScript, Vitest, node:test, cargo fmt/check/
  clippy/test, Python unittest). Rust formatting was written by hand to rustfmt
  style; `cargo fmt --check` may still request changes in `install.rs`/`runtime.rs`.
- `test/model-hub.test.ts` is expected RED until retired; `test/image-context.test.ts`
  must be split (one case uses the dead OpenCode access-policy hook) before
  `access-policy.mjs` is deleted.
- Item 5: transient tool partial output still re-sends a bounded cumulative
  snapshot per update on the wire (retention is coalesced, wire cost is
  per-update); no measured heap/CPU numbers; nothing here proves or disproves the
  historical Mac-wide freeze.
- Item 6: `RunOutcome.reason`/`session.outcome` are in-memory + journal only; the
  SQLite ledger keeps state + error text (no schema change). Empty-stop and
  tool-terminated runs are now `failed`; owner-model frequency is unknown.
- Item 7: no real disk/rename/LaunchServices fault was injected; `BundleOps`
  tests use own temp directories on any Unix. Windows/Linux package installers
  keep their previous NotCommitted-on-error semantics.
- Item 8: Windows behaviour remains unqualified until real Windows CI on the
  supported local NTFS runs the full Hub suite (incl. the Windows-only
  MoveFileExW case); no power-loss claim.
- Item 10: Pi npm/git packages are deliberately not installed; deferred imported
  resource keys are listed, never auto-activated. Skill/prompt loading relies on
  the pinned SDK honouring explicit `skillPaths`/`promptPaths` (adapter
  `ResourceSpec`), not separately re-verified against SDK internals here.
- Item 11: the three dead window policy modules, `api/events.ts`, the OpenCode
  browser plugin and access policy are still present (proposed deletions).
- Native ordinary-Qwen-Medium/tool/MCP/pluginUI/image/history/queue/timer
  acceptance, 2.0.0 final build, push, Hub publication and owner apply are the
  coordinator's; no readiness is claimed.
