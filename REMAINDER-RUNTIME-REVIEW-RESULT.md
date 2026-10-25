# Remainder final review — runtime domain (exact Claude Opus 5.5, `claude-opus-5-5`)

**ALL CHECKS NOT RUN.** Source-only on the borrowed host: no command, test,
typecheck, build, install, git, app, browser, hook, subprocess, Hub/SSH, model or
network. Only Read/Edit/Write/Glob/Grep in `project/` and read-only
`sdk-reference/` (incl. `qualified-sdk-implementation/`, MANIFEST-bound 0.85.1).
No version bump, publish, readiness claim or final build. No test or module
deleted, skipped or weakened. Edits only in `src-tauri/resources/{agent,shared,browser,pi}/**`
and `docs/SDK-UPGRADE.md`.

Inputs read: REMAINDER-FINAL-REVIEW-COMMON, REMAINDER-REFERENCE-INDEX,
REMAINDER-DOMAIN-CHECKLIST, TODO-FOR-OPUS-post-integration-runtime-qualified (fresh
gates), FINAL-OPUS-REVIEW-RESULT.md in full (§3 and §5 especially),
TODO-FOR-OPUS-remainder-test-retirement-matrix + `remainder-retirement-matrix/old-case-ledger.json`
(model-hub cases 0–11), the per-file ledger template (SHAs), the pinned SDK
`skills.js`, `prompt-templates.js` (coding-agent and agent-core),
`resource-loader.js`, `package-manager.js`, `pi-manifest.js`, `settings-manager.js`,
and SDK declarations/docs.

Per-file ledger (path + snapshot SHA + depth + finding): **`REMAINDER-RUNTIME-FILE-LEDGER.json`**.
Every production file of the domain is listed; the few not opened are marked
`not-read` with no credit claimed (§9).

## 1. Concrete obligations → outcome

| Obligation | Outcome (NOT RUN) |
|---|---|
| P1 `store/events.ts` field/getter `head` collision | **Fixed at the root**: private ring index renamed `ringStart`; public `head` stays the highest emitted seq. Explains all 15 TS diagnostics (duplicate identifier + private-access in routes/tests) and the 7 stream/replay REDs (snapshot/hello/replay bounds used the eviction index). Regression `event-wire.test.ts` "journal.head is the highest emitted seq…" (no own `head` field, head==seq through byte eviction and ring compaction >4096, reset/replay cursor invariants, restart never below a held cursor). close-late-events keeps its no-late-event cutoff. |
| Timer source-first fixture 3489 > 3488 | **Fixture fit fixed, production untouched.** Root cause measured: the timer prompt carries the wake marker (~100 tokens more than "queued small"). Success stage now targets `scripted-medium` (16k, limit 15 488): still smaller than the source and still forced to summarize (history ≈19k > limit), asserting the exact pending wake tokens, system/tools > 0, forced transition, `tokensAfter > system+tools`, and ≥4 000 tokens headroom; the phase sequence is exact. Separate test: timer to the 4k model with an unfittable summary is **rejected** with `does_not_fit`, no target call, model and transcript kept, occurrence not marked sent. `targetBudget`/`max(usage, estimate)` unchanged. Planning progress now reports `system`/`tools` (diagnostic only). |
| Pinned SDK resource behaviour + explicit trusted Pi resources | Verified in the 0.85.1 implementation (§4). Fixed a real loader defect (one bad prompt entry blocked opening the chat). Added explicit **local package** support (`packagePaths`) with SDK layout rules; real-SDK tests for skill/prompt/package activation and precedence. No discovery, download, install or activation of imported/untrusted code. |
| Hub: expired lease replacement, whole-turn renewal during a live turn, generic 409, loader failure, slow discovery, outage, unreadable catalog | New `hub-lease-authority.test.ts` (13 cases) + production fixes in `models/hub.ts` (§3.2). Existing lost-ACK test still reuses the SAME requestKey exactly once. |
| create/list/delete/policy coverage (pi-backend 7/19/20/31) | New `session-lifecycle.test.ts`; deleting an opened chat exposed a real metadata leak, fixed (§3.3). |
| Lifecycle outcome / bounded retries / same preflight / no historic replay | Verified (dispatcher, worker.prepareModel, runOutcome, queue, compaction path). Scheduler retry defect found and fixed (§3.1). |
| Durable queue/timer/migration, cancellation never re-runs a stale request | Verified queue/cutover; scheduler cancellation fixed to *consume* the occurrence. |
| ESM boundary, pins, profiles, MCP child identity, HOME | Verified (resource-compat hashes = MANIFEST, single build bindings, launch-args, registry.profileEnvironment, daemonEnvironment). Fixed PTY/LSP env leak of SDK profile overrides (§3.4). |
| Browser identity/ownership; web search; image workflow; bounded screenshots/partials | Browser session-cap fix; MCP refusals now reach the model; screenshots/MCP results no longer persisted twice; live tool partials bounded (§3.4). |
| Retired shims/plugins | Reviewed; **no deletion**. Existing proposals in FINAL-INTEGRATION-DELETE-PATHS stand. |

## 2. Diagnosis of the fresh runtime REDs

- `store/events.ts` head collision — **product defect**, fixed. The 7 stream
  assertions (event-wire ×2, questions, extension-ui, reconnect ×2,
  close-late-events) are expected to change with it; they must be requalified,
  not assumed GREEN.
- `model-context` timer case — **fixture defect** (fit boundary), fixed as above.
- `browser-access`, `control-maintenance-status`, `daemon-environment`,
  `extension-fault`, `resource-settings` were unreported by the bounded run:
  still **unqualified** (resource-settings additionally changed, §5).

## 3. Production fixes and why

### 3.1 Scheduler (`schedule/scheduler.ts`, `protocol.ts`)
The dispatcher dedupes by command id, and an occurrence id was
`schedule-<id>-<nextAt>`. Composition defects (the unit tests used a fake host
returning a fresh state per call, so they never saw it):
- **cancelled** → saved `ready` with the same `nextAt`: every 5 s tick re-picked
  it (oldest first), got the duplicate cancelled receipt and rewrote the row —
  **starving every other due timer** forever, never running anything.
- **rejected** → `waiting` + 15 s "retry" with the same id: a duplicate no-op
  forever; a repeat timer never fired again.
Fix: rejected (provably not executed) → re-attempt under a NEW durable id
(`…-<nextAt>-<attempt>`, `ScheduleDTO.attempt` optional, validated `1..3`),
back-off 15/30/60 s, after `MAX_ATTEMPTS=4` refusals the timer pauses with the
reason (a compaction-heavy refusal cannot loop on paid inference). Cancelled →
the occurrence is **consumed**; next one a full interval later (fresh id, detail
explains); never the stopped request again. First-attempt id unchanged, so older
dispatching rows reconcile. `taskForCommand` matches the exact current id.

### 3.2 Hub authority (`models/hub.ts`, `core/runtime.ts`, `sessions/worker.ts`)
- The native broker returns `ENKI_HUB_ERROR:{"code","status"}`; the runtime
  never decoded it, so the raw envelope reached receipts/UI and every failure
  was retried alike. Now decoded into `HubRequestError` with Russian text.
- prepare: **same requestKey retried once** only for lost-ACK/transient classes
  (network/timeout/interrupted/transport, 408/429/5xx, undecoded broker errors —
  keeps the existing plain-Error lost-ACK test); **one fresh key** only for an
  explicit `lease_expired`; generic 409/other 4xx/TLS are answered, never
  retried. At most 3 prepares, typically 1.
- existing lease: reused only on an exact ready status; replaced only on an
  **explicit** expiry (`lease_expired`) or an explicit non-ready status of our own
  ticket. A status failure or generic 409 keeps the lease and refuses — an
  arbitrary conflict is not proof that a new reservation may be started.
- renewal: if the Hub explicitly ended or replaced the ticket of an owner whose
  **turn is running**, the lease is forgotten and `onLost` → runtime appends
  `session.error {name:"HubLeaseLost"}` and stops that turn; never a silent
  mid-turn re-prepare or continuation on whatever model the Hub now serves.
  Between turns the next `ensureRun` prepares anew (expired-inactive case).
- `worker.turnRunning()` distinguishes a dispatched turn from preparation.

### 3.3 Session deletion and queue scoping (`core/runtime.ts`, `queue/queue.ts`, `interaction/broker.ts`, `server/routes.ts`, `sessions/registry.ts`)
`DELETE /sessions/:id` only tombstoned the row and trashed the transcript. An
armed queue of the deleted chat kept `queue.armedWork()` true → `leaseActive`
true → **its Hub GPU reservation was never released**, and `activity().readyQueue`
>0 kept the runtime **non-idle forever** (update maintenance blocked). Now
`Runtime.deleteSession` also discards the chat's queue rows/state (blobs after
commit), remembered grants and Hub lease; timers stay listed and pause with
"chat deleted". `registry.remove` awaits an in-flight idle eviction first.
Queue item routes (PATCH/DELETE/steer/acknowledge) acted on any chat's global item
id; now 409 unless the item belongs to the scoped chat.

### 3.4 Other defects
- `plugin-ui/scoped-resources.ts`: a missing extension-supplied prompt path, a
  folder named `*.md`, or one malformed frontmatter threw out of `reload()` →
  **the chat could not open**. Now SDK `loadPromptTemplates` semantics (skip +
  diagnostic), first-wins dedupe with collision diagnostics; themes likewise.
- `plugin-ui/runtime.ts`: each editor change stored a full-text draft receipt
  under a new `meta` key forever (O(edits×size)); bounded to the last 64
  revisions (recent lost ACK replays; evicted id → explicit draft conflict).
- `shared/pi-extension.ts`: MCP `isError` text was dropped (model saw only a
  generic error, so image "two attempts"/"no Vision" refusals and web-search
  failures with `retryAt` were invisible); now surfaced, bounded. `details.mcp`
  persisted the raw result (image base64 twice, unbounded structuredContent);
  now a bounded summary.
- `browser/pi-extension.ts`: same duplicate persistence of every screenshot
  (transcripts hit the 128 MiB reader limit twice as fast); bounded summary
  keeping `structuredContent`.
- `browser/daemon.mjs` (+`session.mjs`): 32-session cap was permanent until a
  manual restart; now releases only a provably idle, unselected session.
- `sdk/translate.ts`: live partial tool output re-sent the whole cumulative text
  per update; now a 64 KiB tail with a marker; final result complete.
- `platform/pty.ts`, `extensions/lsp.ts`: terminals/LSP inherited the SDK profile
  overrides (bundled `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, missing ADC file) —
  an owner `pi`/gcloud in Enki's terminal silently used Enki's offline profile.
  Now `projectToolEnvironment`, like SDK project tools.
- `server/http.ts`: malformed `%` escape → 400 (was 500).
- `platform/files.ts`: truncated UTF-8 preview no longer reported as binary.
- `platform/git.ts`: untracked previews no longer follow symlinks out of the project.
- `interaction/ui-bridge.ts`: `select` accepts only an option actually shown.
- `sdk/adapter.ts`: one corrupt JSONL no longer hides all other adoptable chats.
- `core/runtime.ts`: `prepareChatWorkspace` idempotent on a retried request.
- `legacy/opencode-import.ts`: stale "not integrated" header corrected.

## 4. Explicit trusted Pi resources — what the pinned SDK actually does

Read in `qualified-sdk-implementation` (0.85.1, MANIFEST-bound):
- `DefaultResourceLoader.reload` → `DefaultPackageManager.resolve()` merges
  `settings.packages` (npm:/git: install/fetch, local paths), auto-discovers
  `~/.pi/agent/{extensions,skills,prompts,themes}`, project `.pi/…` and `.agents`.
  Enki must not use it; it does not (`ScopedResources`; SDK settings carry empty
  `packages/extensions/skills/prompts/themes`).
- `loadSkills({skillPaths, includeDefaults:false})` (public export) loads only
  the given paths; directory rule = SKILL.md root or `.md` children; **first
  path wins** a name collision (collision diagnostic). Enki order: shared
  capability skills → browser/computer skills → `skillPaths` → `packagePaths`.
- `loadPromptTemplates` is NOT exported from the package index; its rules
  (direct `.md` children of a folder or an explicit `.md`, missing/unreadable
  skipped) are now mirrored in `ScopedResources`; duplicates: first wins, like
  `dedupePrompts`/`expandPromptTemplate`.
- Local package layout (`collectPackageResources`, `pi-manifest.js`): `package.json`
  `pi.{extensions,skills,prompts,themes}` string arrays, else conventional folders.
  `plugin-ui/local-packages.ts` implements exactly the plain-path subset; glob/
  override patterns, entries escaping the package, ignore files, `npm:`/`git:`
  sources and installation are refused as **diagnostics** (shown by
  `GET /v1/settings/resources`), never guessed.
- `/skill:name` and `/template args` are expanded by `session.prompt` by default
  (`expandPromptTemplates: true`, `enableSkillCommands` default true): the new
  real-SDK test observes activation through what the provider receives.

Trust model: a package's extensions are trusted code **only because the owner
entered its absolute local path** in Enki settings (same trust as
`extensionPaths`). Imported old-Pi `settings.packages/skills/prompts/extensions`
remain **deferred pointers** (`/v1/migrations` → `configStatus().deferred`); they
are never activated automatically. Owner paths are never discovered.

**Runtime port (backward compatible):** `RuntimeSettings.packagePaths?: string[]`
(absolute, ≤64, no NUL; absent in older settings = none) via existing
`PUT /v1/settings`; `GET /v1/settings/resources` now also returns
`packages: Array<{path, present, extensions, skills, prompts, themes, diagnostics[]}>`
(counts only, ≤20 diagnostics). Changing it reopens idle workers at next use
(same path as other resource settings).

## 5. Tests written or changed (ALL NOT RUN)

New files: `agent/test/integration/hub-lease-authority.test.ts` (13),
`integration/pi-resources.test.ts` (4), `integration/session-lifecycle.test.ts`
(5), `agent/test/platform-files.test.ts` (2), `agent/test/browser-details.test.ts`
(2), declaration `browser/session.d.mts`.
Added cases: `event-wire` (head), `model-context` (timer success rewritten to
the 16k target with budget assertions; new timer no-fit), `scheduler-unit` (5,
dedupe-faithful host), `plugin-ui-routes` (bounded receipts), `queue`
(cross-chat scoping), `http-security` (400), `pty-activity` (terminal env),
`sdk-translate` (bounded partial), `shared-extension-lifecycle` (2: bounded
details, surfaced isError text).
Changed assertion with reason: `resource-settings` status `toEqual` gains
`packages: []` (deliberate additive contract; all previous fields identical) and
new `packagePaths` validation lines. `model-context` "queued prompt and a timer
wake": queue half unchanged; timer half moved to a target that genuinely fits
(the old target sat exactly on the measured boundary) — the fail-closed side is
kept as its own test.

## 6. Retirement-matrix gaps

| Old case | New exact assertion |
|---|---|
| model-hub 2 "reserves whole native turns, renews during tool execution" | hub-lease-authority "renews DURING a live tool call and a held stream…": status renewed while the tool executes and while the second provider call streams; release list empty until settled, then exactly one release recorded with `turnRunning=false`, receipt completed. |
| model-hub 4 "failed loader terminal; check never selects" | "a failed loader phase / a loader error while loading … terminal" (no SDK call, ticket released, only `mode:"run"` prepares, no later status poll or ready adoption) + "a readiness check of a Hub-owned model never prepares, selects or calls the model" (runtime `/models/check` → 409, catalog only). The UI `inspect` probe stays UI-domain evidence. |
| model-hub 9 "temporary catalog outage" | "a temporary catalog outage refuses without a direct send, then recovers through the Hub". |
| model-hub 10 "expired inactive vs active lease" | "an explicitly expired INACTIVE lease is replaced once…" and "an expired lease of a RUNNING turn stops that turn truthfully and is never re-prepared mid-turn". |
| model-hub 11 "explicit expired key once; generic 409 never another op" | "only an explicitly expired requestKey is refreshed, once, under a NEW key", "…twice in a row is not refreshed again", "a generic 409 on prepare…", "a generic 409 on an existing lease's status…". |
| model-hub 7 lazy init / slow discovery | "slow initial catalog discovery holds the turn…" |
| model-hub 8 lost ACK same key | existing cancel-and-hub case (unchanged) + "a lost ACK in the native envelope is retried once with the SAME key; a second loss refuses". |
| pi-backend 7 POST-created chat opens no worker | session-lifecycle "7": no provider call, `registry.live` undefined, nothing opening, `sessionFile` null, only `session.created` emitted, listing does not open it. Retired premise, stated honestly: the old test proved "no Pi CLI process spawned"; there is no CLI — the live equivalent is "no SessionWorker/SDK session". |
| pi-backend 19 directory-filtered app-owned titles | session-lifecycle "19" (+19b corrupt-file adoption). |
| pi-backend 20 delete opened chat closes worker + metadata | session-lifecycle "20" (worker instance closed, catalog/list gone, queue/state/attachments/grants removed, Hub lease released by the deletion, transcript in trash, project folder unchanged, nothing runs later; running chat → 409). |
| pi-backend 31 separate persisted full/ask/read | session-lifecycle "31": rules equal after a real runtime restart on the same data dir, and enforced: full writes without asking, read refuses without dialog, ask raises exactly one permission (rejected → no file). |

No old test or module is proposed for deletion by this pass beyond the existing
`FINAL-INTEGRATION-DELETE-PATHS.json` rows; `test/model-hub.test.ts` (expected RED)
now has the runtime replacements above for cases 2, 4, 7–11.

## 7. Exact cross-domain ports (other authors; not edited here)

1. **UI test** `test/pi-browser.test.ts:76` — `expect(response.details.mcp).toBe(result)`
   pins the old duplicate persistence. Minimal change:
   `expect(response.details.mcp).toEqual({ isError: false, blocks: ["text", "image"], structuredContent: result.structuredContent })`
   (the screenshot remains asserted through `response.content`).
2. **UI settings (PiSettings + `src/agent/runtime/client.ts` types)** — add
   `packagePaths?: string[]` to the runtime settings type and an editor for
   absolute LOCAL package folders (same UX as skill/prompt paths: missing → "не
   найден, не загружается"). Render `GET /v1/settings/resources` `.packages[]`:
   counts of extensions/skills/prompts/themes and each diagnostic verbatim.
   Explain: "Пакеты Pi подключаются только из выбранной локальной папки;
   npm/git-пакеты не скачиваются и не устанавливаются; расширения пакета —
   доверенный код". For deferred imported keys (`/settings/packages`, `/settings/skills`, …)
   offer "указать локальную папку" — never auto-activate.
3. **UI timers** — `ScheduleDTO.attempt?` is additive; show `detail` for
   `waiting` (retry reason) and the new paused text "Таймер приостановлен:
   пробуждение не отправлено после 4 попыток…" and the cancellation detail.
4. **UI events** — `session.error` with `error.name === "HubLeaseLost"` (reducer
   already handles `session.error`); Hub failures now arrive as Russian text,
   never `ENKI_HUB_ERROR:{…}`. `session.context_transition` planning adds
   `system`/`tools` numbers (optional).
5. **UI queue** — item routes answer **409** when the item belongs to another
   chat; `DELETE /sessions/:id` now also removes that chat's queued prompts and
   remembered grants (warn in the delete confirmation that queued prompts go
   with the chat).
6. **Native** — no change required. (`capabilities.rs` shared install list
   unchanged; the browser extension's import surface was kept unchanged for the
   installed layout.)

## 8. Preserved invariants (verified in source)

One SDK agent loop (no retry/compaction orchestration added); manual/queued/timer
prompts share dispatcher → worker fit (source-first summary under its own lease)
→ exact target readiness; nothing historic replayed; `max(usage, estimate)` and
budget policy unchanged; truthful outcomes (length/no_answer/terminated failed);
command-id idempotency; queue lost-ACK safety; read-only archives and owner
sources untouched (deletion trashes only owned working copies); explicit profiles
never fall back to owner `~/.pi/agent` or HOME changes; MCP stdio children get
exactly the profile identity; Hub never bypassed directly for a known/undiscoverable
route; browser per-chat profiles; Russian user-facing text.

## 9. Remaining gaps and limitations (honest)

- Nothing compiled or run. New code may still need TS/Vitest adjustments on the
  coordinator's machine (e.g. inferred types in test fixtures).
- Not opened in this pass (no credit claimed): `legacy/{projection,records,protocol}.ts`,
  `plugin-ui/README.md`, `browser/SKILL.md`, package manifests, and most unchanged
  test files (listed `not-read` in the ledger). `sdk/history.ts` and
  `extensions/lsp.ts` rely partly on the FINAL-OPUS ledger.
- Browser daemon eviction: only the pure selection is unit-tested; the daemon
  script (Playwright at top level) cannot be exercised source-only.
- Hub "replaced ticket" detection relies on `operation_id`/`active_model` in
  status (both required by `validStatus`); a Hub reporting transient
  `active_model:null` is deliberately not treated as loss.
- Pi packages: no glob/override patterns, no ignore files, no npm/git; imported
  old-Pi package entries stay deferred by design.
- Archive history pages re-validate the whole archived chat per request (perf).
- Pre-existing, not changed: `PUT /config/models` keeps unbounded timestamped
  backups; `AttachmentStore.release` deletes blobs inside a caller's
  transaction in `queue.edit` (new code releases after commit).
- Native ordinary-user acceptance (Qwen Medium via Hub, tools, MCP, plugin UI,
  images, timers) remains the coordinator's release gate. No readiness claimed.
