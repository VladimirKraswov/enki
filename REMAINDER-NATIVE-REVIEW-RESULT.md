# Remainder final review — native / services / release (exact Claude Opus 5.5)

SOURCE ONLY on the borrowed host. Nothing was executed: **every test, build,
format, lint and live check below is NOT RUN.** The Mac coordinator runs them.
Per-file ledger (path + baseline SHA256 from REMAINDER-PER-FILE-LEDGER, read
depth, finding or reason): [REMAINDER-NATIVE-FILE-LEDGER.json](REMAINDER-NATIVE-FILE-LEDGER.json).
Edited files have new bytes. Their ledger `sha256` is the inventory baseline,
and they carry `"modified": true`.

## 1. Fixes and refactors (with the reason)

| # | Area | File(s) | Defect → fix |
|---|---|---|---|
| F1 | Tray quit | `src-tauri/src/tray.rs` | A declined Quit's 5 s fallback timer could finish a *later* Quit before the WebView answered it. The single packed `QuitGate(AtomicU64)` (state in the low 2 bits, request id above) makes `expire(id)` act only on the same unanswered request. |
| F2 | Profile boundary | `paths.rs` (`discovery_home[_for]`), `browser/node.rs`, `lsp.rs`, `capabilities.rs` | QA finding confirmed: `browser/node.rs` eagerly stat'ed HOME shims and walked nvm/fnm/mise/asdf trees even under `ENKI_PROFILE_DIR`. Now candidates are **lazy groups**: bundled verified Node first (recorded by `runtime::locate` artifact verification), then HOME shims, system paths, version managers. A qualifying bundled Node evaluates no HOME group. An explicit profile gets `home = None`, and an invalid profile fails closed. Normal default-profile discovery is unchanged. Probes are bounded to 8, with dedup. The same boundary applies to the LSP candidates and the informational HOME skill scan. |
| F3 | Profile parent | `paths.rs::opencode_data_dir` | Under an explicit profile it returned the owner's OpenCode data dir. It now refuses (`refuse_profile_parent`), so `storage_info` fails closed. |
| F4 | Update install | `hub_updates/install.rs` | Linux AppImage replacement is now staged → chmod 755 → previous copy → rename. It refuses a pre-existing staging path and removes only its own staging on error, so the installed file survives and a retry is not blocked. On Windows, `wait_parent` treats `OpenProcess` → `ERROR_INVALID_PARAMETER` (parent already exited) as done; before, it failed the install. |
| F5 | Update UI thread | `updates.rs` | The macOS previous-bundle `ditto` copy ran on the async runtime thread. It now runs in `spawn_blocking`, with stdin null. |
| F6 | Browser import | `browser/shared.rs` | A failed or cancelled legacy import left a partial stage. `copy_and_publish` now removes its stage on every error. |
| F7 | Computer control | `computer.rs` | Driver commands now use `process::output_with_timeout` (15 s, 512 KiB bounded drain, group kill, hidden console), so a descendant holding the pipe can't hang Enki. The MCP driver gets a hidden console. The `permissions grant` helper is reaped. `computer_set_enabled`/`computer_action` require the main window, and `stop` disables. |
| F8 | Secret to WebView | `model_credentials.rs` | `model_service_key` returns a secret to the WebView and now requires the main window. |
| F9 | Bounded read | `pricing.rs` | The response body is read with `take(LIMIT+1)` (4 MiB), no longer unbounded. |
| F10 | Canonical Hub publication | `scripts/releases/verify.mjs`, `publish.mjs` | `publish.mjs` signed packets but never verified them against the **pinned client key** before POST. A packet signed with another key would be accepted by Hub and refused by every client. New `assertSignedForClients` runs before any Hub request. It requires both `hot`+`source` minisign envelopes to verify against `src-tauri/updater.pub`, with exact kind/version/nativeFingerprint. The existing post-POST `verifyPublication` still checks the served head and both downloads byte-for-byte. |
| F11 | CI coverage | `.github/workflows/desktop.yml` | ASR unittest (the same gate as release:local), the four stdlib script-helper suites under bash `-e`, and the Windows-only install-selection suite now run on CI. The Node pin (24.22.1) is untouched. |
| F12 | Shipped skill helper | `resources/skills/create-shared-skill/scripts/catalog.py` | (a) It ignored `ENKI_PROFILE_DIR`: an isolated profile listed the owner's `~/.agents/skills` and the owner's registry. Now `<profile>/capabilities` is used, HOME is not inspected, and an invalid profile fails closed. (b) The Windows default registry was `%LOCALAPPDATA%\enki`, but natively it is `%USERPROFILE%\.enki` (legacy `.opencode-desktop`), so the inventory saw no sources. (c) Relative `XDG_DATA_HOME` is now ignored, as natively. (d) Each record says `enki: connected-source / not-loaded`, because the runtime loads only enabled registry sources. |
| F13 | Shipped guidance | `create-shared-skill/SKILL.md`, `reliable-web-search/SKILL.md`, `workshop/AGENTS.md`, `migration.rs`, `quality.rs` message | The 2.0 guidance said `~/.agents/skills` is "consumed by both engines" and told agents to verify with the OpenCode/Pi loaders, and the workshop said tools "должны работать в OpenCode и Pi". In fact the runtime loads only registry sources (`includeDefaults:false`). The guidance is now accurate. The prior workshop default SHA `df288d25…` is added to `bundled_defaults`, so unmodified installed copies refresh and owner edits are kept. |
| F14 | Maintenance docs | `docs/ARCHITECTURE.md`, `AGENT-BACKENDS.md`, `WORKSPACES.md`, `SELF-DEVELOPMENT.md`, `HUB-UPDATES.md`, `BROWSER.md`, `AGENT-CONTROL.md`, `LOCAL-MODELS.md`, `PI-ENGINE.md` (banner), `README.md` | These docs now describe the sole bundled Enki Runtime. Removed: the two-backend diagram, `pi.rs`/`local_server.rs` boundaries, the OpenCode endpoint/ownership/update text, the workshop "owned by OpenCode" text, and the wrong Hub releases path (`/var/lib/enki-hub/releases`). Added the pre-POST signature gate to the release docs. |

## 2. Written tests — ALL NOT RUN

- `tray.rs`: `a_declined_quit_timer_never_finishes_a_later_request`, `an_unanswered_request_finishes_exactly_once_at_its_own_deadline`.
- `paths.rs`: `discovery_never_inspects_the_owner_home_under_a_profile_and_fails_closed`.
- `browser/node.rs`: `a_qualifying_bundled_node_never_evaluates_owner_discovery`, `production_groups_put_the_bundled_node_first_and_stat_no_home_path_after_it`, `an_explicit_profile_never_discovers_under_the_owner_home`, `probing_is_bounded_and_duplicates_are_probed_once`; `every_candidate_is_absolute` now uses a fixture HOME.
- `lsp.rs`: `an_explicit_profile_offers_no_owner_home_language_server` (and the fixture-based absolute test).
- `hub_updates/install.rs` (unix): `a_failed_appimage_replacement_keeps_the_installed_file_and_never_blocks_retry`.
- `browser/shared.rs`: `a_failed_or_cancelled_import_leaves_no_partial_stage_behind`.
- `computer.rs` (unix): `driver_commands_are_bounded_even_when_a_descendant_keeps_the_pipe_open`.
- `scripts/releases/verify.test.mjs`: `nothing is published unless both packets verify against the pinned client key`. It uses a real Ed25519 minisign test key and covers the valid case, the real pinned key ≠ the signer, version, fingerprint, kind slot, tampered bytes and a missing packet.
- `scripts/test-skill-catalog.py`: `test_explicit_profile_never_reads_the_owner_home_or_registry`, `test_default_registry_matches_the_native_root_on_every_platform`, `test_only_connected_sources_are_reported_as_loaded_by_enki`.

The coordinator should run: `cargo fmt --check` (some hand-formatted lines may need `cargo fmt`), clippy `-D warnings`, `cargo test` on all three OSes, `npm run test:releases`, the `python scripts/test-*.py` suites, and Hub/ASR/Strata/V100 unittest.

## 3. Cross-domain ports (not edited here)

- **UI** `test/agent-backend.test.ts`, `client.test.ts`, `opencode-live.test.ts`, `engine-routing.test.ts`, `pi-*.test.ts` import deleted modules (`src/agent/opencode`, `src/api/client`, `src/agent/pi/*`), so `npm test` fails while they exist. They are already listed with mappings in `TEST-CUTOVER-DELETE-PATHS.json` / `MIGRATION_DELETE_PATHS.json`. The coordinator applies those deletions after validating the mapped tests.
- **UI**: `model_service_key`, `computer_set_enabled` and `computer_action` now require the main window. Every current caller is the main window, and the invoke names and arguments are unchanged.
- **UI** `src/components/ModelCatalogSettings.tsx` still edits/validates an OpenCode provider block ("Нужен хотя бы один движок (OpenCode или Pi)"). In 2.0 only the Pi part is applied. Minimal change: accept a Pi-only model and label the OpenCode block "для клиентов 0.2.x".
- **Runtime**: the ≤2 image-generation attempts rule is enforced in `shared/image-generation-context.mjs` (runtime domain). The service only accepts and records jobs. Nothing changed natively.
- **Runtime** `docs/SDK-UPGRADE.md` (runtime domain) is referenced as the SDK authority by the docs I edited; it was not edited.

## 4. Preserved invariants

- Qualified sources untouched: `process.rs`, `build_job.rs`, `build-runner/src/main.rs`, `runtime.rs` supervisor/start_once/generation gates/maintenance fences, the Windows Job, timeout/pipe-drain/tree regressions.
- `dev.local.opencodedesktop`, vault service names (`SecretNamespace`), tray id `arvela-runtime` and event names are unchanged. No root version bump, no lock/pin change, and CI `node-version: 24.22.1` is unchanged.
- External OpenCode/Pi CLI installs, services, data and `integrations/opencode-agent` are untouched. No historical/immutable docs, receipts or evaluation evidence were edited.
- Default-profile Node/LSP/skill discovery is preserved, and only explicit profiles lose HOME discovery. Hub authority has no new fallback: publication still never replays a POST, and `PublicationUncertain` stays a separate outcome.

## 5. Special-attention areas: classification (source review)

- **Process ownership / Mac PTY cleanup-unknown / Windows Job / concurrent ensure / late output.** Owned trees, the kill-on-close Job (suspended → assign → resume), `start_once` with generation gates and the bounded output tail were reviewed in `process.rs`/`runtime.rs`/`runtime/control.rs`. No defect was found, so nothing changed. The remaining unbounded native child calls were in `computer.rs` (fixed, F7).
- **Tray close/reopen; stable signing id and vault names; permission-request lifetime.** Close hides (macOS `hide`, otherwise hide + remember the monitor). Reopen shows both. Quit has a race, fixed in F1. The identifier and vault names are unchanged. The plugin UI grant (1.5 s, exact scope, one use) in `runtime_ui.rs` is unchanged.
- **Explicit profile boundary.** Fixed in F2, F3 and F12. `discovery_home()` is the single policy.
- **Update/download authentication; source 0.2 → 2.0 build path; host Node refusal before `node:sqlite`.** Packet minisign + version binding is verified before execution (`hub_updates/packet.rs`). The old-entry Windows build is in CI. `install-remote-entry.mjs` and `prepare-entry.mjs` check host Node before importing the SQLite installer. No defect was found besides F4.
- **Phase-aware installer outcomes; Hub durable publication; real Windows CI.** `last-install.json` phases plus F4. `durable.py`/`releases.py` report a post-rename failure as uncertain and reconcilable (tests exist). The Windows matrix entry builds through the old first-update entry, and F11 adds Windows-only suites.
- **Hub model-switch authority; image edit/PBR and ≤2 retries; ASR chunking and empty final tail.** Reviewed in `model_services.py` (whole-turn leases, external change fails the reservation without switching back), the images service (Klein edit, PBR maps, periodic tiling) and `asr/server.py` (ordered chunks; zero samples → `''` without inference). No defect was found. The ≤2 rule lives in the runtime (§3).
- **CI on all platforms; release gates before secrets; canonical Hub publication verifies both envelopes and bytes.** The 3-OS matrix exists. `operator.mjs` runs gates before reading the credential files. Pre-POST signature verification was missing and is now fixed (F10). The post-POST byte/signature comparison is unchanged.
- **Maintenance docs match the sole Pi runtime.** Fixed in F13 and F14 for the architecture, agent, workspace, self-development, release, browser and bundled-guidance docs. Topic docs still mentioning OpenCode/Pi engines are flagged by the README banner as 0.2.x (§6).

## 6. Remaining gaps and limitations (honest)

1. **Nothing compiled or run.** Rust edits may need `cargo fmt`. Windows-only code is reviewed but unverified: the `wait_parent` errno-87 branch, Job paths, and the `#[cfg(windows)]` node/LSP groups.
2. **Images tests are not in CI.** They need Pillow/numpy/FastAPI/OpenVINO. Run them on the service VM or a dedicated job.
3. `strata/test_gateway_live.py` runs only where `nginx` exists (it is skipped otherwise). On a CI image that ships nginx it starts a loopback nginx.
4. **The browser's trusted bundled Node is known only after the first runtime start** (`runtime::locate` verification). Before that, or if the runtime artifact fails verification, the default profile falls back to normal discovery, and an explicit profile still never reads HOME. A second full artifact verification was not added.
5. `journal.rs` events/operations grow without a bound (pre-existing). The control-socket token comparison is not constant-time (Windows loopback; unchanged). `check-windows-prereqs.ps1` asks for Node ≥ 24.15, while `host-node.mjs` accepts 22.13+.
6. `services/v100/*.patch` were classified by headers only. V100/strata JSON evidence, `seed.json`, the Hub web HTML/CSS and the services' READMEs were not read in depth (see the ledger).
7. Docs: many topic docs (`AI-ENVIRONMENT`, `CAPABILITIES`, `SETTINGS`, `CONTEXT-QUEUE-VOICE`, `MODEL-SERVICES`, `COMPUTER-USE`, `PRODUCT`, …) still describe OpenCode/Pi engine behaviour of 0.2.x. They were only grep-triaged. The README now marks them as 0.2.x, and they need a separate rewrite. `ROADMAP.md` and `.pi/TASK.md` are working logs and were not reviewed.
8. Locks (`package-lock.json`, `Cargo.lock`, `build-runner/Cargo.lock`, `services/images/requirements.lock`) were not read. There was no dependency change.
9. `archive_search.py` URL-encodes `/` inside archive file names (`safe=""`), so nested archive files may 404. A crashed `download.py` leaves a `.download.lock` that blocks that destination name. Both are minor and unchanged.
10. Ad-hoc macOS signing changes the keychain ACL identity on every native build. This is a documented platform limit with no Developer ID.
11. Live acceptance (tray, update install, Windows/Linux packages, remote host, Hub publication) belongs to the coordinator. No readiness is claimed.
