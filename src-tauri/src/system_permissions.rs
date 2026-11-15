//! macOS privacy prompts and read-only permission status.
//!
//! macOS never lets an application grant itself a TCC permission. What Enki can
//! do is preflight the grants it actually uses, ask for the ones that have an
//! official request API, and link the user straight to the exact Settings pane
//! for the rest. This module is deliberately separate from computer control:
//! a missing permission is reported, never silently treated as granted.
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Command;

const BUNDLE_ID: &str = "dev.local.opencodedesktop";

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SystemPermissionStatus {
    platform: &'static str,
    version: &'static str,
    screen_recording: Option<bool>,
    accessibility: Option<bool>,
    /// The WebView owns the microphone prompt. `None` means "probe on demand".
    microphone: Option<bool>,
    /// Full Disk Access has no official request or preflight API.
    full_disk_access: Option<bool>,
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        // These are CFDictionary callback tables. Their layout belongs to
        // CoreFoundation; only their addresses are passed back to it.
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }

    pub fn screen_access() -> bool {
        // Preflight is read-only and never prompts.
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn request_screen_access() -> bool {
        // The system may require a relaunch after this returns true.
        unsafe { CGRequestScreenCaptureAccess() }
    }

    pub fn accessibility_access() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn request_accessibility_access() -> bool {
        // Passing the prompt option makes macOS open the Accessibility pane;
        // it cannot turn the switch on for the user.
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let dictionary = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
                std::ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
            );
            if dictionary.is_null() {
                return false;
            }
            let trusted = AXIsProcessTrustedWithOptions(dictionary);
            CFRelease(dictionary);
            trusted
        }
    }
}

#[tauri::command]
pub fn system_permissions_status() -> SystemPermissionStatus {
    #[cfg(target_os = "macos")]
    {
        SystemPermissionStatus {
            platform: "macos",
            version: env!("CARGO_PKG_VERSION"),
            screen_recording: Some(macos::screen_access()),
            accessibility: Some(macos::accessibility_access()),
            microphone: None,
            full_disk_access: None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        SystemPermissionStatus {
            platform: std::env::consts::OS,
            version: env!("CARGO_PKG_VERSION"),
            screen_recording: None,
            accessibility: None,
            microphone: None,
            full_disk_access: None,
        }
    }
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Разрешения можно менять только в основном окне Enki".into())
    }
}

#[cfg(target_os = "macos")]
fn reset_tcc(service: &str) -> Result<(), String> {
    let name = match service {
        "screen" => "ScreenCapture",
        "accessibility" => "Accessibility",
        _ => return Err("Неизвестное разрешение".into()),
    };
    let output = Command::new("/usr/bin/tccutil")
        .args(["reset", name, BUNDLE_ID])
        .output()
        .map_err(|error| format!("Не удалось запустить tccutil: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if text.is_empty() {
            "tccutil не смог сбросить старую запись разрешения".into()
        } else {
            format!("tccutil: {text}")
        })
    }
}

/// Ask for a permission. `screen`/`accessibility` have native request APIs;
/// `rebind` first removes only this bundle's stale TCC record, then asks again.
#[tauri::command]
pub fn system_permission_request(
    window: tauri::WebviewWindow,
    service: String,
    rebind: Option<bool>,
) -> Result<Value, String> {
    main_window(&window)?;
    #[cfg(target_os = "macos")]
    {
        let rebind = rebind.unwrap_or(false);
        if rebind {
            reset_tcc(&service)?;
        }
        match service.as_str() {
            "screen" => {
                let granted = macos::request_screen_access();
                Ok(json!({
                    "service": "screen",
                    "granted": granted,
                    "needs_settings": !granted,
                    "needs_restart": granted,
                }))
            }
            "accessibility" => {
                let granted = macos::request_accessibility_access();
                Ok(json!({
                    "service": "accessibility",
                    "granted": granted,
                    "needs_settings": !granted,
                }))
            }
            _ => Err("Для этого разрешения используется системный экран настроек".into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, rebind);
        Err("Системные разрешения macOS доступны только на macOS".into())
    }
}

/// A full process restart is required after granting Screen Recording on
/// recent macOS versions. Keep this a main-window-only, explicit action.
#[tauri::command]
pub fn system_permissions_restart(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    main_window(&window)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_macos_status_does_not_claim_granted_permissions() {
        let status = system_permissions_status();
        if status.platform == "macos" {
            return;
        }
        assert_eq!(status.screen_recording, None);
        assert_eq!(status.accessibility, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_preflight_is_a_boolean_not_a_guess() {
        // Read-only: this test must never open a prompt or change TCC.
        let _ = macos::screen_access();
        let _ = macos::accessibility_access();
    }
}
