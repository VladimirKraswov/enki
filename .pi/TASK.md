# TASK — checkpoint (UTC)

Standing scope: workshop self-development for the next stable release.

## Current task — delivery-contract fixes (2.0.25)

Owner audit (31 Oct 2026, `.local/workshop-audit-20261031/`) confirmed the
workshop can edit any Enki part and the runtime injects the release policy,
but found delivery gaps. Fixed in this release:

- publication.commit is now a contract: Hub head publication commit must equal
  the verifying HEAD in both publishers (`verify.mjs`, `device.mjs`); receipts
  record `publishedCommit`; `dispatch-packages` refuses a mismatched receipt;
  republishing from a moved HEAD fails loudly without rewriting the immutable
  receipt. Regressions: device.test.mjs + verify.test.mjs.
- Safe release order documented and policy-enforced: final tracked docs and
  checkpoints BEFORE `release:local`; push the same HEAD; `release:packages`
  before any newer tracked commit; operational summaries live in `.local`.
  (Root cause of the blocked 2.0.24 dispatch: the checkpoint commit landed
  after the published commit; CI requires `published_commit == github.sha`.)
- Workshop runtime context is now refreshed at application start
  (`workshop::refresh_existing` in lib.rs setup): after an update restart the
  RUNTIME.json/WORKSPACE.json no longer stay stale when the workshop is
  resumed without opening its panel. Regression: Rust reentry test.
- Workshop AGENTS.md sync: the framed app-owned block
  `<!-- enki:delivery-policy:begin/end -->` is appended to owner-refined
  instructions and replaced verbatim when it goes stale; owner text outside
  the frame is never overwritten; an unterminated user frame is left alone.
  Rust regressions cover all three cases.
- docs/SELF-DEVELOPMENT.md and docs/HUB-UPDATES.md now describe automatic
  acceptance through `desktop_updates` and the publication.commit ordering
  instead of "apply is a separate action".

## Done

- 2.0.24 (`4d4bd9d`) shipped `desktop_updates` (status/prepare/apply) and the
  automatic-acceptance policy; receipt verified, installed via GUI bootstrap
  (the 2.0.21 app predated the tool), served head 2.0.24.
- 2.0.22 self-refactoring (2569b38) and 2.0.23 archive-continuation UX
  (4f64c65) published and receipt-verified; 2.0.24 GitHub packages remain
  unpublished (dispatch blocked by the post-publication checkpoint — history
  stays honest, no receipt rewriting).

## Checks

- This checkpoint: node --test release suite green (incl. new
  publication-commit regressions), agent tree 412/67 + typecheck, Rust
  workshop/control suites, fmt + strict clippy, frontend suite/build/docs via
  `release:local` gates.

## Next

- After this Hub publish: verify receipt `publishedCommit` == HEAD, push the
  same HEAD, then `npm run release:packages -- stable` with the existing gh
  rights; wait for all three OS packages and check the Hub native descriptor.
- Finish with `desktop_updates` prepare/apply as the final action; from this
  release the whole loop is programmatic.

## Notes

- The workshop store keeps `opencode.json` untracked (git exclude), owned by
  the owner; never stage it.
- Archive/audit folders live under `.local/` (pi-sdk-migration-20261024,
  workshop-audit-20261031); do not delete or commit.
