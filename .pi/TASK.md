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
