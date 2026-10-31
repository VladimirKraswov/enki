//! Agent-facing control plane for Enki.
//!
//! The desktop process owns a private Unix socket and forwards bounded commands
//! to the WebView store.  The same binary can be launched with `--agent-mcp` to
//! expose that socket as a standard MCP stdio server.  External agents never
//! edit WebView storage or talk to undocumented Tauri internals.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(unix)]
use std::os::unix::{
    fs::{OpenOptionsExt, PermissionsExt},
    net::{UnixListener as ControlListener, UnixStream as ControlStream},
};

#[cfg(not(unix))]
use std::net::{TcpListener as ControlListener, TcpStream as ControlStream};

const EVENT: &str = "agent-control://command";
const PROTOCOL: u32 = 1;
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(360);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: u64 = 32;

#[derive(Default)]
pub struct AgentControl {
    pending: Mutex<HashMap<String, SyncSender<ControlCompletion>>>,
    serial: Mutex<()>,
    ready: AtomicBool,
    sequence: AtomicU64,
    connections: AtomicU64,
    runtime: Mutex<Option<RuntimeFiles>>,
}

#[derive(Clone)]
struct RuntimeFiles {
    socket: PathBuf,
    descriptor: PathBuf,
    token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlCommand {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlCompletion {
    id: String,
    #[serde(default)]
    result: Value,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlStatus {
    supported: bool,
    ready: bool,
    command: String,
    descriptor_path: String,
    protocol: u32,
}

#[derive(Deserialize)]
struct WireRequest {
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize, Deserialize)]
struct WireResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    protocol: u32,
    pid: u32,
    socket_path: String,
    token: String,
}

/// Schedules belong to the Enki Runtime (its durable scheduler fires while the
/// window is hidden or reloading), so this goes straight to the runtime API
/// rather than through the WebView.
fn runtime_schedule(app: &AppHandle, params: Value) -> Result<Value, String> {
    let supervisor = app
        .state::<crate::runtime::RuntimeSupervisor>()
        .inner()
        .clone();
    let connection = supervisor.ensure(app)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(format!("{}/v1/schedules/command", connection.endpoint))
        .bearer_auth(&connection.token)
        .json(&params)
        .send()
        .map_err(|_| "Среда выполнения Enki не ответила. Таймер не сохранён.".to_string())?;
    let ok = response.status().is_success();
    let body: Value = response.json().unwrap_or(Value::Null);
    if ok {
        Ok(body)
    } else {
        Err(body["message"]
            .as_str()
            .unwrap_or("Таймер не сохранён.")
            .chars()
            .take(1000)
            .collect())
    }
}

impl AgentControl {
    fn dispatch(&self, app: &AppHandle, method: String, params: Value) -> Result<Value, String> {
        if method == "schedule" {
            return runtime_schedule(app, params);
        }
        if !self.ready.load(Ordering::Acquire) {
            return Err("Enki is still starting; retry in a moment".into());
        }
        // A long wait must not block observation or an emergency stop. Commands
        // that change visible selection/configuration remain strictly ordered.
        let _serial = if matches!(method.as_str(), "status" | "wait" | "stop" | "interactions") {
            None
        } else {
            Some(
                self.serial
                    .lock()
                    .map_err(|_| "control command queue is unavailable".to_string())?,
            )
        };
        let id = format!(
            "{}-{}",
            std::process::id(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|_| "control completion table is unavailable".to_string())?
            .insert(id.clone(), tx);
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Enki main window is unavailable".to_string())?;
        if let Err(error) = window.emit(
            EVENT,
            ControlCommand {
                id: id.clone(),
                method,
                params,
            },
        ) {
            let _ = self.pending.lock().map(|mut p| p.remove(&id));
            return Err(error.to_string());
        }
        let completion = rx.recv_timeout(COMMAND_TIMEOUT).map_err(|_| {
            let _ = self.pending.lock().map(|mut p| p.remove(&id));
            "Enki did not complete the command within 6 minutes".to_string()
        })?;
        match completion.error {
            Some(error) => Err(error),
            None => Ok(completion.result),
        }
    }
}

#[tauri::command]
pub fn agent_control_ready(ready: bool, control: State<'_, AgentControl>) {
    control.ready.store(ready, Ordering::Release);
}

#[tauri::command]
pub fn agent_control_status(
    control: State<'_, AgentControl>,
) -> Result<AgentControlStatus, String> {
    // Supported means the private socket really exists for this process, not
    // merely that the platform could host one.
    let transport = control
        .runtime
        .lock()
        .map(|runtime| runtime.is_some())
        .unwrap_or(false);
    Ok(AgentControlStatus {
        supported: transport,
        ready: control.ready.load(Ordering::Acquire),
        command: std::env::current_exe()
            .map_err(|e| e.to_string())?
            .display()
            .to_string(),
        descriptor_path: descriptor_path()?.display().to_string(),
        protocol: PROTOCOL,
    })
}

#[tauri::command]
pub fn agent_control_complete(
    completion: ControlCompletion,
    control: State<'_, AgentControl>,
) -> Result<(), String> {
    let sender = control
        .pending
        .lock()
        .map_err(|_| "control completion table is unavailable".to_string())?
        .remove(&completion.id)
        .ok_or_else(|| "control command is no longer pending".to_string())?;
    sender
        .send(completion)
        .map_err(|_| "control command receiver closed".to_string())
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("cannot create control token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn start(app: AppHandle) -> Result<(), String> {
    let root = crate::paths::app_data_dir()?.join("agent-control");
    if root.is_symlink() {
        return Err("Control directory must not be a symbolic link".into());
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let socket = root.join(format!("desktop-{}.sock", std::process::id()));
    let descriptor = root.join("control.json");
    #[cfg(unix)]
    if socket.exists() {
        fs::remove_file(&socket).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    let listener = ControlListener::bind(&socket).map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let listener =
        ControlListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let socket = PathBuf::from(
        listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string(),
    );
    #[cfg(unix)]
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let token = random_token()?;
    let data = serde_json::to_vec_pretty(&Descriptor {
        protocol: PROTOCOL,
        pid: std::process::id(),
        socket_path: socket.display().to_string(),
        token: token.clone(),
    })
    .map_err(|e| e.to_string())?;
    let temp = root.join(format!("control-{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temp, &descriptor).map_err(|e| e.to_string())?;
    *app.state::<AgentControl>()
        .runtime
        .lock()
        .map_err(|_| "control runtime is unavailable")? = Some(RuntimeFiles {
        socket: socket.clone(),
        descriptor,
        token,
    });
    thread::Builder::new()
        .name("agent-control".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let control = app.state::<AgentControl>();
                let current = control.connections.fetch_add(1, Ordering::AcqRel);
                if current >= MAX_CONNECTIONS {
                    control.connections.fetch_sub(1, Ordering::AcqRel);
                    let response = WireResponse {
                        ok: false,
                        result: None,
                        error: Some("too many concurrent control connections".into()),
                    };
                    if let Ok(encoded) = serde_json::to_vec(&response) {
                        let _ = stream.write_all(&encoded);
                        let _ = stream.write_all(b"\n");
                    }
                    continue;
                }
                let app = app.clone();
                thread::spawn(move || {
                    handle_connection(stream, app.clone());
                    app.state::<AgentControl>()
                        .connections
                        .fetch_sub(1, Ordering::AcqRel);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn handle_connection(mut stream: ControlStream, app: AppHandle) {
    if let Err(error) = stream.set_read_timeout(Some(READ_TIMEOUT)) {
        let _ = writeln!(stream, "{}", json!({"ok":false,"error":error.to_string()}));
        return;
    }
    let mut line = String::new();
    let read = BufReader::new(&stream)
        .take(MAX_REQUEST_BYTES + 1)
        .read_line(&mut line);
    let response = match read {
        Ok(0) => WireResponse {
            ok: false,
            result: None,
            error: Some("empty control request".into()),
        },
        Ok(_) if line.len() as u64 > MAX_REQUEST_BYTES => WireResponse {
            ok: false,
            result: None,
            error: Some("control request is too large".into()),
        },
        Ok(_) => process_wire(&app, &line),
        Err(error) => WireResponse {
            ok: false,
            result: None,
            error: Some(error.to_string()),
        },
    };
    let encoded = serde_json::to_vec(&response).unwrap_or_else(|error| {
        serde_json::to_vec(&WireResponse {
            ok: false,
            result: None,
            error: Some(format!("cannot encode control response: {error}")),
        })
        .unwrap_or_default()
    });
    let encoded = if encoded.len() as u64 <= MAX_RESPONSE_BYTES {
        encoded
    } else {
        serde_json::to_vec(&WireResponse {
            ok: false,
            result: None,
            error: Some("Enki response is too large".into()),
        })
        .unwrap_or_default()
    };
    let _ = stream.write_all(&encoded);
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
}

fn process_wire(app: &AppHandle, line: &str) -> WireResponse {
    let request: WireRequest = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return WireResponse {
                ok: false,
                result: None,
                error: Some(format!("invalid control request: {error}")),
            }
        }
    };
    let state = app.state::<AgentControl>();
    let token_matches = state
        .runtime
        .lock()
        .ok()
        .and_then(|r| r.as_ref().map(|x| x.token == request.token))
        .unwrap_or(false);
    if !token_matches {
        return WireResponse {
            ok: false,
            result: None,
            error: Some("invalid control token".into()),
        };
    }
    match state.dispatch(app, request.method, request.params) {
        Ok(result) => WireResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => WireResponse {
            ok: false,
            result: None,
            error: Some(error),
        },
    }
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<AgentControl>();
    state.ready.store(false, Ordering::Release);
    let Ok(mut runtime) = state.runtime.lock() else {
        return;
    };
    if let Some(files) = runtime.take() {
        #[cfg(unix)]
        let _ = fs::remove_file(files.socket);
        #[cfg(not(unix))]
        let _ = files.socket;
        let current_is_ours = fs::read(&files.descriptor)
            .ok()
            .and_then(|data| serde_json::from_slice::<Descriptor>(&data).ok())
            .is_some_and(|d| d.pid == std::process::id());
        if current_is_ours {
            let _ = fs::remove_file(files.descriptor);
        }
    }
}

fn descriptor_path() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("agent-control/control.json"))
}

fn call_desktop(method: &str, params: Value) -> Result<Value, String> {
    let descriptor: Descriptor =
        serde_json::from_slice(&fs::read(descriptor_path()?).map_err(|_| {
            "Enki control endpoint was not found; start the installed app first".to_string()
        })?)
        .map_err(|e| format!("invalid Enki control descriptor: {e}"))?;
    if descriptor.protocol != PROTOCOL {
        return Err(format!(
            "unsupported desktop control protocol {}",
            descriptor.protocol
        ));
    }
    #[cfg(not(unix))]
    if !descriptor
        .socket_path
        .parse::<std::net::SocketAddr>()
        .is_ok_and(|a| a.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST))
    {
        return Err("control endpoint must be loopback".into());
    }
    let mut stream = ControlStream::connect(&descriptor.socket_path)
        .map_err(|e| format!("cannot connect to Enki: {e}"))?;
    stream
        .set_read_timeout(Some(COMMAND_TIMEOUT + Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let request = json!({"token": descriptor.token, "method": method, "params": params});
    writeln!(stream, "{request}").map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .take(MAX_RESPONSE_BYTES + 1)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("Enki response is too large".into());
    }
    let response: WireResponse =
        serde_json::from_str(&line).map_err(|e| format!("invalid Enki response: {e}"))?;
    if response.ok {
        Ok(response.result.unwrap_or(Value::Null))
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "desktop command failed".into()))
    }
}

fn tools() -> Value {
    json!([
      {"name":"desktop_schedule","description":"Manage user-authorized wake-ups in an explicit Enki session, without selecting or interrupting it. For monitoring use repeat and choose a sensible interval; once for a delayed task. Use a stable request_key to prevent duplicates. Never claim a timer is saved until this tool succeeds. List/delete timers when asked to stop watching. All times are Unix milliseconds. Requires running Enki (including tray); no execution after full quit.","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["list","create","remove","pause","resume"]},"directory":{"type":"string"},"session_id":{"type":"string"},"id":{"type":"string"},"title":{"type":"string","maxLength":120},"prompt":{"type":"string","maxLength":20000},"minutes":{"type":"integer","minimum":1,"maximum":10080},"mode":{"type":"string","enum":["once","repeat"]},"run_at":{"type":"number"},"request_key":{"type":"string","maxLength":128},"provider_id":{"type":"string"},"model_id":{"type":"string"}},"required":["action","directory","session_id"],"additionalProperties":false}},
      {"name":"desktop_updates","description":"Check, prepare and apply Enki's own signed updates without the mouse. action=status reads the current release/build state; prepare starts the verified download or local source build (idempotent, poll status until prepared or stage=ready); apply behaves like the visible Install control: hot updates reload the interface, source updates wait durably for authoritative idle and then restart the app. Use apply as the final action of a completed update flow; a restart interrupts visible chats, durable state is preserved.","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["status","prepare","apply"],"default":"status"}},"additionalProperties":false}},
      {"name":"desktop_status","description":"Read Enki connection, visible workspace/chat, model, run state and pending user interactions.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
      {"name":"desktop_projects","description":"Refresh and list projects known to the connected Enki instance.","inputSchema":{"type":"object","properties":{"refresh":{"type":"boolean","default":true}},"additionalProperties":false}},
      {"name":"desktop_select","description":"Select a project directory and optionally open one of its sessions in the visible desktop UI.","inputSchema":{"type":"object","properties":{"directory":{"type":"string"},"session_id":{"type":"string"}},"required":["directory"],"additionalProperties":false}},
      {"name":"desktop_sessions","description":"List sessions for a project directory, including origin (native or read-only imported history) and live status.","inputSchema":{"type":"object","properties":{"directory":{"type":"string"},"refresh":{"type":"boolean","default":true}},"required":["directory"],"additionalProperties":false}},
      {"name":"desktop_new_chat","description":"Open the new-chat composer for a directory.","inputSchema":{"type":"object","properties":{"directory":{"type":"string"}},"required":["directory"],"additionalProperties":false}},
      {"name":"desktop_configure","description":"Choose model, variant and agent for the visible chat. This does not change permissions or auto-approve anything.","inputSchema":{"type":"object","properties":{"provider_id":{"type":"string"},"model_id":{"type":"string"},"variant":{"type":["string","null"]},"agent":{"type":"string"}},"additionalProperties":false}},
      {"name":"desktop_send","description":"Send one prompt through the visible Enki chat. Acceptance is not completion; call desktop_wait afterwards. For an explicitly managed long task, supply a literal completion_marker, bounded max_continuations and optional project-relative checkpoint_path. Permission and question requests remain pending for the user.","inputSchema":{"type":"object","properties":{"directory":{"type":"string"},"session_id":{"type":"string"},"text":{"type":"string"},"provider_id":{"type":"string"},"model_id":{"type":"string"},"variant":{"type":["string","null"]},"agent":{"type":"string"},"completion_marker":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"},"max_continuations":{"type":"integer","minimum":0,"maximum":20},"checkpoint_path":{"type":"string","minLength":1,"maxLength":240}},"required":["directory","text"],"additionalProperties":false}},
      {"name":"desktop_wait","description":"Wait until a session becomes idle, needs user input, fails, or the bounded timeout expires.","inputSchema":{"type":"object","properties":{"session_id":{"type":"string"},"timeout_seconds":{"type":"integer","minimum":1,"maximum":300,"default":120}},"required":["session_id"],"additionalProperties":false}},
      {"name":"desktop_conversation","description":"Read a bounded, normalized transcript from a session in Enki.","inputSchema":{"type":"object","properties":{"directory":{"type":"string"},"session_id":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200,"default":40},"max_chars":{"type":"integer","minimum":1000,"maximum":500000,"default":120000}},"required":["directory","session_id"],"additionalProperties":false}},
      {"name":"desktop_stop","description":"Stop a running session without closing Enki.","inputSchema":{"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"],"additionalProperties":false}},
      {"name":"desktop_interactions","description":"List pending permission requests and structured questions. Never infer approval from project scope.","inputSchema":{"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"],"additionalProperties":false}},
      {"name":"desktop_managed_runs","description":"List durable managed long-run contracts for the currently connected server without prompts or tool output.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
      {"name":"desktop_forget_managed_run","description":"Remove one managed continuation contract without aborting or deleting its session.","inputSchema":{"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"],"additionalProperties":false}},
      {"name":"desktop_reply_permission","description":"Reply to a pending permission request. Use once/always only after an explicit user decision; reject is always safe.","inputSchema":{"type":"object","properties":{"request_id":{"type":"string"},"reply":{"type":"string","enum":["once","always","reject"]}},"required":["request_id","reply"],"additionalProperties":false}},
      {"name":"desktop_answer_question","description":"Answer or reject a pending structured question. Answers are arrays because a question may allow multiple selections.","inputSchema":{"type":"object","properties":{"request_id":{"type":"string"},"answers":{"type":"array","items":{"type":"array","items":{"type":"string"}}},"reject":{"type":"boolean","default":false}},"required":["request_id"],"additionalProperties":false}},
      {"name":"desktop_set_view","description":"Open/close visible Enki panels without using mouse input.","inputSchema":{"type":"object","properties":{"settings_open":{"type":"boolean"},"sidebar_open":{"type":"boolean"},"review_open":{"type":"boolean"},"terminal_open":{"type":"boolean"}},"additionalProperties":false}},
      {"name":"desktop_install_mcp","description":"Safely install or disable this exact control MCP in Enki's global shared MCP registry (used by the Enki agent runtime), preserving other entries. Refuses while agents run or on a remote host.","inputSchema":{"type":"object","properties":{"enabled":{"type":"boolean","default":true}},"additionalProperties":false}}
    ])
}

fn tool_method(name: &str) -> Option<&'static str> {
    Some(match name {
        "desktop_schedule" => "schedule",
        "desktop_updates" => "updates",
        "desktop_status" => "status",
        "desktop_projects" => "projects",
        "desktop_select" => "select",
        "desktop_sessions" => "sessions",
        "desktop_new_chat" => "new_chat",
        "desktop_configure" => "configure",
        "desktop_send" => "send",
        "desktop_wait" => "wait",
        "desktop_conversation" => "conversation",
        "desktop_stop" => "stop",
        "desktop_interactions" => "interactions",
        "desktop_managed_runs" => "managed_runs",
        "desktop_forget_managed_run" => "forget_managed_run",
        "desktop_reply_permission" => "reply_permission",
        "desktop_answer_question" => "answer_question",
        "desktop_set_view" => "set_view",
        "desktop_install_mcp" => "install_mcp",
        _ => return None,
    })
}

fn mcp_response(message: Value) -> Option<Value> {
    mcp_response_scoped(message, false)
}
fn mcp_response_scoped(message: Value, schedules_only: bool) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str)?;
    match method {
        "initialize" => id.map(|id| json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":if schedules_only {"enki-schedules"} else {"enki-control"},"version":env!("CARGO_PKG_VERSION")},"instructions":if schedules_only {"Manage user-authorized session wake-ups only. Use explicit directory/session_id and stable request_key. Choose once for delayed tasks, repeat for monitoring. List before creating; remove when asked to stop or when monitoring completes. Do not create follow-up timers from a scheduled wake-up without new human authorization. Never claim creation before tool success."} else {"Control the running Enki through its visible state. Send once, then wait/read. Never auto-approve permissions or invent answers to user questions."}}})),
        "ping" => id.map(|id| json!({"jsonrpc":"2.0","id":id,"result":{}})),
        "tools/list" => id.map(|id| json!({"jsonrpc":"2.0","id":id,"result":{"tools": if schedules_only { Value::Array(tools().as_array().unwrap().iter().filter(|t| t["name"] == "desktop_schedule").cloned().collect()) } else { tools() }}})),
        "tools/call" => id.map(|id| {
            let name = message.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
            match tool_method(name).filter(|method| !schedules_only || *method == "schedule").ok_or_else(|| format!("unknown tool: {name}")).and_then(|method| call_desktop(method, args)) {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string())}],"structuredContent":result}}),
                Err(error) => json!({"jsonrpc":"2.0","id":id,"result":{"isError":true,"content":[{"type":"text","text":error}]}}),
            }
        }),
        _ if id.is_some() => id.map(|id| json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("method not found: {method}")}})),
        _ => None,
    }
}

pub fn mcp_main() -> Result<(), String> {
    let schedules_only = std::env::args().nth(1).as_deref() == Some("--schedule-mcp");
    let stdout = Mutex::new(io::stdout());
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(response) = (if schedules_only {
            mcp_response_scoped(message, true)
        } else {
            mcp_response(message)
        }) else {
            continue;
        };
        let mut out = stdout.lock().map_err(|_| "stdout is unavailable")?;
        writeln!(out, "{response}").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduling_endpoint_only_exposes_schedule_and_refuses_other_control_tools() {
        let listed = mcp_response_scoped(json!({"id":1,"method":"tools/list"}), true).unwrap();
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "desktop_schedule");
        for name in ["desktop_send", "desktop_reply_permission", "desktop_stop"] {
            let response = mcp_response_scoped(
                json!({"id":2,"method":"tools/call","params":{"name":name,"arguments":{}}}),
                true,
            )
            .unwrap();
            assert_eq!(response["result"]["isError"], true);
        }
    }
    #[test]
    fn mcp_lists_bounded_desktop_tools() {
        let response = mcp_response(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let tools = response
            .pointer("/result/tools")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(tools.iter().any(|t| t["name"] == "desktop_send"));
        assert!(tools.iter().any(|t| t["name"] == "desktop_wait"));
        let updates = tools
            .iter()
            .find(|tool| tool["name"] == "desktop_updates")
            .expect("desktop_updates is exposed");
        assert_eq!(
            updates
                .pointer("/inputSchema/properties/action/enum")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(3)
        );
        assert_eq!(tool_method("desktop_updates"), Some("updates"));
        assert!(tools.iter().any(|t| t["name"] == "desktop_managed_runs"));
        assert!(tools
            .iter()
            .any(|t| t["name"] == "desktop_forget_managed_run"));
        let send = tools
            .iter()
            .find(|tool| tool["name"] == "desktop_send")
            .unwrap();
        assert_eq!(
            send.pointer("/inputSchema/properties/max_continuations/maximum"),
            Some(&json!(20))
        );
        assert!(send
            .pointer("/inputSchema/properties/completion_marker/pattern")
            .and_then(Value::as_str)
            .is_some_and(|pattern| pattern.contains("A-Za-z0-9")));
        assert!(!tools.iter().any(|t| t["name"] == "shell"));
        // No engine selector survives: one runtime executes every chat.
        assert!(!serde_json::to_string(tools)
            .unwrap()
            .contains("\"opencode\""));
    }

    #[test]
    fn notifications_do_not_emit_responses() {
        assert!(
            mcp_response(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none()
        );
    }

    #[test]
    fn unknown_tools_are_reported_as_tool_errors() {
        let response = mcp_response(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"desktop_destroy_everything","arguments":{}}})).unwrap();
        assert_eq!(response.pointer("/result/isError"), Some(&json!(true)));
    }
}
