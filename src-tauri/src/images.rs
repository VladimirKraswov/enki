//! Image API settings: non-secret configuration and OS-vault credentials.
use serde::{Deserialize, Serialize};
use std::fs;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub provider: String,
    pub endpoint: String,
    pub model: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "enki".into(),
            endpoint: "http://192.168.31.59:8080/api/images".into(),
            model: "enki-image-auto".into(),
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
    if !["enki", "openai"].contains(&s.provider.as_str())
        || s.model.trim().is_empty()
        || s.model.len() > 200
        || s.endpoint.len() > 2048
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !(u.scheme() == "https" || u.scheme() == "http" && local)
    {
        return Err("Используйте HTTPS либо HTTP локальной сети, без ключа в URL; укажите модель и провайдера".into());
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

/// One-time upgrade of OUR former factory LCM endpoint. Explicit custom models
/// and APIs remain untouched; after the marker, choosing the draft is respected.
pub(crate) fn migrate_quality_default_at(root: &std::path::Path) -> Result<(), String> {
    let marker = root.join("image-quality-v1.json");
    let config = root.join("image-generation.json");
    let backup = root.join("image-generation.before-quality-v1.json");
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
        let mut s: Settings =
            serde_json::from_str(&old).map_err(|_| "Повреждены настройки генератора")?;
        validate(&s)?;
        if s.provider == "enki"
            && s.endpoint == Settings::default().endpoint
            && s.model == "lcm-dreamshaper-v7"
        {
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
            s.model = "enki-image-auto".into();
            crate::config::write_at(
                &config,
                &old,
                &serde_json::to_string_pretty(&s).map_err(|_| "Некорректные настройки")?,
            )?;
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
    fn quality_migration_is_restart_safe_and_respects_explicit_draft_afterwards() {
        let root = std::env::temp_dir().join(format!(
            "enki-quality-migration-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let s = Settings {
            model: "lcm-dreamshaper-v7".into(),
            ..Settings::default()
        };
        let old = serde_json::to_string(&s).unwrap();
        // Simulate a crash after saving the backup, before the CAS/marker.
        fs::write(root.join("image-generation.json"), &old).unwrap();
        fs::write(root.join("image-generation.before-quality-v1.json"), &old).unwrap();
        migrate_quality_default_at(&root).unwrap();
        let updated: Settings =
            serde_json::from_str(&fs::read_to_string(root.join("image-generation.json")).unwrap())
                .unwrap();
        assert_eq!(updated.model, "enki-image-auto");
        assert_eq!(
            fs::read_to_string(root.join("image-generation.before-quality-v1.json")).unwrap(),
            old
        );
        fs::write(root.join("image-generation.json"), &old).unwrap();
        migrate_quality_default_at(&root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("image-generation.json")).unwrap(),
            old
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn quality_migration_preserves_custom_api() {
        let root = std::env::temp_dir().join(format!(
            "enki-quality-custom-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let s = Settings {
            endpoint: "https://example.com/images".into(),
            model: "lcm-dreamshaper-v7".into(),
            ..Settings::default()
        };
        let old = serde_json::to_string(&s).unwrap();
        fs::write(root.join("image-generation.json"), &old).unwrap();
        migrate_quality_default_at(&root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("image-generation.json")).unwrap(),
            old
        );
        assert!(!root
            .join("image-generation.before-quality-v1.json")
            .exists());
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
    if !settings.enabled || settings.provider != "enki" {
        return local;
    }
    let route = if name.starts_with("preview-") {
        {
            let base = name.strip_prefix("preview-").unwrap();
            let original = if base.len() == 6 && base.ends_with(".png") {
                format!("image-{base}")
            } else {
                base.to_string()
            };
            format!("/jobs/{id}/preview/{original}")
        }
    } else {
        format!("/jobs/{id}/files/{name}")
    };
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
    let suffix = if settings.provider == "enki" {
        "/health"
    } else {
        "/models"
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось создать соединение")?;
    let mut response=client.get(format!("{}{}",settings.endpoint.trim_end_matches('/'),suffix)).bearer_auth(key).send().await.map_err(|_|"Сервис не отвечает или сертификат не прошёл проверку. Проверьте URL и доступность сервера")?;
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
    let Some(stem) = name.strip_suffix(".png") else {
        return false;
    };
    let (stem, preview) = match stem.strip_prefix("preview-") {
        Some(s) => (s, true),
        None => (stem, false),
    };
    if [
        "normal",
        "height",
        "roughness",
        "metallic",
        "relight",
        "relight-right",
        "tile-preview",
    ]
    .contains(&stem)
    {
        return true;
    }
    let number = stem
        .strip_prefix("image-")
        .or(if preview { Some(stem) } else { None });
    number.is_some_and(|n| n.len() == 2 && n.bytes().all(|b| b.is_ascii_digit()))
}
#[cfg(test)]
mod asset_tests {
    use super::*;
    #[test]
    fn material_asset_allowlist() {
        for n in [
            "normal.png",
            "preview-normal.png",
            "height.png",
            "image-01.png",
            "preview-01.png",
        ] {
            assert!(asset_name(n))
        }
        for n in [
            "../normal.png",
            "other.png",
            "normal.svg",
            "preview-../normal.png",
        ] {
            assert!(!asset_name(n))
        }
    }
}

/// Largest generated `images.zip` copied for the owner (≤8 PNGs of ≤4 MiB, maps, manifest).
const ARCHIVE_LIMIT: usize = 128 * 1024 * 1024;

/// The job id of `<directory>/.enki/generated-images/<uuid>/images.zip`, only
/// when the URL names exactly that file of the OPEN chat's working folder.
fn archive_reference(u: &url::Url, directory: &str) -> Option<String> {
    if u.scheme() != "file"
        || u.host_str().is_some_and(|s| !s.is_empty())
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return None;
    }
    let parts: Vec<_> = u.path_segments()?.collect();
    let n = parts.len();
    if n < 4
        || parts[n - 1] != "images.zip"
        || parts[n - 3] != "generated-images"
        || parts[n - 4] != ".enki"
    {
        return None;
    }
    let id = parts[n - 2];
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return None;
    }
    // Lexical prefix = the chat directory (works for a remote host's path too).
    let mut prefix = Vec::new();
    for segment in &parts[..n - 4] {
        let decoded = percent_decode(segment)?;
        if !decoded.is_empty() {
            prefix.push(decoded);
        }
    }
    let wanted: Vec<String> = directory
        .replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!wanted.is_empty() && prefix == wanted).then(|| id.to_string())
}

fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(out).ok()?;
    (!text.contains(['/', '\\', '\0']) && text != "." && text != "..").then_some(text)
}

/// Entries the generator writes into images.zip (services/images/server.py):
/// result PNGs/maps by their fixed names and manifest.json. Never a path, a
/// preview, a directory or anything else.
fn archive_entry(name: &str) -> bool {
    name == "manifest.json" || (!name.starts_with("preview-") && asset_name(name))
}

/// Structural check of our generator's seekable ZIP, WITHOUT extracting it or
/// claiming CRC/content integrity. Local records must exactly match the ordered
/// central records, with bounded sizes and no extra fields, descriptors, hidden
/// records, links or paths; manifest.json and at least one image are required.
fn verify_archive(bytes: &[u8]) -> Result<usize, String> {
    const BAD: &str = "Архив изображений повреждён или содержит посторонние файлы";
    if bytes.len() < 22 || bytes.len() > ARCHIVE_LIMIT || !bytes.starts_with(b"PK\x03\x04") {
        return Err(BAD.into());
    }
    let le16 = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]) as usize;
    let le32 = |i: usize| {
        u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize
    };
    let lowest = bytes.len().saturating_sub(22 + 65_535);
    let end = (lowest..=bytes.len() - 22)
        .rev()
        .find(|&i| bytes[i..i + 4] == *b"PK\x05\x06")
        .ok_or(BAD)?;
    let (disk, directory_disk) = (le16(end + 4), le16(end + 6));
    let (here, total) = (le16(end + 8), le16(end + 10));
    let (size, offset) = (le32(end + 12), le32(end + 16));
    if disk != 0
        || directory_disk != 0
        || here != total
        || total == 0
        || total > 32
        || offset.checked_add(size) != Some(end)
        || end + 22 + le16(end + 20) != bytes.len()
    {
        return Err(BAD.into());
    }
    let mut names = std::collections::HashSet::new();
    let mut at = offset;
    let mut local_end = 0;
    let mut expanded_total = 0usize;
    for _ in 0..total {
        if at + 46 > end || bytes[at..at + 4] != *b"PK\x01\x02" {
            return Err(BAD.into());
        }
        let needed = le16(at + 6);
        let (flags, method) = (le16(at + 8), le16(at + 10));
        let (crc, packed, expanded) = (le32(at + 16), le32(at + 20), le32(at + 24));
        let (name_len, extra, comment) = (le16(at + 28), le16(at + 30), le16(at + 32));
        let attributes = le32(at + 38);
        let local = le32(at + 42);
        let name_end = at + 46 + name_len;
        // Python ZipFile's seekable generator writes no extra fields or data
        // descriptors. Refuse features that can override names or hide sizes.
        if name_end > end
            || extra != 0
            || flags & !0x0800 != 0
            || needed > 20
            || le16(at + 34) != 0
            || (method != 0 && method != 8)
            || attributes & 0x10 != 0
            || !matches!((attributes >> 16) & 0xf000, 0 | 0x8000)
        {
            return Err(BAD.into());
        }
        let name = std::str::from_utf8(&bytes[at + 46..name_end]).map_err(|_| BAD)?;
        if !archive_entry(name) || !names.insert(name.to_string()) {
            return Err(BAD.into());
        }
        let entry_limit = if name == "manifest.json" {
            1024 * 1024
        } else {
            12 * 1024 * 1024
        };
        expanded_total = expanded_total.checked_add(expanded).ok_or(BAD)?;
        if expanded == 0
            || expanded > entry_limit
            || expanded_total > ARCHIVE_LIMIT
            || packed == 0
            || (method == 0 && packed != expanded)
            || local != local_end
            || !matches!(local.checked_add(30), Some(stop) if stop <= offset)
            || bytes[local..local + 4] != *b"PK\x03\x04"
        {
            return Err(BAD.into());
        }
        let header_end = local + 30;
        let data_start = header_end.checked_add(le16(local + 26)).ok_or(BAD)?;
        let data_end = data_start.checked_add(packed).ok_or(BAD)?;
        if data_end > offset
            || le16(local + 4) != needed
            || le16(local + 6) != flags
            || le16(local + 8) != method
            || le32(local + 14) != crc
            || le32(local + 18) != packed
            || le32(local + 22) != expanded
            || le16(local + 28) != 0
            || le16(local + 26) != name_len
            || bytes[header_end..data_start] != bytes[at + 46..name_end]
        {
            return Err(BAD.into());
        }
        local_end = data_end;
        at = name_end + extra + comment;
    }
    if at != end
        || local_end != offset
        || !names.contains("manifest.json")
        || !names.iter().any(|n| n.starts_with("image-"))
    {
        return Err(BAD.into());
    }
    Ok(total)
}

const NOT_HERE: &str = "Архив не найден на этом устройстве";

/// Open only the four result components below the selected chat folder. Unix
/// walks relative to pinned directory descriptors; Windows holds no-delete
/// directory handles and refuses every reparse point. No path is reopened for
/// the payload read. This is a bounded snapshot, not a cross-process CAS.
struct ArchiveSource {
    file: fs::File,
    _directories: Vec<fs::File>,
}

fn archive_location(
    path: &std::path::Path,
) -> Result<(&std::path::Path, Vec<&std::ffi::OsStr>), String> {
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(NOT_HERE.into());
    }
    let root = path.ancestors().nth(4).ok_or(NOT_HERE)?;
    let names = path
        .strip_prefix(root)
        .map_err(|_| NOT_HERE)?
        .components()
        .map(|part| match part {
            Component::Normal(name) => Ok(name),
            _ => Err(NOT_HERE),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if names.len() != 4 {
        return Err(NOT_HERE.into());
    }
    Ok((root, names))
}

#[cfg(unix)]
fn open_archive(path: &std::path::Path) -> Result<ArchiveSource, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    let (root, names) = archive_location(path)?;
    let root = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(root)
        .map_err(|_| NOT_HERE)?;
    let mut directories = vec![root];
    for (index, name) in names.iter().enumerate() {
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| NOT_HERE)?;
        let last = index == names.len() - 1;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if last { 0 } else { libc::O_DIRECTORY };
        // Each parent is our still-open directory; O_NOFOLLOW applies to this
        // exact child. O_NONBLOCK prevents a swapped FIFO from blocking open.
        let fd = unsafe {
            libc::openat(
                directories[directories.len() - 1].as_raw_fd(),
                name.as_ptr(),
                flags,
            )
        };
        if fd < 0 {
            return Err("Архив недоступен или содержит ссылку".into());
        }
        // SAFETY: openat returned a new descriptor owned only by this File.
        let file = unsafe { fs::File::from_raw_fd(fd) };
        if last {
            return Ok(ArchiveSource {
                file,
                _directories: directories,
            });
        }
        directories.push(file);
    }
    Err(NOT_HERE.into())
}

#[cfg(windows)]
fn open_archive(path: &std::path::Path) -> Result<ArchiveSource, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let (root, names) = archive_location(path)?;
    let mut current = root.to_path_buf();
    let mut directories = Vec::new();
    // Keep the selected root and all child directories open without write or
    // delete sharing, so they cannot be replaced while child paths are opened.
    for index in 0..=names.len() {
        if index > 0 {
            current.push(names[index - 1]);
        }
        let last = index == names.len();
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x00000001)
            .custom_flags(0x00200000 | if last { 0 } else { 0x02000000 })
            .open(&current)
            .map_err(|_| NOT_HERE)?;
        let metadata = file.metadata().map_err(|_| NOT_HERE)?;
        if metadata.file_attributes() & 0x400 != 0 || (!last && !metadata.is_dir()) {
            return Err("Архив недоступен или содержит ссылку".into());
        }
        if last {
            return Ok(ArchiveSource {
                file,
                _directories: directories,
            });
        }
        directories.push(file);
    }
    Err(NOT_HERE.into())
}

#[cfg(not(any(unix, windows)))]
fn open_archive(_: &std::path::Path) -> Result<ArchiveSource, String> {
    Err("Чтение архива не поддерживается на этой платформе".into())
}

fn bounded_archive_bytes(reader: &mut impl std::io::Read, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Не удалось прочитать архив")?;
    if bytes.len() > limit {
        return Err("Архив слишком большой".into());
    }
    Ok(bytes)
}

fn local_archive(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let mut source = open_archive(path)?;
    let before = source.file.metadata().map_err(|_| NOT_HERE)?;
    if !before.is_file() || before.len() > ARCHIVE_LIMIT as u64 {
        return Err("Архив недоступен или слишком большой".into());
    }
    let bytes = bounded_archive_bytes(&mut source.file, ARCHIVE_LIMIT)?;
    let after = source.file.metadata().map_err(|_| NOT_HERE)?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("Архив изменился во время чтения".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.ctime() != after.ctime() || before.ctime_nsec() != after.ctime_nsec() {
            return Err("Архив изменился во время чтения".into());
        }
    }
    Ok(bytes)
}

/// A remote agent saved its copy on its own host: fetch only THIS device's
/// configured generator's exact job archive route (never a URL from output).
async fn remote_archive(id: &str) -> Result<Vec<u8>, String> {
    let settings = tauri::async_runtime::spawn_blocking(read)
        .await
        .map_err(|_| "Настройки недоступны")??;
    if !settings.enabled || settings.provider != "enki" {
        return Err("Генератор Enki не настроен на этом устройстве".into());
    }
    let key = tauri::async_runtime::spawn_blocking(load_api_key)
        .await
        .map_err(|_| "Связка ключей недоступна")??;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось подключиться к генератору")?;
    let endpoint = settings.endpoint.trim_end_matches('/');
    let mut response = client
        .get(format!("{endpoint}/jobs/{id}/files/images.zip"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "Генератор сейчас недоступен")?;
    if !response.status().is_success() {
        return Err(format!(
            "Архив HTTP {}. Проверьте API генератора в настройках",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Передача архива оборвалась")?
    {
        if bytes.len() + chunk.len() > ARCHIVE_LIMIT {
            return Err("Архив слишком большой".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Write `bytes` to the owner's chosen file: a fresh sibling first, then rename.
fn write_choice(destination: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let name = destination.file_name().ok_or("Не выбрано имя файла")?;
    let part = format!(".{}.enki-part", name.to_string_lossy());
    let staging = destination.with_file_name(part);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|_| "Не удалось создать файл в выбранной папке")?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if written.is_err() || fs::rename(&staging, destination).is_err() {
        let _ = fs::remove_file(&staging);
        return Err("Не удалось сохранить архив в выбранной папке".into());
    }
    Ok(())
}

/// Save the generated images.zip of the OPEN chat (`directory`) to a file the
/// owner chooses in the native save dialog. The WebView names neither a
/// destination nor an arbitrary source: only the exact chat-folder archive is
/// accepted, verified as a generated archive, and copied unchanged. Returns
/// the saved path, or null when the owner cancelled the dialog.
#[tauri::command]
pub async fn image_archive_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    file_url: String,
    directory: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    if file_url.len() > 8192 || directory.len() > 4096 {
        return Err("Некорректная ссылка на архив".into());
    }
    let url = url::Url::parse(&file_url).map_err(|_| "Некорректная ссылка на архив")?;
    let id = archive_reference(&url, &directory).ok_or(OTHER_ARCHIVE)?;
    let local = match url.to_file_path() {
        Ok(path) => tauri::async_runtime::spawn_blocking(move || local_archive(&path))
            .await
            .map_err(|_| "Чтение прервано")?,
        Err(()) => Err(NOT_HERE.to_string()),
    };
    let bytes = match local {
        Ok(bytes) => bytes,
        // Not on this device (a remote agent's folder): the generator's own copy.
        Err(local) => remote_archive(&id)
            .await
            .map_err(|remote| format!("{local}. {remote}"))?,
    };
    verify_archive(&bytes)?;
    let name = format!("enki-images-{}.zip", &id[..8]);
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let Some(choice) = app
            .dialog()
            .file()
            .add_filter("ZIP", &["zip"])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let destination = choice.into_path().map_err(|_| NOT_A_FILE)?;
        write_choice(&destination, &bytes)?;
        Ok(Some(destination.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "Сохранение прервано")?
}

const OTHER_ARCHIVE: &str =
    "Можно сохранить только images.zip из .enki/generated-images текущего чата";
const NOT_A_FILE: &str = "Выбранное место не является файлом на этом устройстве";

#[cfg(test)]
mod archive_tests {
    use super::*;

    /// Minimal stored ZIP (no CRC check is needed by the structural verifier).
    fn zip(entries: &[(&str, u16)]) -> Vec<u8> {
        zip_payload(entries, 0, b"x", 1)
    }

    fn zip_payload(entries: &[(&str, u16)], method: u16, data: &[u8], expanded: u32) -> Vec<u8> {
        let (mut out, mut directory) = (Vec::new(), Vec::new());
        for (name, flags) in entries {
            let local = out.len() as u32;
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&[20, 0]);
            out.extend_from_slice(&flags.to_le_bytes());
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 4 + 4]);
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&expanded.to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            directory.extend_from_slice(b"PK\x01\x02");
            directory.extend_from_slice(&[20, 0, 20, 0]);
            directory.extend_from_slice(&flags.to_le_bytes());
            directory.extend_from_slice(&method.to_le_bytes());
            directory.extend_from_slice(&[0; 4 + 4]);
            directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&expanded.to_le_bytes());
            directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
            directory.extend_from_slice(&[0; 2 + 2 + 2 + 2 + 4]);
            directory.extend_from_slice(&local.to_le_bytes());
            directory.extend_from_slice(name.as_bytes());
        }
        let offset = out.len() as u32;
        out.extend_from_slice(&directory);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    const ID: &str = "01234567-1234-1234-1234-123456789abc";

    #[test]
    fn a_generated_archive_verifies_and_foreign_or_unsafe_ones_are_refused() {
        let good = zip(&[
            ("image-01.png", 0),
            ("normal.png", 0),
            ("relight-right.png", 0),
            ("manifest.json", 0),
        ]);
        assert_eq!(verify_archive(&good), Ok(4));
        for bad in [
            zip(&[
                ("image-01.png", 0),
                ("../evil.png", 0),
                ("manifest.json", 0),
            ]),
            zip(&[
                ("image-01.png", 0),
                ("maps/normal.png", 0),
                ("manifest.json", 0),
            ]),
            zip(&[
                ("image-01.png", 0),
                ("preview-01.png", 0),
                ("manifest.json", 0),
            ]),
            zip(&[("image-01.png", 0), ("secret.txt", 0), ("manifest.json", 0)]),
            zip(&[
                ("image-01.png", 0),
                ("image-01.png", 0),
                ("manifest.json", 0),
            ]),
            zip(&[("image-01.png", 1), ("manifest.json", 0)]),
            zip(&[("image-01.png", 0)]),
            zip(&[("normal.png", 0), ("manifest.json", 0)]),
        ] {
            assert!(verify_archive(&bad).is_err());
        }
        assert!(verify_archive(b"not a zip at all, definitely not").is_err());
        assert!(verify_archive(&good[..good.len() - 5]).is_err());
        let mut moved = good.clone();
        let at = moved.len() - 6;
        moved[at..at + 4].copy_from_slice(&1_000_000u32.to_le_bytes());
        assert!(verify_archive(&moved).is_err());
    }

    #[test]
    fn only_the_open_chats_exact_archive_is_addressable() {
        let url = |s: &str| url::Url::parse(s).unwrap();
        let ok = url(&format!(
            "file:///w/p%20q/.enki/generated-images/{ID}/images.zip"
        ));
        assert_eq!(archive_reference(&ok, "/w/p q").as_deref(), Some(ID));
        assert_eq!(archive_reference(&ok, "/w/p q/").as_deref(), Some(ID));
        assert!(archive_reference(&ok, "/w/other").is_none());
        assert!(archive_reference(&ok, "/w").is_none());
        assert!(archive_reference(&ok, "").is_none());
        for bad in [
            format!("file:///w/p%20q/.enki/generated-images/{ID}/image-01.png"),
            format!("file:///w/p%20q/.enki/generated-images/{ID}/images.zip?x=1"),
            format!("file:///w/p%20q/.enki/generated-images/{ID}/images.zip#x"),
            format!("file://host/w/p%20q/.enki/generated-images/{ID}/images.zip"),
            "file:///w/p%20q/.enki/generated-images/not-an-id/images.zip".to_string(),
            format!("file:///w/p%20q/.enki/other/{ID}/images.zip"),
            format!("https://example.com/w/p%20q/.enki/generated-images/{ID}/images.zip"),
            format!("file:///w/p%20q/.enki/generated-images/{ID}/../../../../etc/images.zip"),
            format!("file:///w/p%2Fq/.enki/generated-images/{ID}/images.zip"),
        ] {
            assert!(archive_reference(&url(&bad), "/w/p q").is_none(), "{bad}");
        }
        // A remote host's path is matched lexically, independent of this OS.
        let remote = url(&format!(
            "file:///C:/u/p/.enki/generated-images/{ID}/images.zip"
        ));
        assert_eq!(archive_reference(&remote, "C:\\u\\p").as_deref(), Some(ID));
    }

    #[test]
    fn local_zip_records_must_match_central_names_flags_sizes_and_extents() {
        let good = zip(&[("image-01.png", 0), ("manifest.json", 0)]);
        let central = good
            .windows(4)
            .position(|part| part == b"PK\x01\x02")
            .unwrap();
        let second = central + 46 + "image-01.png".len();
        let mut cases = Vec::new();
        let mut name = good.clone();
        name[30..42].copy_from_slice(b"../evil0.png");
        cases.push((
            "local traversal hidden behind an allowed central name",
            name,
        ));
        for (field, value) in [(6, 1u16), (8, 8), (26, 13), (28, 1)] {
            let mut bad = good.clone();
            bad[field..field + 2].copy_from_slice(&value.to_le_bytes());
            cases.push(("local flag/method/name/extra mismatch", bad));
        }
        for field in [14, 18, 22] {
            let mut bad = good.clone();
            bad[field..field + 4].copy_from_slice(&2u32.to_le_bytes());
            cases.push(("local CRC or size mismatch", bad));
        }
        let mut reused = good.clone();
        reused[second + 42..second + 46].copy_from_slice(&0u32.to_le_bytes());
        cases.push(("two central entries reuse one local header", reused));
        // Both headers claim a larger first stored entry, overlapping the next
        // record. Matching sizes alone must not establish a valid payload span.
        let mut overlap = good.clone();
        for field in [18, 22, central + 20, central + 24] {
            overlap[field..field + 4].copy_from_slice(&2u32.to_le_bytes());
        }
        cases.push(("overlapping local payloads", overlap));
        let mut link = good.clone();
        link[central + 38..central + 42].copy_from_slice(&0xa1ff0000u32.to_le_bytes());
        cases.push(("central Unix symlink", link));
        let mut comment = good.clone();
        let end = comment.len();
        comment[end - 2..].copy_from_slice(&1u16.to_le_bytes());
        cases.push(("truncated EOCD comment", comment));
        for (label, bad) in cases {
            assert!(verify_archive(&bad).is_err(), "{label}");
        }
        assert_eq!(verify_archive(&good), Ok(2));
    }

    #[test]
    fn generated_deflate_is_supported_but_advertised_expansion_and_hidden_records_are_bounded() {
        // A real raw-DEFLATE stored block containing 'x'. CRC is intentionally
        // not computed by the structural verifier or this fixture builder.
        let payload = [1, 1, 0, 0xfe, 0xff, b'x'];
        let entries = [("image-01.png", 0), ("manifest.json", 0)];
        assert_eq!(
            verify_archive(&zip_payload(&entries, 8, &payload, 1)),
            Ok(2)
        );
        assert!(verify_archive(&zip_payload(&entries, 8, &payload, 12 * 1024 * 1024 + 1)).is_err());
        assert!(verify_archive(&zip_payload(&entries, 0, b"x", 2)).is_err());
        let good = zip(&entries);
        let central = good
            .windows(4)
            .position(|part| part == b"PK\x01\x02")
            .unwrap();
        let mut hidden = good.clone();
        hidden.insert(central, b'x');
        let end = hidden.len();
        hidden[end - 6..end - 2].copy_from_slice(&((central + 1) as u32).to_le_bytes());
        assert!(
            verify_archive(&hidden).is_err(),
            "unreferenced bytes before the directory"
        );
        let mut outside = zip_payload(&entries, 8, &payload, 1);
        let central = outside
            .windows(4)
            .position(|part| part == b"PK\x01\x02")
            .unwrap();
        for field in [18, central + 20] {
            outside[field..field + 4].copy_from_slice(&(ARCHIVE_LIMIT as u32).to_le_bytes());
        }
        assert!(
            verify_archive(&outside).is_err(),
            "compressed payload outside its local area"
        );
    }

    struct ArchiveFixture {
        root: std::path::PathBuf,
        file: std::path::PathBuf,
    }
    impl ArchiveFixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("enki-archive-read-{}-{nonce}", std::process::id()));
            fs::create_dir(&root).unwrap();
            let file = root
                .join("proj/.enki/generated-images")
                .join(ID)
                .join("images.zip");
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, zip(&[("image-01.png", 0), ("manifest.json", 0)])).unwrap();
            Self { root, file }
        }
    }
    impl Drop for ArchiveFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn an_endless_or_growing_reader_cannot_read_past_limit_plus_one() {
        struct Growing {
            read: usize,
        }
        impl std::io::Read for Growing {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer.fill(b'x');
                self.read += buffer.len();
                Ok(buffer.len())
            }
        }
        let mut growing = Growing { read: 0 };
        assert!(bounded_archive_bytes(&mut growing, 16).is_err());
        assert_eq!(
            growing.read, 17,
            "EOF is not needed to enforce the byte bound"
        );
        let mut finite = std::io::Cursor::new(b"exact bytes");
        assert_eq!(
            bounded_archive_bytes(&mut finite, 16).unwrap(),
            b"exact bytes"
        );
    }

    #[test]
    fn an_oversized_regular_archive_and_directory_are_refused_before_reading() {
        let fixture = ArchiveFixture::new();
        fs::OpenOptions::new()
            .write(true)
            .open(&fixture.file)
            .unwrap()
            .set_len(ARCHIVE_LIMIT as u64 + 1)
            .unwrap();
        assert!(local_archive(&fixture.file).is_err());
        fs::remove_file(&fixture.file).unwrap();
        fs::create_dir(&fixture.file).unwrap();
        assert!(local_archive(&fixture.file).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn every_result_link_and_a_swapped_fifo_are_refused_without_waiting() {
        use std::os::unix::ffi::OsStrExt;
        for level in 0..4 {
            let fixture = ArchiveFixture::new();
            let component = fixture.file.ancestors().nth(level).unwrap();
            let target = fixture.root.join("moved");
            fs::rename(component, &target).unwrap();
            std::os::unix::fs::symlink(&target, component).unwrap();
            assert!(
                local_archive(&fixture.file).is_err(),
                "linked result level {level}"
            );
        }
        let fixture = ArchiveFixture::new();
        fs::remove_file(&fixture.file).unwrap();
        let name = std::ffi::CString::new(fixture.file.as_os_str().as_bytes()).unwrap();
        // SAFETY: an owned fixture path, no other process or owner data.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(local_archive(&fixture.file).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn opened_archive_is_a_pinned_snapshot_and_growth_after_stat_is_still_bounded() {
        use std::io::Write;
        let fixture = ArchiveFixture::new();
        let expected = fs::read(&fixture.file).unwrap();
        let mut opened = open_archive(&fixture.file).unwrap();
        let job = fixture.file.parent().unwrap();
        let moved = fixture.root.join("original-job");
        fs::rename(job, &moved).unwrap();
        let outside = fixture.root.join("elsewhere");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("images.zip"), b"DO_NOT_READ_OTHER_FILE").unwrap();
        std::os::unix::fs::symlink(&outside, job).unwrap();
        assert_eq!(
            bounded_archive_bytes(&mut opened.file, ARCHIVE_LIMIT).unwrap(),
            expected
        );
        assert!(local_archive(&fixture.file).is_err());
        assert_eq!(
            fs::read(outside.join("images.zip")).unwrap(),
            b"DO_NOT_READ_OTHER_FILE"
        );
        // Stat a small file, then grow that exact opened object before reading.
        let fixture = ArchiveFixture::new();
        fs::write(&fixture.file, b"x").unwrap();
        let mut opened = open_archive(&fixture.file).unwrap();
        assert!(opened.file.metadata().unwrap().len() <= 16);
        fs::OpenOptions::new()
            .append(true)
            .open(&fixture.file)
            .unwrap()
            .write_all(&[b'y'; 100])
            .unwrap();
        assert!(bounded_archive_bytes(&mut opened.file, 16).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_result_folder_is_refused_and_a_real_one_is_read() {
        let root = std::env::temp_dir().join(format!("enki-archive-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let job = root.join("proj/.enki/generated-images").join(ID);
        fs::create_dir_all(&job).unwrap();
        let bytes = zip(&[("image-01.png", 0), ("manifest.json", 0)]);
        fs::write(job.join("images.zip"), &bytes).unwrap();
        assert_eq!(local_archive(&job.join("images.zip")).unwrap(), bytes);
        // A job folder that is a link to elsewhere is not followed.
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("images.zip"), &bytes).unwrap();
        let linked = root.join("proj/.enki/generated-images/11111111-1111-1111-1111-111111111111");
        std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
        assert!(local_archive(&linked.join("images.zip")).is_err());
        // The owner's chosen destination receives the exact bytes; no staging remains.
        let destination = root.join("saved.zip");
        write_choice(&destination, &bytes).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert!(!root.join(".saved.zip.enki-part").exists());
        fs::remove_dir_all(root).unwrap();
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
mod remote_tests {
    use super::*;
    #[test]
    fn references_do_not_depend_on_client_os() {
        for root in ["file:///C:/project", "file:///private/tmp/project"] {
            let u=url::Url::parse(&format!("{root}/.enki/generated-images/01234567-1234-1234-1234-123456789abc/preview-normal.png")).unwrap();
            assert_eq!(remote_reference(&u).unwrap().1, "preview-normal.png")
        }
        let u=url::Url::parse("https://example.com/.enki/generated-images/01234567-1234-1234-1234-123456789abc/normal.png").unwrap();
        assert!(remote_reference(&u).is_none());
    }
}
