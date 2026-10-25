# BUILD-ENTRY-RESULT — first 0.2→2.0 source update, bootstrap settlement, release gates

Source-only pass on a borrowed host. **Every check below is NOT RUN.** Nothing was
executed: no tests, builds, typecheck, npm, cargo, git, app or browser. This is not
the user-required final whole-code review, which happens after integration and
before the final 2.0 build. No version bump.

## Changed files (scope respected)

- New: `scripts/runtime/tauri-entry.mjs`, `scripts/runtime/tauri-entry.test.mjs`, `scripts/runtime/build-runner.test.mjs`
- Edited: `scripts/runtime/prepare.mjs` (reuse receipt), `scripts/runtime/build-runner.mjs` (settlement, job cap)
- `package.json`: only `scripts.tauri` → `node scripts/runtime/tauri-entry.mjs`. `test:runtime-artifact` (it already
  carries the concurrent author's `--experimental-transform-types`) and `build:*` are unchanged.
- `scripts/releases/operator.mjs` + `operator.test.mjs`, `.github/workflows/desktop.yml`, `docs/PLATFORMS.md`
- Not touched: native Rust/runtime/SDK/UI/legacy/credential source, pins, `run-node-suites.mjs`, existing tests.

## 1. Old builder → new source: portable `npm run tauri` entry (P1)

The old 0.2.115 builder runs `npm ci`, then `npm run tauri -- build … --ci -- --locked`. That now runs the entry:

- `planTauriInvocation(argv,{platform,arch})` is pure. The subcommand is the first non-option token.
  `build`/`bundle` (without `-h/--help/-V/--version`) get `--config src-tauri/tauri.runtime.conf.json`
  inserted immediately before the FIRST `--`, or appended when there is none. All original arguments keep
  their bytes and order, including Mac signing JSON and multiple configs. Nothing is inserted when the exact
  overlay is already passed (the current native builder's vector).
- `runTauriInvocation(plan,opts)`, for prepared commands:
  1. `hostNodeProblem(process.version)` runs before `import('./prepare.mjs')`, because `artifact.mjs` imports
     `node:sqlite`. Supported hosts are ≥22.13, ≥23.4 and 24+ (unflagged `node:sqlite`); only 24.22.1 is
     qualified. Older hosts get typed `ENKI_HOST_NODE_UNSUPPORTED` and no app. The entry's static imports are
     builtins only and its syntax is ES2020, so the diagnostic is reachable on old hosts.
  2. Verified reuse: `preparedRuntimeProblems()` (new, `prepare.mjs`) needs `target/enki-agent/preparation-receipt.json`.
     `prepare()` writes it after promotion, bound to the promoted manifest SHA256 and to an input digest
     (`preparationDigest`: the staged resource trees with copyTree SKIP semantics, `prepare.mjs`, `artifact.mjs`,
     the runtime entitlements, platform/remote/signing identity, computed BEFORE staging). It also needs a
     fresh digest match and a full `verifyArtifact(current,{manifestSha256})`. There is no environment boolean.
     Otherwise `prepare({platform,repo,signal,signingIdentity})` runs under a deadline (45 min) and cancellation.
  3. The same verification runs again. Failure gives `ENKI_RUNTIME_UNVERIFIED` and no spawn.
- The CLI comes from `resolveTauriCli()`: the root `node_modules/@tauri-apps/cli` real directory (links refused).
  Its `package.json` name, version and `bin` must equal the root `package-lock.json` entry. The `bin` must be a
  regular file inside the package (`tauri.js`, not `main`). Never PATH, `.bin`, an installed Enki or a recursive
  npm script.
- Spawn: `process.execPath tauri.js …args`, `shell:false`, explicit `cwd` (repository) and an explicit env copy.
  Stdio is inherited and the CLI stays in the caller's process group/Job, so the old builder's owned-tree kill
  still covers cargo/rustc.
- Deadline (120 min) or cancel sends SIGTERM to the primary, then SIGKILL after grace. Node never signals a
  reaped child. Errors are typed with `cleanup: 'primary-exited' | 'unknown'`; settlement of descendants is
  never claimed. CLI exit codes: Tauri's own code, 1 on refusal/failure, 130 on cancel. SIGINT/SIGTERM/SIGHUP
  abort the run.
- Pass-through, with no preparation, download or `prepare.mjs` import: help/version/`dev`/`info`/`icon`/`signer`/`help`/empty.
- `build:<platform>` keeps its explicit prepare + `tauri build` (the `.bin` shim, not this entry). Direct
  `cargo check/test` and `npm run build` are unaffected: `tauri.conf.json` is unchanged.
- Runtime binaries are signed with `ENKI_CODESIGN_IDENTITY || '-'`, the same as `runtime:prepare`; the identity
  is not parsed from Tauri `--config`.

## 2. Bootstrap `bounded()` settlement (source-confirmed gap)

- After the primary `exit`, `close` gets `drainMs` (10 s, configurable). If pipes are still held, or a
  deadline/cancel arrives after exit, our pipe ends are released and the result is a typed
  `ENKI_BUILD_CLEANUP_UNKNOWN` failure, never success. After exit the saved PGID is never signalled.
- Before exit, the existing group SIGKILL applies (Windows: cargo's Job). The error reports `cleanup:'signalled-group'`.
- `bootstrapRunner` publishes no receipt/provenance on any failure. On cleanup-unknown it **keeps** the private
  root and reports it (`error.retained`) instead of deleting a possibly still-written tree. Settled failures are
  removed as before.

## 3. `CARGO_BUILD_JOBS` ≤ 2 for bootstrap

`bootstrapJobs(source)`: unset/empty → 2; a positive integer → min(n, 2); anything else is refused explicitly.
It is passed both as `cargo build --jobs N` (outranks Cargo config files) and as env `CARGO_BUILD_JOBS=N`.
The TOOLCHAIN_ENV whitelist is otherwise unchanged: HOME is not repurposed and no provider/signing/Hub
credentials are forwarded. Trust and receipts are unchanged: exact 5-source digest, binary SHA, no discovery.

## 4. Canonical `release:local` gates (before any credential request)

Added after the existing frontend gates and before Python/native, with exact order fixed by tests:

- `npm run sdk:check`
- `npm ci --prefix src-tauri/resources/agent --ignore-scripts`
- `npm rebuild --prefix src-tauri/resources/agent node-pty`
- `npm --prefix src-tauri/resources/agent run typecheck`
- `npm run test:runtime` (Vitest + real-SDK/legacy Node suites)
- `npm run test:runtime-artifact` (artifact/installer/sdk-contract/entry/bootstrap)
- after the main crate: standalone runner `cargo fmt --check`, `test --locked`, `clippy --locked --all-targets -D warnings`

Existing gates, the device mode and "secrets only at the publisher" are preserved. No gate is skippable.

## CI

The Windows job now builds with the exact old vector, `npm run tauri -- build --bundles nsis --ci -- --locked`,
under bash so both `--` survive. A follow-up step checks that `src-tauri/target/release/agent-runtime` verifies
with the same manifest SHA256 as `target/enki-agent/current`. Mac/Linux keep `build:<platform>`.

## Tests written (all NOT RUN)

- `tauri-entry.test.mjs`:
  - all 5 saved old vectors (Mac, Windows, Linux appimage/deb/rpm): overlay before `--`, originals intact,
    signing JSON kept
  - no duplicate overlay for the current-builder vector; only the first `--` counts
  - pass-through list
  - host-version matrix
  - `main()` per vector: prepare before CLI; CLI argv/cwd exact
  - verified reuse with no second prepare; exit-code propagation
  - prepare failure, hollow prepare and unsupported host → no compile
  - pass-through never touches the port
  - cancel/deadline during prepare; cancel/deadline against a SIGTERM-ignoring CLI (bounded)
  - spawn shape (`shell:false`, execPath, package bin, env/cwd)
  - CLI resolution: missing, lock mismatch, escaping bin, missing bin, linked dir; real checkout `tauri.js`,
    not executed and skipped without `npm ci`
  - package.json wiring
  - real `preparedRuntimeProblems` over a fixture repo: unchanged, unstaged change, platform, identity, remote,
    source edit, code edit, tamper, regenerated manifest, missing receipt
  - tampered runtime re-prepared before compile, and refused when not repaired
- `build-runner.test.mjs`:
  - primary exit + pipe-holding descendant → cleanup-unknown within the drain bound
  - deadline/cancel after exit settle (the reported hang)
  - normal trailing output still succeeds
  - pre-exit deadline kills the group (POSIX)
  - jobs cap matrix
  - POSIX fixture toolchain through the real `bootstrapRunner`: `--jobs 2`/`1`, env cap, HOME kept, credentials
    absent, settled failure removed; unsettled compile keeps its dir with no provenance
  - descendants end themselves; markers prove they were never signalled.
- `operator.test.mjs`: exact gate order (operator + device), credentials requested only after the last gate,
  and each of the 9 new gates failing → no credentials, no publisher. Existing tests unchanged.

## Exact prerequisites for qualification (coordinator, not Igor)

- Node 24.22.1, root `npm ci`. For the release gates: registry access and `src-tauri/resources/agent` deps (the
  gate installs them). Rust stable. Windows: MSVC; on PATH for runner bootstrap.
- Run: `npm run test:runtime-artifact`, `npm run test:releases` and `npx vitest run test/bundle-config.test.ts`.
  The native-port live cases need `ENKI_TEST_NATIVE_RUNNER(+_SHA256)` from `node scripts/runtime/build-runner.mjs --out <dir>`.
- Real Mac old-entry build from a clean prepared source copy:
  `npm ci && npm run tauri -- build --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}' --ci -- --locked`,
  then `python3 scripts/verify-macos.py <app>`. Repeat it to observe verified reuse.
- Windows CI run of the old-entry job.

## Honest limitations

- Nothing was syntax-checked or run. The CI step assumes Tauri copies resources to `target/release/agent-runtime`
  during the build. If it doesn't, that step fails and must be pointed at the bundled location
  (`verify-windows.ps1` is out of scope).
- The old host's Node version is unknown. Below 22.13 the first update fails explicitly (no runtime-less
  installer) and needs a Node upgrade. darwin-x64 and win32-arm64 have no runtime pin, so `prepare` refuses them.
- The old builder's 40-min "compiling" limit now covers preparation + compile. A slow host can hit it; that fails
  closed, and the old executable cannot be changed.
- In-process cancel stops only the Tauri primary. Descendant cleanup relies on the caller's group/Job.
- Preparation needs network (Node, rg/fd, npm). The release `npm ci` replaces local agent `node_modules`.
  `release:local` does not bootstrap a live runner, so those native-port cases skip with an explicit reason;
  the standalone runner cargo gates still run.
- Bootstrap: a negative/invalid `CARGO_BUILD_JOBS` is now refused. Windows pipe-holder settlement still relies on
  cargo's Job (no Windows run).
- Still open elsewhere: `run-node-suites` transform flag (concurrent author), paired `backupForUpdate`, and the
  final whole-code review.
