# CONFIG-FOLLOWUP-RESULT — native/SDK credential contract fixes

**SOURCE ONLY. Nothing was compiled, type-checked, formatted, tested or run.
Every check below is NOT RUN.** No version bump or release; Enki 2.0 / 2.0.0
only after Mac acceptance and the separately required whole-code Opus review.
This is not a final review.

## Resume baseline

The interrupted job left these partial changes. I read them, kept the correct
ones as they were, and finished the rest:
`runtime/config_fs.rs`, `runtime/vault.rs`, `runtime/config_commit.rs` (lock
deadline, process leases, admission, `cas_requests` table), `models/credentials.ts`,
`test/config-authority-fake.ts`, `test/config-credential-contract.node.ts`,
`test/config-vault.node.ts`. The native test file and `core/runtime.ts` had not
been touched yet.

## Changes

1. **E0308 compile fix** (`config_fs.rs`, `verify_and_sync`): the function now
   ends with `file.sync_all().map_err(|_| ERR_IO.to_string())`. I found no other
   `&str` tail expression of this kind. All 13 original native tests are kept.
   Three of them were updated for item 6 (see "Tests written"); none of their
   plaintext, crash or CAS assertions were weakened.
2. **SDK `CredentialStore` contract** (`credentials.ts`, from the partial run; verified against `qualified-sdk/pi-ai/dist/auth/types.d.ts:68-78`):
   - `modify`: a callback returning `undefined` makes no CAS call and creates no new revision. It returns the current effective credential. A callback rejection propagates.
   - On a CAS conflict the callback is never re-run. An OAuth refresh adopts the fresher committed credential.
   - `delete` is its own serialized CAS to `null` on the same per-provider chain. Deleting when nothing is stored writes nothing. A newer cross-client write makes `delete` fail with `CredentialConflict` and is never erased. A lost ACK is retried with the same operationId and the full `null` payload.
   - No native lock is held while the SDK callback runs. `sdk/adapter.ts` did not need changes.
3. **Deadline-bounded OS lock** (`config_commit.rs`):
   - `lock_until` uses `try_lock_exclusive` with backoff from 2 ms up to 100 ms. It never calls a blocking `lock_exclusive`.
   - The deadline is `LOCK_DEADLINE` = 3 s, shorter than the runtime's 5 s replacement drain. The SQLite `busy_timeout` gets only whatever time is left of that deadline.
   - Results are typed: `CONFIG_AUTHORITY_BUSY` (no read-modify-write and no recovery happened), `CONFIG_DURABLE_IO` (the lock call itself failed), and `CONFIG_GENERATION_REVOKED` (from the admission check and from item 6).
   - A lock that is obtained only after the deadline is released, and nothing is admitted.
   - A foreign holder is never killed or released.
   - **Still uncertain:** only the *wait* is bounded. A keychain or SQLite call that stalls inside the lock holder's own call cannot be interrupted. Its outcome stays unknown until that call returns, and the caller reconciles it with the same operationId or `config.status`.
4. **CAS receipt bound to the complete request** (`config_commit.rs`, `vault.rs`):
   - `cas_requests.request` stores HMAC-SHA256 over the operation, provider, expectedRevision, an explicit `null`/`value` discriminator and the value. Parts are length-prefixed.
   - The key is a random 256-bit value at OS-vault account `pi-authority:cas-request-key-v1`. It is created once under the lock and is never written to disk or into the journal.
   - The tag is written in the same transaction as the success or conflict receipt.
   - Reusing an operationId returns the original receipt only if the tag matches, compared in constant time. Otherwise it is `CONFIG_OPERATION_CONFLICT`. This also covers receipts that have no tag.
   - Receipts do not depend on the current credential or on collected refs, so an old receipt still verifies after newer writes.
   - The journal never holds the plaintext value, a plain hash of it, or the key.
5. **Windows 2560-byte UTF-16 limit** (`vault.rs`, `ChunkedOs`; on Windows only, through `platform_os()`):
   - The limit is 1280 UTF-16 code units per entry. 2500 ASCII characters do not fit.
   - A value within the limit is stored raw, unchanged.
   - A larger value is split into parts `account#1..n` on char boundaries, so a surrogate pair is never split. The parts are written first and the manifest `\x01enki-chunked-v1:<n>:<units>` is written last, under the same immutable owned account.
   - `get` checks the exact part count, the per-part limit, the total UTF-16 length and the 64 KiB cap. A missing manifest reads as absent.
   - `delete` removes the manifest and probes every possible part, so crash orphans are removed through the existing owned intent/cleanup/collect paths.
   - Setting a raw value that starts with the marker is refused.
   - There is no plaintext sidecar. Secrets-off-disk and old-provider-wins are unchanged.
   - `max_parts` uses `max_units - 1` so that a part shortened to avoid splitting a pair still fits within the count bound.
6. **Ownership/recovery precondition** (`config_commit.rs`):
   - The runtime revokes and drains the previous generation before starting a child (`runtime.rs:810-819, 852`), and the job workers check `permit.is_active()`. The authority now *enforces* this instead of assuming it. A per-(root, process) `Writers` registry is used under the OS lock: the first claiming call of a new generation retires the previous claimant. Claiming calls are begin, fileChunk, secretPut, commit, abort and compareAndSet. A retired generation gets `CONFIG_GENERATION_REVOKED` on every call, reads included.
   - Read-only calls (`current`, `status`, `secretRead`, `credentialRead`, `credentialList`) go through `observe()`. They never retire a generation and never reclaim an unproven job, so they see a live import as pending.
   - A foreign job is reclaimed only with proof: same process and the owner was retired; another process whose lease is lockable (it died); or a journal row with no process row (written before leases existed), and only on a claiming call. Crash-left CAS intents are still always reclaimed.
   - Exact crashed-job recovery and retention of the current and previous generation are unchanged.

**`core/runtime.ts` merge.** This was mechanical and three-way: the result equals `runtime-merge-conflict.txt` with the conflict resolved.
- The import union keeps `PtyService, type PtyModule` and adds `snapshotSessions, syncDirectory, type SessionSnapshot` from `platform/update-snapshot.ts`.
- `UpdateBackup.sessions` was added.
- In `backupForUpdate`, the paired JSONL snapshot is taken under the maintenance fence, with a re-check of the fence, and `syncDirectory` replaces the inline fsync loop.
- All Config, UI, PtyModule and plugin changes are preserved.
- The line counts reconcile (592 + 8 = 600 lines). I found no semantic conflict.

`CONFIG-RESULT.md`: the outdated Windows and lock limitation bullets now point here.

## Tests written (all NOT RUN)

Native: `cd src-tauri && cargo test --lib runtime::config_commit::tests:: --locked`

- **Updated for item 6, assertions kept:**
  - `crash_after_every_vault_and_file_boundary_recovers_exactly`: a read now sees the job as pending, then the successor's claiming `abort` retires gen-1 and reclaims the job.
  - `crash_during_cleanup_is_resumed_without_touching_foreign_refs`: the successor's claiming `abort` resumes the cleanup.
  - `wrong_owner_cannot_continue_and_rotation_keeps_committed_generation`: documents the lifetime contract and adds `CONFIG_GENERATION_REVOKED` asserts for gen-1.
- **New:**
  - `live_reader_observes_a_staged_import_and_only_a_retired_owner_is_reclaimed`: gen-1 stages; live gen-2 reads between gen-1's calls; gen-1 commits; then gen-2 claims, and only gen-1's unreferenced refs are removed while both kept generations survive.
  - `another_live_process_job_is_never_reclaimed_until_its_lease_is_released`
  - `revoked_admission_is_refused_before_any_recovery_or_write`
  - `cas_receipt_is_bound_to_the_complete_request_even_after_newer_writes`: covers value→other value and value↔null for both success and conflict receipts, plus an old success receipt replayed after GC. It also checks that no value, value digest or key reaches disk.
  - `foreign_lock_holder_process_gets_a_bounded_busy_result_and_the_head_is_unchanged`
    - Its own child fixture is the `#[ignore]` test `lock_holder_fixture`, run by re-executing the test binary. It holds the exact `authority.lock`.
    - Four calls (two mutating, two reads) are each expected to return `CONFIG_AUTHORITY_BUSY` in under 3 s.
    - The head, the credential revision and the unjournaled CAS id are all expected to be unchanged.
    - The `Holder` guard always closes stdin, waits for the child with a bound, and kills its own child only as a fallback.
  - `windows_entry_limit_is_1280_utf16_units_and_larger_values_are_chunked_exactly`: uses `LimitOs`, which mirrors keyring 3.6.3's `encode_utf16().count()*2 > 2560`. Covers ASCII, `é` and surrogate pairs at 1280/1281 units, and values up to the 64 KiB cap.
  - `chunked_crash_before_manifest_reads_absent_and_damaged_parts_fail_closed`
  - `windows_sized_oauth_credentials_and_import_secrets_round_trip_through_the_authority`

Node: `cd src-tauri/resources/agent && node --test test/config-credential-contract.node.ts test/config-vault.node.ts`

`config-credential-contract.node.ts` has 9 tests and is a port of the independent reference:
- the real public SDK baseline;
- `modify(undefined)` on a stored credential and on an empty store;
- the real `createModels().getAuth()` OAuth double-check race;
- `delete` serialized after `modify`, deleting nothing, `delete` racing a newer write, and a lost delete ACK;
- the fake broker rejecting a reused id with a changed payload.

`config-vault.node.ts` asserts that `modify(undefined)` leaves the credential unchanged and that `delete` writes its own tombstone. FakeAuthority is only a model of the TS contract, not proof of native or Keychain behaviour.

Also to run: full `cargo test`, `cargo clippy`, `npm run typecheck`, `npm test`, and the builds. Mac runs the formatters.

## Remaining limitations

- **Windows: nothing was run.**
  - `ChunkedOs` is compiled into production only on Windows; on other platforms it runs only in these tests.
  - Each part is a separate Credential Manager entry under the same service and is visible in the Credential Manager UI.
  - `delete` costs up to 53 OS calls.
  - Credential Manager limits on the total number of entries are not qualified.
  - `sync_dir` is still a no-op on Windows; parity with Unix power-loss durability is not claimed.
- **CAS key:** if the key entry is lost, every old receipt refuses reuse (fails closed). The key entry is never deleted, so it survives a binary rollback. `cas_receipts` and `cas_requests` rows are never collected: about 200 B per CAS, growing without bound. Receipts written by the earlier unreleased build have no tag and refuse reuse.
- **Same-process writers:** the latest claimant wins. If two generations of one process were ever live at once (not a supported setup), the older one is fenced with `CONFIG_GENERATION_REVOKED` instead of both writing.
- **Other processes:** liveness comes from the lockability of each process's lease file. A lease file deleted from outside, under the 0700 root, would count as dead.
- **Admission port not wired:** `Authority::with_admission` exists but production `dispatch` does not pass the job's `GenerationPermit` to it. Wiring it is a `runtime.rs` caller port that I did not do (that file is out of scope). Today a revoked generation's call is refused before dispatch by `permit.is_active()`, and the permit is held for the whole call.
- **TS handling:** `CONFIG_AUTHORITY_BUSY` and `CONFIG_GENERATION_REVOKED` reach TS as ordinary coded errors. `VaultCredentialStore` retries once with the same operationId. Mapping these codes to UI messages belongs to the concurrent caller/Legacy integration job.
- The caller ports listed in CONFIG-RESULT.md are unchanged and still open: frontend migration UI, the `/config/models` read-only view, hot reload, default model, and resource migration.
