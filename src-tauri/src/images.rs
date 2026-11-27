//! Image API settings: non-secret configuration and OS-vault credentials.
use serde::{Deserialize, Serialize};
use std::fs;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub endpoint: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: "http://192.168.31.59:8080/api/images".into(),
        }
    }
}
fn validate(s: &Settings) -> Result<(), String> {
    let u = url::Url::parse(&s.endpoint).map_err(|_| "Некорректный URL генератора")?;
    let local = match u.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback(),
        Some(url::Host::Domain("localhost")) => true,
        _ => false,
    };
    if s.endpoint.len() > 2048
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !(u.scheme() == "https" || u.scheme() == "http" && local)
    {
        return Err("Используйте HTTPS либо HTTP локальной сети, без ключа в URL".into());
    }
    Ok(())
}
fn path() -> Result<std::path::PathBuf, String> {
    Ok(crate::capabilities::root()?.join("image-generation.json"))
}
/// Intentional alias of the shared MCP credential `global/enki-images` in the
/// SAME (profile-scoped) shared-mcp namespace; never another profile's entry.
pub(crate) const MCP_SCOPE: &str = "global";
pub(crate) const MCP_ID: &str = "enki-images";
fn entry() -> Result<keyring::Entry, String> {
    crate::capabilities::credential(MCP_SCOPE, MCP_ID)
}
pub fn load_api_key() -> Result<String, String> {
    // One entry for read and bootstrap import: both use this profile's service.
    let entry = entry()?;
    match entry.get_password() {
        Ok(v) => Ok(v),
        Err(keyring::Error::NoEntry) => {
            // Optional operator provisioning. Import inside the installed Enki
            // process so the OS vault attributes the item to the application.
            // Only this profile's own capabilities root is consulted.
            let p = crate::capabilities::root()?.join("image-api.bootstrap");
            if !p.exists() {
                return Ok(String::new());
            }
            let m = fs::symlink_metadata(&p)
                .map_err(|_| "Не удалось прочитать начальный ключ генератора")?;
            if !m.is_file() || m.file_type().is_symlink() || m.len() > 8192 {
                return Err("Недопустимый файл начального ключа генератора".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if m.permissions().mode() & 0o077 != 0 {
                    return Err("Начальный ключ должен быть доступен только владельцу".into());
                }
            }
            let value = fs::read_to_string(&p)
                .map_err(|_| "Начальный ключ недоступен")?
                .trim()
                .to_string();
            if value.len() < 32 || value.contains(['\r', '\n']) {
                return Err("Некорректный начальный ключ".into());
            }
            entry
                .set_password(&value)
                .map_err(|_| "Не удалось перенести ключ в связку ключей")?;
            fs::remove_file(p)
                .map_err(|_| "Ключ перенесён в связку, но начальный файл не удалён")?;
            Ok(value)
        }
        Err(_) => Err("Ключ генератора недоступен в связке ключей".into()),
    }
}
fn read() -> Result<Settings, String> {
    let p = path()?;
    if p.is_symlink() {
        return Err("Настройки генератора не должны быть ссылкой".into());
    }
    if !p.exists() {
        return Ok(Settings::default());
    }
    if fs::metadata(&p).map_err(|_| "Настройки недоступны")?.len() > 16384 {
        return Err("Слишком большие настройки".into());
    }
    let s = serde_json::from_str(&fs::read_to_string(p).map_err(|_| "Настройки недоступны")?)
        .map_err(|_| "Повреждены настройки генератора")?;
    validate(&s)?;
    Ok(s)
}

/// Lenient reader for the pre-Hub settings file: the retired `provider`/`model`
/// fields may be present (legacy) or absent (already migrated).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySettings {
    enabled: bool,
    endpoint: String,
    #[serde(default)]
    #[allow(dead_code)]
    provider: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    model: Option<String>,
}
pub(crate) fn migrate_hub_settings_at(root: &std::path::Path) -> Result<(), String> {
    let marker = root.join("image-hub-v1.json");
    let config = root.join("image-generation.json");
    let backup = root.join("image-generation.before-hub-v1.json");
    for p in [&marker, &config, &backup] {
        if p.is_symlink() {
            return Err("Миграция генератора не поддерживает ссылки".into());
        }
    }
    if marker.exists() {
        return Ok(());
    }
    if config.exists() {
        if fs::metadata(&config)
            .map_err(|_| "Настройки недоступны")?
            .len()
            > 16384
        {
            return Err("Слишком большие настройки генератора".into());
        }
        let old = fs::read_to_string(&config).map_err(|_| "Настройки недоступны")?;
        let legacy: LegacySettings =
            serde_json::from_str(&old).map_err(|_| "Повреждены настройки генератора")?;
        let migrated = Settings {
            enabled: legacy.enabled,
            endpoint: legacy.endpoint,
        };
        validate(&migrated)?;
        let new = serde_json::to_string_pretty(&migrated).map_err(|_| "Некорректные настройки")?;
        if new.trim() != old.trim() {
            if backup.exists() {
                if fs::metadata(&backup)
                    .map_err(|_| "Копия настроек недоступна")?
                    .len()
                    > 16384
                {
                    return Err("Резервная копия генератора слишком велика".into());
                }
                if fs::read_to_string(&backup).map_err(|_| "Копия настроек недоступна")? != old
                {
                    return Err("Резервная копия генератора отличается; настройки сохранены".into());
                }
            } else {
                crate::config::write_at(&backup, "", &old)?;
            }
            crate::config::write_at(&config, &old, &new)?;
        }
    }
    crate::config::write_at(&marker, "", "{\"version\":1}")
}
#[tauri::command]
pub async fn image_settings(
    window: tauri::WebviewWindow,
    settings: Option<Settings>,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(s) = settings {
            validate(&s)?;
            if let Some(key) = api_key {
                if key.len() > 8192 || key.contains(['\r', '\n']) {
                    return Err("Некорректный API-ключ".into());
                }
                if key.is_empty() {
                    match entry()?.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => (),
                        Err(_) => return Err("Не удалось удалить ключ".into()),
                    }
                } else {
                    entry()?
                        .set_password(&key)
                        .map_err(|_| "Не удалось сохранить ключ")?
                }
            }
            let p = path()?;
            let old = if p.exists() {
                fs::read_to_string(&p).map_err(|_| "Настройки недоступны")?
            } else {
                String::new()
            };
            crate::config::write_at(
                &p,
                &old,
                &serde_json::to_string_pretty(&s).map_err(|_| "Некорректные настройки")?,
            )?;
        }
        Ok(serde_json::json!({"settings":read()?,"hasKey":!load_api_key()?.is_empty()}))
    })
    .await
    .map_err(|_| "Операция настроек прервана")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hub_migration_drops_retired_fields_and_keeps_the_endpoint() {
        let root = std::env::temp_dir().join(format!(
            "enki-hub-migration-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let old = "{\"enabled\":true,\"provider\":\"enki\",\"endpoint\":\"https://images.example.com/api/images\",\"model\":\"enki-image-auto\"}";
        fs::write(root.join("image-generation.json"), old).unwrap();
        migrate_hub_settings_at(&root).unwrap();
        let updated: Settings =
            serde_json::from_str(&fs::read_to_string(root.join("image-generation.json")).unwrap())
                .unwrap();
        assert!(updated.enabled);
        assert_eq!(updated.endpoint, "https://images.example.com/api/images");
        assert_eq!(
            fs::read_to_string(root.join("image-generation.before-hub-v1.json")).unwrap(),
            old
        );
        // Restart-safe: a second run keeps the migrated file byte for byte.
        let migrated = fs::read_to_string(root.join("image-generation.json")).unwrap();
        fs::remove_file(root.join("image-hub-v1.json")).unwrap();
        migrate_hub_settings_at(&root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("image-generation.json")).unwrap(),
            migrated
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn hub_migration_leaves_an_already_current_file_alone() {
        let root = std::env::temp_dir().join(format!(
            "enki-hub-current-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let current = serde_json::to_string_pretty(&Settings::default()).unwrap();
        fs::write(root.join("image-generation.json"), &current).unwrap();
        migrate_hub_settings_at(&root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("image-generation.json")).unwrap(),
            current
        );
        assert!(!root.join("image-generation.before-hub-v1.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn endpoints() {
        let mut s = Settings::default();
        assert!(validate(&s).is_ok());
        for url in [
            "http://example.com/api",
            "https://key@example.com",
            "https://example.com/?key=secret",
            "file:///tmp/a",
        ] {
            s.endpoint = url.into();
            assert!(validate(&s).is_err())
        }
        s.endpoint = "https://example.com/v1".into();
        assert!(validate(&s).is_ok());
    }
}

/// Explicit generated PNG reader; never grants general filesystem access to tool output.
#[tauri::command]
pub async fn image_asset(window: tauri::WebviewWindow, file_url: String) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    let fallback_url = file_url.clone();
    let local = tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let url = url::Url::parse(&file_url).map_err(|_| "Некорректная ссылка изображения")?;
        if url.query().is_some() || url.fragment().is_some() {
            return Err("Некорректная ссылка".into());
        }
        let p = url.to_file_path().map_err(|_| "Нужен локальный PNG")?;
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Нет имени PNG")?;
        if !asset_name(name) {
            return Err("Недопустимое имя PNG".into());
        }
        let parent = p.parent().ok_or("Нет папки результата")?;
        let id = parent
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Нет задания")?;
        if id.len() != 36
            || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || parent
                .parent()
                .and_then(|n| n.file_name())
                .and_then(|n| n.to_str())
                != Some("generated-images")
            || parent
                .parent()
                .and_then(|n| n.parent())
                .and_then(|n| n.file_name())
                .and_then(|n| n.to_str())
                != Some(".enki")
        {
            return Err("Нужен файл из .enki/generated-images".into());
        }
        for ancestor in p.ancestors() {
            if ancestor.is_symlink() {
                return Err("Ссылки на результаты не поддерживаются".into());
            }
        }
        let m = fs::metadata(&p)
            .map_err(|_| "Файл недоступен на этом устройстве. Откройте его на компьютере агента")?;
        if !m.is_file() || m.len() > 4 * 1024 * 1024 {
            return Err("PNG недоступен или больше 4 МБ".into());
        }
        let bytes = fs::read(p).map_err(|_| "Не удалось прочитать PNG")?;
        if bytes.len() > 4 * 1024 * 1024 || !valid_png(&bytes) {
            return Err("Повреждённый PNG".into());
        }
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|_| "Чтение прервано")?;
    if local.is_ok() {
        return local;
    }
    // A remote agent saves into its own workspace. Fetch only this configured
    // generator's exact job/file route; never follow a URL from tool output.
    let u = url::Url::parse(&fallback_url).map_err(|_| "Некорректный файл")?;
    let Some((id, name)) = remote_reference(&u) else {
        return local;
    };
    let settings = read()?;
    if !settings.enabled {
        return local;
    }
    let route = format!("/jobs/{id}/images/{name}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось подключиться к генератору")?;
    let mut response = client
        .get(format!(
            "{}{}",
            settings.endpoint.trim_end_matches('/'),
            route
        ))
        .bearer_auth(load_api_key()?)
        .send()
        .await
        .map_err(|_| "Файл находится на компьютере агента; генератор сейчас недоступен")?;
    if !response.status().is_success() {
        return Err(format!(
            "Превью HTTP {}. Проверьте API генератора в настройках",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Передача PNG оборвалась")?
    {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("PNG больше 4 МБ".into());
        }
        bytes.extend_from_slice(&chunk)
    }
    if !valid_png(&bytes) {
        return Err("Генератор вернул повреждённый PNG".into());
    }
    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// A job id from the Hub: exactly the UUID shape the service issues.
fn valid_job_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
async fn image_api(method: &str, route: &str, timeout: u64) -> Result<reqwest::Response, String> {
    let settings = read()?;
    if !settings.enabled {
        return Err("Включите генерацию изображений в настройках Enki".into());
    }
    let key = tauri::async_runtime::spawn_blocking(load_api_key)
        .await
        .map_err(|_| "Связка ключей недоступна")??;
    if key.is_empty() {
        return Err("Ключ генератора не задан в настройках Enki".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось создать соединение")?;
    let url = format!("{}{}", settings.endpoint.trim_end_matches('/'), route);
    let request = if method == "DELETE" {
        client.delete(url)
    } else {
        client.get(url)
    };
    request
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "Сервис изображений не отвечает. Проверьте URL и доступность".to_string())
}
async fn json_bounded(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<serde_json::Value, String> {
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(format!(
            "Сервис изображений HTTP {status}: {}",
            if status == 401 || status == 403 {
                "проверьте ключ генератора"
            } else if status == 404 {
                "задание не найдено"
            } else {
                "проверьте настройки и состояние сервиса"
            }
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Ответ сервиса оборвался")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("Слишком большой ответ сервиса".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Сервис вернул некорректный JSON".into())
}
/// Progress and result metadata of one image job for the chat card.
#[tauri::command]
pub async fn image_job(
    window: tauri::WebviewWindow,
    job_id: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    if !valid_job_id(&job_id) {
        return Err("Некорректное задание".into());
    }
    json_bounded(
        image_api("GET", &format!("/jobs/{job_id}"), 20).await?,
        262144,
    )
    .await
}
/// Cancel a queued or running job; finished images stay available.
#[tauri::command]
pub async fn image_job_cancel(
    window: tauri::WebviewWindow,
    job_id: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    if !valid_job_id(&job_id) {
        return Err("Некорректное задание".into());
    }
    json_bounded(
        image_api("DELETE", &format!("/jobs/{job_id}"), 30).await?,
        262144,
    )
    .await
}
/// Save the finished images of a job into the open chat's generated-images
/// folder and return their file URLs. Used when a turn ended before the agent
/// retrieved them, so an interrupted answer never loses a paid-for result.
#[tauri::command]
pub async fn image_job_result(
    window: tauri::WebviewWindow,
    job_id: String,
    directory: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    if !valid_job_id(&job_id)
        || directory.len() > 4096
        || !std::path::Path::new(&directory).is_absolute()
    {
        return Err("Некорректный запрос результата".into());
    }
    let state = json_bounded(
        image_api("GET", &format!("/jobs/{job_id}"), 20).await?,
        262144,
    )
    .await?;
    if state["state"] != "completed" {
        return Err("Задание ещё не завершено".into());
    }
    let names: Vec<String> = state["images"]
        .as_array()
        .filter(|list| !list.is_empty() && list.len() <= 8)
        .ok_or("Сервис не вернул список изображений")?
        .iter()
        .map(|image| image["name"].as_str().unwrap_or_default().to_string())
        .collect();
    if names.iter().any(|name| !asset_name(name)) {
        return Err("Некорректное имя файла".into());
    }
    let base = fs::canonicalize(&directory).map_err(|_| "Рабочая папка чата недоступна")?;
    let mut folder = base.clone();
    for segment in [".enki", "generated-images"] {
        folder = folder.join(segment);
        fs::create_dir_all(&folder).map_err(|_| "Папка результатов недоступна")?;
        if fs::symlink_metadata(&folder)
            .map_err(|_| "Папка результатов недоступна")?
            .is_symlink()
        {
            return Err("Папка результатов не должна быть ссылкой".into());
        }
    }
    folder = folder.join(&job_id);
    fs::create_dir_all(&folder).map_err(|_| "Папка результатов недоступна")?;
    if fs::symlink_metadata(&folder)
        .map_err(|_| "Папка результатов недоступна")?
        .is_symlink()
    {
        return Err("Папка результатов не должна быть ссылкой".into());
    }
    let mut saved = Vec::new();
    for name in &names {
        let response = image_api("GET", &format!("/jobs/{job_id}/images/{name}"), 120).await?;
        let mut response = response;
        if !response.status().is_success() {
            return Err("Сервис не вернул файл изображения".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Передача PNG оборвалась")?
        {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("PNG больше 8 МБ".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if !valid_png(&bytes) {
            return Err("Сервис вернул повреждённый PNG".into());
        }
        use std::io::Write as _;
        let path = folder.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file
                .write_all(&bytes)
                .map_err(|_| "Не удалось сохранить PNG")?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = fs::read(&path).map_err(|_| "Файл результата недоступен")?;
                if existing != bytes {
                    return Err("Файл результата уже существует и отличается".into());
                }
            }
            Err(_) => return Err("Не удалось сохранить PNG".into()),
        }
        let url = url::Url::from_file_path(&path).map_err(|_| "Некорректный путь результата")?;
        saved.push(serde_json::json!({"name": name, "url": url.as_str()}));
    }
    Ok(serde_json::json!({
        "jobId": job_id,
        "images": saved,
        "width": state["width"],
        "height": state["height"],
        "seed": state["seed"],
        "progress": state["progress"],
    }))
}
fn valid_png(bytes: &[u8]) -> bool {
    if bytes.len() < 33 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return false;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    (1..=2048).contains(&w) && (1..=2048).contains(&h)
}

#[tauri::command]
pub async fn image_probe(
    window: tauri::WebviewWindow,
    settings: Settings,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    validate(&settings)?;
    let key = match api_key {
        Some(value) => value,
        None => tauri::async_runtime::spawn_blocking(load_api_key)
            .await
            .map_err(|_| "Связка ключей недоступна")??,
    };
    if key.len() > 8192 || key.contains(['\r', '\n']) {
        return Err("Некорректный API-ключ".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось создать соединение")?;
    let mut response=client.get(format!("{}/health",settings.endpoint.trim_end_matches('/'))).bearer_auth(key).send().await.map_err(|_|"Сервис не отвечает или сертификат не прошёл проверку. Проверьте URL и доступность сервера")?;
    if !response.status().is_success() {
        return Err(format!(
            "Генератор HTTP {}: {}",
            response.status().as_u16(),
            if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
                "проверьте API-ключ"
            } else {
                "проверьте адрес и готовность сервиса"
            }
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Ответ генератора оборвался")?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err("Слишком большой ответ диагностики".into());
        }
        bytes.extend_from_slice(&chunk)
    }
    serde_json::from_slice(&bytes).map_err(|_| "API должен вернуть JSON".into())
}

#[cfg(test)]
mod png_tests {
    use super::*;
    #[test]
    fn rejects_truncated_and_oversized_png_headers() {
        assert!(!valid_png(b"\x89PNG\r\n\x1a\n"));
        let mut b = vec![0; 33];
        b[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        b[12..16].copy_from_slice(b"IHDR");
        b[16..20].copy_from_slice(&512u32.to_be_bytes());
        b[20..24].copy_from_slice(&512u32.to_be_bytes());
        assert!(valid_png(&b));
        b[16..20].copy_from_slice(&100000u32.to_be_bytes());
        assert!(!valid_png(&b));
    }
}

fn asset_name(name: &str) -> bool {
    let Some(number) = name
        .strip_suffix(".png")
        .and_then(|s| s.strip_prefix("image-"))
    else {
        return false;
    };
    number.len() == 2 && number.bytes().all(|b| b.is_ascii_digit())
}
#[cfg(test)]
mod asset_tests {
    use super::*;
    #[test]
    fn only_job_images_are_assets() {
        for n in ["image-01.png", "image-08.png"] {
            assert!(asset_name(n))
        }
        for n in [
            "../image-01.png",
            "other.png",
            "image-1.png",
            "image-001.png",
            "image-01.svg",
            "preview-01.png",
            "normal.png",
        ] {
            assert!(!asset_name(n))
        }
    }
}

fn remote_reference(u: &url::Url) -> Option<(&str, &str)> {
    if u.scheme() != "file"
        || u.host_str().is_some_and(|s| !s.is_empty())
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return None;
    }
    let parts: Vec<_> = u.path_segments()?.collect();
    let n = parts.len();
    if n < 4 || parts[n - 4] != ".enki" || parts[n - 3] != "generated-images" {
        return None;
    }
    let id = parts[n - 2];
    let name = parts[n - 1];
    (id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') && asset_name(name))
        .then_some((id, name))
}
#[cfg(test)]
mod job_tests {
    use super::*;
    #[test]
    fn accepts_only_hub_job_ids() {
        assert!(valid_job_id("01234567-1234-1234-1234-123456789abc"));
        for value in [
            "",
            "../jobs",
            "01234567-1234-1234-1234-123456789ab",
            "01234567-1234-1234-1234-123456789abc/",
            "zzzzzzzz-1234-1234-1234-123456789abc",
        ] {
            assert!(!valid_job_id(value), "{value}")
        }
    }
}
#[cfg(test)]
mod remote_tests {
    use super::*;
    #[test]
    fn references_do_not_depend_on_client_os() {
        for root in ["file:///C:/project", "file:///private/tmp/project"] {
            let u = url::Url::parse(&format!(
                "{root}/.enki/generated-images/01234567-1234-1234-1234-123456789abc/image-02.png"
            ))
            .unwrap();
            assert_eq!(remote_reference(&u).unwrap().1, "image-02.png")
        }
        let u = url::Url::parse(
            "file:///w/.enki/generated-images/01234567-1234-1234-1234-123456789abc/image-01.png",
        )
        .unwrap();
        assert_eq!(remote_reference(&u).unwrap().1, "image-01.png");
        let u = url::Url::parse(
            "file:///w/.enki/generated-images/01234567-1234-1234-1234-123456789abc/preview-01.png",
        )
        .unwrap();
        assert!(remote_reference(&u).is_none());
    }
}
