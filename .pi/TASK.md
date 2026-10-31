# TASK — checkpoint (UTC)

Standing scope: workshop self-development for the next stable release.

## Current task — automatic release acceptance (`desktop_updates`)

Owner directive (31 Oct 2026): after the workshop publishes, the application
must take the update itself; manual clicks are not the standard path. Shipped
in 2.0.24 (commit 4d4bd9d, receipt verified, pushed):

- `desktop_updates` on the control bridge: `status` / `prepare` (idempotent
  verified download or local source build) / `apply` mirroring the visible
  Install control, including the durable wait for authoritative idle before a
  source restart.
- Workshop policy (agent tree + workshop/root AGENTS + docs/AGENT-CONTROL.md +
  docs/HUB-UPDATES.md): after an accepted receipt run status → prepare → poll
  → apply as the final action; explicit owner veto or a missing tool keeps the
  plain offer. The previous policy wording is retained only for history
  stripping (LEGACY_WORKSHOP_RELEASE_CONTEXT).
- Bootstrap: the running 2.0.21 predates the tool, so THIS transition is
  finished through the GUI once (Settings → Обновления → prepare → install);
  from 2.0.24 onward the loop is programmatic.

## Done

- 2.0.22 self-refactoring (commit 2569b38): dead exports removed (21 exports,
  including two duplicate `dayKeyOf`, two `finite` and five unused CSS rules),
  shared `secondsText` duration helper, one recorded-call guard in
  pluginUi/session with an assertion instead of the local `record()` copies,
  the `runtime-events` boundary rule restored and an honest export count in
  docs/AGENT-GATE.md. Receipt verified byte-for-byte; pushed.
- 2.0.23 owner-relayed archive continuation UX (commit 4f64c65): explicit
  «Продолжить в архиве» action, IndexedDB draft + delivery continuation before
  the queue releases, bounded model recovery for accepted continuation turns,
  durable delivery journal, stable «Продолжение archive» sessions in the
  «Архив» view. Patch integrated with two extra regressions (IndexedDB failure
  keeps draft and allows retry; a second send merges the draft into the
  existing continuation). Receipt verified byte-for-byte; pushed.
- Both stayed source-kind: 2.0.22 changed agent resources so the native
  fingerprint moved fcc50c98 (2.0.21) → 3a51988d (2.0.22/2.0.23) → 26213be7
  (2.0.24). No green badge is expected on 2.0.21; the yellow badge appears
  only after a local prepare or binary reports ready, and GitHub packets were
  not published for these versions.

## Checks

- 2.0.24: vitest 1214/196 files, agent 412/67 files, control/updates
  regressions (15+9), cargo control suite 13, tsc, architecture 217, bundle,
  build, docs 65 files, fmt+strict clippy; `npm run release:local -- stable`
  repeated everything. Receipt `.local/releases/2.0.24-stable.json`; served
  head and both signed packets re-downloaded via the device transport and
  compared file-by-file against commit 4d4bd9d (bridge.ts, control.rs,
  workshop policy/tests, docs, package.json all byte-identical; hot bundle
  contains the new contract).
- 2.0.22 and 2.0.23 receipts verified the same way against commits 2569b38
  and 4f64c65 (source packet extracted from the device-transport envelope).

## Accepted

- Hub/stable publishes verified: 2.0.22 (source f1b75068…/hot
  77c1981a…), 2.0.23 (source 6b56d5d5…/hot a92518f4…), 2.0.24 (source
  b336ebba…/hot c72782e8…), served head 2.0.24.

## Next

- Bootstrap this transition via the GUI (Settings → Обновления → prepare the
  2.0.24 source build → install when idle); afterwards future workshop rounds
  accept updates through `desktop_updates` automatically.
- Consider `npm run release:packages -- stable` for 2.0.22–2.0.24 when
  repository rights are available, so installs can download finished
  binaries instead of compiling locally.

## Notes

- The workshop store keeps `opencode.json` untracked (git exclude), owned by
  the owner; never stage it.
- Archive folders from previous migrations are kept under
  `.local/pi-sdk-migration-20261024/` (stabilize-v43 now also holds the
  archive-continuation patch receipt and verification note); do not delete.
