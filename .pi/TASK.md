# TASK — local Mac resource repair (31 Oct 2026)

Current owner request: diagnose RAM/SSD exhaustion, stop recurring accumulation,
move this Mac's Enki data to Extend without losing histories. This is local
maintenance; do not execute the previous release assignment automatically.

Verified cause: the owner's pending catalog UX test captured a vi.fn rather
than its implementation, then called the same newly replaced mock recursively.
Two bundled-Node OOM reports at 21:31/21:32 match those test runs; kernel reported
failed swapfile creation. The pending test was corrected in the original working
tree (getMockImplementation; missing root binding); 16 targeted tests PASS under
a 768 MiB heap. Pending model-catalog source/test work remains uncommitted and
must not be overwritten or silently published with this repair.

This branch: owner-selected physical data root with private identity marker and
no missing-disk fallback, external tool TMPDIR, runtime heap 1536 MiB, test heaps
1024 MiB, worker-exit cleanup of harness-owned temp directories preserving
restart/recovery tests. Version 2.0.27 is installed locally with the original app identity/entitlements;
codesign --verify --deep --strict PASS.

Checks completed: UI 198 files/1223 tests, Rust 285 PASS/7 opt-in skipped,
storage location 4 tests, runtime typecheck, clippy -D warnings, fmt, SDK pin
check, docs, architecture and bundle; artifact gate 100 PASS/4 platform skips.
Final runtime suite: 68 files/413 tests plus 167 SDK Node checks PASS. Native
release build PASS (custom protocol, two build jobs). No Hub or
GitHub publication has been performed for this local request.

Data: complete stopped-store copy SHA256-verified for 67,999 regular files,
9,755,886,709 bytes; both databases quick_check OK; all 307 session rows retained.
Paired rollback copy is on Extend. Two normal native launches connected to the external store; protected workshop
history is readable, all 307 session IDs match the backup and quick_check is OK.
The verified internal duplicate was removed; data and app rollback are on
Extend. Private receipts are outside Git.

DONE for the local Mac request. Native MacStorageGuard checks disk/pressure
every five minutes; allowlisted closed-app cache cleanup runs at most every six
hours, bounded logs, no process kills or session deletion. Operational config
and private receipts live outside Git. No other platform or Hub rollout claimed.
Do not start inference, replay old tasks, alter independent OpenCode/Pi stores,
or restart Eridu workers/VMs.

---
Previous checkpoint (historical context; no automatic continuation):

# TASK — checkpoint (UTC)

Standing scope: workshop self-development for the next stable release.

## Current task — update-navigation & badge freshness (2.0.26)

Owner complaint (31 Oct): the yellow update badge opened «Общее» instead of
«Обновления»; the update state was not understandable; after the 2.0.25 apply
restart the Hub-applied models were missing until an external agent re-applied
the catalog (Settings→Models→Apply). DeepSeek hit a refresh timeout during that
re-read; models.json itself was never rewritten (mtime evidence).

Proven on the pre-fix code (test kept in .local/update-navigation-audit/):
`useState(() => consumeUpdateSettings() ...)` consumed a module-global flag
inside render; any re-run of the mount render (Suspense retry / discarded
concurrent attempt) made the second initializer run see `false` and open
«Общее». Fix: peek-only in the initializer (render-safe), consumption happens
exactly once in the committed mount effect or the open-event listener.
Regression: test/update-navigation.test.ts (real lazy+Suspense App pattern;
case «discarded render» fails on the old code, passes on the new) and
test/update-navigation-flag.test.ts (peek is repeatable; consume is explicit).

Badge/tab single source of truth (hub_updates status contract): native caches
its check result and clears it when nothing newer remains; `release:null` is
confirmation, an absent field (older native) is not evidence. refresh() now
syncs version/kind/revision/FULL digest/binary-state changes (a real
digest-to-digest swap was previously ignored) and clears a stale available
release when the native cache says null — the indicator cannot stick.
Regressions in test/hub-updates.test.ts. While the workshop apply waits for
idle, the settings section and the badge both state the queued version and the
automatic restart explanation. Opening settings never starts installation
(only a read-only refresh).

## Catalog continuity after restart

Baseline snapshot: .local/update-navigation-audit/models-before-2.0.26.json —
providers local-artemis, local-gemma4, local-qwen, local-qwen-v100
(local-qwen/qwen38-flash-next serves this chat). After the 2.0.26 restart the
same four providers must be present without pressing Apply again; verify
against this file (do not switch to cloud models; DeepSeek refresh timeouts
are per-provider in the SDK and must not be treated as catalog loss).

## Checks so far

- Full vitest 199 files green (update-navigation regressions included), tsc,
  build, architecture 217, bundle. No src-tauri changes this round → the
  release is hot (green indicator); prepare downloads the hot packet.

## Next (release ordering per AGENTS.md)

1. Version bump 2.0.26 in all manifests, commit (this checkpoint is in it),
   `npm run release:local -- stable`.
2. Verify receipt publishedCommit == HEAD == main; push the same HEAD;
   `npm run release:packages -- stable` before any newer tracked commit.
3. desktop_updates: prepare → poll prepared/ready → apply as the final action.
   External agent verifies the installed 2.0.26, one badge click, and the four
   model providers surviving the restart.

## Notes

- `opencode.json` in the workshop store stays untracked (git exclude).
- Audit artifacts live in .local/update-navigation-audit/ (not committed).
