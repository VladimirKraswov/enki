# Final whole-project review — native / scripts / services / docs scope (Opus 5.5)

2026-10-25. Source editing only (Read/Edit/Write/Glob/Grep). **No command, test,
typecheck, build, formatter, install, git, app, UI, network or owner file was
run or accessed. Every check below is NOT RUN.** No version bump, no publish,
no readiness claim. Scope per assignment: native Rust/Cargo/build-runner;
scripts (build/package/installer/release/CI/eval); services code/tests; root
package/config; maintained global docs. UI `src/`+`test/` and the
agent/shared/browser/pi resource trees belong to the other final authors; I read
them only for callers/contracts and did not edit them.

## 1. Concrete defects fixed

| # | Defect (evidence) | Fix | Regression test (NOT RUN) |
|---|---|---|---|
| F1 | P1 build-entry: official `@tauri-apps/cli` `bin:{tauri:"./tauri.js"}` vs npm-normalized lock `"tauri.js"` → `resolveTauriCli` throws, real `npm run tauri` cannot compile | `scripts/runtime/tauri-entry.mjs` `normalizedBin()`: npm-equivalent bin map (string bin → unscoped package name; `./`/duplicate separators equated). Name, locked version, entry set and every target must still agree; absolute, drive-relative, leading-separator, `..`, empty and non-string entries refuse; no-link package dir and regular contained target checks unchanged | `tauri-entry.test.mjs`: literal `./tauri.js` vs `tauri.js` (both directions), string-bin key, target/extra-entry mismatch, escaping lock, `/abs`, `\\x`, `C:x`, empty map; `normalizedBin` table. Existing version/escape/missing/link/actual-checkout cases unchanged |
| F2 | P1 schema: protocol `SCHEMA_VERSION=3`, real DB `user_version` 3, but `runtime-lock.json` `dataSchema:2` (written by `build.mjs` into authenticated `runtime-version.json`) → fail-closed `verifyBackup` refuses every real paired backup | `scripts/runtime/sdk-contract.mjs` audits `runtime-lock.dataSchema === protocol SCHEMA_VERSION` (single authority), the literal itself, and that `build.mjs` takes it from `runtimePin.dataSchema`; `remote-fixture.mjs` derives `CURRENT_SCHEMA` from protocol.ts (explicit `dataSchema` option for cross-schema fixtures); `sdk-upgrade.mjs` plan lists the field. `verifyBackup` untouched | `sdk-contract.test.mjs`: four single-drift cases (stale lock, bumped protocol, non-literal, build source). `runtime-db-composition.test.mjs`: real Database `user_version` equals fixture metadata; a stale-schema previous artifact pairs no backup, keeps serving, data untouched, candidate never launched |
| F3 | Native-quality fixture RED: under-lease test called `compare_and_set` directly, bypassing `Authority::call` entry, yet expected 3 admission checks | `config_commit_tests.rs` now calls `late.call("vault.compareAndSet", …)` with identical fields. Kept `CONFIG_GENERATION_REVOKED`, exactly 3 checks, byte-identical snapshot, no claim/receipt, previous-generation CAS. Production unchanged | the fixed test itself |
| F4 | CI Mac/Linux clippy: deprecated `AtomicU64::fetch_update` (`browser.rs`) | `next_selection_revision()`: explicit `compare_exchange_weak` loop, same `max(now)+1` semantics/orderings; works on old and current stable (no `try_update`, no `allow`) | `browser.rs` unit: monotonic, clock-backwards, stored==returned, 8×250 concurrent unique revisions |
| F5 | CI Windows Hub: 28 errors from `os.open(directory)` PermissionError in `releases.atomic` (same code in `model_catalog`) | New `services/hub/durable.py`: one crash-durable publication (private temp, fsync, replace). POSIX: `os.replace` + directory fsync (`O_DIRECTORY`); Windows: `MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)` — Windows' durable rename primitive; failures propagate, temp removed, previous file intact. `releases.py`/`model_catalog.py` use it (duplicate code removed). Deploy lists updated (`install-signer.sh` ownership, Hub README, HUB-UPDATES.md) | `services/hub/tests/test_durable.py`: platform selection, complete replace/no temp/0600, failed rename keeps old, Windows flags + error propagation with injected port (every OS), real POSIX dir-fsync-after-rename (POSIX), real MoveFileExW (Windows only) |
| F6 | Device source builder never capped Cargo parallelism (requirement `CARGO_BUILD_JOBS<=2`) | `hub_updates/build.rs`: every stage gets `CARGO_BUILD_JOBS` = 2 (an explicit `1` kept) | `device_builds_are_capped_at_two_jobs` |
| F7 | Builder withheld `ARVELA_HUB_ADMIN_TOKEN` but NOT the current `ENKI_HUB_ADMIN_TOKEN` that `operator.mjs` exports; the runtime child (and MCP/browser/tool children) inherited the GUI env with any publisher secret | One list `WITHHELD_ENV` (re-exported `hub_updates::PUBLISHER_SECRET_ENV`); `lib.rs run()` removes them from the GUI process env while still single-threaded (no native code reads them; CLI modes before `run()` unaffected); builder still removes them per command | `current_and_legacy_publisher_credentials_are_withheld` binds the list to the exact names in `operator.mjs` |
| F8 | Release gates: app crate `cargo test`/`clippy` ran without `--locked` (CI and runner gates use it) → a gate could re-resolve Cargo.lock | `operator.mjs`: both crates run fmt / `test --locked` / `clippy --locked`; order and credential-last unchanged | `operator.test.mjs` exact GATES updated; new assertion every compiling cargo gate is `--locked` |
| F9 | `node:sqlite` loaded before any host check for `npm run runtime:prepare` (device builder stage) and the remote installer → cryptic `ERR_UNKNOWN_BUILTIN_MODULE` on old Node | `scripts/runtime/host-node.mjs` (import-free guard, shared); `prepare-entry.mjs`, `install-remote-entry.mjs` check first then lazily load `main` of `prepare.mjs`/`install-remote.mjs` (now exported); `tauri-entry.mjs` uses the same guard (message unchanged); `runtime:prepare` script points to the entry | `host-node.test.mjs`: guard/entries have no sqlite-capable static import, package scripts routed, old host refused without loading, supported host runs main, modules export `main` |
| F10 | Evaluation runner defaulted to external `opencode,pi` CLIs (probed installed engines, bypassed the bundled core) | `runner.mjs`: new default adapter `pi-sdk` = exact pinned SDK package CLI from the reviewed agent lock, verified (name, `SDK_CONTRACT.sdk`, safe bin) and run with this Node; `opencode`/`pi` kept only as explicit historical baselines, never probed by default. Fixtures/oracles/limits/self-check unchanged. `eval:check` now also runs adapter tests; evaluations.yml pinned to the same action SHAs and exact Node (audited by `sdk:check`) | `scripts/evaluations/runner.test.mjs` (default, explicit baselines, launcher, SDK refusal table, identical event parsing); sdk-contract drift case for evaluations.yml |
| F11 | User-facing remote error pointed to non-existent `docs/PI-SDK-MIGRATION.md`; no maintained remote setup instructions existed | `hosts.rs` messages → new `docs/REMOTE-RUNTIME.md` (actual `ensure`/tunnel/health contract, operator install/update/rollback via the journaled installer, honest limitations) | — (doc + string) |
| F12 | `paths::app_data_parent()` under `ENKI_PROFILE_DIR` returned the profile's PARENT (outside the isolated profile); no current caller, latent escape | fails closed under a profile (`refuse_profile_parent`); default literals/paths unchanged | `an_explicit_profile_never_exposes_a_shared_parent` |

### Maintained documentation rewritten (historical reports untouched)

* `AGENTS.md`: mission/architecture now the sole bundled Enki Runtime (pinned
  Pi SDK; SDK = agent loop, Enki = UI/policy/transport/scheduling/state);
  OpenCode/Pi CLI histories read-only + explicit continuation; installed OS
  identity kept; external CLIs/services never touched; cleanup-unknown;
  `ENKI_PROFILE_DIR`; remote runtime; gate commands and `CARGO_BUILD_JOBS<=2`.
* `README.md`: architecture, install/identity, remote mode, legacy chats
  («Продолжить в Enki», verified in `TopBar.tsx`/`store.continueLegacySession`),
  dev/check commands incl. runtime deps and the first-update `npm run tauri`
  entry; banner that 0.2.x sections are history.
* `ROADMAP.md`: 2.0 status block (source done / acceptance open; NOT released).
* `docs/VERIFICATION.md`: maintained 2.0 gate table + uncovered areas on top;
  0.2.x log below kept as history.
* `docs/SDK-UPGRADE.md`, `docs/PLATFORMS.md`, `docs/DEVELOPMENT.md`,
  `docs/EVALUATIONS.md`, `docs/HUB-UPDATES.md`, `services/hub/README.md`,
  new `docs/REMOTE-RUNTIME.md`.

## 2. Written / changed tests — ALL NOT RUN

`scripts/runtime/tauri-entry.test.mjs` (+2 tests, helper param),
`scripts/runtime/sdk-contract.test.mjs` (+5 drift cases, evaluations.yml in copy),
`scripts/runtime/runtime-db-composition.test.mjs` (+1),
`scripts/runtime/host-node.test.mjs` (new, 4), `scripts/releases/operator.test.mjs`
(GATES + locked assertion), `scripts/evaluations/runner.test.mjs` (new, 4),
`services/hub/tests/test_durable.py` (new, 6; 1 POSIX-only, 1 Windows-only
real-primitive case — a platform split, each primitive runs on its OS),
Rust: `browser.rs` (+1), `hub_updates/build.rs` (+2), `paths.rs` (+1),
`runtime/config_commit_tests.rs` (call boundary fixed). No test deleted,
skipped or weakened; no assertion lowered.

Expected coordinator observations:

* `sdk-contract.test.mjs › the committed tree is synchronized` and every
  single-drift case (they assume a synchronized baseline) are **RED until the
  runtime author's pin `runtime-lock.json dataSchema: 3` lands** (agent tree,
  not mine). This is the deliberate guard for F2, not a regression. Same for
  `npm run sdk:check` (CI step) and `assertSdkContract` before preparation.
* `cargo fmt --check` may need the root's mechanical format of my Rust edits
  (written in rustfmt style; formatter not run).
* `installer` cases whose RED came from the hardcoded fixture schema should be
  GREEN with F2's fixture derivation; the real-artifact pairing additionally
  needs the runtime pin above.

## 3. Review ledger (what was actually read)

Read in full or at the relevant regions; "unchanged" means reviewed with no
defect found that is fixable in my scope.

| Area | Files | Result |
|---|---|---|
| First-update entry | `scripts/runtime/tauri-entry.mjs` (+test) | F1, F9; plan/argv/deadline/cancel/pipe semantics unchanged |
| Runtime preparation | `prepare.mjs` (header, run, prepareWithPort, CLI), `artifact.mjs` (imports, launcher, rollback) | F9 (`main` export). Unchanged otherwise |
| SDK contract/upgrade | `sdk-contract.mjs`, `sdk-upgrade.mjs` (+test) | F2, F10 audit, plan fields |
| Remote installer | `install-remote.mjs` (state, inspect, publish, verifyBackup, recovery call sites, CLI), `remote-fixture.mjs`, `install-remote*.test.mjs`, `runtime-db-composition.test.mjs` | F2, F9; fail-closed pairing unchanged |
| Bootstrap runner | `build-runner.mjs` (env, jobs cap, imports), `build-runner/Cargo.toml` | unchanged: jobs already ≤2 via `--jobs` + env |
| Native build job | `src-tauri/src/build_job.rs` (all non-test + framed helper test) | unchanged: Collector.capture already gone; bounded drain/outbox/settlement verified by reading |
| Native updates/builder | `hub_updates/build.rs` (all), `hub_updates/mod.rs` (head) | F6, F7 |
| Native fingerprint | `native_fingerprint.rs`, `build.rs`, `scripts/releases/packet.mjs` | unchanged: JS/Rust agree; nested build-runner Cargo files hashed raw in both, own version static `0.1.0` |
| Startup/identity/profile | `lib.rs` (run, setup), `entry.rs`, `main.rs`, `paths.rs`, `paths/profile_isolation_tests.rs`, keyring sites (`hub.rs`, `capabilities.rs`, `model_credentials.rs`, `runtime/vault.rs`) | F7, F12; namespaces fail closed, default literals intact |
| Runtime supervisor | `runtime.rs` (artifact locate/verify, data dir, command env, broker, ensure/ensure_locked) | F7 covers child env. Concurrent-connect coalescing = start mutex + `live()` recheck (static only, see §5) |
| Config/vault authority | `runtime/config_commit.rs` (call/open_as/with_admission/dispatch/serve), `config_commit_tests.rs` (region) | F3 |
| Browser | `browser.rs` (session/stop/selection, tests head) | F4; `"opencode"|"pi"` engine acceptance kept (UI sends `"pi"`; persisted legacy scopes) |
| Remote hosts | `hosts.rs` (ssh, probe, upload, workspaces, ensure parse, connect) | F11; strict-key/no-local-fallback unchanged |
| Legacy-name sweep | every `opencode` hit in `src-tauri/src` and `scripts/` | unchanged: legacy readers, compatibility identity, journal/Hub agent tokens; no execution path |
| Release | `operator.mjs` (+test), `packet.mjs` (+test), publish/device (fingerprint usage) | F8 |
| CI | `.github/workflows/desktop.yml`, `evaluations.yml` | F10 (pins); desktop.yml unchanged (already runs old-entry Windows build, runner, all suites) |
| Evaluations | `runner.mjs` (all), `pi-extension.ts`, `test/evaluations.test.ts` (imports/expectations) | F10 |
| Hub services | `releases.py` (atomic, validation), `model_catalog.py` (publish), `model_services.py` (config permission check), `deploy/install-signer.sh`, tests (imports, skips) | F5 |
| Root config | `package.json` | F9 script, F10 eval:check |
| Docs | see §1 docs list | rewritten |

## 4. Preserved invariants

* Strict CLI identity: package name, locked version, no-link package dir,
  contained regular target. Only the `./x` and `x` spellings are treated as equal.
* Old 0.2 builder argv for Mac/Windows/Linux reaches the real CLI byte-for-byte,
  with the runtime config inserted before Cargo `--`. Host check, deadline, cancel,
  primary-only signalling and `cleanup` reporting are unchanged.
* `verifyBackup` is still fail-closed (`user_version`, receipt, sha, quick_check,
  session snapshot). Fixtures follow the real schema, and cross-schema fixtures
  still have to say so explicitly.
* Config authority production logic is unchanged. The admission tests still
  check exactly 3 admission calls and that a refused call has no effect.
  LiveGenerationPermit and drain wiring were not touched.
* Browser selection revisions are still `max(now, previous) + 1` with the same
  memory orderings.
* Hub publication keeps file and rename durability on every platform. Nothing
  is skipped and no error is hidden.
* Installed identity `dev.local.opencodedesktop` and the default vault
  literals are unchanged. Profile namespaces are untouched. Nothing new touches
  the keychain or adds a TCC prompt.
* Credentials are requested only after every gate, and only the publisher
  receives them.
* Evaluation fixtures, independent oracles, budgets and the self-check are
  unchanged. Historical reports are unchanged, and the historical baselines can
  still be repeated explicitly.

## 5. Not reviewed or only partly reviewed in my scope (honest)

* Not read in this pass: `process.rs` (Unix group / Windows Job / Mac
  limits), `updates.rs`, `hub_updates/{install,packet,assets}.rs`, `migration.rs`
  body, `legacy.rs`, `journal.rs`, `control.rs`, `capabilities/*`, `computer.rs`,
  `images.rs`, `image_context.rs`, `lsp.rs`, `asr.rs`, `attachments.rs`,
  `runtime_ui.rs`, `runtime/{artifact,control,config_fs,vault}.rs` bodies,
  `browser/*` submodules, `tray*`, `workshop.rs`, `usage_store.rs`,
  `pricing.rs`, `sound.rs`, `storage_info.rs`, `build-runner/src/main.rs`. These
  were spot-checked by grep only (env handling, legacy names, keyring).
  Earlier qualified passes cover most of them; this review does not re-qualify them.
* Not read: `scripts/{check-architecture,check-bundle-budget,ci-artifacts,update-feed,artifact-policy}.mjs`,
  the PowerShell and Python helper scripts, `scripts/releases/{publish,device,verify}.mjs`
  apart from the fingerprint and env sites, services `images/`, `strata/`, `v100/`,
  `asr/` and `helper/`.
* Native concurrent-connect start-once (TEST-CUTOVER `local-server.test.ts`
  gap). This is only a static mapping: `RuntimeSupervisor::ensure` takes
  `lock_start_until`, and `ensure_locked` re-checks `live()` before spawning.
  There is no native test, because the supervisor is bound to
  `tauri::AppHandle`. Covering it would need a seam refactor; not done.
* Possible remaining Windows Hub CI item, not confirmed against logs:
  `model_services.py` rejects config and token files whose `st_mode & 0o077`
  is non-zero. On Windows `st_mode` does not express ACLs, so that check always
  fails closed there. The Hub is a Linux/systemd service, so this is not a
  product defect, but `test_model_services.py` may fail on the Windows runner.
  I did not change a security check without the actual log. Next step: read the
  fresh Windows CI log. If confirmed, either run the Hub server suite on POSIX
  only with an explicit coverage note, or add a Windows ACL port.

## 6. Cross-layer items for the other owners (exact paths, not edited by me)

* Runtime author: `src-tauri/resources/agent/runtime-lock.json`
  `"dataSchema": 2` → `3`. This is required for F2 GREEN and real paired
  rollback. The audit now fails until then.
* Runtime author: `agent/main.ts` falls back to the owner's `~/.pi/agent` when
  `--user-pi-agent-dir` is absent. Under a profile the native side omits that
  flag (`runtime.rs` `command`), so the fallback must be inert under an
  explicit profile. Also: the eager PiCli folder vs `snapshotSessions`; MCP
  profile env (`agent/src/mcp/pool.ts`, `browser/pi-extension.ts`,
  `shared/client.mjs`); `agent/test/node-guard.mjs` loopback/IPC allowlist; and
  `agent/package.json` `engines` `>=22.19.0` vs the pinned 24.22.1. Host
  tooling now refuses below 22.13 (`host-node.mjs`).
* Shared author: `shared/pi-extension.ts` late MCP tool registration after
  shutdown/abort.
* UI author: `src/components/HostDialogs.tsx` still shows the «Порт OpenCode» /
  `opencode serve` instructions. Point it at `docs/REMOTE-RUNTIME.md` and the
  `connect_remote_runtime` contract (strict-key SSH alias, `enki-runtime ensure`).
* Coordinator: apply rustfmt. Then run every gate in `docs/VERIFICATION.md`
  plus `npm run eval:check`, the Windows CI (Hub durable test, old-entry build),
  and the native actual-checkout CLI resolution test with the real installed
  package.

All checks NOT RUN. Nothing here is a release-readiness claim.

