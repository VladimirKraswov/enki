use super::{
    atomic,
    packet::{self, Envelope, Verified, FINGERPRINT},
    read_json, root,
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    Assets, Runtime,
};
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pointer {
    current: Option<String>,
    previous: Option<String>,
    pending: bool,
    last_error: Option<String>,
}
const LEGACY_CACHE_ERROR: &str =
    "Сохранённое обновление несовместимо или повреждено. Загружен встроенный интерфейс.";
const CACHE_ERROR: &str = "Не удалось проверить сохранённое обновление: оно повреждено или требует другой версии приложения. Enki запущена со встроенным интерфейсом; загрузите обновление заново.";
struct Bundle {
    digest: String,
    version: String,
    files: BTreeMap<String, Vec<u8>>,
}
#[derive(Default)]
struct State {
    pointer: Pointer,
    current: Option<Bundle>,
    previous: Option<Bundle>,
}
#[derive(Clone)]
pub struct HotAssets(Arc<Mutex<State>>, Option<Arc<std::path::PathBuf>>);
impl HotAssets {
    pub fn load() -> Self {
        let location = root();
        let runtime = Self(
            Arc::new(Mutex::new(State::default())),
            location.as_ref().ok().map(|p| Arc::new(p.clone())),
        );
        if let Err(e) = location {
            runtime
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pointer
                .last_error = Some(e);
            return runtime;
        }
        if let Err(e) = runtime.restore() {
            if let Ok(mut s) = runtime.0.lock() {
                s.pointer.last_error = Some(e);
            }
        }
        runtime
    }
    fn cache(&self) -> Result<&std::path::Path, String> {
        self.1
            .as_deref()
            .map(|p| p.as_path())
            .ok_or("Хранилище обновлений недоступно".into())
    }
    fn cached(root: &std::path::Path, digest: &str) -> Result<Option<Bundle>, String> {
        if !packet::hash_ok(digest) {
            return Err("Invalid cached release".into());
        }
        let e: Envelope = read_json(&root.join(format!("{digest}.json")))?;
        if e.payload.len() > packet::MAX * 4 / 3 + 4 || e.signature.len() > 8192 {
            return Err("Cached release exceeds limit".into());
        }
        // Metadata is untrusted until verify checks the signed bytes below.
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&e.payload)
            .map_err(|_| "Invalid cache")?;
        let p: packet::Packet = serde_json::from_slice(&raw).map_err(|_| "Invalid cache")?;
        // Authenticate the original packet before deciding whether a native
        // update has superseded it. A different fingerprint is never executed.
        let v = packet::verify(&e, digest, &p.version, "hot", &p.native_fingerprint)?;
        Self::compatible_cached(digest, v)
    }
    fn compatible_cached(digest: &str, v: Verified) -> Result<Option<Bundle>, String> {
        let version = semver::Version::parse(&v.packet.version).map_err(|e| e.to_string())?;
        let native =
            semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
        if version <= native {
            return Ok(None);
        }
        if v.packet.native_fingerprint != FINGERPRINT {
            return Err("Cached UI requires another native version".into());
        }
        Ok(Some(Bundle {
            digest: digest.into(),
            version: v.packet.version,
            files: v.files,
        }))
    }
    fn restore(&self) -> Result<(), String> {
        let path = self.cache()?.join("active.json");
        if !path.exists() {
            return Ok(());
        }
        let mut p: Pointer = read_json(&path)?;
        // Older versions persisted this generic error after a normal native
        // upgrade. Retire it only when a NEW successful installation of this
        // exact version has replaced the affected embedded interface.
        if p.current.is_none() && !p.pending && p.last_error.as_deref() == Some(LEGACY_CACHE_ERROR)
        {
            let installed =
                read_json::<serde_json::Value>(&self.cache()?.join("last-install.json"));
            if installed.is_ok_and(|v| {
                v["installed"] == true
                    && v["phase"] == "committed"
                    && v["version"] == env!("CARGO_PKG_VERSION")
            }) {
                p.last_error = None;
                atomic(&path, &p)?;
            }
        }
        if p.pending {
            p.current = p.previous.take();
            p.pending = false;
            p.last_error =
                Some("Интерфейс не подтвердил запуск. Восстановлена предыдущая версия.".into());
            atomic(&path, &p)?;
        }
        let current = p
            .current
            .as_deref()
            .map(|d| Self::cached(self.cache()?, d))
            .transpose();
        let mut s = self.0.lock().map_err(|e| e.to_string())?;
        match current {
            Ok(b) => {
                s.current = b.flatten();
                if p.current.is_some() && s.current.is_none() {
                    p.current = None;
                    p.previous = None;
                    p.last_error = None;
                    atomic(&path, &p)?;
                }
            }
            Err(_) => {
                p.current = None;
                p.last_error = Some(CACHE_ERROR.into());
                atomic(&path, &p)?;
            }
        }
        s.previous = p.previous.as_deref().and_then(|d| {
            self.cache()
                .ok()
                .and_then(|root| Self::cached(root, d).ok().flatten())
        });
        s.pointer = p;
        Ok(())
    }
    pub(super) fn retained(&self) -> Vec<String> {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.pointer
            .current
            .iter()
            .chain(s.pointer.previous.iter())
            .cloned()
            .collect()
    }
    pub fn status(&self) -> serde_json::Value {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::json!({"uiVersion":s.current.as_ref().map(|b|b.version.as_str()).unwrap_or(env!("CARGO_PKG_VERSION")),"activeDigest":s.current.as_ref().map(|b|b.digest.as_str()),"pending":s.pointer.pending,"lastError":s.pointer.last_error})
    }
    pub fn activate(&self, digest: &str, v: Verified) -> Result<(), String> {
        if v.packet.native_fingerprint != FINGERPRINT {
            return Err("Требуется сборка нативной части".into());
        }
        let mut s = self.0.lock().map_err(|e| e.to_string())?;
        if s.pointer.pending {
            return Err("Предыдущее обновление ещё запускается".into());
        }
        let current = s
            .current
            .as_ref()
            .map(|b| b.version.as_str())
            .unwrap_or(env!("CARGO_PKG_VERSION"));
        if semver::Version::parse(&v.packet.version).map_err(|e| e.to_string())?
            <= semver::Version::parse(current).map_err(|e| e.to_string())?
        {
            return Err("Обновление должно быть новее установленной версии".into());
        }
        let p = Pointer {
            current: Some(digest.into()),
            previous: s.current.as_ref().map(|b| b.digest.clone()),
            pending: true,
            last_error: None,
        };
        atomic(&self.cache()?.join("active.json"), &p)?;
        s.previous = s.current.take();
        s.current = Some(Bundle {
            digest: digest.into(),
            version: v.packet.version,
            files: v.files,
        });
        s.pointer = p;
        Ok(())
    }
    pub fn ready(&self, digest: Option<&str>) -> Result<(), String> {
        let mut s = self.0.lock().map_err(|e| e.to_string())?;
        if s.pointer.pending && s.pointer.current.as_deref() == digest {
            let mut pointer = s.pointer.clone();
            pointer.pending = false;
            atomic(&self.cache()?.join("active.json"), &pointer)?;
            s.pointer = pointer;
        }
        Ok(())
    }
    pub fn rollback_pending(&self, digest: &str) -> Result<bool, String> {
        let mut s = self.0.lock().map_err(|e| e.to_string())?;
        if !s.pointer.pending || s.pointer.current.as_deref() != Some(digest) {
            return Ok(false);
        }
        let p = Pointer {
            current: s.pointer.previous.clone(),
            previous: None,
            pending: false,
            last_error: Some("Новый интерфейс не запустился. Обновление отменено.".into()),
        };
        atomic(&self.cache()?.join("active.json"), &p)?;
        s.current = s.previous.take();
        s.pointer = p;
        Ok(true)
    }
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        let s = self.0.lock().ok()?;
        let key = key.trim_start_matches('/');
        s.current
            .as_ref()
            .and_then(|b| b.files.get(key))
            .or_else(|| {
                s.current
                    .as_ref()
                    .and_then(|_| s.previous.as_ref())
                    .and_then(|b| b.files.get(key))
            })
            .cloned()
    }
}
pub struct Provider<R: Runtime> {
    pub hot: HotAssets,
    pub embedded: Box<dyn Assets<R>>,
}
impl<R: Runtime> Assets<R> for Provider<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.embedded.setup(app);
    }
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.hot
            .get(key.as_ref())
            .map(Cow::Owned)
            .or_else(|| self.embedded.get(key))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }
    fn csp_hashes(&self, html: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html)
    }
}
pub struct Empty;
impl<R: Runtime> Assets<R> for Empty {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Windows may return the same wall-clock tick to concurrent test threads.
    // Keep create_dir exclusive while assigning every fixture a distinct suffix.
    static FIXTURE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn fixture() -> (HotAssets, std::path::PathBuf) {
        let p = std::env::temp_dir().join(format!(
            "arvela-hot-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            FIXTURE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        (
            HotAssets(
                Arc::new(Mutex::new(State::default())),
                Some(Arc::new(p.clone())),
            ),
            p,
        )
    }
    fn bundle(version: &str, body: &str) -> Verified {
        Verified {
            packet: packet::Packet {
                schema_version: 1,
                kind: "hot".into(),
                version: version.into(),
                native_fingerprint: FINGERPRINT.into(),
                notes: String::new(),
                files: BTreeMap::new(),
            },
            files: BTreeMap::from([("index.html".into(), body.as_bytes().to_vec())]),
        }
    }
    #[test]
    fn unsuccessful_ui_boot_rolls_back_without_stopping_runtime() {
        let (hot, p) = fixture();
        hot.activate(&"a".repeat(64), bundle("99.0.0", "first"))
            .unwrap();
        assert_eq!(hot.get("/index.html").unwrap(), b"first");
        assert_eq!(hot.rollback_pending(&"b".repeat(64)), Ok(false));
        assert_eq!(hot.rollback_pending(&"a".repeat(64)), Ok(true));
        assert!(hot.get("/index.html").is_none());
        assert!(hot.status()["lastError"]
            .as_str()
            .unwrap()
            .contains("не запустился"));
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn acknowledgement_is_exact_and_confirmed_ui_does_not_roll_back() {
        let (hot, p) = fixture();
        let digest = "a".repeat(64);
        hot.activate(&digest, bundle("99.0.0", "one")).unwrap();
        hot.ready(Some(&"b".repeat(64))).unwrap();
        assert_eq!(hot.status()["pending"], true);
        hot.ready(Some(&digest)).unwrap();
        assert_eq!(hot.rollback_pending(&digest), Ok(false));
        assert_eq!(hot.status()["uiVersion"], "99.0.0");
        assert!(hot.activate(&digest, bundle("98.0.0", "old")).is_err());
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn cached_tampering_falls_back_to_embedded_assets() {
        let (hot, p) = fixture();
        let digest = "a".repeat(64);
        atomic(
            &p.join("active.json"),
            &Pointer {
                current: Some(digest.clone()),
                pending: false,
                ..Pointer::default()
            },
        )
        .unwrap();
        std::fs::write(p.join(format!("{digest}.json")), b"malformed").unwrap();
        hot.restore().unwrap();
        assert!(hot.get("/index.html").is_none());
        assert_eq!(hot.status()["uiVersion"], env!("CARGO_PKG_VERSION"));
        assert!(hot.status()["lastError"]
            .as_str()
            .unwrap()
            .contains("повреждено"));
        atomic(&p.join("last-install.json"), &serde_json::json!({"version": env!("CARGO_PKG_VERSION"), "installed": true, "phase": "committed"})).unwrap();
        hot.restore().unwrap();
        assert_eq!(hot.status()["lastError"], CACHE_ERROR);
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn native_upgrade_retires_authenticated_older_ui_without_loading_it() {
        for version in ["0.1.0", env!("CARGO_PKG_VERSION")] {
            let mut v = bundle(version, "obsolete");
            v.packet.native_fingerprint = "b".repeat(64);
            assert!(HotAssets::compatible_cached(&"a".repeat(64), v)
                .unwrap()
                .is_none());
        }
        let mut future = bundle("99.0.0", "wrong native");
        future.packet.native_fingerprint = "b".repeat(64);
        assert!(HotAssets::compatible_cached(&"a".repeat(64), future).is_err());
        let valid = HotAssets::compatible_cached(&"a".repeat(64), bundle("99.0.0", "valid"))
            .unwrap()
            .unwrap();
        assert_eq!(valid.files["index.html"], b"valid");
    }
    #[test]
    fn successful_new_native_install_clears_only_legacy_cache_warning() {
        let (hot, p) = fixture();
        atomic(
            &p.join("active.json"),
            &Pointer {
                last_error: Some(LEGACY_CACHE_ERROR.into()),
                ..Pointer::default()
            },
        )
        .unwrap();
        hot.restore().unwrap();
        assert_eq!(hot.status()["lastError"], LEGACY_CACHE_ERROR);
        atomic(
            &p.join("last-install.json"),
            &serde_json::json!({"version": "0.1.0", "installed": true, "phase": "committed"}),
        )
        .unwrap();
        hot.restore().unwrap();
        assert_eq!(hot.status()["lastError"], LEGACY_CACHE_ERROR);
        atomic(&p.join("last-install.json"), &serde_json::json!({"version": env!("CARGO_PKG_VERSION"), "installed": true, "phase": "committed"})).unwrap();
        hot.restore().unwrap();
        assert!(hot.status()["lastError"].is_null());
        std::fs::remove_dir_all(p).unwrap();
    }
}
