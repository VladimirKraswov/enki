# Development and verification

## Bootstrap

Official `create-tauri-app` 4.7.4, `react-ts`, npm, Tauri 2. Product name is Enki. Dependencies are tracked by npm and Cargo lockfiles. The initial worker implementation was independently reviewed and corrected; the current shell includes native chat/PTY acceptance evidence.

Run from this project directory. On the current Mac, `NODE_PATH` can point into an unrelated project: use `env -u NODE_PATH npm …` when necessary. The app runs only its bundled Enki Runtime (pinned Node + Pi SDK in `src-tauri/resources/agent`, verified by manifest before start); it does not discover, launch or stop any agent executable from PATH. For development install the runtime dependencies from the reviewed lock (`npm ci --prefix src-tauri/resources/agent --ignore-scripts` then `npm rebuild --prefix src-tauri/resources/agent node-pty`). Use `ENKI_PROFILE_DIR=/absolute/new/dir` for an isolated development profile that never touches the owner's data or OS-vault entries.

## Verification ladder

1. Unit tests for API normalization, message/event reducer, session scoping, reconnect deduplication and request lifecycle.
2. Component tests for composer, real pending permissions/questions, error/empty states and keyboard behavior.
3. `npm run build` for TypeScript and bundling; `cargo check --locked --manifest-path src-tauri/Cargo.toml` for native changes (`CARGO_BUILD_JOBS=2`); Rust tests for native transport/validation where appropriate. Runtime/packaging changes: `npm run sdk:check`, `npm run test:runtime`, `npm run test:runtime-artifact`. The full ordered gate list is in `docs/VERIFICATION.md`.
4. Contract fixtures captured without private content; integration tests in a temporary Git repository created by the test.
5. Native manual smoke: connect, select project, create session, submit task, see live tools, inspect diff, terminal, stop/reconnect, restart app. Use exactly one inference request at a time on this system.
6. Release `.app` build and launch without Vite or a developer shell. Record actual results in `docs/VERIFICATION.md`.

Initial Cargo dependency compilation may take several minutes. Use an adequate bounded timeout rather than repeatedly killing/restarting it. Never hide build failures with a successful wrapper command. Don't call `npm test` passed until a real test script exists and runs meaningful tests.

## Build variants

Three variants, one shared source tree: `npm run build:linux` (`.deb`),
`npm run build:macos` (`.app` + `.dmg`, ad-hoc signed) and `npm run build:windows`
(NSIS). Each first prepares the bundled runtime and passes
`src-tauri/tauri.runtime.conf.json`. The platform-neutral `tauri.conf.json` carries
no OS chrome or entitlements; `tauri.{macos,linux,windows}.conf.json` add only
their own keys and `test/bundle-config.test.ts` fails if they drift. Exact
commands and the support matrix are in `docs/PLATFORMS.md`.

`./scripts/check-linux-prereqs.sh` reports missing Tauri 2 system libraries and prints
the `apt` line; it never installs anything, so an agent can stop cleanly at the
system-package boundary. On Ubuntu 24.04 the required set is `build-essential
pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libssl-dev`.

For a headless Linux smoke test start `Xvfb :N -screen 0 1360x900x24`, run the binary
with `DISPLAY=:N` and confirm the window with `xwininfo -root -tree` (software
rendering prints harmless `libEGL warning: DRI3` lines). Run smoke tests under an
explicit `ENKI_PROFILE_DIR`, never against the owner's profile, Hub key or services.

## Test safety

Use only explicitly created test projects/sessions. Never delete, reset or summarize a user's existing conversation to test behavior. Git status and before/after diffs must demonstrate user work is preserved. Do not mutate another project as a convenience. Do not upgrade/stop externally installed OpenCode/Pi CLIs or their servers, and do not restart FreeToken during ordinary UI tests.

## Visual QA

Check dark and light modes, empty app, long message/code, expanded tool error, pending permission, disconnected server, narrow window and three-panel layout. Buttons must perform their labeled action. Native-only APIs can be mocked in explicit frontend development/tests but the packaged release must use real implementations. Save useful screenshots locally and describe what was manually checked.

## Deliverable

A locally built `Enki.app`, source, tested instructions, compatibility notes and honest feature checklist. Install under the user's Applications only after verification; create a Desktop shortcut without overwriting the existing Qwen OpenCode launcher. The user explicitly authorized GitHub publication on 2026-09-22. Publish source/docs/tests to the private repository and attach the built DMG to its release; exclude local receipts, chat histories, credentials and app backups.
