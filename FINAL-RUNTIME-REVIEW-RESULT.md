# Final runtime review — Opus 5.5 (runtime scope)

Scope: `src-tauri/resources/{agent,shared,browser,pi}/**` and `docs/SDK-UPGRADE.md`.
Source editing only. **Every check below is NOT RUN**: no test, typecheck,
build, install, app or subprocess was executed in this pass. Nothing was
deleted (proposal: `FINAL-RUNTIME-DELETE-PATHS.json`). No version bump, no
publish, no readiness claim.

## 1. Fixes (source)

### P1 paired update backup vs. session layout (CRITICAL, fixed)
Two independent triggers made every `Runtime.backupForUpdate` fail:
1. `Runtime` eagerly creates `sessions/pi-cli` (writable Pi CLI imports
   `pi-cli/pi-legacy-<48hex>/{session.jsonl,ownership.json}`), which the
   snapshot rejected (it accepted only flat `<sha16>/<file>`).
2. **New finding:** `ContinuationImporter`'s constructor creates
   `<sha16>/.legacy-continuations/` in EVERY shard during startup recovery, so
   even a runtime with no Pi import failed its backup after the first restart.

Fix: one canonical `SESSION_LAYOUT` in `agent/src/platform/paths.ts`, used by
`core/runtime.ts` (importer root, continuation recovery), `legacy/pi-cli.ts`
(runtime file / ownership names, identical bytes → no data migration) and
`platform/update-snapshot.ts` (rewritten walker). The snapshot now copies,
hashes, verifies and restores SDK shard files AND every file of writable Pi
CLI imports (incl. ownership metadata and SDK-created files there). Manifest
schema 1 is kept byte-compatible for shard-only stores; schema 2 is written
only when Pi CLI paths exist; verify accepts 1 and 2 (installer uses the
target bundle's verifier). Continuation staging must be EMPTY under the idle
fence (fail closed with a restart hint, never silently skipped); restore
leaves it to startup recovery. Restore still moves the live store aside into
`preserved`, never deletes. Stray entries still fail closed.

### Schema contract drift (fixed)
`runtime-lock.json` `dataSchema` 2 → 3 (= `SCHEMA_VERSION`, store migration
3). `build.mjs` now refuses to build when `runtime-lock.json`
contract/dataSchema/sdk differ from `src/protocol.ts`. Native/scripts fixtures
that still say `dataSchema: 2` are ported to the native author (§5).

### MCP profile identity (P1, fixed in all three seams)
The MCP SDK stdio transport only inherits a HOME/PATH-like set, dropping
`ENKI_PROFILE_DIR`. New `profileEnvironment()` / `stdioEnvironment()` in
`shared/registry.mjs` (+ `.d.mts`): presence kept exactly (including empty or
invalid, which native `profile_override()` rejects → fail closed), absence
stays absence, nothing else forwarded. Wired into `agent/src/mcp/pool.ts`
`officialClient` (`--shared-mcp`), `browser/pi-extension.ts`
(`browserTransportParameters`, `--browser-mcp`) and `shared/client.mjs`
(only the app-owned `enki-images` child, alongside its lock command;
user-configured servers get neither).

### Explicit-profile legacy defaults (fixed)
`parseArgs` moved to side-effect-free `agent/src/launch-args.ts`. With
`ENKI_PROFILE_DIR` present (even empty) owner-home defaults are inert:
`--data` is required and `userPiAgentDir` stays undefined unless passed
explicitly. Without a profile, production defaults are unchanged. HOME is
untouched. `LaunchConfig.userPiAgentDir` / `RuntimeConfig.userPiAgentDir`
are optional; `daemonArguments` omits the flag; `importPiConfig` refuses with
`CONFIG_SOURCE_UNCONFIGURED` (HTTP 501) before any read or native call.

### Shared MCP extension lifecycle (fixed, assertion kept)
`shared/pi-extension.ts`: generation/abort rechecked after EVERY await
(registry read, acquire, `tools()`); a discovery that finishes after
shutdown/restart registers nothing and reports/notifies nothing over its
successor; a deadline abort in the same generation is still reported as an
error. `execute()` rechecks the generation after its registry read, so a call
racing shutdown never reaches a released lease.

### Capability scope refresh (remaining-integrations item 3, runtime side)
`POST /v1/capabilities/refresh {directory?}` → `Runtime.refreshCapabilities`:
bumps a scope epoch (an in-flight broker reply that raced the refresh is used
once but never cached), drops the cache, and `SessionRegistry.refreshResources`
recycles IDLE workers now; busy/gated/opening workers are only marked and are
recycled at their next idle use (in `worker()`) or by the sweeper — never
aborted, never replayed. Emits `runtime.resources`. Resource-selecting
settings (`extensionPaths`, `browserEnabled`, `lspEnabled`) trigger the same.

### CONFIG caller integration
* Imported `defaultProvider`/`defaultModel`: typed `ConfigProjection.defaultModel`
  (also kept on blocked projections for explainability), validated by
  `Runtime.configDefaults()` against the live catalog and projection admission;
  `GET /v1/config/defaults`; applied to `POST /sessions` only when no model is
  given. Never written to SDK settings or UI prefs.
* Honest restart semantics: after a successful import the status keeps
  describing the running projection and adds `pendingRestart
  {configRevision, generationId}` (omitted otherwise, so the exact `none` DTO
  is unchanged). No hot swap is claimed.
* `useUserPiResources`/`noDiscoveredExtensions` are stored and reported as the
  only effective policy (false/true); no inert "on" switch.
* Packages/extensions/skills/prompts remain deferred pointers (no ambient
  discovery, no network load) — unchanged, documented.

### Pending permission under a policy change (retirement gap)
`pi/tool-gate.ts` passes `recheck()` (re-runs `decide` for the exact pending
call); `InteractionBroker.reevaluatePermissions` settles pending requests the
CURRENT policy decides (allow → once, deny → reject) exactly once with
`by: "policy"`, no persistent grant. Called on `PATCH /sessions/:id`
permission changes and on default-policy changes.

### SDK fork veto (retirement gap)
`registry.fork` now asks the source session's extensions
(`session_before_fork` via `SessionWorker.allowsFork`, opening the worker if
needed) before any file/catalog row exists; veto → `ForkRefused` → HTTP 409.

### Timer preflight (retirement gap)
`scheduleProblem` also pauses a timer whose saved effort is unknown or not
supported by the saved model (previously the worker silently kept the current
level).

### Smaller fixes / cleanup
* `agent/package.json` + lock root `engines.node` `>=24.22.1` (dev interpreter
  = pin; SDK's own `>=22.19` stays in `runtime-lock.json sdk.engines`).
* Stale headers corrected: `main.ts` ("proposal"), `legacy/pi-cli.ts`
  ("not integrated"), `extensions/enki.ts` (claimed ambient Pi discovery).

## 2. Test infrastructure fixes (assertions preserved)

* `model-context.test.ts:88` timer case: the recorder now classifies SDK
  summarization requests (fixed SDK summarization system prompt). The check
  stays strict: source-only before the target, exactly ONE target turn, and
  after it only the SDK's own post-answer summaries of the small context —
  never a second turn/replay/other model. Existing `toEqual([...ids])`
  assertions are untouched (the flag is non-enumerable).
* `stop-cancel.test.ts:31`: awaits the exact durable `question.rejected`
  (same requestID, `by: "cancelled"`) instead of sampling the SSE buffer;
  cancelled/no-next-call/idle/genuine-error assertions unchanged.
* 13 test-only TS diagnostics: typed `FakeAuthority.call` signature (no
  behavior change), typed `continuedBy()` helper that THROWS on a non-opencode
  origin (keeps the old false-vs-undefined strictness), typed mock rest args,
  non-narrowed observer view, `ObjectValue` fixture annotation.
* Undici late reconnects to closed fixture ports: harness `request`, SSE
  `stream`, plugin-UI streams, the lost-ACK request and `sse-budget` now use
  `ownedRequest` (own socket, `agent:false`, `Connection: close`), tracked per
  harness and destroyed AND awaited before the listener closes. No pool exists
  that could reconnect; the guard is not loosened.
* Node-suite gate: `node-guard.mjs` now allows only LIVE listeners owned by
  this run (in-process + harness registry with pid liveness), refuses other
  loopback ports, expired ports, foreign IPC, DNS and external hosts, records
  every refusal, and injects itself into spawned Node children;
  `run-node-suites.mjs` fails the gate on any refusal. A new preload installs
  the run's immutable profile fixture through the PRODUCTION
  `installSdkEnvironment` before any SDK import; Vitest and Node share
  `setup/sdk-profile-fixture.mjs`. `sdk-worker-ui.node.ts` no longer overwrites
  `PI_CODING_AGENT_DIR` (its agentDir goes through WorkerDeps).

## 3. New regression tests (ALL NOT RUN)

| File | Covers |
| --- | --- |
| `agent/test/pi-cli-import.test.ts` (+2) | real import + turn + restart (staging dir present) → paired backup schema 2 incl. `pi-cli` session/ownership + shard file → later turn → installer restore: exact bytes, newer store preserved, catalog/history valid, re-backup OK; fail-closed stray entries / unrecovered staging |
| `agent/test/protocol.test.ts` (+1) | runtime-lock contract/dataSchema/sdk = protocol constants = migrated `user_version` |
| `agent/test/profile-env.test.ts` | REAL SDK `StdioClientTransport` + harmless owned child: SDK default drops profile; pool/browser/image keep A, B, empty; absent stays absent; no secret canary; custom servers get nothing; launch defaults inert under profile |
| `agent/test/shared-extension-lifecycle.test.ts` | late discovery after shutdown, restart during discovery, shutdown during execute's registry read |
| `agent/test/integration/resource-refresh.test.ts` | idle reopen, busy recycled only after its turn, other project untouched, one provider call per prompt, settings-triggered refresh |
| `agent/test/config-defaults.test.ts` | validated imported default, explicit model wins, unknown/blocked/malformed defaults refused, effective discovery policy |
| `agent/test/config-vault.node.ts` (+2) | actual `Runtime.importPiConfig` → `pendingRestart` → restart → active generation; profile without source refuses with no native config call |
| `agent/test/integration/pending-policy.test.ts` | full/read/unrelated policy change while a request waits |
| `agent/test/integration/fork-veto.test.ts` | SDK `session_before_fork` veto (null and message forks) |
| `agent/test/integration/extension-fault.test.ts` | real hook error → scoped notice, no history/transcript contamination, replay once |
| `agent/test/integration/schedules.test.ts` (+1) | vanished model / unknown effort / effort on non-reasoning model pause without dispatch |
| `agent/test/integration/model-context.test.ts` (+1) | fitting history never summarized; busy chat refuses `model.set` |
| `agent/test/browser-access.test.ts` | browser scope from rules/default only |

Original RED→GREEN assertions (runtime-lifecycle `:97,:120`, Hub, crash,
legacy) were not modified.

## 4. Preserved invariants

Single SDK agent loop; Enki owns policy/transport/scheduling. Archives and
source originals are read-only; raw vs outer IDs unchanged; continuation and
importer journals untouched except shared layout constants (same bytes).
Backups never partial, never delete user work; restore preserves the newer
store. No direct fallback for Hub-owned models (dispatcher unchanged). No
intent replay: refresh/recycle, policy re-evaluation and fork veto never
resubmit prompts. Maintenance fence, activity, PTY cleanup-unknown unchanged.
No ambient discovery, no owner `~/.pi` read under a profile, no whole-env
forwarding to MCP children.

## 5. Ports for other owners (exact)

**UI author:** call `POST /v1/capabilities/refresh` `{directory?: absolute}`
after a CONFIRMED shared-registry/skill/capability commit (response
`{reopened, pending}`; event `runtime.resources`); picker default from
`GET /v1/config/defaults` → `{model: ModelRef|null, code: string|null}`;
show `pendingRestart` from `GET /v1/migrations/pi-agent`; `permission.replied`
may carry `by: "policy"`; fork may answer 409 (extension veto);
`POST /migrations/pi-agent` may answer 501 `CONFIG_SOURCE_UNCONFIGURED`.
Frontend tests `test/browser-session.test.ts`, `test/access-directory-alias.test.ts`
import the dead OpenCode plugin (see delete manifest).

**Native/scripts author:** `runtime-lock.json dataSchema` is now 3 —
update `scripts/runtime/remote-fixture.mjs:66`, `install-remote.test.mjs:17,47`,
`install-remote-recovery.test.mjs:19` fixtures and the sdk-contract audit;
`LaunchConfig.userPiAgentDir` is optional (installer passes it, unchanged).
`shared/registry.mjs` and `shared/client.mjs` changed → embedded by
`capabilities.rs` (native fingerprint changes). Packaging must not define a
second session layout: `daemon-control.js` verify/restore implement
`SESSION_LAYOUT`. Guarding unsupported Node before `node:sqlite` in
`install-remote.mjs`/bootstrap scripts is outside this scope.

## 6. Review ledger (what was actually read)

Read fully or in the relevant sections, with fixes: `agent/src/platform/{paths,
update-snapshot,environment,launch-env}`, `core/runtime.ts` (config, settings,
capabilities, resources, recovery, activity, backup), `main.ts`,
`daemon-control.ts` (launch args), `legacy/pi-cli.ts`,
`legacy/continuation-import.ts`, `legacy/files.ts` (`directory`),
`mcp/pool.ts`, `sessions/registry.ts`, `sessions/worker.ts` (open/bind/
commands/select/compact/close), `server/routes.ts` (sessions, settings,
config, events, migrations), `models/config.ts`, `legacy/pi-agent.ts`
(settings planner), `interaction/broker.ts`, `extensions/enki.ts`,
`execution/dispatcher.ts` (submit/gates/readiness), `schedule/scheduler.ts`
(tick), `plugin-ui/scoped-resources.ts` (reload), `protocol.ts` (header),
`store/db.ts` (migrations), `build.mjs`, `package.json`, `runtime-lock.json`,
`tsconfig.json`, `vitest.config.ts`; `shared/{pi-extension.ts,client.mjs,
registry.mjs,registry.d.mts,proxy.mjs,stdio-command.mjs}`;
`browser/pi-extension.ts`, `browser/opencode-session-plugin.mjs`;
`pi/tool-gate.ts` (gate loop). Unchanged after reading: `platform/pty.ts`
(cleanup-unknown contract already present), `proxy.mjs`, `stdio-command.mjs`,
`scoped-resources.ts`, dispatcher, scheduler.

Tests read: `helpers.ts`, `run-node-suites.mjs`, `node-guard.mjs`, `setup/*`,
`runtime-lifecycle.node.ts` (1–160), `sdk-worker-ui.node.ts` (foundation),
`pi-cli-import`, `model-context`, `stop-cancel`, `schedules`, `access` (1–70),
`plugin-ui-routes` (stream helper), `commands` (lost ACK), `sse-budget`,
`protocol` (head), `config-vault.node.ts`/`config-credential-contract.node.ts`
/`config-authority-fake.ts` (relevant parts), the three legacy-qualified files
with diagnostics, root `test/pi-shared-tools.test.ts`.

**NOT reviewed in this pass (honest gap):** `agent/src/{admission,lifecycle,
daemon-maintenance}.ts`, `control/{broker (partial),channel}.ts`,
`execution/tools.ts`, `interaction/{access (evaluate only),access-paths,
grants,ui-bridge}.ts`, `legacy/{continuation,continue,opencode-import,
opencode-reader,pi-config-commit,pi-jsonl,projection,protocol,records,
wire-projection}.ts`, `migration/cutover.ts`, `models/{catalog,check,
credentials,hub (start/ensure only)}.ts`, `platform/{files,git}.ts`,
`plugin-ui/*` except scoped-resources, `policy/*`, `queue/queue.ts`,
`sdk/{adapter (parts),history,translate}.ts`, `server/{http,ui-routes}.ts`,
`sessions/catalog.ts`, `store/{attachments,commands,events}.ts`; `shared/`
image/web-search/project-map services and tests; all `browser/*.mjs` except
the two named; `pi/lsp-extension.ts`. Earlier qualified results for these
remain the only evidence; no whole-project review is claimed.

## 7. Remaining concrete limitations

* Nothing here was executed. The new guard (owned-listener registry, child
  injection, refusal = failure) is stricter than the qualified private guard
  in one respect (records/blocks expired own ports) and must be qualified on
  Mac and CI; a suite that legitimately talks to an unguarded child's port
  would now fail visibly rather than pass.
* `pi-backend` (b) "intentional close then late SDK events" still has no
  dedicated test (source: `close()` unsubscribes first).
* Config hot reload is deliberately NOT implemented: imports apply on restart
  (`pendingRestart`). Deferred Pi resources stay deferred.
* Fork now opens the source worker if it was closed (needed for the veto);
  this costs one worker open per fork of an idle-closed chat.
* Windows: directory fsync (`r+` handle), named-pipe IPC registry and empty
  `ENKI_PROFILE_DIR` propagation through CreateProcess are unqualified.
* macOS PTY: descendants of a closed shell remain cleanup-unknown (unchanged).
* Old 0.2 source-updater bootstrap, release-gate composition, CI baseline and
  native Hub key namespace are other owners' scopes and were not touched.
