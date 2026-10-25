//! Compare-and-swap writes for Enki-owned configuration files.
//!
//! Agent configuration (Pi `models.json`, runtime settings) is owned by the
//! Enki Runtime and edited through its versioned API. External engine
//! configuration (OpenCode `opencode.json`, `~/.pi/agent`) is never written.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn read_at(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let metadata = fs::metadata(path).map_err(|_| "Не удалось прочитать конфигурацию")?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("Конфигурация слишком велика или не является файлом".into());
    }
    fs::read_to_string(path).map_err(|_| "Конфигурация должна быть в UTF-8".into())
}

pub(crate) fn write_at(path: &Path, expected: &str, content: &str) -> Result<(), String> {
    let current = read_at(path)?;
    if current != expected {
        return Err(
            "Конфигурация изменилась на диске. Обновите настройки и повторите изменение".into(),
        );
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Не удалось определить время")?
        .as_nanos();
    let temp = path.with_extension(format!("ocdesktop-{now}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "Не удалось создать временный файл")?;
    let result = (|| -> Result<(), String> {
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "Не удалось записать конфигурацию")?;
        if path.exists() {
            let permissions = fs::metadata(path)
                .map_err(|_| "Не удалось прочитать права конфигурации")?
                .permissions();
            fs::set_permissions(&temp, permissions)
                .map_err(|_| "Не удалось сохранить права конфигурации")?;
            let backup = path.with_extension(format!("backup-{now}"));
            fs::copy(path, backup).map_err(|_| "Не удалось создать резервную копию")?;
        }
        fs::rename(&temp, path).map_err(|_| "Не удалось заменить конфигурацию".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_stale_writes_and_keeps_original_backup() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "ocdesktop-config-test-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("settings.json");
        let original = "{\n  // keep this comment\n  \"plugin\": []\n}\n";
        fs::write(&path, original).unwrap();
        assert!(write_at(&path, "stale", "{}").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        write_at(&path, original, "{\"plugin\":[\"example\"]}\n").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"plugin\":[\"example\"]}\n"
        );
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("backup-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), original);
        fs::remove_dir_all(&dir).unwrap();
    }
}
