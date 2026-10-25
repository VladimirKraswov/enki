# Enki 2.0 — final seam review (exact Claude Opus 5.5, `claude-opus-5-5`)

**ALL CHECKS NOT RUN.** Source-only on the borrowed host: no command, test,
typecheck, build, install, git, app, browser, hook, subprocess, Hub/SSH, model or
network was executed. Only Read/Edit/Write/Glob/Grep inside `project/` and
read-only `sdk-reference/` (including `qualified-sdk-implementation/` 0.85.1).
No version bump, publish, signing/identity/vault change, owner install or
readiness claim. No test or module deleted, skipped or weakened; assertion
changes are listed with reasons (§9). Previous reports are unchanged.

Per-file ledger (baseline SHA from `FINAL-SEAM-CURRENT-FILE-INVENTORY.json`,
depth, change, finding): **`FINAL-SEAM-FILE-LEDGER.json`**. It covers only files
read or changed in this pass; the rest of the repository keeps the coverage of
the earlier REMAINDER/FINAL ledgers and was **not** freshly reread.

Inputs read: the task brief (`REMOTE-FINAL-SEAM.md`), `FINAL-REFERENCE-INDEX.md`,
the three REMAINDER reports, `TODO-remainder-ui-review.md`,
`TODO-remainder-runtime-review.md`, `TODO-FOR-OPUS-remainder-native-readonly-review.md`,
`current-qualification/{runtime,ui,native}.md`, the retirement matrix entries
touched here, and the pinned SDK sources `package-manager.js`, `skills.js` and the
`agent-session` / `compaction` declarations.

## 1. Changes panel invalidation (TODO-remainder-ui-review P2) — fixed

`applyHistory` copied the old `patchRevision`; a snapshot without patch parts
removed every patch without advancing it, so the narrow `RightPanel` selector
never re-ran its load effect. Now, when the replaced slot contained any patch
part, the revision advances once (O(parts) per authoritative load, never per
token); it stays monotonic. Streamed deltas and patch-free reloads still leave it
untouched, so the O(1) subscription stays quiet.

Tests: `test/changes-panel-history.test.ts` (new) renders the real `RightPanel`
over the real reducer: a live patch with an empty server diff shows the fallback
file and its expanded preview; an authoritative history without patches advances
the revision, the panel re-reads `sessionDiff` (2nd call) and shows the empty
truth, without the stale file/preview; a second case proves a patch-free reload
and deltas trigger no refetch. `test/chatReducer.test.ts` gains the history-removal
revision assertion.

## 2. Hub lease loss throughout inference — fixed

Cause confirmed: `Runtime.hubLeaseLost` returned unless `worker.turnRunning()`
(`this.run !== null`), which is false during the source-model summary inside
`fitTarget` and during manual `worker.compact()`; the dispatcher still counted
them in flight, so renewal kept and then lost the lease while paid compaction
continued and could reach target readiness.

Fix (one cancellation seam, SDK behaviour respected):
- `Dispatcher`: each gated command has a `Reservation.leased` flag, set only after
  its own `ensureRun` succeeded (source summary, target, manual-compaction gate)
  and cleared when the next model is direct. `leaseInUse(session)` = a leased,
  non-aborted gate **or** a running turn. A gate still waiting for its own
  `ensureRun`, or a settled chat whose lease is only retained for armed queue
  work, is not stopped (inactive-between-turn behaviour preserved: the next
  `ensureRun` prepares anew).
- `Dispatcher.abort(session, reason?)`: aborts gates with an `AbortReason`
  carrying the lease-loss text, then `worker.abort(reason)`. A plain Stop keeps
  its previous texts.
- `SessionWorker.abort(reason?)`: calls the SDK's separate `abortCompaction()`
  **before** `session.abort()` (and again after, as before), records the reason
  per operation epoch; the preparation fence then throws
  `ContextTransitionError("cancelled", "<lease text> Подготовка отменена; модель не
  переключена, запрос не отправлен.")`, so nothing reaches target readiness or
  `setModel`. A running turn's receipt carries the same reason.
- Manual compaction aborted by Stop or lease loss is now `cancelled` ("… История
  не изменена.") instead of `failed`.
- `hubLeaseLost` appends `session.error {name:"HubLeaseLost"}` inside try/catch and
  always calls the abort, so a failing journal can never suppress the stop.
- Unchanged: whole-turn renewal, lost-ACK same-key retry, one fresh key only on
  explicit `lease_expired`, generic 409 never retried, ≤3 prepares, release of
  only the exact owned ticket (a lost ticket is forgotten, never released again).

Tests: `agent/test/integration/hub-lease-inference.test.ts` (new, real Runtime +
pinned SDK + scripted provider + fake Hub broker):
- source summary with the lease **expired** and, separately, **replaced** (another
  `operation_id`): receipt `cancelled` with the Hub text and "запрос не
  отправлен"; exactly one large-model call; no small-model call; model still
  large; phases contain `summarizing`, not `target_model`/`ready`, last phase
  `cancelled`; exactly one `HubLeaseLost`; no new prepare; no release of the lost
  ticket (also after the next renewal); the prompt never became a user entry.
- manual compaction with an expired lease: `cancelled`, Hub text + "История не
  изменена", no `session.compacted`, one HubLeaseLost, no prepare/release; a later
  compaction prepares a **new** reservation once and completes.
- a journal that throws on the notice still stops a running turn (`cancelled`,
  one provider call, no extra prepare/release).
Existing `hub-lease-authority.test.ts` cases (running-turn loss, inactive expiry,
409s, lost ACK) are unchanged and still apply.

## 3. Local Pi packages — fixed

Verified in `qualified-sdk-implementation` 0.85.1: `collectPackageResources` uses
manifest fields as one group; `collectFiles`/`collectSkillEntries` follow links
without a visited set or bound and honour `.gitignore/.ignore/.fdignore`;
`resolve()` collects **configured packages before top-level settings entries**
(first wins), then auto-discovery; the SDK's `loadSkills` directory walker follows
links unbounded.

`plugin-ui/local-packages.ts` rewritten (same public API + `PACKAGE_LIMITS`):
- physical boundary: package root, every manifest/conventional entry, every walked
  directory and every linked entry must `realpath` inside the package; escapes are
  diagnostics, never returned;
- one `Walk` per package: each physical directory visited once (aliases, cycles),
  bounds of 256 directories, 8192 examined entries, 512 files; exceeding a bound
  drops that entry entirely with a diagnostic (no partial load); no matching files
  terminates quickly;
- nested extension `package.json` entries obey the same pattern and package-root
  policy;
- ignore files are **not** interpreted: an entry whose walk meets one is refused
  with a Russian diagnostic naming the file (exact file entries unaffected, as in
  the SDK);
- skill folders are expanded here into `SKILL.md`/root `.md` files
  (`collectSkillEntries` "pi" rules) so the SDK walker never sees a package
  directory;
- diagnostics bounded (40 kept; the API shows ≤20).

Precedence correction: `Runtime.resources()` now orders Enki's own capability,
browser and computer skills first, then **package** resources, then explicit
skill/prompt/extension paths — matching SDK `resolve()`. The earlier "explicit
path wins" test expectation contradicted the SDK source and was corrected with
that reason (§9). `docs/SDK-UPGRADE.md` updated.

Tests (`integration/pi-resources.test.ts`, own `tempDir` fixtures only): package
resource wins a name collision through real `/template` and `/skill:` expansion;
an explicit-only skill still activates; links out of the package (prompt folder,
extension folder, linked skill, manifest entry lexically inside but physically
outside) return nothing outside and are diagnosed; alias + cycle walked once; an
8-way self-alias fan-out with no matching files finishes (<5 s) with one honest
diagnostic; a walk over the directory bound loads nothing of that entry and says
so; nested manifest glob and escape are diagnosed while the plain entry loads; a
`.gitignore` refuses its entry while another entry of the package loads. No npm/git
download or discovery was added.

## 4. Shared-skill helper profile — fixed

`catalog.py` gains `profile_root()` mirroring native `paths::validate_profile_root`
read-only: absolute, not root, no `..`, not lexically HOME; every existing path
component checked with `lstat` (link or file → refusal); an existing profile is
compared with HOME by physical identity; a missing profile simply has no registry;
any doubt raises `ValueError` (main() prints its sanitized error). Under
`ENKI_PROFILE_DIR` the inherited `MESH_CAPABILITIES_ROOT` is ignored (native has no
such override); the explicit caller-owned override remains `--registry`. Default
(no profile) discovery is unchanged, including `MESH_CAPABILITIES_ROOT`.

Tests (`scripts/test-skill-catalog.py`, own fixtures): linked profile, linked
ancestor, link to HOME, file component, and physical HOME reached through a linked
HOME argument all fail closed; a clean own profile resolves to its physical
registry; an inherited `MESH_CAPABILITIES_ROOT` pointing at an owner-like registry
does not redirect a profile (and yields no sources) while the default mode keeps
it. The existing profile test now canonicalises its temp root (macOS `/var` is a
link that the native policy also refuses) — assertions unchanged. The suite now
has **8** tests; the admin loader's expected count (6) needs updating.

## 5. UI/runtime ports — integrated

Compared against current code; only missing items were implemented.
- **packagePaths**: typed client (`packagePaths?`, `PackageStatusDTO`,
  `packages?` optional for older runtimes); `Настройки → Агент Enki → Расширения и
  LSP → Пакеты Pi` editor (absolute paths, ≤64, disabled when the runtime lacks the
  field); per-package counts and verbatim diagnostics from `GET
  /settings/resources`; Russian explanation of local trusted-code activation,
  no npm/git download, refusal of escaping links/patterns/.gitignore, SDK
  precedence; resource status re-read after a package change. Imported old-Pi
  pointers stay deferred (only a note with "укажите локальную папку").
- **Timers**: `attempt` mapped; waiting with attempt shows "Не отправлено: … ·
  повторная попытка N из 4"; a cancelled occurrence (ready + detail) shows its
  explanation; paused text already shown. `SCHEDULE_MAX_ATTEMPTS` moved into
  `protocol.ts` (browser-safe) and aliased by the scheduler (value 4 unchanged).
- **HubLeaseLost**: reducer already surfaces `session.error`; verified the notice
  survives the following cancelled outcome and idle (new reducer test). English
  fallbacks ("Session error", "The response was aborted.", "The assistant message
  failed.") translated.
- **Queue 409 / delete**: item-route failures that answer 409 re-read that chat's
  queue once (no retry), so a row that belongs elsewhere disappears; the runtime's
  Russian reason is shown. The delete confirmation now says queued prompts and
  remembered permission answers go with the chat and its timers stay paused.
- **Browser details assertion**: `test/pi-browser.test.ts` now asserts the exact
  bounded summary `{isError:false, blocks:["text","image"], structuredContent}`,
  that the image is in `response.content`, and that details contain no second copy
  of the screenshot. Other assertions unchanged.
- Not implemented (contract decisions outside this scope, unchanged from the UI
  report): `extension.notify` surface tagging, plugin draft `selection`/theme.

## 6. PBR/image archive usability — new native port + UI action

Ownership inspected: the shared image tool saves PNGs, previews, `manifest.json`
and `images.zip` under `<agent cwd>/.enki/generated-images/<job>/` on the host
where the runtime runs; for a remote host the generator retains
`/jobs/<id>/files/images.zip`; `image_asset` already reads only allowlisted PNGs.

`images::image_archive_save(fileUrl, directory)` (registered in `lib.rs`):
- main window only; bounded inputs;
- accepts only `file:` URLs naming exactly `<directory>/.enki/generated-images/<uuid>/images.zip`
  of the **open chat** (lexical segment match, percent-decoding refusing `/`, `\`,
  NUL, `.`/`..`; no host/query/fragment);
- local read refuses links among `images.zip`, the job folder, `generated-images`
  and `.enki`; ≤128 MiB;
- not on this device → fetches only `/jobs/<id>/files/images.zip` from this
  device's configured Enki generator (bearer from the vault, no redirects,
  streamed with the same bound);
- verifies the ZIP **without extracting**: one disk, ≤32 entries, central directory
  ends exactly at EOCD, no encryption, stored/deflate only, local headers before
  the directory, only generator names (`image-NN.png`, maps, relight, tile preview,
  `manifest.json`; no paths, no previews), unique, manifest and an image present;
- the destination comes only from the native save dialog (cancel → `null`); bytes
  are written to a fresh sibling then renamed.
UI: `GeneratedImages` adds "Сохранить images.zip…" (uses the chat directory),
shows the saved path or a refusal; PNG/map/viewer cards unchanged. The two-attempt
generation budget is untouched (shared runtime authority).

Tests: Rust `archive_tests` (verifier positives/negatives incl. traversal,
nested path, preview, foreign file, duplicate, encryption flag, missing
manifest/image, truncation, moved directory; exact chat addressing incl. remote
Windows path, query/fragment/host/traversal/encoded slash; unix: linked job folder
refused, real archive read, staged write leaves no part file);
`test/generated-images-archive.test.ts` (save → native args + path; cancel → no
message; refusal shown; no button without archive; disabled without chat folder;
cards still use `image_asset`). No real generation was run.

## 7. Model catalog — Pi-only is accepted and normal

`ModelCatalogSettings`: a model without a Pi entry is refused with an explicit
reason (2.0 applies only Pi); OpenCode fields are labelled "совместимость 0.2.x,
необязательно" and come after Pi; "Добавить модель" creates a Pi-only entry
(`newCatalogModel`); summaries say when a model is not applied by 2.0. No OpenCode
executable/provider is required. Test: `test/catalog-editor.test.ts` (+1).

## 8. Fresh qualification failures — triage

| Report item | Class | Action |
|---|---|---|
| runtime `close-late-events` → `failed` | **product defect** (close not bound to the active run; stale `toolUse` read as tool-policy termination) | `close()` binds the exact active command with cause `close` before detaching; `finishRun` reports `cancelled` ("Ход прерван закрытием чата…") unless the pre-close facts show a genuine provider `error`/`length`, which stay failed; an earlier explicit Stop keeps its own reason. Marker cleared on settle. Test file unchanged; assertion unchanged. |
| UI `pi-browser.test.ts:76` identity | **stale fixture** (bounded details by design) | assertion updated (§5). |
| UI 43 held failures / 11 collection errors | **retired premise** (removed OpenCode/Pi CLI modules) | no change; retirement proposals §10. |
| native catalog P2 | **product defect** | fixed (§4). |
| native `build-runner.test.mjs` 31/39 | **fixture assumption** (cold `node -e` primary may need >300 ms to exit under copy I/O, so deadline/cancel hit the pre-exit branch) | POSIX primary is now `/bin/sh` (the Node holder still inherits the pipes from fork); the cancel case aborts only after the holder observed its primary **reaped** (`kill(pid,0)` fails only after reap, i.e. after Node reported `exit`), written as a GONE marker. 300 ms/200 ms/60 s budgets, error predicates and the "settled before the holder" checks are unchanged; the cancel timing bound is measured from the cancel. Windows keeps a Node primary with the same GONE logic. |
| native `prepare.test.mjs` 43/57 | **platform cold start** (first exec of a freshly copied ~100 MB Node; repeat passed at 4.99/4.54 s) | `bundledNode()` copies and runs the binary once under a separate 60 s readiness bound and asserts it really ran; the unchanged 5 s budgets then measure only the wrapper path. Production `run()` deadlines untouched. |
| native ASR listener denial | harness/guard (authorized separately) | none. |

Retirement-matrix note: `close-late-events.test.ts` bytes are unchanged, so its
`invariants.json` entry stays exact (expected to flip to PASS). `test/pi-browser.test.ts`
changed bytes; its `sourceSHA256` in `invariants.json` must be refreshed by the
coordinator (the pinned title there is a different, unchanged case).

## 9. Production review gaps closed

- `src/state/store.ts` read **completely** (1–3476). Concrete fix: per-chat
  `mcpStatuses` grew without bound between reconnects → LRU bound 64. Nothing
  else changed (eviction, history pages, send/queue/selection fences reviewed).
- `src/styles.css` read **completely** (1–3244). Fix: `--muted`, `--text-muted`,
  `--fg-muted`, `--bg-hover`, `--font-sm` were used without definition/fallback
  (muted text at full contrast, help hover without background) → aliases; small
  rules for the new archive action and package diagnostics.
- `promptQueue.ts`, `handoffTranscript.ts`, `Sidebar.tsx`,
  `legacy/{projection,records,protocol}.ts`, `sdk/history.ts`, `extensions/lsp.ts`
  read in full. Fix in `lsp.ts`: stdin `error` listener (EPIPE after a dead server
  was an unhandled stream error in the runtime process); an unexpected exit now
  forgets the process (next call restarts it instead of timing out forever) and
  fails waiters with "сервер завершился" instead of "замечаний нет"; frames over
  32 MiB stop the server (bounded buffer). Test: `extension-boundary.node.ts` (+1:
  crash reported, then a fresh `didOpen:1`).

Assertion changes (with reasons, none weakened):
- `pi-resources.test.ts`: collision winner flipped to the package (SDK `resolve()`
  order, source-verified); package skill count 1→2 (now counts skills, not the
  folder). All other assertions kept; cases added.
- `pi-browser.test.ts`: identity → exact bounded summary + content image + no
  duplicate.
- `scripts/test-skill-catalog.py`: fixture temp root canonicalised.
- `build-runner.test.mjs` / `prepare.test.mjs`: fixture synchronisation only.

## 10. Retirement proposals (deleteNow: false — coordinator decides after replacements pass)

Existing mappings stand (`MIGRATION_DELETE_PATHS.json`, `TEST-CUTOVER-DELETE-PATHS.json`,
`FINAL-INTEGRATION-DELETE-PATHS.json`, REMAINDER-UI §7). Summary for the 14 held
UI files of the fresh run:

| Held file | Premise | Replacement evidence |
|---|---|---|
| `test/engine-routing.test.ts` (29) | two-engine routing | `test/engines.test.ts`, `test/runtime-store-sync.test.ts` |
| `test/local-server.test.ts` (3) | OpenCode server start | none needed (no OpenCode execution) |
| `test/model-hub.test.ts` (11) | per-engine UI lease setters | runtime `hub-lease-authority.test.ts` (cases 2,4,7–11) + **new** `hub-lease-inference.test.ts` (loss during summary/compaction) + UI `model-hub-inspect.test.ts` (case 4 window part) |
| `agent-backend`, `client`, `opencode-live` | deleted OpenCode client/backend | `test/runtime-client-ui.test.ts`, `runtime-stream-framing.test.ts` |
| `config-reload`, `global-policy`, `full-access-loop` | OpenCode config/policy | `queue-access.test.ts` (full access via PATCH), runtime access tests |
| `pi-backend`, `pi-live`, `pi-probe-id`, `pi-translate` | Pi CLI | runtime `session-lifecycle.test.ts` (7/19/20/31), `sdk-translate` tests |
| `schedule-preflight` | UI timer preflight | runtime `integration/schedules.test.ts`, `scheduler-unit` |

New proposal from this pass: none. (`src/state/handoffTranscript.ts` remains in the
UI report's proposal; it has no importer in `src`.)

## 11. Documentation

Rewritten for the sole runtime (current operating instructions, not a banner):
`AI-ENVIRONMENT`, `CAPABILITIES`, `SETTINGS`, `CONTEXT-QUEUE-VOICE`,
`MODEL-SERVICES`, `COMPUTER-USE`, `PRODUCT`; also `IMAGE-GENERATION` (archive
action), `ATTACHMENTS`, `CHAT-CONTEXT`, `SCHEDULES`, `SHARED-SKILL-AUTHORING`,
`BROWSER-PREFERENCES`, `PROJECT-MEMORY`, `ARVELA-HUB`, `TASK-RESULTS`, `HANDOFF`,
`TASK-DIAGNOSTICS`, `AGENT-FACTORY`, `SDK-UPGRADE` and the README banner. OpenCode
content that remains is marked as 0.2.x history. Unchanged on purpose (historical
evidence or incident reports): `VERIFICATION.md`, dated `*-2026*` reports,
`WINDOWS-RESULT-*`, `RELEASE-*`, `docs/evaluations/**`, `API.md` (OpenCode API
baseline), `PROJECT-ACCESS-RECOVERY.md`, `OUTPUT-LIMIT-RECOVERY.md`,
`PI-MODEL-COMPARISON-20261007.md`. Not rewritten in this pass (residual 0.2.x
mentions remain): `LOCAL-MODELS.md` (partly updated by the native author),
`WORKER_PROMPT.md`, `WINDOWS-AGENT-PROMPT.md`, `PI-ENGINE.md` (banner).

## 12. Tests written or changed — ALL NOT RUN

New: `src-tauri/resources/agent/test/integration/hub-lease-inference.test.ts` (4),
`test/changes-panel-history.test.ts` (2), `test/generated-images-archive.test.ts` (2),
Rust `images::archive_tests` (3, one unix-only).
Added cases: `pi-resources.test.ts` (+5), `extension-boundary.node.ts` (+1),
`scripts/test-skill-catalog.py` (+2), `chatReducer.test.ts` (+1 case, +1 assertion
block), `pi-settings.test.ts` (+2), `schedule-section-ui.test.ts` (+1),
`queue-access.test.ts` (+1), `catalog-editor.test.ts` (+1).
Changed: `pi-browser.test.ts`, `build-runner.test.mjs`, `prepare.test.mjs` (§8/§9).

Coordinator gates to run: agent `tsc --noEmit` and full public Vitest (incl.
`close-late-events`, `hub-lease-*`, `model-context*`, `pi-resources`, queue,
scheduler), `test/run-node-suites.mjs` (extension-boundary), frontend `tsc` and
full Vitest, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test` (images archive tests), `python scripts/test-skill-catalog.py`
(expect 8), `npm run test:runtime-artifact` (build-runner/prepare).

## 13. Remaining limitations (honest)

- Nothing compiled or run; TS/Rust may need small adjustments (e.g. rustfmt
  layout was written by hand to rustfmt style; `tauri_plugin_dialog::FilePath::into_path`
  and `blocking_save_file` are used per the v2 API from memory, not from vendored
  source).
- Native save dialog, remote archive fetch, Windows/Linux paths and the
  Windows branch of the pipe-holder fixture are unverified on real platforms.
- The archive verifier is structural; it does not decompress or CRC-check entries
  (the generator wrote them; the copy is byte-identical).
- Explicit (non-package) skill/prompt directories configured by the owner are still
  walked by the SDK itself (unbounded, link-following) — they are the owner's own
  explicit paths; only packages got Enki's stricter subset.
- Hub "replaced" detection still relies on `operation_id`/`active_model` in status.
- A lease loss while only a non-model UI command runs is not acted upon (correct);
  a lease loss exactly between a gate's `ensureRun` resolution and its `leased`
  flag being set cannot occur (same synchronous continuation).
- Live acceptance (Hub GPU models, image generation, tray, update, platforms)
  remains the coordinator's release gate. No readiness claimed.
