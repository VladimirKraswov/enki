//! Model-control credentials live only in the OS vault; never in preferences.
use std::sync::Mutex;
static ACCESS: Mutex<()> = Mutex::new(());
fn origin(endpoint: &str) -> Result<String, String> {
    let url = url::Url::parse(endpoint).map_err(|_| "Invalid service address")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Only a loopback HTTP service origin is allowed".into());
    }
    Ok(url.origin().ascii_serialization())
}
/// Account is the normalized loopback origin, unchanged from shipped builds.
pub(crate) fn account(endpoint: &str) -> Result<String, String> {
    origin(endpoint)
}
fn access(endpoint: &str, action: &str, value: Option<String>) -> Result<Option<String>, String> {
    let endpoint = account(endpoint)?;
    let service = crate::paths::MODEL_CONTROL_SECRETS.service()?;
    let _guard = ACCESS.lock().map_err(|_| "Credential store lock failed")?;
    let entry = keyring::Entry::new(&service, &endpoint)
        .map_err(|_| "System credential store unavailable")?;
    match action {
        "get" => match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Cannot read system credential store".into()),
        },
        "set" => {
            let value = value
                .filter(|v| !v.trim().is_empty() && v.len() <= 4096)
                .ok_or("A nonempty control key is required")?;
            entry
                .set_password(value.trim())
                .map_err(|_| "Cannot save to system credential store")?;
            Ok(None)
        }
        "delete" => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Cannot remove system credential".into()),
        },
        _ => Err("Unknown credential operation".into()),
    }
}
#[tauri::command]
pub async fn model_service_key(
    window: tauri::WebviewWindow,
    endpoint: String,
    action: String,
    value: Option<String>,
) -> Result<Option<String>, String> {
    // The key is returned to the WebView: only the main window may ask.
    if window.label() != "main" {
        return Err("Main window only".into());
    }
    tauri::async_runtime::spawn_blocking(move || access(&endpoint, &action, value))
        .await
        .map_err(|_| "Credential operation failed")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Opt-in real OS vault write/read/delete with a disposable endpoint"]
    fn native_vault_roundtrip() {
        let endpoint = "http://127.0.0.1:61983";
        let value = format!("test-only-{}", std::process::id());
        access(endpoint, "set", Some(value.clone())).unwrap();
        assert_eq!(access(endpoint, "get", None).unwrap(), Some(value));
        access(endpoint, "delete", None).unwrap();
        assert_eq!(access(endpoint, "get", None).unwrap(), None);
    }
    #[test]
    fn endpoint_policy() {
        assert_eq!(
            origin("http://localhost:18008").unwrap(),
            "http://localhost:18008"
        );
        for endpoint in [
            "https://localhost",
            "http://remote",
            "http://user@localhost",
            "http://localhost/path",
            "http://localhost/?key=secret",
        ] {
            assert!(origin(endpoint).is_err());
        }
    }
}
