# Final whole-project review — UI leg (Opus 5.5), source only

**ALL CHECKS NOT RUN.** No command, test, typecheck, build, install, app, UI,
browser, git or network was executed. Only Read/Edit/Write/Glob/Grep inside
`project/` (edits limited to `src/**`, `test/**`, `index.html` and this file)
and read-only `sdk-reference/`. No version bump, publish or readiness claim.
No test was deleted, skipped, excluded or weakened.

Inputs read: FINAL-OPUS-REVIEW-REQUEST, FINAL-REVIEW-KNOWN-GAPS, FINAL-REFERENCE-INDEX,
TODO-FOR-OPUS-{frontend-after-legacy, remaining-runtime-integrations,
frontend-cutover-qualified, test-retirement-gaps}, TEST-CUTOVER-DELETE-PATHS.json.
**`SCOPE-INVENTORY.json` and `FILE-REVIEW-INVENTORY.json` do not exist** in either
readable tree (Glob/Grep for `*INVENTORY*` found nothing); the ledger below is my
own Glob-based inventory and states honestly how deeply each area was read.

## 1. Concrete fixes (production source)

Compiler diagnostics (TODO-frontend-after-legacy, 13 in 6 files) — real callers fixed, no shims:
- `components/BrowserSettings.tsx`: reads the single-runtime `setup.agent`; removed per-engine
  rows/"OpenCode / Pi" texts (the idle render threw on `undefined.includes`).
- `components/CapabilitiesSettings.tsx`: removed the never-populated `piSkills` branch; new
  exported `skillAgentState()` states what the runtime really does (explicit `skillPaths` of
  enabled sources only; unmanaged ambient skills are *not loaded*; no "found by agent").
  Save notice no longer promises re-open refresh (see §3 contract). Remote text corrected.
- `components/HandoffDialog.tsx`: no `agent` on the profile (runtime has one profile); variant `null`.
- `components/ScheduleSection.tsx`: no undeclared `engine`; add/pause/remove are **awaited**,
  runtime refusal text shown, form input kept until accepted, double-submit fenced.
- `schedules/control.ts`: rewritten on the sole runtime: explicit model (+optional variant) wins,
  else the background chat's own saved model via new `Store.modelChoiceForSession()` (never the
  visible selection); `refresh/add/toggle/remove` awaited; accepted DTO returned.
- `components/Sidebar.tsx`: dropped removed `prefs.projectEngine` bypass of the stale-status `?`.

Product defects from the cutover qualification (all 13 named product failures addressed):
- `agent/runtime/client.ts`: `RequestOptions.empty` enforced — a JSON-required endpoint answering
  204/empty is an `ApiError`; plugin-UI routes split into JSON (`ui<T>`) vs void (`uiVoid`). Every
  runtime handler returning `undefined` was checked against routes.ts/ui-routes.ts.
- `components/ContextPanel.tsx`: children read from `GET /sessions/:id/children` for every connected
  chat (gate was `engine === "opencode"`); cancellation by key/endpoint kept; dead engine gate on
  OutcomeSection removed.
- `state/promptQueue.ts`: `steerQueued` has a per-chat in-flight fence, captures the chat before
  awaiting, treats a `rejected` receipt as an error (`acceptedReceipt`).
- `components/PromptQueue.tsx` + `components/Composer.tsx`: while editing a queued item its stored
  files are rendered (metadata only, never fetched) next to new draft files; removing a kept file
  only marks `edit.removed` (applied atomically by Apply/Now); Apply allowed with only kept files.
- `browser/integration.ts`: `configureLocalBrowser` returns the same in-flight promise (was an
  `async` wrapper, so coalescing could not be observed).

Remaining-runtime-integrations TODO:
- Item 6 `workshop/workspace.ts` + `Store.ensureWorkshop`: a saved pointer that resolves to a
  read-only imported archive goes through the runtime's verified idempotent
  `POST /sessions/:id/continue` inside the native-trusted workshop directories; continuation must be
  writable and in-directory; workshop flag set by PATCH on the continuation (never on the archive);
  pointer + provenance (`handoffOrigins`) written in **one** mutate only after all ACKs; failure
  keeps the old pointer, never creates an empty replacement, never replays. Un-pointed archives are
  still never adopted (existing assertion kept).
- Item 4: `PiSettings` LSP switch now shows/writes the **runtime** `lspEnabled` of the connected
  host (`PUT /settings`), disabled on SSH hosts; the legacy UI pref is no longer written by the
  switch (it was leaking into later per-host migrations). `Store.setupPiLsp` awaits the runtime save.
- Item 3: no authenticated capability-refresh route exists in the current runtime (routes.ts
  inventory); UI made honest instead of inventing a callback (contract in §3).
- Item 5 confirmed done (store sends only user parts); frontend policy copies are now dead (§3).

`runtime.settings` consumer (retirement gap config-reload): `state/runtimeSync.ts` validates the DTO
and calls `host.settings`; `Store` mirrors compaction (`compactionOf`, shared with metadata load)
and exposes `onRuntimeSettings()`; `PiSettings` subscribes. Dead `global.disposed` branch removed.

Other real defects found in the systematic pass:
- `components/HostDialogs.tsx` / `native/hosts.ts`: removed the OpenCode port field, `opencode serve`
  instructions and API-password control; real setup text (runtime-dist path, trusted
  `install-remote.mjs`, strict known_hosts, no local fallback). The saved port is kept as workspace
  **identity** (`ssh:<target>:<port>`), re-adding a target reuses it, new hosts get 4096.
  Deleted dead `connectSsh` (invoked a native `connect_ssh` that no longer exists), `prepareChat`,
  OpenCode Basic-auth `setHostPassword/hostHeaders`, `LOCAL_HOST`.
- `components/ChatView.tsx`: the stale-stream / status-error alert was unreachable
  (`engine !== 'pi'` and `!isPiSession` always false); restored for live (non-archive) chats.
- `state/store.ts reconcileOperation`: a definite `rejected/cancelled` answer of the *receiving*
  ledger now settles the journal record (was left "uncertain" forever). Pre-2.0 / foreign-ledger
  rules unchanged (404 never disproves them).
- `state/store.ts refreshModelCatalog`: a rescan with provider errors keeps the failed provider's
  previous entry, so a saved chat model is not silently replaced by `chooseModel`'s fallback.
- `hub/modelCatalog.ts` + `ModelCatalogSettings.tsx`: after the CAS write, a refresh failure throws
  typed `CatalogRefreshError` carrying `appliedPi`; the UI records ownership (not the version), so
  later removals still remove Hub-owned providers. Still not reported as success.
- `schedules/tasks.ts migrateLegacy`: a failed backup prune after accepted receipts returns
  `backupRetained: true` instead of rejecting as "not transferred" every start.
- `control/bridge.ts`: `engine: "opencode"` (or anything but the runtime tag) is refused **before**
  any project/chat selection or send (was: toast + silent execution by the runtime); recovery prompt
  no longer names OpenCode; dead engine-switch branches removed.
- `components/SkillQualitySettings.tsx`: listed nothing (required `engines` ⊇ {pi, opencode}, native
  reports `["pi"]`); stale "OpenCode и Pi" text.
- `components/ContextMeter.tsx`: dead engine branch; shows the runtime's auto-compaction setting.
- Stale user-visible OpenCode/Pi-CLI texts: UsageSettings, ProjectActions, ImageGenerationSettings,
  Composer ("Reconnecting…" English), store toasts (English), help texts. `settings/help(Topics).ts`:
  16 topics for removed OpenCode/Pi-CLI controls deleted (no component referenced them); live ones
  rewritten for the sole runtime. `index.html` `lang="ru"` (screen readers).

## 2. Tests written or ported (ALL NOT RUN)

New files: `test/host-dialogs.test.ts` (4), `test/store-runtime-authority.test.ts` (9: same-ledger
404/rejected/cancelled/completed settlement, pre-2.0 positive-evidence only, foreign ledger, rescan
catalog retention, busy-chat deferred model choice, archive continuation provenance + stale answer,
`runtime.settings` store effect), `test/skill-quality-ui.test.ts` (1).
Added cases: workshop (4 archive-pointer cases incl. store atomicity), pi-settings (3, and the store
mock now mirrors `onRuntimeSettings/currentHost`), runtime-store-sync (1), runtime-client-transport
(1, empty-vs-JSON split), catalog-apply (1), agent-control (1), browser-settings (1 foreign scope).
Fixture/API ports with contract reason (assertion intent kept):
- browser-settings: two mocks returned engine `opencode` for a `pi` selection → `pi`.
- store-regressions: preparation gate `ensure` → actual seam `ensureLocal` (4 cases); workshop case
  asserts only user text (policy owned by agent `turn-policy.test.ts`); manual compaction sends
  `payload: {}` (runtime current model); the "late compaction" race case re-expressed at submission
  time because no awaited preparation precedes the compact command any more.
- model-selection: gates on `/health` (pre-lock window) and the `model.transition` receipt.
- queue-access: the lossy `migrateLegacyQueues` case remapped to store `migrateLegacyQueueState`
  (full records, attachments, uncertain state, per-receipt prune, same-id retry, no replay).
- scheduler-delivery-storage (3), scheduler-storage-unavailable (1), schedules (1): ported to
  `migrateLegacy(storage, RuntimeBackend, {installation, workspace, servers})` + idempotent
  `/migrations/cutover` journal fixture; corrupt raw, failed prune, refusal isolation retained.
Stale "Expected RED until…" headers updated where the defect is fixed.

## 3. Cross-scope contracts and proposals (not implemented here; no fake callbacks)

1. **Runtime capability refresh (runtime author).** Proposed typed port, UI caller to follow:
   `POST /v1/capabilities/refresh {directory: string|null}` → `{ invalidated: true;
   refreshed: string[] /*idle workers reopened with new ResourceSpec*/; pending: string[]
   /*busy workers marked pending-refresh, reopened at next idle*/ }`, authenticated, host-scoped,
   no abort/replay, clears `Runtime.capabilityScopes` (core/runtime.ts:300-307, 30 s cache).
   Client: `RuntimeClient.refreshCapabilities(directory)`; caller: `Store.configureSharedTools`
   (replace the read-only `GET /extensions`). Until then the UI says honestly that already open
   workers keep their resources.
2. **Dead duplicate UI Hub orchestration** (models/hub.ts `HubModelServices.ensure/prepare/renew`
   and `ModelServices.ensure`, models/services.ts:407): no production caller (runtime dispatcher
   owns readiness + whole-turn lease). In practice the 15 s `renew()` timer can only ever see
   pre-2.0 leases restored from localStorage (released after 60 s when not active) — unchanged
   by me, statically reasoned, not run. Proposal: keep `route/status/configuredRoutes/check` (display +
   explicit probe), remove `ensure/prepare/lease cache/renew timer`; tests to re-home/retire:
   `test/model-hub.test.ts` (14 refs). Needs coordinator mapping before deletion — not removed.
3. **Dead duplicate prompt policy in the window**: `src/agent/promptPolicy.ts`,
   `src/agent/toolWorkflow.ts`, `src/workshop/policy.ts` have **no production importer**
   (runtime `policy/*` + `sdk/history.ts` own injection/hiding). Their tests
   (`prompt-language`, `schedule-wakeups`, `execution-feedback`, `workshop-policy`) partly assert
   byte-identity with the runtime copies; re-home those onto `src-tauri/resources/agent/src/policy`
   then delete the three modules. Not deleted here.
4. Native: `hosts::prepare_chat_workspace` has no UI caller left (runtime `POST /workspaces/chat`
   creates chat folders). Native author may retire it.
5. `AgentCapabilities` flags are a constant all-true for the sole runtime, so the
   "agent does not accept attachments/fork" branches in store are unreachable; real refusals are
   model/MIME based (integration/attachments tests). Recommend retiring the false-flag premise of
   `agent-backend.test.ts` explicitly rather than inventing a fake backend.

## 4. Retirement-gap status for TEST-CUTOVER-DELETE-PATHS.json (UI-owned rows)

The manifest file itself is outside my edit scope; updated mapping for the coordinator:
- `config-reload`: gap closed by `runtime-store-sync › hands validated runtime.settings…`,
  `store-runtime-authority › runtime.settings from the current runtime…`, `pi-settings › a
  runtime.settings announcement…`.
- `engine-routing`: rescan → `store-runtime-authority › a rescan with provider errors keeps…`;
  busy transfer → `› choosing a model for a busy chat defers it…`; continueLegacySession →
  `› continuing an archive selects…`. "Does not compact fitting history" stays a **runtime** row
  (model-transition planner); newer-selection RED → ported `model-selection › a newer selection…`.
- `client`: JSON-required 204 no longer expected RED (fixed); plus the new empty/JSON split case.
- `agent-backend`: see §3.5 — retire premise; not closable by a UI test without a fake backend.
- `full-access-loop`, `pi-backend` (fork veto, late close events), `pi-translate` (extension fault
  vs transcript), `schedule-preflight` (real vanished model/variant), `local-server` (native
  concurrent ensure), `pi-live` remain **runtime/native/acceptance** owned; untouched here.
Keep `deleteNow` false for every row whose gap is not closed by a qualified (run) test.

## 5. Invariants deliberately preserved

Runtime is the only dispatcher (no window loop/timer/Hub lease added); no direct local fallback for
a remote host; lost-ACK: same id only, a 2.0 404 never disproves a pre-2.0 send; drafts cleared
only for the accepted revision; queued/timer cutover keeps complete records + attachments until a
per-item receipt; workshop un-pointed archives never adopted; strict browser scope guard; shared
registry project/global semantics; PTY cleanup-unknown shown with explicit detach (no fake idle);
read-only archive provenance; Hub catalog OpenCode fields kept as shared-data compatibility for
not-yet-updated devices; saved SSH host identity keys unchanged.

## 6. Review ledger (honest depth)

Read in full and reviewed: `agent/{backend,registry,promptPolicy,toolWorkflow}.ts`,
`agent/runtime/{backend,client,connection,ids}.ts`, `browser/integration.ts`,
`capabilities/integration.ts`, `components/{BrowserSettings,CapabilitiesSettings,HandoffDialog,
ScheduleSection,ContextPanel,PromptQueue,HostDialogs,PiSettings,SkillQualitySettings,ContextMeter}`,
`control/bridge.ts`, `hub/modelCatalog.ts`, `models/hub.ts`, `native/hosts.ts`,
`operations/journal.ts`, `schedules/{control,tasks}.ts`, `settings/{help,helpTopics}.ts`,
`state/{cutover,engines,errors,handoff,modelChoice,modelTransition,promptQueue,runtimeSync,
submission,computer}.ts`, `updates/runtime.tsx`, `workshop/{workspace,policy}.ts`, `index.html`,
`vite.config.ts`, `vitest.config.ts`, `tsconfig*.json`.
Partially read (the sections touching the paths above): `state/store.ts` (connect/host,
capabilities/browser, workshop, metadata, model choice/selection, send, compaction, reconcile,
streams), `components/{Composer,ChatView,Sidebar,TerminalPanel,UsageSettings,ModelCatalogSettings,
ProjectActions,ImageGenerationSettings}`, `capabilities/registry.ts`, `models/services.ts`,
`state/{prefs,context,types}.ts`, `src-tauri/src/{hosts,lib}.rs`, runtime `server/{routes,
ui-routes}.ts`, `core/runtime.ts` (capabilities/resources/activity), relevant tests.
Cross-cutting sweeps over all of `src/**`: every native `invoke`/`capabilityNative`/`browserNative`
command name vs the native `generate_handler!` list (only `connect_ssh` was dead); every
`OpenCode/opencode` occurrence (remaining ones are legitimate archive/legacy-data/provenance);
engine-tag filters on shared data; `Expected RED` headers in tests.
**Not reviewed in depth (unchecked)**: `App.tsx`, `components/{render,Markdown,Dialogs,RightPanel,
BrowserPanel,BrowserMonitor,BrowserEnvironmentSettings,BrowserPerformance,VoiceInput,VoiceWaveform,
GeneratedImages,AttachmentViewer,PdfPreview,PluginUiPanel,PluginTerminalSurface,MemorySection,
OutcomeSection,RecoveryCenter,TaskDiagnostics,TopBar,UpdateSettings,HubSettings,
ModelServicesSettings,ModelSwitchStatus,ModelSelectionDialog,ModelConnectionCheck,Palette,
SelectMenu,SessionSpinner,TimerBadge,WorkspacePicker,MessageEdit,InformationDialog,ComputerSettings,
AgentControlSettings,SettingsScreen,ScheduleDialog,PiDialog,…}`, `agent/runtime/{events.ts,
pluginUi/*}`, `api/*`, `attachments/*`, `chat/*`, `voice/*`, `images/*`, `memory/*`, `outcomes/*`,
`usage/*`, `util/*`, other `hub/*`, `state/{chatReducer,queue,sidebar,notifications,access,…}`,
and the bulk of `test/**`. Voice chunk recovery, image/PBR cards, plugin-UI surfaces, DnD
geometry and accessibility/responsiveness of these screens were NOT re-audited in this pass.

## 7. Remaining concrete limitations

- Nothing here was compiled or run; new/ported tests may need fixture adjustments on the Mac.
- Capability refresh for idle workers needs the runtime port in §3.1.
- §3.2/§3.3 dead duplicate modules remain until their tests are re-homed/retired by mapping.
- Runtime/native-owned retirement gaps in §4 remain open; this pass did not touch them.
- `test/config-reload.test.ts` still drives the retired `global.disposed` wire (held obsolete file).
