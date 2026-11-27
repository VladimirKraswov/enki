//! Shared search registration. Retains user edits and disabled state.
use super::{private, read_at, recorded_node, runtime_ready_at, validate, Server};
use fs2::FileExt;
use std::{fs, path::Path};
pub(super) fn ensure(root: &Path) -> Result<(), String> {
    let runtime = root.join("runtime");
    if !runtime_ready_at(&runtime) {
        return Ok(());
    }
    // A missing node.json used to disable the tool for good; fall back to the
    // bundled Node this build ships so a fresh profile still registers it.
    let node = match recorded_node(&runtime)? {
        Some(node) => node,
        None => crate::browser::node_program(None)?
            .to_str()
            .ok_or("Путь Node недоступен")?
            .to_string(),
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
        .map_err(|_| "Реестр поиска недоступен")?;
    lock.try_lock_exclusive()
        .map_err(|_| "Реестр инструментов занят")?;
    let (mut registry, expected) = read_at(root, "global")?;
    if registry.servers.iter().any(|s| s.id == "web-search") {
        return Ok(());
    }
    registry.servers.push(Server {
        id: "web-search".into(),
        name: "Веб-поиск".into(),
        enabled: true,
        kind: "stdio".into(),
        command: node,
        args: vec![runtime.join("web-search.mjs").display().to_string()],
        url: String::new(),
        env_keys: vec![],
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
            "arvela-search-{}-{}",
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
