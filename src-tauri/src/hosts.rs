//! Only app-owned directories and SSH tunnels to the Enki Runtime on remote
//! hosts. External agent servers are never started, stopped or contacted.
use crate::process::{hide_console, output_with_timeout, OutputTail, RunError};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::State;

/// Retained SSH diagnostics per tunnel. ssh keeps writing to stderr for the
/// tunnel's whole life (for example a refused forwarded connection each time
/// the remote server restarts), so the pipe is drained continuously.
const SSH_STDERR_TAIL: usize = 4096;

#[derive(Default, Clone)]
pub struct Hosts(pub Arc<Mutex<HashMap<String, Tunnel>>>);
pub struct Tunnel {
    child: Child,
    endpoint: String,
    stderr: OutputTail,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    directory: String,
    root: String,
}

fn valid_target(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with('-')
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.@:%[]".contains(&c))
}
/// Absolute paths only: resolving `ssh` through PATH would let a user-writable
/// directory decide which binary opens the tunnel. macOS ships the first entry,
/// Debian/Ubuntu the first or second, Nix/Homebrew installs the last.
#[cfg(unix)]
const SSH_PROGRAMS: &[&str] = &["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh"];

fn ssh_program() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        system_root.join(r"System32\OpenSSH\ssh.exe")
    }
    #[cfg(unix)]
    SSH_PROGRAMS
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(SSH_PROGRAMS[0]))
}

fn ssh(target: &str) -> Result<Command, String> {
    if !valid_target(target) {
        return Err("Укажите SSH-алиас или user@host, без параметров команды.".into());
    }
    let mut c = Command::new(ssh_program());
    c.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
    ]);
    hide_console(&mut c);
    Ok(c)
}
fn output_timeout(mut c: Command) -> Result<String, String> {
    let out =
        output_with_timeout(&mut c, Duration::from_secs(12), 64 * 1024).map_err(
            |error| match error {
                RunError::TimedOut => "SSH: время ожидания истекло.".to_string(),
                RunError::Spawn(error) => error.to_string(),
            },
        )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .chars()
            .take(1200)
            .collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Workspace probes must not also open forwards inherited from an SSH alias.
/// Tunnel commands keep their explicit -L; ClearAllForwardings would erase it.
fn ssh_probe(target: &str) -> Result<Command, String> {
    let mut command = ssh(target)?;
    command.args(["-o", "ClearAllForwardings=yes"]);
    Ok(command)
}

pub(crate) fn upload_archive(
    hosts: &Hosts,
    target: &str,
    endpoint: &str,
    id: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if !crate::attachments::validate_id(id) {
        return Err("Некорректное вложение.".into());
    }
    {
        let mut tunnels = hosts.0.lock().map_err(|e| e.to_string())?;
        if !tunnels.iter_mut().any(|(key, tunnel)| {
            key.starts_with(&format!("{target}:"))
                && tunnel.endpoint == endpoint
                && matches!(tunnel.child.try_wait(), Ok(None))
        }) {
            return Err("SSH-подключение изменилось. Архив не передан.".into());
        }
    }
    let mut command = ssh_probe(target)?;
    // Only validated UUID and numeric byte count are interpolated; original names never reach a shell.
    let script = format!("umask 077; root=\"$HOME/.local/share/enki/attachments\"; test ! -L \"$root\" && mkdir -p -- \"$root\" && d=\"$root/{id}\" && mkdir -- \"$d\" && cat > \"$d/archive.zip.part\" && test \"$(wc -c < \"$d/archive.zip.part\")\" -eq {} && mv -- \"$d/archive.zip.part\" \"$d/archive.zip\" && printf '%s\\n' \"$d/archive.zip\"", bytes.len());
    command.arg(target).arg(script);
    let output = crate::process::output_with_input_timeout(
        &mut command,
        Duration::from_secs(60),
        8192,
        Some(bytes.to_vec()),
    )
    .map_err(|_| {
        "Не удалось передать архив через SSH. Повторите после проверки подключения.".to_string()
    })?;
    if !output.status.success() {
        return Err("SSH не подтвердил сохранение архива.".into());
    }
    let path = String::from_utf8(output.stdout)
        .map_err(|_| "SSH вернул некорректный путь.")?
        .trim()
        .to_string();
    if !path.starts_with('/')
        || path.contains(['\r', '\n'])
        || path.len() > 4096
        || !path.ends_with(&format!("/attachments/{id}/archive.zip"))
    {
        return Err("SSH вернул некорректный путь архива.".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn ssh_aliases() -> Vec<String> {
    let text = crate::paths::user_home()
        .ok()
        .and_then(|home| fs::read_to_string(home.join(".ssh/config")).ok())
        .unwrap_or_default();
    let mut out = Vec::new();
    for line in text.lines() {
        let mut words = line
            .split('#')
            .next()
            .unwrap_or_default()
            .split_whitespace();
        if words.next().is_some_and(|x| x.eq_ignore_ascii_case("host")) {
            for name in words {
                if valid_target(name) && !out.iter().any(|x| x == name) {
                    out.push(name.to_string());
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn prepare_chat_workspace(
    id: String,
    ssh_target: Option<String>,
    server_home: String,
) -> Result<Workspace, String> {
    if id.len() < 12 || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Некорректный идентификатор рабочего каталога.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(target) = ssh_target {
            let mut c = ssh_probe(&target)?;
            // Only the restricted, app-generated ID is interpolated. No arbitrary shell input.
            let remote = crate::paths::REMOTE_CHATS_SUBPATH;
            let script = format!("umask 077; d=\"$HOME/{remote}/{id}\"; mkdir -p -- \"$d\" && cd -- \"$d\" && pwd -P");
            c.arg(&target).arg(script);
            let directory = output_timeout(c)?;
            if !directory.starts_with('/') || directory.contains('\n') { return Err("SSH вернул некорректный рабочий путь.".into()); }
            let root = directory.rsplit_once('/').ok_or("Некорректный путь")?.0.to_string();
            Ok(Workspace { directory, root })
        } else {
            let home = crate::paths::user_home()?;
            if fs::canonicalize(&home).ok() != fs::canonicalize(&server_home).ok() || !home.is_absolute() {
                return Err("Сервер работает на другой машине. Выберите подключение SSH для создания чата.".into());
            }
            let root = crate::paths::app_data_dir()?.join("chats");
            fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            let dir = root.join(&id);
            fs::create_dir(&dir).map_err(|e| e.to_string())?;
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?; }
            let directory = fs::canonicalize(dir).map_err(|e| e.to_string())?.to_string_lossy().to_string();
            let root = Path::new(&directory)
                .parent()
                .ok_or("Некорректный путь")?
                .to_string_lossy()
                .to_string();
            Ok(Workspace { directory, root })
        }
    }).await.map_err(|e| e.to_string())?
}

/// Where the remote Linux runtime artifact is installed (see
/// scripts/runtime/prepare.mjs, `enki-runtime-linux-x64-<version>.tar.gz` and
/// the trusted journaled installer scripts/runtime/install-remote.mjs, which
/// requires the authenticated manifest SHA256). Fixed path: nothing user-controlled is
/// interpolated into the remote command. Runtime data lives separately in
/// `~/.local/share/enki/runtime`.
pub(crate) const REMOTE_RUNTIME: &str =
    "$HOME/.local/share/enki/runtime-dist/current/bin/enki-runtime";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRuntime {
    pub target: String,
    pub endpoint: String,
    /// Bearer for this runtime. Kept in memory only; never in a URL or a log.
    pub token: String,
    pub instance: String,
    pub contract: u64,
}

/// Parse `enki-runtime ensure` output: one JSON line, strictly validated.
fn parse_ensure(stdout: &str) -> Result<(u16, String, String, u64), String> {
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).ok_or(
        "На удалённой машине не найдена среда выполнения Enki. Установите её (см. docs/REMOTE-RUNTIME.md).",
    )?;
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|_| "Удалённая среда выполнения вернула некорректный ответ.")?;
    let port = value["port"]
        .as_u64()
        .filter(|p| (1..=65535).contains(p))
        .ok_or("Удалённая среда выполнения не сообщила порт.")? as u16;
    let token = value["token"]
        .as_str()
        .filter(|t| {
            t.len() >= 32
                && t.len() <= 256
                && t.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or("Удалённая среда выполнения не сообщила ключ доступа.")?
        .to_string();
    let instance = value["instance"]
        .as_str()
        .filter(|s| s.len() <= 128)
        .unwrap_or_default()
        .to_string();
    let contract = value["contract"]
        .as_u64()
        .ok_or("Удалённая среда выполнения не сообщила версию контракта.")?;
    if contract != crate::runtime::CONTRACT {
        return Err(format!(
            "Версия удалённой среды выполнения (контракт {contract}) несовместима с этим Enki (контракт {}). Обновите её на удалённой машине.",
            crate::runtime::CONTRACT
        ));
    }
    Ok((port, token, instance, contract))
}

/// Start (or find) the runtime daemon on the SSH host, then forward its
/// loopback port through a strict SSH tunnel. A failure is reported as such:
/// there is never a fallback to the local runtime for a remote project.
#[tauri::command]
pub async fn connect_remote_runtime(
    target: String,
    state: State<'_, Hosts>,
) -> Result<RemoteRuntime, String> {
    let mut probe = ssh_probe(&target)?;
    probe
        .arg(&target)
        .arg(format!("exec \"{REMOTE_RUNTIME}\" ensure"));
    let stdout = tauri::async_runtime::spawn_blocking(move || {
        output_timeout_for(probe, Duration::from_secs(45))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (port, token, instance, contract) = parse_ensure(&stdout)?;
    let endpoint = open_tunnel(&target, port, state.inner()).await?;
    // The forwarded runtime must answer authenticated health with the same
    // instance; anything else listening on that remote port is refused.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let health: serde_json::Value = client
        .get(format!("{endpoint}/v1/health"))
        .bearer_auth(&token)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| {
            "Удалённая среда выполнения не прошла проверку подлинности через туннель.".to_string()
        })?
        .json()
        .await
        .map_err(|_| "Удалённая среда выполнения вернула некорректный ответ.".to_string())?;
    if health["contract"].as_u64() != Some(contract)
        || (!instance.is_empty() && health["instance"].as_str() != Some(instance.as_str()))
    {
        if let Ok(mut tunnels) = state.0.lock() {
            tunnels.remove(&format!("{target}:{port}"));
        }
        return Err("Через туннель ответил другой процесс. Подключение отменено.".into());
    }
    Ok(RemoteRuntime {
        target,
        endpoint,
        token,
        instance,
        contract,
    })
}

fn output_timeout_for(mut c: Command, limit: Duration) -> Result<String, String> {
    let out = output_with_timeout(&mut c, limit, 64 * 1024).map_err(|error| match error {
        RunError::TimedOut => "SSH: время ожидания истекло.".to_string(),
        RunError::Spawn(error) => error.to_string(),
    })?;
    if !out.status.success() {
        let stderr: String = String::from_utf8_lossy(&out.stderr)
            .chars()
            .take(1200)
            .collect();
        if out.status.code() == Some(127) {
            return Err("На удалённой машине не установлена среда выполнения Enki. Установите её (см. docs/REMOTE-RUNTIME.md).".into());
        }
        return Err(format!("SSH: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Strict `-L 127.0.0.1:<local>:127.0.0.1:<remote>` tunnel, reused while alive.
async fn open_tunnel(target: &str, port: u16, state: &Hosts) -> Result<String, String> {
    if port == 0 {
        return Err("Порт должен быть от 1 до 65535.".into());
    }
    let target = target.to_string();
    let mut command = ssh(&target)?;
    let handles = state.0.clone();
    let key = format!("{target}:{port}");
    let ssh_target = target.clone();
    let endpoint = tauri::async_runtime::spawn_blocking(move || {
        let mut tunnels = handles.lock().map_err(|e| e.to_string())?;
        if let Some(t) = tunnels.get_mut(&key) {
            if t.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(t.endpoint.clone());
            }
        }
        tunnels.remove(&key);
        let socket = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let local_port = socket.local_addr().map_err(|e| e.to_string())?.port();
        drop(socket);
        command.args([
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            &format!("127.0.0.1:{local_port}:127.0.0.1:{port}"),
            &ssh_target,
        ]);
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stderr = child
            .stderr
            .take()
            .map(|pipe| OutputTail::follow(pipe, SSH_STDERR_TAIL))
            .unwrap_or_default();
        let endpoint = format!("http://127.0.0.1:{local_port}");
        tunnels.insert(
            key,
            Tunnel {
                child,
                endpoint: endpoint.clone(),
                stderr,
            },
        );
        Ok::<_, String>(endpoint)
    })
    .await
    .map_err(|e| e.to_string())??;
    // Wait for the actual forwarded HTTP server, not just the SSH process to
    // exist. The loopback probe never goes through an HTTP(S)_PROXY from the
    // environment and never follows a redirect elsewhere.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(13);
    while Instant::now() < until {
        let exited = {
            let mut tunnels = state.0.lock().map_err(|e| e.to_string())?;
            let key = format!("{target}:{port}");
            let Some(t) = tunnels.get_mut(&key) else {
                // Removed by app exit or a superseded failed attempt; never
                // report a forward that no longer exists as ready.
                return Err("SSH-туннель закрыт. Повторите подключение.".into());
            };
            if t.child.try_wait().map_err(|e| e.to_string())?.is_some() {
                let stderr = t.stderr.clone();
                tunnels.remove(&key);
                Some(stderr)
            } else {
                None
            }
        };
        if let Some(stderr) = exited {
            // The drain thread reaches EOF just after exit; let it catch up.
            tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_millis(100)))
                .await
                .map_err(|e| e.to_string())?;
            let error: String = stderr.text().chars().take(1600).collect();
            return Err(format!("SSH: {} Проверьте ключ и известный ключ сервера командой ssh {target} в терминале.", error.trim()));
        }
        // Unauthenticated probe: the runtime answers 401 once the forward works.
        if let Ok(response) = client.get(format!("{endpoint}/v1/health")).send().await {
            if response.status().is_success() || response.status().as_u16() == 401 {
                return Ok(endpoint);
            }
        }
        tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_millis(150)))
            .await
            .map_err(|e| e.to_string())?;
    }
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&format!("{target}:{port}"));
    Err(format!("SSH подключён, но среда выполнения Enki не отвечает на 127.0.0.1:{port} удалённой машины. Повторите подключение."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_targets_are_arguments_not_commands() {
        for ok in ["vm-v100", "user@192.168.31.2", "user@[::1]"] {
            assert!(valid_target(ok));
        }
        for bad in [
            "",
            "-oProxyCommand=touch",
            "host;rm",
            "a\nb",
            "a b",
            "$(id)",
            "`id`",
            "host/../../",
        ] {
            assert!(!valid_target(bad));
        }
    }
    #[test]
    fn remote_runtime_handshake_is_strictly_validated() {
        let token = "a".repeat(43);
        let good = format!("motd line\n{{\"port\":41234,\"token\":\"{token}\",\"instance\":\"i-1\",\"contract\":{}}}", crate::runtime::CONTRACT);
        let (port, parsed, instance, _) = parse_ensure(&good).unwrap();
        assert_eq!(
            (port, parsed.as_str(), instance.as_str()),
            (41234, token.as_str(), "i-1")
        );
        for bad in [
            String::new(),
            "{\"port\":0,\"token\":\"x\",\"contract\":1}".to_string(),
            format!("{{\"port\":1,\"token\":\"{token}\",\"contract\":999}}"),
            format!("{{\"port\":1,\"token\":\"bad token {token}\",\"contract\":1}}"),
        ] {
            assert!(parse_ensure(&bad).is_err(), "{bad}");
        }
        // The remote command is a fixed path; no target text reaches the shell.
        assert!(!REMOTE_RUNTIME.contains(['\'', ';', '`']));
    }
    #[test]
    fn ssh_is_only_ever_launched_from_an_absolute_path() {
        #[cfg(unix)]
        assert!(SSH_PROGRAMS.iter().all(|p| p.starts_with('/')));
        assert!(ssh_program().is_absolute());
    }
    #[test]
    fn ssh_never_disables_host_key_verification() {
        let cmd = ssh("vm-test").unwrap();
        let args: Vec<_> = cmd
            .get_args()
            .map(|x| x.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"StrictHostKeyChecking=yes".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    #[cfg(unix)]
    fn workspace_probes_clear_alias_forwards_without_changing_tunnel_policy() {
        let config = std::env::temp_dir().join(format!("oc-ssh-config-{}", std::process::id()));
        fs::write(
            &config,
            "Host fixture\n  HostName 127.0.0.1\n  LocalForward 127.0.0.1:55555 127.0.0.1:4096\n",
        )
        .unwrap();
        let resolved = |mut command: Command| {
            command.arg("-G").arg("-F").arg(&config).arg("fixture");
            output_timeout(command).unwrap()
        };
        let tunnel = resolved(ssh("fixture").unwrap());
        let probe = resolved(ssh_probe("fixture").unwrap());
        let _ = fs::remove_file(config);
        assert!(tunnel.lines().any(|line| line.starts_with("localforward ")));
        assert!(!probe.lines().any(|line| line.starts_with("localforward ")));
        assert!(probe.contains("stricthostkeychecking true"));
        assert!(probe.contains("batchmode yes"));
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    #[tokio::test]
    async fn workspace_id_cannot_escape_the_managed_root_or_inject_remote_commands() {
        for id in [
            "../../escape-path",
            "some-id;touch-x",
            "$(touch x)",
            "bad\nworkspace",
        ] {
            assert!(
                prepare_chat_workspace(id.into(), Some("host".into()), "/home/test".into())
                    .await
                    .is_err()
            );
        }
    }
}
