//! Original user-authorized image bytes, scoped to an actual engine/chat/request.
//! No arbitrary file or URL is read; model tool arguments cannot change this context.
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, Write},
    path::Path,
};

const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_TOTAL: usize = 16 * 1024 * 1024;
const MAX_STATE: usize = 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    name: String,
    mime: String,
    data: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UnsupportedSource {
    name: String,
    mime: String,
    reason: String,
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_' || v == b'-')
}
fn private_directory(path: &Path) -> Result<(), String> {
    if path.is_symlink() {
        return Err("Каталог исходных изображений не должен быть ссылкой".into());
    }
    fs::create_dir_all(path).map_err(|_| "Не удалось сохранить исходные изображения")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Не удалось защитить исходные изображения")?;
    }
    Ok(())
}
fn jpeg_orientation(bytes: &[u8]) -> Option<u16> {
    let mut at = 2;
    while at + 4 <= bytes.len() && bytes.get(at) == Some(&0xff) {
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let size = u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as usize;
        if size < 2 {
            return None;
        }
        let payload = bytes.get(at + 2..at.checked_add(size)?)?;
        if marker == 0xe1 && payload.starts_with(b"Exif\0\0") {
            let tiff = &payload[6..];
            let little = match tiff.get(..2)? {
                b"II" => true,
                b"MM" => false,
                _ => return None,
            };
            let short = |i| {
                let v: [u8; 2] = tiff.get(i..i + 2)?.try_into().ok()?;
                Some(if little {
                    u16::from_le_bytes(v)
                } else {
                    u16::from_be_bytes(v)
                })
            };
            let long = |i| {
                let v: [u8; 4] = tiff.get(i..i + 4)?.try_into().ok()?;
                Some(if little {
                    u32::from_le_bytes(v)
                } else {
                    u32::from_be_bytes(v)
                })
            };
            if short(2)? != 42 {
                return None;
            }
            let start = long(4)? as usize;
            for n in 0..usize::from(short(start)?).min(1024) {
                let offset = start.checked_add(2)?.checked_add(n * 12)?;
                if short(offset)? == 0x112 && short(offset + 2)? == 3 && long(offset + 4)? == 1 {
                    return short(offset + 8);
                }
            }
        }
        at += size;
    }
    None
}
fn dimensions(bytes: &[u8], mime: &str) -> Option<(u32, u32)> {
    match mime {
        "image/png"
            if bytes.len() >= 33
                && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                && &bytes[12..16] == b"IHDR" =>
        {
            Some((
                u32::from_be_bytes(bytes[16..20].try_into().ok()?),
                u32::from_be_bytes(bytes[20..24].try_into().ok()?),
            ))
        }
        "image/jpeg" if bytes.starts_with(b"\xff\xd8") => {
            let mut at = 2;
            while at + 4 <= bytes.len() {
                if bytes[at] != 0xff {
                    return None;
                }
                while at < bytes.len() && bytes[at] == 0xff {
                    at += 1;
                }
                let marker = *bytes.get(at)?;
                at += 1;
                if marker == 0xda || marker == 0xd9 {
                    return None;
                }
                if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                    continue;
                }
                let length = u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as usize;
                if length < 2 || at + length > bytes.len() {
                    return None;
                }
                if [
                    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
                ]
                .contains(&marker)
                    && length >= 7
                {
                    let width = u16::from_be_bytes(bytes[at + 5..at + 7].try_into().ok()?) as u32;
                    let height = u16::from_be_bytes(bytes[at + 3..at + 5].try_into().ok()?) as u32;
                    return Some(if (5..=8).contains(&jpeg_orientation(bytes).unwrap_or(1)) {
                        (height, width)
                    } else {
                        (width, height)
                    });
                }
                at += length;
            }
            None
        }
        "image/webp"
            if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" =>
        {
            let le24 = |at| {
                Some(u32::from_le_bytes([
                    *bytes.get(at)?,
                    *bytes.get(at + 1)?,
                    *bytes.get(at + 2)?,
                    0,
                ]))
            };
            match &bytes[12..16] {
                b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
                b"VP8 " if &bytes[23..26] == b"\x9d\x01\x2a" => Some((
                    (u16::from_le_bytes(bytes[26..28].try_into().ok()?) & 0x3fff) as u32,
                    (u16::from_le_bytes(bytes[28..30].try_into().ok()?) & 0x3fff) as u32,
                )),
                b"VP8L" if bytes[20] == 0x2f => {
                    let packed = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
                    Some(((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn stage_at(
    root: &Path,
    engine: &str,
    session: &str,
    directory: &str,
    message: &str,
    images: Vec<Source>,
    mut unsupported: Vec<UnsupportedSource>,
    supports_vision: bool,
    automatic: bool,
) -> Result<(), String> {
    if !["opencode", "pi"].contains(&engine)
        || !safe_id(session)
        || !safe_id(message)
        || images.len() > 4
        || unsupported.len() > 12
    {
        return Err("Некорректный контекст исходных изображений".into());
    }
    let directory = fs::canonicalize(directory).map_err(|_| "Папка чата недоступна")?;
    if !directory.is_dir() {
        return Err("Папка чата недоступна".into());
    }
    let canonical = directory.to_string_lossy();
    // Node realpath returns ordinary Win32 paths, not Rust's verbatim prefix.
    let canonical = if cfg!(windows) {
        if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            canonical
                .strip_prefix(r"\\?\")
                .unwrap_or(&canonical)
                .to_string()
        }
    } else {
        canonical.into_owned()
    };
    let mut total = 0;
    let mut sources = Vec::new();
    for image in images {
        if image.name.len() > 1024
            || image.name.chars().any(char::is_control)
            || image.data.len() > MAX_IMAGE.div_ceil(3) * 4
        {
            return Err("Исходное изображение слишком большое: максимум 8 МБ".into());
        }
        let raw = STANDARD
            .decode(&image.data)
            .map_err(|_| "Не удалось прочитать исходное изображение")?;
        total += raw.len();
        let (width, height) = dimensions(&raw, &image.mime).unwrap_or((0, 0));
        if raw.len() > MAX_IMAGE
            || total > MAX_TOTAL
            || width == 0
            || height == 0
            || width > 4096
            || height > 4096
            || u64::from(width) * u64::from(height) > 16_000_000
        {
            if unsupported.len() < 12 {
                unsupported.push(UnsupportedSource { name:image.name, mime:image.mime,
                    reason:"Для редактирования нужен PNG/JPEG/WebP до 8 МБ, 4096 по стороне и 16 Мп; обычное вложение сохранено в сообщении".into() });
            }
            continue;
        }
        sources.push(serde_json::json!({"name":image.name,"mime":image.mime,"data":image.data,"sha256":format!("{:x}",Sha256::digest(&raw)),"width":width,"height":height}));
    }
    if unsupported.iter().any(|v| {
        v.name.len() > 1024
            || v.mime.len() > 100
            || v.reason.len() > 300
            || v.name.chars().any(char::is_control)
    }) {
        return Err("Некорректное описание исходного изображения".into());
    }
    private_directory(root)?;
    let contexts = root.join("image-context");
    private_directory(&contexts)?;
    let key =
        serde_json::to_vec(&(&canonical, engine, session)).map_err(|_| "Некорректная сессия")?;
    let hash = format!("{:x}", Sha256::digest(&key));
    let destination = contexts.join(format!("{hash}.json"));
    let lock_path = contexts.join(format!("{hash}.context.lock"));
    if destination.is_symlink() || lock_path.is_symlink() {
        return Err("Контекст изображения не должен быть ссылкой".into());
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|_| "Контекст изображения недоступен")?;
    lock.try_lock_exclusive()
        .map_err(|_| "Контекст изображения занят, повторите отправку")?;
    let mut images_from_previous = false;
    let prior = if (automatic || sources.is_empty()) && destination.exists() {
        let metadata =
            fs::symlink_metadata(&destination).map_err(|_| "Контекст изображения недоступен")?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 24 * 1024 * 1024
        {
            return Err("Контекст изображения недоступен".into());
        }
        let mut current: serde_json::Value = serde_json::from_slice(
            &fs::read(&destination).map_err(|_| "Контекст изображения недоступен")?,
        )
        .map_err(|_| "Контекст изображения повреждён")?;
        if current["version"] != 1
            || current["directory"] != canonical
            || current["engine"] != engine
            || current["sessionID"] != session
        {
            return Err("Контекст изображения не соответствует сессии".into());
        }
        // Timers retain the human request and originals, while review support
        // follows the model actually selected for this scheduled dispatch.
        current["supportsVision"] = serde_json::Value::Bool(supports_vision);
        if automatic {
            Some(current)
        } else {
            sources = current["images"]
                .as_array()
                .filter(|images| images.len() <= 4)
                .cloned()
                .ok_or("Контекст исходных изображений повреждён")?;
            images_from_previous = !sources.is_empty();
            None
        }
    } else {
        None
    };
    let message = if automatic {
        format!("automatic_{hash}")
    } else {
        message.to_string()
    };
    let payload = serde_json::to_vec(&prior.unwrap_or_else(|| serde_json::json!({"version":1,"directory":canonical,"engine":engine,"sessionID":session,"messageID":message,"images":sources,"imagesFromPrevious":images_from_previous,"unsupported":unsupported,"supportsVision":supports_vision}))).map_err(|_| "Не удалось подготовить исходные изображения")?;
    let temporary = contexts.join(format!(
        "{hash}.{}.tmp",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Не удалось определить время")?
            .as_nanos()
    ));
    let result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&temporary)
            .map_err(|_| "Не удалось сохранить исходные изображения")?;
        output
            .write_all(&payload)
            .and_then(|_| output.sync_all())
            .map_err(|_| "Не удалось сохранить исходные изображения")?;
        fs::rename(&temporary, &destination)
            .map_err(|_| "Не удалось обновить исходные изображения".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn image_prompt_context(
    window: tauri::WebviewWindow,
    engine: String,
    session_id: String,
    directory: String,
    message_id: String,
    images: Vec<Source>,
    unsupported: Vec<UnsupportedSource>,
    supports_vision: bool,
    automatic: Option<bool>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Недоступно в этом окне".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        stage_at(
            &crate::capabilities::root()?,
            &engine,
            &session_id,
            &directory,
            &message_id,
            images,
            unsupported,
            supports_vision,
            automatic.unwrap_or(false),
        )
    })
    .await
    .map_err(|_| "Не удалось подготовить исходные изображения")?
}

fn state_valid(value: &serde_json::Value) -> bool {
    value["version"] == 1
        && value["requests"].is_object()
        && value["jobs"].is_array()
        && (value["latest"].is_null() || value["latest"].is_object())
}

fn is_lock_contention(error: &std::io::Error, contended_raw: Option<i32>) -> bool {
    // Windows fs2 uses ERROR_LOCK_VIOLATION, which std does not classify as
    // WouldBlock. Match the platform's explicit fs2 code, never arbitrary errors.
    error.kind() == std::io::ErrorKind::WouldBlock
        || matches!((error.raw_os_error(), contended_raw), (Some(actual), Some(expected)) if actual == expected)
}

fn state_exchange(
    root: &Path,
    id: &str,
    mut input: impl BufRead,
    mut output: impl Write,
) -> Result<(), String> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Некорректная область изображений".into());
    }
    private_directory(root)?;
    let file = root.join(format!("{id}.state.json"));
    let lock_path = root.join(format!("{id}.state.lock"));
    if file.is_symlink() || lock_path.is_symlink() {
        return Err("Состояние изображений не должно быть ссылкой".into());
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(lock_path)
        .map_err(|_| "Состояние изображений недоступно")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let contended_raw = fs2::lock_contended_error().raw_os_error();
    loop {
        match lock.try_lock_exclusive() {
            Ok(()) => break,
            Err(e)
                if is_lock_contention(&e, contended_raw)
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(25))
            }
            Err(_) => return Err("Состояние изображений занято; повторите чтение статуса".into()),
        }
    }
    let state = match fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            serde_json::json!({"version":1,"requests":{},"jobs":[],"latest":null})
        }
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= MAX_STATE as u64 =>
        {
            serde_json::from_slice(
                &fs::read(&file).map_err(|_| "Состояние изображений недоступно")?,
            )
            .map_err(|_| "Состояние изображений повреждено")?
        }
        _ => return Err("Состояние изображений недоступно".into()),
    };
    if !state_valid(&state) {
        return Err("Состояние изображений повреждено".into());
    }
    serde_json::to_writer(&mut output, &state)
        .map_err(|_| "Не удалось прочитать состояние изображений")?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|_| "Клиент изображений отключился")?;
    let mut data = Vec::new();
    // EOF without a complete replacement means rollback; dropping the File
    // releases the OS lock on normal exit and on process termination alike.
    use std::io::Read;
    input
        .by_ref()
        .take((MAX_STATE + 1) as u64)
        .read_until(b'\n', &mut data)
        .map_err(|_| "Клиент изображений отключился")?;
    if data.is_empty() {
        return Ok(());
    }
    if data.len() > MAX_STATE || !data.ends_with(b"\n") {
        return Err("Состояние изображений слишком большое или неполное".into());
    }
    let next: serde_json::Value =
        serde_json::from_slice(&data).map_err(|_| "Некорректное состояние изображений")?;
    if !state_valid(&next) {
        return Err("Некорректное состояние изображений".into());
    }
    let temporary = root.join(format!(
        "{id}.{}.tmp",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Не удалось определить время")?
            .as_nanos()
    ));
    let result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut writer = options
            .open(&temporary)
            .map_err(|_| "Не удалось сохранить состояние изображений")?;
        writer
            .write_all(&data)
            .and_then(|_| writer.sync_all())
            .map_err(|_| "Не удалось сохранить состояние изображений")?;
        fs::rename(&temporary, &file)
            .map_err(|_| "Не удалось обновить состояние изображений".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result?;
    output
        .write_all(b"{\"ok\":true}\n")
        .and_then(|_| output.flush())
        .map_err(|_| "Клиент изображений отключился")?;
    Ok(())
}

pub fn state_lock_cli() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Некорректный вызов состояния изображений".into());
    }
    let root = crate::capabilities::root()?;
    private_directory(&root)?;
    state_exchange(
        &root.join("image-context"),
        &args[2],
        std::io::stdin().lock(),
        std::io::stdout().lock(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "enki-image-context-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn source() -> Source {
        Source {
            name: "photo.png".into(),
            mime: "image/png".into(),
            data: STANDARD.encode(include_bytes!("../icons/32x32.png")),
        }
    }
    fn context(root: &Path) -> serde_json::Value {
        let file = fs::read_dir(root.join("image-context"))
            .unwrap()
            .map(|v| v.unwrap().path())
            .find(|p| p.extension().is_some_and(|v| v == "json"))
            .unwrap();
        serde_json::from_slice(&fs::read(file).unwrap()).unwrap()
    }
    #[test]
    fn original_bytes_request_identity_and_engine_scope_survive_restart() {
        let root = root();
        fs::create_dir(&root).unwrap();
        for (engine, session, message) in [
            ("opencode", "ses_a", "msg_1"),
            ("pi", "ses_a", "msg_2"),
            ("opencode", "ses_b", "msg_3"),
        ] {
            stage_at(
                &root,
                engine,
                session,
                root.to_str().unwrap(),
                message,
                vec![source()],
                vec![],
                true,
                false,
            )
            .unwrap();
        }
        let files: Vec<_> = fs::read_dir(root.join("image-context"))
            .unwrap()
            .map(|v| v.unwrap().path())
            .filter(|p| p.extension().is_some_and(|v| v == "json"))
            .collect();
        assert_eq!(files.len(), 3);
        for file in files {
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
            assert_eq!(
                STANDARD
                    .decode(value["images"][0]["data"].as_str().unwrap())
                    .unwrap(),
                include_bytes!("../icons/32x32.png")
            );
            assert_eq!(value["images"][0]["width"], 32);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn timers_preserve_request_and_sources_but_capture_current_vision_support() {
        let root = root();
        fs::create_dir(&root).unwrap();
        stage_at(
            &root,
            "pi",
            "same",
            root.to_str().unwrap(),
            "human",
            vec![source()],
            vec![],
            true,
            false,
        )
        .unwrap();
        stage_at(
            &root,
            "pi",
            "same",
            root.to_str().unwrap(),
            "wake",
            vec![],
            vec![],
            false,
            true,
        )
        .unwrap();
        let first = context(&root);
        assert_eq!(first["messageID"], "human");
        assert_eq!(first["images"].as_array().unwrap().len(), 1);
        assert_eq!(first["supportsVision"], false);
        stage_at(
            &root,
            "pi",
            "same",
            root.to_str().unwrap(),
            "next_human",
            vec![],
            vec![],
            false,
            false,
        )
        .unwrap();
        assert_eq!(context(&root)["messageID"], "next_human");
        assert_eq!(context(&root)["images"].as_array().unwrap().len(), 1);
        assert_eq!(context(&root)["imagesFromPrevious"], true);
        let mut replacement = source();
        replacement.name = "replacement.png".into();
        stage_at(
            &root,
            "pi",
            "same",
            root.to_str().unwrap(),
            "new_attachment",
            vec![replacement],
            vec![],
            true,
            false,
        )
        .unwrap();
        assert_eq!(context(&root)["images"][0]["name"], "replacement.png");
        assert_eq!(context(&root)["imagesFromPrevious"], false);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oversized_image_does_not_block_ordinary_chat_but_is_not_an_edit_source() {
        let root = root();
        fs::create_dir(&root).unwrap();
        let mut bad = source();
        let mut raw = STANDARD.decode(&bad.data).unwrap();
        raw[16..20].copy_from_slice(&5000u32.to_be_bytes());
        bad.data = STANDARD.encode(raw);
        stage_at(
            &root,
            "pi",
            "same",
            root.to_str().unwrap(),
            "msg",
            vec![bad],
            vec![],
            true,
            false,
        )
        .unwrap();
        let value = context(&root);
        assert_eq!(value["images"].as_array().unwrap().len(), 0);
        assert_eq!(value["unsupported"][0]["name"], "photo.png");
        assert!(stage_at(
            &root,
            "pi",
            "../escape",
            root.to_str().unwrap(),
            "msg",
            vec![],
            vec![],
            true,
            false
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn state_exchange_commits_atomically_and_eof_or_bad_data_rolls_back() {
        let root = root();
        let id = "a".repeat(64);
        let next =
            serde_json::json!({"version":1,"requests":{"human":[1]},"jobs":[],"latest":null});
        let data = format!("{next}\n");
        let mut out = Vec::new();
        state_exchange(&root, &id, std::io::Cursor::new(data.as_bytes()), &mut out).unwrap();
        assert!(out.ends_with(b"{\"ok\":true}\n"));
        let file = root.join(format!("{id}.state.json"));
        let original = fs::read(&file).unwrap();
        state_exchange(&root, &id, std::io::Cursor::new([]), Vec::new()).unwrap();
        assert_eq!(fs::read(&file).unwrap(), original);
        assert!(state_exchange(&root, &id, std::io::Cursor::new(b"{}\n"), Vec::new()).is_err());
        assert_eq!(fs::read(&file).unwrap(), original);
        assert!(state_exchange(&root, "../escape", std::io::Cursor::new([]), Vec::new()).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::remove_file(&file).unwrap();
            std::os::unix::fs::symlink("/etc/passwd", &file).unwrap();
            assert!(state_exchange(&root, &id, std::io::Cursor::new([]), Vec::new()).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recognizes_windows_lock_contention_without_retrying_unrelated_errors() {
        // fs2's Windows LockFileEx contention contract is Win32 error 33, even
        // though its ErrorKind is Uncategorized. Exercise that raw-code path on
        // every host, then use the actual OS lock in the following test.
        assert!(is_lock_contention(
            &std::io::Error::from_raw_os_error(33),
            Some(33)
        ));
        assert!(!is_lock_contention(
            &std::io::Error::from_raw_os_error(13),
            Some(33)
        ));
        assert!(!is_lock_contention(
            &std::io::Error::other("not an OS lock conflict"),
            None
        ));
        assert!(is_lock_contention(
            &std::io::Error::from(std::io::ErrorKind::WouldBlock),
            None
        ));
    }
    #[test]
    fn state_uses_os_lock_and_survives_a_previous_owner_dropping_it() {
        let root = root();
        private_directory(&root).unwrap();
        let id = "b".repeat(64);
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(format!("{id}.state.lock")))
            .unwrap();
        lock.lock_exclusive().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let child_root = root.clone();
        let worker = std::thread::spawn(move || {
            let mut out = Vec::new();
            let result = state_exchange(&child_root, &id, std::io::Cursor::new([]), &mut out);
            sender.send((result, out)).unwrap();
        });
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        // The lock file remains; it is the OS ownership, not deleting a stale
        // marker, that lets the next process proceed safely.
        drop(lock);
        let (result, output) = receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        result.unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&output).is_ok());
        worker.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn jpeg_exif_rotation_swaps_geometry_without_changing_source_bytes() {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1, 0, 34];
        bytes.extend_from_slice(
            b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0",
        );
        bytes.extend_from_slice(&[0xff, 0xc0, 0, 7, 8, 0, 20, 0, 10]);
        assert_eq!(jpeg_orientation(&bytes), Some(6));
        assert_eq!(dimensions(&bytes, "image/jpeg"), Some((20, 10)));
    }
}
