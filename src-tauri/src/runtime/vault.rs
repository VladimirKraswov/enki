//! OS-vault boundary for the native config/credential authority.
//!
//! The OS keychain is not transactional. Atomicity of an import or of an
//! OAuth refresh comes from the CAS head in `config_commit.rs`; this module
//! only writes *immutable, never reused* accounts whose names are derived from
//! (logical id, owning operation, revision) and never from the secret value.
//! Existing `pi-provider:<id>` entries written by older Enki versions are read
//! here as a read-only legacy source and are never overwritten or deleted.

use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const LEGACY_PREFIX: &str = "pi-provider:";
/// Account list maintained by older Enki versions next to `pi-provider:*`.
pub const LEGACY_INDEX: &str = "__accounts__";
pub const REF_PREFIX: &str = "pi-ref:";
/// Total UTF-8 bytes of one logical secret, on every platform.
pub const MAX_SECRET: usize = 64 * 1024;
/// Random 256-bit key (hex) of the CAS request MAC. Owned by the authority,
/// never deleted: losing it only makes old receipts refuse every retry.
pub const CAS_KEY_ACCOUNT: &str = "pi-authority:cas-request-key-v1";
/// keyring 3.6.3 windows.rs refuses `password.encode_utf16().count() * 2 >
/// CRED_MAX_CREDENTIAL_BLOB_SIZE` (2560 bytes): at most 1280 UTF-16 code units
/// per Credential Manager entry, NOT 2560 bytes of UTF-8 or 2500 characters.
#[cfg_attr(not(windows), allow(dead_code))]
pub const WINDOWS_MAX_UNITS: usize = 1280;
/// Manifest of a chunked value. Starts with a control character; a value
/// with this prefix is refused, so a raw entry can never be misread as one.
#[cfg_attr(not(windows), allow(dead_code))]
const CHUNK_MARKER: &str = "\u{1}enki-chunked-v1:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    Unavailable,
    Read,
    Write,
    Delete,
}

impl VaultError {
    /// Fixed text only: OS errors may echo account names or service details.
    pub fn message(self) -> &'static str {
        match self {
            VaultError::Unavailable => "CONFIG_VAULT_UNAVAILABLE: хранилище ключей ОС недоступно",
            VaultError::Read => "CONFIG_VAULT_READ: не удалось прочитать хранилище ключей ОС",
            VaultError::Write => "CONFIG_VAULT_WRITE: не удалось сохранить ключ в хранилище ОС",
            VaultError::Delete => {
                "CONFIG_VAULT_DELETE: не удалось удалить собственную запись хранилища ОС"
            }
        }
    }
}

/// The only operations the authority needs from an OS vault. Production uses
/// `KeyringOs`; native tests inject an in-memory implementation with faults.
pub trait SecretOs: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, VaultError>;
    fn set(&self, account: &str, value: &str) -> Result<(), VaultError>;
    /// Missing entries are success: deletion is used only for owned cleanup.
    fn delete(&self, account: &str) -> Result<(), VaultError>;
}

/// Provider namespace: `VAULT_SERVICE` without a profile, otherwise exactly
/// `dev.enki.profile.<SHA256(canonical root)>.pi-credentials` as before.
pub const NAMESPACE: crate::paths::SecretNamespace = crate::paths::SecretNamespace {
    legacy: super::VAULT_SERVICE,
    suffix: "pi-credentials",
};

/// Profile-specific service, identical to the historical provider vault, so an
/// isolated ENKI_PROFILE_DIR never sees the owner's credentials.
pub fn service() -> Result<String, String> {
    NAMESPACE.service()
}

pub struct KeyringOs {
    service: String,
}

impl KeyringOs {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            service: service()?,
        })
    }
    fn entry(&self, account: &str) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new(&self.service, account).map_err(|_| VaultError::Unavailable)
    }
}

impl SecretOs for KeyringOs {
    fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(VaultError::Read),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        self.entry(account)?
            .set_password(value)
            .map_err(|_| VaultError::Write)
    }
    fn delete(&self, account: &str) -> Result<(), VaultError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(VaultError::Delete),
        }
    }
}

/// The production OS vault. On Windows every entry is bounded to
/// `WINDOWS_MAX_UNITS`; larger values (typical OAuth JSON) become OS-protected
/// parts of the same immutable owned account. Never a plaintext sidecar.
pub fn platform_os() -> Result<Arc<dyn SecretOs>, String> {
    let os: Arc<dyn SecretOs> = Arc::new(KeyringOs::new()?);
    #[cfg(windows)]
    let os: Arc<dyn SecretOs> = Arc::new(ChunkedOs::new(os, WINDOWS_MAX_UNITS));
    Ok(os)
}

/// Bounded per-entry storage over an OS vault with a per-entry limit.
///
/// A value within the limit is stored raw at `account` (unchanged format).
/// A larger value is split on char boundaries (a surrogate pair is never
/// split) into parts `account#1..=n`, each within the limit, written FIRST;
/// the manifest `{marker}{n}:{utf16 units}` is written LAST at `account`, so
/// a crash before it leaves the account reading as absent (the authority's
/// intent row then retries or deletes it). `get` verifies exact part count,
/// per-part limit and total length. `delete` removes the manifest, then probes
/// every possible part, so orphans of a crashed or shorter retry are removed.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct ChunkedOs {
    inner: Arc<dyn SecretOs>,
    max_units: usize,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl ChunkedOs {
    pub fn new(inner: Arc<dyn SecretOs>, max_units: usize) -> Self {
        assert!(
            max_units >= 64,
            "OS vault entry limit too small for a manifest"
        );
        Self { inner, max_units }
    }
    fn max_parts(&self) -> usize {
        // UTF-16 units never exceed UTF-8 bytes, so MAX_SECRET bounds both; a
        // closed part holds at least max_units-1 units (a pair never splits).
        MAX_SECRET.div_ceil(self.max_units - 1)
    }
    pub fn part_account(account: &str, index: usize) -> String {
        format!("{account}#{index}")
    }
}

/// Split into parts of at most `max_units` UTF-16 code units, on char boundaries.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn split_units(value: &str, max_units: usize) -> Vec<&str> {
    let (mut parts, mut start, mut units) = (Vec::new(), 0, 0);
    for (at, c) in value.char_indices() {
        if units + c.len_utf16() > max_units {
            parts.push(&value[start..at]);
            (start, units) = (at, 0);
        }
        units += c.len_utf16();
    }
    if start < value.len() {
        parts.push(&value[start..]);
    }
    parts
}

impl SecretOs for ChunkedOs {
    fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        let Some(head) = self.inner.get(account)? else {
            return Ok(None);
        };
        let Some(manifest) = head.strip_prefix(CHUNK_MARKER) else {
            return Ok(Some(head));
        };
        let (count, units) = manifest
            .split_once(':')
            .and_then(|(c, u)| Some((c.parse::<usize>().ok()?, u.parse::<usize>().ok()?)))
            .ok_or(VaultError::Read)?;
        if !(2..=self.max_parts()).contains(&count) {
            return Err(VaultError::Read);
        }
        let mut value = String::new();
        for index in 1..=count {
            let part = self
                .inner
                .get(&Self::part_account(account, index))?
                .ok_or(VaultError::Read)?;
            if part.is_empty() || part.encode_utf16().count() > self.max_units {
                return Err(VaultError::Read);
            }
            value.push_str(&part);
        }
        if value.encode_utf16().count() != units || value.len() > MAX_SECRET {
            return Err(VaultError::Read);
        }
        Ok(Some(value))
    }
    fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        if value.starts_with(CHUNK_MARKER) || value.len() > MAX_SECRET {
            return Err(VaultError::Write);
        }
        let units = value.encode_utf16().count();
        if units <= self.max_units {
            return self.inner.set(account, value);
        }
        let parts = split_units(value, self.max_units);
        for (index, part) in parts.iter().enumerate() {
            self.inner
                .set(&Self::part_account(account, index + 1), part)?;
        }
        self.inner
            .set(account, &format!("{CHUNK_MARKER}{}:{units}", parts.len()))
    }
    fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.inner.delete(account)?;
        for index in 1..=self.max_parts() {
            self.inner.delete(&Self::part_account(account, index))?;
        }
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// HMAC-SHA256 (RFC 2104) over length-prefixed parts, so no two different
/// part lists frame to the same message. With a random 256-bit key kept only
/// in the OS vault, the journaled tag is neither plaintext nor a reversible
/// hash of a low-entropy secret.
pub fn hmac_hex(key: &[u8], parts: &[&[u8]]) -> String {
    let mut block = [0_u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    for part in parts {
        inner.update((part.len() as u64).to_be_bytes());
        inner.update(part);
    }
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    hex(&outer.finalize())
}

/// Constant-time comparison of two fixed-length (hex HMAC) tags.
pub fn tags_equal(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0_u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Fresh random 256-bit key, hex encoded (fits every OS vault entry limit).
pub fn random_key() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Нет источника случайных чисел")?;
    Ok(hex(&bytes))
}

/// Immutable account for one revision of one logical secret owned by one
/// operation. Revisions are never rewritten, so a crash can only leave an
/// unreferenced owned account, never a corrupted referenced one.
pub fn ref_account(logical: &str, owner: &str, revision: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"enki-config-ref-v1\0");
    digest.update(logical.as_bytes());
    digest.update(b"\0");
    digest.update(owner.as_bytes());
    digest.update(b"\0");
    digest.update(revision.to_string().as_bytes());
    format!("{REF_PREFIX}{}", hex(&digest.finalize()))
}

/// Unified identifier contract shared by the planner port, SDK credential
/// store and native authority. Unsupported provider names fail the whole
/// import explicitly instead of being dropped.
pub fn valid_provider(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// Planner logical ids: `pi-import-<sha256(origin, pointer)>`.
pub fn valid_import_id(id: &str) -> bool {
    id.strip_prefix("pi-import-").is_some_and(|rest| {
        rest.len() == 64
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub fn provider_logical(provider: &str) -> String {
    format!("provider:{provider}")
}

pub fn legacy_account(provider: &str) -> String {
    format!("{LEGACY_PREFIX}{provider}")
}

pub fn valid_operation_id(id: &str) -> bool {
    (16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Нет источника случайных чисел")?;
    Ok(hex(&bytes))
}

#[cfg(test)]
mod namespace_tests {
    use super::*;

    /// Provider credentials must keep their exact shipped service names.
    #[test]
    fn provider_service_bytes_are_unchanged_by_the_common_helper() {
        assert_eq!(
            super::super::VAULT_SERVICE,
            "dev.local.opencodedesktop.pi-credentials"
        );
        assert_eq!(
            NAMESPACE.service_for(None),
            "dev.local.opencodedesktop.pi-credentials"
        );
        let root = std::path::Path::new("/fixture/enki-profile-a");
        let historical = format!(
            "dev.enki.profile.{:x}.pi-credentials",
            Sha256::digest(root.to_string_lossy().as_bytes())
        );
        assert_eq!(NAMESPACE.service_for(Some(root)), historical);
        assert_eq!(
            NAMESPACE.service_from(Err("invalid profile".into())),
            Err("invalid profile".to_string())
        );
    }
}
