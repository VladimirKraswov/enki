# Enki 2.0 — maintained verification gates (sole bundled Pi SDK runtime)

This section is maintained; every section below it is the historical evidence
log of 0.2.x releases (OpenCode/Pi external-engine era) and is kept as history.

Canonical order is `scripts/releases/operator.mjs` (tested by
`scripts/releases/operator.test.mjs`); every gate runs before any publisher
credential is read. CI (`.github/workflows/desktop.yml`) runs the same suites on
Linux, macOS and Windows. `CARGO_BUILD_JOBS` is 2.

| Gate | Command | Covers |
|---|---|---|
| Clean tree | `git diff --exit-code` | reviewed source only |
| UI | `npm test`, `npm run build`, `npm run check:architecture`, `npm run check:bundle` | frontend, module boundaries, bundle budget |
| Release transport | `npm run test:releases` | gate order, signatures, device publish/lost ACK |
| SDK contract | `npm run sdk:check` | every SDK/Node/data-schema pin agrees with `scripts/runtime/sdk-contract.mjs` |
| Runtime deps | `npm ci --prefix src-tauri/resources/agent --ignore-scripts`, `npm rebuild … node-pty`, `npm --prefix … run typecheck` | reviewed lock, native PTY ABI, strict types |
| Runtime | `npm run test:runtime` | Vitest + every guarded real-SDK/legacy `*.node.ts` suite |
| Packaging | `npm run test:runtime-artifact` | artifact/manifest, preparation, remote installer + paired rollback, first 0.2→2.0 `npm run tauri` entry, host-Node guard, bootstrap runner |
| Services | `python3 -m unittest discover -s services/hub/tests`, `… services/asr/tests` | Hub releases/catalog/model services (durable publication on POSIX and Windows), ASR |
| Native app | `cargo fmt --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings` (`src-tauri/Cargo.toml`) | supervisor, config/vault authority, updates/builder, browser, profiles |
| Bootstrap runner | same three on `src-tauri/build-runner/Cargo.toml` | Windows Job / NTFS directory flush runner used by first-update preparation |

CI additionally runs `npm run eval:check` (fixture self-check + evaluation
adapter contract), `test:faults`, strata/v100 service tests, the live native
runner protocol checks, the Windows build through the exact old 0.2 builder
command (`npm run tauri -- build --bundles nsis --ci -- --locked`) with
verification that the bundled runtime equals the prepared artifact, and the
platform package checks.

Not covered by these gates (separate acceptance required and reported
separately): live models/GPU, an installed ordinary-user Mac/Windows/Linux
upgrade 0.2.x→2.0 with history resume, the remote Linux host procedure
(`docs/REMOTE-RUNTIME.md`), Windows Job/NTFS behaviour on real hardware beyond
CI, and macOS PTY descendants that escape their process group (reported as
cleanup-unknown by design).

# Paired-device release and Windows browser review (0.2.104)

Imported six source/test files from the supplied Windows0.2.103 browser package.
Contributor reports1091 tests/Windows NSIS/install/live example.com success;
we do not count that report as a new Windows acceptance run. Supplied installer
SHA25607af54188572559327a829dab5cb34c794e4335ae381491cf39fc68d152dea6b matches.
Initial full run hit chat-window timing under concurrent workers(10.75s);
unchanged isolated test passed. Select ENKI_RELEASE_TEST_WORKERS=1 for canonical
retry, preserving assertions/timeouts. Signer comments are deterministic for the
same payload/version so interrupted staging can reuse immutable envelopes.
New review regression rejects stale presence after selection changes.92 focused
browser/workspace/workshop tests pass. Canonical0.2.104/runtime63396dc:1094 frontend/6 skips,160 native/3 ignored,83 Hub,3 ASR,15 publisher; build/architecture194/bundle/fmt/strictClippy all pass. Published through an ordinary paired device (admin API403 confirmed), central minisign signer and pinned key. Receipt .local/releases/0.2.104-stable.json; live head and both signed packets verified,36 changed source/19 hot files byte-exact. Native actual-packet acceptance/tamper/version tests pass for BOTH source and hot envelopes. Native fingerprint changed from0.2.103: native update required; application installation remains separate.
Temporary paired key revoked, HTTP401 verified; temporary signing-key copies on Mac/PVE and
device config/key removed. Real signer key retained only in its protected service
directory and original private operator store. Hub/signer active; root-owned deployed
modules match reviewed source SHA256; HTTP user cannot read signer key. Socket
0660 with Hub group, peer UID check. Native application not installed/restarted;
no owner prompts or GPU work. Windows build of0.2.104 not executed here.

Hub now accepts device-authenticated unsigned source/UI candidates, validates
portable bounded files, six manifest versions, app identity and recomputed native
fingerprint. Separate user/socket signer validates again and checks the declared
pinned public key against its configured key, then uses minisign and verifies its
own signatures. Uploaded code never executes on Hub. Local tests are device
attestations; all enrolled owner-device keys now grant release authority, but no
other admin API. Revocation and channel CAS rechecked after signing. HTTP service
cannot read signer key. Existing offline/operator path remains compatible; central
signer is online and trusted. Fresh local source compilation/install stays separate.

# Enki icon (0.2.103)

New imagegen raster master and Tauri-derived desktop icons replace the old E.
Favicon previously referenced a missing legacy PNG; now uses the same master.
Inspected generated 32/128px PNGs and the extracted macOS ICNS 128px image;
glyph remains distinct. PNG dimensions, six Windows ICO entries, ICNS container
length and release version consistency pass. Tauri CLI preserved transparent
corners. UI/favicon use a 256px/73KB derivative rather than the 1.86MB master.
`npm run build` passes. Canonical0.2.103/runtime547981d:1089 frontend/159 native/77 Hub/3 ASR/11 publisher and all gates pass. Receipt .local/releases/0.2.103-stable.json; served head and both signed packets verified,28 changed source files (all icon containers/master/UI PNG) and19 hot files byte-exact. Native fingerprint fb636127… changed: native update required for Dock/tray/launcher. Publication complete; owner installation separate, active agents preserved.
Independent byte verifier initially exceeded Node default1MB stdout buffer on
the1.86MB ICNS; explicit12MB maxBuffer fixed the diagnostic and all bytes match.

# Hub recovery and error diagnostics (0.2.102)

Owner repeatedly could not send: «Библиотека недоступна или сертификат не
совпадает». Node HTTPS with the actual app endpoint/certificate returned200 for
health/model catalog/coordinator, but an explicit Rust client probe reproduced
TCP No route to host/os65. No TLS failure was detected. OS proxies were disabled.
Two Enki LAN privacy entries appeared enabled. After explicit owner approval,
one linked toggle was turned off/on and both entries verified back on. Installed
Enki then displayed authenticated Hub HTTP409 instead of a connection failure.
The separate standalone Rust executable remained LAN-denied; its identity is not
proof that the installed app remained disconnected. No certificate bypass,
proxy/tunnel workaround, other-app permission change or owner prompt was used.
The private temporary diagnostic credential file was removed. Initial TLS
classifier regression exposed io::Error::source skipping its wrapped error;
get_ref traversal fixed it and both native classification tests pass.

HTTP409 uncovered a second permanent fault: an expired cached whole-turn lease
was retained and reused on every send. The client now recognizes ONLY explicit
expired/missing/cancelled ticket responses, clears an inactive reservation and
obtains one fresh ticket before dispatch. Expired requestKey recovery is also
limited to once. Busy/routing/validation conflicts and active runs never create a
replacement reservation. Native error decoding uses bounded allowlisted Hub
responses, not arbitrary backend strings.

Native Hub failures now carry a bounded typed envelope; UI messages distinguish
network, timeout, TLS, interrupted body,401/403/409/429/5xx. Raw URLs, credentials
and response bodies never reach the error message. TLS/auth errors never retry.
The shared retry policy allows three attempts (750ms/1500ms backoff, native20sec
request limit): GETs/read-only retrieval/status, or prepare retaining exactly the
same persistent requestKey. No inference, agent prompt, ingest or unkeyed write
is replayed. Abort and profile changes prevent subsequent attempts. Reconnect
status shows the attempt while the original request/draft remains pending.

26 focused frontend regressions and build pass;2 native tests pass. Actual Hub
already has persisted device+requestKey idempotency, with lost-ack regressions.
Canonical0.2.102/runtime3487913 passed1089 frontend/6optional skips,159 native/
3ignored,77Hub/3ASR/11publisher and build/architecture/bundle/fmt/strictClippy.
Receipt.local/releases/0.2.102-stable.json, head and both signed packets verified:
18 changed source/19 hot files byte-exact. Native fingerprint changed; source/native
installation is required, hot UI alone cannot decode legacy transport failures.
Installed old client resumed Quake2 work after the owner-approved permission
refresh (authoritative session busy and fresh assistant tool execution; no owner
prompt submitted by this operator). Native activation deferred to preserve this
new active work. Two CUA attempts to reopen settings timed out; main-process
sample showed normal AppKit event waiting, not proof of an application deadlock.
No installation/restart or owner agent termination was performed.

# Context transfer from a larger model (0.2.97)

Read-only engine4096/1.18.18 metadata identifies the owner Quake2 incident:
last successful DeepSeek-v4-pro usage415589, context1048576; targetV100Qwen
context262144/input229376. Two subsequent summary assistants used the target
Qwen and failed ContextOverflowError: session too large even after media removal.
No owner prompt, GPU inference, model/provider setting or history was changed.

An isolated clean clone at /Volumes/Extend/work/Enki-context-transition-097
preserves the primary checkout's unrelated pending usage/pricing work. Node
dependencies installed independently; any native build cache copied as independent
files, never a shared Cargo target. Source basea1f0506/Enki0.2.96.

Selection now checks bounded fresh native history and detects a smaller-model
input budget against previous-model measured usage, including cache tokens and
failed zero-usage summary attempts. One native compaction uses the previous
configured larger model before loading the target. Source availability, explicit
compaction-role override and authoritative idle/permission/question state are
checked. Native request explicitly auto:false. No cloud fallback, loop, history
delete/truncate, AGENTS.md mutation or prompt replay is introduced.

A new completed nonempty assistant summary with a non-length finish and a
conservative output/recent-tail budget is required. Pending acknowledgement is
observed for the same request, bounded15minutes including its HTTP wait, without
reissuing it. Cancellation/navigation does not abort already accepted compaction
but prevents committing a late destination. The session guard spans destination
readiness too; manual, queued and scheduled dispatch wait. Confirmed summary is
merged without replacing paginated history or unrelated streamed messages.
«Сжать сейчас» recovers chats that already switched to the small model. Russian
error/stage messages explain the transition. Summary input billing usage is not
shown as the resulting working context.

128 focused frontend tests pass:415k->262k previous-model ordering, HTTP-success
with failed summary, cancellation, unavailable source, authoritative busy state,
no unnecessary compaction, guards through destination readiness, manual recovery,
new/complete/nonempty/non-length/fit verification and pending completion deadline.
Normal same-model compaction is retained. TypeScript/Vite and architecture188 pass.

Actual separately installed1.18.18 ran with isolated HOME/XDG/config and a synthetic
loopback provider, separate ephemeral port and no inherited API credentials. A
noReply fixture user turn followed by summarize(previous large,auto:false) produced
one completed nonempty assistant summary through exactly one provider call.
Original user message remained; no task continuation or target-model call.
NATIVE_COMPACTION_PASS. The first fixture mistakenly selected a user.summary
(diff metadata) instead of assistant.summary; corrected and reran, earlier failed
fixture assertions are not acceptance. All own servers/test data cleaned up.

Canonical0.2.97/runtime79006a5 passed1055 frontend/6optional skips,149 native/
3ignored,77Hub/3ASR/11publisher and build/architecture/bundle/fmt/strictClippy.
Receipt.local/releases/0.2.97-stable.json, served head and both signed packet
verification pass;21 changed source/19hot files byte-exact. Nonempty native
fingerprint equals0.2.96, compatible hot UI packet is available.
Client application remains separate; Windows/Linux live GUI not claimed.

# Dictation tails and MCP notifications (0.2.96)

Owner saw successful dictation followed by HTTP400 and recurring Web Compass
unavailable notices. A synthetic WAV probe reproduced the ASR cause: valid
0.01/0.1-second clips returned400 invalid_audio with a 150ms minimum, while
0.5-second silence returned200 empty text. A stop immediately after encoder
rotation can produce such a tail. We never read or uploaded owner recordings.

SegmentedCapture now allows a newly started final encoder to reach400ms before
stopping, preserving its actual samples and independent container headers.
Recorder failure remains bounded by the original five-second deadline; microphone
cleanup is idempotent. Successful ASR clears recognition errors independently of
capture/storage errors. HTTP hints distinguish audio400, auth401/403, route404,
rate429 and service5xx; genuine failures keep durable recovery.

The actual CT201 CPU GigaAM source is now tracked under services/asr/server.py.
Only the decoded150ms rejection was removed from the deployed baseline; existing
leading0.65/trailing0.20-second padding, model/environment/CPU execution remain.
Zero decoded samples skips inference; corrupt containers/nonalignedPCM still fail.
Deployment compared exact baselineSHA2567323f4f7934680f90ac23d36aef41da0aebb8b3cf4e454dc329c335429d74638,
kept a private backup, verified no establishedASR connections, replaced atomically
and restarted only gigaam-asr.service. Live sourceSHA256d0625cb00cd4ff21e7509bc44756a861cb797c6f74a9e24ff205a6d49c968d1f.
Actual endpoint:0/1/160/1600/8000-sample synthetic silence ->200empty; corrupt
container ->400; previous synthetic Russian speech fixture ->200 with complete
Russian text. Three Python regressions check sample preservation, empty behavior
and real decode errors without loading a model; added to the release gates.

Web Compass actually was down: localhost8787 connection refused; existing
LaunchAgent dev.vladimir.web-compass disabled/unloaded. Re-enabled and bootstrapped
that existing job; authenticated health returned200. Official failed-only
/mcp/mesh_web_compass/connect for quake2-next returned200true; read-back all six
MCPs connected, previously connected tools left alone. No owner prompt, agent
abort, OpenCode restart, global permission/provider/model edit or GPU inference.

McpNotices deduplicates the same outage per endpoint/directory episode and clears
only its own visible message upon confirmed healthy report. It does not clear
unrelated messages, suppress a new outage after recovery or fabricate tool health.
29 focused frontend regressions pass, including immediate stop at rotation,
400ms bounded completion, once-only cleanup, independent headers, recovery from
ASR error to empty success, and outage/recovery notification behavior.

The first full release run was stopped after two test failures while competing
for resources on the active Mac. A concurrent diagnostic run hit test/hook
timeouts. Full Vitest concurrency is now capped at two workers; assertions and
timeouts remain unchanged. Both previously failing suites then passed17/17;
canonical release passed1041 frontend/6optional skips,149 native/3ignored,
77Hub/3ASR/11publisher and build/architecture/bundle/fmt/strictClippy gates.
Canonical receipt .local/releases/0.2.96-stable.json/runtime36c4b61; independent
served head and both signed packet verification passed,23 changed source files
and19hot files byte-exact. Actual multipart short-tail probe also200empty.
Applying a client
update remains separate; Windows/Linux live GUI acceptance is not claimed.

# Fullscreen tray and cached global configuration (0.2.95)

Owner reported a black screen after closing Enki0.2.94 and an access-policy
preflight error. Live UI observation later showed the original chat/draft again;
no owner prompt was submitted. Close-to-tray intentionally keeps the process
running. The previous implementation hid only the main NSWindow, leaving its
fullscreen Space. AppKit application hiding alone was insufficient too: an
isolated actual native fixture showed active=false but hidden=false/fullscreen=true.

The Mac path now observes NSWindowDidExitFullScreenNotification for the exact
live window, exits fullscreen, then hides NSApplication. Reopen restores the
previous fullscreen mode. A pending animation retains its observer and changes
intent on rapid reopen; duplicate close never toggles fullscreen twice. No timer
controls production visibility. Windows/Linux window/monitor hide behavior,
tray-unavailable minimize fallback and explicit quit lifecycle stay unchanged.

`node scripts/check-tray-native.mjs` builds a fixture from actual tray source,
using the existing lockfile, unique app identity and temporary WebView data. It
has no Enki runtime/state/agents/network/model configuration. Actual AppKit:
before-close hidden=false/fullscreen=true; after-close hidden=true/fullscreen=false;
background counter continues; reopen hidden=false/fullscreen=true; duplicate close
plus50ms reopen -> hidden=false/fullscreen=true. Fixture exits0/TRAY_FIXTURE_PASS.
Initial standalone fixture required an icon; first build selected newer transitive
packages, interrupted and pinned to the existing lock. Proposed application-only
hide failed its native assertion, prompting notification-based coordination.
Observer token conversion errors were fixed before the accepted build; a stale
fixture binary was inadvertently rerun once after a compile failure and is not
counted as acceptance. Final repeatable runner builds successfully before running.

Read-only actual engine4096/1.18.18: global config cached four old mutable plugin
URLs while both on-disk layers already held immutable URLs. Scoped disposal left
the global cache stale. [Version-specific configuration source](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/config/config.ts)
uses infinite global caching and invalidates only on a changed API write;
[global API handler](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts)
then disposes all instances asynchronously. V2 active drains do not cover legacy
SessionStatus, which is scoped per instance/directory.

Recovery checks bounded global session metadata including archived records, every
known legacy directory status (four requests at a time), v2 active drains before
and after, current endpoint/cancellation, and complete valid inventory. Busy,
unknown, failed or1000+-row inventory fails closed before global mutation. Exact
verified managed paths only; unrelated plugins/permissions preserved. Native CAS
stages the plugin array with equivalent whitespace so an already migrated file
still causes a real API invalidation. Subscribe before PATCH; wait for actual
`global.disposed`, not just its earlier HTTP acknowledgement, then verify scoped
policy and reconnect shared/browser MCPs. Global event handling invalidates
attachment caches even if the initiating caller was cancelled. No model request or retry is created.
This is an idle preflight, not an atomic exclusion lock against independent
external clients starting new work after the check.

Isolated installed engine with temporary XDG roots/--pure reproduced cached old
config after scoped dispose and then recovered with official PATCH, completion
event and fresh global/scoped readback. First probe expected server.disposed;
actual wire tracing identified global.disposed, corrected transport/tests. The
server and temp directory were removed in finally. No owner state was used in
this probe. Production headers/body data are not logged.

Owner repair used the same tested helper after verifying the immutable four-file
SHA graph and realpath aliases. Whole-engine idle verified; private ignored0600
backup and CAS staging; actual global completion acknowledged, global/project
managed URLs fresh, entire parsed global config equal before/after. No owner
prompt/inference/agent abort/game action/server kill. Existing UI error clears
on the next normal send. Private evidence under.local/review/0.2.95.

Focused80 frontend regressions pass before final gates (includes new fallback
integration), TS/build/architecture186 and native cargo check pass. Canonical
publication verified:1037 frontend tests/6 existing skips,148 native/3 existing
skips,77 Hub,11 publisher; build/architecture186/bundle/fmt/strict Clippy PASS.
Runtimea9c8057, receipt.local/releases/0.2.95-stable.json, served head/revision and
both signed downloads verified.23 changed source and19 hot files byte-match the
reviewed commit/dist. Native fingerprint61dffc33… differs from0.2.94. No owner
installation/activation was performed. Native fingerprint changes: installing
the source update is required for the Mac tray fix. Owner activation and live
Windows/Linux GUI acceptance remain separate.

# Bounded active conversations (0.2.94)

Read-only owner diagnostics: Quake history has 33,285 parts / 233,237,340 JSON
characters; NFS has 5,567 / 28,465,541. Recent 200-message pages are about 3 and
5 MB, respectively. No owner conversation replay, database write, model call,
engine restart, game action or heavy owner UI opening was performed.
A WebKit CPU report at 11:42–11:45 shows 90 CPU seconds / 165 seconds, peak
footprint 1.49 GB and Intl.DateTimeFormat construction in sampled stacks. It
predates the 14:38 reboot and does not identify Enki conclusively. No claim that
this report proves the reboot's cause.

Confirmed source defects: the first visible message remained anchored while a
following conversation grew indefinitely, so the mounted range and restored
range were unbounded. Entire cached order was grouped on every update. Footer
formatters were constructed repeatedly. Hub retained full serialized receipt
strings and cleared them above 5000, resending unchanged history repeatedly;
collection/stringification was synchronous. Task observation copied/reversed and
mapped the whole history on every live delta to find the latest user message.

Fixes bound following rendering to 60 messages and detached reading to 120,
provide overlapping older/newer windows, preserve reading/search/latest across
switches, and never delete canonical data. Four lazy date formatters are reused.
Oversized Markdown (>32k chars or >300 newlines) uses a bounded plain-text page
instead of a giant parsed DOM; copying preserves the entire original. Hub uses
incremental collection, batches/yields every 25 entries, weak SHA256 receipts
stored only after native acknowledgement, cancellation and retry preservation.
Latest-user observation scans backward until found without full-history copies.

Behavior coverage includes 20k-message tail growth/cached return; fixed reader
window while appending; reader restore, search focus, newer/latest navigation;
2000 timestamp sets with exactly four formatter constructions; 100 live events
in a 20k history with only 100 message lookups; 5050-record Hub replay/change,
batch limits, UI yields, failed acknowledgement, disposal and production SHA256;
large Markdown paging and full copying.

Isolated Chromium fixture exercised the actual ChatView/scroll controller and
Markdown, with test-owned state and simple message renderer adapters (not owner
state or a whole native-app benchmark). 20 alternating switches, 100 appends,
older/reveal/newer/latest and large-text next page pass; zero JS errors. Tail60,
reader120, final151 DOM nodes/~31.5 MB JS heap. Median switch34.7ms includes a
forced20ms wait, not a pure latency measurement. Initial fixture missed Vite's
React preamble; corrected transformIndexHtml. Test server and browser closed.
The source-only change is hot-compatible with native0.2.93; installed owner0.2.92
still needs the native0.2.93 extension cache fix included in this source release.
Owner native freeze/reboot acceptance, Windows/Linux GUI remain unverified.

Canonical `npm run release:local -- stable` passes:1029 frontend tests/6 existing
skips,148 native/3 existing skips,77 Hub,11 publisher, build/architecture184,
bundle budget, fmt and strict Clippy. Runtime1e35bc2 published, canonical receipt
`.local/releases/0.2.94-stable.json`; served head/revision and both signed
packet downloads verified.20 changed source files and19 hot files byte-match
reviewed commit/dist. Native fingerprint4015934d… matches0.2.93. Publication
offers an update; owner application has not been installed/restarted/activated.
Final fixture run after toolbar wrapping:151 nodes,~31.2MB heap,median31.6ms
including forced20ms wait,zero errors.52 focused tests pass. The first new chat
integration test used .tsx, outside this repository's test glob; renamed to .ts
and verified in the focused52 and full1029 runs. No unrun test is counted.

# Engine extension cache invalidation (0.2.93)

Owner installed0.2.92 and on-disk policy already contains the directory alias fix,
but stack line23 still comes from the old policy. Effective config contains both
legacy opencode-desktop and canonical enki mutable policy URLs, plus the old
mutable browser hook. Bun caches these modules beyond instance disposal.

Metadata-only isolated probe against actual1.18.18 server: temporary plugin sets
a config marker, GET experimental/tool/ids initializes extensions. Rewriting the
same file then disposing ONLY that test directory leaves old marker; changing
module URL then disposing loads fresh marker. Config hook completion is async:
first observation ran too early, bounded marker polling corrected the probe.
Final output: samePathAfterDispose=enki-probe-old,
immutablePathAfterDispose=enki-probe-fresh. No session/prompt/inference/tool calls;
test-only instance disposed and directory removed in finally. Owner instances,
server, browser and configs have not been changed or restarted.

New native module stages a bounded locked immutable graph of policy, execution
feedback, browser session identity and browser before-hook under SHA256 of all
filenames/content. Any dependency change changes all module URLs. Existing
immutable content is verified and tampering rejected. Previous revisions are
retired only if their on-disk digest is valid; app-root aliases require actual
canonical identity. No unrelated same-name files or plugins are removed.

Browser/shared JSONC writers migrate verified managed entries once, preserving
foreign plugins/order/comments/permissions. Both config layers are written before
checking loaded effective config; presence of new URL alone is insufficient if
old managed URLs remain. Only idle selected-directory instance is disposed;
busy/unconfirmed work is not interrupted. Scoped MCP connections reconnect after
reload. Existing legacy mutable materialization remains for old-client support.
65 focused frontend tests and native graph digest/alias/idempotency/tamper test
pass. Native test first found missing Debug derive, now fixed. Native update
required; no owner activation performed. Windows/Linux live acceptance separate.
Canonical0.2.93/runtimec93b446 passed1020 frontend tests (6 optional skips),148 native tests (3 optional skips),77 Hub tests and publisher/build/architecture/budget/fmt/strict Clippy. Receipt.local/releases/0.2.93-stable.json; served head and both signed packets byte-exact17 changed source/19 hot files. Native fingerprint changed: source/native update required. Owner activation/current-session recovery after apply remains unverified.

# Conversation UI performance (0.2.92)

Message rendering previously subscribed to the entire app store. Stream reducer
slots are mutable, so a naive slot-reference selector would lose updates. New
presentation selectors compare actual immutable part values and status/connection
primitives. They see same-tick deltas/removal/disconnect while leaving unrelated
message parts stable. Turn memoization compares message identities and all public
props. Newly opened folded history keeps lightweight anchors and mounts heavy
step bodies on disclosure; visited bodies remain mounted to preserve editor/fold
state. Closed tool cards defer JSON serialization to their mounted details.

Navigation aborts obsolete GET history requests, never agent execution. Cross-
directory cached target is selected synchronously before runtime metadata awaits;
selection-generation guard prevents late metadata from reopening an older choice.
Uncached history still follows the existing scoped stream/startup reconciliation.
66 focused behavior tests pass including state/routing, folded progress, hidden
input serialization, mutable-slot/background deltas, cancelled history reads and
cached navigation/latest-selection races. Existing fold/anchor/live/errors tests
remain intact. No user session, browser action, prompt or inference was replayed.

Isolated Chromium/Vite fixture uses actual components, a test-owned external
store, actual reducer events and original2317864 render source as baseline:
30 long historical steps + final answer,3 cold/remount samples. Before
[1188,964.9,700.1]ms /7920 DOM nodes; after[72.1,7.5,8.3]ms /60 nodes.
30 actual background chat deltas:30 answer commits/306ms before,0 commits/1.9ms
after. Updated visible answer text still renders;30 step code blocks mount on
expansion and fold again. First diagnostic fixture import needed its relative
lazy path normalized; final clean run passes without page errors. Test scripts,
JSON and screenshot are in ignored.local/ui-performance-092; own servers/browser
closed in finally. Numbers describe this dev-browser fixture, not all native
navigation or CPU/engine responsiveness. macOS WebKit/Windows/Linux live owner
acceptance remains separate.
Canonical0.2.92/runtime1fb4663 passed1017 frontend tests (6 optional skips),
147 native tests (3 optional skips),77 Hub tests and publisher/build/architecture/
budget/fmt/strict Clippy gates. Receipt.local/releases/0.2.92-stable.json;
served head+both signed packets verified byte-exact13 source/19 hot files.
Native fingerprint equals0.2.91, allowing hot activation from that version;
older incompatible clients still need the full native update. Owner activation
not performed; no agent/browser/engine restart.

# Migrated session directory identity (0.2.91)

The affected projectless session still records its original opencode-desktop/chats
path. The app root has physically moved to enki, with the legacy directory alias
retained. Read-only database/API metadata and fs realpath show both paths point
to the same existing directory. Access-policy compared path strings, rejecting
valid old sessions before prompt dispatch and browser permission derivation.

On mismatches, the common plugin now verifies realpath equality and a directory
target. It retains exact session IDs, scoped API queries, bounded ancestry/cycle
checks, inherited full/ask/read behavior and denies missing/foreign/redirected
paths. Update acknowledgements also verify the returned ID/directory before
accepting applied policy. No path-name substitution or permission broadening.
Seven tests cover aliases, mixed ancestry, browser metadata, read revocation,
invalid IDs/cycles, foreign/missing/redirected paths, file targets and bad update
acknowledgements. File-symlink test is skipped on Windows (requires privileges);
directory fixtures use junctions there.23 focused tests pass.

Actual affected session was resolved by the new helper against the installed
1.18.18 engine API, read-only, with its existing full policy. No prompt replay,
model calls, browser actions, session/database edits or owner process restarts.
There are22 existing engine sessions under legacy app-owned paths; official
session PATCH schema cannot change directory. Removing aliases requires a
separate complete migration of engine references and historic paths; this fix
preserves them and does not claim that migration or current activation occurred.
Canonical release0.2.91/runtime3d90d11 passed1012 frontend/147 native/77 Hub tests plus publisher/build/architecture/budget/fmt/strict Clippy. Receipt.local/releases/0.2.91-stable.json,served head+both signed packets byte-exact9 source/19 hot files. Native update/new extension instance required; no owner activation. Windows/Linux live acceptance separate.

# Generic command execution feedback (0.2.90)

OpenCode can mark a tool call completed while its terminal shell metadata reports
process timeout. A shared, bounded terminal-marker classifier now adds explicit
unsuccessful-check feedback and diagnosis guidance to OpenCode/Pi shell results.
OpenCode retains the actual output/exit metadata and adds an outcome/title; Pi
preserves original content/images and its error flag. No new process manager,
command rewrite, automatic retry/kill, timeout cap or approval bypass is added.
Ordinary log mentions of timeout do not trigger feedback. This is advisory
execution evidence, not a security boundary or a guarantee of model compliance.

Per-dispatch workflow v3 covers supported launch options, env vs arguments,
observable success, GUI/server readiness vs lifetime, bounded log inspection,
exit status and diagnosis before retry. Exact same-session v1/v2 Pi history blocks
remain hidden, while quotes/attachments/foreign-session text remain intact.
Native resources materialize the common helper for both agents, including when
shared MCP runtime is absent. Missing Pi diagnostic helper cannot grant approval.

27 focused tests pass. Actual installed Pi bash executor ran only isolated
`sleep 2` with0.1s deadline and `echo fixture-ready` in /tmp: timeout classified,
success unchanged, no model calls. Original Quake session/game/engine/processes
untouched. No owner update activation/restart; runtime hooks require native
update and a subsequently loaded engine instance. Windows/Linux live acceptance
and future model behavior remain unverified.

Canonical release0.2.90/runtime50a8ee5 passed1005 frontend tests (6 optional
skips),147 native tests (3 optional skips),77 Hub tests, publisher tests,
build/architecture/bundle/fmt/strict Clippy. Receipt
`.local/releases/0.2.90-stable.json`; served canonical head and both signed
packets verified,16 changed source/19 hot files byte-exact. Native resources
changed, so this is a source/native update. No owner activation or server restart.

# Optional MCP resilience / Node alias launch (0.2.89)

Diagnosis: Web Compass HTTP/API credentials and OpenAPI were healthy, but its MCP
Node entrypoint compared import.meta.url (resolved target) with argv[1] (legacy
root alias), then exited0 with no output. Actual shared SDK discovery failed with
connection closed; canonical entrypoint discovery succeeds with27 tools and no
tool calls. A synthetic isolated script reproduces both outcomes. Shared stdio
launch now canonicalizes only an absolute Node JS main script, preserving other
arguments/cwd and non-Node commands; missing scripts retain their startup error.

Shared MCP preflight also blocked ordinary prompts on any optional server failure.
It now reports unavailable tools, continues other connections and applies30s
fingerprint-scoped reconnect cooldown. Explicit invalidation/revision changes can
recover. Missing optional runtime is reported honestly with no connection call;
that test expectation changed with the explicit nonblocking product contract.
Configuration ownership/CAS, access-policy loading, disabled-tool disconnects and
changed contexts remain fatal. Store reports a warning without setting sendError.
71 focused tests pass. New Node helper is included in embedded runtime resources.

Current owner Web Compass args[0] was normalized under registry.lock/CAS/atomic
replace with a private backup; whole registry verified equal except that argument.
Only the failed scoped MCP was reconnected via official API; connected confirmed.
No model prompt, queued task, game action, inference or shared engine restart.
Canonical release:999 frontend pass/6 existing skips,146 native pass/3 existing
skips,77 Hub tests; publisher/build/180-module architecture/budget/fmt/strict Clippy
pass. Receipt `.local/releases/0.2.89-stable.json`; served head and both signed
packets verified,15 changed source/19 hot files byte-match runtimeac032a9.
Owner app activation was not performed. Windows native GUI/alias acceptance remains
separate from Unix synthetic tests.

# Built-in skill path migration (0.2.88)

Read-only inspection confirmed that the authoring source's retained legacy path
and current Enki root resolve to the same installed bundle. Lexical starts_with
incorrectly classified it as a user source. The permanent ownership check now
compares canonical locations, requires a direct bundle child with the shipped
64-character hash identity and rejects leaf links/missing/foreign locations.
The retained root alias is accepted without relaxing the built-in bundle guard.
Existing disabled choice, foreign sources, immutable content checks and CAS remain.

A real rename plus legacy symlink regression fails before the fix, then passes;
four focused native authoring tests cover idempotency, disabled/foreign source
preservation, changed built-in files and redirected directories. The current
owner registry was repaired under the actual registry lock, with a private backup,
expected-content check, atomic replace and verification that only one source path
changed. No prompt or game action was sent and no engine/agent/browser restarted.
Other inspected registry path checks already canonicalize; no further confirmed
registry defect was found. Canonical release:995 frontend pass/6 existing skips,
146 native pass/3 existing skips,77 Hub tests; publisher/build/architecture/budget/
fmt/strict Clippy pass. Receipt `.local/releases/0.2.88-stable.json`; Hub head and
both signed packets verified,8 changed source/19 hot files byte-match runtime7481c97.
No owner installation/activation performed. Live Windows junction/GUI acceptance remains separate
from the Unix migration regression.

# Enki MCP identity migration (0.2.87)

Read-only installed-client inspection: Enki0.2.86 uses primary CLI enki, while
its browser MCP entry retained the previous opencode-desktop executable. The
browser adapter and shared registry checked basename equality only, incorrectly
classifying the shipped legacy identity as foreign after the rename.
A common executable-identity helper now recognizes exactly enki/opencode-desktop
(and their Windows.exe variants) across absolute paths. Callers still require the
private browser/shared mode flag; shared entries also require exact scope and
server IDs. POSIX names remain case sensitive, Windows drive/UNC paths fold case;
foreign or malformed entries remain protected. Migration preserves JSONC comments,
permissions, other tools and repeat configuration without further changes.

Four migration regressions fail before the fix; 68 browser/shared/Pi/helper tests pass
after it. A full browser setup regression verifies configuration CAS and successful attach.
Additional helper tests cover reverse migration, UNC, relative paths,
foreign names and case/platform mismatches. No owner config was manually rewritten,
no engine/agent/browser restart or game action performed. Native inputs other
than normalized version metadata are unchanged from0.2.86 (hot update compatible).
Canonical release:995 frontend pass/6 existing skips,144 native pass/3 existing skips,
77 Hub tests; publisher/build/180-module architecture/budget/fmt/strict Clippy pass.
Receipt `.local/releases/0.2.87-stable.json`; Hub head and both signed packets
verified,13 changed source/19 hot files byte-match runtime6b6fb04. Published native
fingerprint matches0.2.86. Windows/Linux real GUI qualification remains separate
from portable policy tests; owner activation was not performed.

# Web discovery recovery (0.2.86)

Read-only inspection identified repeated webfetch HTTP404s from guessed repository
names, independent HTTP403s on two public search providers, and generic GitHub
RSS results accepted because the anchor was the generic term software. Missing
URLs are not evidence of an engine outage or access-policy failure.
Two regression tests fail before the fix and pass after it: generic software RSS
must not satisfy a Quake repository query, and repository fallback must use the
project anchor. Existing provider cooldown/cancellation/query-specific health
semantics remain intact. The common skill and both engines' per-prompt reminder
now describe404 recovery through verified repository metadata/default branch/tree;
legacy Pi history blocks remain hidden without stripping quotations or files.

45 focused search/prompt/engine-routing/skill checks pass. Canonical release:
989 frontend pass / 6 existing skips, 144 native pass / 3 existing skips,
77 Hub tests, publisher/build/179-module architecture/budget/fmt/strict Clippy pass.
Receipt `.local/releases/0.2.86-stable.json`; Hub head and both signed packets
verified, 13 changed source files / 19 hot files match runtime6365de0. Live read-only public
GitHub repository search returns id-Software/Quake-2; its API metadata reports
master and its game/g_target.c returns HTTP200 with the expected symbol.
No owner prompt, game edit/tool replay, model inference or engine restart.
Public provider403s remain real access denials; this change does not claim to
restore those services or guarantee future model adherence to guidance.

# Full access / doom_loop (0.2.85)

Screenshot diagnosis: OpenCode 1.18.18 processor asks doom_loop with only
`agent.permission`, ignoring the invoking session policy. Source checked against
[tagged processor](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/processor.ts#L347)
and permission evaluator. Full session rules now include an explicit loop allow;
both legacy signatures migrate via the scoped plugin before the next prompt.
The client adapter handles this engine exception using a one-time official permission API response
only after validating the exact session/root directory and explicit full mode.
Other permissions, inherit/ask/read and foreign sessions retain manual handling.
A missing context, API error or ambiguous timeout leaves the prompt available;
no global approval or automatic request retry is installed.

Focused regression: 41 tests pass (adapter events/reconnect/deduplication, access/inheritance, queue access, child routing); 108 earlier store/Pi/capability checks pass.
The running local engine schema confirms both official permission reply routes.
No UI layout changes; backend event handling also supports an already-running engine.
Canonical release: 986 frontend tests pass / 6 existing skips; 144 native tests /
3 existing skips; 77 Hub tests; publisher/build/architecture/bundle/fmt/strict Clippy pass.
Hub stable 0.2.85 receipt `.local/releases/0.2.85-stable.json`; served head and
both signed packets checked, 13 changed source files / 19 hot files byte-match
reviewed runtime `2d9cd1a288d439e33c4f641eaa89573c93a7bda4`, pushed to main.

Owner game/desktop tools and inference were not replayed. No app restart or
externally managed engine restart. Live owner-session acceptance after updating
is separate from isolated policy tests.

# V100 — квалификация профилей и шлюза (2026-10-20)

Reviewed runtime `e8c04d03401a9de75790984232540b413498f085` pushed to `main`; server profiles already active.

Server-only rollout in VM5100: original four checkpoints/quants, contexts,
Medium/native budgets and OpenCode/Pi policies retained. GPU stays in VM5100;
RTX5090/Strata unaffected. Canonical source and primary-source research:
[services/v100](../services/v100/README.md); aggregate synthetic results:
[qualification.json](../services/v100/qualification.json).

Selected: old NInfer7e626a68 + Linux SO_REUSEADDR for both Qwens, original
llama.cpp f916130 with both target/draft embeddings on CUDA for Gemma/Artemis.
MTP4 for Qwens/Gemma, MTP2 for Artemis; original native contexts262144/131072/
196608 and inactive host-cache limits. Native graph audit found0CPU text nodes
(21917CUDA Gemma/26864CUDA Artemis); CPU Vision allowed, Gemma uses it.

Quality: unchanged8/9 functional cases for Qwens/Gemma,9/9 Artemis. Coding:
20/20 assertions for both Qwens/Artemis, unchanged15/20 Gemma (existing invalid
JSON escape prevents execution of one five-assertion task). Cold long retrieval
passed at226108Qwen/117909Gemma+OCR and173727Artemis text tokens; Artemis warm
prefix also passed with2.259sTTFT. Short CPU-free768-token Medium runs: Huihui
55.04–68.52, Pi38.36–49.84, Gemma61.34–74.64, Artemis44.92–57.10tok/s. Gemma
retains speed after full GPU placement; Artemis short gains7–11% versus paired
original runs, with long decode16.15 versus16.56tok/s. Small regression suites
cannot prove universal model quality.

Rejected candidates remain explicit: IK6.48/5.21tok/s pilots; new NInfer Gemma
sampling cap20 versus native64, Artemis unsupported Q4_1; both new Qwens fail a
fair226108-token/full-resolution test by exhausting4096tokens in reasoning;
expanded Volta flash fails an independent65K-key FP64 oracle with unchanged
thresholds. Early CPU-Vision256-token image probes were not equivalent and
are excluded from quality conclusions. Tokenizer3032parity cases and13CUDA
oracles alone were insufficient for release. Workspace/tokenizer patches are
retained for reproducibility, not used to authorize the rejected runtime.

13gateway HTTP/startup/TCP tests passed on Mac and Linux. Silent-prefill client
cancellation regression failed original code before the fix; normal SSE,
keep-alive/follow-up, model gate, legacy/new startup enums and blocked native
management routes pass. Socket-handoff regression reproduced both TIME_WAIT
directions before the fix. Full app TS/Vite build, architecture176 and unchanged
bundle budgets passed; Rust unchanged. Existing Vite warnings retained.

Deployment used idle/GPU-empty checks, CAS against original registry/source,
verified24immutable llama release files and Qwen binary44ea4ad416ba0085f0356190dd1b111cdd1fba0171742cf5a902263a96faa1c7.
Live registry8a837cf4e698d95bd71ec694302494a50ce7e77a898cab5967af2f1d9120a3b5,
gateway5421a6e8b1e49b4d242cbc0284adcb6702d75c50a1e7c4de0c78a6674a170588.
Production healthy on VM and existing Mac forwards; seven real isolated read-tool
turns passed (3OpenCode/4Pi, Medium, random JSON marker), only completed read
calls observed. Own OpenCode test sessions removed; Pi used no persisted session.
[Live acceptance receipt](../services/v100/acceptance.json): all four models
passed actual GPU-prefill and decode cancellation plus distinct follow-up JSON.
Gateway lease released in0.405–0.454s; next native first token0.188–3.035s.
Pi-only model refused OpenCode with403 before inference. DefaultQwen ready,
0active requests and one GPU compute process confirmed. Own maintenance leases/
test device released/revoked, private forward closed, metrics/fallback timer
stopped; existing18021/18008 forwards remain healthy. Removed only the unused
own converted Gemma artifact(19083598848B); original weights retained.
No empty desktop package is needed to activate server-only profiles; Windows/
Linux desktop interaction was not separately exercised.

# Enki 0.2.77 — output-limit recovery (2026-10-19)

Incident: two real `finish:length` stops at16,384 output tokens, with repetitive
reasoning tails; no transport error. Private history saved (2,928messages),
authoritative idle checked, one normal manual compaction completed with
`auto:false` (about250sec); one authorized corrective task sent through the
normal native control/send path, same Qwen/engine/session, Medium, no automatic
continuations. Resumed agent completed six actual tool calls across five model steps (checkpoint,
source search and scenario inspection), with no new errors or length stops at
the checkpoint. It continues without duplicate prompts. No game code, shared
model/sampling configuration, engine process or GPU ownership changed by repair.

Published to Hub/stable from runtime `5199f6d`. Canonical gates: **951frontend,
133native,74Hub,9publisher passed**, with6frontend/3native existing opt-in skips.
TypeScript/Vite, architecture176, unchanged bundle budgets (main1,398,946B /
gzip398,087B), fmt and strict Clippy passed. Real isolated Chromium380/1000px
keyboard/one compaction/zero agent dispatches/no overflow/page errors passed.
The extra regression preserves the draft and blocks a racing manual prompt
while compaction is pending.

Canonical receipt `.local/releases/0.2.77-stable.json`, served head and both
actual downloaded packets verified. All20 changed source files match runtime
Git; all15 hot files match `dist`. Both actual packets also passed the native
pinned-key verifier, including tamper/version and source fingerprint checks.
Native fingerprint unchanged from0.2.76. The installed client reports an
available **hot**0.2.77 update; no compilation/app restart/application of update
was forced. Source1,135files/14,263,208B; hot6,538,581B.

Final live recovery check:12 completed tool calls across12 assistant steps,
zero tool-status errors and zero new length stops; same session/model remains
busy on Medium. This proves resumed execution, not completion of the game port.
See [behavior and constraints](OUTPUT-LIMIT-RECOVERY.md). Source/docs are pushed
only after verified Hub delivery; no owner app/browser/engine restart.

---

# Enki 0.2.76 — session-guided tool reliability (2026-10-18)

Published to Hub/stable from runtime `33724a7`. Canonical gates: **943 frontend / 133 native passed**, 6 frontend and
3 native existing opt-in skips. TypeScript/Vite, architecture174, raw/gzip bundle
budgets (main1,398,016/397,894B), format and strict Clippy passed. Both changed
skills validated. Canonical publisher9 and Hub74 tests also passed. No active owner app, model, external engine or game project changed.

Reviewed full2,127-message snapshot and all60 actual tool failures; no private
history is published. Reproduced the principal Cua implicit-session failure on
the installed0.28.2 driver, then verified a separate source proxy through real
MCP discovery/own-session reads/end/start (22tools). Explicit session works,
missing session fails before forwarding, closed session stays refused until an
intentional start. No GUI input, screenshots or model inference in acceptance.
See [findings and boundaries](TOOL-RELIABILITY-REVIEW.md).

Canonical receipt `.local/releases/0.2.76-stable.json` and served head verified.
Both actual signed packets passed the native pinned-key verifier, including
negative tamper/version checks. Source1,130files/14,239,713B, hot14files/6,535,359B;
all23 changed source files match runtime Git and all hot files match `dist`.
Installed native client reports connected/available/source0.2.76. No installation
or working-agent interruption. Installing/reconnecting the owner's native tools
is a separate action. This documentation follow-up does not replace the signed
runtime revision or require another empty release.

---

# Enki 0.2.75 — central Hub model readiness (2026-10-18)

Published to Hub/stable from runtime `d129e31` (feature `53dd2a5`). Canonical final
gates: **940 frontend / 130 native / 74 Hub / 9 publisher tests passed**, with
6 frontend and 3 native pre-existing opt-in skips. The first publisher gate
stopped before publication on a 2.9KB raw-main budget overrun; native-only lazy
coordinator loading plus an awaited dispatch barrier fixed it without raising
the budget (main1,395,966B / gzip397,046; settings137,643B / gzip35,376).

Canonical receipt, served revision and both downloaded packets verified. All33
changed source files match the runtime commit; all14 hot files match `dist`.
The existing native pinned-key verifier independently passed both actual signed
packets, including tamper/version rejection and source fingerprint verification.
Source packet1128files/14,203,733B; hot6,532,663B. Installed0.2.74 reports an
available **source** update0.2.75. No application installation or agent restart.
Final read-only Hub check:9routes, anonymous access401, Artemis and Flash Next
both ready. Private receipts remain outside Git. This follow-up documentation
commit does not replace the signed runtime revision or need an empty release.

Reproduced the exact owner's Artemis failure: the configured provider had no
model-control binding; the VM gateway still had Qwen resident and returned 409.
The owner's failed prompt was not replayed.

Shared catalog v2 now explicitly routes nine engine/model pairs through Hub:
V100 VM5100 uses its existing switching gateway; RTX5090 VM5200 is monitored as
an always-resident fixed server. Private gateway registry and credentials live
only on CT206. Source, gateway processes, inference URLs, model/variant settings
and physical GPU ownership remain independent. See [architecture and protocol](MODEL-SERVICES.md).

Checks before publication: 939 frontend passed / 6 existing opt-in skipped;
130 native passed / 3 existing opt-in ignored; 74 Hub passed locally and on the
actual Debian container. TS/Vite, architecture173, bundle budgets, fmt and strict
Clippy passed. Canonical publisher repeats the required gates before signing.

Real Hub + isolated Chromium using the production Composer: an actual Qwen run
reservation held Artemis in waiting; Stop kept the draft with zero engine
submissions. Releasing it produced real unload/load/ready transitions on V100;
the isolated stub engine was invoked exactly once only after exact Artemis
readiness. No inference or owner-history changes were needed for that gate test.
Flash Next remained ready on the separate GPU. Wide/narrow layout and page errors
were checked. A second real-Hub test held Artemis while Gemma waited: three
unrelated-chat lease heartbeats could not overwrite the selected chat's status;
Stop cleared progress without an error or dispatch. Artemis stayed resident.

Hub restart retained its existing catalog/data. Updated coordinator/catalog code
passed Linux tests before deployment with private backups; catalog v2 preserved.
Control metadata cannot be silently stripped by old clients' editors. Expiring
reservations, explicit idempotent retry after a lost ack, lease scope, failures,
cancellation races, loader progress, independent GPUs, fixed-server exact model
checks and draft preservation are covered by tests. No auto prompt replay or
implicit inference fallback. Old direct clients must upgrade to participate in
whole-turn coordination. Offline clients lose reservations after ten minutes;
see the protocol's limits rather than assuming an indefinite lock.

Installed Mac0.2.74, external OpenCode and owner agents were not restarted or
modified. Test-owned Vite1431 and fixtures were removed. Windows/Linux runtime
acceptance is separate; cross-platform source is delivered by the signed Hub
release. Publication receipt and actual served-packet verification are recorded
in the follow-up release checkpoint. No installation is claimed here.

# Full access consistency — 0.2.49 (2026-10-11)

User explicitly requested Full access across both agents, delegated sessions and
shared tools. Per-chat selection now applies to OpenCode/Pi, persists through Pi
forks, and replaces an idle Pi process after policy changes. The independent
shared OpenCode plugin propagates root-chat permissions without altering role
prompts or answering approval requests. Browser policy is obtained from the real
invoking session; model-supplied Pi context is stripped. Restricted and full
Playwright MCP connections are separate.

Validation: 732 frontend tests passed, 6 existing opt-in skips; 101 Rust tests
passed, 1 existing vault ignore; locked all-target check, TypeScript/Vite build,
focused browser/registry 28 tests, skill validator and diff check passed.
Actual isolated OpenCode 1.18.18 loaded the project plugin, inherited full rules,
revoked inherited full rules after the parent became read-only, and reloaded an
idle scope without restarting the external server. No inference was performed.
Actual isolated Chromium denied an external screenshot path in restricted mode,
allowed it in Full access and denied it again after switching back. Pi policy
persistence/process selection and tool gating have automated regression coverage;
no new live Pi inference or Windows/Linux qualification is claimed.

Final Mac app signature and DMG checksum passed. Installed/reopened 0.2.49;
installed binary equals the final package:
`965e18322b9455534dddede6e0670b0f0e54d49dc20d2aa2ca57f6e91cbeb9f0`.
Actual selected-project policy is loaded and the installed common/browser policy,
Pi extension, browser adapter, daemon and session transport match source bytes.
Native control is connected with no error; external OpenCode 1.18.18 retained its
original PID. No owner prompts, inference tests or GPU changes were submitted.
CUA image capture initially failed on the nearly full system disk; verified old
0.2.46/0.2.47 app backups were moved to the external workspace before update.
The preceding installed 0.2.48 app was preserved as an installation backup.
Private engine config, session history, tokens and test receipts are excluded.

# Local session repair — 0.2.36 (2026-10-09)

672 frontend / 94 Rust / 2 Node checks, final Mac package and isolated real
Chromium/SDK session routing passed. Installed/reopened locally; no push/release.
See [repair evidence and limits](SESSION-RECOVERY-0.2.36.md).

# Windows 0.2.35 archive integration — 2026-10-09

Reviewed `Enki-0.2.35-Windows-installed-20261009.zip`: all 26 payload sizes
and SHA256 hashes match the supplied manifest; all 957 tracked source files
match bundled HEAD `4842d2c7501063ca645da158941b7e65321c2e1f`. Its exact
ancestor is main `0705a1491494a03115a1da20b9e4c77753dc4e34`; the three source
commits were fast-forwarded without replacing newer work.

Accepted the Git-for-Windows `NUL` global-config fix while retaining system/global
config isolation, real unprivileged junction fixtures, a strict browser acceptance
result parser, and a Windows-only Job Object child/grandchild regression. Added
its two Node parser checks to the existing desktop CI matrix. No version,
dependency, capability, browser production behavior or UI change.

Independent Mac checks: 654 frontend passed / 6 existing opt-in skipped;
2 Node parser checks passed; `npm run build` (TypeScript/Vite), `npm run eval:check`,
Cargo fmt, locked all-targets check and Rust tests passed (94 passed / 1 unchanged
vault opt-in ignored). Existing Vite chunk/dynamic-import warnings remain.
No live UI or inference test was needed or run for this platform-specific import.
The installed Mac 0.2.35 remains unchanged; Windows-only Rust behavior was not
executed on Mac. Owner chats/settings, external agents and GPU services preserved.

Windows verification is supplied-agent evidence, not a Mac rerun: 654 frontend,
78 Rust, 37 Hub and installed browser/MCP acceptance. See
[the original report and limitations](WINDOWS-RESULT-0.2.35-20261009.md).
The unsigned Windows installer is retained locally with its verified manifest;
it is not a new build from the Mac and is not placed in Git. Existing release
tags/assets are unchanged; importing source does not requalify old binaries.

# Enki 0.2.35 — configured model discovery (2026-10-09)

Configured model rows are independent of transient readiness. The picker adds
read-only refresh, last-known public service metadata and agent policy, and an
awaited selection with a modal warning/retry. Explicit configured choices remain
selected offline; a late check cannot write a choice into another chat. Service
keys remain in the native vault. Cached metadata does not authorize execution.

Validation: 654 frontend tests pass, 6 pre-existing tests remain skipped;
TypeScript/Vite and the Mac app/DMG build pass. Existing fail-closed policy and
credential tests remain unchanged. Added regressions cover offline relaunch,
endpoint changes, policy updates, deleted bindings, public-field-only persistence,
provider aliases, access failures and stale selection. The Pi picker test was
updated because the owner explicitly requires unverified configured rows to stay
visible; real access evidence and prompt gates remain separate.

An isolated real browser UI used deliberately unreachable test-only endpoints:
refresh retained the configured row and reported the connection error; selection
opened a native HTML modal, retry failed honestly, and closing restored the editor.
No synthetic result is claimed as inference evidence.

Installed native Mac 0.2.35: OpenCode's picker contains the uncensored 27B entry
and excludes the Pi-only entry; Pi's picker contains both 27B entries. Native
catalog refresh completes without inference. Selecting the already-loaded V100
model confirmed exact service readiness and a 262144-token context. The new chat's
original OpenCode/DeepSeek Pro choice and effort were restored; no owner prompt,
existing chat, global agent configuration, service lifecycle or GPU assignment was
changed. The V100 remains on the uncensored model. No Pi inference trial, GPU speed
benchmark or Windows/Linux live test was run for this UI fix.

The installed executable matches the signed build SHA256
`712a6fe79aadb3ac69407e735722b9c14d37da4b9cfc33df2b75a0f2a3b43622`.
DMG SHA256: `d1f8567456b2d9607d22e4f18a3d731720ce76fbee42e1cb7322afca495fd421`.
The prior app bundle is retained privately. Source commit `2ef6c81edebdd5fa517e38f7b9efc58a5ce0dd36` is pushed to main. Release [v0.2.35](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.35) targets that exact commit; its downloaded DMG matches the build and GitHub digest/size. The read-only mounted release app matches installed version, signature and executable. The Downloads copy matches too.

# Enki 0.2.34 — M43/M44/M45 and selected Mac acceptance (2026-10-08)

The combined release adds passive per-request timing diagnostics, realistic miniature-project/browser evaluations and an optional shared read-only project map. No inference engine, GPU, provider defaults, existing histories or native agent permissions changed.

Mac ARM64: final frontend640/6 existing opt-in skips; Hub37; Rust94/1 existing OS-vault ignore; TypeScript/Vite, locked all-targets check, fmt, offline baseline/reference checks and native app/DMG build pass. Source/candidate audit covers45 exact source hashes,180 project candidate files and36 wrapper hashes, including failures. Runtime package dependencies remain unchanged except the application version.

Actual isolated Chromium: M43 diagnostics measured/missing values and M45 preview/enable/disable,320/480/760px geometry pass. Actual signed native binary with officialSDK: map query,UTF8 budget,input refusal,wrongCWD,disable/re-enable oldconnection refusal pass. InstalledPi0.85.1 loads/calls the common tool; isolated officialOpenCode1.18.18 reports MCP connected with no inference. A separate native budget check verifies20 calls then refusal. Early fixture-only failures (copying a resource directory; fixture incorrectly insideGitignored.local) were diagnosed and corrected without changing assertions or production ignore rules.

Installed `/Applications/Enki.app` visibly shows0.2.34,OpenCode1.18.18 andPi0.85.1. Owner chat/history/Medium restored, shared scripts match source byte-for-byte, externalOpenCode remainshealthy; no prompt,stop or model/GPU change was issued. Installed native Context preview searches this repository, reports partial coverage and heuristic symbols, and project toggle enables/disables correctly. Existing stopped history displaysunknown elapsed/first-response fields honestly and separates tool/reasoning phases from result acceptance. Previous0.2.33 bundle retained privately. Current GUI is left onAbout.

Installed/build executable SHA256: `33108c7a159a74ad18d21c4d45fb2148d407a404ccd823057d0011804e390597`.
Built/Downloads DMG SHA256: `35f0791592957ff7f0d30498df1f24d72c5e5c74920fbb404fba2fe79eadcbd5`.
Strict bundle signature/audio entitlement/microphone description andDMGCRC pass. Ad-hoc signed, not notarized. Updated UI model-inference,live dictation/clipboard/SSH were not rerun; CLI syntheticmodel trials and native shared-tool qualification are separate evidence, not packaged end-to-end inference claims. Windows/Linux live work is explicitly excluded by owner; existing CI is not live acceptance.

M44: three five-file projects plus two-product validation/stale browser workflow. Initial projectOpenCode2/6/Pi1/6,final qualifiedbrowser2/2each. Eight earlier browser budget-limited trials preserved; no retries erase failures. [Report](evaluations/2026-10-08/projects/REPORT.md).
M45:24 paired same-budget trials. OpenCodeoff/tools2/6each;Pi off3/6/tools0/6. No reliable improvement: map remainsoff-by-default/manual; no automatic context injection. [Report](evaluations/2026-10-08/navigation/REPORT.md). No localQwen speed/generalquality claim.

HubCT206: additive numeric task-diagnostics table/API/Web deployed,37actual tests/sourcehashmatch/integrityok,all10314historyrecords preserved. One postdeploymentSQLquoting error in the verification helper was corrected with independent typedPython; no redeployment needed. FullNASarchive0.2.34 bytecmp/zstd and extractedSQLite history/schema/integrity pass; ownSSDarchive removed. SHA256 `d2e38eb08854da1abe51325be1ced10f298beb5e170bab04c5309bbf3e1ab4f2`. This checks archived contents, not a newly booted restore. Private .local receipts hold logs/oldbundle/backup metadata; none published.

Source commit `5fc71376befd08fb783c096c90e2dc2a25f47fcd` pushed to public main; release [v0.2.34](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.34) targets that exact source. Fresh downloaded GitHub asset matches built/Downloads SHA256, API digest and size; DMGCRC/read-only mounted signature/version/audio/installed-executable equality pass. Initial release creation rejected the abbreviated commit target; full verified GitHub commit SHA succeeded. Final follow-up is documentation only. Installed Hub catalog6packages/3installedskills/queue0 also verified through GUI, app leftAbout. Existing automatedCI status is separate and no new Windows/Linux live claim follows. At final status capture, native workflow37828107691 was still running; its Windows job failed and was not investigated because Windows/Linux work was explicitly excluded. The separate synthetic workflow37828107664 passed. Local Mac build/acceptance above is completed; no three-platform green CI claim is made. No delegation, new automation, localGPU benchmarks or Windows/Linux live tasks.

# Enki 0.2.33 — engineering foundations (2026-10-08)

M42 extracts state schema, fresh startup construction and pure OpenCode/Pi model
selection from the central store (3510→3222 lines). Existing facade/type exports,
selection priority, separate engine verification, session/project scope and
transport normalization in adapters are retained. Seven initial behavior tests
and two Debian payload regressions cover the extracted contracts and packaging.
Architecture/platform docs now distinguish implementations, native build evidence
and actual per-platform GUI acceptance.

CI qualification: all three jobs passed. Source
`6fe9477da1da2c9d89d19e7d618d50ed493d6f37`; native matrix run 37781057191,
separate Synthetic evaluation contracts run 37781057171 passed.

| Platform | Frontend | Hub Python | Rust | Native artifact |
|---|---:|---:|---:|---|
| macOS ARM64 | 626 | 34 | 94 | signed .app / verified .dmg |
| Windows x64 | 626 | 34 | 77 | NSIS PE, artifact-only verifier |
| Ubuntu 24.04 x64 | 626 | 34 | 96 | .deb version / exact executable / no macOS payload |

Six existing opt-in frontend skips and one existing OS-vault Rust ignore remain
on each platform. Locked Cargo check/fmt, TypeScript/Vite and offline evaluation
contracts pass. CI never installs the app or calls a model; receipts explicitly
say `liveAcceptance: not-run`. Packages and source-bound SHA256 receipts are
available in the CI artifacts. Only the exact qualified file is uploaded, even
when Cargo cache contains old packages.

Actual CI findings fixed rather than hidden: LF checkout preserves immutable
candidate hashes on Windows; test paths use host separators; Node permissions
grant only lexical/canonical/namespaced aliases of the same disposable fixture,
and an existing sibling file is refused with ERR_ACCESS_DENIED. Debian archives
can list tar-relative `usr/bin/...` without a leading slash; verification accepts
that syntax while requiring the exact regular executable and rejecting missing,
nonexecutable, indirect and macOS payloads. Old failed/superseded runs remain
historical and are not counted as successful qualification.

Local final Mac package source `5545138033ae76ae4c205a38b515f6f111499a31`;
subsequent edits affect CI helpers/tests/docs and EOF whitespace only. Rebuilt
frontend asset bytes remained identical; native runtime source is unchanged.
Actual installation and native launch passed: About 0.2.33, OpenCode 1.18.18,
Pi 0.85.1, restored history and model metadata (Medium, 262144 tokens), authenticated Hub catalog
six packages/three installed skills and empty outbox. No prompt, model benchmark,
provider change, GPU operation or production Hub update was performed. Existing
external OpenCode remains healthy; previous installed bundle is privately retained.

Installed executable equals final build SHA256:
`180eaaa7ebebbbaba93b1bccea7a47622177e9c6f239d02550f7fee006a13e16`.
Local Mac DMG SHA256:
`0d9621b3a6cf7389ba922bb746e76789d80d8cd5c1688fd1e2f8b8b9bb68b47d`.
Strict signature/audio-input/microphone usage description and DMG integrity pass.
Mac is ad-hoc signed, not notarized. Windows/Linux current packaged GUI, OS vault,
microphone and live agent scenarios remain unrun; use the separate
[platform acceptance checklist](PLATFORM-ACCEPTANCE.md). No inference performance
or model quality improvement is claimed by this engineering release.

Source published in main as `53b7baa69111a49c1fc61e193c02b37df157106c`;
[v0.2.33](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.33) targets
that exact commit and contains three native packages plus three public build
receipts. All six freshly downloaded assets equal the prepared bytes, sizes and
GitHub SHA256 digest. Published DMG CRC passes; a read-only temporary mount
confirmed its app version, signature/microphone and executable equal the installed
bundle. The first optional mount inside the external workspace was denied; a
test-owned system temporary mount succeeded and was detached/removed.

Released Windows installer SHA256:
`7dfc238443c8aea4620c85178a15743551e3566fbb26563fc8989962109c21da`.
Released Linux package SHA256:
`9aa34184a0ded0bf0ab5e84f542ebcf7dc22164adf1a9ae9f319c3a97de7916e`.
CI Mac DMG is a separate build with SHA256:
`bb67ae8e53f24c8efe6e81df126ab3fcdbc948e1a7a501a1bc17acb74fa2a85c`;
its downloaded CRC and exact receipt binding pass, but the release/installed Mac
DMG is the local build listed above. Completion receipt commits change docs only.

# Enki 0.2.32 — shared project-memory retrieval (2026-10-08)

M41 adds explicit local project grants for a read-only memory MCP through the
existing shared OpenCode/Pi adapters. Approved, unexpired, latest-known accepted
sources only; lexical ranking, whole-entry byte budgets, coverage and revisioned
Hub Web links. Vault-held HTTPS auth never enters model arguments/registry. CWD,
project/revision/Hub identity checks fail closed, including after delayed response
and revocation. Disabled by default; no production prompt injection/training.
Foreign registry entries cannot prevent native revocation and are preserved.
Offline Hub access cannot prevent disabling an existing grant; the UI checks local
state before network refresh, with a regression test for this failure case.

617frontend pass/6opt-in skipped,34Hub Python pass locally/on CT206,94Rust pass/
1unchanged vault ignore; TypeScript/Vite, Rust fmt/all-targets, final Mac app/DMG,
strict signature/audio-input/usage-description/hdiutil pass. Actual isolated SDK
and installed Pi loader read approved data over HTTPS through native + shared
proxy, refused extra project selectors and revoked grants; isolated OpenCode
metadata confirmed MCP connected with no inference. Test HOME had its own
disposable OS keychain; owner default/search-list and credentials were unchanged.
An initially unsuitable CA:TRUE test leaf was rejected; corrected CA:FALSE leaf
with serverAuth worked, without disabling native TLS validation.

Actual isolated UI opt-in/disable and340px layout passed, no horizontal overflow.
Installed native panel reads production Hub and enables create after unsaved title
entry (then cleared; no project created). About:0.2.32/OpenCode1.18.18/Pi0.85.1.
Build equals installed executable SHA256:
`9bb4e81fdcdda0aaa5f72c80e83b0b8d4e34fde4f878f26f301cf2369260ec8a`.
DMG SHA256:`530b94d3f47861292aac615e03345fa76557241ffa392aa0683f5dc59ae62dae`.
Ad-hoc signed, not notarized; Windows/Linux live acceptance unrun.

[36-trial comparison](evaluations/2026-10-08/retrieval/REPORT.md) on3unchanged M39
fixtures: all36 independent code assertions pass;35full successes, one provider
path error retained/partial usage. New baseline medians OpenCode/Pi9.51/7.13s;
optional search12.09/9.83s; prepared context9.79/8.10s. No stable benefit,
so automatic preparation remains off/unimplemented.194provider requests,
193responses with usage,423490known tokens. Synthetic facts/fixtures only; no
owner sessions/files/skills or local inference/GPU changes. A preliminary aborted
run found mode-specific artifact collisions; final36files all match their SHA.

CT206 code hashes match; all10314pre-update records preserved, integrityok,
production memory remains empty/catalog6. Full private NAS0.2.32 archive SHA256:
`adfe2cde573ed10657f87b20a11106e2a63fdec7de5adda16e838edb25173539`.
Byte/zstd verification and isolated unstarted207restore pass: code/server/Web
hashes match, SQL integrity/history/memory tables preserved. Own207/SSD staging
removed. External OpenCode PID3714 remains healthy1.18.18; externally owned
browser MCP processes and user chats preserved.

Source `3d6b080ab35ae58555f6d8a83b7e852d6687455e` pushed to main;
public [v0.2.32](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.32)
targets that exact source. CI Synthetic evaluation contracts run37772620531
passed. Fresh downloaded release DMG matches build, Downloads and GitHub digest;
hdiutil verifies it. Final installed package includes offline grant revocation;
About and both agent status checks pass. Own fixture listeners/tabs/key material
removed; production memory unchanged.


# Enki 0.2.31 — curated project memory (2026-10-08)

M40 adds explicit UUID project binding shared by OpenCode/Pi, accepted-result
proposals with editable fact/runbook text, separate owner approval, source
revision/digest, expiry and deterministic invalidation. Local paths/server identity
remain on the device; native text consent and client/server known-secret/path
filters protect writes. SQLite CAS prevents overwrites; reviewer identity in the
version ledger does not transfer source ownership. Web «Память проектов» exposes
current entries and review actions. AGENTS.md/checkpoints stay authoritative.
M41 retrieval/injection, training and skill rewriting are not implemented.

612frontend pass/6opt-in live skipped;30Python Hub pass locally and on CT206;
92Rust pass/1unchanged vault test ignored. TypeScript/Vite, Rust fmt/all-targets,
reviewed Mac app/DMG build pass. Tests cover explicit identity/CAS/races/reopen,
accepted-source gating, draft retention/network errors, stale drafts/source replay,
cross-device reviewer ownership, expiry, consent and unknown field rejection.
Real isolated CUA browser exercised result acceptance → candidate → separate
approval → source change → stale, a340px form without horizontal overflow, and
actual Web/API source/revision/state. Synthetic data remains in isolated fixtures;
no fake project, task result or memory entry was added to production Hub.

CT206 preserves all10314 pre-update history records, integrity_check=ok, four
additive memory tables. HTTPS authenticated memory API/certificate validation and
installed native panel readiness/catalog reading pass. External OpenCode3714
remains healthy1.18.18; browser bridge children and owner chats preserved. No
inference, GPU/model/global-provider changes. Reviewed installed executable equals build:
`88be29c79696c0f81393357ac7d6e3af5bb28afe160c343123fa9a17713d41c8`.
DMG SHA256:
`30150526fce56811e3b7a553d81d46da680db7b2f3f3cf097a8a9c1aca6085cb`.
Strict signature/microphone/hdiutil pass; ad-hoc signed, not notarized.
Final native About shows0.2.31/OpenCode1.18.18/Pi0.85.1; source/release round-trip
passed: sourcec8512204754444b0463b8a267f0dd65a144f4ba2 is the publicv0.2.31
target, freshly downloaded asset equals build/Downloads/GitHub digest and passes
hdiutil. GitHub CI [contracts run37763498470](https://github.com/VladimirKraswov/enki/actions/runs/37763498470) succeeds.

Full private NAS CT206 archive0.2.31 SHA256:
`bdc9d9e9e79506409fccde847bad7d966d5290f491c2b7d27f508c7ed34e56f0`.
Byte/zstd verified, restored to isolated unstarted207: integrityok/10314records,
server/memory/Web source hashes match, four memory tables present. Own207 and
backup SSD staging removed. Expiry/invalidation do not erase audit text; memory
versions persist separately from chat retention. Stale source detection requires
the originating device to reconnect/sync; offline changes cannot be known instantly.
Windows/Linux live checks and model-quality/speed comparisons remain unrun.

# Enki 0.2.30 — full-card Hub batching follow-up (2026-10-08)

Final boundary review found the old native 64KB record cap could reject a valid
long Unicode assessment attached to a user request. Assessed records now allow
192KB; complete records are sent in FIFO batches bounded to 20 records /1.5MiB,
leaving space under the existing HTTP 2MiB cap. Ordinary records retain64KB;
queue1200/12MiB bounds and consent rules remain. No task evidence is truncated.
New native regression checks complete partitioning/byte cap. Version0.2.30
supersedes the already-published initial0.2.29 package; do not rewrite its tag.
Final587frontend/21Hub/91Rust tests pass (6 optional live skipped/1 unchanged
vault ignore); TypeScript/Vite, fmt/all-targets and Mac build/signature/mic/DMG
checks pass. Installed Mac footer0.2.30, real catalog6/installedskills3 and
queue0/drop0 verified; unchanged OpenCode3714 healthy1.18.18. No owner chat writes,
model requests or GPU changes. Main source83ece421512d0d9db9038751c6d119fb800a79bd
is the publicv0.2.30 target. Downloaded asset SHA equals build/Downloads/GitHub
digest, hdiutil passes. Installed/built binary:
`e754ba015992f21f9b3209747e7d9db5b3340607e65960e686db399d659f8067`.
DMG:
`d1aff0e7282fc0d3b5ef8f199cd1837c7a8c3795e7050495cc4b922197327716`.
Hub backend is unchanged from0.2.29 deployment. Full NAS archive
`59a70030cb90a38fc90cd7e9b18788027f2e648ea17ae4400f0c3f2be1ec3f87`
was byte/zstd verified and restored to isolated unstarted207 with integrityok,
10314records/sourcehashmatch/newtablepresent; own207 and SSD staging removed.
Windows/Linux live tests and model-quality/speed A/B remain unrun. M38 complete;
M39–42 are roadmap work, not implemented or silently scheduled.

# Enki 0.2.29 — task result cards (2026-10-08)

M38 adds request-anchored owner assessments for OpenCode/Pi in the context panel,
atomic IndexedDB revision checks and durable optional Hub delivery. Agent idle,
completion markers and reported tool success never become owner acceptance.
Changes to evidence invalidate the previous assessment. Checks are user reports,
not independently executed tests. Sharing is opt-in per card, respects text
privacy at enqueue/read/final send, redacts known secrets and keeps separate
per-device assessments. Dataset approval remains independent.

Verification: 587 frontend tests pass / 6 opt-in live skipped; 21 Python Hub tests
pass locally and on CT206; 90 Rust tests pass / 1 unchanged vault test ignored.
TypeScript/Vite, Rust fmt/all-targets and final macOS app/DMG build pass.
Tests cover simultaneous/stale writes, scope isolation, explicit acceptance,
failed-write draft retention, reopen, sharing boundaries, old revision replay,
per-device reviews, invalid-batch rollback, safe rendering and retention.
Real isolated browser storage save/accept/reload restored all fields; a 340px
panel and actual isolated Web history/API showed the owner report separately
from session approval. Final installed Mac exposes the section and enables
creation after its storage opens; no fake card was added to owner history.

CT206 source hashes match local server/Web code, schema migration preserved all
10314 pre-update records, integrity_check=ok. Updated installed native Hub CLI
reports connected=true/catalog6. External OpenCode remains healthy1.18.18;
no model requests, inference/GPU changes, owner session submissions or aborts.
Windows/Linux live acceptance and model quality/speed A/B were not run.

Installed/built binary SHA256:
`65dc1ab5cfdaa4ee59512b5e78b0bf44fd94da08de7855f279c51b2259ae255e`.
DMG SHA256:
`90ec4269b1b801e34f3b9ae48b4641c5d0fe15c440e9910951dfcc7141bec815`.
Strict signature/microphone/DMG verification passed; previous app is retained
privately. Main publication, release round-trip and NAS archive verification
are recorded in the final checkpoint below once complete. M39–42 remain future
work; this release does not implement project memory or automatic training.

# Enki 0.2.26 — balanced settings and new icon (2026-10-08)

Common app/capability settings are separate from equal OpenCode/Pi sidebar
entries. Agent-owned settings have their own wrapping navigation. OpenCode
connection/path/diagnostics belong to OpenCode; Pi tabs cover connection,
models, extensions/LSP and capabilities. Pi drafts remain mounted across
navigation/search and participate in the settings exit confirmation. Common
skills/MCP remain in the shared catalog; native agent features remain separate.

554 frontend pass/6 opt-in skipped;87 Rust pass/1 unchanged vault ignored.
New navigation regressions failed on the preceding implementation (4 failures,
5 passed) and pass after the change; two real Pi settings component tests verify
draft reporting/tab retention without model probes. fmt, TypeScript/Vite and
final Mac app/DMG build pass. Existing Vite chunk warnings remain.

New icon generated using built-in imagegen, copied to repository and converted
with the official Tauri icon CLI. Full source/alpha and native32px preview
visually inspected, PNG/ICO/ICNS formats verified. Installed native About shows
the new mark and0.2.26. Same image source is used for sidebar/favicon/resources.
See [icon source and prompt](ENKI-ICON.md).

Actual installed Mac: equal sidebar entries and common-only General page,
OpenCode connection/tabs/diagnostics, Pi tabs/0.85.1 discovery, draft retained
when visiting OpenCode then returning, exit confirmation, test draft cleared
without saving. App left on About showing OpenCode1.18.18 and Pi0.85.1.
No inference requests or global configuration/history changes. Original external
OpenCode PID3714 healthy; its CLI bridge children preserved. Previous signed
bundle privately backed up; compatibility paths/data identities preserved.

Installed executable equals built SHA256:
`86b03a122450171607dd2623701711ba98af6253d5804052c1dad2852bd4ae17`.
Built/Downloads DMG SHA256:
`134c7c7ce4fb87ea4685ae4e202a67762975ccbf9e2f8011fe9eed27cdee4e62`.
Strict/deep signature, microphone entitlement, installed ICNS/source equality
and hdiutil verification pass. Ad-hoc signed, not notarized. Windows/Linux live
UI/install checks for this version were not run. Source7f6b136264cbc2afce748e9a6e394f5355ee8ee5
is pushed to main; public v0.2.26 targets that exact source. Published DMG
downloaded back, matches built/Downloads SHA256 and passes hdiutil verification.
Final checkpoint changes documentation only.

# Enki 0.2.25 — passive browser monitor and scroll recovery (2026-10-07)

Separate fixed420×308 native JPEG viewer, restore/hide controls and native close
handling; one existing Chromium, no page input/resize or extra agent/control/
scheduler loop in the viewer. Label-gated frame/presentation IPC and a minimal
window-drag capability; hidden viewers do not capture screenshots. Restore
retains settings drafts; remote/disabled support hides the viewer. Main-window
close exits the app even with an auxiliary window still allocated.

550frontend tests pass/6opt-in skipped;87Rust pass/1unchanged vault ignored.
Rust fmt/all-targets, TypeScript/Vite and Mac app/DMG package pass. Isolated real
Chromium36tools acceptance passes auth/workspace/profile/transport/modes plus
new manual-wheel invalidation of both agent and panel coordinates, fresh recovery
images and interrupted composed actions with no replay. The same-JPEG edge case
is tested: new decoded frame revision unlocks the panel even if pixels are unchanged.

Installed `/Applications/Enki.app`0.2.25: actual separate native viewer shows
live own-fixture frames; passive click/keyboard cannot edit the page. Detached
viewport706×698/page/tab preserved; restore returns the same page, full-panel
manual typing and click confirmed by actual DOM. Hide retains page/tab/form and
viewport; Browser button restores it. Actual full-panel manual wheel shows the
refresh barrier and returns to ready; real DOM confirms scrolling, preserved
input and one button click. Main window close with a hidden observer exits the
original app process cleanly; fresh launch/About/healthy OpenCode verified.
CUA native coordinate wheel/drag against the floating window returned
`noWindowsAvailable`, so live OS edge-drag/window-move and floating-wheel input
were not independently performed; fixed-size/forbidden-input guards are covered
by native configuration and behavioral tests. No live Windows/Linux acceptance.

Installed and built executable SHA256:
`70ec7ee833fb08e3a586fa726f35f6feb5623317ec3c8583fb357bb44e6c6c8b`.
DMG SHA256:
`9dd3e40aee734f97f65f524de96c2fa5427a2c7116ea07a8cbbf086e53f8de30`.
Strict/deep signature, microphone entitlement and DMG integrity pass. Ad-hoc
signed, not notarized;0.2.24 privately retained. Compatibility aliases remain.
Installed browser scripts match source; actual installedCLI+Pi0.85.1 loader/
validator/scoped OpenCode attachment and no-replay/disable acceptance pass.
Own fixtures removed, sidebar restored, app left open on About. Original
external OpenCode PID3714 remains healthy1.18.18; models, GPU services, owner
history/providers/permissions preserved. Source e6c5bb4 is pushed to main; public v0.2.25 targets that exact source.
Downloaded release DMG matches local SHA256 and passes hdiutil verification.

# Enki 0.2.24 — product rename, Mac installed (2026-10-07)

Public product name is **Enki**: window/menu/settings/messages, bundle/installer
names, README/current documentation, npm/Rust package and GitHub repository
`VladimirKraswov/enki`. New SVG mark produces Mac/Windows/Linux icons; old
default icon is replaced. Existing application ID, executable `opencode-desktop`,
preference/data/vault/skill/tool identities stay compatible. Dated reports and
published historical files below keep their actual names. See [branding](BRANDING.md).

533 frontend tests passed /6 opt-in skipped;85 Rust passed /1 unchanged vault
opt-in ignored. After the logo import,37 focused UI checks passed. Rust
fmt/all-targets, TypeScript/Vite and macOS app/DMG builds pass. Windows
installation selector includes all three names and retains ambiguous-version
rejection; its expanded10-case PowerShell fixture was not run on Mac (pwsh absent).
Live Windows/Linux rename upgrades are pending.

Installed `/Applications/Enki.app` 0.2.24 executable matches the build:
`56247a585b50bff78a2d7985468a4f6369abbfae0c1cac57bd1689ebb620b3b6`.
DMG `2f49a0ede8d9819f62ceb96414c25407f64ba49507e9cb6bba247095e481a283`
matches the Downloads copy; strict/deep signature, microphone entitlement,
application ID/version/name and `hdiutil verify` pass. Ad-hoc signed, not notarized.
Private0.2.23 backup retained; prior app moved across volumes, legacy application
path resolves to Enki through a hidden symlink. User Applications/Desktop
launchers use the new name. No second data store or concurrent legacy app.

Native window/menu/About visibly show Enki0.2.24 and healthy OpenCode1.18.18.
Existing browser remains ready; renamed shared SDK refreshed through its official
locked installer. Browser/shared scripts match source. Installed CLI and real
Pi0.85.1 loader/validator acceptance pass: discovery, aliases, scoped cwd,
upstream errors without replay, disabled service rejection and disposable
OpenCode MCP attachment/disconnect. No model calls; test-owned registries removed.
Original external OpenCode PID3714, conversations, global providers, permissions
and inference services preserved. Public [v0.2.24](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.24)
targets pushed runtime source `c072a82b5a72d01e830fdb7a1bafcb35cead86ff`.
Published DMG downloaded back: SHA256 matches the built/Downloads image and
GitHub asset digest; `hdiutil verify` passes on the downloaded artifact. Final
checkpoint changes documentation only. Enki remains open on About.

# AgentMesh 0.2.23 — shared capabilities, Mac verified (2026-10-07)

One global/project registry for portable SKILL.md sources and MCP tools. OpenCode
uses its native MCP/config APIs, Pi a thin extension through its real loader;
shared names are normalized once by the proxy. No additional agent loop or
permission auto-approval. Existing user paths, foreign MCPs, JSONC comments,
plugins, providers, sessions and inference services are preserved.

Final frontend: **533 passed / 6 opt-in skipped**. Rust: **85 passed / 1 unchanged
vault opt-in ignored**. TypeScript/Vite, Rust fmt/all-targets check and Mac
app/DMG build pass. Initial store regressions needed an explicit mock for the new
preparation dependency and acknowledgement wait; assertions were retained and a
preparation-failure draft regression added. Registry collision, ownership,
revision/credential rotation, bounds, symlink discovery, actual engine discovery,
stale/disabled calls, form navigation and busy-state tests pass.

Real isolated SDK/Pi 0.85.1 loader and Pi argument validator pass. Actual installed
Desktop CLI: real stdio tools, normalized alias, own workspace cwd, discovery
without calls, upstream error without replay and disabled-service rejection pass.
OpenCode 1.18.18 confirms the own fixture MCP attached to its disposable directory
and disconnected afterwards. Streamable HTTP with an own loopback Bearer fixture
passes discovery and call. No model requests, GPU work, personal session analysis,
owner model/permission/configuration rewrites or persistent fixture registrations.

Actual native UI 0.2.23 shows the unified catalog and SDK readiness. Verified
source form survives navigation, exit guard keeps edits and explicit form clear
removes the fixture without saving. Final scripts in installed shared runtime
match the source byte-for-byte; validated absolute Node path is recorded for
launcher/CLI use. Original sidebar layout restored, shared catalog left open.
External OpenCode PID3714 remains healthy 1.18.18.

Final installed `/Applications/AgentMesh Desktop.app` executable matches the build:
`0a7bf37d7d978f51aa8e320cc7b64e6729bad1a9652321ecd49f3cbf3b8c14ed`.
Strict/deep signature, bundle version and microphone entitlement pass. Mac DMG:
`804084d1817735732aa328da482448c4bd492f9309de65226d14c7f6fea0e35e`;
`hdiutil verify` passes. Ad-hoc signed, not notarized. Old0.2.22 bundle retained
privately. Public release [v0.2.23](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.23)
targets pushed source `8082ec6df4e0b8571eff5b8dfd8ae960370bab55`. Its DMG was
downloaded back: SHA256 equals the built/Downloads image and GitHub asset digest;
`hdiutil verify` also passes on the downloaded image. A final Windows-only main
followup aligns shared capabilities with the existing browser profile root outside
MSIX AppData redirection; Mac/Linux behavior is unchanged and all-targets check
passes. Live Windows/Linux acceptance and real third-party
OAuth/SSE/resource/audio compatibility are not claimed. Shared bridge supports tools over stdio and Streamable HTTP; see
[configuration and boundaries](CAPABILITIES.md).

# Verification record

## AgentMesh 0.2.20 composer — 2026-10-07

Presentation-only model labels are compact; provider/model IDs, eligibility, sampling and routing are unchanged. Full names remain searchable in menu details and available as trigger tooltips. Model ready state removes stale elapsed time and completed weight progress; loading/error states retain actual service data.

Composer choices wrap according to the composer container width. Primary actions have their own grid area; recording occupies one full in-flow row. Footer wraps and drops keyboard hints at narrow widths. No new permission or microphone capture behavior.

Frontend suite: **476 passed / 6 opt-in skipped**. Initial concurrent build/test run had one 10-second acceptance setup timeout; isolated acceptance retry passed 9/9, then the complete suite passed without timeout overrides. TypeScript/Vite build passed. Rust runtime source unchanged; previous 0.2.19 native qualification remains applicable.

Actual Composer/CSS rendered in the Mac in-app browser using `test/fixtures/composer-layout.html` (Vite-only fixture, excluded from release assets). Eight cases: host widths 1000/640/480/320px, root fonts 14/22px, OpenCode/Pi, and recording layout with three file chips. Measured composer widths 790/556/396/236px. All visible control buttons were within the composer, no overlapping button rectangles or horizontal overflow, no truncated access/model labels for the tested catalogs. At 236px the recording cancel/finish buttons remained 38px each and visible. Voice state/file chips in this geometry fixture are simulated; actual capture/transcription behavior is covered by existing voice tests, not a new live microphone recording.

macOS native app/DMG build passed. Installed `/Applications/AgentMesh Desktop.app` 0.2.20 has SHA256 `4221bf04db4a00beafd6abea8e12e06eddfbe6f55604e006fd34d18bd3a77e82`, identical to the build executable; strict signature/microphone entitlement/version check passed. DMG SHA256 `0598dce2a928f7083527c0d2a7fde8b5c6d108cc9e8dc52e3f432931a2692a94`; Downloads copy matches, `hdiutil verify` passed. Ad-hoc signed, not notarized.

Installed Mac UI visibly shows short OpenCode/Pi model labels. A real narrow composer with the browser side panel open keeps labels and mic/stop inside the panel. Owner tiny-cad continued its busy task across Desktop restart; external OpenCode remained healthy. A control-MCP attempt to reselect the already-resident Pi model raced another controller restoring the owner OpenCode chat: the Pi-only selection was safely rejected, no prompt sent. The transient selection error was cleared by directory reselection; no inference configuration changed. The side panel was closed after the layout check. Runtime source `de5e5df` is in GitHub main; release `v0.2.20` targets that exact commit. Published `AgentMesh.Desktop_0.2.20_aarch64.dmg` was downloaded back: its SHA256 matches the built image and GitHub asset digest. Windows/Linux 0.2.20 live acceptance not performed.


## AgentMesh 0.2.19 Mac installation and V100 deployment — 2026-10-07

Before the 0.2.20 UI refresh, `/Applications/AgentMesh Desktop.app` was the final 0.2.19 build
from runtime source `11590a3`; subsequent commits change documentation only.
Its executable SHA256 is
`9eaf43dc50367de240c8e2c4e6ef8a93271892ab7980c77890aea5ba4e3f227c`.
Strict signature, microphone entitlement and bundle version checks pass.
The verified macOS arm64 DMG SHA256 is
`5b5053dd108d3e5c31c3b3a5f5df2f63f2c8f2f07206f2b5c80c0f7cdb666105`;
the Downloads copy matches and `hdiutil verify` passes. This is an ad-hoc signed,
unnotarized Mac build; it is not a Windows/Linux installation claim.

Applicable frozen-source evidence: 469 frontend tests passed / 6 opt-in skipped,
79 Rust tests passed plus a separate opt-in real Mac vault roundtrip, production
frontend/native app+DMG builds, fmt and all-targets checks passed. These checks
were completed before packaging; no redundant full suite was rerun for the
subsequent documentation-only commits.

Final installed UI acceptance: both V100 service bindings read the protected
catalog; Pi 0.85.1 discovery refreshed successfully after a stale timeout. Both
V100 models are verified in Pi settings, including a new real minimal request to
the Pi checkpoint. The Pi picker lists both; the OpenCode picker excludes the
Pi-only model. Actual Pi→ordinary→Pi selection showed weight-loading progress,
disabled selection during loading and exact-model ready state, approximately
18 seconds per load. No additional OS confirmation blocked these final checks.

A disposable native Pi chat on the installed package streamed reasoning/text,
used the exact `local-qwen-v100/qwen-v100-pi` model, displayed two permission
requests and finished normally after both were rejected. The model attempted
unrequested write/bash calls despite a text-only prompt. Consequently this is
transport/rendering/permission-denial acceptance, **not** a successful exact-output
or instruction-following test. The fixture directory remained unchanged; this
observation does not establish quantization loss or revise the paired benchmark.
The owner's TinyCAD chat remained busy on its original external OpenCode server;
no owner chat was aborted or resumed by this verification.

V100 production is enabled and healthy on VM5100, using published NInfer
`7e626a68` and immutable binary
`d1f134d02456cb32f90b22a15c36f9e5d2321c8ee2c23bc0f3845b69c4108b5f`.
The running binary and gateway hashes match the deployed manifest. The catalog
advertises 262144-token capacity for both models and the Pi-only policy; the
resident model is restored to `qwen-v100-pi`. Previous qualification comprises
9 switching checks and 6 heldout Pi tasks including long-context and vision.
Weights and production engine settings were not changed in this final audit.
FreeToken on RTX 5090 is separately healthy/enabled at published main `09cafc9`;
its active owner workload was not interrupted. Windows/Linux 0.2.19 runtime
acceptance remains pending.

## Windows 0.2.18 MCP integration — 2026-10-06

Verified archive/history and imported the shared Windows browser runtime without changing the production code in the supplied installer. Independent Mac checks: 451 frontend / 78 Rust tests, TypeScript/Vite, Cargo fmt/all-targets check, native CLI, real 32-tool headless browser and two proxy regressions passed. Installer provenance, hashes and remaining installed Windows/Mac/Linux checks are detailed in [the integration report](WINDOWS-MCP-INTEGRATION-20261006.md).

## Windows port integration review on Mac — 2026-10-04

- The owner supplied a ZIP containing the original port bundle, patch and Windows
  verification report. `git bundle verify` passed. SHA256 of the bundle is
  `97de5cfa6c3ce308e273425f547348a6fea03241537bff5e355471d68d0d3a16`;
  patch SHA256 is `6b296e2181f60b2b0e59d48136a1e17245dc78b8cef34383d4dc1f5180d3cf59`.
  Both match the transferred report. Bundle head is
  `7c47d55ee36dcd6640f7bd3d25dee81990c95dd4`.
- The laptop reconstructed a baseline without the original Git history. Its
  baseline tree matches Mac main `2d5b9f9` except for the executable bit on
  `scripts/check-linux-prereqs.sh`. Cherry-picking only the port preserves main's
  history and that executable bit.
- Regression tests first reproduced POSIX case folding and loss of drive roots.
  Fixed both, kept separator/case handling for drive and UNC paths, corrected
  root-level relative diff paths, and added five path tests. An invalid explicit
  Windows Node override now fails rather than selecting a fallback silently.
- PowerShell scripts no longer depend on `$IsWindows` (absent in PowerShell 5.1).
  Native detection exit codes are checked, and Node 25 is rejected because it
  does not match the lockfile's supported ranges. The artifact verifier now
  fails on missing/unhealthy server, missing installation or version mismatch;
  `-ArtifactOnly` explicitly skips runtime acceptance. PowerShell is not installed
  on this Mac, so these revised scripts have not been executed here.
- The first full frontend run had two project-switch test timeouts: runtime
  metadata was not mocked, causing requests to the owner's local server. An
  isolated baseline run also made those requests (7 tests took 17.64 seconds).
  Mocked only those API boundaries without changing behavioral assertions.
  Final full suite: **313 passed / 6 opt-in live skipped**. Rust library:
  **39 passed**. `cargo check --all-targets --locked`, `cargo fmt --check`,
  TypeScript/Vite production build and `git diff --check` passed on Mac.
- Native release app packaging passed with `npm run tauri -- build --bundles app`
  and the ad-hoc signing overlay. `scripts/verify-macos.py` passed strict signature,
  audio-input entitlement and microphone description checks. This candidate was
  not installed, opened or published; the existing v0.2.14 release is unchanged.
- No Windows installer was supplied in this ZIP. Its hash below is a transferred
  receipt, not an independently verified or newly published binary. The integrated
  source needs a fresh Windows build and live acceptance. Known Pi/Agent Control
  limitations remain explicit; no inference benchmark or engine deployment was
  performed for this integration.

## Windows 11 x64 port and installation — 0.2.14, 2026-10-04

The following Windows acceptance is imported evidence from the owner's laptop,
not a Windows rerun on this Mac. It applies to port commit `7c47d55` and its
original installer. Integration fixes and their separate checks are recorded above.

- The supplied inner source archive matched the administrator manifest SHA256
  `003744378acdfa9170a8910edcc808ff61ae97d110b581efb931c22ec8b3540a`.
- Rust stable-msvc 1.99.0, Visual Studio Build Tools C++ workload, Windows SDK,
  Node.js 24.16.0/npm 11.13.0 and WebView2 were present or installed. Official
  OpenCode CLI 1.18.33 was installed separately through winget.
- OpenCode configuration uses `%USERPROFILE%\.config\opencode\opencode.jsonc`.
  The reachable OpenAI-compatible endpoint at `192.168.31.71:1919/v1` was
  configured as `local-qwen-next/qwen38-flash-next`; the V100 endpoint did not
  respond and was not configured.
- Frontend suite: **308 passed / 6 opt-in live skipped** with two workers. Rust
  library suite: **33 passed**. TypeScript/Vite production build, `cargo check`,
  formatting and the Windows NSIS release build passed.
- Installed location is `%LOCALAPPDATA%\OpenCode Desktop`. The native process
  is responsive, `/global/health` reports OpenCode 1.18.33 healthy, and provider
  status reports `local-qwen-next` connected.
- Live acceptance session `ses_ef9185746ffeFDPE6yD5Elz8sr` used directory
  `C:\Dev\OpenCode Desktop Smoke\Проект тест`, provider `local-qwen-next`, model
  `qwen38-flash-next`, and completed normally with exact text
  `WINDOWS_QWEN_OK`. No automatic permission approval was enabled.
- Pi 0.85.1 was installed from `@earendil-works/pi-coding-agent@0.85.1` and
  configured in `%USERPROFILE%\.pi\agent\models.json` for the same endpoint.
  The server rejected Pi's initial `developer` role, so the documented
  `compat.supportsDeveloperRole: false` setting was applied. A no-tools,
  no-session Medium request returned exact text `PI_WINDOWS_QWEN_OK`.
  JSONL RPC responses for `get_available_models`, `get_state` and `get_commands`
  all succeeded and reported the intended provider/model, Medium thinking,
  262144-token context and 16384-token maximum output.
- `scripts/check-windows-prereqs.ps1` passed for Git, Node 24.16.0/npm 11.13.0,
  Rust, Visual Studio Build Tools C++ and WebView2 154.0.4258.53.
  `scripts/verify-windows.ps1` verified the package, registry installation and
  healthy OpenCode server.
- NSIS artifact SHA256:
  `0C87647FC0BA7D3FF6A0E714E934F3C57EE7D35EF3D8BFE12DB7C6179FEBF36B`.
  This private local build is not Authenticode-signed.
- Known limits: Agent Control/Factory have no Windows named-pipe implementation;
  packaged-UI Pi integration, Pi LSP/approval UI and SSH were not live-tested;
  Windows Job Object process-tree shutdown for Pi and a Windows completion-sound
  player remain unimplemented.

## Pi startup and settings spacing — 0.2.14, 2026-09-30

- Owner screenshot showed `env: node: No such file or directory` below the Pi
  capabilities card and its last row touching the card border. Reproduced the
  runtime failure with the installed `/opt/homebrew/bin/pi` and a Finder-like
  `PATH=/usr/bin:/bin`: `pi --version` exited 127 with the same error.
- Native Pi launches and version/LSP checks now detect npm's `env node` entry
  point, choose an executable Node from absolute candidates, and pass the Pi
  script directly to it. The selected Node directory is put first on the
  child's PATH for extensions. A unit test uses a test-owned fake Pi/Node pair
  and a restricted PATH; it also checks the prepared child PATH.
- Pi capability rows now have vertical padding and a separator. Native UI and
  final artifact checks remain to be recorded.
- Optional Pi, Node.js and local OpenCode CLI paths are stored in app preferences;
  blank values keep auto-discovery. Pi detection and launch use the same Node
  override. The OpenCode override is validated and is used only for local
  autostart; saving it alone does not reconnect to or restart a healthy server.
  Rust tests cover invalid and executable path overrides.
- Frontend suite: 308 passed, 6 opt-in live skipped. Rust suite: 39 passed;
  `cargo check --all-targets`, TypeScript/Vite build and `git diff --check` passed.
  The 0.2.14 DMG passed `hdiutil verify`, strict code-signature and microphone
  entitlement checks. Local/Downloads SHA256:
  `4c4d9eb7316cd2cad1887ba2be6d0fc359c843e1701f48cb86bcb4fca9884ec5`.
- An ad-hoc native 0.2.14 preview with isolated bundle ID
  `dev.local.opencodedesktop.pathsqa` showed the new CLI/Node fields and
  well-spaced Pi capabilities card. Pi 0.85.1 was detected using the explicit
  `/opt/homebrew/bin/node`; OpenCode CLI path saved with a visible confirmation.
  The existing OpenCode server remained PID 7745 and healthy. The preview
  process was closed.
- The Pi capability-metadata probe in that preview timed out (`Pi не ответил
  вовремя`). A separate, no-inference CLI RPC check of `get_available_models`,
  `get_commands` and `get_state` returned all three successful responses, so
  the timeout appears specific to Desktop's probe path. No claim is made that
  this part of Pi is repaired.
- Private main source commit `5acaab80f00512c77268cb24909822b4d694545a`
  is the target of [release v0.2.14](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.14).
  GitHub's reported asset digest and a downloaded copy both match the verified
  DMG SHA256 above. Installed 0.2.13 is retained while the TinyCAD chat is busy
  (confirmed from `/Applications/OpenCode Desktop.app/Contents/Info.plist`).

## Token usage metrics — 0.2.13, 2026-09-30

- Following owner screenshots, settings spacing was corrected for Pi installation
  controls, HTTPS skill-source entry and related wrapping rows. Browser UI checks
  at 900 px covered every settings section without horizontal overflow or row
  collisions; at 680 px Pi and Skills remained within their content bounds.
  A signed 0.2.13 macOS preview with an isolated bundle ID was also opened
  alongside installed 0.2.12: native Pi and Skills views showed the bottom
  button gap and vertically separated source label, field and action.
- The new Settings → Использование screen reads assistant-message token counters
  from the currently connected OpenCode server (including archived/child chats)
  and locally registered Pi chats. It groups by each response's model, not the
  chat's current model selection. Input, cache read/write and output are shown
  separately; reasoning is already part of output. Period choices are 7 days,
  30 days and all time. Errors make the result visibly partial.
- Focused usage/settings tests: 12 passed. Final full frontend suite: 307 passed,
  6 opt-in live inference tests skipped. TypeScript/Vite build passed; 37 Rust
  tests passed.
- An ad-hoc signed native preview with a separate bundle identifier
  `dev.local.opencodedesktop.usagepreview` opened on macOS while the installed
  0.2.12 app remained running. Settings showed the new page and live local
  model split; both a partial-history warning and a subsequent complete scan
  rendered correctly. The preview process was stopped afterward. No prompt,
  inference or server restart was triggered by the check.
- The final Apple Silicon app and DMG include the spacing correction.
  `codesign --verify --deep --strict`, `scripts/verify-macos.py` and
  `hdiutil verify` passed. DMG SHA256:
  `234b560fb0330181dae61359971af5110de2f1021321d58385ca12d7f7713912`.
  The owner’s TinyCAD session remained busy, so the installed app was untouched.
  GitHub publication and eventual installation are recorded separately.
- Private main has the release source at
  `c94eadecf417a7252de0d55144c9d02e66f47dbc`. [Release v0.2.13](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.13)
  targets that commit; its downloaded DMG and GitHub asset digest both match
  SHA256 `234b560fb0330181dae61359971af5110de2f1021321d58385ca12d7f7713912`.
  Installed 0.2.12 is retained while the TinyCAD session is busy.

## GitHub publication — v0.2.12, 2026-09-30

- Private main contains the source, tests and updated documentation at
  `540a587ef8adca6f9ca2d05600124d3e6283e0e1`.
- [Release v0.2.12](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.12)
  targets that commit and contains the macOS Apple Silicon DMG. GitHub's asset
  SHA256 equals the verified local/Downloads artifact:
  `2008936781b68ee0de5dab781ca938942601dc7c1826e502563aee1ed6723733`.
  The installed executable matches the built candidate. Linux remains at
  v0.2.10; no Linux 0.2.12 package is claimed.

## Local OpenCode server autostart and CLI install offers — 0.2.12, 2026-09-30

- The prior local connection path only checked `/global/health` and showed a
  manual `opencode serve` instruction. A failed local connection now asks the
  native shell to launch the separately installed CLI, then repeats health.
  Existing healthy servers and occupied ports are never spawned over. SSH
  workspaces, non-network HTTP errors and browser preview cannot start a local
  service. The native command accepts only a plain HTTP loopback origin, uses
  an interprocess launch lock and waits at most 30 seconds for health.
- Native detection offers official OpenCode setup from the local connection
  gate and General settings if the CLI is absent. The Pi settings page offers
  the official Pi setup if its existing native detection fails. These are
  explicit links, not automatic installers. The owner clarified that the
  requested name was OpenCode, not Claude Code.
- Test evidence: focused frontend **3/3**, full frontend **300 passed / 6
  opt-in live skipped**, TypeScript/Vite build, Rust **37/37** plus formatting.
  Rust tests include a test-owned fake CLI that reaches `/global/health`, an
  immediate CLI failure, a healthy existing endpoint and an occupied port.
  An initial frontend suite run overlapped Rust compilation and timed out in
  five unrelated tests; those three suites passed **31/31** when rerun alone,
  and the subsequent full sequential run passed.
- After adding the install offers, focused frontend tests passed **20/20** for
  connection/client behavior and **6/6** for Settings. Rust remained **37/37**;
  `cargo check --all-targets` and `cargo fmt --all --check` passed. A parallel
  full frontend rerun under Rust compilation and heavy local workload produced
  timeouts in unrelated store/routing tests; this is not counted as a pass.
  The final full rerun with two workers passed **301 tests / 6 opt-in live
  skipped**.
- Existing OpenCode 1.18.18 on local port 4096 and its active user session were
  left untouched during implementation. The final macOS app and DMG built;
  strict `codesign`, `scripts/verify-macos.py` and `hdiutil verify` passed.
  Executable SHA256:
  `24f7a0772324d1f3dedbbac8cd1e0732bf55ed3fde86492a60f8b5be7395fd6a`;
  DMG SHA256:
  `2008936781b68ee0de5dab781ca938942601dc7c1826e502563aee1ed6723733`.
  The matching DMG was copied to Downloads. The owner authorized interrupting
  the one active TinyCAD session for installation. Only that session was
  aborted; the API then showed no active jobs. Previous app backup:
  `~/.local/share/enki/backups/0.2.11-before-0.2.12-20260930-184828`.
  Installed executable matched the candidate SHA256. Native UI showed Desktop
  0.2.12 connected to the unchanged OpenCode 1.18.18 server, OpenCode CLI
  installed, and Pi 0.85.1 installed. The original TinyCAD chat was resumed
  through the installed app; API confirmed the new user message and busy
  status in the same session ID. A packaged-app missing-server test on the
  owner's active profile was not performed; the Rust fake-CLI integration
  test proves the launch/readiness path without stopping the user server.

## GitHub publication — v0.2.11, 2026-09-27

- Current source and the completed AI-environment documentation were pushed to
  private `main` at `ce5c595d0ca7339837205b7f22b8e2f80897ace5`.
- [Release v0.2.11](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.11)
  is published in that private repository and its tag points to the same commit.
  The release contains the macOS Apple Silicon DMG only; Linux remains at v0.2.10.
- The uploaded asset was downloaded again and matched the verified local DMG:
  SHA256 `241b0c059d4ea440c3c22315e8608146d8cdc90a7b6fdd2acdc13848c4cc7f75`.
  The installed executable also matches the candidate SHA256
  `8f5c00b66014c5e6f9f2fa12fc192b4bce36f5b7e34e659a00aafe242cec150f`.
- Separately installed OpenCode helpers are active in server 1.18.18: both
  `repo_inspect` and `safe_edit` appear in its global and model-specific tool
  lists. Historical sessions, model defaults and existing provider IDs survived
  the idle restart. No new inference benchmark was claimed for publication.

## Agent Factory durable local runs — 0.2.11 follow-up, 2026-09-27

- Managed `desktop_send` accepts an exact completion marker, bounded semantic
  continuation budget and optional safe project-relative checkpoint. The model
  receives a visible contract to work through tools, record evidence, resume
  after compaction and request human input rather than invent it.
- Supervision survives Desktop restart and is scoped by server plus session.
  Only directory, boundary ID, marker/checkpoint and counters are stored; no
  prompt, response, tool output, credential or permission answer. Records are
  schema-validated, capped at 100, expire after 30 days and retain at most 32
  malformed message IDs.
- An idle persisted run first opens the exact session and loads authoritative
  history. Completion requires the marker as its own exact assistant text line.
  Missing markers and malformed tool calls use separate finite budgets.
  Explicit stop/rejected recovery delete the contract. Ordinary chats remain
  single-send and receive no semantic continuation.
- A per-turn message fence prevents a stale `idle` event from sending another
  continuation while the model is already reasoning or executing a tool. An
  assistant message with `finish=tool-calls` is intermediate; only a later
  completed assistant response permits the next lifecycle decision.
- Checks: focused Agent Factory/Control **16 passed**; full frontend **297
  passed / 6 opt-in live skipped**; TypeScript/Vite production build; Rust
  **32 tests passed**; signed native app, strict `codesign`, package verifier
  and `hdiutil verify` passed.
- Native local-Qwen acceptance used isolated sessions in the real candidate
  app. `ses_f1e30b68cffe8fP1f66sPnMnXY` stopped once without its marker, received
  exactly one continuation, passed through an intermediate tool-call turn and
  completed on the exact marker without a duplicate send.
  `ses_f1e2eae57ffecZXDK0nk6CZHhb` stopped without its marker, remained listed
  by `desktop_managed_runs`, survived a full Desktop process restart and then
  completed from authoritative OpenCode history. Explicit stop removed the
  contract for `ses_f1e2ce58cffewjWTctCszuA34o`; the inventory was empty and no
  continuation was resurrected.
- On the final installed build, two simultaneous MCP waits observed
  `ses_f1e262117ffeb4LNtlCGigSzwm`. Both returned the same completed result;
  authoritative history contained two user messages total (the initial task
  and exactly one continuation), proving per-session wait coalescing.
- An explicit stop while `desktop_wait` was actively observing
  `ses_f1e20d527ffeJPyhjn0uoKx42S` woke the waiter with `outcome=stopped` in
  0.111 seconds rather than waiting for its 180-second timeout. The backend
  became idle and `desktop_managed_runs` returned an empty list.
- Installed and candidate executable SHA256:
  `8f5c00b66014c5e6f9f2fa12fc192b4bce36f5b7e34e659a00aafe242cec150f`.
  DMG SHA256:
  `241b0c059d4ea440c3c22315e8608146d8cdc90a7b6fdd2acdc13848c4cc7f75`.
  Previous installed build is recoverable at
  `~/.local/share/enki/backups/0.2.11-agent-factory-stopfix-before-20260927`;
  earlier candidates remain in the adjacent Agent Factory backups.
  The external OpenCode server and unrelated sessions were not restarted,
  stopped or repurposed.

## Managed local-model recovery — 0.2.11, 2026-09-27

- NInfer request 269 proved the failure mode: Qwen emitted a complete textual
  tool-call region but omitted the opening parameter name. The parser reported
  `marker_seen=true`, `fallback_reason=malformed_structure`, zero structured
  calls and a normal stop token; therefore OpenCode correctly but misleadingly
  considered the task finished.
- NInfer commit `ce67fc9c` adds one schema-bounded repair. It may infer a missing
  opening tag only for exactly one required declared string parameter. Multiple
  required parameters, optional-only schemas, non-string parameters and other
  malformed structures remain rejected. Exact regression plus Qwen frontend
  and OpenAI-schema tests all pass. The V100 service was restarted only after
  its scheduler reached zero running requests; health and model discovery pass.
- Desktop Agent Control now keeps managed-send state in the long-lived app. On
  an idle result it detects a new stopped assistant message containing textual
  tool-call markup but no real tool part, submits a fixed recovery prompt and
  continues waiting. It stops after two attempts with `recovery_exhausted`.
  Ordinary UI chats, user text, unfinished turns, valid tool parts, permissions
  and questions are never auto-retried or auto-approved.
- Verification: `npm test` **288 passed / 6 opt-in live skipped**; focused Agent
  Control tests **7 passed**; TypeScript/Vite production build; `cargo fmt
  --check`; `cargo check --all-targets`; `cargo test` **32 passed**; macOS app
  and DMG build; signature/entitlement verifier, strict codesign and `hdiutil
  verify` all pass. Final candidate executable SHA256 is
  `ac9f9bc2d2eb0bf36380082c9c17d64c7992e8e8f90a3cadcea1a3166b093c1a`;
  installed first-candidate SHA256 is
  `5c0ea938eff003905021a223fe1534f413e98ff4a78d36b7ef1c65357fabae2f`;
  final DMG SHA256 is
  `57171a61a767b3048853cb5acaf3d0350fb5072df45f0227e3d0a1ff7ef2c415`.
  Previous app backup:
  `~/.local/share/enki/backups/0.2.11-before-tool-recovery-20260927`.
  The independent OpenCode server and user sessions were preserved. The final
  candidate was not installed over an actively running unrelated tiny-cad task;
  it differs only by clearing managed recovery state after explicit stop or a
  rejected retry. The requested malformed-output recovery is already present
  in the installed first candidate.

## Voice composer repair — 0.2.10, 2026-09-25

- The recording control was competing with model, effort and agent pickers in
  one flex row. In the native 0.2.10 candidate, three synthetic PNGs with long
  names remained attached while the microphone entered real recording; the
  waveform, timer, cancel and stop were all visible and accessible across the
  composer. Cancel stopped the recording without sending audio and the three
  test attachments were removed afterward. The installed 0.2.10 app also
  entered recording and canceled cleanly in the preserved tiny-cad chat.
- WebKit could leave `AudioContext.resume()` pending before requesting the
  microphone. Capture now starts first, and visualization cannot hold it up.
  A regression test keeps Web Audio permanently pending while checking that
  recording starts, the stop action transcribes and the result reaches the
  draft. Other tests cover refusal and cancellation of a late microphone grant.
- Mac checks: `npm test` **281 passed / 6 opt-in live skipped**;
  `npm run build`; `cargo fmt --check`; `cargo check --all-targets`;
  `cargo test` **29 passed**; `npm run build:macos`;
  `scripts/verify-macos.py` on both candidate and installed app;
  `hdiutil verify` on the DMG. Installed app and candidate executable hashes
  match: `0b4408484fd7854991e0e89ed020fcb3941000106b6954bdec58293722f0e2f8`.
  DMG SHA256 is
  `548a2441cdfff53807c373592e19970fb56a786b92c6c01cdb003566f0ea206e`;
  the identical file is in Downloads. Previous 0.2.9 app backup:
  `~/.local/share/enki/backups/0.2.9-before-0.2.10-20260925-112515/`.
- Linux Ubuntu 24.04 x86_64 used a test-owned copy of source commit `54fe7a3`:
  **281 frontend tests passed / 6 opt-in live skipped**, **31 Rust tests passed**,
  `npm run build:linux` produced package `open-code-desktop` version `0.2.10`
  for `amd64` with GTK/WebKit dependencies. Xvfb displayed a real
  1360×900 OpenCode Desktop window. DEB SHA256 is
  `4463440656dd0626cb3b9c3a8109d174c7f48c1f6449d4cbe317aee8795204a5`.
  The package was copied back and the marker-verified temporary checkout on
  Igor's machine was removed.
- The OpenCode API reported no busy sessions before installation. Its server,
  model services, user chats and configuration were not restarted or edited.
  No model inference or ASR audio request was sent for this acceptance.
  Read-only inspection of the user's 09:10 tiny-cad prompt recorded
  `local-qwen38/qwen-v100` in the actual user message and assistant response;
  the screenshot also displays V100. This evidence does not establish a
  different picker selection immediately before that send.
- Source fix `54fe7a3` was pushed to main. [Release v0.2.10](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.10)
  contains the Mac DMG and Linux DEB with the digests above. macOS remains
  ad-hoc signed without Developer ID notarization; Windows is unbuilt.

## Coordinator macOS acceptance — 0.2.9, 2026-09-25

- Pi 0.85.1 was detected at `/opt/homebrew/bin/pi`. Its model catalog was
  populated on startup, before opening Settings. Short direct requests to
  `local-qwen/qwen38-flash-next` and `local-qwen-v100/qwen-v100` both returned
  the requested text; the app then verified both independently with a nonempty
  response and showed only those two models in the Pi picker. No cloud model
  was configured on the Mac. The 5090 Flash Next remains OpenCode's default.
- The app-owned Pi LSP extension found TypeScript Language Server 6.0.1 and
  rust-analyzer 1.96.0 as «готов». Global `~/.pi` configuration was not edited.
  A native Pi projectless chat returned `PI_FINAL_OK`; its context meter showed
  **10 195 / 131 072** tokens and the composer remained usable after completion.
  A separate native OpenCode projectless chat returned `OC_FINAL_OK` with the
  existing local Flash Next, and the new-chat default was restored to OpenCode.
- Native review found and fixed two defects before release: projectless Pi
  routing previously required an OpenCode workspace, and Pi chats were absent
  from cross-project «Недавние». The project list and recent history now merge
  both engines; Pi history remains visible when the OpenCode server is down.
  OpenCode-only agent, terminal, changes and edit controls are hidden in Pi;
  Pi's context meter uses its own model window.
- Final source checks: `tsc --noEmit`, **280 passed / 6 skipped** frontend tests,
  `cargo fmt --check`, `cargo check --all-targets`, **29/29** Rust tests.
  The six skipped cases are opt-in live suites, run separately on Igor's machine
  with isolated test engines and a DeepSeek key outside the repository.
- The final Linux build from the same source commit passed **280 passed / 6
  skipped** frontend tests and **31/31** Rust tests on Igor's Ubuntu 24.04
  x86_64 machine. Its `.deb` reports package `open-code-desktop`, version
  `0.2.9`, architecture `amd64`, and the expected GTK/WebKit dependencies.
  A fresh Xvfb launch displayed a real `OpenCode Desktop` window at 1360×900.
  Debian SHA256:
  `b8690c93a7a372e39ea8937875a8b4c20c611ca75b0b4f0bc1432491bf057f69`.
- The final Mac `.app` and `.dmg` passed `scripts/verify-macos.py` (signature,
  Hardened Runtime audio-input entitlement and microphone usage text) and
  `hdiutil verify`. DMG SHA256:
  `f5c38b32d4541757503f88a6dc2d22cf2e5d2bfd5c5e3e904a1edce858777741`;
  executable SHA256:
  `4f67e7b0344b3466173d237aa8657314d54480ce4034b4e3f0b800f3292a0d98`.
  `/Applications/OpenCode Desktop.app` now reports 0.2.9 and its executable hash
  matches the candidate. The previous 0.2.8 app is backed up at
  `~/.local/share/enki/backups/0.2.8-before-0.2.9-20260925-015339/`.
  The identical DMG is in Downloads. The installed UI reopened with OpenCode
  1.18.18 healthy and local Pi settings intact; three coordinator test chats
  were deleted, while user chats and the independent OpenCode server remained.
- Source commits `6b5d05e` (Igor/Claude direct CLI refactor) and `91f19b2`
  (coordinator native acceptance) are on main. [Release v0.2.9](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.9)
  contains both OS packages: GitHub reports exactly the two SHA256 digests
  above, and the tag resolves to `91f19b2`. Igor's marker-verified clean test
  checkout and the isolated DeepSeek test key were removed after publication.
  This is an Apple Silicon ad-hoc signed build, without Developer ID
  notarization. Windows remains unbuilt and untested.

The sections below record earlier review stages; their interim “source only”
and “Mac not checked” labels describe those stages, not the final 0.2.9 result.

## Coordinator review follow-up — 0.2.9, 2026-09-25 (source only, not released)

Twenty coordinator findings were re-checked against the code; the real ones were
fixed and each is backed by a test or a measurement.

- **Existing chats no longer change engine when a folder's default does.**
  `engineForSession` now resolves an existing chat from durable evidence —
  explicit per-chat override, then Pi session metadata, then OpenCode — and the
  folder preference governs new chats only. Previously, setting a project to Pi
  would have reinterpreted every historical OpenCode id as a Pi chat.
- **Handoff works both ways and the composer leads into it.** Choosing the other
  engine for an existing chat opens a dialog explaining that engines cannot share
  a transcript, then creates a chat on the target engine seeded with an editable
  transcript. Provenance is engine-neutral and shown in the new chat. The
  transcript now carries tool outcomes (path/command plus trimmed output), and
  when it does not fit it sheds tool output before whole turns, reporting both.
- **Pi's built-in tools are gated.** A first-party `tool-gate.ts` extension is
  loaded into every real Pi session by the native layer. Anything not on the
  read-only list — including unknown tools — requires `ctx.ui.confirm()`, which
  the app shows as a modal; no answer, no UI or a native timeout all deny.
  "Full access" exists only as an explicit setting; an unset or unrecognized
  value means "ask". **Measured live:** the model was told to write a file,
  really called `write`, the gate asked, the answer was cancel, and no file was
  created — the test asserts the attempt and the prompt so it cannot pass
  vacuously.
- **Process-tree shutdown.** Pi runs in its own process group; shutdown closes
  stdin, waits 3 s, then SIGTERMs the group, waits 1.5 s, then SIGKILLs it. A
  Rust test drives a tree that ignores both EOF and SIGTERM and asserts the whole
  group is gone within bounds. Live: closing stdin ends Pi with code 0 and the
  language server disappears. Note for accuracy: hard-killing Pi alone did *not*
  orphan `typescript-language-server`, because it exits when its stdin closes;
  the group fallback is there for servers that do not.
- **The explicit DeepSeek model works.** Pi's bundled catalog is treated as
  evidence, not a gate: a pinned `provider/model` is used even when absent from
  it, `piModelInfo` falls back to conservative metadata, and prompts pass Pi's
  own `provider/id` form. Picker entries are labelled "каталог Pi · доступ не
  проверен" / "свой идентификатор · доступ не проверен" / "проверена".
- **Readiness is measured, not assumed.** "Проверить доступ" sends one minimal
  real request in an ephemeral session. **Measured in the built app:** with
  `deepseek/deepseek-flash` pinned — a model absent from Pi's catalog — it
  reported «Подтверждён · Модель ответила на тестовый запрос». The Mac review
  now requires an actual nonempty assistant response (not just `agent_settled`)
  and offers only separately verified models in the chat picker.
- **Capability probes leave nothing behind**: they run with `--no-session` and no
  extensions, and any `probe-*` transcript from an older build is filtered out of
  the chat list.
- **Pi settings tell the truth**: the LSP toggle is disabled and reads "Не
  установлено" until the extension exists; credentials are described as Pi's own;
  extensions and language-server paths can now be added, not only removed.
  Explicit absolute server paths are tried first, which is what a Finder-launched
  macOS app needs since it inherits neither `/opt/homebrew/bin` nor `~/.cargo/bin`.
- **The composer no longer shows OpenCode's access selector for Pi chats**; it
  shows the Pi tool policy instead.
- **Live tests use the real model and real events.** `test/pi-live.test.ts`
  defaults to `deepseek/deepseek-flash` and waits for `agent_settled` instead of
  sleeping; the suite dropped from ~22 s to ~6 s and no longer depends on
  provider latency.
- **Both engines were accepted on Linux.** A test-owned OpenCode 1.18.18 was run
  with an isolated config/XDG home on loopback port 43067 against a disposable
  fixture project; `test/opencode-live.test.ts` proved health and provider, a real
  conversation reaching the stream reducer (`OPENCODE_LIVE_OK`), history agreeing
  with the stream, and cancel. The owner's own services were never touched.
- Verified: `tsc --noEmit`; **273 passed / 6 skipped** frontend tests across 39
  files (the 6 skipped are the opt-in live suites, run separately and passing —
  3 Pi, 3 OpenCode); `npm run build`; `cargo fmt --check`; `cargo check
  --all-targets` with zero warnings; **31/31** Rust tests; `npm run build:linux`
  → `OpenCode Desktop_0.2.9_amd64.deb`; native UI smoke of the Pi settings.
  After the app exited: no Pi processes and no language servers left.
- Still not verified: macOS (coordinator), Windows (no variant), image
  attachments to Pi in a live run, and third-party Pi extensions raising dialogs.

## Pi as a second engine — 0.2.9, 2026-09-25 (source only, not released)

Performed on the owner's Ubuntu 24.04 x86_64 machine. **macOS was not built or
tested here; Windows does not exist as a variant.**

- **Pi is real, not a picker.** `src/agent/pi/` implements `AgentBackend` over
  Pi's documented JSONL RPC mode (`docs/rpc.md` of the installed
  `@earendil-works/pi-coding-agent@0.85.1`). Pi events are translated into this
  app's own event vocabulary, so the existing reducer, renderer and scrolling
  work unchanged — there is no second agent loop. Both engines are registered in
  the backend registry.
- **Installed on Igor** into an app-owned location:
  `~/.local/share/enki/pi-runtime` with the version pinned exactly to
  0.85.1 (matching the owner's Mac). Nothing global was changed; `~/.pi` was
  created by Pi itself and is never written to by this app.
- **Live acceptance** (`test/pi-live.test.ts`, opt-in, real CLI + real model):
  a streamed answer reached the app's chat state (`PI_LIVE_OK`), `agent_settled`
  swapped the provisional streaming ids for Pi's durable entry ids, one process
  per session, and reopening the same session id returned the same transcript.
  The DeepSeek key was passed only in the child environment; it is not printed,
  logged, committed or placed in any argument.
- **LSP works end to end.** A first-party extension
  (`src-tauri/resources/pi/lsp-extension.ts`) registers `lsp_diagnostics`,
  `lsp_hover` and `lsp_definition`. Live: the model called `lsp_diagnostics` and
  received `Type 'number' is not assignable to type 'string'` from
  typescript-language-server and `E0308 mismatched types` from rust-analyzer.
  The third-party candidate `samfoy/pi-lsp-extension@f2433d1` was read but **not
  installed**: it spawns a detached per-workspace daemon that outlives the Pi
  session, which conflicts with this app's process-ownership rule. Full audit in
  `docs/PI-ENGINE.md`.
- **Language servers on Igor**: `typescript-language-server@5.1.1` installed into
  the app-owned runtime directory; `rust-analyzer` added as a rustup component.
  Detection now *probes* a server before offering it — `rustup` leaves a shim at
  `/usr/bin/rust-analyzer` even when the component is absent, and the first live
  run caught exactly that.
- **Native UI acceptance** on the built Linux app under Xvfb: the settings screen
  shows a separate "Pi" group; detection reported the managed path and version
  0.85.1; the model list showed the real 4-model DeepSeek catalog with context
  and modalities read from Pi; "Настроить LSP" found both servers as "готов".
- **Process ownership verified in the real app**: 3 Pi children while running, 0
  after the window exited.
- **Safety**: no network transport (stdio only), program path always absolute and
  never from `PATH`, one child per (directory, session), blocking
  `extension_ui_request` surfaced to a modal with default-deny on timeout or when
  nothing can display it.
- **OpenCode is unchanged as the default**: folders and chats without an explicit
  choice resolve to OpenCode, and its model-preference keys keep their historic
  unprefixed form. A regression test asserts OpenCode still refuses to send while
  its server is unreachable, while a Pi chat is allowed to run.
- Verified: `tsc --noEmit`; **258 passed / 2 skipped** frontend tests across 37
  files (the 2 skipped are the opt-in live ones, run separately and passing);
  `npm run build`; `cargo fmt --check`; `cargo check --all-targets`; **30/30**
  Rust tests; `npm run build:linux` → `OpenCode Desktop_0.2.9_amd64.deb`.
- Not verified: macOS (coordinator), Pi extension dialogs against a real
  extension that raises them, image attachments to Pi in a live run, and Pi with
  a remote OpenCode host (deliberately unsupported and reported as such).

## Linux variant and agent-backend seam — 0.2.9, 2026-09-24 (source only, not released)

Performed on the owner's Ubuntu 24.04 x86_64 machine, in a temporary review checkout.
**macOS and Windows were not built or tested here.**

- Agent-backend seam: the state layer now talks to `AgentBackend` (`src/agent/`), with
  OpenCode as the only registered implementation and still the default. Transport,
  stream URLs and SSE parsing no longer leak into `src/state/store.ts`. PTY, `/mcp`
  and the JSONC config editor stay OpenCode-specific and are reached through
  `asOpenCodeClient`; the review panel and terminal are mounted only when
  `backend.capabilities.vcsDiff` / `.pty` are true, so that escape hatch cannot be hit
  during render. Re-connecting resolves the active backend's descriptor strictly — a
  lenient fallback would silently move a live workspace onto another runtime.
- Two reviewed build variants. `tauri.conf.json` is platform-neutral; macOS window
  chrome and `Entitlements.plist` live only in `tauri.macos.conf.json`, deb targets only
  in `tauri.linux.conf.json`. `test/bundle-config.test.ts` fails on drift between the
  duplicated window object (Tauri replaces arrays), on a macOS key reaching the shared
  config, on a version mismatch across package/Cargo/Tauri, and if an untested
  `tauri.windows.conf.json` appears.
- Per-OS paths are resolved in one place (`src-tauri/src/paths.rs`) and are
  **evidence-first**: an existing `opencode` / `opencode-desktop` directory always wins
  over an XDG guess, so the settings editor cannot write a config the engine never
  reads and an upgrade cannot orphan existing chats. Without XDG variables the result is
  byte-for-byte the shipped 0.2.x layout on both platforms.
- Linux runtime fixes: completion chime now picks the first installed system player
  (`canberra-gtk-play` → `paplay` → `pw-play`, all absolute paths, silence if none);
  macOS overlay-window-control insets are scoped to a `mac-chrome` class; `ssh` is
  resolved from an absolute allow-list, never PATH. Platform detection falls back to
  `navigator.platform`, so a stripped user agent cannot drop the macOS chrome inset.
- User-visible copy that claimed macOS on every platform was corrected in 10 places
  (settings, workspace picker, host dialogs, connection gate, OpenCode settings,
  microphone errors, keyboard hints). `test/ui-copy.test.ts` fails if shared copy names
  an OS again, unless the line explicitly scopes the claim ("Только macOS").
- Correctness fixes with regression tests: abort/стоп is routed with the session's own
  project directory (a session created in project A and stopped from project B used to
  get a 404 and keep running); malformed `message.part.updated` / `session.error` events
  no longer create phantom session slots; a 200 response with a malformed body is
  reported as an API fault instead of "cannot reach the server"; a session's own
  directory is authoritative over the listing directory it was seen in.
- Verified on Linux: TypeScript `tsc --noEmit`; **213/213** frontend tests across 32
  files; `npm run build`; `cargo fmt --check`; `cargo check --all-targets`; **24/24**
  Rust tests; `npm run build:linux` producing `OpenCode Desktop_0.2.9_amd64.deb`
  (`Package: open-code-desktop`, `Depends: libwebkit2gtk-4.1-0, libgtk-3-0`,
  `Categories=Development`, no `Entitlements.plist` / `Info.plist` / `.icns` inside).
  Headless smoke under Xvfb: `xwininfo` showed `"OpenCode Desktop" 1360x900+0+0` and a
  screen capture showed the rendered UI with no dead macOS chrome gap and the expected
  "no connection" state. The owner's OpenCode server, sessions and GPUs were not touched.
- Not verified here and left to the maintainer on a Mac: the `.app`/`.dmg` build, ad-hoc
  signature, Hardened Runtime, the audio-input entitlement surviving the config split
  (`scripts/verify-macos.py` is the gate), and the macOS chime. Not verified on any
  platform after these changes: SSH tunnels, ASR dictation, the PTY terminal and
  drag-and-drop attachments.

## Attachments and CPU helper — 0.2.8, 2026-09-24

- Deployed isolated unprivileged Proxmox CT205 `oc-helper` (Debian 12, 4 vCPU/4 GB, 20 GB) with bounded PDF/audio/video conversion. Its source SHA256 matches `services/helper/server.py`; `oc-helper.service` is active. Mac access is through a persistent loopback SSH tunnel on port 18107; direct Mac requests to the CT return 403. `/health` reports version 0.1.0 and the three conversion services. PDF text/page, video frames/audio and audio conversion fixtures passed. Existing GigaAM ASR on CT201 remains the transcription backend and was not moved.
- Desktop routes attachments according to the selected model's actual `/provider` input capabilities. Both configured local Qwen models advertise image input, not native PDF/audio/video input. The composer supports file picker, drag/drop, clipboard files and large-text paste, with per-chat IndexedDB drafts and explicit 12-file/50-MiB limits. Converted PDF/video frames go to Vision; sound goes through GigaAM. The helper address and health are visible under Settings → Services; MCP servers remain separately configurable. CT205 currently has no MCP endpoint.
- Full frontend suite **184/184** passed (single worker under high system load); TypeScript/Vite production build and `cargo check` passed. Final app+DMG build, strict local ad-hoc signature/entitlement verification and `hdiutil verify` passed. Browser UI connected to the real OpenCode server: picker attached a PDF, reload restored the unsent attachment, and removal worked. A separate one-shot live PDF test passed through CT205 and local Qwen: OpenCode stored `sample.pdf.описание.txt` plus `sample.pdf.page-1.jpg` and answered **«Контрольная фраза — HELLO, число — 42.»** The disposable test session was archived; no existing user conversation was modified.
- Installed `/Applications/OpenCode Desktop.app` 0.2.8 and copied the verified DMG to Downloads. Native Settings showed helper **«Работает · версия 0.1.0»** and all three services. The native file picker opened and an attachment chip was created; native selection of the intended fixture was not reliably completed by the macOS computer-control tool, so native end-to-end PDF sending is not claimed. A mistakenly selected unrelated file was removed from the unsent draft without transmission. The native UI was reopened after the automation dialog stopped responding. After the owner reported that Finder/Desktop drag did not work, the installed app was rebuilt with Tauri WebView native drag/drop events and narrowly scoped `fs:allow-stat`/`fs:allow-read-file` permissions. Native file preflight rejects folders, symlinks, oversize and changed files; 3 regression tests pass. The owner confirmed that dragging files from the Desktop now works in the installed build. No model request was sent for this regression check.
- Pre-install check found all 27 remembered OpenCode scopes idle. The independent OpenCode PID 27982 remains alive; the model server and user MCP processes were not restarted. The installed app retained all prior preference fields except the selected directory/new-chat mode changed during acceptance; the user's previous HyperMQ conversation remains intact and unread. New `helperEndpoint` is `http://127.0.0.1:18107`. Original bundle backup: `/Users/vladimirkrasov/.local/share/enki/backups/0.2.7-before-0.2.8-20260924-202206`. Private receipts are in `.local/attachments-0.2.8/`.
- Final installed executable SHA256: `f18f492d8683b5b80b1222b0ed03de38fd84ef7a5e1a64c77783cdcd8d15b535`; final Downloads DMG SHA256: `d4f0d3caab31a8ca0ddc6d9479171a39bdbab922e3db42e8d7d22da95ec87378`. The previous 0.2.8 bundle was backed up under `/Users/vladimirkrasov/.local/share/enki/backups/0.2.8-before-dragfix-20260924-214747`. Apple Silicon local ad-hoc signature; no Developer ID/notarization.
- Source commits `5bfe2d2` and `9ae9ad2f35a9f84397e2412faff74da2c3b427b7` were pushed. [Release v0.2.8](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.8) points to the latter commit; the remote asset SHA256 matches the installed/Downloads DMG. The later overloaded-host test repeat timed out one unrelated project-switching test; that test and the new native-drop tests passed together, 8/8, when rerun separately.

## Microphone permission repair — 0.2.7, 2026-09-24

- Reproduced owner's English WebKit capture refusal in installed 0.2.6. The macOS microphone switch was already ON and NSMicrophoneUsageDescription was present. TCC at 17:25 explicitly denied capture because Hardened Runtime required the missing `com.apple.security.device.audio-input` entitlement. Existing ad-hoc code requirement also differed after the prior update. No TCC database edits or global permission resets.
- Added the single audio-input entitlement to the signed bundle; retained Hardened Runtime and normal OS consent. Capture failures now explain local permission/device problems in Russian. A canceled AudioContext startup cannot make a later getUserMedia call; late granted streams are stopped without transcription.
- 171/171 frontend tests pass, including 4 new capture/cancellation regressions. TypeScript/Vite production build passes. New `scripts/verify-macos.py` checks the actual bundle's strict signature, signed audio-input entitlement and microphone usage description; rejects the installed 0.2.6 artifact as expected. Final Tauri app+DMG build, strict codesign, signed-entitlement check and hdiutil verification passed.

- Installed `/Applications/OpenCode Desktop.app` 0.2.7. Native microphone click produced a running timer and sound-level canvas; cancel returned to the microphone button without error or ASR submission. The existing microphone grant was usable. This verifies actual capture/start/cancel; speech-to-transcript was not repeated in this fix.
- All 26 preferences categories, drafts and global OpenCode configuration compared unchanged. All 26 remembered scopes were idle before installation. External OpenCode PID 27982 and the four pre-existing MCP processes remained alive; engine 1.18.18 healthy. Backup: `/Users/vladimirkrasov/.local/share/enki/backups/0.2.6-before-0.2.7-20260924-173755`. Private receipts: `.local/microphone-0.2.7/`.
- Installed executable SHA256: `c68e60ce6b9eb8563732f3085eaca6b6203173878db498dbc0c0434ba460d666`. Downloads DMG SHA256: `143b48f24f9d47dbf9cd33e85f9b4e40b0186b3667e652dd34f2af8c0cdc1602`. Hardened Runtime remains enabled; local ad-hoc signature, no Developer ID/notarization.
- Source `c04f053b2fc7a67c937689a8363418b62e913ef3` pushed; [v0.2.7](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.7) published. Remote tag and DMG digest match the verified local artifact.

## Settings and appearance — 0.2.6, 2026-09-24

- Replaced the modal/tab layout with a full-window screen: searchable sections, independent navigation/content scrolling, grouped settings rows, back/Escape and Cmd+, keyboard access. The conversation remains mounted but inert/hidden, preserving its draft, stream and reading state. Completion behind settings remains unread until the visible chat is viewed.
- App-global appearance: validated migration/persistence, independent UI/chat/code fonts, themes, palette/custom HEX accent with contrast-aware foregrounds, width and line spacing, preview/reset. Existing host snapshots cannot restore an obsolete appearance. No inference/config/model payload uses these values.
- Existing OpenCode config editor is preserved and driven by the new navigation; staged edits stay mounted across sections. Connection and ASR edits have separate save actions and exit protection. No additional engine restart, privileges or dependencies introduced.
- Full frontend tests **167/167**, `npm test -- --maxWorkers=2`. TypeScript/Vite passed. Tests cover preference migration, validation/CSS input rejection, remote workspace return, accent contrast, DOM application, search, independent saves, dirty exit/navigation and unread completion behind settings.
- Browser acceptance through private local API fixture, no inference: both themes; default and maximum fonts at1280×720/900×620; no horizontal content overflow, sidebar remains scrollable. Actual chat computed sizes18pxUI/24pxchat/22pxcode and composer24px, width1060px, relaxed line height44.4px confirmed. Settings reload retained all values; return retained the exact test draft; discarded ASR edit restored GigaAM; search reached appearance. Private receipts `.local/settings-0.2.6/`.
- Native installed acceptance: settings search/Cmd+, separate font changes and blue accent, live preview, actual SQLite persistence, reset to original neutral/dark defaults. Staged bash permission stayed pending across Appearance navigation and exit protection; discarded without writing the config (hash unchanged). Existing GigaAM endpoint/model/language retained. Cua Driver0.28.2 remains enabled, connected, with both grants. About confirms Desktop0.2.6 and OpenCode1.18.18 connected/open. Original Compute Mesh and empty composer restored; final screen intentionally shows Appearance.
- Final Tauri app+DMG build, strict ad-hoc codesign and hdiutil checksum verification passed. Installed `/Applications/OpenCode Desktop.app`, executable SHA256 `87bd0855e095b0354d7f4174c5b713336221e760aac8c07ac4ee59e7eba934f1`. Downloads DMG SHA256 `7ad462b508845224d828c6c0589949efea868f7d16a0e830a65b5487e1c291e9`. Backup: `/Users/vladimirkrasov/.local/share/enki/backups/0.2.5-before-0.2.6-20260924-165520`. Not Developer ID signed/notarized.
- All25scopes idle before replacement. OpenCode27982 and all four existing MCP processes unchanged. Fourteen preference categories including all5drafts, models/agents/ASR/hosts/layout/selection/theme compared unchanged; only the new default appearance field was added. No prompts/inference or server restart. Owned fixture4314/Vite1425 and browser14 closed.
- Source/tag `e0b2324f9dfe2a508e3f629afd286012c8061f82` pushed and [v0.2.6](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.6) published; remote asset digest matches the verified Downloads/installed receipt.


## Cohesive assistant output — 0.2.5, 2026-09-24

- Read-only inspection of actual OpenCode 1.18.18 history confirmed many `tool-calls` messages share one user parent and precede a `stop` text answer. The view now groups those adjacent steps without mutating messages or session state. User steering, different parents and compaction summaries remain separate boundaries.
- One compact progress rail retains explanatory text, collapsed reasoning and expandable tools; one final footer copies only the final Markdown. Model profiles and total known output tokens appear under «Сведения», with incomplete/paginated usage labelled. Tool errors remain discoverable when progress is folded; abort/budget failures remain visible and are never promoted to final answers. Internal compaction is a separate folded disclosure.
- Browser acceptance used a private local HTTP/SSE fixture, without model requests. Manual reading stayed exactly at scrollTop2275 as height grew3076→3713; the final-answer transition preserved3090.5 as height grew3820→4121. Jump resumed following. Switching away/back preserved expanded progress and top2867.5. Exact final Markdown clipboard, history prepend, light/dark layouts and no console errors verified.
- Native review exposed internal summaries opening as large transcript blocks and short tool durations wrapping beside long commands; both corrected. A separate browser reproduction found folded zero-size anchors being selected when the viewport was above the window edge. Its regression test failed before the fix and passed after; invisible anchors are now excluded from capture/restore.
- Final full frontend suite: **157/157**, `npm test -- --maxWorkers=2`; TypeScript/Vite production build passed. Regression coverage includes request boundaries, pagination-stable group identity, final/error/compaction classification, exact copy, retained live folds and navigation state. No Rust implementation changed. Native candidate verified the real Compute Mesh history with29/19tool actions, distinct finals and actual error states; connected/open, engine1.18.18, app0.2.5. The final installed build also confirms «Сжатие контекста» starts collapsed and offers «Копировать сводку».

- Final Tauri app+DMG build passed, app `codesign --verify --deep --strict` and DMG `hdiutil verify` passed. Installed `/Applications/OpenCode Desktop.app`; executable SHA256 `83190f6c007f363cf631c51c5282e0f39a46225f101f154db6a85bda83b59bf4`. Downloads DMG SHA256 `ce4fbdf9d899906418ccdfd15ad126f0ee721c40c8cf43867c582cc775cc5edb`. Local ad-hoc signing only; no Developer ID/notarization.
- All25remembered directory scopes were idle before both installations. Original0.2.4 backup: `~/.local/share/enki/backups/0.2.4-before-0.2.5-20260924-161613`; the intermediate candidate is separately backed up. OpenCode PID27982 and existing MCP processes retained. Model/agent/ASR/host/access/theme, all drafts, selected Compute Mesh conversation, expanded projects and globalconfig were compared unchanged. No prompts or GPU requests were sent. Private receipts: `.local/turns-0.2.5/`; owned fixture/Vite/browser closed.


## Chat reading and attention — 0.2.4, 2026-09-24

- Confirmed the owner’s phantom GPU Mesh indicator was persisted attention for a hidden explore child. Metadata reconciliation now removes confirmed child/archive/deleted marks, preserves unknown marks on network errors, and includes older unread roots beyond the first page. Late lookup/host races are guarded.
- Browser acceptance used an isolated local HTTP/SSE fixture with 140 messages and 180 streamed paragraphs, without inference. While paused, scrollTop stayed exactly 14500 as scrollHeight grew from 15195 to 15865; jump resumed at the actual bottom. History prepend moved scrollTop from 0 to 4652 while the same message stayed at y=191. The initial date-separator anchor defect was reproduced and fixed by anchoring stable messages/parts.
- Browser clipboard verified exact Python code without fences, full Markdown response, edited local code copy, and prompt-edit branch draft. Dark and light layouts reviewed, no browser console errors. Untrusted Markdown HTML/unsafe links, unknown/large code, copy and streamed local edits covered by tests.
- Independently verified the real OpenCode 1.18.18 fork boundary with a disposable noReply session: the selected message is excluded, earlier context retained, and permission rules are NOT inherited by the engine. Desktop explicitly restores source rules before presenting a branch. Both probe sessions were archived; no model request was made.
- Final full frontend suite: **145/145**; focused final metadata/edit regressions **14/14** after two review corrections. TypeScript/Vite production build and `git diff --check` pass. No Rust implementation changed; final Tauri release build completed. Existing large-chunk advisory remains (about 292KB gzip for the primary frontend bundle).
- Native installed acceptance: settings reports **0.2.4**, engine **1.18.18**, connected/open; actual user history renders date/time and code controls. Code copy reports success. Manual upward scrolling exposes «Вниз» and the button returns to the tail. GPU Mesh collapses without phantom attention; persisted hidden-child mark is gone. A separate owned session was edited through native UI: the branch contains exactly the earlier control message, source history is unchanged, deny-all rules and Qwen/Medium/agent are retained, correction is in its draft and no inference ran. Test sessions were archived, temporary project hidden, original user chat/empty draft and project expansion restored.
- Original model/agent selections, ASR, hosts, access, theme and global OpenCode config were independently compared and preserved. External OpenCode PID27982 and existing MCP processes were not restarted. All 24 inspected directory scopes were idle before installation. Prior app backed up locally.
- Initial bundle carried only a linker signature and failed strict resource verification. Re-bundled the same compiled release using an explicit ad-hoc macOS identity (`tauri bundle --bundles app,dmg --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'`). Final app passes `codesign --verify --deep --strict`; final DMG passes `hdiutil verify`. README build command includes the signing option. No Developer ID/notarization claim.
- Installed `/Applications/OpenCode Desktop.app`; executable SHA256 `1e6225c0508f52b7567e86a50915871b4c1cab13604a097b8840fe378aee6fc5`. Downloads/release DMG SHA256 `80738a55250510020a17fc671b51b2bbd47126914501ac9c6af7a0ba2633285b`. Private acceptance/backup receipts are under `.local/scroll-0.2.4/`. Release: [v0.2.4](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.4).


## Background computer control — 0.2.3, 2026-09-23

- Official Cua Driver 0.28.2 installed separately. Archive SHA256 `818ddefa0fa8ba2ec9cba837c7aa634a4b064221c748752cf49c5b08e2c94e8c`; Developer ID Cua AI, Inc. / YCK386LBJ7 and notarization verified. Driver telemetry disabled. User explicitly approved Accessibility and Screen Recording; the signed daemon's own permission report confirmed both grants.
- Native settings detected the driver and grants, connected `cua_desktop`, and wrote a backed-up JSONC entry with the canonical installed Desktop executable. Model/provider/access fields were unchanged. OpenCode's global config cache needed its documented config-update API to load the new entry and skill; all existing scopes were idle and existing directories had no PTYs. The OpenCode server process was not restarted. The UI now distinguishes immediate connection in the current project from the server's cached configuration.
- Real Qwen Flash Next / Medium acceptance used one disposable OpenCode session and a TextEdit test note. The model discovered the app/window, read its screenshot and accessibility tree, performed a background pixel click after AXPress proved unsupported by the text field, set its value and read it back. Fresh AX + screenshot independently confirmed `CUA_BACKGROUND_OK_5729`.
- Physical pointer coordinates before/after were exactly `(1050, -1013)`; Cua's separate agent cursor was enabled at `(416, 355)`. The named control session ended normally. The test conversation was archived and the owned note moved into private acceptance artifacts; no user document was edited.
- Native emergency stop disabled the shared gate; a new MCP caller then received `isError:true` before any driver tool could act. Post-stop acceptance found that the driver retains runtime suspension even after the MCP transport reconnects. Explicit UI Connect now closes only a runtime with `authorization_suspended`, reconnects under its normal policy and verifies actual permission readiness; model tool calls never trigger restart and other refusals remain errors. Focused frontend/Rust regressions cover this condition. Final native reconnect is checked below.
- Native testing caught two integration defects: OpenCode consumes MCP `content` but omits `structuredContent` from model-visible text, so the adapter now adds a JSON content block without altering images; ambiguous target formats confused the local model, so action schemas expose required `pid` + `window_id`, and JSON-encoded nested targets are accepted for compatibility. Focused Rust regressions cover both. Unsupported driver instructions to escalate to foreground are replaced with the actual Desktop contract.
- Limitation reproduced: a window on another macOS Space can be captured, but input is refused with `off_space_or_ax_unresolved`. The user brought the owned note to the current Space; only then did input pass. This is stated in settings, skill and documentation. Foreground/full-desktop control, remote desktop and browser-profile attachment are excluded. Cua 0.28.2 can also report an invalid cursor-state output while its position is null before any action; the post-action cursor report passed. No claim of complete Codex equivalence.
- Final automated checks: 126 frontend tests and 15 Rust tests. One earlier run concurrent with compilation timed out in unchanged R3; the complete rerun without compilation passed all 126 without modifying assertions or timeouts. Release build/installation receipt recorded after packaging.

## Installed bundle — 0.2.3, 2026-09-23

- `env -u NODE_PATH npm run tauri build -- --bundles app,dmg` passed with the final reconnect fix. Final app installed at `/Applications/OpenCode Desktop.app`, existing `~/Applications` and Desktop aliases retained. Previous 0.2.2 app/preferences are backed up privately.
- Installed executable matches the built candidate: SHA256 `4c1b9eeaa22e5e991ff3c990e4d60c6df46bc73f78069fb96e9bd2a5fd84354d`. `hdiutil verify` passed; the same DMG is in Downloads: SHA256 `3c304fcaf1334db32ca68012ee6f966ceb1d23d843a100e48732e68bea0ab34c`.
- Final native settings correctly showed the revoked driver as **Не готово**. Explicit Connect recovered it and displayed **Включено / Подключён**, Accessibility and Screen Recording **Разрешена**. A separate MCP handshake against the installed binary verified 22 tools, required exact-window schemas, permission checks under `com.trycua.driver`, and model-visible structured results. No additional inference was needed.
- Settings fit the native window; IgorPC was restored with an empty composer. ASR, model/provider/default/permission fields and chat history were preserved. Existing session/PTY scopes were checked idle before replacement; external OpenCode PID27982 stayed healthy at 1.18.18 without restart.
- Desktop remains an Apple Silicon ad-hoc local build; the separately installed Cua Driver has its own Developer ID signature. No Desktop notarization claim. Published release: [v0.2.3](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.3).

- Release tag `v0.2.3` points to source commit `abf4e2e7b846f261d7aa4cc9d4f18b6ab5215f0c`; GitHub asset digest matches the local DMG SHA256 above. Subsequent checkpoint-only documentation commit records publication and does not alter the packaged source.

## Project removal and task handoff — 0.2.3, 2026-09-23

- `env -u NODE_PATH npm test`: **122/122** tests pass. Added coverage for project remove/restore and server isolation, append-only recipient drafts, full-history fork preparation and cancellation, recipient model/directory preservation, busy/permission guards, SSH credential isolation, and uncertain delivery without resending. A raw HTTP fixture covers assistant `parentID` normalization; native testing exposed that previously missing field.
- Native project-menu acceptance: removed a disposable project from the sidebar, verified the current IgorPC conversation stayed selected, and restored the project through **Убранные проекты**. No filesystem or session deletion occurs.
- Native handoff acceptance used two disposable local sessions with real Qwen Flash Next / Medium. Important facts were deliberately placed in the **first** source message, followed by unrelated messages. **Собрать важный контекст** produced a 7,578-character editable packet in 123 seconds containing the original protocol, port, SSH alias, application path, service, database restriction, passed test and next action. The isolated preparation fork was archived automatically; the source still contained exactly its three original messages. A separate cancellation check stopped/archived only its preparation fork.
- **Отправить и начать** delivered exactly one user message to the selected recipient. Its real response began `HANDOFF_RECEIVED` and reproduced all eight control facts, explicitly distinguishing source-machine coordinates from the receiving workspace. There were no tool calls and no parallel inference requests.
- Native draft mode appended a second packet after `EXISTING_DRAFT_KEEP`, preserving the existing text and generating no additional API message/model response. Cleared the disposable draft and archived only the acceptance sessions afterward. Restored IgorPC with its empty composer and original model; ASR, host and endpoint preferences matched the pre-test backup.
- Native visual review found flex shrinking the recipient list in short windows; the final layout keeps fields intact and scrolls the dialog instead.
- Scope: title search and explicit recipient selection are implemented in the UI. A model-invoked automatic discovery/delegation tool is not included. Preparation quality depends on the selected model and available source context; the user reviews/edits the packet before sending. Remote client/profile/auth isolation has automated coverage, but no configured second-host native roundtrip was available for acceptance.
- Final installation passed; see the shared 0.2.3 receipt below.


## Expandable project sidebar — 0.2.2, 2026-09-23

- `env -u NODE_PATH npm test`: **105/105** tests pass, including the original store regressions. New coverage: independent expansion without navigation/draft/SSE changes, persistence on reconnect, directory/subagent filtering, events received during slow snapshots, host isolation, recent pagination, background project actions and retry/load-more. Existing attention/queue/history/model tests still pass.
- `env -u NODE_PATH npm run tauri build -- --bundles app,dmg`: TypeScript, Vite and native release build pass. Native source unchanged except package version. Existing chunk-size advisory remains.
- Native macOS candidate: GPU Mesh expands into all six imported sessions. A second project can remain expanded while IgorPC stays selected. A temporary unsent draft survived collapse/re-expand and was then cleared. Blogger Scout and IgorPC opened their real imported history. Project “+” starts a new draft in that project without creating/sending a server request; returning to the existing session works.
- Collapsed GPU Mesh remained collapsed after quitting/reopening the candidate; expanded state persisted into the installed app. Recent sessions appear below projects, and switching to the global archive lists archived sessions with restore controls. Archive/restore mutations are unit tested in this revision; no user session was archived/deleted during native acceptance.
- Installed `/Applications/OpenCode Desktop.app` **0.2.2** after checking OpenCode had no running sessions. Previous bundle and WebKit preferences backed up locally. Installed executable SHA256 matches the tested candidate (`13ffa0e9f92a211571e8f895513f45b7cb8b10fe82dd1e8d74f66352839a16e2`). OpenCode process stayed unchanged and healthy at 1.18.18; no inference request or model configuration change.
- Installed UI shows expanded GPU Mesh, all six sessions and the restored IgorPC history with an empty composer. Existing Applications/Desktop aliases retained. DMG copied to Downloads and passed `hdiutil verify`; SHA256 `a7cdbb9e42dc65ce986a5f220c1b1b67f536863007872691074d9560a49106b2`.
- Cross-project recent/archive API is verified against OpenCode1.18.18 `/experimental/session`. Unsupported future/older versions show a retryable list error. Apple Silicon ad-hoc local build; no notarization claim.


## V100 NInfer migration — configuration only, 2026-09-23

This supersedes the deployment decision in the older 0.2.1 acceptance entry below.
The app binary remains 0.2.1; only the external model/agent configuration changed.

- The corrected NInfer fork now serves `local-qwen38/qwen-v100`: NVFP4, context262144,
  Vision, MTP4, prefill2048. Production startup/restart and sole GPU ownership passed.
- Model and agent JSONC/Markdown were backed up; Flash Next provider/default and
  existing sessions were preserved. The native model picker displayed both Flash
  Next and **Qwen3.8 27B NVFP4 (NInfer · V100)** after metadata reload.
- Real OpenCode `read`/`write`/`bash` task: 8/8 independent tests passed after its fix,
  test file unchanged. Serving logs confirmed Medium8192 and Low2048 thinking
  budgets, with the actual OpenCode response ceiling32000.
- Corrected quality smoke suite:107/108 first attempts; code51/51, tools11/11 and
  Vision10/10. One exact string-reversal error remains. This does not prove broad
  quality parity. Old clock/seed/retry methodology errors are documented in the
  [fork report](https://github.com/VladimirKraswov/ninfer-v100/tree/master/deploy/v100/results/2026-09-23).
- Cold226022-token input plus image passed scattered-fact/OCR checks and completed
  normally in604.43s. Old active Qwen GGUF/projector and standalone llama.cpp were
  removed after client acceptance; unrelated archives and CPU services were retained.
- No app source change, repackaging or duplicate GPU inference was needed. Current
  limits, compaction threshold and operation are in [LOCAL-MODELS.md](LOCAL-MODELS.md).

## Completion attention, settings and V100 model — 0.2.1, 2026-09-23

Historical release-time decision; superseded by the migration entry above. The
old aggregate quality figures also had scorer/seed/retry methodology problems.

- Independently recalculated all six context-bucket decode medians and the 225K-token cold probe from the raw llama.cpp/NInfer JSONL files. NInfer reached 262144 context and 1.42–1.95× decode, but the 116-case quality suite was 113/116 versus 116/116 for llama.cpp. A code error and fine-detail Vision error reproduced, so NInfer remains stopped and `llama-v100.service` remains healthy. See [model profile and decision](LOCAL-MODELS.md).
- Added live V100 profile `local-qwen38/qwen-v100` through the separate `127.0.0.1:18021` SSH tunnel. `/v1/models` reports `qwen-v100` and 262144 context; OpenCode `/provider` shows V100 and Flash Next simultaneously. A short OpenCode test request recorded assistant `providerID=local-qwen38`, `modelID=qwen-v100`, `variant=medium`, while global `model` and `default_agent` remain Flash Next/`qwen-build`.
- Source checks after the project-row unread fix: 97/97 frontend tests, frontend build, six Rust tests and `git diff --check` passed. The test covers returning via the project row, where the completed session becomes visible without another session-row click.
- In the packaged native 0.2.1 candidate, the model picker displayed both local GPUs. Selecting V100 changed the context meter to 262144/196608 threshold without borrowing the prior Flash Next token usage; switching back restored Flash Next's 131072 context and its measured usage. The V100-specific `qwen-v100-build` agent and Medium option appeared in the composer.
- Native settings showed live tools, skills, plugin, MCP and agent sections. In a disposable project, changing `permission.bash` through the UI created a backup, preserved a JSONC comment and unrelated field, and showed the saved value. A second staged edit was rejected after an external file change, proving stale-write protection. The installed GigaAM ASR endpoint/model/language appeared in the native 0.2.1 candidate settings.
- A real V100 chat in the disposable project called the `read` tool and answered `deny` from that file. While another chat was visible, the project row indicated the running task and then showed a yellow unread dot after completion. Opening the specific session cleared the dot. Native review found that returning via the project row displayed the answer but left the dot; this was fixed in source and is covered by a new regression test.
- The final rebuilt native app repeated that scenario: after a second V100 read-tool response (`dark`), the project row showed unread; returning through that row restored the answer and cleared the dot without a separate session click. No duplicate GPU jobs were run.
- Final `npm run tauri -- build --bundles app,dmg` completed for the fixed source; `hdiutil verify` reported **VALID**. DMG SHA256: `387826b644f8d199024b9e6e2716364852f167b3387f8d00eceaddaa977ae4c2`; executable SHA256: `c7cc170b52d6c6c859ee492bb47c3e615045fbf59df5d1e4b7383d910977b497`.
- Backed up installed 0.2.0 locally, installed 0.2.1 to `/Applications/OpenCode Desktop.app`, and copied the same DMG to `~/Downloads`. Installed executable hash matches the bundle. The `~/Applications` and Desktop aliases still resolve to it; `Qwen OpenCode.app` remains present. The installed app displayed **0.2.1**, OpenCode **1.18.18**, connection **connected**, SSE **open**, and the configured GigaAM endpoint. The pre-existing benchmark conversation and context meter survived installation. The OpenCode server remained healthy on `127.0.0.1:4096`.
- Source commit `471e78082072ee152c931e61e8617f16573b18d9` was pushed. [GitHub release v0.2.1](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.1) points at that commit; GitHub reports the uploaded DMG SHA256 matching the local artifact.


## Optional projects and SSH execution — 0.2.0, 2026-09-22

### Automated checks and final package

- `env -u NODE_PATH npm test`: **83/83 passed**, preserving the previous 68 tests and adding 15 workspace/host regressions. Covers lazy per-chat workspace creation, duplicate submissions, failed/stale preparations, new-chat versus resume, stable SSH identity, local/remote drafts and PTY isolation, failed remote never falling back to Mac, late handshakes, auth non-persistence, deleted-session reconciliation, non-Git folders and Medium defaults.
- TypeScript + Vite production build, `cargo check`, `cargo fmt`, `git diff --check`: passed. `cargo test --lib`: **5/5 passed**, including SSH argument validation, mandatory known-host verification and workspace traversal/injection rejection.
- Final `env -u NODE_PATH npm run tauri build -- --bundles app,dmg`: passed. `hdiutil verify`: **VALID**.
- Installed `/Applications/OpenCode Desktop.app` reports **0.2.0**, and its executable matches the final build. Existing `~/Applications` and Desktop links still resolve correctly; the old Qwen launcher is preserved. Previous installed version backed up locally.
- Executable SHA256: `2564a5754e5f2b0cd077d2aa71c264848abd43336ef3489b65e6da358445c194`.
- DMG SHA256: `752dab42bb118d9f0591a801257ab2281c0e767c0f1d298fb22962a1d166d26c`. A matching copy is in Downloads.

- Delivery: source commit `452df23e18cfacb21a2c62578524c330d555b5e2` pushed to the existing private repository. [Release v0.2.0](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.0) has the DMG; GitHub reports the same SHA256 as the local artifact.

### Real native acceptance

These were actual packaged Tauri UI actions with OpenCode 1.18.18, not only unit tests. Inference checks used local Qwen3.8 Flash Next / Medium sequentially, in app-owned test directories. No user project was modified.

- New Chat opens an enabled composer, optional project picker and explicit projectless choice. Local and remote execution selectors are independent of project selection; local project menus list actual server projects.
- Opening the terminal before sending a prompt creates a separate managed workspace. Real xterm `pwd; uname -s` showed its Mac path and Darwin. A subsequent UI prompt invoked the real read tool in that workspace and returned the exact fixture marker `LOCAL_PROJECTLESS_FILE_020`.
- Context meter for that chat showed **9208/131072**, compaction threshold **81920**, remaining **72712**. Medium was confirmed by UI and actual message metadata. Automatic compaction uses the unchanged existing OpenCode configuration; no extra long-context inference was forced for this release.
- A temporary, isolated OpenCode instance on a POSIX SSH host exercised the actual native tunnel and API Basic authentication: HTTP, streamed chat and PTY all worked. Terminal output showed the remote directory, Linux and the remote host. The real remote read tool returned `REMOTE_PROJECTLESS_FILE_020`; context showed **8159/131072**.
- Remote project selection accepted the real server directory through its path dialog; a nonexistent server path was rejected by the file API. It did not open a Mac folder picker. Returning to Local restored local project/history/model state without remote entries leaking across hosts.
- Local projectless chat archive and restore worked through the native UI. Its history survived app exit, final installation and relaunch. The installed final build displayed the prior read result and context usage, opened a fresh projectless terminal, and reported app **0.2.0**, engine **1.18.18**, SSE **open** in settings.
- Temporary remote engine, its temporary data/config, forwarding connection, remote test workspace and test connection profile were removed. Test PTYs were closed. The independently managed local OpenCode server remained healthy and was not restarted. The app is left on New Chat / this computer.

### Scope and remaining limitations

See [workspace/host contract](WORKSPACES.md). The remote engine must already exist and serve its API on remote loopback; Desktop owns only its SSH connection. SSH requires a working key and known host. API passwords are memory-only with standard HTTP user `opencode`; no Keychain persistence/custom HTTP username yet. Managed chat folders are not a filesystem sandbox. This Apple Silicon build is not Developer ID notarized. Full Codex feature/pixel parity, cloud execution and Windows remote workspace creation are not claimed.

## Window dragging hotfix — 0.1.1, 2026-09-22

- Root cause: the custom titlebar invoked `start_dragging` without the required capability; bare drag regions also excluded their nested label/spacer hit targets. See [Tauri window guidance](https://v2.tauri.app/learn/window-customization/).
- Added only `core:window:allow-start-dragging` to the existing main-window capability. The installed Tauri 2.11.6 `window/scripts/drag.js` supports `data-tauri-drag-region="deep"`, including descendants while excluding buttons/interactive controls. Both titlebar regions now use this native mode; text selection is disabled only on native window chrome.
- App/settings version updated to 0.1.1. The settings display reads package.json instead of a stale literal.
- 68 frontend tests passed; frontend production build, cargo check and final app/DMG build passed. No Rust implementation changes; the two native ASR tests from0.1.0 remain previous evidence, not a new run.
- Installed native0.1.1 was dragged from free titlebar space and from the title text. The review button still toggled on/off, and settings showed0.1.1. No inference request or user project change was needed.
- Installed to `/Applications/OpenCode Desktop.app`, aliases unchanged. `hdiutil verify`: VALID. Build/installed executable hashes match.
- Executable SHA256: `01c70536f7f6b349593043869fda39bb831720288c54a9fa0a8b558e634cfe0f`.
- DMG SHA256: `4c7aa0453c87aa5b0c13ebde3bbe95ff958de4bf6322c06e32227e9b3295a28c`.

## Original 0.1.0 acceptance pass — 2026-09-22

Supersedes the original worker's completion claims below. See [independent corrections](ACCEPTANCE-2026-09-22.md) and [context, access, queue and voice contracts](CONTEXT-QUEUE-VOICE.md).

### Automated checks and package

- `env -u NODE_PATH npm test`: **68/68 passed**. Includes model/Medium defaults, endpoint/project isolation, late archives, duplicate sends, stale acknowledgements, snapshot/delta races, opaque pagination, strict origins, PTY tickets, CRLF SSE, compaction accounting, queue/access and five popup placement regressions.
- The five original independent review reproducers passed unchanged; equivalent assertions remain in the main suite. They are additional acceptance evidence, not five extra product features.
- `env -u NODE_PATH npm run build`: passed (TypeScript + Vite production build).
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: **2/2 passed**, including endpoint validation and an actual multipart roundtrip with synthetic audio.
- `CARGO_BUILD_JOBS=2 env -u NODE_PATH npm run tauri -- build --bundles app,dmg`: passed for the final source; native app and DMG exist.
- `hdiutil verify` on the delivered DMG: VALID. SHA256: `06a8475ca73c48aa386ca3dbabd0d12a6aefeb47b2c80d82cbb9897ff4b4d20c`.
- Build bundle and installed executable match: SHA256 `dec4302d6558fc1072b62bf62d8654eb83603c989e7761b89f40ed5f42bca145`.

### Real browser and native acceptance

All new inference checks used local Qwen3.8 Flash Next / Medium sequentially, in a disposable project. No user project or existing conversation was modified.

- Live API pagination: 200 recent + 124 older messages, zero overlap, using `X-Next-Cursor`. A message-ID cursor reproduced HTTP 400 and was replaced.
- Project/session selection, model defaults, archive/restore, project/endpoint draft isolation and ticket-authenticated PTY reconnect were exercised in the browser.
- While a real bash tool was running, one queued correction was sent with “Скорректировать сейчас”. The same engine loop consumed it at the next step and returned `LIVE_STEER_42`. A separate queued prompt then dispatched automatically once and returned `QUEUE_AUTO_42`.
- Context meter displayed actual usage 9434/131072 and 72486 tokens remaining to the installed engine's 81920 compaction threshold. Engine automatic compaction remains enabled. Manual compaction completed with a real compaction part and successful summary response; a separate automatic overflow run was not forced.
- Read-only access changed the test session's actual permission rules through the API. No global permission configuration changed.
- Final native application selected/resumed the test session, streamed a real read-tool call and answer `NATIVE_CHAT_42`, and displayed the existing file content `SMOKE42`.
- Real native terminal executed `printf "NATIVE_TERMINAL_42\n"; pwd`; output and the correct disposable working directory were visible. The test PTY was closed explicitly.
- A draft was saved, the app was quit and the final bundle installed. Reopening the installed app restored both session and draft. The test draft was then cleared.
- The external OpenCode 1.18.18 server remained running independently. TinyCAD's port 1420 was not used or altered; our development port is 1425.

Popup correction: real browser checks at 1280×720 and 900×620 show unclipped menus, a scrolling model list and upward-flipping sidebar actions; no browser warnings/errors. The rebuilt installed native app also showed the complete agent menu, scrolling model list and filtering by `qwen`, with no clipping. See acceptance notes.

### Installation and limitations

Canonical installed app: `/Applications/OpenCode Desktop.app`. `~/Applications/OpenCode Desktop.app` and the Desktop shortcut resolve to it. Both earlier app copies were backed up locally; the original `Qwen OpenCode.app` launcher was preserved. The delivered DMG is also in the user's Downloads folder.

- Apple Silicon local build; no Developer ID signature or notarization.
- Actual ASR credentials/endpoint were not supplied. Configuration and native multipart transport are implemented/tested; real microphone-to-transcript recognition is not claimed verified. The microphone shows settings when ASR is unconfigured.
- Queued prompts require the app to remain open and their conversation selected; uncertain submissions are paused instead of retried. Steering takes effect at an engine step boundary, not in the middle of an already running tool.
- Access modes are OpenCode permission rules, not an operating-system sandbox. Live permission/question dialogs were not triggered by the configured test policy.
- Finder restricted-PATH/offline restoration, engine upgrades, multiple terminal tabs and advanced Git/worktree/cloud features are not claimed. See roadmap.
- The layout is Codex-inspired; pixel-perfect identity and full proprietary feature parity are not claimed.

## Historical worker report — corrections apply

The remainder is retained as historical evidence, not as current acceptance. Two original claims were wrong: the smoke used DeepSeek V4 Pro; PTY 403 meant a missing CSRF header, not a server quirk.


## Bootstrap — 2026-09-22

- Official create-tauri-app 4.7.4 completed with react-ts/npm/Tauri 2.
- Local OpenCode health reports healthy, version 1.18.18.
- Configured local Qwen model/agent/Medium were found in live API.
- `env -u NODE_PATH npm install`: passed, 27 packages added, npm audit reported 0 vulnerabilities.
- `env -u NODE_PATH npm run build`: passed (TypeScript + Vite 8.3.0).
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed in 1m 09s, Tauri 2.11.6, Rust 1.96.0.
- This verifies the starter only; no product feature or packaged release is claimed yet.

## Product milestones

## M1–M5 core + review pass (R1–R9) — 2026-09-22

Environment: OpenCode 1.18.18 at `127.0.0.1:4096` (externally managed — never started/killed by the app), local Qwen model, dev frontend on `http://localhost:1425`.

Commands and results:

- `npx tsc --noEmit`: clean. `npm run build`: ok (Vite 8.3.0).
- `npm test`: 34/34 — chatReducer normalization, transport/endpoint safety, store regressions R1–R5 (stale-event isolation, draft ownership, agent-choice priority, archive/delete cleanup, reconnect resync), diff util, patch-part contract.
- Review reproduction suite `.local/review` (5/5) mirrored into the repo; findings recorded in `docs/REVIEW-2026-09-22.md`.

Live browser verification (isolated `agent-browser` session, throwaway project `/tmp/oc-smoke`, screenshots under `.local/review/`):

- Startup chain: gate → connected, version shown, selected directory + last session restored from prefs only (no parallel fetch races).
- Terminal (R6): created/attached OpenCode PTY; typed `echo R6_ECHO_$((6*7))` through the real xterm input; `R6_ECHO_42` appeared in the xterm buffer (`term-r6.png`); console errors: none.
- One real streamed prompt (single inference): parts observed `reasoning → tool:write:completed → patch → text`, session went busy → idle; `/tmp/oc-smoke/qwen-smoke.txt` contained exactly `SMOKE42`; UI session-changes showed badge A with `+SMOKE42` (`session-diff.png`). The server policy required no permission for this write — the app auto-approved nothing.

Verified 1.18.18 quirks the adapter now encodes (each found by live probing, not guessed):

- PTY WS: stdout arrives in **text frames**; binary frames beginning `0x00` + `{"cursor":N}` are control only.
- `/pty/{id}/connect-token` answers **403 for every shell** while unauthenticated WS works; rejection is surfaced only if the WS also fails.
- `/session/{id}/diff` can return `[]` even after successful writes; `patch` parts carry the truthful file list, so ChangesTab merges both sources and loads content lazily via `/file/content`.

Not yet verified at the time of writing: Finder launch with restricted PATH, native-window interactive project selection. See M6 entry below. Notification/command-palette parity items remain open and are not claimed.

## M6 package + native smoke — 2026-09-22

- `cargo tauri build`: `src-tauri/target/release/bundle/macos/OpenCode Desktop.app` and `bundle/dmg/OpenCode Desktop_0.1.0_aarch64.dmg`. Unsigned local build — not notarized.
- Installed to `~/Applications/OpenCode Desktop.app` with a Desktop symlink; the existing `Qwen OpenCode.app` launcher was left untouched.
- Native launch outside dev tooling (LaunchServices `open`): window "OpenCode Desktop" rendered the dark shell, connected pill "OpenCode 1.18.18", engine version, and real model/agent/effort options fetched live from `/config` + `/agent` (screenshot `/tmp/ocdesktop-native2.png`). WebKit child processes hold the loopback connections; the external server was never started or stopped by the app. The app quit cleanly afterward.
- **Limitation (honest):** interactive project selection / session resume inside the *packaged native window* was not proven. Synthetic input (System Events keystrokes and a CGEvent click helper) did not drive the WKWebView `<select>`/buttons, and while probing, the user's own apps came to the foreground — further synthetic event injection was stopped immediately to avoid interfering with live work, and one keystroke sequence may have reached the then-focused app (flagged deliberately). The identical store/renderer code path for resume is proven in the browser run above.
- Still open: command palette, desktop notifications, full file viewer (highlight/find/open-in-editor), Finder restricted-PATH + offline-draft-restore check, working-tree vs session diff separation, engine-update flow.
# Agent control MCP — 0.2.11, 2026-09-26

- Added a private per-user Unix-socket control plane and bundled
  `opencode-desktop --agent-mcp` stdio server. Installed app reports 0.2.11;
  installed and bundle executable SHA256 match:
  `4edf4a0ae7bd6c6464fc17c689f2e376a821ff871a9a51d30b3ed5e65fe0f8b8`.
- Global OpenCode JSONC contains only the reserved local `opencode_desktop`
  command with `enabled:true`; live `/mcp` for the project reports `connected`.
  Registration ran through `desktop_install_mcp`, which uses compare-and-save,
  backup, collision refusal and rollback on dynamic connection failure.
- Installed MCP handshake reported server 0.2.11 and 15 bounded semantic tools.
  `desktop_status` matched the visible project/session/model. A real Qwen Flash
  Next read-only review was submitted, waited and read back through MCP session
  `ses_f213ab959ffeqKwsKiqqTdhGx5`; no pointer automation was used.
- That review found wait serialization, fast-idle, partial-install, stalled-client,
  oversized-response and future multi-window delivery risks. They were corrected:
  wait/status/stop/interactions bypass mutation serialization, idle is immediate,
  failed registration rolls back, reads time out at 10 seconds with 32-connection
  cap, oversized replies return an explicit error and events target `main` only.
- Live regression: while `desktop_wait` was active, a second `desktop_status`
  completed in 12 ms and `desktop_stop` in 253 ms; the waiting call immediately
  returned `idle`. The stopped test session had entered OpenCode's normal
  `model is still loading` retry state, proving stop remains available during retry.
- Final verification: 286 frontend tests pass (6 skipped integration tests), 32
  Rust tests pass, TypeScript/Vite production build, Cargo check/fmt and
  `git diff --check` pass. Ad-hoc app signature verifies. DMG verifies with SHA256
  `dc23b5e68e76d221eea0623b44cd8861f9f0dd55e68c83d362c3ab3e6cdc869d`.


## M19 managed browser and Windows driver source import — 0.2.15, 2026-10-05

The owner authorized archive review, cross-platform browser implementation, Mac
acceptance, Git publication and installation. Useful Windows Cua Driver changes
from the supplied archive were adapted and reviewed; the Windows-only InPrivate
WebView browser was replaced by the official Playwright integration described
in [BROWSER.md](BROWSER.md). Neither an agent loop nor model runtime is bundled.

Source verification:

- Full frontend run: 364 passed, 6 opt-in live skipped, one existing acceptance
  test timed out at its five-second limit. Its complete suite subsequently passed
  9/9 in isolation. All 365 frontend tests therefore passed across these runs.
  An earlier full run before the additional 15 browser UI tests passed 350/350.
- TypeScript/Vite production build, Cargo check, fmt and diff check passed.
  Final Rust library suite passed 53/53, including shutdown cancellation.
- Pi extension tests use real tool schemas, bounded discovery, no-process metadata
  loading, failure/abort handling, image/text results and the existing permission
  gate. The extension typechecks against installed Pi 0.85.1.
- Real headed Chromium smoke uses a disposable profile and HTTP fixtures. Passed:
  32 official tools, authenticated loopback and Origin rejection, lazy window
  startup, DOM snapshots, test-password form entry, project upload and outside-root
  rejection, workspace isolation, PNG screenshots, retained login state after
  restart, same SDK connection after daemon restart and reveal preserving a form.

Installed Mac acceptance:

- Desktop 0.2.15 opened from LaunchServices, rendered its native settings and
  restored the existing TinyCAD history/draft. The previously absent local
  service was automatically started: health reports OpenCode 1.18.18. No model
  request was submitted and no user session was aborted.
- First-start browser setup installed Playwright MCP 0.0.83 and Chromium using
  the discovered Node executable. UI confirms readiness and the Browser button
  opens the ordinary visible Chromium window. OpenCode's directory-scoped
  `/mcp` inventory reports `desktop_browser` connected. `/experimental/tool/ids`
  is the engine registry, not the MCP inventory, and is not used as proof of
  browser-tool exposure.
- Global JSONC deep comparison, after removing only the managed MCP entry and
  added skills directory, exactly matches the pre-install configuration. All
  providers, models, plugins and permission rules are preserved. The directory
  skill is discovered on normal engine configuration reload; the existing
  instance's cached `/skill` inventory did not yet show it. Browser tools are
  attached dynamically without restarting an externally managed server.
- Windows and Linux share the implementation, but native browser execution and
  packaging for this release were not tested there. Windows archive reports are
  historical evidence. Mac packages use an ad-hoc signature, not notarization.

Final release acceptance completed:

- `npm run build:macos` produced the final app and DMG; optimized native build
  completed in 7m43s. `scripts/verify-macos.py` and strict codesign verification
  passed. Installed binary exactly matches the final candidate:
  `97804d10882bd9b64ccf8609c672030a0b880adfbfdc7d293167e661bcb0f1dd`.
- DMG passed `hdiutil verify`; its checked copy is in Downloads. SHA256:
  `58073b7b51d17c69ba4ecf29c2b9c970071e96c9ce1bf93ea55085ae674cf3cc`.
  Earlier intermediate packages were superseded and must not be published.
- The final package was installed to `/Applications/OpenCode Desktop.app` and
  reopened. Native UI reports 0.2.15, ready tools, connected OpenCode and configured
  Pi. Both top-bar and settings browser buttons were exercised; the browser is
  left on `about:blank`.
- The real installed Pi 0.85.1 loader and argument validator, via the final
  app's `--browser-mcp`, register 32 tools, enforce the required URL argument
  and successfully navigate/snapshot a disposable local fixture. No prompts,
  model calls, global Pi changes or session history were created.
- Existing OpenCode listener PID3714 remained the same across the final app
  replacement; health and directory-scoped MCP connection remain healthy.
  Old Desktop 0.2.13 is retained in the owner's private app backup.
- Final full Rust suite passed 53/53. The new cancellation test proves its own
  installer child is reaped; review confirms shutdown signals before acquiring
  the owner mutex. Short Node/health/termination deadlines remain, but Quit no
  longer waits for the complete download. Windows shutdown copy correctly
  distinguishes the Desktop gate from unrelated driver sessions.

Published release: [v0.2.15](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.15).


## 0.2.16 — browser/SSH refactor, verified on Mac (2026-10-05)

Claude Code Opus 5.5 reviewed a private source copy directly through its CLI on
Igor. Only Read/Edit/Write/Glob/Grep were available: no tests, builds, applications,
MCP connections or project execution ran there. All tool paths remained inside
that copy. The 252-file result and SHA256 were verified on Mac, then the owned
remote directory was immediately removed before local review and execution.
See `docs/CLAUDE-REFACTOR-20261005.md` for retained changes and coordinator fixes.

- Final full frontend: 375 passed, 6 opt-in live tests skipped. Rust: 70 passed.
  TypeScript/Vite production build, Cargo all-target check, formatting and diff
  checks passed. A late attachment-caption regression was first reproduced and
  fixed; the final complete run includes it and the stopped/config-read failure.
- Real headed official Playwright MCP 0.0.83 smoke exposes 32 tools and verifies
  authenticated loopback/Origin rejection, lazy launch, password fixture, upload
  isolation, screenshots, persistent profile, same-client daemon restart and
  owner-pipe EOF cleanup. Real SDK proxy tests prove delivered mutations are not
  replayed and token rotation before delivery retries exactly once (2/2).
- Final macOS app/DMG build passed. Strict codesign, microphone entitlement and
  usage description passed; DMG passed `hdiutil verify`. Ad-hoc signed, not
  notarized. Final binary SHA256:
  `2f0c913ebdbc2dc853411e213902c07f53eda34c76edc59b7a13d9588ea951f7`.
  Final DMG SHA256:
  `233b1105ebe32d7be163a2229ecfaff3a52d1661303252710f8813f789604c1b`.
  Earlier intermediate packages are superseded and were never installed.
- Installed `/Applications/OpenCode Desktop.app` reports 0.2.16. Old 0.2.15 is
  retained in the owner's private backup. Settings show ready browser tools,
  confirmed project connection and Pi 0.85.1. Stop/disable, re-enable, settings
  opening and top-bar opening were exercised. Project-connected caption remains
  correct after checking Pi. Authenticated daemon health confirms its window open.
- Actual installed Pi loader and argument validation through the final app's
  `--browser-mcp` expose 32 tools and navigate/snapshot a disposable fixture.
  No model requests or user sessions were created, aborted or restarted.
- Script refresh matches bundled sources without dependency reinstall or browser
  download: Chromium hash/inode, dependency manifest inode and installedAt stayed
  unchanged. Complete global OpenCode JSONC deep comparison matches pre-update
  configuration after re-enabling; providers/models/plugins/permissions retained.
  Existing OpenCode 1.18.18 listener PID3714 stayed healthy and unchanged.
- Windows/Linux 0.2.16 compilation and live acceptance remain pending. Windows
  hidden-console and Pi Job Object code has source coverage/review only; this Mac
  release does not claim Windows runtime validation. Live SSH-server restart and
  Finder/nvm launch are integration follow-ups, not measured results.


## Windows result import — 0.2.16 (2026-10-05)

The supplied result contains no new source changes: verified complete bundle and
its SHA match the original main at 2def38234eb4e06a6cf1f39d2e30edb4aed01703.
ZIP CRC and installer PE/size/SHA match the report and verification logs. Windows
logs confirm 375 frontend / 55 Rust tests, build/check/NSIS and real headed MCP
smoke (32 tools). Installed registry/version and healthy OpenCode 1.18.33 match.
These are imported Windows results, not tests rerun by the Mac coordinator.
Packaged toolbar opening, stop/re-enable, Pi chat/tree cleanup, LSP, file input,
dictation and SSH remain unverified; Linux acceptance remains pending.
Installer SHA256: 25c103a867e397f28416e84a251cb3549fc15916d7e0908fcc58f4ae31ec4790.
Installer is an unsigned current-user NSIS release asset, not tracked source.
See docs/WINDOWS-RESULT-0.2.16-20261005.md for provenance, evidence and limits.


## 0.2.17 — embedded browser, chat context and source review (2026-10-06)

The owner authorized direct Claude Code Opus 5.5 review on Igor, file changes
only, followed by Mac review/tests, main publication and Desktop replacement.
Claude ran directly (no Cloud Tasks), exact model `claude-opus-5-5`, with only
Read/Edit/Write/Glob/Grep and no project execution, builds, tests or app launches.
Tool audit: 54 Read, 5 Glob, 38 Grep, 14 Write, 56 Edit, all inside the unique
working copy. Its complete 281-file result was verified against per-file hashes
and archive SHA256 before that remote working copy was immediately removed.
No remote copy was retained for testing. Source manifests, locks, versions and
instruction files were unchanged by Claude.

Transfer SHA256:

- Input source: `524f6e02633ad74701cecc8ec90d25bba4318626d7665a5dfa6013a17c25b446`.
- Returned source: `1f97aee40ebc77231a8b1b57224b26a3749b4547c9af154a3c7e89812c580a6a`.

Imported Windows browser source/provenance is documented separately in
EMBEDDED-BROWSER-IMPORT-20261005.md. Its archived Windows installer/report are
historical 0.2.16 evidence, not a Windows build of final 0.2.17.

Reviewed improvements:

- Scoped recurring chat tasks retain server, directory, engine, model, reasoning
  variant and agent. Bounded read-only preflight rechecks busy queues, questions,
  permissions and model availability; Pi's live model is checked before scheduled
  sends. Sending does not abort/replay an ambiguously delivered prompt. Storage
  failure after acceptance stops scheduling, including if localStorage access
  itself throws; failed corrupt-data backup preserves the original data.
- Context sections are separated, labelled and keyboard accessible. Results keep
  actual provenance, children retain their model/agent/permissions, changed stream
  parts update lists, and late child reads cannot cross connection identities.
- A scoped composer bridge uses the existing chooser/draft. Browser input queues
  are bounded and coalesce waiting text/wheel input without replaying failures.
  Hidden-window/chooser polling pauses; address drafts survive frame refresh;
  stale input completions are isolated. Native HTTP clients are reused without
  idle connection pooling. Context is anchored inside the chat column.
- Coordinator regression checks reproduced and fixed additional child metadata,
  localStorage getter, mutable stream-container memo, corrupt-backup failure and
  stale browser/SSH endpoint cases before accepting the source. Existing runtime
  metadata dependencies in a unit fixture were mocked, preserving its assertions.

Mac validation of final production source:

- `npm test -- --maxWorkers=4`: **451 passed / 6 opt-in live skipped**.
- `npm run build`: TypeScript and Vite passed.
- `cargo fmt --check`, `cargo test`: **71 passed**, and `cargo check --all-targets` passed.
- Two real MCP proxy transport regressions passed; earlier official 32-tool/view
  smoke covered projected pixels, manual input, tabs/history, stale guards,
  auth/Origin, password fixture, file-root isolation, persistence and owner cleanup.
- `npm run build:macos`, `scripts/verify-macos.py`, strict ad-hoc signature and
  microphone capability checks, and `hdiutil verify` passed. Final bundled app
  replaced only `/Applications/OpenCode Desktop.app`; installed binary matched.

Final installed Mac acceptance:

- Real installed CLI exposes 32 official browser tools. Visible projected local
  fixture accepted paste, Backspace, replacement character and button click.
  Browser snapshot plus exact DOM assertions verified both input and button result
  equal `PANEL_UI_OK` (substring matches are insufficient).
- Real installed Pi 0.85.1 extension loader/argument validator registered 32 tools,
  navigated and read the local fixture through the installed Desktop CLI. No model
  requests or global Pi configuration writes were used for this check.
- Native context displayed 41 actual results and 12 child sessions from loaded
  history. It stayed in the chat column beside the browser. Result navigation,
  Tab and separate Escape closure of task form/panel passed.
- Sources + opened the native Mac file chooser with browser panel present. A
  test-owned text file was selected and attached to the original draft, then
  removed. A second native chooser was cancelled and the UI remained responsive.
  Earlier CUA modal timeouts were not reproduced in this final bounded check.
- A test-owned 15-minute task retained the chosen model/variant/agent; it was paused
  immediately, survived normal Desktop quit/relaunch as paused, and was removed
  before first execution. Native scheduled inference was not run; dispatch guard,
  persistence failure, cancellation and refusal cases are unit-tested.
- Original chat and text draft survived. No prompt was sent to the owner's chat.
  External OpenCode stayed healthy (1.18.18, original PID3714); complete global
  JSONC parsed configuration matched the before snapshot. Cached Chromium SHA256
  and inode, MCP dependency inode were unchanged; installed runtime scripts match
  source. Browser returned to about:blank and test-only task/attachment removed.

Final artifact SHA256:

- Mac installed binary: `f54ad4fba99f2b50cd6df2b7f775e20a0c0783ed145fdfcd51cf1d9eb2d2f4a3`.
- Mac DMG: `1f06f287f45ad895c0e119afe270f56f98eed558d7f72b1629a684e872ef14b0`.

Windows/Linux 0.2.17 compilation and native acceptance remain unverified. The
projected page does not implement full IME, drag gestures, native Chromium menus
or page clipboard copying. Multi-process profile lease coherence and live remote
service restart were not newly exercised. macOS signing is ad-hoc, not notarized.
Private transcripts, profiles, credentials and transfer receipts are outside Git.

Publication receipt: main source `cc1fc0b13f51c67a3e1b90f627b88750c15879b9`
was fast-forwarded from the preserved earlier main and pushed; remote SHA matched.
Release [v0.2.17](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.17)
targets that source and contains the final Mac DMG. GitHub asset digest and a fresh
authenticated download both match the DMG SHA256 above; downloaded image passed
`hdiutil verify`. Subsequent publication checkpoint changes are documentation only.


## 2026-10-07 — Browser modes and responsive panel 0.2.21

Shared implementation adds compact tabs/navigation/address/mode/expand UI;
fast semantic-first and enforced mouse/keyboard mode; one bounded focused-field
keyboard tool in addition to the 32 pinned official tools. No dependency,
Chromium sandbox, filesystem-root or permission expansion. Live mode changes
retain healthy MCP connections and are persisted before the next startup.

Real disposable Mac Chromium smoke passed: auth/Origin/lazy startup, forms with
fixture password, approved/rejected uploads and workspace isolation, profile
persistence, native-style pixel/manual input, shared tabs/history, owner-pipe
cleanup. Human mode rejected semantic click and evaluation, stale XY after
1280×800→640×480 returned a fresh image without execution, old manual frame was
refused, keyboard text reached the focused field, responsive target at its new
position was clicked successfully, outside-viewport/shared-input stale actions
were rejected. Official32 plus Desktop1 =33 tools. No model requests/user profile.

Actual Pi0.85.1 extension loader/argument validator passed via the disposable
proxy:33 tools registered, navigation and snapshot reached the real fixture.
This is isolated Pi loader evidence, not an installed app/model-loop test.
Five render-only browser geometry cases at320/440/640/760px, root font14/22,
light/dark: no control overlap/outer horizontal overflow/outside controls;
expand and mode selection responded. Uses actual BrowserPanel/CSS and isolated
stub IPC with inert pixels from the smoke; no production session/config calls.

80 native Rust passed,1 real vault opt-in ignored (unchanged vault already
qualified0.2.19); fmt/check-all-targets and TypeScript/Vite passed. Initial full
frontend481pass/6skip; a later concurrent native-build run encountered the
acceptance beforeEach10s timeout. A one-worker retry reproduced it. Inspection
identified three unmocked runtime-metadata API calls in the old acceptance
harness (providers/agents/config), allowing real server requests during tests.
Mocked these unrelated setup responses; behavioral assertions and timeouts
are unchanged. Final full suite:487passed/6opt-in skipped (65files passed,2skipped); no timeout overrides. New capture-race/client-ownership/mode/bounds tests5/5pass; panel16/16pass.
Mac production app/DMG built successfully. Strict signature and microphone
entitlement check passed, hdiutil verified DMG integrity. Installed binary and
Downloads DMG equal their build artifacts; prior0.2.20app preserved privately.
Installed AX/UI: compact panel, actual human↔fast mode selection, expand/collapse,
real Chromium706×698→1333×694 and panel close passed. Actual installed MCP CLI
lists33tools, observes about:blank, rejects human-mode evaluation with the fresh
recovery image/current dimensions; managed runtime scripts equal source bytes.
No browser navigation, model prompt or owner abort was sent in native acceptance.
External OpenCode3714 remains alive/healthy1.18.18. The prior TinyCAD conversation
still shows its earlier aborted-turn record; no continuation was sent as part
of this browser task. Browser restored to fast/blank and panel hidden; app open.
No further keychain handoff was required. Windows/Linux live0.2.21 remains pending.

Binary SHA256:47f1b3eb61f97574a3e2605881a94a5e0b56eba4973460913b511c70d076935e.
DMG SHA256:fcd34d9a9dec84b114044198fdd876bd0ea53ba180c7013fa43101a19adcdc0f.
Publication receipt: runtime source `7485a140950109474f489dff4e23c95137b1e6a0`
was pushed to GitHub main. Release
[v0.2.21](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.21)
targets that source. Published `AgentMesh.Desktop_0.2.21_aarch64.dmg`
was downloaded into a fresh private directory; its SHA256 equals the local DMG,
the uploaded checksum manifest and GitHub asset digest above. The downloaded
image passed `hdiutil verify`. Installed app still reports0.2.21 and its binary
SHA256 equals the qualified build above. Final publication checkpoint changes
are documentation only.


## 2026-10-07 — Windows PR #1 reviewed and integrated on Mac

Reviewed all ten files of PR head `e0e877e6c0fb329a6c945368abad8bbbe613420d`.
Changes are Windows installation selection/verification helpers, acceptance
runners and documentation; shipped runtime/manifests/locks are unchanged.
The optional Pi acceptance uses the disposable home/AppData and bounded child.
Windows report explicitly separates compiled CLI from installed UI and retains
pending real upgrade/legacy NSIS-key inspection. No speculative uninstall or
registry migration was accepted.

[PR #1](https://github.com/VladimirKraswov/enki/pull/1) was merged
with matched reviewed head. Merge source:
`212c2f451b9241e6407a18d43d7a0feb1213c835`, fetched into local main.
Mac checks: 488 frontend passed /6 opt-in skipped; 80 Rust passed /1 unchanged
OS-vault opt-in ignored; TypeScript/Vite, modified JS syntax and diff checks
passed. PowerShell fixtures were not run on Mac (pwsh absent); eight successful
cases are transferred Windows-agent evidence, not an independent Mac run.

Fresh `npm run build:macos` app/DMG passed strict signing/microphone checks and
`hdiutil verify`. Prior installed signed bundle was backed up privately. Desktop
was closed normally; after confirming the main process exited, the fresh bundle
was copied into Applications and reopened. Native UI loads history, composer,
browser control and local connection. Actual installed MCP CLI lists33 tools
including keyboard input; managed scripts match main. No page actions, model
requests, owner aborts or global provider writes were sent during acceptance.
External OpenCode remains the original PID3714, healthy1.18.18.

Installed binary SHA256 remains
`47f1b3eb61f97574a3e2605881a94a5e0b56eba4973460913b511c70d076935e`:
byte-identical to the earlier qualified0.2.21 binary, consistent with helper-only
changes. Fresh local DMG SHA256:
`e90a5e6cd794d7a3764ac5bcdd35832ecaef79012bf7f262aec9492f88d440c7`.
DMG container bytes differ after repackaging; the existing public0.2.21 release
was not overwritten. Product version remains0.2.21. Windows installed upgrade
and microphone/Pi native UI remain pending as the imported report records.
Subsequent handoff/checkpoint edits are documentation only.

## Browser system performance 0.2.22 — source acceptance (2026-10-07)

509 frontend checks passed /6 opt-in skipped;80 Rust passed /1 unchanged vault opt-in ignored. Production TypeScript/Vite passed. Real isolated Chromium36tools acceptance passes: atomic action, all-step validation before input, compact snapshots, human keyboard chains, second-stale-XY rejection with fresh screenshot, resize interruption of text wait, numeric telemetry, existing auth/origin/workspace/upload/profile/restart guards. Real installed Pi0.85.1 loader and argument validator register36tools and execute the atomic adapter through an isolated proxy (no inference). Per-chat Low request payload/manual override tests pass; this is not a live model speed/quality comparison. Owner sessions/providers/GPU engines/skills and externally managed OpenCode preserved. Final package/install qualification is recorded below. Windows/Linux live tests remain pending.


### Mac package and installed acceptance

Final Tauri app and Apple Silicon DMG built successfully. Strict ad-hoc signature,
microphone entitlement and `hdiutil verify` passed. Installed
`/Applications/AgentMesh Desktop.app` reports0.2.22; binary SHA256:
`345d2c49386193be91c7382599dc1960415ff09d6d28fb0468973ad3e9afbd99`.
DMG SHA256:
`08ce27fae4e1eeba6bba361f8166aa010569b8511788feedc37563078027a3b2`.
The previous signed bundle is privately retained; Downloads contains the verified DMG.

Actual installed CLI registers36tools; managed scripts match reviewed source and
numeric performance health is available. Native settings show tool readiness,
refresh numeric counters, and create an empty browser chat with advertised Low.
Chromium starts before the panel opens; actual ready viewport706×698 and effort
menu (Low selected) verified. Sidebar restored and panel hidden afterwards.
No model request or owner-history research was sent. External OpenCode PID3714
stayed healthy1.18.18; user drafts, sessions, skills and inference services preserved.
Two test-owned empty browser chats were created, with no prompt or attachment.
Initial package candidate missed Chromium startup in this path; it was corrected
and regression checked before this final package, with no publication of the candidate.
No percentage speedup or quality comparison is claimed without task-based A/B.


### Publication

Reviewed source `47bd91a8fe5582afa001cd1cbe26c2c4a9024fb3` pushed to main;
[v0.2.22](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.22)
targets that exact commit. Published DMG was downloaded back: SHA256 equals the
qualified local DMG above and GitHub's asset digest; `hdiutil verify` passed.
Final installed app remains0.2.22 and external OpenCode remains healthy1.18.18.
Subsequent publication checkpoint changes are documentation only.

## 0.2.27 — private LAN library and history (2026-10-08)

-569frontend tests PASS /6existing opt-in skipped;89Rust PASS /1unchanged OS-vault opt-in ignored; TypeScript/Vite build and Rust formatting/check PASS.12Python store/HTTPS tests PASS: authentication/revocation/admin boundaries, replay across devices, actual token counting/reasoning subset, atomic batches, completed-record preservation, approved-only export, retention, SHA256/CAS/path validation, secret redaction, cookies/CSRF/security headers and wrong-CA rejection.
-Real CT206 created: Debian12,1vCPU/1GiB/16GiB, unprivileged/onboot, LAN HTTPS8443, user-owned single-account keys,6real catalog packages. Service uses~12MiB RAM at idle. Reboot returns network/service healthy. No inference/GPU changes; external OpenCode1.18.18 preserved.
-NAS consistent daily SQLite snapshot verified/integrity checked;7rotation/2GiB-free guard. Direct NFS staging rejected chown; local SSD staging parent0711 permits mapped UID traversal. Full198MiB archive SHA256`3bf934847b52883c26f4bc81445d0fed459430e3ec245bdc8ef2efcd49372643` byte-verified on NAS. Restored to isolated unstarted CT207: database integrity/catalog6/TLS key600/source hash PASS; test207 removed. Service source SHA256`dd212b1ec9b197e53e568ca8a1f8c2daaf13961903d8292823e187bf9eab991f` matches restored source.
-Web UI login/layout/empty states verified on isolated localhost fixture; live private HTTPS verified through CA-validating API client. Browser trust of self-signed cert remains an explicit owner step; no security interstitial bypass. Current production never seeded with fake sessions.
-Mac final signed app/DMG built; strict signature/microphone verification PASS; installed executable SHA256`0e7ecf5661cc51e06cf72c721de6651894c9122047f23eebd944ab605ec23ba6` equals built executable. NSLocalNetworkUsageDescription added after Rust LAN probe returned NoRoute while curl succeeded. Owner keychain grant completed. Installed native HTTPS status/catalog passed (6 packages), all3 shared skills installed; real Pi0.85.1 skill loader accepts each without diagnostics.30-day import10088records/0read errors; repeat10088/0errors. Aggregate changed only by2new live replies (+350528reported tokens), confirmed against created timestamps; no replay double-count. Queue0/dropped0. Latest filled SQLite snapshot backed up and verified on NAS. Browser live certificate trust remains an owner step.
-Live Windows/Linux not run. New devices default transmission off; owner Mac opts into redacted texts+metrics. Unknown secrets/PII can survive heuristics; no file/screens/raw tool output/reasoning-body upload. Device attribution is first reporter, not guaranteed task origin. Closed unseen final snapshots may require bounded30-day import. No auto-training or external issue publishing.

Publication: source `6c9fdd71b564d47bab0d79c82bcdd598a8b89c02` pushed to main; public v0.2.27 targets it. Published DMG downloaded back: SHA256`6b6d78ba9a52e656b4ed3aff88df36e13ce11212611862aefe1c884778990898` equals built/Downloads/GitHub digest; hdiutil verify PASS. Final checkpoint is documentation only.


## 0.2.28 — history-guided reliability (2026-10-08)

Observed long-session loss, repeated-redaction corruption and stale file/target errors informed this slice. All available owner history was analyzed privately; session texts, project details and the database are excluded from Git. Imported records without usage and controlled refusal tests cannot establish a model performance score.

Regression checks failed before changes (missing pagination/diagnostics and non-idempotent scrub). Final frontend **574 passed /6 opt-in skipped**, Python service **17 passed**, Rust **89 passed /1 unchanged opt-in vault ignored**. TypeScript/Vite, Rust formatting/all-target checks and Mac package build passed. Four Web regression tests cover latest-first history, note preservation, category filtering/session navigation and late private responses after close/logout. Real isolated Web interaction additionally checked earlier pages, preserved note draft, latest result and logout. Live certificate-validating HTTPS read-only calls traversed a long session without duplicate/lost records; no fake records were written to production.

Mac0.2.28 installed/open; strict signature/microphone checks passed. Installed executable SHA256 `970a57f137b081fd43123153ce257cc405f7ba614afde7efbe456f88f35357b9` equals final build. DMG SHA256 `1c6e8c1367f146f11e7d60f8aa976794945cf964d72de9cdb5ddc7ea23ae04b7`; hdiutil passed. An early verifier ran while build was still producing artifacts and saw the previous version; it was not acceptance evidence. Final checks ran after build completion. Ad-hoc signed, not notarized. Windows/Linux live acceptance remains separate.

Hub source/Web updated; latest full NAS archive byte/hash verified and restored to an isolated, unstarted CT. SQLite integrity, catalog and source hashes matched, TLS key mode600. Test clone and redundant own SSD archives removed only after proof. Three portable skill revisions validated/published; first apply correctly refused while busy. Updated Mac vault access and idle application still require the owner's OS confirmation; no ACL bypass or permission weakening. External OpenCode, owner sessions and inference services preserved; no model benchmark or automatic training ran.

Publication: source `0dbfd0a25131e117f8e162ab44ead51a9e257460` pushed to main; [v0.2.28](https://github.com/VladimirKraswov/enki/releases/tag/v0.2.28) targets it. Fresh published DMG downloaded, byte-compared and hdiutil-verified; GitHub asset digest matches the qualified SHA256 above. Subsequent documentation-only checkpoint preserves the pending owner vault/idle-skill acceptance rather than marking it complete.

Final owner-confirmed Mac acceptance (2026-10-08): installed GUI loaded the six-item HTTPS catalog and displayed all three new skill revisions as installed; repeated installed CLI status returned connected=true. First CLI attempt had a transient connection failure; subsequent GUI and CLI passed without OS ACL/TLS bypass. Actual Pi0.85.1 loader read3/3 current shared skill roots with zero diagnostics. An isolated OpenCode1.18.18 --pure instance on an ephemeral loopback port read3/3 exact current-revision paths through its real skill API and was terminated afterwards. No model requests were needed; owner's instruction to use DeepSeek for any necessary inference was respected, local GPUs untouched. Active owner OpenCode global configuration/sessions remained unchanged; normal shared-source synchronization occurs before the next Enki OpenCode prompt, rather than forcing a reload during the busy turn. Native queue drained99→0, dropped0. Prior pending vault/skill acceptance is resolved.

## 0.2.74 — Workshop review and progressive dictation (2026-10-18)

- Behavioral regressions reproduced JSONC comment-brace corruption, malformed/duplicate config handling, stale catalog publishing and HTTP close-header/socket reuse failure before fixes. Catalog tests preserve unrelated local providers/comments, fail before either write on invalid config, and expose partial CAS safely. Shared prompt tests preserve original user files/drafts/model/variant across manual, queue/steer, schedules and Pi live/reloaded history.
- Dictation tests cover ten minutes of continuous speech, a 30-second thinking pause, observed silence60s, independent container headers, original-draft delivery/receipt deduplication, IndexedDB binary recovery, ASR failure and failed draft acknowledgement, explicit interrupted-record recovery and a recorder missing its final stop event.
- Real isolated Chromium and native macOS WKWebView both sent independently encoded WebM clips to the existing CPU GigaAM. Native WebKit additionally passed real M4A recording/ASR. Synthetic Russian speech appeared in the draft while recording continued, then the remaining clip was delivered after stop. No owner's microphone or private audio was used. Three seconds of synthetic silence returned valid empty text in0.59s.
- WebKit acceptance uncovered Blob-backed IndexedDB rejection: the journal now stores ArrayBuffers. It also uncovered old interrupted audio blocking a new recording: explicit recovery/deletion is required before another microphone start. Native fixture throttling was aligned with the app's disabled-background-throttling setting.
- Hub suite passed on macOS and the actual Debian/Python3.11 CT. Source was backed up before scoped server deployment; the six-model catalog remained byte-identical. Live stale publication returned409 and unauthenticated catalog access401. Closed TLS connections now announce Connection:close; the same live reuse scenario that reproduced ECONNRESET passes after the fix.
- Publication is separate from installation. Windows/Linux native runtime acceptance remains separate; source/hot packets are offered through the canonical Hub publisher. Private receipts and synthetic-audio evidence stay outside Git.

Canonical release0.2.74: runtime `2ba2ea2`; 926 frontend tests passed (6 existing skips),129 native tests passed (3 existing skips),59 Hub tests and9 release-transport tests passed, plus production build/architecture/budgets/fmt/strict Clippy. Receipt `.local/releases/0.2.74-stable.json` verifies head and both signed packets. A second readback matched49 changed source files to Git and all13 hot assets to dist. Installed0.2.73 reports available0.2.74 with kind `source`; this was an offer check, not installation. Agents and the external OpenCode server were not restarted.
