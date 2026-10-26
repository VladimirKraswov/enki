## Reliable updates and canonical session paths (2.0.6)

- [x] Explicit failed-build retry extracts a fresh signed snapshot, keeps diagnostics and displays progress/time/log location; transient component downloads retry twice without weakening authentication.
- [x] Interrupted shard moves validate ownership and checksums before cleanup; missing targets recover from a verified source, conflicts preserve both files. UI selections, project bindings and drafts follow committed moves within their host.
- [x] Continuation seeds estimate their actual content instead of inheriting the archived context's token totals; immutable archive accounting remains available.
- [x] Native upgrades retire authenticated superseded hot UI without a false corruption warning; genuine tampering and incompatible newer bundles remain errors.
- [ ] Canonical gates, exact CI, signed Hub publication, native installation and owner-history acceptance.

## Archive acceptance follow-up (2.0.1)

- [x] Actual owner archive imported read-only:255 sessions/47239 messages/211229 parts.
- [x] UI archive reads now project one tail page, preserving cursors and V1/V2 order without expanding the complete transcript; full import validation remains strict. Five reader regressions, ten integration checks and167 public SDK tests pass. Actual200-message tail:5.607s,~121MiB peak RSS.
- [x] Lost import acknowledgement follows its exact durable job/source/archive with bounded read-only reconciliation and connection fencing; no repeated POST. Six focused UI checks pass. A separate continuation deadline allows the measured25-second seed and fails boundedly at120seconds without replay; its regression passes.
- [x] Canonical2.0.1 publication, fresh runtime/native package/current CI and actual owner archive/workshop/continuation acceptance.

# Enki roadmap

## Enki 2.0 — sole bundled Pi SDK runtime

Sections below are the 0.2.x history (external OpenCode/Pi engines). 2.0 status:

- [x] Source: one bundled Enki Runtime (pinned Node + Pi SDK, `scripts/runtime/sdk-contract.mjs`); OpenCode execution removed; OpenCode/Pi CLI histories read-only with explicit continuation; paired backups and journaled remote installer; first 0.2→2.0 source update prepares the runtime through `npm run tauri`.
- [x] Source: reviewed SDK upgrade workflow (`docs/SDK-UPGRADE.md`), canonical release gates before credentials (`docs/VERIFICATION.md`), remote host procedure (`docs/REMOTE-RUNTIME.md`), evaluation adapter on the pinned SDK (`docs/EVALUATIONS.md`).
- [x] Source review and full local code qualification of the V5 snapshot on Mac: whole runtime/frontend TypeScript, 347 runtime Vitest, 161 public Node and 1070 frontend cases. Native compilers and guarded tests, public artifact/release/Hub/catalog/ASR checks passed with their explicit sandbox/platform limits. Old engine/client/installer copies retired only after replacement checks; original failures and evidence preserved.
- [x] Synchronized application version 2.0.0; SDK and helper versions stay independently pinned.
- [x] V8 protected-workshop identity bridge: exact source-bound archive lookup, no empty replacement on missing/ambiguous import; focused runtime9/9 and frontend30/30 plus both TypeScript checks passed.
- [x] V11 genuine prepared/relocated runtime, actual SDK/PTY/ripgrep/fd/HTTP smoke, and V13 ad-hoc signed Mac app/DMG with the original complete post-sign inventory verified. Linux full CI/package passed; Windows runtime/artifact/frontend/Hub suites passed.
- [x] Native profile storage now uses explicit WebView builder settings, including the detached browser viewer. Config conversion in the pinned Tauri omitted these fields; unsupported macOS test profiles fail closed. Mac all-target check/strict Clippy/test compilation and focused profile2/path5 checks passed.
- [x] V18 actual native test-profile isolation and authenticated Hub catalog read passed. V19 full Windows native232/build-runner6 and Linux package passed. SDK auth reads now use a bounded per-broker queue; six regressions and162 public Node tests passed, including OAuth/CAS and actual concurrent SDK auth.
- [x] Official Node npm empty directories are normalized together with app dependencies before signing; both trees validate before deletion, shared traversal limits retained. Public native-port/artifact/prepare37 passed/1 Windows skip; original strict inventory unchanged. Windows packaging regression before the fix is retained.
- [x] Stable 2.0.1: exact three-platform CI, genuine prepared runtime, signed Mac app/DMG, canonical Hub receipt and both verified packets; owner app replaced and all 31611 installed files verified. Real history imported (255 chats); protected workshop and explicit bounded continuation verified; ordinary Qwen Medium/PBR acceptance completed. Original CLI sources remain unchanged; earlier profile failures and final evidence retained privately.

Full release gates and platform builds follow [VERIFICATION](docs/VERIFICATION.md).
A version in source does not establish publication or installation: verify the
canonical signed Hub receipt, served source/UI packets and the installed build
separately. Focused regression counts are not a full-suite or live-model claim.
- [ ] Separate live acceptance: Windows Job/NTFS first update and rollback, remote Linux host install/update/rollback, ordinary-user upgrade from 0.2.x.

## Compact task context and available models (2.0.2)

- Source: three compact chat controls; named keyboard actions for terminal, changes, handoff and recovery. Context prioritizes schedules/results/children/sources; timer details and technical tools expand on demand. Long titles retain fixed action slots.
- Source: model picker groups owned local models, authenticated paid routes and explicitly free API routes. SDK catalogue alone is not access or pricing proof. Read-only discovery is bounded, cached, credential-scoped and cancellable; unloaded Hub models remain selectable without loading a GPU.
- Source: explicit credential-only Pi transfer preserves existing keys, Hub models and legacy files. Idle SDK defaults no longer display a false working badge or empty extension bar.
- [x] Canonical gates, exact three-platform CI, both signed Hub packets and owner installation verified. Actual native compact toolbar/context and idle state checked; DeepSeek key-only import and local/paid picker verified after owner OS permission. Original CLI data unchanged; owned builds cleaned.

## Independent application language (2.0.3)

- Main settings, model catalog, memory, history and recovery use Enki terminology. Optional external imports and compatibility fields are secondary; data provenance and recovery actions remain available.
- Generic progress appears once in the chat; explicit extension progress, draft conflicts and recovery remain visible when relevant.
- Context panel smoothly reserves space beside the live chat and composer; compact screens retain a readable chat width. Closing/reopening preserves draft, focus and mounted agent views; system reduced-motion preferences are respected.
- Settings search preserves staged forms. Browser profiles remain staged across navigation and warn before exit; manual controls expand below ready profiles. Model search distinguishes no matches from unavailable connections; command search and pickers support keyboard focus/return.
- All1107 frontend tests, TypeScript/build and isolated dark/light layout checks passed. Original copy assertions reflect requested terminology; behavior checks retained. Delivery is recorded by the canonical signed Hub receipt and installed UI acceptance.

## Reference image editing and bounded revisions (0.2.115)

- [x] Actual authenticated bounded PNG/JPEG/WebP references; qualified FLUX.2 Klein4B instruction edits with private immutable source/provenance. Blue-hair request succeeded at512px/131s; source/config/weight reproduction verified. SDXL remains new-image renderer and explicit legacy redraw.
- [x] Trusted OpenCode/Pi session/request context; current/retained original and persistent latest-result editing, including text-only chat models with explicit Vision limitations.
- [x] Native OS-lock journal enforces two total jobs per human request; automatic wakes retain the budget, scoped idempotency/read-only lost-ack recovery, monotonic latest and safe local reuse.
- [x] Both primary pipelines preload and remain resident, optional variants bounded to1; approximately30.4GiB combined qualification RSS,64GiB unit cap, actual readiness in health/settings.
- [x] Actual native MCP/API proof: attached portrait → blue hair → red dress → white flower, provenance hashes follow the previous result; third attempt in one human request rejected. Subsequent SDXL generation succeeded with both models still resident.56 CPU tests;113 canonical1136 frontend/177 native, both pinned Hub packets49 source/20 hot byte-exact.
- [x] Windows lock contention recognizes the platform fs2 code;7 focused native checks pass. Queue recovery and invocation ordering from114 preserved.
- [x] Stable115 canonical1138 frontend/6 skipped,178 native/3 ignored,83 Hub,3 ASR,15 publisher; all build/architecture/bundle/fmt/strictClippy gates pass. Receipt/head/both pinned signatures and51 source/20 hot files byte-exact; main pushed.
- [x] Owner-approved native update installed115 through signed Hub source build; entire installed tree matches the hash-bound install plan and code signature validates. External OpenCode server preserved. Ordinary Qwen Medium chat with a real PNG chose image_inputs → edit_image; owner follow-up automatically used latest. Two successful512px Klein jobs137.61/139.02s, source SHA links exact previous output, no tool errors, actual image reads and visible inline card. Both primary models remain resident. Windows/Linux live acceptance remains separate.

## CPU image quality and periodic texture inference (0.2.109)

- [x] Quality/explicit-draft profiles, native SDXL inference resolution, exact distilled sampling, style preservation, one resident CPU pipeline and honest loading status.
- [x] Circular UNet AND VAE convolutions; wrapped resizing/derivatives; remove destructive border crossfades. Matched tokenizer/CLIP integer input compatibility without changing model values.
- [x] Actual CPU visual comparison: SDXL illustrated portrait58.72s including load, periodic stone85.86s; rejected the misleading anime export (realistic result88.74s). Target12 CPU threads; benchmark peak16.1GiB, no swap. Deployed with exclusive idle-job guard and rollback; ASR process preserved.18 backend checks pass.
- [x] Actual Enki ordinary anime request: sharp2D portrait shown/opened in chat, Vision review and two bounded corrections. Exact eye/clothing color binding still failed; no claim of perfect prompt adherence.
- [x] Live neural brick generation failed regular masonry geometry; explicit procedural brick/granite recipes now produce periodic albedo and authored aligned height instead of pretending that diffusion is exact. CPU proofs0.886/0.834s;24 backend tests include legacy idempotency and cache invalidation.
- [x] Actual ordinary Enki request: procedural brick eight-card set, normal/16-bit height, valid9-entry ZIP, full2×2 viewer and folded-progress visibility; authored source verified in manifest. Installed108 generic tool prose still mislabeled height as luminance-derived;109 metadata/inference output corrects that description (history preserved).
- [x] Canonical1120 frontend/6 skips,171 native/3 ignored,83 Hub,3 ASR,15 publisher; build/architecture200/bundle/fmt/strictClippy pass. Stable0.2.109 receipt, served head and both pinned signatures verified;29 changed source and20 hot files byte-exact. CPU7 deployed modules equal committed bytes;24 backend tests pass. New native package offered separately; current108 already uses the upgraded CPU service without interrupting owner agents.

## CPU images and material maps (0.2.108)

- [x] Dedicated authenticated resident OpenVINO LCM CPU worker in CT201; bounded durable jobs, idempotency/progress/cancel/partial recovery, private nginx route; ASR preserved.
- [x] Configurable image API/provider/model with OS-vault key, per-setting help and read-only probe; shared OpenCode/Pi image/icon/material tools, real Vision blocks on request. Inline results remain visible outside folded work; bounded lazy previews and remote exact-job retrieval.
- [x] Matched16-bit height/tangent normal OpenGL or DirectX/scalar roughness and metallic, opposite light previews, tile-edge tests and ZIP/manifest. Height is explicitly approximate.10 service tests, actual CPU/MCP/ZIP and pixel review; frontend/native/full release gates follow.
- [x] Canonical1119 frontend/6 skips,169 native/3 ignored,83 Hub,3 ASR,15 publisher; build/architecture200/bundle/fmt/strictClippy pass. Stable0.2.108 receipt, served head and both pinned signatures verified;33 changed source and20 hot files byte-exact. CPU deployed server/materials SHA256 equal Git source;10 backend tests and real6-tool MCP/PNG/ZIP/Vision acceptance pass. Native installation separate; owner agents preserved.


- [x] Installed 0.2.108 through the signed Hub source-build/update flow on Mac. Real Enki chat with an ordinary Russian material request: Qwen Flash Next Medium selected material/status/retrieval tools, received Vision pixels, performed two bounded corrections and finished without tool errors. Eight visible cards survive folded progress; full normal-map viewer opens. Final ZIP has eight PNGs plus manifest and passes CRC validation (seven maps at 512×512; tile preview 768×768). CPU LCM tiling/repetition and luminance-derived height remain documented quality limits.

## Session wake-ups and activity indicators (0.2.107)

- [x] Agent-facing scoped schedule MCP shared by OpenCode/Pi; once/repeat, stable create keys, bounded durable scheduling, cancel/list/pause/resume without changing the visible chat. Native Windows loopback control transport, Unix socket retained.
- [x] Global schedule list; fixed status slots and title ellipsis; shared frame clock survives recent-row moves without individual CSS animation restarts, honors reduced motion and visibility.
- [x] Native maintenance retires only this process’s tracked idle server, checking all session directories/PTYs/interactions before an update. Current owner-approved old-server recovery completed; both interrupted chats resumed.
- [x] Canonical1112 frontend/6 skips,164 native/3 ignored,83 Hub,3 ASR,15 publisher; build/architecture197/bundle/fmt/strictClippy pass. Stable0.2.107 receipt, served head and both pinned signatures verified;38 changed source and19 hot files byte-exact. Native installation separate.

## Hooded Enki mascot (0.2.106)

- [x] Apply the owner-selected transparent mascot to sidebar/favicon and every desktop Tauri icon from the same raster master. Native update required for Dock/tray/launchers.
- [x] Canonical1100 frontend/6 skips,160 native/3 ignored,83 Hub,3 ASR,15 publisher; build/architecture194/bundle/fmt/strictClippy pass. Hub stable0.2.106 receipt; both downloaded pinned signatures verified,26 changed source/19 hot files byte-exact. Native fingerprint changed; owner installation separate. Actual built UI and32/128px/ICNS previews checked.

## Device publication and Windows browser fixes (0.2.104)

- [x] Review/adopt six Windows source/test files; add stale-presence response guard. 92 focused frontend tests pass. Supplied installer SHA256 matches report; Windows execution is contributor evidence, not a Mac acceptance claim.
- [x] Add paired-device publication with isolated Unix-socket signer; no client signing/admin key. Server validates source versions/fingerprint; compare-and-swap protects concurrent releases and revoked keys are checked again before commit.
- [x] Cross-platform release command retains all local gates, verifies actual bytes and pinned minisign signatures; missing operator config selects device path. Native CLI keeps installed device key in vault. Workshop context/runtime explain this path.
- [x] Canonical0.2.104/runtime63396dc:1094 frontend/6 skips,160 native/3 ignored,83 Hub,3 ASR,15 publisher; build/architecture194/bundle/fmt/strictClippy all pass. Published through an ordinary paired device (admin API403 confirmed), central minisign signer and pinned key. Receipt .local/releases/0.2.104-stable.json; live head and both signed packets verified,36 changed source/19 hot files byte-exact. Native actual-packet acceptance/tamper/version tests pass for BOTH source and hot envelopes. Native fingerprint changed from0.2.103: native update required; application installation remains separate. Temporary device revoked(HTTP401), provisioning key/config copies removed; root-owned deployed Hub modules match reviewed SHA256 and HTTP cannot read signer key.

## Water glyph app icon (0.2.103)

- [x] New gold water/cuneiform-inspired glyph on a lapis tile, generated as a transparent raster master. Replace sidebar, favicon and all desktop native icon formats from the same master; retire obsolete E vector.
- [x] Inspect 32/128px PNGs and extracted macOS ICNS; validate Windows ICO entries, PNG dimensions and release versions. Keep UI/favicons at 256px instead of loading the 1.86MB master.
- [x] Canonical0.2.103/runtime547981d:1089 frontend/159 native/77 Hub/3 ASR/11 publisher and all gates pass. Receipt .local/releases/0.2.103-stable.json; served head and both signed packets verified,28 changed source files (all icon containers/master/UI PNG) and19 hot files byte-exact. Native fingerprint fb636127… changed: native update required for Dock/tray/launcher. Publication complete; owner installation separate, active agents preserved.

## Hub reconnection and expired reservations (0.2.102)

- [x] Typed native transport failures distinguish timeout, network, TLS, interrupted responses and HTTP status without exposing raw URLs, credentials or response text. TLS/auth/validation conflicts never retry.
- [x] Bound automatic reconnect to three attempts with cancellable backoff; preserve profile identity and retry only reads/status or prepare with the SAME idempotency key. Never retry an agent prompt or unkeyed mutation. Show reconnect attempt in the model status.
- [x] Recover explicitly expired inactive leases/keys once before dispatch; preserve active reservations and distinguish busy/routing conflicts from ticket expiry.
- [x] Owner-authorized macOS LAN permission refresh returned installed Enki from connection failure to an authenticated HTTP409 response; obsolete lease bug reproduced in code/tests. Rust standalone probe still denied LAN, distinct executable identity; no certificate bypass.
- [x] Canonical0.2.102/runtime3487913:1089 frontend/159 native/77 Hub/3 ASR/11 publisher and all gates pass. Head/both signed packets verified,18 changed source/19 hot files byte-exact. Existing installed client resumed owner work after permission refresh; new native update remains unapplied while that work is active.

## Safe transfer to a smaller model (0.2.97)

- [x] Detect previous-model usage above the target input budget; preserve history through one native compaction by the previous larger model before destination loading and selection.
- [x] Require a fresh complete nonempty summary within destination budget including preserved recent steps. HTTP acknowledgement alone never commits the target; pending completion is bounded and observed without request replay.
- [x] Preserve drafts/history on failure and cancellation; whole-transition locks cover manual, queued and scheduled dispatch through destination readiness. Check source availability, pinned compaction role, authoritative busy/permission state and navigation identity.
- [x] Recover an already switched oversized chat via «Сжать сейчас»; explain failures in Russian and display transfer stages. Do not count summarization input as the resulting working context.
- [x] Installed1.18.18 isolated fixture: one synthetic previous-model request, auto:false, completed summary, original user history retained. No owner prompts/GPU. Focused regressions/build/architecture pass.
- [x] Canonical0.2.97/runtime79006a5:1055 frontend/149 native/77 Hub/3 ASR/11 publisher and all gates pass. Head/both signed packets verified,21 changed source/19 hot files byte-exact; native fingerprint equals0.2.96. Activation separate.

## Dictation tails and MCP outage notices (0.2.96)

- [x] Complete newly rotated audio clips after a bounded 400 ms minimum; keep every sample, independent container headers, durable recovery and a five-second recorder deadline.
- [x] CPU GigaAM accepts valid short decoded audio using its existing padding; zero samples returns empty text, corrupt audio still fails. Checked deployed service against synthetic silence, damaged data and Russian speech.
- [x] Clear resolved ASR errors without clearing capture/storage errors; distinguish HTTP audio failures from credential failures.
- [x] Announce an MCP outage once per scope/episode, clear its own notice after recovery, retain unrelated notifications and genuine outage visibility. Web Compass disabled LaunchAgent re-enabled; actual engine MCP connection restored.
- [x] Canonical0.2.96/runtime36c4b61:1041 frontend/149 native/77 Hub/3 ASR/11 publisher and all gates pass; head/both signed packets verified,23 changed source/19 hot files byte-exact. Client activation separate.

## Fullscreen tray and global policy recovery (0.2.95)

- [x] macOS exits the fullscreen Space via its native completion notification before hiding the application; reopen restores fullscreen, duplicate close and rapid reopen preserve the intended visibility. Other platforms and explicit quit retain existing behavior.
- [x] A stale global OpenCode plugin cache is refreshed through its official API only after bounded whole-engine idle verification (legacy directories and v2 drains), native JSONC CAS staging and confirmed global disposal event. Reattach shared/browser MCPs before dispatch; never replay a prompt.
- [x] Installed1.18.18 isolated server reproduces stale global cache after scoped disposal and passes recovery. Owner cache repaired while idle, global/project read-back and unchanged config semantics verified; no owner prompt/inference/server kill.
- [x] Repeatable native Mac fixture checks actual AppKit hidden/fullscreen state, preserved background worker and rapid reopen; no owner data/agents. Focused protocol, busy/unknown/truncated inventory, cancellation and cache regressions pass.
- [x] Canonical0.2.95/runtimea9c8057:1037 frontend/148 native/77 Hub/11 publisher and all gates pass; head/both signed packets verified,23 changed source/19 hot files byte-exact. Native fingerprint changed; owner installation separate.

## Bounded active conversation rendering (0.2.94)

- [x] Keep mounted history at 60 messages while following, up to 120 while reading; restore the appropriate bounded window on chat return, preserve older/newer/search/scroll navigation and all canonical history.
- [x] Reuse four date formatters; avoid a full history copy/scan for the latest request on every stream event. Page oversized Markdown as bounded plain text with full-source copying.
- [x] Collect Hub records incrementally, yield every 25 records and retain compact weak cryptographic receipts; never clear and resend an unchanged 5000+ message history.
- [x] Safe synthetic 20k/5k chat fixture: repeated switches, live growth, reader restore/search/newer/latest and oversized text navigation pass. System CPU report is corroborating evidence only, not proven cause of the owner reboot.
- [x] Canonical0.2.94/runtime1e35bc2:1029 frontend/148 native/77 Hub tests and all gates pass; receipt/head/both packets verified,20 source/19 hot files byte-exact. Native fingerprint equals0.2.93. Owner native performance acceptance remains separate.

## Engine extension cache invalidation (0.2.93)

- [x] Materialize policy/browser hooks and relative dependencies in one immutable content-addressed graph. Native catalog supplies current paths and verified retired aliases/revisions; no arbitrary prefix/name deletion.
- [x] Both browser/shared config writers replace duplicate managed plugins and preserve foreign plugins/permissions. Migrate global and project layers before checking effective loaded configuration, then reload only idle scoped instance before connecting tools.
- [x]65 focused frontend tests and native graph ownership/digest/tamper/alias test pass. Actual installed engine metadata-only isolated probe confirms same-path module stays stale after dispose, immutable URL loads new code. No owner prompts/replay/instance/server actions.
- [x] Canonical0.2.93/runtimec93b446 release, served head and both signed packets verified:17 changed source/19 hot files byte-exact;1020 frontend/148 native/77 Hub tests and all release gates pass. Native update required; owner activation separate.

## Conversation UI performance (0.2.92)

- [x] Select message presentation by actual part identities rather than global state; retain same-tick mutable reducer updates and stop background-chat repainting of unaffected answers. Memoize unchanged turn props.
- [x] Mount folded historical step bodies on first disclosure, preserve visited step/editor state, and defer tool-input serialization until its card is open.
- [x] Cancel obsolete history reads on navigation without aborting agents. Show cached cross-directory chat immediately, preserve latest selection during metadata load.
- [x]66 focused behavior checks and isolated real Chromium before/after:30 historical steps, median965ms→8.3ms,7920→60 DOM nodes,30 background events→0 answer commits. Live text/disclosure verified. Fixture measurements, not whole native app latency.
- [x] Canonical0.2.92/runtime1fb4663 release and served packet verification:13 changed source/19 hot files byte-exact;1017 frontend/147 native/77 Hub tests and all release gates pass. Native fingerprint equals0.2.91 (hot compatible from that version).

## Migrated session directory identity (0.2.91)

- [x] Access-policy and browser session hooks recognize existing filesystem aliases by real directory identity; retain exact session IDs, scoped API calls, root-policy inheritance/revocation and foreign-directory rejection. Update acknowledgements also validate ID/directory.
- [x] Actual affected projectless session passes read-only access resolution through the installed engine API with canonical Enki path. Seven regression cases cover mixed ancestry, browser access, foreign/missing/redirected paths and mismatched update acknowledgements.
- [x] Canonical Hub release and exact packet verification:0.2.91/runtime3d90d11,9 source/19 hot files byte-exact;1012 frontend/147 native/77 Hub tests plus build/architecture/budget/fmt/strict Clippy pass.

## Generic command execution feedback (0.2.90)

- [x] Shared timeout interpretation for OpenCode and Pi, based on terminal executor markers; original output and permissions preserved. OpenCode title/metadata and Pi error feedback distinguish incomplete checks from successful execution.
- [x] Every-dispatch guidance covers observable completion, GUI/server lifecycle, env vs arguments, redirected logs, exit status and diagnosis before retry. Existing v1/v2 Pi history stays hidden only in its own session.
- [x] Synthetic hook/approval/history regressions and actual installed Pi executor isolated timeout/success checks, without inference or owner process actions.
- [x] Canonical release and served packet verification:0.2.90/runtime50a8ee5,16 source/19 hot files byte-exact;1005 frontend/147 native/77 Hub tests, build/architecture/bundle/fmt/strict Clippy pass.

## Optional MCP resilience and Node aliases (0.2.89)

- [x] Canonicalize only an absolute Node JS entrypoint at stdio spawn, preserving flags/config/output args, cwd and non-Node commands; ship the helper with the shared runtime.
- [x] Optional server connection/missing-runtime failures produce an explicit unavailable report instead of blocking every prompt; continue other attachments,30s revision-scoped cooldown, explicit invalidation. Critical config/CAS/policy/context failures remain fatal.
- [x] Current Web Compass script argument repaired under registry lock/CAS/private backup; scoped failed MCP reconnected and27 tools discovered without tool calls or prompt replay.
- [x] Canonical Hub publication and exact packet verification:0.2.89/runtimeac032a9,15 source/19 hot files.

## Built-in skill path migration (0.2.88)

- [x] Authoring source ownership uses canonical direct-child bundle identity, accepting the retained legacy root alias while rejecting redirected, missing and foreign sources. Disabled choice and other registry entries remain intact.
- [x] Native regression reproduces the migration failure before the fix; real rename/alias/idempotency/foreign registry preservation checks.
- [x] Current owner registry repaired under its lifecycle lock with a private backup/CAS and verification that only one source path changed; no prompt replay or restart.
- [x] Canonical release and exact Hub packet verification:0.2.88/runtime7481c97,8 changed source/19 hot files.

## Enki MCP wrapper migration (0.2.87)

- [x] Browser and shared MCP reserved entries recognize both shipped executable identities across the rename, retaining private flags and exact scope/server checks. Foreign and malformed entries remain protected.
- [x] POSIX case sensitivity and Windows drive/UNC comparison; idempotent wrapper rewrite preserves JSONC, unrelated tools and permissions. Four migration regressions fail before the fix.
- [x] Canonical Hub publication and exact packet verification:0.2.87, runtime6b6fb04, 13source/19hot files; published fingerprint matches0.2.86.

## Web discovery recovery (0.2.86)

- [x] Reject generic software/GitHub RSS results when the query names an actual project; preserve query-specific misses and GitHub repository fallback.
- [x] Shared OpenCode/Pi workflow distinguishes missing URLs from access/network failures and directs repository discovery/branch/tree verification after two404s. Exact old Pi reminder remains hidden in history.
- [x] Portable reliable-web-search skill records the same bounded recovery; no owner session prompt, tool replay or inference.
- [x] Canonical Hub publication and served packet verification: 0.2.86, 13 changed source files and 19 hot files byte-match runtime6365de0.

## Full-access loop guard consistency (0.2.85)

- [x] Explicit loop permission in full session rules; migrate both legacy representations before the next prompt, including delegated work.
- [x] OpenCode 1.18.18 loop checks use only agent permissions: the client adapter answers only doom_loop, once, after checking the actual session ancestry and selected full mode. No global Always allow or UI autoapproval.
- [x] Fail closed on unavailable/foreign/cyclic context; preserve ask/read/inherit and manual approval after API failure; deduplicate ambiguous replies.
- [x] Canonical Hub publication and exact signed packet verification: 0.2.85, runtime 2d9cd1a; 13 changed source files and 19 hot files verified.

## V100: проверенные профили и переключение — 2026-10-20

- [x] Research and sequential same-checkpoint/native-context qualification for all four V100 profiles; reject faster candidates with long-context/numerical regressions.
- [x] Full GPU target/draft text placement for Gemma/Artemis; immutable runtimes, original contexts/policies/budgets and inactive caches retained; Artemis MTP2 qualified.
- [x] Linux TIME_WAIT handoff fix, explicit gateway route/startup boundaries and silent-prefill disconnect propagation with failing-before TCP regression.
- [x] Seven actual OpenCode/Pi tool turns, all four prefill/decode cancellations and Pi-only403 gate; final defaultQwen/oneGPU process, own test infrastructure cleaned. See [operator report](services/v100/README.md).

## Обязательный выпуск в мастерской — 0.2.64

- [x] Permanent owner authorization repeated as hidden scoped context for manual, queued/steer and scheduled prompts; shared OpenCode/Pi contract and Pi history preservation.
- [x] Explicit no-deploy/analysis requests keep priority; tests and actual Hub packet/receipt verification required before claiming delivery. No automated loop or permission bypass.
- [x] All867 frontend/126 native/48 Hub/9 publisher checks, actual OpenCode noReply context persistence, verified Hub0.2.64 and active native UI assets; original session/model/processes preserved.

## Контраст выделения — 0.2.63

- [x] Use system Highlight/HighlightText for selected text instead of low-contrast accent tint; regression assertions preserve the contract.
- [x] Verified Hub0.2.63 signed packets, actual active native cache digest and acknowledgement; production CSS Chromium selection in both themes.

## Подсказки настроек — 0.2.62

- [x] Small question buttons with named modal explanations for browser parameters, agent permissions, shared capabilities, Hub, model services, appearance, ASR, updates and backups.
- [x] Full browser value/tradeoff explanations, on-demand loading, keyboard focus/return and Escape isolated from settings; no settings mutation or secret copying.
- [x] Full858 frontend/126 native/48 Hub/9 publisher tests,22 real Chromium settings surfaces, verified signed Hub0.2.62 and actual installed0.2.61 hot-update offer. No activation while owner works; Windows/Linux native acceptance separate.

## Мастерская — 0.2.61

- [x] One protected development chat above projects, app-owned workspace and shared OpenCode/Pi project instructions, source detection and no-key disclosure.
- [x] Store-level delete/archive/rename/project-hide guards, per-server identity and reconciliation before creation.
- [x] Private local release operator runs mandatory checks before credentials/publication; canonical publisher and Hub receipt remain authoritative.
- [x] Full checks, isolated Chromium and actual native workspace/UI/identity persistence; signed Hub release and Mac installation verified. Pi context loader verified without inference. Windows/Linux native acceptance remains separate.


## Footer update indicator — 0.2.59

- [x] Update circle placed inside the Enki/connection/settings footer; narrow240/304px and settings navigation verified.

## Hot update visibility — 0.2.58

- [x] Small UI-only update: checking button displays progress; native compatibility with installed 0.2.57 retained.
- [x] Canonical Hub stable0.2.58 publication verified; installed0.2.57 reports available:true/kind:hot.
- [ ] Owner applies the offered hot update to observe it; no automatic activation.

## Browser profile customization — installed 0.2.57

- [x] Shared OpenCode/Pi environment settings and standard/compatibility/private presets alongside existing fast/human modes.
- [x] Actual Chromium/installed Chrome selection, embedded/headed launch, locale/timezone/media preferences, bounded agent pacing, opt-in automation-marker reduction and privacy controls.
- [x] Strict runtime option allowlist; atomic private configuration; existing-context snapshots, separate engine/session profiles and awaited temporary-profile cleanup.
- [x] Full automated checks and isolated real Chromium/Chrome plus narrow/wide settings UI acceptance. Details: [browser preferences](docs/BROWSER-PREFERENCES.md).
- [x] Signed macOS package, Hub stable publication and installed 0.2.57; see [release acceptance](docs/RELEASE-0.2.57.md).
- [ ] Headed window and Windows/Linux OS acceptance remain separate.

## Hub updates and background runtime — 0.2.56

- [x] Authenticated atomic Hub publication of signed complete UI/source packets; guarded stable/preview channels and release page.
- [x] Native compatibility fingerprint; pinned-key verification before use, local hot asset provider, health acknowledgement and rollback.
- [x] Background source compilation with prerequisite checks, cancellation/deadlines, idle native install, private backups and platform helpers.
- [x] Green/yellow update indicator and persistent background update controller. Window close hides to tray; explicit quit saves and stops owned agents.
- [x] Source/package acceptance: full checks, signed HTTPS packets, native asset activation/cache recovery, source rebuild, Hub deployment/publication and 0.2.56 bootstrap release.
- [x] First normal GUI install/launch and actual native Hub connection on macOS verified in 0.2.57.
- [ ] Tray clicks/active-agent update and Windows/Linux installation remain separate OS acceptance; privacy restrictions on isolated older binaries are not bypassed.

## Reliability, skill quality and updates — 0.2.53

- [x] Durable SQLite delivery receipts with attachment recovery and exact public-history reconciliation.
- [x] Selective shell/sidebar subscriptions, batched text events, lazy settings and enforced bundle budgets.
- [x] Interruption, disk, lost-acknowledgement, backup and skill-quality fault gates in CI.
- [x] Attention center with scoped chat navigation and unsent-draft recovery.
- [x] Revision-bound skill candidates, measured paired trials, guarded promotion and rollback.
- [x] Stable/preview signed updates, native idle gate, private data/application backups and guarded restore.
- [x] Pi Full/Allow/Stop/reconnect and startup probe repairs; ordinary Quit versus interface restart.
- Native installation and published-feed verification are recorded separately in [evidence](docs/DEVELOPMENT-20261015.md).

## Reliability and architecture audit — 2026-10-14 (source verified)

- [x] Reproduce and fix attachment transfer races, stale/cancelled submissions, durable queue failures and SSE transport recovery.
- [x] Separate queue policy, submission ownership, SSE framing, multi-resource serialization, Hub collection/outbox and skill scanning into focused modules.
- [x] Keep background-chat metrics and delayed dictation in their original project/workspace; bind Hub outbox/package operations to their source connection.
- [x] Add dependency-boundary/cycle checks and strict Clippy to CI; update the vulnerable development dependency.
- [x] Full local automated suites, production frontend build, isolated Chromium queue/browser acceptance and final source review.
- Installed application and external services were not updated. Windows/Linux live acceptance and model inference are outside this audit's evidence.
- Evidence and remaining limits: [Audit report](docs/REFACTORING-20261014.md).

## M48 — Project access diagnosis and recovery (0.2.37, installed locally)

- [x] Correlated EPERM with TCC/signature and orphaned launch-context evidence; exact transaction limit documented.
- [x] Safe autostart working directory and explicit filesystem usage descriptions.
- [x] Scoped project error, truthful indicators, blocked sends, read-only recovery and queue disarming.
- [x] Regression tests and Mac build; stable Developer ID signing remains unavailable on this host.
- Evidence: [Project access recovery](docs/PROJECT-ACCESS-RECOVERY.md).

## M47 — Session isolation and recovery (0.2.36, installed locally)

- [x] Queue-owned durable attachment copies, edit/remove recovery, once-only dispatch and uncertain POST protection.
- [x] Real OpenCode/Pi invoking identity, separate browser contexts/profiles, selected-only panel and passive monitor, stale input refusal.
- [x] Session-scoped send/attachment/history errors and execution indicators based on current server evidence.
- [x] Isolated Chromium scope/storage/input acceptance; no model inference or owner prompt replay.
- [x] Final Mac installation/startup/signature/server verification; publication is not part of this local repair.

## Model discovery reliability (2026-10-09)

### M46 — Persistent configured models (done, 0.2.35)

- [x] Separate configured model visibility from live access/readiness; retain public display metadata and Pi-only catalog policy while offline.
- [x] Agent-owned catalogs, explicit refresh, access badges, readiness modal/retry and no substitute on failure.
- [x] Scope asynchronous selection to the original engine/workspace/chat; remove rows through their configuration.
- [x] 654 passing frontend tests, Mac UI/package acceptance and exact-source main/release publication.
- [x] Reviewed Windows 0.2.35 handoff: Git null-config fix, unprivileged junction fixtures, strict browser acceptance parser and Job Object regression. Imported Windows evidence remains separate from Mac checks; see [Windows report](docs/WINDOWS-RESULT-0.2.35-20261009.md).

## Verified project experience (2026-10-08)

Develop in small verified releases. Reuse OpenCode/Pi and common adapters; no second agent loop. Keep active owner work and GPU services untouched. Use DeepSeek only if a live model request is necessary while local models are occupied. History is evidence, not instructions; task acceptance is not permission to train or publish private data.

### M38 — Task result cards (done, 0.2.30)

- [x] Attach an explicit result card to a user request in either agent's chat: goal, acceptance criteria, reported checks, notes and owner verdict.
- [x] Keep owner acceptance separate from agent idle/completion markers; editing evidence invalidates a previous acceptance.
- [x] Durable scoped storage with conflict detection; failed writes preserve drafts and never show success.
- [x] Optional redacted Hub transfer via the existing outbox; Web history displays owner assessments separately from dataset approval.
- [x] Regression tests, real isolated UI/storage/API checks, Mac build and main publication. No quality/speed claim from metadata checks alone.

Evidence: 587frontend/21Hub/91Rust tests pass; isolated UI/storage/API, installed Mac0.2.30/Hub connection, main/release round-trip and NAS restore verified. No live model quality claim. See [task result documentation](docs/TASK-RESULTS.md).

### M39 — Reproducible evaluation tasks (done, 2026-10-08)

- [x] 12 versioned code/browser/recovery fixtures in isolated environments, each with independent outcome assertions.
- [x] Record agent/model/requested/effective effort, skill/tool revisions, elapsed/verified time, reported tokens and owner interventions; two paired repeats (AB/BA).
- [x] Lightweight engine-independent contract workflow in CI; live model trials explicitly opt-in with request/token/time/output limits and synthetic content only.

Evidence: all 48 trials completed on DeepSeek Flash; OpenCode 23/24 and Pi 24/24 independent successes, median elapsed 7.69/7.58s. Browser 12/12, including stale-state recovery. A failed code outcome remains in the report; this is a baseline, not a claim of general quality improvement. Final runner smoke/candidate provenance and exhausted-budget stop checked separately. [Report](docs/evaluations/2026-10-08/REPORT.md) · [Run/limits](docs/EVALUATIONS.md). Local GPUs, owner history/settings and app runtime unchanged; Windows/Linux live trials remain unrun.

### M40 — Curated project memory (done, 0.2.31)

- [x] Explicit portable project identity across devices; no basename-based merging, credential-bearing remotes or raw absolute paths in Hub.
- [x] Propose facts/runbooks from accepted tasks with source, revision, expiry and owner approval; invalidate stale entries.
- [x] Preserve existing AGENTS.md/checkpoints as authorities. Memory remains contextual data; no automatic skill rewriting or training.

Evidence: 612frontend/30Hub/92Rust pass; actual isolated UI/API/Web candidate approval and stale-source invalidation, installed Mac readiness and NAS unstarted restore verified. No inference or automatic prompt injection. See [project memory](docs/PROJECT-MEMORY.md).

### M41 — Shared retrieval for OpenCode/Pi (done, 0.2.32)

- [x] Common MCP discovery/retrieval of bounded relevant project facts with source links and budget limits.
- [x] Compare task success and full completion time against M39 before enabling automatic context preparation. Preserve manual choice/rollback.

Evidence: explicit project-granted native MCP through existing shared adapters; approved/current only, bounded whole entries, provenance links, fail-closed revocation. 36 fresh trials on three unchanged M39 tasks; 35 full successes, all36 code assertions pass. No stable speed benefit: automatic preparation remains off; search opt-in. Signed Mac SDK/Pi retrieval and OpenCode metadata connection checked separately. [Comparison](docs/evaluations/2026-10-08/retrieval/REPORT.md) · [Limits](docs/PROJECT-MEMORY.md).

### M42 — Engineering foundations (done, 0.2.33)

- [x] Add Mac/Windows/Linux CI build matrix and platform-specific live acceptance checklists.
- [x] Extract state-store responsibilities incrementally under regression checks; keep API normalization in adapters.
- [x] Reconcile outdated architecture/platform documentation and use current evidence rather than old release checkboxes.

Evidence: CI run37781057191 passed on macOS ARM64/Windows x64/Ubuntu 24.04 x64: 626 frontend and 34 Hub tests each, Rust 94/77/96 respectively, three native packages and source-bound SHA256 receipts. Mac 0.2.33 installed/GUI and public release round-trip verified. State facade reduced from 3510 to 3222 lines with selection/scope regressions; generated frontend unchanged by final whitespace cleanup. Windows/Linux current live GUI remains separate/unrun. See [verification](docs/VERIFICATION.md) and [platform checklist](docs/PLATFORM-ACCEPTANCE.md).

### M43 — Task timing and reliability diagnostics (done, 0.2.34)

- [x] One bounded, engine-neutral task breakdown in chat details, using existing normalized events and timestamps.
- [x] Measure Desktop queue/preparation and observed first response where attributable; distinguish unavailable/history-only data, overlapping phases, cancellation and owner acceptance.
- [x] Optional numeric-only Hub transfer under existing consent, safe export and regressions; no raw reasoning/screenshots/tool payloads.
- [x] Build, isolated real UI/API acceptance and Mac package/install; source/release publication recorded below.

Implementation evidence: focused21/21, Hub37/37, TS/Vite and real isolated Chromium details interaction/320–760px geometry pass. Mac0.2.34 installed/live diagnostics verified; Hub37 tests/integrity/history preserved and NAS archive checked. No inference speed claim. [Semantics](docs/TASK-DIAGNOSTICS.md).

### M44 — Representative project evaluations (done, measured baseline)

- [x] Versioned multi-file coding and browser/recovery tasks with held-out assertions, explicit scope and baseline failures.
- [x] Paired OpenCode/Pi trials on authorized DeepSeek, elapsed-to-verified-result, known usage, failures and intervention accounting.
- [x] Report every outcome; no production/local-GPU performance extrapolation.

Evidence: 12 offline baseline/reference discriminations and 16 eval regressions pass; 12 paired project trials (OpenCode2/6, Pi1/6) plus four qualified browser passes. Eight earlier browser budget-limited trials retained separately; all sources/candidates SHA-bound. [Report](docs/evaluations/2026-10-08/projects/REPORT.md). No general/local-model quality claim.

### M45 — Current project navigation (done, optional)

- [x] Explicit bounded read-only file/symbol/entrypoint/check map, through common tools for both agents.
- [x] Revision/freshness, secret/path/symlink/ignore bounds; no automatic prompt injection or second agent loop.
- [x] Validate usefulness against M44; no stable benefit, keep explicit opt-in.

Evidence:24 paired DeepSeek trials;OpenCodeoff2/6/tools2/6,Pi off3/6/tools0/6. Exact source/candidate receipts retained. Real native signedSDK/Pi/OpenCode scope/revocation and installedMac preview/toggle PASS. [Report](docs/evaluations/2026-10-08/navigation/REPORT.md), [bounds](docs/PROJECT-NAVIGATION.md).

Local Qwen Flash Next follow-up: Medium, protocol2/2, projects16/24 (OpenCode9/12,Pi7/12), browser4/4. No stable project-map improvement; keep opt-in. All eight full failures reproduced offline, one extra total-deadline cancellation retained separately. Engine/app/owner sessions unchanged. [Local qualification](docs/evaluations/2026-10-08/qwen/REPORT.md).

### M46 — Selected live acceptance (Mac completed; other platforms excluded)

- [x] Mac installed GUI for M43/M45 and both-agent isolated shared-tool scenarios.
- [x] Windows/Linux live work excluded at the owner's explicit request; no current GUI pass claimed. Existing automatic CI remains separate.
- [x] Preserve owner history/chat/model/Medium and external OpenCode; retain unrun mic/SSH/new packaged agent-inference scenarios explicitly in verification.

## M25 — Browser/SSH/process ownership review (0.2.16)

Windows in-app panel follow-up (2026-10-05): headless Chromium projection with
real DOM tools, tabs/history/manual input/cursor and first-prompt MCP readiness.
398 frontend / 56 Rust tests, official browser smoke, final NSIS install, native
panel manual interaction and one real Qwen Medium first-prompt task pass. Offline
admin handoff prepared; Desktop left open. See
`docs/WINDOWS-EMBEDDED-BROWSER-20261005.md` for evidence and projection limits.

Claude performed the source review directly through its CLI on Igor with only
file tools. The verified result was transferred and the remote copy immediately
removed; subsequent fixes and execution are Mac-only. See
`docs/CLAUDE-REFACTOR-20261005.md` and `docs/VERIFICATION.md`.

- [x] Mac: 375 frontend tests, TypeScript/Vite build and 70 Rust tests on reviewed/fixed source.
- [x] Mac: explicit stop/exit cancels installers; real headed daemon exits on owner-pipe loss; script refresh and dependency-lock mismatch regressions.
- [x] Moved app/Node-manager discovery covered by source regression tests; live Finder/nvm acceptance remains optional follow-up.
- [x] SSH bounded pipe drain and actual OpenSSH configuration resolution tested on Mac; live remote-server restart remains an integration follow-up.
- [x] Real MCP transport proves delivered mutations are never replayed and pre-delivery token rotation recovers once.
- [x] Final Mac package, installed Pi 0.85.1 bridge (32 tools), script-only upgrade, stop/re-enable and native settings/top-bar acceptance; external OpenCode and complete global configuration retained.
- [x] Windows: unchanged main built/installed; 375 frontend, 55 Rust, actual headed browser smoke/owner-pipe cleanup; supplied report/logs and installer hash verified on Mac.
- [ ] Windows: packaged toolbar/stop/re-enable, hidden-console live checks and Pi Job Object tree cleanup.
- [x] Windows browser follow-up: native MSIX executable-path resolution, disconnected MCP recovery, 377 frontend/55 Rust tests and real headed browser smoke including virtual AppData aliases (2026-10-05). Pi tree cleanup is not claimed by this browser fix.
- [ ] Linux: browser smoke with system Chromium libraries.

## M24 — Windows port integration (0.2.14 source, 2026-10-04)

- [x] Import the owner's Windows port without replacing the existing main history or dropping the Linux prerequisite script's executable mode.
- [x] Windows home/app-data paths, native CLI discovery, cross-process startup lock and current-user NSIS overlay.
- [x] Keep unsupported Agent Control/Factory explicit and nonfatal on Windows.
- [x] Review drive/UNC/POSIX path handling; preserve POSIX case sensitivity and filesystem roots, with regression tests.
- [x] Reject an invalid explicit Windows Node path instead of silently selecting another interpreter.
- [x] Fix prerequisite/verification scripts for PowerShell 5.1; installation and health failures must not count as acceptance.
- [x] Frontend 313 passed / 6 opt-in live skipped; Mac Rust 39 passed, Cargo check and TypeScript/Vite build passed.
- [x] Integrated main rebuilt unchanged on Windows for 0.2.16; source SHA and installer/report/logs verified. Remaining packaged scenarios are listed above.
- [ ] Windows packaged Pi UI, approval/LSP, file drop/clipboard and dictation acceptance.
- [ ] Windows Job Object process-tree cleanup and private Agent Control transport.

The previously published macOS v0.2.14 package is unchanged. This source integration
does not publish a Windows installer or assert a new Linux binary.

## M23 — Pi startup, local runtime paths and final settings-card spacing (0.2.14)

- [x] Launch npm's `env node` Pi entry point through a verified absolute Node interpreter, including when Finder omits Homebrew from PATH.
- [x] Keep that interpreter on Pi's child PATH for Node-based extensions and language servers; report missing Node explicitly.
- [x] Add bottom padding and a divider to direct Pi capability rows so the last line stays inside its card.
- [x] Let the user set optional absolute paths to Pi CLI, its Node.js interpreter and the local OpenCode CLI; blank values preserve auto-discovery.
- [x] Apply saved paths to Pi detection/RPC and local OpenCode autostart without restarting a healthy server or reconnecting for a path-only edit.
- [x] Verify the Pi CLI/Node paths and the capability-card spacing in an isolated native preview.
- [ ] Investigate the isolated preview's Pi capability-metadata timeout; direct CLI RPC commands respond, but the UI probe did not complete.
- [x] Publish the tested macOS package as v0.2.14; GitHub asset digest matches the verified local DMG.
- [ ] Install only after the owner's active TinyCAD session is no longer at risk.

## M22 — Token usage by model (0.2.13)

- [x] Normalize settings spacing: Pi install actions stay inside cards; skill-source labels and inputs stack without collision; narrow-width settings preserve readable gaps.
- [x] On-demand read-only accounting from assistant-message usage, including child and archived OpenCode sessions and Desktop-owned Pi chats.
- [x] Group by the actual model on each reply; separate input, cache read/write and output without counting reasoning twice.
- [x] Settings screen with 7-day, 30-day and all-time periods, per-model totals and daily activity; partial-history errors are visible.
- [x] Isolated native macOS package opened the settings screen and scanned real OpenCode history; model split, dates and partial-data warning were visible.
- [ ] Install/launch 0.2.13 when the owner's active TinyCAD run can be left undisturbed.

Scope: currently connected OpenCode server and locally registered Pi chats. Removed
sessions and other disconnected servers cannot be reconstructed. This is measured
token use, not provider quota or billing.

## M20 — Agent Factory for durable local-model work (0.2.11 follow-up)

- [x] Explicit completion contract: exact standalone marker plus bounded continuations.
- [x] Durable server/session-scoped supervision state survives Desktop restart.
- [x] Optional safe project-relative checkpoint path injected into the visible task contract.
- [x] Separate completed, incomplete, needs-input, failed, timeout and recovery-exhausted outcomes.
- [x] Bounded malformed tool-call repair remains independent from semantic continuation budget.
- [x] Explicit stop and rejected recovery remove the contract; no later resurrection.
- [x] Stored records are schema-validated, age/count bounded and contain no prompts/tool output.
- [x] Agent API can inventory and explicitly forget durable contracts without deleting chats.
- [x] Native live continuation, full Desktop restart/resume and explicit-stop acceptance.

Acceptance: start a test-owned managed task, observe at least one bounded continuation,
restart Desktop between waits, complete only on the exact marker, and prove explicit stop
cannot resume it. Preserve the external OpenCode server and all unrelated sessions.

## M19 — Agent control plane and MCP (0.2.11)

- Private per-user Unix socket owned by the running Desktop process; no LAN listener.
- Bundled `--agent-mcp` stdio server for semantic project/session/model/run control.
- Commands execute through the visible frontend store and are serialized with bounded payloads/timeouts.
- Explicit permission/question handling, without automatic approval or hidden retries.
- Settings page installs the local MCP into OpenCode while preserving JSONC and unrelated entries.
- Native acceptance covers MCP handshake, visible state synchronization, one real bounded agent task and transcript retrieval.

The goal is a full daily-use desktop coding client with the familiar workspace structure requested by the user. This checklist describes planned work. A checkbox is checked only with recorded evidence. Exact equivalence with proprietary/cloud-only Codex features is not assumed; each capability must have an actual implementation or be explicitly marked unsupported.

## M0 — Bootstrap (provided)

- [x] Official Tauri 2 + React + TypeScript starter.
- [x] Product name Enki; independent engine boundary documented.
- [x] Product specification, architecture, agent instructions and API snapshot.
- [x] Dependency installation, starter frontend build and Rust check verified; see docs/VERIFICATION.md.
- [x] Initial Git checkpoint prepared and committed before worker dispatch.

## M21 — Local OpenCode server autostart (0.2.12)

- [x] On local connection failure, native Desktop checks the loopback port and starts the separately installed CLI only when absent.
- [x] Cross-process startup lock, bounded health wait, executable discovery under a restricted app PATH, and a private startup log.
- [x] Remote SSH workspaces, occupied ports, HTTP/auth errors and browser preview never trigger a local server launch.
- [x] App exit leaves the server running; no existing server is restarted or killed.
- [x] When local OpenCode or Pi CLI is missing, offer its official installation instructions; never install either engine silently.
- [ ] Packaged macOS acceptance: missing test-owned local endpoint starts and connects; already running OpenCode is reused; existing user sessions are preserved.

## M1 — Native shell and connection (first vertical slice)

- [x] Replace template with designed application shell, real sidebar, main view, top bar and persistent composer area. (VERIFICATION M1–M5)
- [x] Native window title and controls, reasonable minimum size, resizable panels, keyboard focus, light/dark/system theme. (styles.css splitters + `applyTheme`; shortcuts Cmd+N/Cmd+Shift+R/Ctrl+`)
- [x] Connection manager: existing opencode health/version, actionable disconnected/error UI, configurable local port. (Engine executable stays externally managed — picker intentionally omitted.)
- [x] Typed HTTP adapter; documented WebView fetch over CORS-reflecting loopback (no proxy needed); timeouts, cancellation, no token logging. `test/client.test.ts`.
- [x] Read providers/connected models/agents dynamically; no hard-coded catalog. (Live native screenshot shows real options.)
- [x] Display server version; major-version gate yields an actionable compatibility message instead of a blank screen.
- [x] Unit tests for connection states, invalid endpoints, API errors (client + store-regressions suites).

Acceptance: `tauri dev` launches a useful native window, detects existing OpenCode without spawning a duplicate, and visibly shows real connection/model information. Disconnecting it produces a recoverable state, not a blank page. App exit leaves the existing server running.

## M2 — Projects and conversations

- [x] Project list from OpenCode plus native folder picker (dialog plugin); selection stored in app prefs only.
- [x] Scoped task list, search via command palette, rename, loading/empty/error states. Rechecked in the independent acceptance pass.
- [x] Create, select and resume real sessions; history with older-page pagination; per-session drafts. (Proven live incl. reload-restore.)
- [x] Directory+generation isolation on requests and events; stale results dropped. (Regression tests R1–R5.)
- [x] Archive/restore via engine API; delete behind an explicit confirmation dialog. (Test R4.)
- [x] Status from `/session/status` truth incl. post-reconnect resync. (Test R5.)
- [x] Tests for new session, project switch, stale-response and out-of-order event handling at the store/reducer level. (Archived-filter live check not separately recorded.)

Acceptance: two temporary projects have independent session lists and drafts; reopening the app resumes the chosen session. Existing user histories are unchanged.

## M3 — Complete chat execution (minimum useful release)

- [x] Prompt composer: Enter/Shift+Enter, duplicate-send guard, live model/agent/effort selects.
- [x] Submit through the real async prompt endpoint. (No fake attachment support.)
- [x] SSE with event-ID dedupe, provisional deltas, bounded reconnect and authoritative resync. (Reducer tests + live streamed run.)
- [x] Sanitized markdown (no raw HTML, safe hrefs), copy buttons, collapsible reasoning, tool cards with state/errors.
- [x] Stop via `/session/:id/abort`; submitted prompts are never auto-retried. (Reducer/store tests.)
- [x] Permission card with once/always/reject preserving request IDs. (Unit-tested; this server policy never asked during the live run, so not exercised end-to-end.)
- [x] Question card: options, multi/custom answers, reject; pending requests re-pulled after reconnect. (Unit-tested; not exercised live.)
- [x] Distinct status states from server truth; no dead-model guessing.
- [x] Output-length/context-overflow are surfaced; command palette exposes the engine compaction action. No automatic tool duplication or continuation.
- [x] Reducer tests cover parts/deltas, duplicate replay, abort/error/length, permission lifecycle and switch-while-streaming isolation.

Acceptance: use a dedicated fixture, ask for one small code fix + test, observe tool calls live, answer a permission/question if requested, and verify the resulting diff/tests. Abort a separate safe operation. Restart the UI and see the preserved result. Record actual local Qwen model/variant used.

## M4 — Code, changes and review

- [ ] PARTIAL: files + session changes tab proven live (badge A, real diff lines, patch-part merge for the 1.18.18 empty-diff quirk, binary fallback); renamed-state mapping unverified.
- [ ] NOT IMPLEMENTED beyond a basic lazy file-content preview; no highlighting/find/editor handoff.
- [x] Changed-file list with expandable per-file unified diff, bounded preview. (Live: `+SMOKE42` in the running app.)
- [x] Separate session and working-tree changes; unknown session baselines are labelled honestly, never represented as new files.
- [ ] PARTIAL: read-only branch chip from `/vcs`; dirty badge and any Git actions not implemented.
- [ ] PARTIAL: `test/diff.test.ts` covers binary detection and unified diff shape; path-traversal/spaces/pre-existing tests still missing.

Acceptance: fixture changes in multiple files are accurately inspectable in the app and agree with Git. Reading a diff cannot modify or discard files.

## M5 — Terminal and desktop ergonomics

- [x] Real OpenCode PTY terminal: create/attach/reuse, resize push, explicit close. Live proof `R6_ECHO_42` in xterm (`term-r6.png`).
- [x] Project-scoped PTY (directory query on every call); xterm passthrough; honest transport errors.
- [ ] PARTIAL: Ctrl+` toggle/resize and single reused PTY per project (no reconnect duplicates); multiple terminal tabs not implemented.
- [x] Command palette, project/task search, new task, terminal and review shortcuts; native-safe model/effort/agent menus.
- [ ] Desktop completion notifications are not implemented.
- [ ] PARTIAL: echo/ANSI and disposal verified live in /tmp/oc-smoke; no unit tests for terminal resize yet.

Acceptance: user can execute and interrupt a local test command, then continue chat while inspecting output and diff. Closing the app does not kill an externally managed server or leave duplicate PTYs created by this app.

## M6 — Reliability, independent updates and macOS package

- [x] Disconnected gate shows actionable errors and reconnect; installed local OpenCode is started automatically when absent, with no executable picker or engine auto-update.
- [x] Existing OpenCode processes are never killed or restarted; a Desktop-started local server remains independent after app exit. No config rewrites.
- [ ] PARTIAL: shell (0.1.0) and engine (1.18.18) versions are displayed separately and reconnect is bounded/handled; no update flow.
- [x] Reducer/client tests use real 1.18.18 event/patch/question shapes incl. missing/optional fields. No engine upgrade was run.
- [x] Loopback-only WebView CSP, narrow core/opener/dialog capabilities and bounded native ASR command, safe-href markdown, no secrets logged. (Diagnostic export UI still absent.)
- [ ] PARTIAL: prefs live in a separate local store and OpenCode data is untouched; a prefs schema-migration path is not yet written.
- [x] `cargo tauri build` clean: bundle + dmg 0.1.0, id `dev.local.opencodedesktop`, README install steps. Unsigned/notarized — stated plainly.
- [x] Installed final bundle to /Applications; ~/Applications and Desktop aliases resolve to it. Native chat/PTY/session and draft restoration verified; `Qwen OpenCode.app` preserved.
- [ ] NOT VERIFIED: launch was via LaunchServices `open` with the server up; restricted-PATH/offline-draft-restore scenario not run.

Acceptance: packaged app opens outside development tooling, connects to existing OpenCode, resumes a test session, and leaves the CLI/service independently usable. Record bundle path, tested versions, test counts and remaining limitations. Local unsigned build must not be described as notarized.

## M7 — Extended parity backlog, after a verified core

These should have capability/evidence-based designs, not placeholder buttons:

- [ ] Isolated worktrees using actual supported OpenCode endpoints; display creation/cleanup ownership and protect dirty worktrees.
- [ ] Background/multiple tasks and activity inbox, respecting local single-GPU execution limits. Parallel sessions do not imply parallel model capacity.
- [ ] PARTIAL (0.2.1 source): live skill/agent/tool/MCP inventory; local global/project JSONC editor for tool permissions, skill URLs, npm plugins, remote MCP and default agent with key-level review, backup and conflict guard. Native save UI still needs final validation; full line diff and a plugin marketplace are not implemented.
- [ ] Git workflow refinements, branch review, per-line comments and GitHub integration through existing authenticated CLI with explicit publication actions.
- [ ] File/image drag and drop, attachment previews, find in history, export with privacy controls, session fork/branching.
- [ ] Scheduling/automation only after defining persistence, permission boundaries, duplicate prevention and cancellation. Do not silently auto-start work.
- [x] Remote OpenCode through native SSH tunnels, strict host keys, in-memory API password, per-host preferences. See docs/WORKSPACES.md. Direct arbitrary HTTPS endpoints and Keychain persistence remain future work.
- [ ] Browser preview as isolated content without Tauri privileges; optional worktree-aware dev-server handling.
- [x] Linux packaging: `.deb` built and smoke-tested on Ubuntu 24.04 (0.2.9), with a platform-neutral
      Tauri config plus reviewed per-OS overlays. See `docs/PLATFORMS.md`.
- [x] Pi as a second local engine in 0.2.9: separate settings and model verification,
      per-project/per-chat choice, projectless chats, guarded tools, LSP, history
      alongside OpenCode and explicit two-way handoff. Native Mac and Linux
      acceptance is recorded in `docs/VERIFICATION.md`.
- [ ] Windows packaging: extension points named in `docs/PLATFORMS.md`, nothing built or tested.
- [ ] Cloud proprietary functionality only through a real supported service. Document unsupported features plainly.

## Completion evidence

Maintain `docs/VERIFICATION.md` with date, commit, installed OpenCode version, commands/results, relevant screenshots or manual steps, and limitations. Update `.pi/TASK.md` at meaningful checkpoints and before compaction. Mark the deliverable done only after M1–M6 acceptance is satisfied; record M7 separately as a backlog rather than claiming complete Codex parity.

## Дополнения при независимой приёмке (2026-09-22)

- [x] Круговой индикатор реального контекста, порог автосжатия и ручное сжатие.
- [x] Session-scoped режимы доступа OpenCode; существующие правила не теряются молча.
- [x] Очередь, редактирование/удаление, уточнение текущей задачи на безопасной границе шага.
- [x] Диктовка, реальная звуковая визуализация, настройки ASR, native multipart adapter.
- [x] GigaAM v3 CPU on CT 201 configured as local default; health and OpenAI multipart endpoint tested, including a short Russian synthetic speech sample. Native microphone UI acceptance pending 0.2.1 installation.

## M8 — Optional projects and execution hosts (0.2.0)

- [x] New Chat opens a project-optional start screen; project search and explicit projectless choice.
- [x] Separate workspace directory per projectless chat; real tools/PTY/history/drafts/access/context work without Git.
- [x] Local versus SSH host selection; server-scoped project picker, native local folder picker, explicit remote path entry.
- [x] SSH tunnel lifecycle and authentication; generation guards and server identity independent of ephemeral port.
- [x] Regression coverage for new-chat, workspace failure, duplicate send, stale SSH handshake and host isolation.
- [x] Final packaged-native local/SSH chat, tools, PTY, archive/restore, relaunch and installation recorded in VERIFICATION.

## M9 — Completion attention (0.2.1, pending native delivery)

- [x] Source: spinner for busy/retry sessions and projects; yellow dot only for a completed result not yet viewed; separate pending-request marker.
- [x] Source: global event monitoring across projectless chats and projects, unread state scoped by server and persisted; focus/scroll/open transitions clear unread, and a fixed system chime fires once per unattended completion.
- [x] Source: reconnect reconciles previously busy sessions, duplicate events do not repeat sounds, deleted/archived sessions clear attention; focused regression tests cover these transitions.
- [x] Native finding: project-row restoration now loads the session history if needed and clears unread when the completed answer is visible; regression test added.
- [x] V100 Qwen3.8-27B added alongside Flash Next with its own context/output profile and coding agent; Flash Next remains default. The initial HOLD is superseded by the 2026-09-23 corrected NInfer deployment and client acceptance; see LOCAL-MODELS and VERIFICATION.
- [x] NInfer task finished and its raw measurements were reviewed; native 0.2.1 candidate passed settings, V100 chat, attention and re-open checks. DMG verified and 0.2.1 installed; GitHub publication is recorded in VERIFICATION.

## M10 — Project conversation tree (0.2.2)

- [x] Independently expandable project groups with their own session lists; expansion does not navigate away from a conversation or reset its draft.
- [x] Expansion preferences scoped to the selected server and preserved on restart. New chat button per project.
- [x] Recent root sessions across projects and projectless workspaces, paginated global archive with restore.
- [x] Background SSE updates, stale-response protection, retry/loading states, exact directory filtering and session list pagination.
- [x] Native acceptance and installation of 0.2.2 (see VERIFICATION).

## M11 — Project removal and explicit session handoff (0.2.3)

- [x] Remove/restore project entries without deleting folders or sessions; server-scoped persistence and recent filtering.
- [x] Select recipient across projects/projectless workspaces and configured local/SSH servers, searchable/paginated.
- [x] Prepare an editable task packet from full available source history in an isolated, tool-disabled fork; archive on completion and cancel only that fork.
- [x] Recipient profile/directory preserved, append-only draft mode, busy/permission guards, single send and uncertain-acknowledgement handling.
- [x] Native acceptance and release installation (see VERIFICATION).
- [ ] Model-invoked automatic discovery/delegation tool; this release implements the user-authorized UI workflow.

## M12 — Background computer control (0.2.3)

- [x] Separately installed signed Cua Driver with native settings/status/onboarding controls.
- [x] MCP proxy with window-scoped tools, background delivery, read-only permission checks and shared disable gate; emergency revoke.
- [x] JSONC-preserving MCP configuration and OpenCode skill, local-host guard, unchanged model/provider/access settings.
- [x] Native permission onboarding, live tool/vision/overlay acceptance and final installation.
- [ ] Foreground/desktop control, remote desktop and explicit browser-profile integration; excluded from this release.


## M13 — Reading and message tools (0.2.4)

- [x] Explicit follow/reading modes, wheel/touch/keyboard intent, jump-to-latest and resize/prepend anchoring.
- [x] Per-session in-memory reading position; incremental history, day separators and exact timestamp tooltips.
- [x] Safe React Markdown/GFM, syntax highlighting, full-response/code copying and editable code copies.
- [x] User-message edit into an engine fork before the selected message; original retained, access and profile copied, explicit draft/send step.
- [x] Root-session attention reconciliation; hidden subagents/archive/deletion excluded, unread roots exposed beyond sidebar truncation.
- [x] Native installation and release acceptance (see VERIFICATION).

## M14 — Cohesive assistant turns (0.2.5)

- [x] Adjacent engine steps grouped by request, with user/parent/compaction boundaries and stable message/part anchors.
- [x] Compact progress rail with expandable reasoning/tools; final answer and single copy/time/details footer.
- [x] Completed history starts folded; live progress stays open and disclosure state survives conversation switching.
- [x] Tool errors remain discoverable; aborted/limited output is not labelled as a successful final answer; invisible engine markers no longer create gaps.
- [x] Native installation and final package validation (see VERIFICATION).

## M15 — Full-page settings and appearance (0.2.6)

- [x] Settings navigation/search, grouped rows, back/escape and preserved conversation/draft; Cmd+, shortcut.
- [x] Theme, accessible palette/custom accent, independent UI/chat/code sizes, chat width/line spacing, live preview and reset.
- [x] Validated app-global persistence and old-preferences migration, unaffected by SSH workspace snapshots.
- [x] Separate connection/ASR saves, staged JSONC edits retained across sections with exit protection; original backup/conflict logic retained.
- [x] Unit and browser acceptance, including maximum fonts at the minimum native window size; no model inference.
- [x] Final native installation and package verification (see VERIFICATION).

## M16 — Native microphone permission repair (0.2.7)

- [x] Signed macOS audio-input entitlement, retaining Hardened Runtime and normal system consent.
- [x] Russian capture diagnostics distinguish permission, missing and unavailable devices; cancellation stops a late-granted microphone stream without transcription.
- [x] Regression tests for refusal/cancellation and release-artifact signature/entitlement/usage-description check.
- [x] Installed native capture/cancel acceptance, strict package verification and preserved configuration (see VERIFICATION).

## M17 — Attachments and CPU helper (0.2.8)

- [x] File picker, drag/drop and clipboard files; large pasted text as a file; reload-safe attachment drafts scoped to host/directory/session.
- [x] Route by live model input capabilities; direct images and supported media, PDF/video/audio conversion on isolated CT205 with GigaAM transcription for sound.
- [x] Loopback SSH tunnel with dynamic CT address, restricted source IP, helper endpoint/status in Desktop settings; OpenCode MCP connections remain separately configurable.
- [x] Explicit size, context and queue limits; failures retain draft and never silently discard unsupported content.
- [x] Packaged app, native helper/status and picker draft, real browser-to-OpenCode PDF roundtrip, source checks and installation (see VERIFICATION). Finder drop is handled by Tauri's native event and narrowly scoped file read after an owner-reported regression. The native acceptance outcome is recorded in VERIFICATION.

## M18 — Voice composer and attachment layout (0.2.10)

- [x] Recording uses a full-width, anchored composer row with visible cancel, waveform, timer and stop controls; model, agent and access controls cannot crowd it offscreen.
- [x] Attachment chips scroll within a bounded area, and long model/agent names shrink in the idle toolbar. The text area also respects viewport height.
- [x] Microphone capture no longer waits for Web Audio visualization to resume. Cancellation stops late grants and does not transcribe.
- [x] Native Mac acceptance with three long-name images, active recording, cancel and clean draft; installed app smoke. Linux `.deb` built and window-smoked from the same source. See VERIFICATION.

## M19 — Managed agent browser (0.2.15)

- [x] Official Playwright MCP, headed persistent Chromium, private lifecycle proxy, shared serialized tools with per-project file roots.
- [x] Local first-start/after-install setup for installed OpenCode/Pi, absent-engine skip, JSONC preservation and normal engine permissions.
- [x] Browser window button and settings, optional Node path, bounded install/start/error recovery.
- [x] Windows archive native-driver import with window guards; honest Linux unsupported native-control UI.
- [x] Final packaged Mac acceptance and installation (see VERIFICATION).
- [ ] Live Windows/Linux browser acceptance. Shared source implemented; no claim of live verification.

## M26 — Embedded browser and chat context (0.2.17)

- [x] Reviewed Windows ca99367/7452a0e archive, retained later main documentation.
- [x] Shared headless Chromium projection, manual input/cursor/tabs/history, stale input guards and first-prompt attachment; no privileged remote HTML or new network exposure.
- [x] Chat context: real sources/results/children, history navigation and existing composer picker/draft actions.
- [x] Durable recurring prompts scoped to server/directory/chat/engine/model, normal permission checks, no catch-up bursts or ambiguous retries.
- [x] 451 frontend / 71 Mac Rust checks and official browser transport/view smoke.
- [x] Reviewed direct source-only Opus 5.5 changes; fixed additional storage/delivery, child routing, stream cache and stale endpoint cases on Mac. All 451 frontend / 71 Rust checks pass; see `docs/CLAUDE-CONTEXT-REVIEW-20261005.md`.
- [x] Final Mac package installed: exact DOM input/key/click, real Pi loader/32 tools, context placement/history navigation, source chooser acceptance/cancel and paused schedule persistence passed. Original engine, configuration and draft preserved. See VERIFICATION.
- [ ] Live Windows/Linux 0.2.17 acceptance; archived Windows 0.2.16 results remain separate evidence.

## M27 — Windows shared browser transport (0.2.18)

- [x] Browser-only runtime outside per-process MSIX AppData redirection; versioned MCP executable outside shadowed install paths.
- [x] Copy legacy browser profile/cache without deleting originals or overwriting an existing shared profile.
- [x] 451 frontend / 59 Windows Rust checks, final NSIS build and debug/release cross-AppData real CLI regression (32 tools, one disposable browser).
- [ ] Manual installation and installed native 0.2.18 acceptance; Mac/Linux new source acceptance remains pending.

## M27 — Shared Windows browser MCP runtime (0.2.18)

- [x] Imported verified Windows history 5132356/8ae3e93; all archive checksums and source content matched.
- [x] Shared USERPROFILE browser runtime and versioned executable bridge outside MSIX AppData redirection, with cancellable profile migration preserving originals.
- [x] 451 frontend and 78 Mac Rust tests; TypeScript/Vite, Cargo fmt/all-targets check and native CLI build passed.
- [x] Disposable Mac native CLI: 32 shared tools; headless browser and two proxy regressions passed without inference or user configuration changes.
- [x] Windows NSIS preserved as a release asset with checksum and original build provenance.
- [ ] Installed Windows 0.2.18 normal/MSIX acceptance and real-profile migration. Mac 0.2.18 installation and Linux runtime acceptance are not claimed.


## Enki 0.2.19 — Mac release verified

- [x] Neutral product name and equal agent overview/badges; stable identity and data paths.
- [x] Pi native model/effort confirmation, unopened-session compaction, prepared text attachments and durable message branching.
- [x] Shared workspace terminal/Git for Pi, without inventing Pi PTY/permission-queue capabilities.
- [x] Generic model-service bindings, catalog agent policy and real switch progress, ordinary/queued/scheduled/compact readiness gates.
- [x] 2026-10-15: Gemma 4 31B added alongside both Qwen V100 profiles in VM5100; exclusive NInfer/llama.cpp switching, preserved Pi policy, reused verified weights, live OpenCode/Pi and picker acceptance. See LOCAL-MODELS.
- [x] Native Mac UI/package acceptance, real V100 model qualification and switch deployment; final permissions and Pi-only picker checks recorded in docs/VERIFICATION.md.
- [x] Reviewed runtime source published and installed as Mac 0.2.19; final release archive verified.

See [model services and capability matrix](docs/MODEL-SERVICES.md). Windows/Linux new release acceptance remains pending.

## Enki 0.2.20 — responsive composer

- [x] Short model labels with full-name details; routing unchanged.
- [x] Container-based wrapping and separate send/voice actions.
- [x] In-flow dictation row; compact honest model-switch state.
- [x] 476 frontend tests and eight real browser geometry cases.
- [x] Signed Mac bundle and installed UI acceptance; source/release publication recorded in verification.
- [ ] Windows/Linux live acceptance.


## M30 — Browser modes and responsive projection (0.2.21)

- [x] Compact tabs, centered address pill, mode selector and expand/collapse; narrow container layout.
- [x] Fast semantic-first and enforced human mouse/keyboard mode, shared by OpenCode/Pi.
- [x] Bounded keyboard input tool, normal agent permissions and workspace upload policy preserved.
- [x] Debounced actual Chromium reflow; pending old panel input discarded and disabled until matching frame.
- [x] Per-client screenshot/page/viewport observation guard; stale XY input rejected before action with fresh image/dimensions, no click replay.
- [x] Decoded-image manual coordinates, shared-user input invalidation, bounded read-only frame refresh after capture races.
- [x] Isolated real Mac Chromium responsive-target, modes, password/upload/profile/transport acceptance.
- [x] Final Mac package/signature/microphone/DMG checks; installed mode/viewport/panel and actual MCP CLI acceptance. Publication recorded in VERIFICATION.
- [ ] Live Windows/Linux acceptance; shared source only.

## M31 — General browser performance (0.2.22)

- [x] Compact observations and atomic action/wait/observe over official MCP.
- [x] Six-step prevalidated sequences, interruption, partial results and no replay.
- [x] Shared queue and coordinate policy retained; numeric-only diagnostics.
- [x] Explicit per-chat supported effort / separate browser chat; Pi effort selector.
- [x] Idle capture throttling; no skills, owner-session search or model changes.
- [x] Final Mac package/install acceptance; native Low/new task/browser/diagnostics and installed CLI verified.
- [x] Reviewed main pushed; v0.2.22 matched Mac DMG published and downloaded SHA256/GitHub digest/integrity verified.
- [ ] Live Windows/Linux acceptance and task-based speed/quality A/B.

## M32 — Shared skills and tools (0.2.23)

- [x] Versioned global/project registry, portable skill sources and unified catalog.
- [x] Shared MCP tools with official SDK, Pi adapter and scoped OpenCode attachment.
- [x] Actual connection/session availability, dependencies and reload states.
- [x] Regression/real isolated MCP/Pi acceptance; Mac build/install and publication.
- [ ] Live Windows/Linux acceptance.

## M33 — Enki identity (0.2.24)

- [x] Public product/repository/UI/docs use Enki; stable data, vault and MCP identities preserved.
- [x] Windows verifier recognizes current and both legacy product names.
- [x] Regression/build, verified Mac replacement and publication.
- [ ] Live Windows/Linux rename upgrade acceptance.

## M34 — Passive browser observation window (0.2.25)

- [x] Fixed separate live preview; no browser input or viewport resize.
- [x] Dock/restore/hide and lifecycle/scope guards; one browser remains running.
- [x] Regression/security checks and real Mac window/Chromium acceptance.
- [x] Verified Mac replacement and publication; Windows/Linux live acceptance pending.

## M35 — Balanced agent settings and Enki icon (0.2.26)

- [x] Common settings separated; equal OpenCode/Pi entries with owned navigation.
- [x] Pi drafts retained and covered by the settings exit guard.
- [x] Original generated icon with matching UI/macOS/Windows/Linux resources.
- [x] Tests, real Mac settings acceptance, installed build and main publication; Windows/Linux live acceptance pending.

## M36 — Private LAN knowledge and telemetry hub (0.2.27)

- [x] Small isolated Proxmox LXC, authenticated HTTPS API, catalog/versioning and Web UI.
- [x] Cross-device Enki pull through existing shared skills/tools adapters.
- [x] Redacted texts/steps/errors/usage, durable retry/dedup and per-device/global metrics.
- [x] Private issue candidates, reviewed dataset export and bounded NAS backups.
- [x] Regression/security/real API/UI checks, Mac package/install and publication.

## M37 — History-guided reliability (0.2.28)

- [x] Analyze all available Hub records privately; distinguish controlled refusals/cancellation from defect candidates and missing usage from measured tokens.
- [x] Complete keyset pagination, latest-first message view and preserved review drafts.
- [x] Read-only error diagnostics, scoped session links and explicit coverage limits.
- [x] Stable repeated secret redaction and stale private-dialog/logout guards.
- [x] Revise three existing portable skills from observed edit/target/verification failures; publish catalog revisions without bypassing busy guards.
- [x] Frontend/service/native regression checks, isolated Web interaction and real TLS API pagination.
- [x] Mac0.2.28 build/signature/install and NAS full archive; isolated restore checked.
- [x] Updated Mac vault/HTTPS access and idle-applied skill revisions; actual Pi/OpenCode loaders checked without inference.
- [x] Main/release publication and downloaded Mac asset verification; live Windows/Linux acceptance remains separate.

## Shared skill authoring (0.2.38)

- [x] Common bundled creation recipe, shared adapters and persistent disable choice.
- [x] Selected-chat draft action: analysis, reuse/migration, portable package and verification; no automatic send or old-job replay.
- [x] Reviewed document-download skill with partial/edition/access evidence and portable helper failure checks.
- [ ] Qualify usefulness and automatic skill selection on future owner tasks; no unmeasured performance claim.

## Compact prompt queue (installed in 0.2.39)

- [x] Single-line summaries, bounded queue scrolling and attachment counts.
- [x] Composer-based Apply/Cancel with original position/model/attachment preservation and paused dispatch while editing.
- [x] Failure, cancellation and idle-during-edit tests; isolated narrow/large-text browser layouts.
- [x] Included in the owner-authorised 0.2.39 Mac installation.

## Detached browser group (installed in 0.2.39)

- [x] Selected-chat page cards, draggable ordering, layered previews and native group header.
- [x] Passive page selection without changing agent tab/input/viewport; stale capture and scope isolation.
- [x] Component drag/layout, isolated real Chromium and native checks on Mac.
- [x] Included in 0.2.39 Mac installation; Windows/Linux and OS-window drag acceptance remain separate.

## Queue recovery and shared skill improvement (0.2.39)

- [x] Explicit recovery acknowledges prior terminal error, preserves queue order/files, and allows deliberate rebinding of ready entries to the selected model.
- [x] Balance failure explains pause; new errors pause again and ambiguous POSTs never replay automatically. Pending dispatch updates authoritative local activity to busy.
- [x] Shared authoring recipe routes editing requests, resolves available source/revision through portable read-only catalogue, preserves concurrent edits and managed copies, and requires isolated verification.
- [x] 688 frontend / 96 native tests; catalogue fixtures and narrow actual Composer recovery/layout checks pass.
- [x] Mac 0.2.39 signature/DMG CRC/install binary equality, native connected/open status, GUI version and installed shared recipe bytes verified. No owner prompt or automatic old-job replay.

## Compact detached browser cards (0.2.40)

- [x] Fit passive window to the observed page ratio (preview capped at 420×300 logical pixels); no Chromium viewport/input changes.
- [x] Transparent native corners, one rounded outline, compact title/controls/status and full preview area without nested frame or empty stage.
- [x] Keep selected-session isolation, passive page selection and drag ordering; isolated actual layout checks for landscape, square and portrait pages.
- [x] Mac 0.2.40 package signature/DMG CRC/binary equality and GUI version verified; installed after explicit owner permission to interrupt browser. Native control and external server healthy. Owner preview after restart and Windows/Linux live acceptance remain separate.

## Resizable browser panel (0.2.41)

- [x] Pointer-captured left border and keyboard width controls; 280px minimum, preserve room for chat.
- [x] Save chosen width through existing layout preferences; cancelled drag retains the prior choice, overlay/fullscreen behave independently.
- [x] Defer page resize until drag release, clear stale input, ignore disconnected observer callbacks.
- [x] Component regressions and actual isolated Chromium pointer drag, durable settings/reload, keyboard and narrow viewport checks.
- [x] Final Mac 0.2.41 app signature/DMG CRC/install binary equality and GUI version verified; native connection healthy. Owner live splitter after restart and Windows/Linux native checks remain separate.

## Session-guided browser reliability (0.2.42)

- [x] Privately review the selected session history; classify parameter refusals, timeouts, state guards and agent/file-root issues without publishing private transcripts.
- [x] Bounded short observations, typed value-free argument recovery, partial-action guidance and retained underlying failure text for OpenCode/Pi.
- [x] Independent per-session queues, cancellable bounded preparation, controlled 45s deadline and retained mutation ordering/no replay; numeric timeout failure accounting.
- [x] Unit and real isolated MCP/Chromium regression checks, including a slow backend and independent second session.
- [x] Final Mac package signature/DMG CRC, installed binary and four runtime resource equality, GUI0.2.42 and connected native API verified; owner inference and Windows/Linux acceptance remain separate.


## Concise interface copy (0.2.43)

- [x] Remove redundant context-meter and application explanatory paragraphs; retain labels, counters, actions, errors, empty states and concise data-sharing facts.
- [x] Move optional setting help to label hover; retain helper dictation as an actionable setting.
- [x] Frontend build and 696 tests pass.
- [x] Isolated Chromium and installed Mac GUI context/settings checks, signed package/DMG CRC/binary equality and healthy native connection verified; Windows/Linux native qualification separate.


## Session attachment gallery (0.2.44)

- [x] Shared message/source thumbnails and scoped gallery with search and navigation; compact three-source list and earlier-history loading.
- [x] Image zoom, bounded passive text/media and PDF canvas pages; preserve remote/file security boundaries, cleanup and scope isolation.
- [x] Unit and isolated Chromium acceptance including real PDF, inert HTML text, narrow layout and no owner mutations.
- [x] Final Mac signature/DMG CRC/install equality, native0.2.44 and actual historic image/gallery acceptance; source publication. Packaged WK PDF and Windows/Linux native acceptance remain separate.


## Project and session information (0.2.45)

- [x] Project/session dots menus open scoped accessible properties, including archived chats.
- [x] Full paged project index including archived/child sessions; title filter, dates, agent/model/parent/ID and copyable project/history paths.
- [x] Native read-only SQLite payload accounting (UTF-8 bytes/messages), exact Pi JSONL length; unknown/remote sizes stay unavailable. Project files, external attachments and shared database overhead are excluded explicitly.
- [x] Bounded query deadline, no arbitrary database path/transcript export, cancel/stale-host guards, no Pi directory creation on listing.
- [x] 707 frontend/100 Rust tests, real Chromium properties/search/narrow/no mutation, actual API-to-local-DB identity check, final Mac package signature/DMG CRC and source publication. Native installation deferred while owner agent works; Windows/Linux native qualification separate.

## Manual browser responsiveness (0.2.46)

- [x] Trusted pointer/wheel/key input avoids agent snapshots, while retaining authenticated native gateway, session queue, displayed-frame validation and agent observation invalidation.
- [x] Atomic pointer drag for text selection, Cmd/Ctrl+C copies selected text; password inputs excluded, cancelled gestures send no input.
- [x] Immediate single-flight capture after input and bounded visible polling; hidden-window/file-picker suspension retained.
- [x] System-browser action for sites that reject automated login. Separate cookies; no automation identity masking or Google login bypass.
- [x] Isolated Chromium input/selection/copy plus daemon guard/smoke checks. Installed Mac WK pointer input/drag/Cmd+C paste confirmed on test-owned fixture; owner-site responsiveness remains a separate check.

## Shared web search reliability (0.2.48)

- [x] Read-only shared MCP search for OpenCode/Pi, independent provider fallback, bounded deadlines and cancellation.
- [x] HTTP403/401 cooldown, bounded Retry-After, explicit provider errors/status, bounded output and untrusted result contract.
- [x] Portable recovery skill and non-destructive registration; disabled/user-edited service preserved.
- [x] Reject RSS results with no query anchor match; GitHub-only repository scope/fallback via official API, empty responses distinguished from outages.
- [x] Regression coverage and real isolated SDK discovery/search/status with Bing sources after two actual403 responses.
- [ ] Live Windows/Linux qualification. Public providers do not guarantee availability or target-site access.

## Full access consistency (0.2.49)

- [x] One chat access selector for OpenCode/Pi; Pi persists permissions, applies per-process full/ask/read, preserves forks and replaces idle processes on policy changes.
- [x] Explicit external-directory grant and scoped plugin inheritance for delegated OpenCode work; legacy full representation and append-only engine permission updates recognized. Role prompts remain intact.
- [x] Browser adapter derives full file access from invoking chat; official backend connections separate full/project policies. Other session identities and interaction guards remain independent.
- [x] Isolated actual OpenCode SDK/API inheritance and idempotency; frontend/native checks. Package/live-browser acceptance recorded separately.
## Model API connection recovery (0.2.50)

- [x] Distinguish model transport errors from engine, HTTP authentication and balance failures; display the latest message error once.
- [x] Read-only check of the failed message's exact managed model, fresh policy and readiness; no select, inference or prompt replay.
- [x] Configuration/chat guards; checking an unloaded or agent-restricted model does not mark other chats' working model unavailable.
- [x] Optional Mac SSH supervisor: strict keys, loopback forwards, owned child, bounded health probes and reconnect/backoff for stalled forwards.
- [x] Regression tests, isolated real HTTP stalled-listener recovery, launchd restart and real Chromium offline/recovery/narrow UI.
- [x] Final Mac signature/DMG CRC, staged install/binary equality, actual native model-check UI and reviewed main/release publication; downloaded release artifact verified.
- [ ] Live Windows/Linux qualification of the common UI; supervisor is a Mac deployment helper.

## ZIP attachments and queued corrections (0.2.51)

- [x] Preserve original ZIP bytes in private local/connected-SSH storage; shared file references for OpenCode/Pi and the source gallery.
- [x] Remove individual queued files; await pending draft mutations and use current attachment IDs.
- [x] Apply edited text/files before Now, explicit Pi steer, visible guard failures and cancellation before POST after Stop.
- [x] Frontend/native/isolated UI checks, verified Mac package/install, real native queued-file/gallery acceptance and main/release publication; downloaded artifact verified.
- [ ] Native Windows/Linux and live SSH qualification.

## Legacy-client source bootstrap — 2026-10-15

- [x] Latest stable ZIP/manifest and immutable signed-source downloads through existing LAN HTTPS Hub; no device key needed for public release sources, private APIs stay authenticated. Automatic latest tracking and Windows manual-build instructions.

## Review of Workshop model catalog — 0.2.74

Shared Russian response policy across OpenCode/Pi/manual/queue/schedules, with hidden exact policy blocks in Pi history. JSONC edits use the existing parser and refuse malformed/duplicate keys; both engine files are validated before writes, with explicit partial-CAS failure recovery. Empty published catalogs can remove managed providers. Hub rejects duplicate providers and inline secrets and guards current editors with expectedVersion. Restart owns a live Child handle, checks idle and listener PID, and refuses external servers.

Progressive dictation in 0.2.74: no total time limit, observed silence60s, independent short phrase clips, IndexedDB checkpoint before ASR, serial progressive draft delivery with durable receipts, explicit scoped recovery and safe audio flush on quit/update. CPU GigaAM remains the existing service; no model replacement.

## Hub model coordination — 0.2.75

- [x] Central authenticated routing, persistent FIFO reservations per GPU and VM-local lifecycle ownership.
- [x] Whole-turn reservations for OpenCode/Pi/manual/queue/schedules, exact readiness before dispatch.
- [x] Chat-scoped switching status, cancellation without prompt loss, explicit lost-ack recovery.
- [x] Fixed Flash Next health plus shared V100 Qwen/Gemma/Artemis control; operator-only gateway credentials.
- [x] Live Hub/Chromium waiting → unload → load → ready and Stop acceptance without owner inference.

See [model services](docs/MODEL-SERVICES.md); release receipt and cross-platform limits are recorded in verification.

## Session-guided tool reliability (0.2.76)

- [x] Audit complete session snapshot; distinguish engine/tool, script/compiler and expected probe failures.
- [x] Explicit task-owned Cua sessions in schema and runtime; preserve background/exact-window/disabled gates, no implicit revival or replay.
- [x] Actionable stale-window/output-path/session hints with original failures preserved; updated portable computer/search skills.
- [x] Query-specific relevance rejection no longer poisons provider health; genuine access/rate-limit cooldown retained.
- [x] Shared OpenCode/Pi execution guidance at existing dispatch boundary, exact user-history hiding and attachment preservation.
- [x] Canonical release gates, served head/both downloaded packets/native signature verification and installed-client source update offer; no active-agent/native-app restart.

## Repetitive output-limit recovery (0.2.77)

- [x] Diagnose real length stops versus network failure; preserve history and request one scoped engine compaction, then one authorized corrective continuation.
- [x] Russian limit/repetition notice and explicit latest-session compaction action; no automatic prompt/tool replay.
- [x] Compaction session/host/model/activity race guards and a bounded deadline suitable for large local contexts.
- [x] Regression and isolated Chromium narrow/wide keyboard/scope/no-dispatch checks.
- [x] Verified Hub receipt, served head/both actual signed packets/native verification; installed client offers hot0.2.77. Real resumed agent completed12tool calls, no new length/tool-status failures; no app restart.

## RTX 5090 inference migration — 2026-10-19

- [x] Tune pinned Strata on the existing PCIe 3 / DDR4 host; retain native 262144 context and GPU Vision.
- [x] Independent runtime, inference-only authenticated gateway, exact readiness and bounded watchdog; preserve OpenCode/Pi URLs and Hub reservations.
- [x] Publish Hub model catalog v3 and Pi 262144 metadata; real client tools, cancellation, long input, coding and Vision acceptance.
- [x] Remove FreeToken services/runtime/cache after verified private backup; cold VM boot restores Strata and both clients.
- [x] Operator source/tests/docs and CI checks. This is a server migration; no desktop binary or empty hot UI release is required. See [Strata operations](services/strata/README.md).

## Queue preflight recovery (0.2.78)

- [x] Busy/permission races before POST wait without disarming automatic execution; recheck after model reservation and durable journal preparation.
- [x] Legacy idle and interaction-reply events drain the armed queue once. Stop, terminal failures and uncertain delivery still require explicit recovery.
- [x] Explicit resume durably acknowledges stale item errors without changing the captured model. Queue controls remain outside the scrolling rows, including narrow layouts.

## Queue drag ordering (0.2.79)

- [x] Left grip reorders ready requests by pointer with insertion marker, edge scrolling and Escape cancellation; arrow keys move a focused grip and announce its new position.
- [x] Save the complete reordered entries durably without changing paused/armed state. Reject changes during submission/editing or uncertain delivery; cancel stale drags after navigation or queue changes.
- [x] Queue UI loads as its own component, preserving the main bundle budget and existing file/edit/steer controls.

## Visible queue dragging (0.2.80)

- [x] Dragged request follows the pointer as a raised card, with its text and file count. Neighbouring rows animate into place around a reserved slot, using stable layout coordinates for hit testing.
- [x] Preserve durable drop ordering, cancellation and edge scrolling; respect reduced-motion preferences. Existing dispatch guards unchanged.

## Corrections within the running task (0.2.81)

- [x] Rename queued «Сейчас» to «Скорректировать». Keep the same session and safe-boundary steering, without abort/clear or disturbing the remaining queue.
- [x] Render corrections as compact «Уточнение» notes, with durable OpenCode part metadata and scoped Pi live/history markers. Send explicit continuation guidance; hide only exact app-owned same-session guidance.
- [x] Verify duplicate-click/queue preservation and Pi process/model/thinking preservation, live/history classification and ordinary-message distinction.

## Enki display branding, composer and dictation readiness (0.2.82)

- [x] First durable encoder checkpoint and live/unmuted track gate «Можно говорить»; bounded visible failure instead of premature readiness. Preserve pre-roll, progressive ASR, recovery and suspended-WebAudio capture.
- [x] Independent display-frame waveform, peak envelope, growing history and subpixel scrolling; responsive orange authoritative full-access badge and image previews.
- [x] Enki UI/window/tray/macOS display name, stable package/data/update identity. Rename the existing protected workshop without duplicating it; preserve exact legacy Pi hidden reminders.
- [x] Actual Chromium encoder/CPU ASR retains first spoken word; isolated native macOS WebKit AAC/MP4 readiness, canvas and recovery pass with synthetic input. Windows/Linux live shell checks remain separate.

## Enki: совместимый переход — 0.2.82

- [x] Переходный подписанный маршрут обновлений для старых клиентов; новые нативные клиенты принимают Enki.
- [x] Атомарный перенос собственных данных в enki, сохранение абсолютных путей, блокировка/журнал/восстановление; OpenCode/Pi остаются независимыми.
- [x] Совместимый переход опубликован; финальный пакет вынесен в 0.2.84.

## Enki: завершение переименования — 0.2.83–0.2.84

- [x] Совместимость отпечатка обоих имён Rust-пакета, подписанный переход для прежних клиентов.
- [x] Enki UI/документация/основной CLI/иконки; сохранён прежний CLI для зарегистрированных MCP.
- [x] Hub каталоги/служба и NAS резервные копии переведены на enki; ключи/TLS/данные и старые указатели сохранены.
- [x] Каноническая папка и GitHub-репозиторий Enki; основной бинарник enki плюс совместимый MCP-вход.
- [x] Финальный выпуск 0.2.84 проверен на Hub: совместимый старый маршрут, два подписанных пакета и публичный ZIP; macOS-подпись/профиль/два CLI/иконка, Linux пакетная миграция в отдельной базе. Windows/Linux GUI — отдельная проверка.
