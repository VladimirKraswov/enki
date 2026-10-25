# Test cutover to the single Pi SDK runtime — result (source only)

Date 2026-10-25. Continuation of the interrupted source-only job. **Every check is NOT RUN**: no tests,
typecheck, build, Clippy, install, app, browser or subprocess were executed on this machine. Nothing in
this report is a pass claim. No version bump, release or final review claim; the whole-code Opus review
before the final 2.0 build remains mandatory.

## Scope actually edited

* `test/**` (frontend tests and the shared fixture `test/helpers/runtime-fixture.ts`).
* New runtime tests under `src-tauri/resources/agent/test/**` (no existing runtime test was edited —
  those 11 fixes belong to the runtime-fixture author).
* `src-tauri/src/build_job.rs`: only the two authorised items below.
* New docs: this file and `TEST-CUTOVER-DELETE-PATHS.json`. `MIGRATION_DELETE_PATHS.json` (earlier UI
  pass) is unchanged. No production frontend/runtime/native source, config, package or lock was edited.

## Native (src-tauri/src/build_job.rs)

1. `#[cfg(test)]` framing (found already applied by the interrupted job, verified by reading):
   `runner_cli_helper` writes `"\n" + "ENKI_BUILD_JOB_TEST_RESULT " + json`, and
   `streamed_output_cannot_block_the_deadline` accepts only a line that starts with that exact marker and
   whose remainder parses as JSON with `kind == "run"`. Deadline (`finished` within 2 s), `reaped == true`
   and `streamComplete == false` assertions are unchanged; no skip, no regex acceptance.
2. Clippy `field capture is never read`: removed only `Collector.capture` and its initializer
   (`capture: job.capture`). `Job.capture` stays: it still selects the outbox
   (`outbox: (!job.capture).then(Outbox::start)`). No behaviour, process or lifecycle change.
Checks NOT RUN: component/standalone `cargo test`, standalone `cargo clippy -- -D warnings`, Windows GNU check.

## Shared fixture (`test/helpers/runtime-fixture.ts`)

Production `RuntimeBackend`/`RuntimeClient` unchanged; only the loopback wire is in memory:
route table with `:param` patterns, empty real-DTO reads by default, unrouted mutations fail visibly
(`unexpected`), `RuntimeReply(status, body)` for exact runtime refusals, per-call abort `signal` and
fetch-like rejection on abort, origin dispatch so several runtimes (this computer + forwarded SSH ports)
coexist, `emit`/`emitGlobal` into the store's real subscriptions, `withProvider` for the catalogue the store
reloads on every project switch, and `bindStore` (replaces only the native `connectRuntime` handshake;
the bound runtime identity always wins over a test's prefs patch). Host switches in sidebar/activity/
acceptance/workspaces go through the store's real `connectHost → doConnect`, with only
`agent/registry.connectRuntime` mocked. Store suites use `vi.resetModules()` + dynamic import of the
fixture so `ApiError`/`ConnectionError` share one module graph with the store.

## Frontend suites (45 previously failing)

Rewired to the runtime (assertions kept, wire expectations now runtime routes/DTOs):
store-regressions, queue-access, queue-attachments, composer-queue, workspaces, sidebar, activity,
acceptance, context-panel-ui, context-child-routing, workshop, message-edit, handoff, usage,
transport-reliability, schedules, schedule-control, schedule-section-ui, schedule-wakeups,
scheduler-delivery-storage, scheduler-storage-unavailable, capabilities-registry, capabilities-settings,
browser-integration, browser-settings, browser-preferences, browser-performance, agent-control, computer,
managed-plugins, pi-settings, pi-workspace, state-policy, access-inheritance, appearance,
shared-setup-report, task-diagnostics, archive-references, prompt-language, workshop-policy, pi-shared-tools.

Left intact (guard denials, not product assertions; the Mac coordinator qualifies them): evaluations (10),
project-map (4, two are downstream "Cannot verify repository scope" of a denied git subprocess),
ci-artifacts (1), shared-script-paths (1).

Moved to the actual owner instead of a fake window authority:
* scheduler dispatch (due/once/repeat, no catch-up, busy/question/maintenance waits, durable-before-send,
  uncertain vs refused vs cancelled, crash recovery, corrupt rows, request-key dedup, limits,
  acknowledgement-write failure) → `resources/agent/test/scheduler-unit.test.ts` (new);
* queue dispatch (exactly once on idle with captured model, refusal/uncertain/Stop, fatal vs recoverable,
  steering, edit/reorder fences, prepared attachments, restart) → `resources/agent/test/queue-unit.test.ts`
  (new);
* translator/history (durable ids, tools, errors, retry, reasoning, unknown events, paging) →
  `resources/agent/test/sdk-translate.test.ts` (new); policy hiding stays cross-checked from the UI tests;
* per-turn policy incl. workshop authority for queued/steered turns, browser scope →
  `resources/agent/test/turn-policy.test.ts` (new);
* ephemeral model probe (no session/transcript/identity collision) →
  `resources/agent/test/integration/model-check.test.ts` (new);
* reserved MCP entries → `test/reserved-servers.test.ts` (new), model selection lifecycle →
  `test/model-selection.test.ts` (new), client security → `test/http.test.ts`,
  `test/runtime-client-transport.test.ts` (both from the interrupted job, completed and corrected).

Retired (engine/process-specific only, each listed per suite in `TEST-CUTOVER-DELETE-PATHS.json`):
OpenCode JSONC writers (desktop_browser, shared MCP, agent control, computer, plugin graph),
OpenCode `/instance/dispose` refresh, two-engine routing, Pi CLI process/RPC specifics, window-owned
timer/queue/journal dispatch.

Corrections to the interrupted job's partial files: the transport timeout test waited 1.5 s although
`/commands` carries its own 120 s deadline (fixed, plus a default-timeout read case); the fixture gained
abort semantics, origin dispatch, `withProvider` and a non-clobbering `bindStore`.

## Genuine source/caller defects (found by reading; tests written to expose them — expected RED)

Not fixed here (production source is out of scope). Each has a concrete failing scenario:

1. `src/state/store.ts:2246` awaits removed `modelServices.reserve` → every manual send throws a
   TypeError after session creation and before `POST /commands`. RED: every case that expects
   `sendPrompt` to return true / post one command (store-regressions R5, workshop authorization,
   cancelled-preparation, Stop-after-POST, browser tools, stop routing, browser Low; workspaces first
   projectless send / file part; acceptance completion-before-ACK). Cases asserting *no* command pass
   regardless and therefore do not prove the fix.
2. `src/agent/runtime/client.ts` never enforces `RequestOptions.empty`: a JSON-required read answered
   204/empty resolves `undefined` (e.g. `health()` → later TypeError in `doConnect`). RED:
   runtime-client-transport › a JSON-required endpoint answering 204 or an empty body is an ApiError.
3. `src-tauri/resources/shared/pi-extension.ts:72–82`: no `generation !== epoch` check after
   `await lease.connection.tools()`; a session shut down during discovery still registers tools
   (they fail closed on execute, but are advertised). RED (pre-existing): pi-shared-tools › shutdown during
   discovery does not register late tools.
4. `src/schedules/control.ts`: imports removed `chooseOpenCodeModel/choosePiModel` and does not await the
   now-async `add/toggle/remove` (a Promise is returned as `task`; refusals become unhandled rejections —
   a plausible source of the 22 unhandled rejections). RED: schedule-control (3).
5. `src/components/ScheduleSection.tsx:49` undeclared `engine` (ReferenceError on save) and `mutate`
   wraps async toggle/remove in a sync `try` (runtime refusal → unhandled rejection, no message).
   RED: schedule-section-ui (2), context-panel-ui › saving a recurrence….
6. `src/components/BrowserSettings.tsx:25,74–75` read removed `setup.openCode/pi`: the initial `idle`
   phase with the browser enabled calls `undefined.includes`. RED: browser-settings › renders the initial
   setup state of the single runtime without per-engine rows.
7. `src/components/ContextPanel.tsx:94` lists children only when `engine === "opencode"` (never true);
   `GET /sessions/:id/children` is never called, so imported-archive subagents are unreachable.
   RED: context-panel-ui (3 child-list cases).
8. `PromptQueueController.steerQueued` has no double-click fence: the second `POST …/steer` is refused
   by the runtime ("уже отправляется") and shown as an error. RED: queue-access › Now steers….

Static cautions (read, not reproduced; no test asserts them):
* The window still appends language/tool/timer/workshop reminders to user parts (`agentParts`) while the
  runtime injects the same blocks into the system prompt: duplicated tokens (hidden in history).
* Queued-item image context is staged under the item id, but the runtime dispatches it as
  `queue-<id>-<attempt>`; the comment in store.ts claims they are equal.
* `Scheduler.tick` has no try/catch around `host.submit`: a throw leaves the task `dispatching` until a
  restart (safe — never replayed — but toggle/remove are refused meanwhile).
* `GET /sessions/status` reflects workers only; an accepted command gated on Hub preparation reads as
  idle to handoff/edit preflights.
* The store ignores `runtime.settings`; its `global.disposed` invalidation has no producer.
* `restorePiRuntime` applies a snapshot requested before a later queue mutation; `owns()` is evaluated at
  apply time, so a slow snapshot can briefly replace a newer queue mirror.
* The window's `modelServices.ensure` still prepares Hub models while the runtime owns Hub leases
  (double ownership; runtime Hub routing itself is RED in the runtime baseline).
* `sdk/history.ts entriesToMessages` would throw on a `message` entry without `message`.
* No production importer remains for `src/api/events.ts`, `src/util/managedPlugins.ts`,
  `src-tauri/resources/browser/access-policy.mjs` (only the OpenCode plugin imports it).

## Coverage matrix and deletion proposal

`TEST-CUTOVER-DELETE-PATHS.json` lists, for all 13 proposed deletions, the retired engine/process
specifics, each independent invariant with the exact new test titles of its owner, and explicit gaps. All
13 are marked `deleteNow: true` because no independent invariant is left without either a named test or a
written gap; the coordinator should still apply them only after the mapped tests ran. Remaining gaps
(also in the JSON): a capability flag set to false is never exercised; native single-start of the local
runtime; a pending permission is not re-evaluated when rules later become full; fork cancelled by an
extension; extension runtime error kept out of the transcript; catalogue rescan failure keeps the
previous catalogue; `transferContext` guards (fitting history, busy engine); `continueLegacySession`
provenance in the window; `Runtime.scheduleProblem` with a vanished model/variant; no reaction to
`runtime.settings`.

## Checks — all NOT RUN

Frontend Vitest (guarded broad suite and the 45 suites), strict TypeScript, architecture check, Vite
build; runtime Vitest (`test/**/*.test.ts`) and `test:node` suites; native component and standalone
`cargo test`, standalone `cargo clippy --all-targets -- -D warnings`, Windows GNU check. Expected REDs
are listed above; any other failure is unknown until run. App visual/interaction quality is not covered.
