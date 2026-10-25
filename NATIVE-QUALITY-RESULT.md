# Native quality — bounded source author pass (config authority / runtime broker)

Source editing only. **No command, check, test, build, clippy, rustfmt or
typecheck was run on Igor.** Every check below is NOT RUN. Mac verification and
the final whole-code review are still required. No version bump.

## Changed paths

* `src-tauri/src/runtime.rs`
* `src-tauri/src/runtime/config_commit.rs`
* `src-tauri/src/runtime/config_commit_tests.rs`
* `src-tauri/src/runtime/config_fs.rs`
* `NATIVE-QUALITY-RESULT.md` (this file)

Not touched: `vault.rs`, `control.rs`, `build_job.rs`, `process.rs`, build
runner, Node/SDK/frontend/installer, manifests/locks. No control/updates
boundary change was needed. Collector.capture is left to its owner.

## Clippy groups addressed (scoped; no lint suppression added)

| Was | Resolution |
|---|---|
| config_commit.rs `with_lock_deadline` unused | `#[cfg(test)]`: its only role is to bound the wait in tests. |
| config_commit.rs `with_admission` unused | Production now uses it: `dispatch` -> `serve` -> `Authority::with_admission(live permit predicate)`. |
| config_fs.rs `read_checked` unused | Removed. No caller anywhere; the native side never re-reads published files. `options`/`regular`/`Read` still used. |
| config_commit.rs map_entry | `held.entry(path)` + `Entry::Vacant`, lock file opened from `slot.key()`. |
| config_commit.rs explicit_auto_deref | `current(&tx)`. |
| runtime.rs spawn_reader 9 args | 5 args: the generation's owned identity/shared state are grouped in `ReaderContext { gate, generation, current_gate, activity, acks }`, destructured at entry; no other change to the body. |
| runtime.rs while_let_loop | `while let Ok(true) = control::read_control_line(..)`; EOF and framing errors still end the stream. |
| config_commit_tests.rs needless borrow | `STANDARD.encode(models())`; the assertions are unchanged. |
| build_job.rs Collector.capture | EXCLUDED (owned separately); still red until that owner's change lands. |

## Generation semantics (now in production)

What I verified in the current source before changing it:
`GenerationPermit::is_active` (control.rs) says "check immediately before a
side effect". The runtime checked it once before dispatch, but `Authority`
could then wait up to `LOCK_DEADLINE` (3 s) for the OS lease, and production
passed no admission. Drain (`wait_drained_until`) is bounded, and startup or
replacement fail closed if it times out. So drain alone did not prevent a
revoked generation from starting authority effects after it was revoked.
The intended rule was not being met at the point where effects begin.

Chosen contract:

1. **No new operation after revoke.** `GenerationGate::admit` already refuses
   (unchanged). A queued job whose generation was revoked never reaches the
   broker (`BrokerJob::respond` checks the permit first).
2. **Deny at the OS-lock boundary.** Each config/vault request gets
   `BrokerJob::admission()`, a closure that owns a clone of the job's
   `Arc<GenerationPermit>` and returns `permit.is_active()`. It is not a borrow,
   not a global lookup, and never always-true. `dispatch` checks it on entry,
   then `serve` installs it on the Authority. `Authority` checks it at `call`
   entry (this also covers the journal-less read path), at `open_as` entry,
   on every contended poll inside `lock_until` (a revoked waiter returns
   `CONFIG_GENERATION_REVOKED` at once and does not hold drain open for up to
   3 s), and once more **under the lease**. That last check is authoritative
   and runs before claim (`enter`), process lease, journal open and recovery.
3. **An operation admitted under the lease runs to completion.** Revoke cannot
   interrupt keychain/SQLite work that has already started. Drain waits for it
   because the permit is shared by the job and the admission closure. The
   generation leaves the drain count only after the authority call returned,
   the response frame was written and the job was dropped.
4. Stale-claimant fencing (the `Writers` retire registry) is unchanged.

The remote relay still has no generation or admission: `CONFIG_LOCAL_ONLY`.

## New tests and assertions (written, NOT RUN)

`config_commit_tests.rs`:

* `revoke_while_admitted_requests_wait_for_the_os_lock_denies_them_without_any_effect`.
  This exercises the real chain `runtime::BrokerJob` -> its own permit admission
  -> `serve` -> Authority, with the existing child-process OS lock holder (now
  the shared helper `hold_authority_lock`). The setup commits a CAS and stages a
  gen-1 job. Two gen-2 requests are admitted (`config.begin` and
  `vault.compareAndSet`). Assertions:
  * After 300 ms both requests are still waiting, and drain is pending.
  * Revoke; `admit()` then fails.
  * Both requests return while the lock is still held, in under
    `LOCK_DEADLINE`, with `CONFIG_GENERATION_REVOKED` (not busy) and the correct
    id/generation/ok:false.
  * Drain stays pending until the settled jobs are dropped.
  * A queued, pre-admitted job never reaches the broker.
  * A late uncontended `serve` with a revoked admission is refused.
  * After the drain completes:
    * the full root snapshot (names and bytes) is byte-identical;
    * the SecretOs map is identical, and so is the head;
    * the gen-1 job is still `prepared` (not recovered) and OP_B is `unknown`;
    * gen-1 can still commit, so it was not retired (no claim);
    * the denied CAS id is not a receipt (a fresh CAS gives revision 2).
  * A new generation with its own permit is served (revision 3), drains, and
    retires gen-1 (`CONFIG_GENERATION_REVOKED`).
* `admission_is_rechecked_under_the_lease_after_the_entry_checks_passed`. The
  predicate is live for the two entry checks and false for the third. The
  assertions are: `CONFIG_GENERATION_REVOKED`, exactly 3 checks, a
  byte-identical root, no claim and no receipt.

`runtime.rs`: `broker_job_admission_is_its_own_live_permit_and_holds_the_drain`
checks that the broker receives the method and params, that the admission sees
revoke at once, that nothing new is admitted, and that the response frame is
exact. Drain stays pending while either the job or a retained admission clone
is alive.

All 21 existing config cases and the ignored child fixture are kept. The bounded
foreign-lock test now uses the extracted helper; its assertions are unchanged.

## Remaining limitations

* Formatting is not applied. Mac rustfmt is needed, and my new lines follow the
  long-line style of the surrounding test file.
* The revoke-wait test uses a 300 ms delay to make sure both requests reach the
  lock wait. The assertion "not finished yet" guards against a false pass.
* Windows: LimitOs/MemoryOs qualify the chunk logic only. There is no live
  Credential Manager. A GNU typecheck is not Windows acceptance, and `sync_dir`
  is a documented no-op on Windows (no directory fsync parity claimed).

## NOT RUN

`cargo check --all-targets`, `cargo test` (config, runtime, control), `cargo
clippy --all-targets -- -D warnings`, `cargo fmt --check`, Windows target check.
All of them must be run on the Mac.
