//! Scoped HTTPS client; device secrets never cross the WebView boundary on read.
pub mod device_publish;
mod errors;
mod outbox;
pub mod retrieval;
use outbox::{strip_text, upload_batch};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
static IO: Mutex<()> = Mutex::new(());
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub endpoint: String,
    pub certificate: String,
    pub enabled: bool,
    pub share_text: bool,
    pub label: String,
    #[serde(default)]
    pub installed: BTreeMap<String, String>,
}
fn root() -> Result<PathBuf, String> {
    Ok(crate::capabilities::root()?.join("hub"))
}
fn safe_dir(p: &Path) -> Result<(), String> {
    if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Hub path is a symlink".into());
    }
    fs::create_dir_all(p).map_err(|_| "Cannot create Hub directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect Hub directory")?;
    }
    Ok(())
}
fn read(p: &Path) -> Result<String, String> {
    if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Hub file is a symlink".into());
    }
    if !p.exists() {
        return Ok(String::new());
    }
    if fs::metadata(p)
        .map_err(|_| "Cannot inspect Hub file")?
        .len()
        > 24 * 1024 * 1024
    {
        return Err("Hub file is too large".into());
    }
    fs::read_to_string(p).map_err(|_| "Cannot read Hub file".into())
}
fn write(p: &Path, value: &str) -> Result<(), String> {
    safe_dir(p.parent().ok_or("Missing Hub parent")?)?;
    if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Hub file is a symlink".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Invalid clock")?
        .as_nanos();
    let tmp = p.with_file_name(format!(".hub-{}-{stamp}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|_| "Cannot create Hub temporary file")?;
    use std::io::Write;
    if file
        .write_all(value.as_bytes())
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&tmp);
        return Err("Cannot write Hub file".into());
    }
    drop(file);
    fs::rename(tmp, p).map_err(|_| "Cannot replace Hub file".into())
}
fn load() -> Result<Config, String> {
    let s = read(&root()?.join("connection.json"))?;
    if s.is_empty() {
        Ok(Config::default())
    } else {
        serde_json::from_str(&s).map_err(|_| "Invalid Hub configuration".into())
    }
}
pub(crate) fn workshop_endpoint() -> Option<String> {
    load()
        .ok()
        .filter(|c| origin(&c.endpoint).is_ok())
        .map(|c| c.endpoint)
}
// Updates share the configured origin, certificate and device credential, but
// work even when telemetry sharing is disabled. Credentials stay native.
pub(crate) fn release_identity() -> Result<String, String> {
    let c = load()?;
    origin(&c.endpoint)?;
    let token = vault(&c.endpoint)?
        .get_password()
        .map_err(|_| "Настройте ключ Hub в разделе «Общая библиотека»")?;
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{}\0{}\0{}", c.endpoint, c.certificate, token))
    ))
}
pub(crate) fn release_get(path: &str, identity: &str) -> Result<Value, String> {
    if !matches!(path, "stable" | "preview")
        && !path.strip_prefix("artifacts/").is_some_and(hash_ok)
    {
        return Err("Invalid release path".into());
    }
    let c = load()?;
    let key = vault(&c.endpoint)?
        .get_password()
        .map_err(|_| "Нет ключа Hub")?;
    origin(&c.endpoint)?;
    if format!(
        "{:x}",
        Sha256::digest(format!("{}\0{}\0{}", c.endpoint, c.certificate, key))
    ) != identity
    {
        return Err("Подключение Hub изменилось. Проверьте обновления заново.".into());
    }
    let route = if matches!(path, "stable" | "preview") {
        format!("enki/{path}")
    } else {
        path.to_owned()
    };
    let response = client(&c)?
        .get(format!(
            "{}/api/updates/{route}",
            c.endpoint.trim_end_matches('/')
        ))
        .timeout(Duration::from_secs(120))
        .bearer_auth(key)
        .send()
        .map_err(|_| "Не удалось подключиться к Hub обновлений")?;
    if !response.status().is_success() {
        return Err(format!(
            "Hub обновлений: HTTP {}",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Загрузка обновления прервана")?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Release exceeds 64 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Некорректный ответ сервера обновлений".into())
}
fn origin(value: &str) -> Result<String, String> {
    let u = url::Url::parse(value.trim()).map_err(|_| "Нужен HTTPS-адрес библиотеки")?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("Нужен HTTPS origin без пути, ключа или пароля".into());
    }
    Ok(u.origin().ascii_serialization())
}
/// Hub device key account: the exact endpoint origin, as shipped.
pub(crate) fn device_account(endpoint: &str) -> String {
    endpoint.to_string()
}
/// Cached model-admin key account, in the same profile Hub service.
pub(crate) fn admin_account(endpoint: &str) -> String {
    format!("{endpoint}#model-admin")
}
fn vault(endpoint: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        &crate::paths::HUB_SECRETS.service()?,
        &device_account(endpoint),
    )
    .map_err(|_| "System credential store unavailable".into())
}
fn validate(c: &Config) -> Result<(), String> {
    if c.endpoint.is_empty() && !c.enabled {
        return Ok(());
    }
    origin(&c.endpoint)?;
    if c.certificate.len() > 16384 || c.label.len() > 80 || c.installed.len() > 32 {
        return Err("Hub configuration is too large".into());
    }
    if !c.certificate.is_empty() {
        reqwest::Certificate::from_pem(c.certificate.as_bytes())
            .map_err(|_| "Invalid Hub public certificate")?;
    }
    for (id, rev) in &c.installed {
        if !id_ok(id) || !hash_ok(rev) {
            return Err("Invalid package identity".into());
        }
    }
    Ok(())
}
fn client(c: &Config) -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    if !c.certificate.is_empty() {
        b = b.add_root_certificate(
            reqwest::Certificate::from_pem(c.certificate.as_bytes())
                .map_err(|_| "Invalid public certificate")?,
        );
    }
    b.build()
        .map_err(|_| "Cannot create Hub HTTPS client".into())
}
fn model_control_path(path: &str, body: Option<&Value>) -> bool {
    if path == "model-services/catalog" {
        return body.is_none();
    }
    let Some(value) = body.and_then(Value::as_object) else {
        return false;
    };
    let text = |key: &str, max: usize| {
        value.get(key).and_then(Value::as_str).is_some_and(|s| {
            !s.is_empty()
                && s.len() <= max
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        })
    };
    match path {
        "model-services/status" | "model-services/release" => {
            value.len() == 1 && text("ticket", 36)
        }
        "model-services/inspect" | "model-services/prepare" => {
            let prepare = path.ends_with("prepare");
            value.len() == (if prepare { 5 } else { 3 })
                && text("providerID", 64)
                && text("modelID", 128)
                && value
                    .get("agent")
                    .and_then(Value::as_str)
                    .is_some_and(|a| a == "opencode" || a == "pi")
                && (!prepare
                    || (text("requestKey", 128)
                        && value
                            .get("mode")
                            .and_then(Value::as_str)
                            .is_some_and(|m| m == "run" || m == "select")))
        }
        _ => false,
    }
}
fn request(c: &Config, path: &str, body: Option<Value>) -> Result<Value, String> {
    origin(&c.endpoint)?;
    let allowed = path == "me"
        || path == "catalog"
        || path == "devices"
        || path.starts_with("catalog/")
        || path.starts_with("metrics?")
        || path == "ingest"
        || memory_path(path)
        || path == "memory/retrieve";
    let model_control = model_control_path(path, body.as_ref());
    if !(allowed || model_control)
        || path.contains(['#', '\\', '\r', '\n'])
        || path.contains("..")
        || path.len() > 512
    {
        return Err("Unsupported Hub API path".into());
    }
    if body.is_some()
        && !model_control
        && path != "ingest"
        && path != "memory"
        && path != "memory/retrieve"
    {
        return Err("Unsupported Hub write operation".into());
    }
    if path == "memory/retrieve" && !body.as_ref().is_some_and(retrieval::retrieval_input) {
        return Err("Invalid read-only retrieval request".into());
    }
    if path == "memory" {
        if let Some(value) = &body {
            memory_write(value, c.share_text)?;
        }
    }
    let key = vault(&c.endpoint)?
        .get_password()
        .map_err(|_| "Нет ключа библиотеки в системном хранилище")?;
    let url = format!("{}/api/{}", c.endpoint.trim_end_matches('/'), path);
    let mut q = client(c)?
        .request(
            if body.is_some() {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            url,
        )
        .bearer_auth(key);
    if let Some(mut b) = body {
        if !c.share_text {
            if let Some(records) = b["records"].as_array_mut() {
                for r in records {
                    strip_text(r);
                }
            }
        }
        if b.to_string().len() > 2 * 1024 * 1024 {
            return Err("Hub upload exceeds 2MiB".into());
        }
        q = q.json(&b);
    }
    let response = q.send().map_err(errors::transport)?;
    let status = response.status();
    if !status.is_success() {
        if model_control {
            let mut body = String::new();
            let _ = response.take(4096).read_to_string(&mut body);
            return Err(errors::http(status.as_u16(), &body));
        }
        if memory_path(path) {
            let mut text = String::new();
            if response.take(4096).read_to_string(&mut text).is_ok() {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if let Some(error) = value["error"].as_str() {
                        return Err(format!(
                            "Hub HTTP {} — {}",
                            status.as_u16(),
                            error.chars().take(300).collect::<String>()
                        ));
                    }
                }
            }
        }
        return Err(errors::failure("http", Some(status.as_u16())));
    }
    let mut raw = String::new();
    response
        .take(8 * 1024 * 1024 + 1)
        .read_to_string(&mut raw)
        .map_err(|_| errors::failure("interrupted", None))?;
    if raw.len() > 8 * 1024 * 1024 {
        return Err("Hub response exceeds 8MiB".into());
    }
    serde_json::from_str(&raw).map_err(|_| "Invalid Hub JSON".into())
}
fn portable_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                matches!(b, b'0'..=b'9' | b'a'..=b'f')
            }
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}
fn memory_path(path: &str) -> bool {
    path == "memory"
        || path
            .strip_prefix("memory?project=")
            .is_some_and(portable_uuid)
}
fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn memory_source(value: &Value) -> bool {
    exact_keys(
        value,
        &["anchor", "revision", "digest", "accepted", "engine"],
    ) && ["anchor", "digest"]
        .iter()
        .all(|k| value[*k].as_str().is_some_and(hash_ok))
        && value["revision"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
        && value["accepted"].is_boolean()
        && matches!(value["engine"].as_str(), Some("opencode" | "pi"))
}
fn memory_write(value: &Value, share_text: bool) -> Result<(), String> {
    let valid = match value["action"].as_str() {
        Some("sources") => {
            exact_keys(value, &["action", "sources"])
                && value["sources"]
                    .as_array()
                    .is_some_and(|s| s.len() <= 500 && s.iter().all(memory_source))
        }
        Some("approve" | "invalidate") => {
            exact_keys(value, &["action", "id", "expected"])
                && value["id"].as_str().is_some_and(portable_uuid)
                && value["expected"].as_u64().is_some_and(|n| n > 0)
        }
        Some("project") => {
            share_text
                && exact_keys(value, &["action", "id", "title"])
                && value["id"].as_str().is_some_and(portable_uuid)
                && value["title"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.chars().count() <= 80)
        }
        Some("save") => {
            share_text
                && exact_keys(value, &["action", "entry", "expected"])
                && exact_keys(
                    &value["entry"],
                    &[
                        "id",
                        "project",
                        "kind",
                        "title",
                        "text",
                        "source",
                        "expiresAt",
                    ],
                )
                && memory_source(&value["entry"]["source"])
                && value["entry"]["id"].as_str().is_some_and(portable_uuid)
                && value["entry"]["project"]
                    .as_str()
                    .is_some_and(portable_uuid)
                && (value["expected"].is_null()
                    || value["expected"]
                        .as_u64()
                        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991))
                && matches!(value["entry"]["kind"].as_str(), Some("fact" | "runbook"))
                && value["entry"]["source"]["accepted"] == true
                && value["entry"]["expiresAt"]
                    .as_u64()
                    .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
                && [("title", 120), ("text", 4000)].iter().all(|(k, max)| {
                    value["entry"][*k]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= *max)
                })
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Memory request rejected: check fields and text-sharing consent".into())
    }
}
fn main_window(w: &tauri::WebviewWindow) -> Result<(), String> {
    if w.label() != "main" {
        Err("Only the main window can access Hub".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn hub_config(
    window: tauri::WebviewWindow,
    config: Option<Config>,
    key: Option<String>,
    expected: Option<Config>,
) -> Result<Config, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = IO.lock().map_err(|_| "Hub lock failed")?;
        if let Some(mut c) = config {
            let old = load()?;
            if expected.as_ref() != Some(&old) {
                return Err(
                    "Подключение изменено. Обновите настройки; чужие изменения сохранены".into(),
                );
            }
            validate(&c)?;
            if !c.endpoint.is_empty() {
                c.endpoint = origin(&c.endpoint)?;
            }
            if let Some(k) = key {
                if !k.is_empty() {
                    if !(20..=256).contains(&k.trim().len()) || k.contains(['\r', '\n']) {
                        return Err("Invalid device key".into());
                    }
                    vault(&c.endpoint)?
                        .set_password(k.trim())
                        .map_err(|_| "Cannot save Hub key to system vault")?;
                }
            }
            if scope(&old) != scope(&c) {
                c.installed.clear();
            }
            if scope(&old) != scope(&c) || (old.share_text && !c.share_text) {
                write(
                    &root()?.join("outbox.json"),
                    &serde_json::to_string(&Spool::default()).map_err(|_| "Cannot reset outbox")?,
                )?;
            }
            write(
                &root()?.join("connection.json"),
                &serde_json::to_string_pretty(&c).map_err(|_| "Cannot encode Hub configuration")?,
            )?;
            Ok(c)
        } else {
            load()
        }
    })
    .await
    .map_err(|_| "Hub configuration task failed")?
}
#[tauri::command]
pub async fn hub_request(
    window: tauri::WebviewWindow,
    path: String,
    body: Option<Value>,
    expected: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let c = load()?;
        if !c.enabled {
            return Err("Hub disabled".into());
        }
        if expected.is_some_and(|e| e != scope(&c)) {
            return Err("Hub connection changed; upload cancelled".into());
        }
        request(&c, &path, body)
    })
    .await
    .map_err(|_| "Hub request task failed")?
}
/// Enki Runtime broker: identity of the configured Hub (the same scope the UI
/// uses), or None when Hub coordination is off.
pub(crate) fn broker_identity() -> Result<Option<String>, String> {
    let c = load()?;
    Ok((c.enabled && !c.endpoint.is_empty()).then(|| scope(&c)))
}
/// Enki Runtime broker: model-service coordination only (catalog, prepare,
/// status, release). Memory, packages, devices and releases stay UI-only. The
/// device key never leaves this process.
pub(crate) fn broker_request(
    path: &str,
    body: Option<Value>,
    expected: &str,
) -> Result<Value, String> {
    let allowed = ["catalog", "prepare", "status", "release", "inspect"];
    let Some(rest) = path.strip_prefix("model-services/") else {
        return Err("Среда выполнения может обращаться только к сервисам моделей Hub".into());
    };
    if !allowed.contains(&rest) {
        return Err("Недопустимый запрос сервиса моделей".into());
    }
    let c = load()?;
    if !c.enabled {
        return Err("Hub disabled".into());
    }
    if expected != scope(&c) {
        return Err("Hub connection changed; request cancelled".into());
    }
    request(&c, path, body)
}
fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn hash_ok(h: &str) -> bool {
    h.len() == 64
        && h.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_files(v: &Value) -> Result<BTreeMap<String, String>, String> {
    let files = v["files"].as_object().ok_or("Missing package files")?;
    if files.is_empty() || files.len() > 128 {
        return Err("Invalid file count".into());
    }
    let mut out = BTreeMap::new();
    let mut total = 0;
    for (name, raw) in files {
        let text = raw.as_str().ok_or("Only UTF-8 files are supported")?;
        total += text.len();
        if name.is_empty()
            || name.len() > 240
            || name.contains(['\\', ':', '\0'])
            || name.split('/').count() > 8
            || name
                .split('/')
                .any(|s| s.is_empty() || s == ".." || s == ".")
            || text.len() > 262144
            || total > 1024 * 1024
        {
            return Err("Unsafe package path or size".into());
        }
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        if v["hashes"][name].as_str() != Some(&hash) {
            return Err("Package SHA256 mismatch".into());
        }
        out.insert(name.clone(), text.into());
    }
    Ok(out)
}
fn admin_vault(endpoint: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        &crate::paths::HUB_SECRETS.service()?,
        &admin_account(endpoint),
    )
    .map_err(|_| "System credential store unavailable".into())
}
fn catalog_send(
    c: &Config,
    method: reqwest::Method,
    body: Option<&Value>,
    key: &str,
) -> Result<Result<Value, (u16, String)>, String> {
    let url = format!("{}/api/model-catalog", c.endpoint.trim_end_matches('/'));
    let mut q = client(c)?.request(method, url).bearer_auth(key);
    if let Some(b) = body {
        if b.to_string().len() > 256 * 1024 {
            return Err("Каталог моделей превышает 256KiB".into());
        }
        q = q.json(b);
    }
    let response = q.send().map_err(errors::transport)?;
    let status = response.status().as_u16();
    let mut raw = String::new();
    response
        .take(1024 * 1024)
        .read_to_string(&mut raw)
        .map_err(|_| errors::failure("interrupted", None))?;
    if raw.len() > 512 * 1024 {
        return Err("Ответ каталога моделей слишком велик".into());
    }
    let value: Value = serde_json::from_str(&raw).map_err(|_| "Invalid Hub JSON".to_string())?;
    Ok(if (200..299).contains(&status) {
        Ok(value)
    } else {
        Err((
            status,
            value["error"]
                .as_str()
                .unwrap_or("ошибка Hub")
                .chars()
                .take(300)
                .collect(),
        ))
    })
}
#[tauri::command]
pub async fn hub_model_catalog(
    window: tauri::WebviewWindow,
    action: String,
    models: Option<Value>,
    admin_key: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let c = load()?;
        if !c.enabled || c.endpoint.is_empty() {
            return Err("Hub не подключён".into());
        }
        origin(&c.endpoint)?;
        let device = vault(&c.endpoint)?
            .get_password()
            .map_err(|_| "Нет ключа библиотеки в системном хранилище")?;
        if action == "get" {
            return match catalog_send(&c, reqwest::Method::GET, None, &device)? {
                Ok(value) => Ok(value),
                Err((status, message)) => Err(format!("Hub HTTP {status} — {message}")),
            };
        }
        if action != "publish" {
            return Err("Неизвестное действие каталога моделей".into());
        }
        let list = models
            .as_ref()
            .and_then(|m| m.get("models").cloned())
            .ok_or("Нужен список моделей")?;
        let mut body = serde_json::json!({ "models": list });
        if let Some(expected) = models.as_ref().and_then(|m| m.get("expectedVersion")) {
            body["expectedVersion"] = expected.clone();
        }
        if !body["models"].is_array() {
            return Err("models должен быть списком".into());
        }
        let provided = admin_key
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        if let Some(k) = &provided {
            if !(20..=256).contains(&k.len()) || k.contains(['\r', '\n']) {
                return Err("Некорректный административный ключ".into());
            }
        }
        let mut keys: Vec<String> = Vec::new();
        if let Some(k) = &provided {
            keys.push(k.clone());
        }
        if let Ok(Some(k)) = admin_vault(&c.endpoint).map(|v| v.get_password().ok()) {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        if !keys.contains(&device) {
            keys.push(device);
        }
        let mut last =
            "Hub отклонил публикацию: ни один ключ не является администратором".to_string();
        for k in &keys {
            match catalog_send(&c, reqwest::Method::POST, Some(&body), k)? {
                Ok(value) => {
                    if Some(k) == provided.as_ref() {
                        // Publication is already acknowledged. A credential
                        // cache failure must not turn it into a failed publish.
                        if let Ok(entry) = admin_vault(&c.endpoint) {
                            let _ = entry.set_password(k);
                        }
                    }
                    return Ok(value);
                }
                Err((403, message)) => last = format!("Hub HTTP 403 — {message}"),
                Err((status, message)) => return Err(format!("Hub HTTP {status} — {message}")),
            }
        }
        Err(last)
    })
    .await
    .map_err(|_| "Каталог моделей: задача не выполнена")?
}
#[tauri::command]
pub async fn hub_package(
    window: tauri::WebviewWindow,
    id: String,
    revision: String,
    expected: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !id_ok(&id)||!hash_ok(&revision){return Err("Invalid package identity".into());}
        let c=load()?;if !c.enabled{return Err("Hub disabled".into());}
        if expected.as_deref()!=Some(&scope(&c)){return Err("Hub changed; refresh the catalog".into());}
        let v=request(&c,&format!("catalog/{id}?revision={revision}"),None)?;
        if v["id"].as_str()!=Some(&id)||v["revision"].as_str()!=Some(&revision){return Err("Package identity mismatch".into());}
        let files=valid_files(&v)?;let _guard=IO.lock().map_err(|_|"Hub lock failed")?;
        let current=load()?;
        if !current.enabled || scope(&current)!=scope(&c){return Err("Hub changed during package download".into());}
        let base=root()?.join("packages");safe_dir(&base)?;let parent=base.join(&id);safe_dir(&parent)?;
        let folder=parent.join(&revision);safe_dir(&folder)?;
        for (name,text) in files{let p=folder.join(&name);let mut ancestor=folder.clone();for part in Path::new(&name).parent().into_iter().flat_map(|p|p.components()){ancestor.push(part);safe_dir(&ancestor)?;}
            if p.exists() && read(&p)?!=text{return Err("Local package revision was modified; original preserved".into());}
            if !p.exists(){write(&p,&text)?;}}
        Ok(json!({"path":folder.to_string_lossy(),"sourcePath":folder.to_string_lossy(),"manifest":v}))
    }).await.map_err(|_|"Hub package task failed")?
}
#[derive(Default, Serialize, Deserialize)]
struct Spool {
    #[serde(default)]
    origin: String,
    pending: Vec<Value>,
    seen: Vec<String>,
    dropped: u64,
}
fn scope(c: &Config) -> String {
    fingerprint(&json!([c.endpoint, c.certificate]))
}
fn fingerprint(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
#[tauri::command]
pub async fn hub_spool(
    window: tauri::WebviewWindow,
    action: String,
    records: Option<Vec<Value>>,
    hashes: Option<Vec<String>>,
    expected: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = IO.lock().map_err(|_| "Hub lock failed")?;
        let c = load()?;
        outbox::verify_origin(&action, expected.as_deref(), &scope(&c))?;
        let p = root()?.join("outbox.json");
        let raw = read(&p)?;
        let mut s: Spool = if raw.is_empty() {
            Spool::default()
        } else {
            serde_json::from_str(&raw).map_err(|_| "Invalid Hub outbox")?
        };
        if s.origin != scope(&c) { s=Spool { origin:scope(&c), ..Spool::default() }; }
        match action.as_str() {
            "enqueue" => {
                if !c.enabled {
                    return Ok(json!({"pending":s.pending.len(),"dropped":s.dropped}));
                }
                let records = records.unwrap_or_default();
                if records.len() > 50 {
                    return Err("Batch too large".into());
                }
                for mut r in records {
                    r = outbox::prepare_record(r, c.share_text)?;
                    let h = fingerprint(&r);
                    if !s.seen.contains(&h) && !s.pending.iter().any(|v| fingerprint(v) == h) {
                        s.pending.push(r);
                    }
                }
                while s.pending.len() > 1200
                    || serde_json::to_vec(&s)
                        .map_err(|_| "Cannot encode outbox")?
                        .len()
                        > 12 * 1024 * 1024
                {
                    s.pending.remove(0);
                    s.dropped += 1;
                }
            }
            "ack" => {
                let done = hashes.unwrap_or_default();
                if done.len() > 50 {
                    return Err("Ack batch too large".into());
                }
                s.pending.retain(|r| {
                    let h = fingerprint(r);
                    if done.contains(&h) {
                        s.seen.push(h);
                        false
                    } else {
                        true
                    }
                });
                if s.seen.len() > 5000 {
                    s.seen.drain(..s.seen.len() - 5000);
                }
            }
            "clear" => s = Spool { origin:scope(&c), ..Spool::default() },
            "read" => {}
            _ => return Err("Unknown outbox operation".into()),
        }
        if !c.share_text {
            for r in &mut s.pending {
                strip_text(r);
            }
        }
        if action != "read" {
            write(
                &p,
                &serde_json::to_string(&s).map_err(|_| "Cannot encode outbox")?,
            )?;
        }
        // Respect the server's 2MiB body cap even when cards carry long Unicode evidence.
        let batch = upload_batch(&s.pending);
        let hash: Vec<_> = batch.iter().map(fingerprint).collect();
        Ok(json!({"pending":s.pending.len(),"dropped":s.dropped,"records":batch,"hashes":hash,"origin":s.origin}))
    })
    .await
    .map_err(|_| "Hub outbox task failed")?
}
/// Administrator bootstrap: a PRIVATE local JSON file, never command-line secrets.
/// Does not start an agent, browser, inference service, or change provider settings.
pub fn cli() -> Result<(), String> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "--hub-setup" {
        let path = std::env::args()
            .nth(2)
            .ok_or("Private setup file required")?;
        let input: Value =
            serde_json::from_str(&read(Path::new(&path))?).map_err(|_| "Invalid setup file")?;
        let mut c: Config = serde_json::from_value(input["config"].clone())
            .map_err(|_| "Invalid setup configuration")?;
        validate(&c)?;
        c.endpoint = origin(&c.endpoint)?;
        let key = input["key"].as_str().ok_or("Missing device key")?;
        if !(20..=256).contains(&key.len()) || key.contains(['\r', '\n']) {
            return Err("Invalid device key".into());
        }
        let _guard = IO.lock().map_err(|_| "Hub lock failed")?;
        vault(&c.endpoint)?
            .set_password(key)
            .map_err(|_| "Cannot save Hub credential")?;
        write(
            &root()?.join("connection.json"),
            &serde_json::to_string_pretty(&c).map_err(|_| "Cannot encode connection")?,
        )?;
        println!("{{\"configured\":true}}");
    } else {
        let c = load()?;
        let me = request(&c, "me", None)?;
        let metrics = request(&c, "metrics?days=30", None)?;
        println!(
            "{}",
            json!({"connected":true,"device":me["name"],"counts":metrics["counts"],"totals":metrics["totals"]})
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_coordinator_paths_accept_only_bounded_catalog_ids_and_ticket_operations() {
        let prepare = json!({"providerID":"local-artemis","modelID":"artemis31-v100","agent":"opencode","requestKey":"test-1","mode":"run"});
        assert!(model_control_path("model-services/catalog", None));
        assert!(model_control_path("model-services/prepare", Some(&prepare)));
        assert!(!model_control_path("model-services/prepare", None));
        let mut injected = prepare.clone();
        injected["endpoint"] = json!("http://attacker");
        assert!(!model_control_path(
            "model-services/prepare",
            Some(&injected)
        ));
        injected = prepare.clone();
        injected["agent"] = json!("admin");
        assert!(!model_control_path(
            "model-services/prepare",
            Some(&injected)
        ));
        assert!(!model_control_path(
            "model-services/status?url=http://attacker",
            Some(&prepare)
        ));
        assert!(!model_control_path(
            "model-services/../devices",
            Some(&prepare)
        ));
        assert!(model_control_path(
            "model-services/release",
            Some(&json!({"ticket":"12345678-1234-1234-1234-123456789012"}))
        ));
        assert!(!model_control_path(
            "model-services/release",
            Some(&json!({"ticket":"x","device":"another"}))
        ));
    }
    #[test]
    fn large_cards_are_uploaded_in_bounded_complete_batches() {
        let check = json!({"name":"漢".repeat(160),"status":"passed","evidence":"漢".repeat(1500)});
        let assessment = json!({"revision":1,"goal":"漢".repeat(4000),"criteria":"漢".repeat(4000),"notes":"漢".repeat(2000),"checks":vec![check;8],"verdict":"accepted"});
        let pending: Vec<_> = (0..20)
            .map(|i| json!({"id":i.to_string(),"sessionId":"s","role":"user","engine":"pi","text":"漢".repeat(16000),"tools":[],"assessment":assessment}))
            .collect();
        assert!(pending[0].to_string().len() > 64000);
        assert!(pending[0].to_string().len() < 192000);
        let first = upload_batch(&pending);
        assert!(!first.is_empty());
        assert!(first.len() < 20);
        assert!(
            json!({"appVersion":"0.2.30","records":first})
                .to_string()
                .len()
                < 2 * 1024 * 1024
        );
        let rest = upload_batch(&pending[first.len()..]);
        assert_eq!(first.len() + rest.len(), pending.len());
        assert_eq!(first[0], pending[0]);
        assert_eq!(rest.last(), pending.last());
    }
    #[test]
    fn private_assessment_is_removed_when_text_sharing_is_off() {
        let mut r = json!({"text":"request","title":"private","assessment":{"goal":"private"},"tokens":{"total":12}});
        strip_text(&mut r);
        assert!(r.get("assessment").is_none());
        assert_eq!(r["text"], "");
        assert_eq!(r["title"], "");
        assert_eq!(r["tokens"]["total"], 12);
    }
    #[test]
    fn memory_paths_and_consent_are_explicit() {
        let id = "f699c7f4-a21c-4a3b-99f3-6beac4fe6a8f";
        assert!(memory_path("memory"));
        assert!(memory_path(&format!("memory?project={id}")));
        for path in [
            "memory?project=/local/path",
            "memory?project=x&key=secret",
            "memory/../me",
            "memory?project=F699C7F4-a21c-4a3b-99f3-6beac4fe6a8f",
        ] {
            assert!(!memory_path(path));
        }
        let project = json!({"action":"project","id":id,"title":"Project"});
        assert!(memory_write(&project, true).is_ok());
        assert!(memory_write(&project, false).is_err());
        assert!(memory_write(
            &json!({"action":"project","id":id,"title":"P","remote":"https://secret@host"}),
            true
        )
        .is_err());
        let source = json!({"anchor":"a".repeat(64),"revision":2,"digest":"b".repeat(64),"accepted":true,"engine":"pi"});
        assert!(memory_write(
            &json!({"action":"sources","sources":[source.clone()]}),
            false
        )
        .is_ok());
        let mut private = source.clone();
        private["directory"] = json!("/private/project");
        assert!(memory_write(&json!({"action":"sources","sources":[private]}), false).is_err());
        let mut save = json!({"action":"save","expected":null,"entry":{"id":id,"project":id,"title":"Build","text":"Use documented build","kind":"fact","source":source,"expiresAt":1900000000000u64}});
        assert!(memory_write(&save, true).is_ok());
        assert!(memory_write(&save, false).is_err());
        save["entry"]["source"]["accepted"] = json!(false);
        assert!(memory_write(&save, true).is_err());
        assert!(memory_write(&json!({"action":"invalidate","id":id,"expected":1}), false).is_ok());
    }
    #[test]
    fn endpoints() {
        assert!(origin("https://192.168.31.223:8443").is_ok());
        for u in [
            "http://192.168.31.223",
            "https://u:p@host",
            "https://host/path",
            "https://host?key=x",
        ] {
            assert!(origin(u).is_err());
        }
    }
    #[test]
    fn package_validation() {
        let mut v = json!({"files":{"SKILL.md":"hello"},"hashes":{"SKILL.md":format!("{:x}",Sha256::digest(b"hello"))}});
        assert!(valid_files(&v).is_ok());
        v["hashes"]["SKILL.md"] = json!("bad");
        assert!(valid_files(&v).is_err());
        for path in ["../a", "/abs", "a//b", "C:x", "a\\b"] {
            assert!(valid_files(&json!({"files":{path:"hello"},"hashes":{path:format!("{:x}",Sha256::digest(b"hello"))}})).is_err());
        }
    }
}
