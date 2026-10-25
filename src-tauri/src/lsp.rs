//! Language servers for the runtime's LSP tools.
//!
//! The list is written into Enki's own data directory and handed to the Enki
//! Runtime through `capabilities.prepare` (`lspConfig`). The LSP extension only
//! ever executes programs named in that file, by absolute path; the user's
//! `~/.pi` configuration is never written to.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const VERSION_PROBE: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspServer {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub extensions: Vec<String>,
    pub language_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSetup {
    pub config_path: String,
    pub servers: Vec<LspServer>,
    pub missing: Vec<String>,
}

fn support_dir() -> Result<PathBuf, String> {
    let dir = crate::paths::app_data_dir()?.join("agent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

pub fn config_path() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?
        .join("agent")
        .join("lsp-config.json"))
}

/// Known language servers, by absolute path only (PATH is never consulted).
/// `data` is Enki's own data root; `home` is the owner HOME only outside an
/// explicit profile (see [`crate::paths::discovery_home`]).
fn candidates(data: Option<&Path>, home: Option<&Path>) -> Vec<(LspServer, Vec<PathBuf>)> {
    // A language server installed by an earlier Enki build is still usable.
    let typescript: Vec<PathBuf> = data
        .map(|d| d.join("pi-runtime/node_modules/.bin/typescript-language-server"))
        .into_iter()
        .collect();
    #[cfg(not(target_os = "windows"))]
    let typescript = {
        let mut paths = typescript;
        paths.extend([
            PathBuf::from("/usr/local/bin/typescript-language-server"),
            PathBuf::from("/opt/homebrew/bin/typescript-language-server"),
        ]);
        paths
    };
    let mut rust = Vec::new();
    #[cfg(not(target_os = "windows"))]
    rust.extend([
        PathBuf::from("/usr/bin/rust-analyzer"),
        PathBuf::from("/usr/local/bin/rust-analyzer"),
        PathBuf::from("/opt/homebrew/bin/rust-analyzer"),
    ]);
    if let Some(home) = home {
        rust.insert(0, home.join(rust_analyzer_relative()));
    }
    vec![
        (
            LspServer {
                id: "typescript".into(),
                command: String::new(),
                args: vec!["--stdio".into()],
                extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]
                    .map(String::from)
                    .to_vec(),
                language_id: "typescript".into(),
            },
            typescript,
        ),
        (
            LspServer {
                id: "rust".into(),
                command: String::new(),
                args: vec![],
                extensions: vec![".rs".into()],
                language_id: "rust".into(),
            },
            rust,
        ),
    ]
}

fn rust_analyzer_relative() -> &'static str {
    if cfg!(target_os = "windows") {
        ".cargo/bin/rust-analyzer.exe"
    } else {
        ".cargo/bin/rust-analyzer"
    }
}

/// `#!/usr/bin/env node` servers must find the bundled interpreter.
fn probe_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    if let Some(bin) =
        crate::runtime::known_bundled_node().and_then(|n| n.parent().map(Path::to_path_buf))
    {
        let mut paths = vec![bin];
        if let Some(inherited) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&inherited).filter(|p| p.is_absolute()));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }
    command.env_remove("NODE_OPTIONS");
    crate::process::hide_console(&mut command);
    command
}

/// Existence is not enough: `rustup` installs a shim for components that are
/// not installed and it exits non-zero at run time.
fn runnable(program: &Path) -> bool {
    let mut command = probe_command(program);
    command.arg("--version");
    crate::process::output_with_timeout(&mut command, VERSION_PROBE, 4096)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn absolute_file(raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw);
    (path.is_absolute() && path.is_file()).then_some(path)
}

/// `extra_paths`: absolute server paths configured by the user, tried first.
/// This is what makes the feature work for a macOS app started from Finder,
/// which does not inherit `/opt/homebrew/bin` or `~/.cargo/bin` in PATH.
#[tauri::command]
pub async fn runtime_setup_lsp(extra_paths: Option<Vec<String>>) -> Result<LspSetup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = support_dir()?;
        let home = crate::paths::discovery_home()?;
        let extra: Vec<PathBuf> = extra_paths
            .unwrap_or_default()
            .iter()
            .take(32)
            .filter_map(|raw| absolute_file(raw))
            .collect();
        let mut servers = Vec::new();
        let mut missing = Vec::new();
        for (mut server, paths) in candidates(dir.parent(), home.as_deref()) {
            let found = extra
                .iter()
                .cloned()
                .chain(paths)
                .find(|p| p.is_file() && runnable(p));
            match found {
                Some(found) => {
                    server.command = found.display().to_string();
                    servers.push(server);
                }
                None => missing.push(server.id),
            }
        }
        let config = dir.join("lsp-config.json");
        // Atomic replace: a session opening concurrently never reads half a file.
        let temporary = dir.join(format!("lsp-config.json.{}.tmp", std::process::id()));
        let body =
            serde_json::to_vec_pretty(&json!({ "servers": servers })).map_err(|e| e.to_string())?;
        std::fs::write(&temporary, body)
            .and_then(|_| std::fs::rename(&temporary, &config))
            .map_err(|e| {
                let _ = std::fs::remove_file(&temporary);
                e.to_string()
            })?;
        Ok(LspSetup {
            config_path: config.display().to_string(),
            servers,
            missing,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_candidate_is_absolute() {
        // Own fixture roots: no process HOME and no owner data-root resolution.
        let data = std::env::temp_dir().join("enki-lsp-fixture-data");
        let home = std::env::temp_dir().join("enki-lsp-fixture-home");
        for (_, paths) in candidates(Some(&data), Some(&home)) {
            for path in paths {
                assert!(path.is_absolute(), "{}", path.display());
            }
        }
    }

    #[test]
    fn an_explicit_profile_offers_no_owner_home_language_server() {
        let data = std::env::temp_dir().join("enki-lsp-fixture-profile");
        let home = std::env::temp_dir().join("enki-lsp-fixture-owner-home");
        let owner: Vec<PathBuf> = candidates(Some(&data), Some(&home))
            .into_iter()
            .flat_map(|(_, paths)| paths)
            .collect();
        let expected = if cfg!(target_os = "windows") {
            ".cargo/bin/rust-analyzer.exe"
        } else {
            ".cargo/bin/rust-analyzer"
        };
        assert!(owner.contains(&home.join(expected)));
        let profile =
            crate::paths::discovery_home_for(Ok(Some(data.clone())), Ok(home.clone())).unwrap();
        let isolated: Vec<PathBuf> = candidates(Some(&data), profile.as_deref())
            .into_iter()
            .flat_map(|(_, paths)| paths)
            .collect();
        assert!(
            isolated.iter().all(|path| !path.starts_with(&home)),
            "{isolated:?}"
        );
        // The profile's own earlier Enki install stays usable.
        assert!(isolated.iter().any(|path| path.starts_with(&data)));
    }

    #[test]
    fn relative_or_missing_overrides_are_ignored() {
        assert!(absolute_file("rust-analyzer").is_none());
        assert!(absolute_file("./bin/x").is_none());
        assert!(absolute_file("/definitely/not/here/x").is_none());
    }
}
