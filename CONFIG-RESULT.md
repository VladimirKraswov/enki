# CONFIG-RESULT — Pi config/vault import and restart reload

**SOURCE ONLY / NOT VERIFIED.** Nothing was compiled, type-checked, tested, run or
installed. Every check below is **NOT RUN**. No version bump, no release; 2.0.0
only after coordinator Mac acceptance. Windows bootstrap and runtime/routes
legacy-history callers are not part of this pass. `legacy/pi-agent.ts` (frozen
planner) is unchanged.

## What was implemented

**Native authority** (`src-tauri/src/runtime/`):
- `vault.rs` — the `SecretOs` trait (get/set/delete) and `KeyringOs` (the real OS keychain, with the same profile-specific service as before). Accounts are immutable `pi-ref:<sha256(logical, owner, revision)>` and never contain a value. `pi-provider:<id>` entries are read-only legacy input. It also defines the single identifier contract: `^[A-Za-z0-9._-]{1,128}$` for providers, `pi-import-<64hex>` for import ids, operation ids are 16–64 `[A-Za-z0-9-]`.
- `config_fs.rs` — the durable private filesystem:
  - every ancestor is checked with lstat; nothing is canonicalized, and links and reparse points are refused;
  - files are 0600 and opened with O_NOFOLLOW (Windows: FILE_FLAG_OPEN_REPARSE_POINT);
  - chunks are written at exact offsets, and an unjournaled tail is truncated;
  - sha256 and size are verified, then `sync_all`, then the directory is fsynced on unix;
  - publication is a no-overwrite rename of the generation directory: unix `rename` (EXDEV becomes `CONFIG_CROSS_DEVICE`), Windows `MoveFileExW(MOVEFILE_WRITE_THROUGH)` without REPLACE or COPY. There is no copy fallback.
- `config_commit.rs` — `Authority`, the single commit authority. It is a private SQLite journal at `<app_data_dir>/runtime-config/authority.sqlite` (synchronous=FULL), protected by an exclusive inter-process `fs2` lock held for every call.
  - One CAS `head {revision, generation, manifest_hash, operation, receipt}`.
  - Per-generation `bindings` (logical id → immutable account), `entries` (intent/staged/live), versioned `credentials` and idempotent `cas_receipts`.
  - Recovery runs on every open. Open operations belonging to another (dead) broker generation, and every crashed CAS intent, are rolled back by deleting only refs owned by that job and not referenced by anything. The current and previous generations are kept; older ones and unreferenced live refs are collected.
  - Nothing is created before the first write. Read-only calls then return the empty head and legacy credentials.
- `config_commit_tests.rs` — the native suite. It uses an injectable in-memory `SecretOs` with failure injection plus named crash points; the filesystem, SQLite and recovery are real.
- `runtime.rs`:
  - Removed the unconditional `vault.read/write/delete/list` methods and the two-write index.
  - Added `local_broker` (`config.*` and `vault.*` run only with the owned child's broker generation, on the job thread that holds the `GenerationPermit`). `broker_core`/relay refuse with `CONFIG_LOCAL_ONLY`, and `relayable()` stays hub/ui only.
  - Mutations respect `updates::ensure_writable()` (the maintenance fence). Status, abort and reads stay available.

**Broker API** (all local supervisor only):

| method | params | result |
|---|---|---|
| `config.current` | – | sanitized snapshot `{configRevision, generationId, manifestHash, directory, files[{name,sha256,size}], bindings[{vaultId,provider,kind,pointer}], deferred, sourceHashes}` |
| `config.begin` | `{operationId, manifest}` (plan minus `secrets`, + `expectedRevision`) | `{operationId, phase, configRevision}`; same id+manifest is idempotent, a different manifest returns `CONFIG_OPERATION_CONFLICT` |
| `config.fileChunk` | `{operationId, name, index, dataBase64}` (fixed 48 KiB chunks) | idempotent retry only if the bytes are identical |
| `config.secretPut` | `{operationId, logicalId, value≤64KiB}` | fresh owned ref; a retry is compared against the staged OS value (no digest is journaled) |
| `config.commit` | `{operationId}` | `CommitReceipt {receiptId, files, vaultIds, configRevision, generationId, manifestHash, conflicts}` |
| `config.status` / `config.abort` | `{operationId}` | phase/receipt/error; abort is a no-op after the head |
| `config.secretRead` | `{configRevision, logicalId}` | current head only, otherwise `CONFIG_REVISION_CHANGED` |
| `vault.credentialRead` / `vault.credentialList` | `{providerId}` / – | `{value, revision, source: versioned/legacy/deleted/none}` / provider ids only |
| `vault.compareAndSet` | `{operationId, providerId, expectedRevision, value\|null}` | `{revision}` or `{conflict:true, revision}`; idempotent per operationId |

**Commit stages:**
1. `prepared` journal.
2. Intent row, then OS set, then read-back verify, then `staged`.
3. All files complete with matching hashes; every bound ref present in the OS.
4. fsync, then no-overwrite publish, then `published`.
5. Re-verify the published bytes and the refs.
6. One IMMEDIATE transaction: head CAS + provider-credential adoption + `committed` receipt.

Before the head, the previous config stays active. After the head, the same receipt is always returned and a commit is never reverted.

**Runtime** (`src-tauri/resources/agent/src/`):
- `legacy/pi-config-commit.ts` — `NativePiConfigCommitPort`:
  - budgets the full inventory before `begin`: file sizes and total, binding/secret 1:1, provider ids, secret ≤64 KiB;
  - transfers in bounded frames;
  - lost ACK: the same request is resent once, then `config.status` with the same id; never a new import or id, never a blind secret replay;
  - on failure, `config.abort` removes only this job's refs;
  - the receipt must match the frozen plan exactly.
- `models/config.ts` — `ConfigProjection`:
  - re-verifies every generation file (O_NOFOLLOW, size, sha256), then resolves header and api-key bindings into private maps;
  - states are `none / ready / shadowed / blocked`; `status()` is sanitized;
  - header merge: provider headers, then model (`models[i]` / `modelOverrides[id]`) headers, case-insensitive, `null` deletes. Unknown pointer shapes are refused.
- `models/credentials.ts` — `VaultCredentialStore`:
  - `modify` reads value+revision, runs the SDK callback with no native lock held, then CAS;
  - on conflict it never reruns the callback: an OAuth refresh adopts the fresher committed credential, anything else gets `CredentialConflict`;
  - a lost CAS ACK is retried with the same operationId;
  - `assertAdmissible` runs before every read.
- `sdk/adapter.ts`:
  - `createModelRuntime({config})` uses the immutable generation `models.json` (no apiKey/headers in it), so no literal reaches SDK `$VAR`/`${VAR}` interpolation;
  - config + `agent-dir` credentials is refused, so there is never a plaintext auth.json;
  - the projection is bound to the model runtime. Every `openAgentSession`, including ephemeral `checkModelAccess`, runs the preflight (`CONFIG_SECRET_UNAVAILABLE` before any session exists) and gets the `<enki-host:config-headers>` host prelude (`before_provider_headers`, mutated in place);
  - imported allowlisted settings go into `SettingsManager.inMemory` under Enki-owned keys, with telemetry off and empty resource lists.
- `core/runtime.ts`:
  - `Runtime.create` loads the projection before the model runtime, catalog, registry and admission (local vault host only);
  - `sdkSettings()` projects the imported settings; imported `retry` replaces the forced default;
  - new `importPiConfig(signal)` (admission-reserved; refuses during maintenance and on an existing owner `agentDir/models.json`; applies on restart) and `configStatus()`.
- `control/broker.ts` — the new method names. `server/routes.ts` — narrow caller fix: `POST /migrations/pi-agent` (it was calling an obsolete signature) now goes to `runtime.importPiConfig`, plus `GET /migrations/pi-agent` returns the sanitized status, and the projection is passed to the `/credentials` store.

## Deterministic policies

- **Existing provider credential** (a versioned row, a tombstone or a legacy `pi-provider:` entry) always wins over an imported auth.json credential. It is never overwritten or deleted. The import stays bound and is reported as `conflicts[{vaultId, policy:"existing-provider-credential-kept"}]`. With no existing credential, the commit adopts the imported ref as `provider:<id>` revision 1.
- **API key**: a stored provider credential comes before the imported models.json key, which is the fallback (SDK precedence).
- **Owner `agentDir/models.json` with providers** blocks the import (`CONFIG_EXISTING_MODELS_CONFLICT`). If it appears later, the generation becomes `shadowed`: it is not mixed in and its headers and keys are not injected.
- **Missing/changed binding or vault failure**: the bound providers are `blocked` (the catalog stays visible). An unreadable authority blocks all model access. There is no fallback to ambient keys.

## Exact remaining caller ports (not done here)

1. **Frontend** (migration UI): call `POST /migrations/pi-agent`, show `receipt.conflicts`, `deferred` and `applies:"restart"`, then use the existing runtime restart. Show `GET /migrations/pi-agent` state/code.
2. **`routes.ts` `GET/PUT /config/models`** still edits `agentDir/models.json`. When `configStatus().state==="ready"` it should show the generation file read-only. Saving now shadows the import, by design.
3. **Hot reload**: `Runtime.applyConfigGeneration()` under `MaintenanceGate.begin()`. It must load a new `ConfigProjection`, create a new model runtime and swap the registry/session workers together. Currently changes apply on restart only; the running process keeps one immutable projection, and the native side keeps the previous generation for it.
4. **Default model**: `defaultProvider/defaultModel` from the imported settings are not applied to registry default selection; the model-transition owner should take this.
5. **Resource migration**: the frozen planner records only deferred pointer names, not paths, pins or values. Real plugin/skill/prompt/package transfer needs a planner revision, then an inert `needs-validation` manifest. Keybindings are published but inert (Enki has no consumer).

## Known limitations (real)

- **The SDK 0.85.1 declarations/dist are not in this snapshot.** Three things are unverified:
  - the `before_provider_headers` event shape (`headers`, `model` or `ctx.model`);
  - that a stored `api_key.key` is not run through config-value interpolation;
  - that `allowModelNetwork:false` does not block inference.

  The end-to-end test covers all three, but it is NOT RUN. If stored keys turn out to be interpolated, `$`-containing api-key literals must be refused, not delivered.
- Headers are injected only for session requests. Provider code making requests outside the session hook (login, dynamic catalogs) does not get imported headers; this is not claimed as covered. Trusted user extensions running after the host prelude can see or modify headers (SDK trust model).
- **Windows** (not run on Windows): there is no directory fsync. Durability relies on FlushFileBuffers plus MOVEFILE_WRITE_THROUGH. Credential Manager allows 2560 bytes of UTF-16 (1280 code units) per entry; superseded by CONFIG-FOLLOWUP-RESULT.md (OS-protected bounded parts, no plaintext sidecar).
- Legacy `pi-provider:*` entries are never deleted, only shadowed by versioned rows or tombstones. A binary rollback to an older Enki would read those stale entries.
- The removed `vault.read/write/delete/list` methods now fail closed for any out-of-tree caller. The remote runtime cannot import config (`CONFIG_LOCAL_ONLY`, never auth.json).
- At most 4 open operations. Stale operations are cleaned only after their owner is retired (same process) or proven dead (another process). The inter-process lock wait is deadline-bounded (CONFIG-FOLLOWUP-RESULT.md).

## Tests written (all NOT RUN)

Native (`cd src-tauri && cargo test --lib runtime::`). Coverage: OS vault without the keychain, real filesystem/SQLite, crash after every vault and file phase, lost ACK, concurrency, owner, OAuth CAS, plaintext scan, unchanged source.
- `runtime::config_commit::tests::` — `import_publishes_exact_receipt_and_keeps_values_off_disk`, `preexisting_legacy_and_versioned_credentials_survive_import`, `import_without_existing_provider_credential_becomes_the_provider_credential`, `concurrent_imports_cannot_overwrite_or_roll_back_each_other`, `lost_ack_retries_return_one_receipt_and_never_accept_changed_payload`, `crash_after_every_vault_and_file_boundary_recovers_exactly`, `crash_during_cleanup_is_resumed_without_touching_foreign_refs`, `wrong_owner_cannot_continue_and_rotation_keeps_committed_generation`, `oauth_cas_never_overwrites_a_newer_credential_or_replays_a_refresh`, `vault_failure_oversized_or_missing_secret_never_moves_the_head`, `manifest_schema_identity_and_inventory_budget_fail_closed`, `reads_before_any_write_create_nothing_and_keep_legacy_credentials_available`, `linked_root_or_staging_is_refused` (unix).
- `runtime::tests::` — `vault_is_reachable_only_through_versioned_local_config_methods` (new), and `remote_relay_never_exposes_the_vault_or_local_paths` (extended to cover the config/vault methods).

Runtime (`cd src-tauri/resources/agent && npm run typecheck && node --test test/config-vault.node.ts test/legacy-qualified/pi-migration.node.ts`). `test/config-authority-fake.ts` is a test-only model of the broker contract.
- `test/config-vault.node.ts`:
  - bounded frames, values only in `secretPut`, and an unchanged source;
  - lost ACK on commit and on a secret;
  - a native conflict aborts only its own job;
  - budget enforced before any call;
  - restart projection: literal `$VAR`/`${VAR}`, header merge/null, no ambient resource settings, a sanitized DTO;
  - a missing binding blocks only the bound provider; an unreadable authority blocks everything; shadowing;
  - end-to-end against a 127.0.0.1 OpenAI-compatible fixture: the ephemeral `checkModelAccess` sends the literal key and imported headers; a blocked binding sends zero HTTP requests; no secret appears in agentDir or the generation; `agent-dir` is refused;
  - two independent stores: OAuth refresh with no callback replay;
  - API-key conflict, lost-ACK CAS and tombstone;
  - adoption/precedence of the imported credential.
- Also to run: the full `cargo test`, `cargo clippy`, `npm test` (Vitest), and `npm run build` of the desktop and the runtime.
