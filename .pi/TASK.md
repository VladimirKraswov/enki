# Enki 2.0.22 — глубокий саморефакторинг: мёртвые экспорты и дубли

W `.local/pi-sdk-migration-20261024/review`; R `/Volumes/Extend/work/Enki`.
H42 `../stabilize-v42`. Owner untracked `opencode.json` preserved (local-only
`.git/info/exclude`, repo untouched). Never touch owner histories/keys.

## Done (release 2.0.22 stable, published and accepted)

Dead-code sweep: removed 21 exports with zero readers in app/runtime/tests/
scripts (stale backend/browser/computer ids incl. wrong `COMPUTER_MCP` value,
retired DTOs `VcsFileStatus`/`PtyInfo`/`MigrationStatusDTO`/`isReadOnlySession`,
unused SDK aliases in adapter.ts, `bindPluginUi`, `archiveText`,
`PLUGIN_UI_PROTOCOL_VERSION`, `RecoveryButton`, `sessionStatusLine`,
`platformName`, `isMutatingTool`+MUTATING set). Verified by whole-tree name
count + tsc, not by guess.
Dedup: canonical `dayKeyOf`+`finite` in `src/usage/metrics.ts` reused by cache
and money (ledger day-key format unchanged, re-export from money keeps the
contract); shared `record()` guard pluginUi types→session; `secondsText` util
for TaskDiagnostics/BrowserPerformance panels.

## Checks (all actually run, green)

tsc front+agent clean; frontend 1204 tests/194 files; agent 411/67;
test:sdk-compat, sdk:check (0.85.1 on pinned Node 24.22.1),
test:runtime-artifact; build, check:architecture (217 modules, no cycles),
check:bundle, check:docs; full release gate incl. cargo fmt/test/clippy via
`release:local`. NOTE ambient node: Enki runtime node 24 works; prepending
/opt/homebrew/bin (node 26) breaks `--experimental-transform-types` fixtures.

## Accepted

Commit 2569b38; receipt `.local/releases/2.0.22-stable.json` (native fingerprint
3a51988d… — yellow/native release, agent resources changed; NOT applied to the
running session). Hub served head 2.0.22 revision 622701ee…, both artifacts by
digest, pinned signatures verified by publisher; independent check: served
source packet byte-identical to local files for all changed paths.

## Next

Nothing pending in this task. Update offer stands; owner applies it separately.
