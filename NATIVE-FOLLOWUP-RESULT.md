# NATIVE-FOLLOWUP-RESULT — native/package second correction pass (Opus 5.5)

**SOURCE ONLY / NOT VERIFIED.** File tools only (Read/Edit/Write/Glob/Grep) on the
borrowed host. Nothing was executed: no cargo/rustfmt/clippy, node, npm, vitest,
tsc, app, browser, git or Windows run. **Every check below is NOT RUN.** No version
bump (final Enki 2.0 / 2.0.0 after coordinator acceptance). Read and used:
`../sdk-reference/enki-tasks/TODO-FOR-OPUS-{native,packaging-current,lifecycle,sdk-upgrade}.md`,
`NATIVE-RESULT.md`, `SDK-RESULT.md`. The private RED fixtures/evidence under
`/Volumes/...` were not accessible; repros were re-authored from their descriptions.

## 1. Installer data path + paired DB/JSONL snapshot
- One SDK-free contract `DATA_LAYOUT` in `agent/src/platform/paths.ts` (runtimePaths
  derives from it); re-exported by the verified `daemon-control.js`. The installer
  reads it ONLY from that bundle (`liveLayout`, fail-closed shape check).
  `state.sqlite` remains the backup filename only.
- New `agent/src/platform/update-snapshot.ts`: `snapshotSessions` (exact copies of
  every `sessions/<sha16>/<name>` file + `sessions.json` manifest, fsynced; anything
  else fails closed), `verifySessionSnapshot` (manifest hash from receipt, exact
  entry set, sizes/hashes, no unlisted files), `restoreSessionSnapshot` (staged
  verified copies; live store moved aside, never deleted; rename back on failure).
- `core/runtime.ts backupForUpdate` adds `sessions` to `UpdateBackup` (same held
  fence + idle check, re-checked after the copy); directory fsync via shared
  `syncDirectory` (Windows: write-access handle `r+`).
- `install-remote.mjs`: `preserveLive`/`liveData` use the real layout (DB + WAL/SHM/
  journal + sessions); fresh-data check now covers runtime.sqlite and transcripts;
  first-install crash quarantines DB and sessions; `restoreBackup` restores DB AND
  JSONL into the same `failed-update-*` preservation dir. `exactBackup` accepts the
  `sessions` key (validated by the bundle) or DB-only legacy receipts.
- Cross-SDK: forward upgrade allowed only when the old runtime's receipt carries a
  session snapshot (else exact fence released, journal cleared, typed
  `ENKI_UPDATE_REFUSED`); explicit SDK/schema rollback needs
  `--restore-paired-data` and a sessions-bearing `previousBackup`. Typed refusals
  bypass the "journal retained" wrapper. SDK/Node acceptance via
  `sdk-contract.mjs qualified` (no hardcoded 0.85.1); `qualifiedRuntimes` option
  for reviewed sets (tests).
- Tests: `install-remote-recovery.test.mjs` on shared `remote-fixture.mjs` (control
  imports the ACTUAL paths.ts / store/db.ts / update-snapshot.ts); stale
  `build16`-vs-manifest expectations corrected only (daemon identity = info.version,
  return = manifest version). New `runtime-db-composition.test.mjs`: existing
  runtime.sqlite or transcript not fresh; first-install quarantine; candidate crash
  restores exact commands/events/queue/schedules rows + JSONL bytes, candidate table/
  files preserved aside; cross-SDK update + explicit paired rollback; DB-only
  receipt refuses SDK change; tampered snapshot refused, journal retained.

## 2. Windows first-update bootstrap runner
- New standalone crate `src-tauri/build-runner` (serde/serde_json/libc; `#[path]`
  to the exact `src/process.rs` + `src/build_job.rs`; own `[workspace]`; Cargo.lock
  entries copied verbatim from `src-tauri/Cargo.lock`, hand-written — first
  `cargo build --locked` may report a lock-format diff: regenerate offline and
  confirm identical versions/checksums).
- `scripts/runtime/build-runner.mjs`: `bootstrapRunner` compiles it from the
  authenticated source into fresh `mkdtemp` under `src-tauri/target/enki-build-runner/`
  using the REAL cargo/rustc from `rustc --print sysroot` (Windows cargo self-Jobs
  its compile tree), `--locked`, explicit toolchain-only env, bounded deadline/abort;
  receipt `{path, sha256, sources}` + provenance.json; sources re-hashed after build.
  `verifyRunner` re-checks bytes before every job. CLI `--out <dir>` for CI.
- `native-port.mjs`: no `ENKI_BUILD_JOB_RUNNER`/installed `enki.exe` trust; only a
  receipt; refuses `reaped !== true`. `prepare.mjs` bootstraps on win32 before any
  artifact recovery (also for `--verify/--rollback`), releases flush port and
  deletes the private dir afterwards. `hub_updates/build.rs` no longer injects
  `current_exe()`; old installed builders run the same path.
- CI: exact Node 24.22.1; runner crate fmt/clippy/test; bootstrap via the script;
  receipt → `ENKI_TEST_NATIVE_RUNNER(+_SHA256)`; live native-port/artifact/prepare.
- Tests: native-port.test.mjs rewritten (receipt trust, links, provenance digest,
  typed toolchain-missing with no leftovers, live settlement); prepare.test.mjs
  Windows cases use the receipt or skip with reason (+ Windows refusal test);
  artifact.test.mjs uses the verified receipt; stale `/unverified/` →
  `/Artifact does not verify: hash mismatch/`.

## 3. Native lifecycle / process ownership
- build_job.rs: bounded reader channel; streamed output via a bounded outbox +
  writer on a DUPLICATED stderr handle (never std's lock); full/closed outbox drops
  and counts; writer never joined (500 ms grace) → `streamComplete`,
  `streamDroppedBytes`. Result adds `scope`.
- process.rs: `OwnedTree::primary_exited` (Unix `waitid(WNOWAIT)`, primary stays
  unreaped so its PGID is pinned), `settle` (Unix: SIGKILL group while pinned, reap;
  Linux runner: `PR_SET_CHILD_SUBREAPER` + sweep of adopted orphans via
  `/proc/self/task/*/children`, own unreaped children only; Windows: TerminateJob +
  `QueryInformationJobObject` ActiveProcesses==0), `stop` (TERM grace). `reaped` =
  proven settlement; macOS scope `group` cannot see setsid escapees (documented).
  Removed `kill_tree`/`reap_descendants`. Hub build uses settle/stop (no unbounded
  `terminate_group` wait).
- runtime.rs: `OwnedChild` replaces StartingChild/Supervised child — every drop is
  bounded (`terminate_group_until`), unreaped child moved to `retained`, which blocks
  replacement starts and authoritative idle; `idle()` None also requires closed
  writers. Reader check+mutation+emit is one transition under `current_gate`
  (`publish_if_current`); new generation + "starting" published under the same lock.
  Ready carries an authoritative `activity` snapshot (main.ts) applied in stream
  order. Rotation: lost ACK reconciled with the SAME id+token (runtime stores by id,
  refuses other authority); never publishes unconfirmed bearer, never revokes/kills.
  Begin lost ACK: read-only `maintenance status` of the exact id (no begin resend);
  then confirmed `end`, else stop the exact child.
- main.ts/channel.ts: maintenance receipts serialized in arrival order (end cannot
  overtake a pending begin); end retires held begins (`MAINTENANCE_ENDED` on re-ask);
  `status` mode (unknown/pending/held/ended/failed/done).
- updates.rs: `release_maintenance` (3 exact `end` attempts → else
  `shutdown_checked` of the owned runtime); native gate released only on proof,
  otherwise intentionally kept closed (forgotten guard).
- Tests: build_job unread-stderr pipe repro (helper child of the test binary),
  Unix descendant marker repro, Windows Job descendant test; runtime.rs bounded
  OwnedChild drop + retained-blocks-idle, old-reader interleaving, release without
  runtime; agent `control-maintenance-status.test.ts`.

## 4. SDK upgrade workflow + narrow SDK fixes
- `scripts/runtime/sdk-contract.mjs` (canonical pins, reviewed descriptor hashes incl.
  resource loader, `qualified`), `auditSdkContract` (precise file/field drifts),
  called by prepare before building. `sdk-upgrade.mjs --check | --plan --target X.Y.Z
  | --prepare --target X.Y.Z --out <dir>` (literal target only; staging outside repo;
  registry metadata/integrity; `--ignore-scripts`; candidate hashes reported,
  never written). `build.mjs` reads the pin from runtime-lock (+overrides).
  `resourceLoaderSha256` moved into `SDK_UI_COMPAT_0851`.
- `test/run-node-suites.mjs` + `node-guard.mjs`: every `*.node.ts` (required list),
  pinned Node only, private HOME/agent dir, network guard pre-import.
  `npm run test:runtime` = Vitest + `test:sdk-compat`; `sdk:check`, `sdk:upgrade`.
- Docs: `docs/SDK-UPGRADE.md` (linked from README), `docs/PLATFORMS.md` runner section.
- scoped-resources.ts: `const prelude: Extension[]` (public SDK type). worker.ts:
  `fitTarget` runs on EVERY prompt (also unchanged model); `prompt_too_large` /
  `shorten_prompt` refusal when system+tools+new prompt exceed the budget, before
  any summary/target call; same-model progress only when not fitting. Regression in
  `test/integration/model-context.test.ts` (20,506-token prompt on small, auto-
  compaction off: rejected, zero provider calls, follow-up still runs).

## Remaining exact caller ports / risks (not done)
1. Frontend: project `prompt_too_large` + `shorten_prompt` recovery.
2. `daemon-maintenance.ts` (remote HTTP fence) not reviewed for the same begin/end
   serialization; native/stdin path only was changed.
3. Confirm Pi SDK 0.85.1 session filenames match `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`
   under `sessions/<sha16>/` only; otherwise snapshot (and update) refuses.
4. libc `waitid`/`siginfo_t.si_signo`/`P_PID`/`WNOWAIT` on macOS, Windows
   `AsHandle` stderr dup, `QueryInformationJobObject` layout: compile + live proof.
5. Windows live (CI/Mac coordinator, never Igor): Job settlement, NTFS flush,
   `r+` directory fsync in backupForUpdate, bootstrap with MSVC, node-gyp, full
   `build:windows`, old-0.2.x Hub builder fixture.
6. `test:runtime` now fails on a non-pinned Node by design.
7. `cargo fmt` not applied (Mac runs rustfmt). README still describes two engines
   (docs owner).

## Checks: ALL NOT RUN
cargo fmt/check/clippy/test (src-tauri and build-runner, all targets, Windows GNU/MSVC)
· node --test scripts/runtime · agent typecheck/vitest/test:node · sdk:check · CI ·
Windows/macOS/Linux live runner, flush, install/rollback rehearsal.
