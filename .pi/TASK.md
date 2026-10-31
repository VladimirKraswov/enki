# Enki 2.0.23 — рефакторинг 2.0.22 + UX продолжения архива

W `.local/pi-sdk-migration-20261024/review`; R `/Volumes/Extend/work/Enki`.
Owner untracked `opencode.json` preserved (local `.git/info/exclude`).

## Done

2.0.22: dead-export sweep (21 zero-reader exports) + dedup dayKeyOf/finite
(usage), record guard (pluginUi), secondsText util. Commit 2569b38.
2.0.23: owner-reported archive-continuation UX integrated from isolated
review patch (sha256 c4367281…, base 757a972, applied clean): composer-level
archive notice + explicit «Продолжить чат»; Send/Enter inert in archive;
draft/attachments/model carry-over without auto-send; existing continuation
draft appended, not overwritten; click coalescing, late-answer fencing by
connection+directory generations; archive preserved (SDK continuedBy reuses
same continuation). Two added regressions: attachment-store transfer failure
+ retry, draft merge into existing continuation. Commit 4f64c65.

## Checks

All actually run green: full frontend 1209/195 files (incl. composer-archive
5 tests), agent 411, sdk:check 0.85.1/Node24.22.1, sdk-compat,
runtime-artifact, build, architecture 217 modules, bundle, docs. release:local
full gate incl cargo fmt/test/clippy both manifests. Real-browser live UI
acceptance NOT done (jsdom component tests only); owner app still on older
native.

## Accepted

Receipts `.local/releases/2.0.22-stable.json` (fp 3a51988d…) and
`2.0.23-stable.json` (same fp → hot-compatible from 2.0.22); served head
2.0.23 revision afdb6d8f…; both artifacts digest-matched; source packet
byte-identical for all changed files incl. the two new regressions. Pushed
to main through 4f64c65. Archive folder stabilize-v43 preserved untouched;
Quake query from screenshot intentionally not executed.

## Next

Nothing pending. Update application remains the owner's action.

