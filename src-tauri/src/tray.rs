//! The window is a view of the runtime. Closing it must not stop agent work.
#[cfg(target_os = "macos")]
#[path = "tray/macos.rs"]
mod macos;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
/// One Quit request at a time. State (low two bits: 0 idle, 1 awaiting the
/// WebView, 2 finishing) and request id share ONE atomic word, so the
/// fallback timer of a request the UI already declined can never finish a
/// LATER request before that request's own answer.
struct QuitGate(AtomicU64);
const AWAITING: u64 = 1;
const FINISHING: u64 = 2;
impl QuitGate {
    const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    /// The id of a new request, or None while one is in progress or finishing.
    fn request(&self) -> Option<u64> {
        let mut word = self.0.load(Ordering::Acquire);
        loop {
            if word & 3 != 0 {
                return None;
            }
            let id = (word >> 2) + 1;
            match self.0.compare_exchange_weak(
                word,
                (id << 2) | AWAITING,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(id),
                Err(actual) => word = actual,
            }
        }
    }
    /// The WebView's answer to the pending request: true = finish now.
    fn reply(&self, ready: bool) -> bool {
        let mut word = self.0.load(Ordering::Acquire);
        loop {
            if word & 3 != AWAITING {
                return false;
            }
            let next = (word & !3) | if ready { FINISHING } else { 0 };
            match self
                .0
                .compare_exchange_weak(word, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return ready,
                Err(actual) => word = actual,
            }
        }
    }
    /// Fallback after the grace period: only the still-unanswered SAME request.
    fn expire(&self, id: u64) -> bool {
        self.0
            .compare_exchange(
                (id << 2) | AWAITING,
                (id << 2) | FINISHING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
}
static QUIT: QuitGate = QuitGate::new();
static MONITOR_HIDDEN: AtomicBool = AtomicBool::new(false);
static AVAILABLE: AtomicBool = AtomicBool::new(false);
pub fn show(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    macos::show(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if MONITOR_HIDDEN.swap(false, Ordering::AcqRel) {
            if let Some(m) = app.get_webview_window(crate::browser::monitor::LABEL) {
                let _ = m.show();
            }
        }
    }
}
pub fn close(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if AVAILABLE.load(Ordering::Acquire) {
            // Hiding only an NSWindow in a fullscreen Space can leave the user
            // on an empty black Space. Let AppKit hide the whole application;
            // it switches Spaces and preserves all windows and running agents.
            #[cfg(target_os = "macos")]
            {
                if let Err(error) = macos::hide(app) {
                    eprintln!("Cannot hide Enki: {error}");
                    let _ = w.minimize();
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = w.hide();
                if let Some(m) = app.get_webview_window(crate::browser::monitor::LABEL) {
                    if m.is_visible().unwrap_or(false) {
                        MONITOR_HIDDEN.store(true, Ordering::Release);
                        let _ = m.hide();
                    }
                }
            }
        } else {
            let _ = w.minimize();
        } // A desktop without a tray must remain reachable.
    }
}
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть Enki", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "updates", "Обновления…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Завершить Enki", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &updates, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("arvela-runtime")
        .tooltip("Enki")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app),
            "updates" => {
                show(app);
                let _ = app.emit_to("main", "arvela-open-updates", ());
            }
            "quit" => quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    AVAILABLE.store(true, Ordering::Release);
    Ok(())
}

fn finish(app: &tauri::AppHandle) {
    if !crate::lifecycle::request_exit(app) {
        app.exit(0);
    }
}
fn quit(app: &tauri::AppHandle) {
    let Some(id) = QUIT.request() else {
        return;
    };
    let _ = app.emit_to("main", "arvela-before-quit", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if QUIT.expire(id) {
            finish(&app);
        }
    });
}
#[tauri::command]
pub fn runtime_quit_ready(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    ready: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main window only".into());
    }
    if QUIT.reply(ready) {
        finish(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::QuitGate;

    #[test]
    fn a_declined_quit_timer_never_finishes_a_later_request() {
        let gate = QuitGate::new();
        let first = gate.request().expect("first request");
        assert!(gate.request().is_none(), "one request at a time");
        // The WebView could not save its state: the quit is cancelled.
        assert!(!gate.reply(false));
        let second = gate.request().expect("a new quit after the refusal");
        assert_ne!(first, second);
        // The first request's grace timer fires during the second one.
        assert!(!gate.expire(first), "stale timer must not finish");
        // The second one is still waiting for its own answer.
        assert!(gate.reply(true));
        assert!(!gate.expire(second), "already finishing");
        assert!(!gate.reply(true), "no duplicate finish");
    }

    #[test]
    fn an_unanswered_request_finishes_exactly_once_at_its_own_deadline() {
        let gate = QuitGate::new();
        let id = gate.request().unwrap();
        assert!(gate.expire(id));
        assert!(!gate.expire(id));
        assert!(!gate.reply(true), "a late answer is ignored");
        assert!(gate.request().is_none(), "finishing is terminal");
    }
}
