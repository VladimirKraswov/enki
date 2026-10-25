//! Narrow UI bridge for Pi extension components. Clipboard and external links
//! need a recent gesture in the focused main window, bound to one exact surface.
//! A remote agent cannot obtain OS access just by knowing a session identifier.
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const GESTURE_LIFETIME: Duration = Duration::from_millis(1500);
const MAX_CLIPBOARD: usize = 512 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiScope {
    host_id: String,
    session_id: String,
    session_epoch: u64,
    surface_id: String,
    directory: String,
    principal: String,
}
impl UiScope {
    fn valid(&self) -> bool {
        fn text(value: &str, max: usize) -> bool {
            !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
        }
        text(&self.host_id, 200)
            && text(&self.session_id, 200)
            && self.session_epoch > 0
            && self.surface_id == "extensions"
            && text(&self.directory, 8192)
            && text(&self.principal, 200)
    }
}
struct Gesture {
    scope: UiScope,
    actions: HashSet<String>,
    expires: Instant,
}
#[derive(Default)]
pub struct UiAuthority(Mutex<Option<Gesture>>);
impl UiAuthority {
    fn authorize(&self, scope: UiScope, actions: Vec<String>, now: Instant) -> Result<(), String> {
        if !scope.valid()
            || actions.is_empty()
            || actions.len() > 3
            || actions.iter().any(|action| {
                !matches!(
                    action.as_str(),
                    "clipboard.read" | "clipboard.write" | "open-url"
                )
            })
        {
            return Err("Некорректное системное действие интерфейса".into());
        }
        *self
            .0
            .lock()
            .map_err(|_| "Состояние интерфейса недоступно")? = Some(Gesture {
            scope,
            actions: actions.into_iter().collect(),
            expires: now + GESTURE_LIFETIME,
        });
        Ok(())
    }
    fn consume(&self, scope: &UiScope, action: &str, now: Instant) -> Result<(), String> {
        let mut current = self
            .0
            .lock()
            .map_err(|_| "Состояние интерфейса недоступно")?;
        let allowed = current.as_mut().is_some_and(|gesture| {
            gesture.expires > now && &gesture.scope == scope && gesture.actions.remove(action)
        });
        if !allowed {
            return Err(
                "Для системного действия нажмите соответствующую команду в активном интерфейсе"
                    .into(),
            );
        }
        Ok(())
    }
}
fn focused(app: &tauri::AppHandle) -> Result<(), String> {
    if app
        .get_webview_window("main")
        .is_some_and(|window| window.is_focused().unwrap_or(false))
    {
        Ok(())
    } else {
        Err("Системное действие доступно только в активном окне Enki".into())
    }
}

#[tauri::command]
pub fn runtime_ui_authorize(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    scope: UiScope,
    actions: Vec<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Действие доступно только главному окну".into());
    }
    crate::updates::ensure_writable()?;
    focused(&app)?;
    app.state::<UiAuthority>()
        .authorize(scope, actions, Instant::now())
}

pub fn relayable(method: &str) -> bool {
    matches!(
        method,
        "ui.clipboard.read" | "ui.clipboard.write" | "ui.open-url"
    )
}
pub fn broker(app: &tauri::AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    crate::updates::ensure_writable()?;
    focused(app)?;
    let scope: UiScope = serde_json::from_value(params["scope"].clone())
        .map_err(|_| "Некорректный контекст интерфейса")?;
    if !scope.valid() {
        return Err("Некорректный контекст интерфейса".into());
    }
    let action = method
        .strip_prefix("ui.")
        .filter(|_| relayable(method))
        .ok_or("Неизвестное системное действие")?;
    app.state::<UiAuthority>()
        .consume(&scope, action, Instant::now())?;
    match method {
        "ui.clipboard.write" => {
            let text = params["text"]
                .as_str()
                .filter(|text| text.len() <= MAX_CLIPBOARD)
                .ok_or("Слишком большой текст для буфера обмена")?;
            app.clipboard()
                .write_text(text)
                .map_err(|_| "Не удалось записать текст в буфер обмена")?;
            Ok(Value::Bool(true))
        }
        "ui.clipboard.read" => {
            let text = app
                .clipboard()
                .read_text()
                .map_err(|_| "Буфер обмена не содержит доступного текста")?;
            if text.len() > MAX_CLIPBOARD {
                return Err("Текст в буфере обмена превышает допустимый размер".into());
            }
            Ok(Value::String(text))
        }
        "ui.open-url" => {
            let raw = params["url"]
                .as_str()
                .filter(|url| url.len() <= 8192)
                .ok_or("Некорректная ссылка")?;
            let url = url::Url::parse(raw).map_err(|_| "Некорректная ссылка")?;
            if !matches!(url.scheme(), "http" | "https" | "mailto") {
                return Err("Этот тип ссылки нельзя открыть из интерфейса расширения".into());
            }
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|_| "Не удалось открыть ссылку")?;
            Ok(Value::Null)
        }
        _ => Err("Неизвестное системное действие".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> UiScope {
        UiScope {
            host_id: "host-1".into(),
            session_id: "session-1".into(),
            session_epoch: 1,
            surface_id: "extensions".into(),
            directory: "/owned/project".into(),
            principal: "opaque-client-1".into(),
        }
    }
    #[test]
    fn gestures_are_exact_scoped_single_use_and_expire() {
        let authority = UiAuthority::default();
        let now = Instant::now();
        authority
            .authorize(scope(), vec!["clipboard.read".into()], now)
            .unwrap();
        let mut foreign = scope();
        foreign.session_epoch = 2;
        assert!(authority.consume(&foreign, "clipboard.read", now).is_err());
        assert!(authority.consume(&scope(), "clipboard.write", now).is_err());
        assert!(authority.consume(&scope(), "clipboard.read", now).is_ok());
        assert!(authority.consume(&scope(), "clipboard.read", now).is_err());
        authority
            .authorize(scope(), vec!["open-url".into()], now)
            .unwrap();
        assert!(authority
            .consume(&scope(), "open-url", now + GESTURE_LIFETIME)
            .is_err());
    }
    #[test]
    fn another_view_replaces_old_gesture_and_unknown_actions_fail_closed() {
        let authority = UiAuthority::default();
        let now = Instant::now();
        authority
            .authorize(scope(), vec!["clipboard.read".into()], now)
            .unwrap();
        let mut other = scope();
        other.host_id = "other-host".into();
        authority
            .authorize(other, vec!["open-url".into()], now)
            .unwrap();
        assert!(authority.consume(&scope(), "clipboard.read", now).is_err());
        assert!(authority
            .authorize(scope(), vec!["vault.get".into()], now)
            .is_err());
        assert!(!relayable("vault.get") && !relayable("capabilities.resolve"));
    }
}
