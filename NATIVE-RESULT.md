# NATIVE-RESULT — native/packaging/lifecycle pass (Enki 2.0 migration)

**SOURCE ONLY / NOT VERIFIED.** Authored by Claude Opus 5.5 with file tools only
(Read/Edit/Write/Glob/Grep). Nothing was executed: no build, typecheck, lint,
format, cargo, node, npm, test, app, browser or git. **Every check below is NOT RUN.**
No version bump (release will be Enki 2.0 / 2.0.0 after Mac review).

Input limitation: `../TODO-FOR-OPUS-packaging.md` and `../TODO-FOR-OPUS-lifecycle.md`
are outside the tool-confined directories and could not be read. Work followed
REMOTE task text plus the current code/tests. The coordinator must diff this
pass against the frozen hashes / RED reproductions in those TODOs.

## 1. POSIX / cmd wrapper metacharacters (scripts/runtime/prepare.mjs)
- `safeRelative` allows `$ \` ' % ! & ^ ; ( )`. Old POSIX wrapper put paths inside
  `"$base/…"` (command substitution possible); `.cmd` neither doubled `%` nor
  disabled delayed expansion.
- New exported `posixWrapper`/`windowsWrapper`: `"$base"'<literal suffix>'` with
  `'\''` escaping; `.cmd` uses `SETLOCAL EnableExtensions DisableDelayedExpansion`,
  `%`→`%%`, always-quoted paths; ancestor must be `.`/`../..`; wrappers are built
  before the link is unlinked (fail closed, link intact).
- Tests (prepare.test.mjs): live hostile-path wrapper execution (no `PWNED_*`
  files, POSIX only), exact POSIX text, exact `.cmd` lines + unsafe-path refusals.

## 2. Windows runtime: native runner + durable FS port
- `src-tauri/src/build_job.rs` (`enki --enki-build-job`, dispatched first in
  `entry.rs`, before Tauri/migration/vault). One JSON request ≤1 MiB on stdin,
  one JSON line on stdout. `run`: absolute normalized program/cwd, explicit env
  (`env_clear`), NUL/`=` checks, timeout 1 ms–4 h, output bound ≤16 MiB; result
  `exited|timeout|output-limit|lost` + code. Captured output bounded; streamed
  output goes to runner stderr. argv/env never logged. `flush-directories`:
  exact link-free canonical paths, `FlushFileBuffers` on a write-access
  directory handle (`FILE_FLAG_BACKUP_SEMANTICS|OPEN_REPARSE_POINT`), reparse
  attribute rejected; unsupported FS fails closed.
- `process.rs`: `spawn_in_job` = `CREATE_SUSPENDED|CREATE_NO_WINDOW` → fresh
  `KILL_ON_JOB_CLOSE|DIE_ON_UNHANDLED_EXCEPTION` Job (no breakaway) →
  `AssignProcessToJobObject` must succeed → resume the single primary thread via
  documented Toolhelp32 snapshot + `OpenThread` + `GetProcessIdOfThread` check +
  `ResumeThread` (previous count must be 1). Failure: `TerminateProcess` on the
  owned handle + `TerminateJobObject` + reap. Stable Rust + documented kernel32
  only. `OwnedTree` (Job on Windows / process group on Unix) with `kill_tree`
  and `reap_descendants`. Runner death closes its non-inheritable Job handle.
- Wired: `prepare.mjs run()` on win32 → runner (no fallback); `artifact.mjs`
  `setDirectoryFlushPort` + batched native flush, Windows file fsync via
  `O_RDWR` handles; unset port = existing `ENKI_ARTIFACT_DIRECTORY_SYNC_UNSUPPORTED`.
  Promotion stays journaled directory renames (no symlink pointer on Windows).
- Trust: `native-port.mjs trustedRunner` reads only `ENKI_BUILD_JOB_RUNNER`
  (absolute, normalized, regular file, no links, `enki.exe` on Windows, NOT inside
  the source tree being built). No discovery, no hash-from-candidate. Hub
  update-source build passes `current_exe()` (installed running Enki) on Windows
  and strips any inherited value elsewhere. Windows system location vars
  (ProgramFiles, ProgramData, …) are passed for node-gyp; HOME/USERPROFILE kept.
- `hub_updates/build.rs` and the runtime supervisor now use the suspended Job
  spawn instead of attach-after-spawn.
- CI (`desktop.yml`): builds `--bin enki` from the reviewed checkout, copies it
  to `RUNNER_TEMP`, exports `ENKI_BUILD_JOB_RUNNER`, runs live native-port and
  artifact promotion tests with `ENKI_TEST_NATIVE_RUNNER`. Docs: PLATFORMS.md.
- Tests: build_job.rs (request refusal, exact env, deadline with pipe-holding
  descendant, output bound, flush exactness), process.rs Windows test (resume
  proof by exit code 7; descendant `IsProcessInJob` for the owned Job; terminate),
  native-port.test.mjs (trust boundary; opt-in live protocol), artifact.test.mjs
  promotion tests bind the Windows port or skip with an explicit reason.

## 3. Remote installer authority/recovery (scripts/runtime/install-remote.mjs)
- Control module imported only from the publisher-owned `dist/<version>` copy,
  re-verified immediately before import (never the caller's candidate path);
  rollback imports from journal target / current published version.
- Lost begin ACK: recovery GETs `/_enki/runtime/maintenance/<journal.id>`;
  `pending` retains; held receipt is verified and released; 404/failed/no live
  daemon (lifetime lease proves stopped) cancels the journal. Never re-POSTs.
- First install: journal records `freshData`; a crashed fenced candidate's DB/WAL
  is moved to `failed-first-install-*` (never deleted) under the lifetime lease.
- Committed but dead candidate: started under the held start lease with its
  initial fence, then the fence is released.
- Paired backup: exact typed `UpdateBackup` key set, field-by-field comparison
  (not serialization order), copy hash-verified and fsynced before the live
  DB/WAL/SHM/journal are moved aside. Restore only in `candidate` phase and only
  after the lifetime lease proves every daemon stopped; schema-rollback restore
  now runs after the durable `candidate` phase so recovery can undo it.
- `install-remote.sh` obsolete → `MIGRATION_DELETE_PATHS_NATIVE.json` (Mac
  applies the removal). References updated in hosts.rs and the checkpoint doc.
- Tests: install-remote-recovery.test.mjs (import location, lost ACK no replay,
  first-install crash, committed-dead startup, exact vs reordered receipts).

## 4. daemon-control ensure early exit (agent/src/daemon-control.ts)
- RED fixed: own child `exit` before readiness now throws typed
  `DaemonStartupError` (`code ENKI_DAEMON_STARTUP_EXITED`, `exitCode`, `signal`,
  bounded child IPC reason) promptly; settles exit/IPC ordering ≤1 s; only the
  own child handle is touched; no PID from JSON. Timeout path unchanged/honest.
- Test appended to test/runtime-lifecycle.node.ts.

## 5. Native lifecycle (src-tauri/src/runtime.rs)
- Typed `AckError {NotSent, Refused, Uncertain}`; `transact_id` binds an id.
- Uncertain native begin: re-ask with the SAME requestId (runtime dedupes,
  returns stored outcome, incl. its backup) → else confirmed `end` → else revoke
  and stop/reap this exact owned child. Never stranded, never re-executed.
- `ensure`/`restart`/`shutdown` share the start-lock barrier: `restart` holds it
  across fence/backup/drain/reap/start and aborts if any other stop was
  requested meanwhile (`stop_requests` counter). `exiting` latch (quit,
  `retire()` after installer handoff) is never cleared by `end_maintenance`.
- Rotation unchanged in substance: bearer replaced only after exact ACK.
- Tests: three latch tests in runtime.rs.

## 6. runtime_ui / ENKI_PROFILE_DIR
Not modified. Remote relay remains `hub.identity|hub.request` + runtime_ui scoped
methods; no vault/files/exec relay added. No OS permission changes.

## Remaining exact caller/API work (not done here; out of scope or unverified)
1. Frontend/routes pass: `/runtime/drain` self-reservation caller (assigned).
2. Native daemon composition: `install-remote.mjs` against the real built
   `dist/daemon-control.js` + a live daemon on Linux (fixture test uses the
   documented contract only). Confirm health `maintenance` carries `backup`.
3. Confirm runtime stdin ACKs carry `generation` (native checks it on every ACK).
4. Windows live: runner suspended spawn/resume, Job descendant ownership, NTFS
   directory flush with write access, `npm rebuild node-pty` via node-gyp under
   the explicit env, `tar.exe` zip extraction, full `build:windows`. Existing
   prepare.test.mjs wrapper/deadline tests call `run()` without a runner and
   still reject on win32 (unchanged from before).
5. `cargo fmt` (hand-formatted toward rustfmt defaults, best effort) and clippy
   `-D warnings` on all three OSes (Windows FFI code unseen by any compiler); no
   Cargo.lock change needed (no new crates). New/changed Rust changes the native
   fingerprint (native update required, as expected).
6. Runtime-side semantics to confirm (agent `main.ts`, not edited): a native
   `end` that arrives while a deduplicated `begin` is still inside
   `backupForUpdate` ends the fence before begin returns ok. Native treats that
   path as "not started"; the runtime could reject `end` while a begin is pending.
7. Unix runner death does not kill its process group (Windows Job does); Unix
   preparation keeps using the in-process group runner.

## Checks: ALL NOT RUN
cargo fmt/check/clippy/test · node --test scripts/runtime · agent typecheck/
vitest/node tests · frontend · CI · native bundle · Hub verification.
