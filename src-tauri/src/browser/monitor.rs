//! A trusted pixel-only viewer. Its size is unrelated to Chromium's viewport.
//! No navigation/input, filesystem, credential or agent capability is added.
use serde::Deserialize;
use serde_json::Value;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "browser-monitor";
const EVENT: &str = "browser-monitor://presentation";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Detach,
    Restore,
    Hide,
}

fn authorized(label: &str, action: Action) -> bool {
    label == "main" || (label == LABEL && !matches!(action, Action::Detach))
}

pub fn visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .is_some_and(|window| window.is_visible().unwrap_or(false))
}

fn publish(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
    let scope = super::gateway::health(&super::root_dir()?)
        .ok()
        .map(|(_, health)| health["scope"].clone());
    app.emit_to(
        "main",
        EVENT,
        serde_json::json!({"mode":mode,"scope":scope}),
    )
    .map_err(|e| e.to_string())
}

/// Creating a webview is asynchronous to avoid the WebView2 synchronous-command
/// deadlock on Windows. Reuse one hidden viewer rather than making new browsers.
#[tauri::command]
pub async fn browser_monitor(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, super::BrowserRuntime>,
    action: Action,
    scope_key: Option<String>,
) -> Result<(), String> {
    if !authorized(window.label(), action) {
        return Err("Это окно не может управлять показом браузера.".into());
    }
    let epoch = state
        .projection_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    if let Some(key) = scope_key {
        let (_, health) = super::gateway::health(&super::root_dir()?)?;
        if health["scopeKey"].as_str() != Some(key.as_str()) {
            return Err("Выбран другой чат.".into());
        }
    }
    match action {
        Action::Detach => {
            let monitor = if let Some(existing) = app.get_webview_window(LABEL) {
                existing
            } else {
                let monitor = crate::webview_profile::apply_current(WebviewWindowBuilder::new(
                    &app,
                    LABEL,
                    WebviewUrl::App("index.html?view=browser-monitor".into()),
                ))?
                .title("Браузер · Enki")
                .inner_size(438.0, 334.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .visible(false)
                .focused(false)
                .center()
                .build()
                .map_err(|e| format!("Не удалось открыть окно наблюдения: {e}"))?;
                let handle = app.clone();
                monitor.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if handle
                            .state::<super::BrowserRuntime>()
                            .shutting_down
                            .load(std::sync::atomic::Ordering::Acquire)
                        {
                            return;
                        }
                        // OS close/Alt+F4 means hide, never browser_stop.
                        api.prevent_close();
                        if let Some(viewer) = handle.get_webview_window(LABEL) {
                            if viewer.hide().is_ok() {
                                let _ = publish(&handle, "hidden");
                            }
                        }
                    }
                });
                monitor
            };
            if epoch
                != state
                    .projection_epoch
                    .load(std::sync::atomic::Ordering::Acquire)
            {
                monitor.hide().map_err(|e| e.to_string())?;
                return Err("Выбран другой чат.".into());
            }
            monitor.show().map_err(|e| e.to_string())?;
            publish(&app, "monitor")
        }
        Action::Restore | Action::Hide => {
            let was_visible = visible(&app);
            if let Some(monitor) = app.get_webview_window(LABEL) {
                monitor.hide().map_err(|e| e.to_string())?;
            }
            if matches!(action, Action::Restore) {
                // A regular panel-open path also calls Restore. Only a visible
                // viewer emits/focuses, so this cannot loop its own UI event.
                if was_visible {
                    publish(&app, "panel")?;
                    if let Some(main) = app.get_webview_window("main") {
                        main.show().map_err(|e| e.to_string())?;
                        main.unminimize().map_err(|e| e.to_string())?;
                        main.set_focus().map_err(|e| e.to_string())?;
                    }
                }
            } else if was_visible {
                publish(&app, "hidden")?;
            }
            Ok(())
        }
    }
}

/// The viewer can read pixels, never the authenticated daemon address/key.
/// A hidden viewer stays mounted but cannot capture screenshots in the background.
#[tauri::command]
pub async fn browser_monitor_frame(
    window: tauri::Window,
    page_id: Option<String>,
    state: tauri::State<'_, super::BrowserRuntime>,
) -> Result<Option<Value>, String> {
    if window.label() != LABEL {
        return Err("Наблюдение доступно только в окне браузера.".into());
    }
    if !window.is_visible().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    if page_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("Некорректная страница наблюдения.".into());
    }
    let epoch = state
        .projection_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    let frame = super::blocking(move || {
        let request = serde_json::json!({"pageId": page_id});
        super::gateway::request(
            &super::root_dir()?,
            super::gateway::Endpoint::MonitorView,
            Some(&request),
        )
        .map(Some)
    })
    .await?;
    if epoch
        != state
            .projection_epoch
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(None);
    }
    if let Some(value) = &frame {
        if let Some((width, height)) = projection_size(value) {
            let current = window.inner_size().map_err(|e| e.to_string())?;
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            if (current.width as f64 / scale - width).abs() > 1.0
                || (current.height as f64 / scale - height).abs() > 1.0
            {
                // Resize only our passive projection, never the Chromium viewport.
                window
                    .set_size(tauri::LogicalSize::new(width, height))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(frame)
}

fn projection_size(frame: &Value) -> Option<(f64, f64)> {
    if frame["browserOpen"].as_bool() != Some(true) || frame["image"].as_str()?.is_empty() {
        return None;
    }
    let width = frame["width"].as_f64()?;
    let height = frame["height"].as_f64()?;
    if !width.is_finite()
        || !height.is_finite()
        || !(1.0..=1920.0).contains(&width)
        || !(1.0..=1200.0).contains(&height)
    {
        return None;
    }
    let scale = (420.0 / width).min(300.0 / height);
    // 8px transparent shadow gutter each side, 1px card border, compact chrome.
    let tabs = frame["tabs"]
        .as_array()?
        .iter()
        .filter(|tab| tab["id"].as_str().is_some())
        .count();
    Some((
        (width * scale + 18.0).ceil().max(200.0),
        (height * scale + 18.0 + 32.0 + 24.0 + if tabs > 1 { 34.0 } else { 0.0 }).ceil(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_projection_matches_page_ratio_and_chrome_without_resizing_page() {
        let landscape = serde_json::json!({"browserOpen":true,"image":"jpeg","width":1280,"height":800,"tabs":[]});
        assert_eq!(projection_size(&landscape), Some((438.0, 337.0)));
        let portrait = serde_json::json!({"browserOpen":true,"image":"jpeg","width":748,"height":1024,"tabs":[{"id":"1"},{"id":"2"}]});
        let (w, h) = projection_size(&portrait).unwrap();
        assert!((w - 238.0).abs() < 1.0);
        assert_eq!(h, 408.0);
        assert_eq!(portrait["width"], 748);
        assert_eq!(portrait["height"], 1024);
        assert_eq!(
            projection_size(&serde_json::json!({"browserOpen":false})),
            None
        );
        assert_eq!(
            projection_size(
                &serde_json::json!({"browserOpen":true,"image":"x","width":0,"height":800,"tabs":[]})
            ),
            None
        );
    }
    #[test]
    fn only_main_can_create_the_viewer() {
        assert!(authorized("main", Action::Detach));
        assert!(!authorized(LABEL, Action::Detach));
        assert!(authorized(LABEL, Action::Restore));
        assert!(authorized(LABEL, Action::Hide));
        for action in [Action::Detach, Action::Restore, Action::Hide] {
            assert!(!authorized("untrusted", action));
        }
    }
    #[test]
    fn action_contract_rejects_browser_input_and_resize() {
        for action in ["resize", "click", "scroll", "stop", "navigate", "open"] {
            assert!(serde_json::from_value::<Action>(serde_json::json!(action)).is_err());
        }
        assert!(serde_json::from_value::<Action>(serde_json::json!("restore")).is_ok());
    }
}
