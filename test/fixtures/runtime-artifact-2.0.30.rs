//! Schema-1 artifact verification. The signed/private artifact tree must remain
//! immutable throughout verification and execution. These portable path/handle
//! checks are not an openat2 sandbox against a hostile concurrent root owner.
//! No persistent marker can substitute for verifying the bytes on activation.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

const MANIFEST: &str = "runtime-manifest.json";
const METADATA_LIMIT: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 200_000;

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    #[serde(deserialize_with = "javascript_safe_integer")]
    pub schema: u64,
    pub version: String,
    #[serde(deserialize_with = "javascript_safe_integer")]
    pub contract: u64,
    pub node: String,
    pub entry: String,
    pub files: BTreeMap<String, String>,
}

fn javascript_safe_integer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<u64, D::Error> {
    let number = serde_json::Number::deserialize(deserializer)?;
    let value = number
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("integer required"))?;
    if value.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0
    {
        Ok(value as u64)
    } else {
        Err(serde::de::Error::custom("safe integer required"))
    }
}

#[derive(Default)]
pub struct Expected<'a> {
    pub version: Option<&'a str>,
    pub contract: Option<u64>,
    pub node: Option<&'a str>,
    pub entry: Option<&'a str>,
    pub manifest_sha256: Option<&'a str>,
}

#[derive(Debug)]
pub struct VerifiedArtifact {
    pub root: PathBuf,
    pub node: PathBuf,
    pub entry: PathBuf,
    pub manifest: Manifest,
    pub manifest_sha256: String,
}

fn problem(message: impl Into<String>) -> String {
    message.into()
}

pub fn safe_relative(relative: &str) -> bool {
    // JS length counts UTF-16 code units; keep the paired verifier identical.
    if relative.is_empty()
        || relative.encode_utf16().count() > 4096
        || relative
            .chars()
            .any(|c| c <= '\u{1f}' || c == '\u{7f}' || "<>:\"\\|?*".contains(c))
    {
        return false;
    }
    relative.split('/').all(|part| {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.len() > 255
        {
            return false;
        }
        let stem = part
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) {
            return false;
        }
        for prefix in ["COM", "LPT"] {
            if stem.strip_prefix(prefix).is_some_and(|suffix| {
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&suffix)
            }) {
                return false;
            }
        }
        true
    })
}

fn collision_key(relative: &str) -> String {
    relative.nfc().collect::<String>().to_lowercase()
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_digest(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 128
        && version.as_bytes()[0].is_ascii_alphanumeric()
        && !version.ends_with('.')
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn linked(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // All reparse points, including junctions, refuse.
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Check every absolute ancestor before opening content. Never canonicalize an
/// untrusted artifact path: doing so would erase evidence of an ancestor link.
fn checked_metadata(full: &Path, directory: bool) -> Result<Metadata, String> {
    if !full.is_absolute()
        || full
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(problem("artifact path must be absolute and normalized"));
    }
    let mut ancestors: Vec<_> = full.ancestors().collect();
    ancestors.reverse();
    for at in ancestors {
        let meta = fs::symlink_metadata(at).map_err(|_| problem("artifact path is unavailable"))?;
        if linked(&meta) || (at != full && !meta.is_dir()) {
            return Err(problem("artifact contains a link or invalid ancestor"));
        }
        if at == full {
            return if (directory && meta.is_dir()) || (!directory && meta.is_file()) {
                Ok(meta)
            } else {
                Err(problem("artifact path has the wrong file type"))
            };
        }
    }
    Err(problem("artifact path is unavailable"))
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // The opened handle denies write/delete sharing. See the immutability
        // precondition: std's by-handle file-index API is still nightly-only.
        a.file_attributes() == b.file_attributes()
            && a.file_size() == b.file_size()
            && a.creation_time() == b.creation_time()
            && a.last_write_time() == b.last_write_time()
    }
    #[cfg(not(any(unix, windows)))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}

fn stable(a: &Metadata, b: &Metadata) -> bool {
    if !same_file(a, b) || a.len() != b.len() || a.modified().ok() != b.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.ctime() != b.ctime() || a.ctime_nsec() != b.ctime_nsec() {
            return false;
        }
    }
    true
}

fn open_regular(full: &Path) -> Result<File, String> {
    let before = checked_metadata(full, false)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(0x00000001);
    }
    let file = options
        .open(full)
        .map_err(|_| problem("artifact file cannot be opened"))?;
    let opened = file
        .metadata()
        .map_err(|_| problem("artifact handle is unavailable"))?;
    let after = checked_metadata(full, false)?;
    if !opened.is_file()
        || linked(&opened)
        || !same_file(&before, &opened)
        || !same_file(&after, &opened)
    {
        return Err(problem("artifact file changed during open"));
    }
    Ok(file)
}

fn read_manifest(full: &Path) -> Result<Vec<u8>, String> {
    let mut file = open_regular(full)?;
    let before = file
        .metadata()
        .map_err(|_| problem("manifest handle is unavailable"))?;
    if before.len() > METADATA_LIMIT {
        return Err(problem("artifact manifest exceeds size limit"));
    }
    let mut raw = Vec::with_capacity(before.len() as usize);
    Read::by_ref(&mut file)
        .take(METADATA_LIMIT + 1)
        .read_to_end(&mut raw)
        .map_err(|_| problem("manifest cannot be read"))?;
    let after = file
        .metadata()
        .map_err(|_| problem("manifest handle is unavailable"))?;
    if raw.len() as u64 != before.len() || !stable(&before, &after) {
        return Err(problem("artifact manifest changed during read"));
    }
    Ok(raw)
}

fn hash_file(full: &Path) -> Result<String, String> {
    let mut file = open_regular(full)?;
    let before = file
        .metadata()
        .map_err(|_| problem("artifact handle is unavailable"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| problem("artifact file cannot be read"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|_| problem("artifact handle is unavailable"))?;
    if !stable(&before, &after) {
        return Err(problem("artifact file changed during hashing"));
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn validate_shape(manifest: &Manifest) -> Result<(), String> {
    if manifest.schema != 1
        || !valid_version(&manifest.version)
        || manifest.contract == 0
        || manifest.contract > 9_007_199_254_740_991
    {
        return Err(problem("unsupported artifact identity"));
    }
    if !safe_relative(&manifest.node)
        || !safe_relative(&manifest.entry)
        || manifest.node == manifest.entry
    {
        return Err(problem("invalid interpreter or entry point"));
    }
    if manifest.files.is_empty()
        || manifest.files.len() > MAX_FILES
        || !manifest.files.contains_key(&manifest.node)
        || !manifest.files.contains_key(&manifest.entry)
    {
        return Err(problem(
            "manifest does not cover interpreter and entry point",
        ));
    }
    let mut canonical = BTreeSet::new();
    for (relative, hash) in &manifest.files {
        if !safe_relative(relative)
            || relative == MANIFEST
            || !valid_digest(hash)
            || !canonical.insert(collision_key(relative))
        {
            return Err(problem("invalid or colliding artifact inventory"));
        }
    }
    Ok(())
}

fn inventory(root: &Path) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    checked_metadata(root, true)?;
    let mut files = BTreeSet::new();
    let mut directories = BTreeSet::new();
    let mut canonical = BTreeSet::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for item in
            fs::read_dir(&directory).map_err(|_| problem("artifact inventory unavailable"))?
        {
            let item = item.map_err(|_| problem("artifact inventory unavailable"))?;
            let full = item.path();
            let relative = full
                .strip_prefix(root)
                .map_err(|_| problem("artifact path escaped root"))?
                .components()
                .map(|c| {
                    c.as_os_str()
                        .to_str()
                        .ok_or_else(|| problem("artifact path is not UTF-8"))
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            if !safe_relative(&relative) || !canonical.insert(collision_key(&relative)) {
                return Err(problem("unsafe or colliding artifact path"));
            }
            let meta = fs::symlink_metadata(&full)
                .map_err(|_| problem("artifact entry is unavailable"))?;
            if linked(&meta) {
                return Err(problem(
                    "artifact contains a symbolic link or reparse point",
                ));
            }
            if meta.is_dir() {
                directories.insert(relative);
                pending.push(full);
            } else if meta.is_file() {
                files.insert(relative);
            } else {
                return Err(problem("artifact contains a special file"));
            }
        }
    }
    Ok((files, directories))
}

pub fn verify(root: &Path, expected: Expected<'_>) -> Result<VerifiedArtifact, String> {
    checked_metadata(root, true)?;
    let raw = read_manifest(&root.join(MANIFEST))?;
    let manifest_sha256 = digest(&raw);
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|_| problem("artifact manifest has invalid fields"))?;
    validate_shape(&manifest)?;
    if expected.version.is_some_and(|v| v != manifest.version)
        || expected.contract.is_some_and(|v| v != manifest.contract)
        || expected.node.is_some_and(|v| v != manifest.node)
        || expected.entry.is_some_and(|v| v != manifest.entry)
        || expected
            .manifest_sha256
            .is_some_and(|v| v != manifest_sha256)
    {
        return Err(problem(
            "artifact identity does not match trusted expectation",
        ));
    }
    // Complete structure/link/inventory checks precede EVERY payload read.
    let (mut files, directories) = inventory(root)?;
    files.remove(MANIFEST);
    let listed: BTreeSet<_> = manifest.files.keys().cloned().collect();
    if files != listed {
        return Err(problem("artifact inventory differs from manifest"));
    }
    let mut allowed_directories = BTreeSet::new();
    for relative in &listed {
        let mut at = relative.as_str();
        while let Some((parent, _)) = at.rsplit_once('/') {
            allowed_directories.insert(parent.to_string());
            at = parent;
        }
    }
    if directories != allowed_directories {
        return Err(problem("artifact contains an unlisted directory"));
    }
    for (relative, expected_hash) in &manifest.files {
        if hash_file(&root.join(relative))? != *expected_hash {
            return Err(format!("artifact file hash mismatch: {relative}"));
        }
    }
    // Detect metadata mutation as well as payload mutation between phases.
    if read_manifest(&root.join(MANIFEST))? != raw {
        return Err(problem("artifact manifest changed during verification"));
    }
    Ok(VerifiedArtifact {
        root: root.to_path_buf(),
        node: root.join(&manifest.node),
        entry: root.join(&manifest.entry),
        manifest,
        manifest_sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let base = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("enki-artifact-{}-{stamp}", std::process::id()));
            fs::create_dir(&base).unwrap();
            let root = base.join("artifact");
            fs::create_dir_all(root.join("node/bin")).unwrap();
            fs::create_dir_all(root.join("app/dist")).unwrap();
            fs::write(root.join("node/bin/node"), b"not-executed-node-fixture").unwrap();
            fs::write(root.join("app/dist/main.js"), b"not-executed-entry-fixture").unwrap();
            let fixture = Self(base);
            fixture.save(&json!({"schema":1,"version":"0.85.1-0.3.0","contract":1,"node":"node/bin/node","entry":"app/dist/main.js","files":{"node/bin/node":digest(b"not-executed-node-fixture"),"app/dist/main.js":digest(b"not-executed-entry-fixture")}}));
            fixture
        }
        fn root(&self) -> PathBuf {
            self.0.join("artifact")
        }
        fn manifest(&self) -> Value {
            serde_json::from_slice(&fs::read(self.root().join(MANIFEST)).unwrap()).unwrap()
        }
        fn save(&self, value: &Value) {
            fs::write(
                self.root().join(MANIFEST),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap();
        }
        fn verify(&self) -> Result<VerifiedArtifact, String> {
            verify(
                &self.root(),
                Expected {
                    contract: Some(1),
                    node: Some("node/bin/node"),
                    entry: Some("app/dist/main.js"),
                    ..Expected::default()
                },
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_exact_covered_artifact_without_executing_any_file() {
        let fixture = Fixture::new();
        let result = fixture.verify().unwrap();
        assert_eq!(result.manifest.files.len(), 2);
        assert_eq!(result.manifest_sha256.len(), 64);
    }

    #[test]
    fn rejects_windows_aliases_on_every_host() {
        for path in [
            "",
            "/absolute",
            "../x",
            "a/../b",
            "C:/outside",
            "c:outside",
            "a\\b",
            "a//b",
            "a/./b",
            "a\0b",
            "a\u{1f}b",
            "a\u{7f}b",
            "a?b",
            "x:y",
            "a|b",
            "a ",
            "a.",
            "a/CON",
            "a/nul.txt",
            "COM¹.json",
            "Lpt³.txt",
            "conout$.x",
            "aux .txt",
        ] {
            assert!(!safe_relative(path), "{path:?}");
        }
        for path in [
            "node/bin/node",
            "app/node_modules/@scope/lib/file.js",
            ".hidden/file",
            "foo..bar",
            "COM0.txt",
            "COM10.txt",
            "тест/карта.png",
        ] {
            assert!(safe_relative(path), "{path}");
        }
        assert!(!safe_relative(&format!("a/{}", "x".repeat(256))));
        assert!(!safe_relative(&format!("a/{}", "ё".repeat(128))));
    }

    #[test]
    fn exact_shape_and_safe_identity_are_required() {
        let fixture = Fixture::new();
        let original = fixture.manifest();
        for mutation in [
            json!({"unknown":true}),
            json!({"version":".."}),
            json!({"version":"a."}),
            json!({"contract":0}),
            json!({"contract":1.5}),
            json!({"schema":2}),
            json!({"files":[]}),
            json!({"files":{}}),
            json!({"node":"C:/x"}),
            json!({"entry":"node/bin/node"}),
        ] {
            let mut value = original.clone();
            for (key, part) in mutation.as_object().unwrap() {
                value[key] = part.clone();
            }
            fixture.save(&value);
            assert!(fixture.verify().is_err(), "{mutation}");
        }
        for key in ["schema", "version", "contract", "node", "entry", "files"] {
            let mut value = original.clone();
            value.as_object_mut().unwrap().remove(key);
            fixture.save(&value);
            assert!(fixture.verify().is_err(), "missing {key}");
        }
    }

    #[test]
    fn validates_every_listed_path_before_reading_payload() {
        let fixture = Fixture::new();
        let mut value = fixture.manifest();
        value["files"]["C:/outside"] = json!("0".repeat(64));
        fixture.save(&value);
        assert!(fixture.verify().unwrap_err().contains("inventory"));
    }

    #[test]
    fn detects_payload_tamper_even_after_a_prior_success() {
        let fixture = Fixture::new();
        fixture.verify().unwrap();
        fs::write(fixture.root().join("node/bin/node"), b"replacement").unwrap();
        assert!(fixture.verify().unwrap_err().contains("hash mismatch"));
    }

    #[test]
    fn rejects_unlisted_files_missing_files_and_empty_directories() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("README.md"), b"unlisted").unwrap();
        assert!(fixture.verify().unwrap_err().contains("inventory"));
        fs::remove_file(fixture.root().join("README.md")).unwrap();
        fs::create_dir(fixture.root().join("empty")).unwrap();
        assert!(fixture.verify().unwrap_err().contains("directory"));
        fs::remove_dir(fixture.root().join("empty")).unwrap();
        fs::remove_file(fixture.root().join("app/dist/main.js")).unwrap();
        assert!(fixture.verify().unwrap_err().contains("inventory"));
    }

    #[test]
    fn trusted_expected_version_contract_paths_and_manifest_hash_are_bound() {
        let fixture = Fixture::new();
        for expected in [
            Expected {
                version: Some("wrong"),
                ..Expected::default()
            },
            Expected {
                contract: Some(2),
                ..Expected::default()
            },
            Expected {
                node: Some("app/dist/main.js"),
                ..Expected::default()
            },
            Expected {
                entry: Some("wrong"),
                ..Expected::default()
            },
            Expected {
                manifest_sha256: Some(&"0".repeat(64)),
                ..Expected::default()
            },
        ] {
            assert!(verify(&fixture.root(), expected)
                .unwrap_err()
                .contains("expectation"));
        }
    }

    #[test]
    fn nfc_and_unicode_case_collisions_are_not_distinct_identities() {
        let fixture = Fixture::new();
        for (one, two) in [
            ("é.txt", "e\u{301}.txt"),
            ("Ä.txt", "ä.txt"),
            ("FILE", "file"),
        ] {
            let mut value = fixture.manifest();
            value["files"][one] = json!(digest(b"x"));
            value["files"][two] = json!(digest(b"x"));
            fixture.save(&value);
            assert!(fixture.verify().unwrap_err().contains("colliding"));
            value["files"].as_object_mut().unwrap().remove(one);
            value["files"].as_object_mut().unwrap().remove(two);
            fixture.save(&value);
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_manifest_leaf_and_any_ancestor_symlink_before_payload_reads() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let root = fixture.root();
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("node"), b"not-readable-external-fixture").unwrap();
        fs::remove_file(root.join("node/bin/node")).unwrap();
        fs::remove_dir(root.join("node/bin")).unwrap();
        symlink(&outside, root.join("node/bin")).unwrap();
        assert!(fixture.verify().unwrap_err().contains("link"));
        fs::remove_file(root.join("node/bin")).unwrap();
        fs::create_dir(root.join("node/bin")).unwrap();
        fs::write(root.join("node/bin/node"), b"not-executed-node-fixture").unwrap();
        let real_manifest = fixture.0.join("actual-manifest.json");
        fs::rename(root.join(MANIFEST), &real_manifest).unwrap();
        symlink(&real_manifest, root.join(MANIFEST)).unwrap();
        assert!(fixture.verify().unwrap_err().contains("link"));
        fs::remove_file(root.join(MANIFEST)).unwrap();
        fs::rename(real_manifest, root.join(MANIFEST)).unwrap();
        let alias = fixture.0.join("alias");
        symlink(&root, &alias).unwrap();
        assert!(verify(&alias, Expected::default())
            .unwrap_err()
            .contains("link"));
        let alias_parent = alias.join("node");
        assert!(checked_metadata(&alias_parent, true)
            .unwrap_err()
            .contains("link"));
    }

    #[cfg(unix)]
    #[test]
    fn inventory_rejects_fifo_without_opening_or_blocking_on_it() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let fixture = Fixture::new();
        let fifo = CString::new(fixture.root().join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(fixture.verify().unwrap_err().contains("special file"));
    }
}
