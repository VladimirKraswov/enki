# Explicit-profile secret isolation — source-only result

**All checks NOT RUN.** No command, build, test, fmt, clippy, typecheck, app,
keychain, network, enrollment, git or owner-data access was performed. Only
file reads/edits in this project (sdk-reference read-only). No version bump,
publish or release claim. This narrow pass does NOT replace the mandatory
whole-code Opus review before Enki2.0, nor coordinator Mac/private-fixture
verification of every check below.

## Helper and service mapping

`src-tauri/src/paths.rs` adds `SecretNamespace { legacy, suffix }`:
`service_for(None)` = shipped literal `legacy`; `service_for(Some(root))` =
`dev.enki.profile.<full lowercase SHA256(root.to_string_lossy().as_bytes())>.<suffix>`;
`service_from(Err)` stays `Err` (no default fallback); `service()` =
`service_from(profile_override())`. `root` is the canonical physical path
already returned by `profile_override` (canonicalization unchanged).

| Site | No profile (byte exact, unchanged) | Explicit profile | Account (unchanged) |
|---|---|---|---|
| runtime/vault.rs provider | `dev.local.opencodedesktop.pi-credentials` | `dev.enki.profile.<h>.pi-credentials` (same as before) | versioned provider accounts |
| hub.rs device `vault` | `dev.local.opencodedesktop.hub` | `dev.enki.profile.<h>.hub` | `endpoint` |
| hub.rs `admin_vault` | `dev.local.opencodedesktop.hub` | `dev.enki.profile.<h>.hub` | `endpoint#model-admin` |
| capabilities.rs `credential` | `dev.local.opencodedesktop.shared-mcp` | `dev.enki.profile.<h>.shared-mcp` | `{scopeKey}/{serverId}` |
| images.rs `entry` (alias) | same shared-mcp service | same profile shared-mcp service | `global/enki-images` |
| model_credentials.rs | `dev.local.opencodedesktop.model-control` | `dev.enki.profile.<h>.model-control` | normalized loopback origin |

Profile A != profile B != default for every site; the four profile
namespaces differ by suffix. No legacy probe, migration, fallback or owner
bootstrap import exists. Invalid/symlink/file/relative/`..`/home profile
makes `profile_override` (and thus every service) return `Err`.

## Files and lines changed (for strict three-way integration)

- `src-tauri/src/paths.rs` 21-123: `sha2` + `Path` imports, `#[cfg(test)] mod
  profile_isolation_tests;`, `SecretNamespace` + `HUB_SECRETS`,
  `SHARED_MCP_SECRETS`, `MODEL_CONTROL_SECRETS`; `profile_override` body now
  delegates to new `validate_profile_root(root, home)` — identical checks,
  messages, 0700 creation and canonicalization; `home` injected (previously
  `user_home()` called twice).
- `src-tauri/src/paths/profile_isolation_tests.rs` NEW (test-only child module).
- `src-tauri/src/runtime/vault.rs` 61-72: `pub const NAMESPACE` (legacy =
  `super::VAULT_SERVICE`, suffix `pi-credentials`); `service()` → `NAMESPACE.service()`.
  306-327: appended `#[cfg(test)] mod namespace_tests`. **Conflict-sensitive
  (native-quality author).** If rejected, only the old `service()` body may stay;
  then drop `NAMESPACE`/its test and keep the other sites unchanged.
- `src-tauri/src/hub.rs` 183-197: `device_account`, `admin_account`, `vault`
  uses `HUB_SECRETS`; 618-624: `admin_vault` uses `HUB_SECRETS` + `admin_account`.
- `src-tauri/src/capabilities.rs` 729-740: `credential_account` (validation
  moved unchanged) and `credential` now `pub(crate)` using `SHARED_MCP_SECRETS`.
  **Conflict-sensitive (Legacy author).** `root()` NOT changed: on Windows it
  derives from `browser::root_dir()` which now honors the profile.
- `src-tauri/src/images.rs` 46-56, 85: `MCP_SCOPE`/`MCP_ID`, `entry()` =
  `capabilities::credential(MCP_SCOPE, MCP_ID)`; `load_api_key` builds one
  entry for read and own-profile bootstrap write. Bootstrap path/validation
  unchanged (own `capabilities::root()/image-api.bootstrap` only).
- `src-tauri/src/model_credentials.rs` 18-27: `account()` = `origin()`;
  service from `MODEL_CONTROL_SECRETS`, computed before taking the lock.
- `src-tauri/src/browser/files.rs` 66-92: Windows `root_dir` →
  `windows_root_dir(profile_override()?, user_home)`; profile wins BEFORE the
  user-home `.enki`/`.opencode-desktop` lookup; no-profile route identical.
  Non-Windows branch unchanged. Tests 349-409 in existing module.
- `PROFILE-ISOLATION-RESULT.md` NEW. No `lib.rs`, manifest, frontend, SDK,
  Hub server, config authority or version change.

## Written regressions (NOT RUN)

- `paths::profile_isolation_tests`:
  `shipped_service_and_account_bytes_are_preserved` (all four legacy literals,
  SHA256("abc") known vector for provider/hub profile form, exact accounts of
  all six sites, account validation); `profile_a_never_reads_or_changes_owner_or_profile_b_secrets`
  (same endpoint/scope/id; owner sentinel seeded; A get/set/delete never
  touches the default service, B absent, sentinel intact, canonical A stable
  incl. trailing-slash spelling, four distinct namespaces);
  `hub_accounts_share_one_service_and_images_alias_mcp_only_within_one_profile`;
  `invalid_profiles_fail_closed_instead_of_using_the_default_service`
  (relative, `..`, home, file component, Unix symlink component; no dir created).
- `runtime::vault::namespace_tests::provider_service_bytes_are_unchanged_by_the_common_helper`.
- `browser::files::tests::windows_explicit_profile_root_beats_the_shared_user_home_root`
  and `windows_default_root_keeps_the_shared_outside_msix_route` — run the
  Windows selection on every host with fixture homes.

Tests use an injected in-memory store, temp fixtures and explicit inputs; no
`KeyringOs`, no process-env mutation, no owner path. Formatting by `cargo fmt`
was not applied; a few new test lines may need rustfmt wrapping.

## Limitations

- Not compiled or executed anywhere; Windows behavior is source-only.
- Child processes (`--shared-mcp` proxy, SDK workers) resolve the profile from
  their own inherited `ENKI_PROFILE_DIR`; env propagation was not audited
  (SDK/Node runtime excluded). Root and credential stay consistent per process.
- Existing `#[ignore]` model-control roundtrip uses the process profile; run it
  only with a disposable `ENKI_PROFILE_DIR`.
- Skill discovery under user home (`capabilities.rs` ~408) is not secret
  storage and was intentionally left untouched.
- Hub enrollment/acceptance from the handoff remains blocked until these
  checks pass on the coordinator's Mac with private fixtures.
