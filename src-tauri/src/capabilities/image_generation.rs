//! Shared image-generation registration. Retains user edits and disabled state.
use super::{private, read_at, recorded_node, runtime_ready_at, validate, Server};
use fs2::FileExt;
use std::{fs, path::Path};
pub(super) fn ensure(root: &Path) -> Result<(), String> {
    let runtime = root.join("runtime");
    if !runtime_ready_at(&runtime) {
        return Ok(());
    }
    let Some(node) = recorded_node(&runtime)? else {
        return Ok(());
    };
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
        .map_err(|_| "Реестр генератора недоступен")?;
    lock.try_lock_exclusive()
        .map_err(|_| "Реестр инструментов занят")?;
    crate::images::migrate_hub_settings_at(root)?;
    let (mut registry, expected) = read_at(root, "global")?;
    if registry.servers.iter().any(|s| s.id == "enki-images") {
        return Ok(());
    }
    registry.servers.push(Server {
        id: "enki-images".into(),
        name: "Генерация изображений".into(),
        enabled: true,
        kind: "stdio".into(),
        command: node,
        args: vec![
            runtime.join("image-generation.mjs").display().to_string(),
            root.join("image-generation.json").display().to_string(),
        ],
        url: String::new(),
        env_keys: vec!["ENKI_IMAGE_API_KEY".into()],
        bearer: false,
        auth_revision: None,
    });
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
    fn registration_preserves_disabled_server_and_other_entries() {
        let root = std::env::temp_dir().join(format!(
            "enki-images-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let runtime = root.join("runtime");
        fs::create_dir_all(&runtime).unwrap();
        ensure(&root).unwrap();
        assert!(read_at(&root, "global").unwrap().0.servers.is_empty());
        for (name, content) in super::super::FILES {
            fs::write(runtime.join(name), content).unwrap();
        }
        fs::create_dir_all(runtime.join("node_modules/@modelcontextprotocol/sdk")).unwrap();
        fs::write(
            runtime.join("node_modules/@modelcontextprotocol/sdk/package.json"),
            r#"{"version":"1.32.0"}"#,
        )
        .unwrap();
        fs::write(
            runtime.join("node.json"),
            serde_json::to_string(
                &serde_json::json!({"nodeProgram":std::env::current_exe().unwrap()}),
            )
            .unwrap(),
        )
        .unwrap();
        ensure(&root).unwrap();
        let (mut registry, _) = read_at(&root, "global").unwrap();
        assert_eq!(registry.servers.len(), 1);
        assert_eq!(registry.servers[0].env_keys, ["ENKI_IMAGE_API_KEY"]);
        assert!(registry.servers[0].args[1].ends_with("image-generation.json"));
        registry.servers[0].enabled = false;
        registry.servers[0].name = "Custom".into();
        fs::write(
            root.join("global.json"),
            serde_json::to_string(&registry).unwrap(),
        )
        .unwrap();
        ensure(&root).unwrap();
        let value = read_at(&root, "global").unwrap().0;
        assert!(!value.servers[0].enabled);
        assert_eq!(value.servers[0].name, "Custom");
        fs::remove_dir_all(root).unwrap();
    }
}
