//! Explicit builder settings: Tauri's WindowConfig conversion currently omits
//! data_directory and data_store_identifier. A test profile must never silently
//! fall back to the owner's WebKit store.
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{utils::config::WindowConfig, Manager, Runtime, WebviewWindowBuilder};

pub(crate) struct WebviewProfile {
    root: PathBuf,
    identifier: [u8; 16],
}

impl WebviewProfile {
    pub(crate) fn new(root: PathBuf) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        require_custom_webkit_store()?;
        let hash = Sha256::digest(root.to_string_lossy().as_bytes());
        let mut identifier = [0; 16];
        identifier.copy_from_slice(&hash[..16]);
        Ok(Self { root, identifier })
    }

    pub(crate) fn apply<'a, R: Runtime, M: Manager<R>>(
        &self,
        builder: WebviewWindowBuilder<'a, R, M>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        builder
            .data_directory(self.root.join("webview"))
            .data_store_identifier(self.identifier)
    }

    /// Create configured windows ourselves, applying storage directly to each
    /// builder before it can load JavaScript. Preserve intentionally deferred ones.
    pub(crate) fn defer_windows(windows: &mut [WindowConfig]) -> Vec<WindowConfig> {
        windows
            .iter_mut()
            .filter_map(|window| {
                if !window.create {
                    return None;
                }
                let original = window.clone();
                window.create = false;
                Some(original)
            })
            .collect()
    }
}

pub(crate) fn apply_current<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> Result<WebviewWindowBuilder<'a, R, M>, String> {
    match crate::paths::profile_override()? {
        Some(root) => Ok(WebviewProfile::new(root)?.apply(builder)),
        None => Ok(builder),
    }
}

#[cfg(target_os = "macos")]
fn require_custom_webkit_store() -> Result<(), String> {
    let mut value = [0u8; 128];
    let mut length = value.len();
    // Read one bounded, public OS-version sysctl. Older WebKit would otherwise
    // silently use defaultDataStore even with an explicit identifier.
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            value.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    let version = (result == 0 && length <= value.len())
        .then(|| std::ffi::CStr::from_bytes_until_nul(&value[..length]).ok())
        .flatten()
        .and_then(|version| version.to_str().ok());
    if version.is_some_and(custom_store_supported) {
        Ok(())
    } else {
        Err("Отдельный тестовый профиль Enki требует macOS 14 или новее; рабочий профиль не открыт.".into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn custom_store_supported(version: &str) -> bool {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 14)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_windows_are_deferred_without_losing_settings() {
        let main = WindowConfig {
            title: "Profile fixture".into(),
            ..Default::default()
        };
        let deferred = WindowConfig {
            label: "later".into(),
            create: false,
            ..Default::default()
        };
        let mut windows = vec![main.clone(), deferred];
        let captured = WebviewProfile::defer_windows(&mut windows);
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].title, main.title);
        assert_eq!(captured[0].label, main.label);
        assert!(captured[0].create);
        assert!(windows.iter().all(|window| !window.create));
        assert!(WebviewProfile::defer_windows(&mut windows).is_empty());
    }

    #[test]
    fn unsupported_webkit_cannot_fall_back_to_the_owner_store() {
        for version in ["", "unknown", "13.6.9"] {
            assert!(!custom_store_supported(version));
        }
        for version in ["14", "15.7", "26.0.1"] {
            assert!(custom_store_supported(version));
        }
    }
}
