# LEGACY-RESULT — history/settings/queue/timer cutover (Opus 5.5, resumed pass)

**SOURCE ONLY / NOT VERIFIED.** Nothing was executed on the borrowed machine: no
shell, test, typecheck, lint, format, build, install, git, app, UI or browser.
**Every check listed below is NOT RUN.** No version bump (2.0.0 only after full
Mac acceptance). Do not read this as "features work" before the Mac runs.

## Inputs actually available

- Read: `sdk-reference/enki-tasks/TODO-FOR-OPUS-config-integration-contract.md`,
  `TODO-FOR-OPUS-runtime-vitest-baseline.md`, `enki-config-current/**`.
- **Not present** in either permitted directory (so not read): `TODO-FOR-OPUS-legacy.md`,
  `-runtime-graph.md`, `-migration-preservation.md`, `-pty-cleanup-contract.md`,
  `-project-tool-env.md`, `-remaining-runtime-integrations.md`, `-hub-qwen-vertical.md`,
  `-frontend-current.md`, `-ui-runtime.md`, `REMOTE-TASK.md`. The task text was the
  specification for those items; the "14 frontend TS blockers" list was not available.

## Merge instruction for the coordinator (important)

`core/runtime.ts` and `server/routes.ts` here are **pre-merged** with
`enki-config-current` (projection load order, `VaultCredentialStore(broker, projection)`,
`createModelRuntime({config})`, `sdkSettings` imported retry, `configStatus()`,
`importPiConfig()`, `POST/GET /migrations/pi-agent`). This project snapshot still has the
pre-config baseline of the config-owned files. **Overlay these from enki-config-current
unchanged, but keep this pass's `runtime.ts`/`routes.ts`:** `src/models/config.ts`,
`src/legacy/pi-config-commit.ts`, `src/models/credentials.ts`, `src/control/broker.ts`,
`src/sdk/adapter.ts` (config-current is a superset of the project version — checked by
export map), and the native `src-tauri/src/runtime/{config_commit,vault,config_fs}.rs` +
`runtime.rs` changes. Without that overlay the runtime does not compile (missing modules).

## Inherited partial work (previous interrupted job — kept, not redone)

Read and kept as the base: `src/migration/cutover.ts` (durable cutover journal),
`store/db.ts` `cutover_items`, `queue.importItem`, `scheduler.importTask` (paused stored
disabled in one write), runtime `piCli: PiCliImporter` with disjoint roots, async
`continueArchive` (raw reader + validated local directory + model-aware seed, serialized),
`cutoverTarget` resolver (archive → verified continuation, quarantine reasons), recovery of
importer/continuation journals before `registry.start()`, `projectArchiveMessages`
projection, `/migrations/{opencode,pi-cli,cutover,evidence}` routes, Stop-cancel
classification (`test/integration/stop-cancel.test.ts`), per-client SSE budgets in
`server/http.ts`, and runtime tests `cutover.test.ts`, `pi-cli-import.test.ts`,
`legacy-import.test.ts` (partially migrated).

## Changes in this pass

### Runtime (`src-tauri/resources/agent`)
- **Config contract** (`core/runtime.ts`, `server/routes.ts`): removed the placeholder
  `RuntimeConfig.configCommit`; real `runtime.importPiConfig(signal)` /
  `configStatus()` from config-current. `POST /migrations/pi-agent` maps
  `CONFIG_NATIVE_UNAVAILABLE`→501, `CONFIG_MAINTENANCE`→503, conflicts→409,
  `PiConfigError`→409; `GET /migrations/pi-agent` = sanitized status; `/migrations` adds
  `piAgent.{available,status}`. No caller operation id exists, so the route comment states
  that a lost HTTP ACK must be shown as unknown (never blindly re-POSTed).
  `/credentials/:provider` passes `runtime.configProjection`.
- **`/config/models`**: when an imported generation is active (ready/blocked with its own
  models.json) GET returns it **read-only** (`readOnly:true, source:"imported", state,
  configRevision`); PUT is refused (`409 CONFIG_IMPORTED_READ_ONLY`) so the import is not
  silently shadowed. Owner mode unchanged (`readOnly:false, source:"owner"`).
- **Hub discovery before the first inference** (`models/hub.ts`, `execution/dispatcher.ts`):
  new `HubLeases.resolve()` performs trusted catalog discovery before the direct-vs-Hub
  decision (prompts incl. queue/timer, source-model summaries via `readiness`, manual
  compaction gate, `/models/check`). Known routes stay fail-closed; Hub unavailable →
  genuine direct providers work; Hub connected but catalog unreadable →
  `HubDiscoveryError` (refused, never direct); successful read cached 60 s. Background
  `discover()` at `start()`, aborted on `stop()`. No pre-seeding or new caller flags.
- **PTY honest close** (`platform/pty.ts`, routes): one kill, bounded `closing`
  (5 s) → `cleanup-unknown`; primary `onExit` no longer means idle/cleaned (documented
  node-pty 1.1 SIGHUP limitation); records keep blocking maintenance until explicit
  `POST /pty/:id/detach` (relinquishes, signals nothing, reports `cleanup:"unknown"`);
  `GET /pty/closing`. No stored PID/PGID is re-signalled.
- **Daemon environment** (`daemon-control.ts` `daemonEnvironment`, `main.ts`,
  `scripts/runtime/install-remote.mjs`): fresh `ensure` and the verified updater restart
  now share one policy — inherit everything (HOME, USERPROFILE, SSH_AUTH_SOCK, proxies,
  custom vars) except the four Node injection keys (case-insensitive on Windows); the old
  allowlist and the updater's three-key variant are gone. `platform/launch-env.mjs` is an
  emptied, unreferenced stub (listed for deletion).
- **Cutover**: adopting an early unjournaled timer copy (`requestKey legacy-<id>`) instead
  of duplicating it, disabling it in the same transaction when the source was paused/uncertain.
- **Computer skill**: `capabilities.prepare` reports `computerSkillPath` (native
  `computer::enabled_skill_path()`: enabled + installed driver + real SKILL.md, no links);
  runtime adds it to the explicit ResourceSpec `skillPaths` (local host only).
- **LSP switch**: new runtime setting `lspEnabled` (default true) gates `lspConfig` in
  resources; UI switch persists it; a pre-2.0 "off" is carried over once.

### Native (narrow)
- `src-tauri/src/journal.rs`: optional `authority` field (part of the immutable identity,
  old bodies still load) + test. Needed for the lost-ACK authority binding below.
- `src-tauri/src/computer.rs`, `capabilities.rs`: computer skill path (above).

### Frontend
- **Model choice** (`state/modelTransition.ts`, `state/store.ts`): removed the UI
  `transferContext → summarize → waitForSummary → modelServices.ensure` loop. An idle chat
  gets ONE durable `model.transition` (stable id; lost ACK → receipt lookup; only a ledger
  404 allows a same-id resubmit; uncertain → unknown). Progress from
  `session.context_transition` (routed in `runtimeSync.ts`), typed recovery text on
  failure; previous choice/draft/queue untouched on failure/cancel. Busy chat → choice
  deferred to the next prompt (no abort, no unload). Closing the dialog only stops waiting.
  `setModelChoice` no longer loads models; send path no longer calls `assertContextReady`
  or the removed `modelServices.reserve`; it calls new `modelServices.ensureLocal` (local
  non-Hub service only — no UI Hub lease). Manual compaction sends `compact` without a
  payload model. `src/state/contextTransfer.ts` (+ its test) listed for deletion.
- **Queue cutover** (`state/cutover.ts`, store): prefs queues → `POST /migrations/cutover`
  with complete items (raw attachment bytes as data URLs, model+variant, agent, order,
  `sending`→`uncertain`, unreadable files counted → runtime quarantine with payload).
  Stable installation id (`enki.installation.v1`), workspace key, batches of 50. Only
  items with accepted/resolved receipts are removed from prefs; failures change nothing.
  The old lossy `migrateLegacyQueues` (text→draft, attachments dropped, blanket clear) is
  removed.
- **Timer cutover** (`schedules/tasks.ts` `migrateLegacy`, wired from the store): per
  workspace (old `server` origins), through the journal; the global `.migrated` marker is
  no longer written/trusted; only acknowledged records leave `ocdesktop.scheduled-prompts.v1`.
- **History before mapping**: local runtime imports OpenCode DB / Pi CLI chats (idempotent)
  once per computer before mapping queue/timer items; inherited "full access" carried into
  the runtime `defaultPolicy` once per workspace only if still the default (per-chat rules,
  incl. exact deny, come with each imported chat).
- **Recovery UI** (`RecoveryCenter.tsx`): quarantined/unfinished cutover items with
  "Повторить перенос" / "Больше не переносить" (resolve keeps the audit row).
- **Lost-ACK authority** (`operations/journal.ts`, store): new sends record
  `authority: runtime:<hostId>`; only that exact ledger's 404 settles a record as refused.
  Records from OpenCode/Pi CLI/another ledger use origin-bound positive evidence
  (`POST /migrations/evidence`); absence stays "unknown"; nothing is resent.
- **Workspace snapshots**: remote→local finds the pre-2.0 local snapshot by
  `localWorkspace/localEndpoint` and copies it to the stable local key (backup kept); SSH
  keys are never candidates.
- **Hub catalog Apply** (`hub/modelCatalog.ts`): single runtime CAS `/config/models` +
  `/providers/refresh`; refused (nothing written) on a remote runtime or an active
  imported generation; refresh errors are surfaced, no false "applied".
- **Duplicated policy**: fresh user messages no longer carry the language/tool/schedule/
  workshop blocks (the runtime appends them to every system prompt).
- **Terminal UI**: close returns at once; closing/cleanup-unknown notes with "Отсоединить";
  update blocker text distinguishes open vs closed-unconfirmed shells.

## Tests written (all NOT RUN)

Runtime (Vitest): `test/integration/hub-discovery.test.ts` (unreadable catalog refused,
Hub down → direct, TTL, `/models/check`), `test/pty-activity.test.ts` (updated: no fake
idle after primary exit, bounded closing, no second signal, detach over HTTP),
`test/daemon-environment.test.ts` (synthetic env only; updater fallback == bundle),
`test/sse-budget.test.ts` (two clients, 429 backpressure, released slot),
`test/cutover.test.ts` (+ legacy-copy adoption), `test/pi-cli-import.test.ts` (pi-agent →
real `importPiConfig` 501 + sanitized status + owner `/config/models`),
`test/legacy-import.test.ts` (DB+WAL byte-identical; SHM sidecar only required to exist).
The four Hub RED tests (`cancel-and-hub:45,63`, `model-context-hub:70,86`) are unchanged
and are expected to turn green from the production fix.
Native: `journal::tests::authority_is_part_of_the_immutable_identity_and_old_records_still_load`.
Frontend: `test/model-transition.test.ts`, `test/legacy-cutover.test.ts`,
`test/catalog-apply.test.ts` (migrated to the runtime port).

## Remaining narrow ports / honest limits

1. Overlay the config-owned files (see merge instruction); hot reload, imported default
   model selection and resource migration remain TODO per the config contract.
2. Old frontend tests that mock `modelServices.ensure`/`reserve`, `transferContext` or
   OpenCode clients (e.g. `queue-attachments`, `queue-access`, `store-regressions`,
   `engine-routing`) will fail until the frontend-test pass rewires them; not edited here.
3. Archive **Workshop pointer → verified continuation** and **authenticated capability
   refresh with idle-only worker refresh** were not implemented (their TODO notes were
   unavailable). The 14 frontend TS blockers could not be enumerated without the list or a
   typecheck; only `modelServices.reserve` (removed API) was fixed here.
4. PTY: real descendant cleanup still needs an owned process-tree backend; until then
   every closed shell needs an explicit detach before automatic maintenance (documented
   limitation, intentionally conservative).
5. Queue item engine for pre-2.0 ids is derived from the id shape (`ses_…` → OpenCode,
   else Pi CLI); a wrong guess quarantines visibly (`source_not_imported`), never misroutes.
6. Remote runtimes: no legacy history import (no local sources), Hub catalog Apply refused,
   `/credentials` stays 409 — by design.
7. Runtime tests owned by the separate runtime-fixture pass (protocol, access copy, crash
   simulation, model-transition fixtures, SSE teardown in `helpers.ts`) were not edited.

Checks: runtime Vitest, `node --test` guarded suites, `npm run typecheck` (runtime and
desktop), frontend Vitest, `cargo test`/`clippy`, builds, Mac acceptance — **all NOT RUN**.
