# Runtime fixture migration — result (source only)

**All checks NOT RUN.** Nothing was executed on Igor: no Vitest, Node, typecheck, build, install, git, app, browser or provider/model request. Every expectation below is a prediction for the Mac run, not a result. No version bump. Pins, dependencies, lockfiles and production runtime/SDK/adapter/worker/access/ledger/lock/Hub/importer source are unchanged.

Inputs: `TODO-FOR-OPUS-runtime-vitest-baseline.md`, `TODO-FOR-OPUS-runtime-fixtures-only.md`, `TODO-FOR-OPUS-native-followup-qualification.md`, read-only `private-vite-setup.ts`. Baseline: 24 files / 121 tests, 102 PASS / 19 FAIL / 0 skipped.

## 1. Public Vitest bootstrap (new)

| File | Change |
| --- | --- |
| `src-tauri/resources/agent/vitest.config.ts` | Adds `globalSetup: test/setup/sdk-profile.global.ts` and `setupFiles: test/setup/sdk-environment.ts`. Timeouts, pool and worker count are unchanged. |
| `test/setup/sdk-profile.global.ts` (new) | Runs once in the main process. By default it generates an owned profile at `<realpath(os.tmpdir())>/enki-vitest-sdk-XXXX/profile` containing `bin/rg` and `bin/fd` (`.exe` on Windows), then makes the files, `bin/` and `profile/` read-only (0o555). Teardown restores write permission and removes the whole root. Alternatively, an explicit `ENKI_TEST_SDK_PROFILE` (for example a prepared app `sdk-profile`) is checked: it must be absolute and physical with no symlinks, must not be the owner's `~/.pi`, must have regular rg/fd files and no `.no-ambient-adc`. An explicit profile is never modified or deleted. The setup also records the original HOME, USERPROFILE, PI_* and ADC values for coverage. It never touches HOME or USERPROFILE. CI does not need runtime:prepare. |
| `test/setup/sdk-environment.ts` (new) | Runs inside each worker's Vite module graph before the test file's imports. It calls the **production** `installSdkEnvironment(inject("enkiSdkProfile"))`, the same call `main.ts` makes, and fails if `sdkProfileDirectory()` does not match. It imports no SDK value module. This closes the gap where a native-ESM install and the Vite-transformed environment module were separate instances. |
| rg/fd placeholders | Each one is exactly `#!/bin/sh`, then a stderr diagnostic carrying the `enki-vitest-sdk-profile-placeholder` marker, then `exit 97`. The suite declares no search scenario, so any execution fails explicitly. They never pretend to be qualified search binaries; that qualification belongs to the separate exact-binary suite. On Windows the text `.exe` is not a PE image, so process creation itself fails. |
| `test/sdk-environment.test.ts` (new, 5 tests) | Checks: the profile is physical, installed in this graph and seen by the native SDK (`getAgentDir()`), and is not the owner's `~/.pi`. Checks `PI_OFFLINE=1` and that the ADC path points at the missing `.no-ambient-adc`. Checks HOME/USERPROFILE are unchanged and that `projectToolEnvironment` restores the original PI/ADC values. Checks that switching profiles is refused without changing state. For a generated profile, checks exact placeholder content, no write bits, the `["bin"]` layout and the temp root location. |

## 2. Test-command flags (only)

- Root `package.json` `test:runtime-artifact` is now `node --experimental-transform-types --test scripts/runtime/*.test.mjs`.
- `src-tauri/resources/agent/test/run-node-suites.mjs` child argv now starts with `--experimental-transform-types` before `--import guard --test …`.

## 3. The 11 fixture/contract cases

1. **`protocol.test.ts` observed grant.** Grants are built from the asked verdict's real `identity`, stored with `storedGrant` and read back with `readGrant`; `exactIdentity` is asserted. Exact matches allow. A different input (`ls -la`, extra `timeout`), a different tool, a different file target or a different file tool all stay `ask`. Raw legacy rows (`bash/ls`, `bash/*`) do not authorize, `readGrant` rejects untyped or malformed rows, and `storedGrant` refuses a non-hash identity. Authored `git *` glob behaviour stays allow/ask as before. No permissive raw grant was reintroduced.
2. **`protocol.test.ts` configure.** Uses the authentic DTO (43-char `generation`, UUIDv4 `requestId`) and `toEqual` round-trips, including `initialMaintenance`. Malformed input is rejected: bad token, bad origin scope, non-boolean maintenance, missing or short or invalid-char generation, missing or non-UUID or wrong-version requestId, array payload, invalid JSON. Newline-only framing is unchanged.
3. **`access.test.ts` read mode.** The old phrase match is replaced with structured tool results. The results come in order `call-write`, `call-read`. The write result is `isError: true` with non-empty text that does not contain the secret, and `x.txt` is absent. The read result is `isError: false` and contains the fixture text. There are no pending permissions and the scripted queue is fully consumed. The access preset is unchanged. The exact Russian copy is left as a separate UI requirement.
4. **`crash-recovery.test.ts` tool crash.** The first Runtime now runs in a **real child** (`test/integration/fixtures/crash-child.ts`), started as `process.execPath --experimental-transform-types --import test/node-guard.mjs`.
   - The child refuses unless it is in a declared scenario with a data dir under the real temp dir, and it installs the same profile before SDK imports.
   - It has a 60 s self-deadline and exits when the parent's stdin pipe closes.
   - While the child is alive, a second in-process `harness()` is asserted to reject with `already owns`, because the SQLite EXCLUSIVE lease is held.
   - The child is then SIGKILLed and joined within 10 s, with `signal === "SIGKILL"` asserted.
   - The recovering runtime registers a counting `deploy` tool, so a replay would be counted. Recovery assertions: receipt `uncertain` with the original error regex, exactly one `call_deploy` part with error status and `INTERRUPTED_TOOL_TEXT`, no interrupted rows, 0 executions, 0 provider calls. The next turn sees exactly one paired error `toolResult`. A restart is idempotent: still `uncertain`, one part, no new executions or provider calls.
   - Teardown kills and joins every child, then always stops the harness.
5. **`crash-recovery.test.ts` accepted-but-undispatched crash.** Same child mechanism. The child reports `accepted` and 0 calls. The second writer is refused while it lives. After SIGKILL the receipt is `cancelled` and there are 0 provider calls. No lock is unlinked or force-released.
6. **`model-context.test.ts`.** `longChat` uses per-chat IDs (`long-<n>-<sid>`) and asserts 202, `{id, sessionID}`, not duplicate, a completed receipt for that session, and `[user, assistant, user, assistant]` history before returning. All transition assertions are unchanged.
7. **`model-transition.test.ts` success.** Six deterministic source responses are provisioned and every call's model is recorded. Asserted: no error, completed, at least one call, all calls by the large model, fewer calls than provisioned, and pending count consistent with calls. Unchanged: target selected, summary visible, two user messages.
8. **`model-transition.test.ts` no-fit.** Same provisioning with an oversized summary. Asserted: `failed` with the original fit regex and not "faux responses", all calls by the large model, original model retained, two user messages.
9. **`extension-ui.test.ts` dialogs and UI.** The test awaits the specific `extension.notify` event, asserts sessionID and level, and checks it is unique. Replay with `after=seq-1` delivers the identical event exactly once. The obsolete `setFooter` unsupported and `extension.widget` event expectations are replaced with positive checks on the live worker's surface state: `statuses {phase:"asking"}` and the text widget `plan` above the editor. A real footer factory runs once with live footer data that sees the status. There is no `extension.unsupported` event, `/extensions` does not list `setFooter`, and there are no extension errors. Dialog answers and scope authority are unchanged.
10. **`questions.test.ts`.** The test awaits the specific `question.replied` event (sessionID, requestID, answers) and checks it is unique; replay from `seq-1` delivers it exactly once. Unchanged: no permission prompt, pending count, honest idle, invalid answer 400, duplicate reply 404.
11. **`extension-ui.test.ts` deadline (afterEach cascade).** Shared fix in `test/helpers.ts`:
    - Every `stream()` client is registered per harness.
    - `stop()` is idempotent. It closes owned SSE clients, calls `closeAllConnections()` **before** awaiting `server.close()`, and **always** runs `runtime.shutdown()` in `finally`.
    - If `startServer` fails, the already-created runtime is shut down.
    - `afterEach` in extension-ui, questions and crash-recovery clears `h` before stopping, so no test inherits a stale harness.
    - The deadline test's own DB now closes in `finally`. Its assertions and deadline are unchanged.

No test or hook timeouts were raised. Nothing was skipped. No teardown error is swallowed.

## 4. Untouched remaining failures (expected to stay RED)

- **Genuine Hub routing RED (4), assertions unchanged:** `integration/cancel-and-hub.test.ts:45,63` and `integration/model-context-hub.test.ts:70,86`. These belong to Legacy Opus's production fix. No route priming, `hubRoute:true` or mocked refresh was added.
- **Legacy/Pi owned (4):** `legacy-import.test.ts:52,86,123` and `pi-cli-import.test.ts:29`. No `importPiCli` shim, no raw archive IDs, no provenance change.

Predicted totals for the Mac run (NOT RUN): 25 files, 126 tests. If every fixture port is right, that is 118 PASS and 8 FAIL (the 4 Hub + 4 Legacy above), with zero skipped.

## 5. Risks for the Mac executor to check first

- **The private guard must allow exactly one owned subprocess:** `process.execPath` with `--experimental-transform-types --import test/node-guard.mjs test/integration/fixtures/crash-child.ts`, run from the agent dir. Its only network is loopback to its own server; `node-guard.mjs` refuses everything else.
- **The read-only generated profile.** The adapter pins auth, models and models-store paths to its explicit `agentDir`. If any SDK path writes to `getAgentDir()`, it will now fail with EACCES. That would be a real immutability finding, not a reason to relax the profile.
- **Assumptions about shapes not checked by execution:**
  - prompt commands answer HTTP 202, and a just-begun command reports `accepted`;
  - `/messages` roles are `user` and `assistant`;
  - denied and read tool results carry `toolCallId`, `toolName` and `isError`;
  - the worker for `sid` is still `registry.live` after the turn;
  - the SDK uses fewer than 6 summary calls per transition.
- Test runs are from Node 24.x with `--experimental-transform-types`; the crash child depends on the same flag.

A full-code final Opus review is still required before the final Enki 2.0 build. This bounded fixture task does not replace it.
