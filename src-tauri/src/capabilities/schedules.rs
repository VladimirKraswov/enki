//! Shared schedule-tool registration. Retains user edits and disabled state.
use super::{private, read_at, validate, Server};
use fs2::FileExt;
use std::{fs, path::Path};
pub(super) fn ensure(root: &Path) -> Result<(), String> {
    private(root)?;
    let lock_path = root.join("registry.lock");
    if lock_path.is_symlink() {
        return Err("Блокировка инструментов не должна быть ссылкой".into());
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|_| "Реестр таймеров недоступен")?;
    lock.try_lock_exclusive()
        .map_err(|_| "Реестр инструментов занят")?;
    let (mut registry, expected) = read_at(root, "global")?;
    if registry.servers.iter().any(|s| s.id == "enki-schedules") {
        return Ok(());
    }
    {
        registry.servers.push(Server {
            id: "enki-schedules".into(),
            name: "Таймеры Enki".into(),
            enabled: true,
            kind: "stdio".into(),
            command: std::env::current_exe()
                .map_err(|_| "Не найден Enki")?
                .display()
                .to_string(),
            args: vec!["--schedule-mcp".into()],
            url: String::new(),
            env_keys: vec![],
            bearer: false,
            auth_revision: None,
        });
    }
    validate(&registry)?;
    crate::config::write_at(
        &root.join("global.json"),
        &expected,
        &serde_json::to_string_pretty(&registry).map_err(|_| "Некорректный реестр")?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adds_only_schedule_service_and_keeps_custom_disabled_entries() {
        let root = std::env::temp_dir().join(format!(
            "enki-schedules-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        ensure(&root).unwrap();
        let (mut registry, _) = read_at(&root, "global").unwrap();
        assert_eq!(registry.servers.len(), 1);
        assert_eq!(registry.servers[0].args, ["--schedule-mcp"]);
        registry.servers[0].enabled = false;
        registry.servers[0].name = "Custom".into();
        registry.servers[0].command = root.join("custom-program").display().to_string();
        fs::write(
            root.join("global.json"),
            serde_json::to_vec(&registry).unwrap(),
        )
        .unwrap();
        let before = fs::read(root.join("global.json")).unwrap();
        ensure(&root).unwrap();
        assert_eq!(fs::read(root.join("global.json")).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
}
