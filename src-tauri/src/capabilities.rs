//! App-owned, scoped shared capability registry. No user histories or skills are
//! rewritten. Engine approvals remain authoritative; metadata never executes a tool.
pub mod quality;
mod skills;
use skills::{scan, SkillSource};
mod authoring;
mod image_generation;
pub mod project_map;
mod schedules;
mod web_search;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(not(unix))]
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
#[derive(Default, Clone)]
pub struct SharedRuntime {
    closing: Arc<AtomicBool>,
    installing: Arc<AtomicBool>,
}
pub fn shutdown(runtime: &SharedRuntime) {
    runtime.closing.store(true, Ordering::Release);
    let end = std::time::Instant::now() + Duration::from_secs(3);
    while runtime.installing.load(Ordering::Acquire) && std::time::Instant::now() < end {
        std::thread::sleep(Duration::from_millis(30));
    }
}
const LIMIT: u64 = 262144;
const FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../resources/shared/package.json"),
    ),
    (
        "package-lock.json",
        include_str!("../resources/shared/package-lock.json"),
    ),
    (
        "registry.mjs",
        include_str!("../resources/shared/registry.mjs"),
    ),
    ("client.mjs", include_str!("../resources/shared/client.mjs")),
    (
        "stdio-command.mjs",
        include_str!("../resources/shared/stdio-command.mjs"),
    ),
    ("proxy.mjs", include_str!("../resources/shared/proxy.mjs")),
    (
        "image-generation.mjs",
        include_str!("../resources/shared/image-generation.mjs"),
    ),
    (
        "image-generation-core.mjs",
        include_str!("../resources/shared/image-generation-core.mjs"),
    ),
    (
        "image-generation-context.mjs",
        include_str!("../resources/shared/image-generation-context.mjs"),
    ),
    (
        "web-search-core.mjs",
        include_str!("../resources/shared/web-search-core.mjs"),
    ),
    (
        "web-search.mjs",
        include_str!("../resources/shared/web-search.mjs"),
    ),
    (
        "project-map-core.mjs",
        include_str!("../resources/shared/project-map-core.mjs"),
    ),
    (
        "project-map.mjs",
        include_str!("../resources/shared/project-map.mjs"),
    ),
];
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub path: String,
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub kind: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub env_keys: Vec<String>,
    #[serde(default)]
    pub bearer: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_revision: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    pub version: u32,
    pub directory: Option<String>,
    pub sources: Vec<Source>,
    pub servers: Vec<Server>,
    #[serde(default)]
    pub applied_paths: Vec<String>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            directory: None,
            sources: vec![],
            servers: vec![],
            applied_paths: vec![],
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub key: String,
    pub content: String,
    pub registry: Registry,
    pub inherited: Registry,
    pub skills: Vec<Skill>,
    pub runtime_ready: bool,
    pub command: String,
    pub scope_directory: Option<String>,
    pub source_health: BTreeMap<String, bool>,
    pub scan_limited: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub managed: bool,
    pub enabled: bool,
    pub engines: Vec<String>,
    pub error: Option<String>,
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn valid_key(value: &str) -> bool {
    value == "global"
        || (value.len() == 24
            && (value.starts_with("project-") || value.starts_with("session-"))
            && value[8..]
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
}
pub fn root() -> Result<PathBuf, String> {
    // Match the browser's existing Windows profile-root policy: the registry
    // stays outside LOCALAPPDATA virtualization, so packaged and unpackaged
    // builds see the same data. The Mac/Linux data path is unchanged.
    #[cfg(windows)]
    return Ok(crate::browser::root_dir()?
        .parent()
        .ok_or("Общая папка инструментов недоступна")?
        .join("capabilities"));
    #[cfg(not(windows))]
    Ok(crate::paths::app_data_dir()?.join("capabilities"))
}
fn private(path: &Path) -> Result<(), String> {
    if path.is_symlink() {
        return Err("Каталог общих инструментов не должен быть ссылкой".into());
    }
    fs::create_dir_all(path).map_err(|_| "Не удалось создать каталог инструментов")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Не удалось защитить каталог")?;
    }
    Ok(())
}
pub(crate) fn key_for(
    scope: &str,
    directory: Option<&str>,
) -> Result<(String, Option<String>), String> {
    key_for_session(scope, directory, None)
}

/// Resolve a capability registry scope. A session key is derived from the
/// canonical project directory and the exact runtime session id, never from a
/// model- or caller-supplied display string. Existing project/global callers
/// keep their original API and files.
pub(crate) fn key_for_session(
    scope: &str,
    directory: Option<&str>,
    session: Option<&str>,
) -> Result<(String, Option<String>), String> {
    if scope == "global" {
        return Ok(("global".into(), None));
    }
    if scope != "project" && scope != "session" {
        return Err("Неизвестная область".into());
    }
    let p = PathBuf::from(directory.ok_or("Выберите локальный проект")?);
    if !p.is_absolute() || !p.is_dir() {
        return Err("Нужен существующий локальный проект".into());
    }
    let p = fs::canonicalize(p)
        .map_err(|_| "Проект недоступен")?
        .display()
        .to_string();
    let mut h = 0xcbf29ce484222325u64;
    for b in p.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    if scope == "project" {
        return Ok((format!("project-{h:016x}"), Some(p)));
    }
    let session = session.ok_or("Не указана сессия")?;
    if session.is_empty()
        || session.len() > 160
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err("Некорректная сессия".into());
    }
    // The project path participates in the key so a project-local session
    // override cannot collide with a same-named session in another project.
    for b in b"\0session\0".iter().copied().chain(session.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    Ok((format!("session-{h:016x}"), Some(p)))
}
fn read_at(root: &Path, key: &str) -> Result<(Registry, String), String> {
    if !valid_key(key) {
        return Err("Некорректная область".into());
    }
    let path = root.join(format!("{key}.json"));
    let content = match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > LIMIT {
                return Err("Реестр повреждён или слишком велик".into());
            }
            fs::read_to_string(path).map_err(|_| "Реестр должен быть UTF-8")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("Реестр недоступен".into()),
    };
    let config = if content.is_empty() {
        Registry::default()
    } else {
        serde_json::from_str(&content).map_err(|_| "Некорректный реестр")?
    };
    validate(&config)?;
    Ok((config, content))
}
fn validate(r: &Registry) -> Result<(), String> {
    if serde_json::to_vec_pretty(r)
        .map_err(|_| "Реестр повреждён")?
        .len() as u64
        > LIMIT
    {
        return Err("Реестр превышает 256 КиБ".into());
    }
    if r.version != 1 || r.sources.len() > 32 || r.servers.len() > 16 || r.applied_paths.len() > 32
    {
        return Err("Неподдерживаемая версия или слишком много подключений".into());
    }
    let mut sources = std::collections::HashSet::new();
    let mut servers = std::collections::HashSet::new();
    for s in &r.sources {
        if !id(&s.id)
            || !sources.insert(&s.id)
            || !Path::new(&s.path).is_absolute()
            || s.path.len() > 4096
        {
            return Err("Проверьте идентификатор и абсолютный путь источника навыков".into());
        }
    }
    for s in &r.servers {
        if !id(&s.id)
            || !servers.insert(&s.id)
            || s.name.is_empty()
            || s.name.len() > 120
            || s.args.len() > 64
            || s.args.iter().any(|a| a.len() > 4096 || a.contains('\0'))
            || s.auth_revision.as_ref().is_some_and(|v| {
                v.len() > 40 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            || s.env_keys.len() > 32
            || s.env_keys.iter().any(|n| {
                n.is_empty()
                    || !n.as_bytes()[0].is_ascii_alphabetic() && n.as_bytes()[0] != b'_'
                    || n.len() > 64
                    || !n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
            })
        {
            return Err("Проверьте параметры MCP".into());
        }
        match s.kind.as_str() {
            "stdio" => {
                let p = Path::new(&s.command);
                if !p.is_absolute()
                    || s.command.len() > 4096
                    || s.command.contains('\0')
                    || s.bearer
                {
                    return Err(
                        "MCP требует абсолютный путь к программе без shell; токен применим к HTTP"
                            .into(),
                    );
                }
                #[cfg(windows)]
                if matches!(p.extension().and_then(|e| e.to_str()), Some("cmd" | "bat")) {
                    return Err("Укажите node.exe и путь к JS в аргументах, вместо cmd/bat".into());
                }
            }
            "http" => {
                let u = url::Url::parse(&s.url).map_err(|_| "Некорректный URL MCP")?;
                if !u.username().is_empty()
                    || u.password().is_some()
                    || u.query().is_some()
                    || u.fragment().is_some()
                    || !(u.scheme() == "https"
                        || (u.scheme() == "http"
                            && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
                {
                    return Err("Нужен HTTPS или loopback HTTP без секретов в URL".into());
                }
            }
            _ => return Err("Поддерживается stdio или Streamable HTTP".into()),
        }
    }
    Ok(())
}
fn merge_registry(base: &mut Registry, overlay: Registry) {
    let mut sources: BTreeMap<String, Source> =
        base.sources.drain(..).map(|s| (s.id.clone(), s)).collect();
    for source in overlay.sources {
        sources.insert(source.id.clone(), source);
    }
    let mut servers: BTreeMap<String, Server> =
        base.servers.drain(..).map(|s| (s.id.clone(), s)).collect();
    for server in overlay.servers {
        servers.insert(server.id.clone(), server);
    }
    base.sources = sources.into_values().collect();
    base.servers = servers.into_values().collect();
    base.applied_paths = overlay.applied_paths;
    base.directory = overlay.directory;
}

/// Effective layers: global -> project -> session. A session file records its
/// project directory, so it inherits the project's current set without storing
/// a raw path in the registry key.
fn effective(root: &Path, key: &str) -> Result<Registry, String> {
    effective_with_directory(root, key, None)
}

fn effective_with_directory(
    root: &Path,
    key: &str,
    session_directory: Option<&str>,
) -> Result<Registry, String> {
    let (global, _) = read_at(root, "global")?;
    if key == "global" {
        return Ok(global);
    }
    let (local, _) = read_at(root, key)?;
    let mut merged = global;
    if key.starts_with("session-") {
        if let Some(directory) = local.directory.as_deref().or(session_directory) {
            let (project_key, _) = key_for("project", Some(directory))?;
            let (project, _) = read_at(root, &project_key)?;
            merge_registry(&mut merged, project);
        }
    }
    merge_registry(&mut merged, local);
    Ok(merged)
}

fn scripts_ready(runtime: &Path) -> bool {
    FILES
        .iter()
        .all(|(p, s)| fs::read_to_string(runtime.join(p)).ok().as_deref() == Some(*s))
}
fn runtime_ready_at(runtime: &Path) -> bool {
    !runtime.is_symlink()
        && scripts_ready(runtime)
        && fs::read_to_string(runtime.join("node_modules/@modelcontextprotocol/sdk/package.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_some_and(|s| s["version"] == "1.32.0")
}
pub fn runtime_ready() -> bool {
    root().is_ok_and(|p| runtime_ready_at(&p.join("runtime")))
}
fn document(
    scope: &str,
    directory: Option<&str>,
    session: Option<&str>,
) -> Result<Document, String> {
    let (key, scope_directory) = key_for_session(scope, directory, session)?;
    let root = root()?;
    let (mut registry, content) = read_at(&root, &key)?;
    if registry.directory.is_some() && registry.directory != scope_directory {
        // A session can be moved to another project; keep the explicit file but
        // make its current parent explicit on the next save.
        if scope == "session" {
            registry.directory = scope_directory.clone();
        } else {
            return Err("Область проекта не совпадает с реестром".into());
        }
    }
    registry.directory = scope_directory.clone();
    let inherited = if key == "global" {
        Registry::default()
    } else if key.starts_with("session-") {
        // UI must show the project layer as inherited, not only global.
        scope_directory
            .as_deref()
            .and_then(|dir| key_for("project", Some(dir)).ok())
            .map(|(project_key, _)| {
                let mut inherited = read_at(&root, "global").map(|v| v.0).unwrap_or_default();
                if let Ok((project, _)) = read_at(&root, &project_key) {
                    merge_registry(&mut inherited, project);
                }
                inherited
            })
            .unwrap_or_else(|| read_at(&root, "global").map(|v| v.0).unwrap_or_default())
    } else {
        read_at(&root, "global")?.0
    };
    let effective = effective_with_directory(&root, &key, scope_directory.as_deref())?;
    let mut skills = vec![];
    let mut budget = 3000;
    for source in &effective.sources {
        scan(
            Path::new(&source.path),
            &SkillSource {
                source: &source.id,
                managed: true,
                enabled: source.enabled,
                engines: &["pi"],
            },
            &mut skills,
            &mut budget,
            0,
        );
    }
    // Informational only: the runtime loads just the explicit `skillPaths` of
    // enabled registry sources (`runtime_scope`; no ambient SDK discovery), and
    // the UI marks these unmanaged finds "not loaded" so the owner can add the
    // directory as a source. An explicit profile never inspects the owner's
    // `~/.agents` or `~/.pi/agent` (see `paths::discovery_home`).
    let home = crate::paths::discovery_home()?;
    for p in home
        .iter()
        .flat_map(|home| [home.join(".agents/skills"), home.join(".pi/agent/skills")])
    {
        scan(
            &p,
            &SkillSource {
                source: "automatic",
                managed: false,
                enabled: true,
                engines: &["pi"],
            },
            &mut skills,
            &mut budget,
            0,
        );
    }
    if let Some(dir) = directory {
        // Project-local resources load only for trusted projects.
        for suffix in [".agents/skills", ".pi/skills"] {
            scan(
                &Path::new(dir).join(suffix),
                &SkillSource {
                    source: "automatic",
                    managed: false,
                    enabled: true,
                    engines: &["pi"],
                },
                &mut skills,
                &mut budget,
                0,
            );
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    skills.dedup_by(|a, b| a.path == b.path);
    Ok(Document {
        key,
        content,
        registry,
        inherited,
        skills,
        runtime_ready: runtime_ready(),
        command: std::env::current_exe()
            .map_err(|_| "Путь приложения недоступен")?
            .display()
            .to_string(),
        scope_directory,
        source_health: effective
            .sources
            .iter()
            .map(|s| {
                (
                    s.id.clone(),
                    Path::new(&s.path).is_dir() && !Path::new(&s.path).is_symlink(),
                )
            })
            .collect(),
        scan_limited: budget == 0,
    })
}
#[tauri::command]
pub async fn shared_catalog(
    state: tauri::State<'_, SharedRuntime>,
    window: tauri::WebviewWindow,
    scope: String,
    directory: Option<String>,
    session: Option<String>,
) -> Result<Document, String> {
    main_window(&window)?;
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        private(&root()?)?;
        // Shared tools are a product feature, not a manual setup step: repair the
        // runtime before a session asks for its tools. A file refresh is offline;
        // only a missing pinned SDK needs npm, and that runs once per app run.
        repair_shared_runtime(&runtime, None)?;
        authoring::ensure(&root()?)?;
        web_search::ensure(&root()?)?;
        schedules::ensure(&root()?)?;
        image_generation::ensure(&root()?)?;
        document(&scope, directory.as_deref(), session.as_deref())
    })
    .await
    .map_err(|_| "Проверка каталога прервана")?
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        Err("Недоступно в этом окне".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn shared_save(
    window: tauri::WebviewWindow,
    scope: String,
    directory: Option<String>,
    session: Option<String>,
    expected: String,
    registry: Registry,
) -> Result<Document, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (key, dir) = key_for_session(&scope, directory.as_deref(), session.as_deref())?;
        validate(&registry)?;
        if registry.directory != dir {
            return Err("Область реестра изменилась".into());
        }
        let root = root()?;
        private(&root)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("registry.lock"))
            .map_err(|_| "Не удалось открыть блокировку")?;
        lock.try_lock_exclusive()
            .map_err(|_| "Реестр занят другой операцией")?;
        crate::config::write_at(
            &root.join(format!("{key}.json")),
            &expected,
            &serde_json::to_string_pretty(&registry).map_err(|_| "Некорректный реестр")?,
        )?;
        document(&scope, directory.as_deref(), session.as_deref())
    })
    .await
    .map_err(|_| "Сохранение прервано")?
}
#[tauri::command]
pub async fn shared_install(
    state: tauri::State<'_, SharedRuntime>,
    window: tauri::WebviewWindow,
    node_program: Option<String>,
) -> Result<bool, String> {
    main_window(&window)?;
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || install(node_program.as_deref(), &runtime))
        .await
        .map_err(|_| "Установка прервана")?
}
fn recorded_node(runtime: &Path) -> Result<Option<String>, String> {
    let file = runtime.join("node.json");
    match fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= 8192 => {
            let value: Value = serde_json::from_str(
                &fs::read_to_string(&file).map_err(|_| "Настройка Node недоступна")?,
            )
            .map_err(|_| "Настройка Node повреждена")?;
            let node = value["nodeProgram"]
                .as_str()
                .ok_or("Настройка Node повреждена")?;
            if !Path::new(node).is_absolute() {
                return Err("Node должен иметь абсолютный путь".into());
            }
            Ok(Some(node.into()))
        }
        _ => Err("Настройка Node повреждена".into()),
    }
}
fn save_node(runtime: &Path, node: &Path) -> Result<(), String> {
    let content = serde_json::to_string(&serde_json::json!({"nodeProgram":node}))
        .map_err(|_| "Путь Node недоступен")?;
    let target = runtime.join("node.json");
    if fs::read_to_string(&target).ok().as_deref() != Some(&content) {
        let temp = runtime.join("node.json.tmp");
        fs::write(&temp, content).map_err(|_| "Путь Node не сохранён")?;
        fs::rename(temp, target).map_err(|_| "Путь Node не сохранён")?;
    }
    Ok(())
}
/// The pinned SDK is what npm ci provides; scripts are compared separately.
fn dependencies_ready(runtime: &Path) -> bool {
    fs::read_to_string(runtime.join("node_modules/@modelcontextprotocol/sdk/package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v["version"] == "1.32.0")
}
/// One repair attempt per app run: a failing npm must not stall every prompt.
static REPAIR_TRIED: AtomicBool = AtomicBool::new(false);
/// Bring the shared runtime to the files this build embeds. Returns whether it
/// is ready afterwards. Never fatal: a session without tools still works.
pub(crate) fn repair_shared_runtime(
    state: &SharedRuntime,
    runtime: Option<&Path>,
) -> Result<bool, String> {
    let path = runtime
        .map(Path::to_path_buf)
        .unwrap_or(root()?.join("runtime"));
    if !path.is_dir() {
        fs::create_dir_all(&path).map_err(|_| "Каталог общих инструментов недоступен")?;
    }
    // The registry records the Node it launches. Keep that record even when the
    // scripts already match, so a profile that lost it still registers tools.
    if recorded_node(&path)?.is_none() {
        let node = crate::browser::node_program(None)?;
        save_node(&path, &node)?;
    }
    if runtime_ready_at(&path) {
        return Ok(true);
    }
    if REPAIR_TRIED.swap(true, Ordering::AcqRel) {
        return Ok(runtime_ready_at(&path));
    }
    // A failed npm (offline first run) leaves sessions usable without shared tools.
    Ok(match install(None, state) {
        Ok(_) => runtime_ready_at(&path),
        Err(_) => false,
    })
}
/// Write the files this build ships into the shared runtime.
fn sync_scripts(runtime: &Path) -> Result<(), String> {
    for (name, content) in FILES {
        fs::write(runtime.join(name), content).map_err(|_| "Не удалось сохранить мост MCP")?;
    }
    Ok(())
}
fn install(node: Option<&str>, state: &SharedRuntime) -> Result<bool, String> {
    if state.closing.load(Ordering::Acquire) {
        return Err("Установка отменена при выходе".into());
    }
    let root = root()?;
    private(&root)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("install.lock"))
        .map_err(|_| "Блокировка недоступна")?;
    lock.try_lock_exclusive()
        .map_err(|_| "Установка уже выполняется")?;
    let runtime = root.join("runtime");
    private(&runtime)?;
    let recorded = recorded_node(&runtime)?;
    let node = crate::browser::node_program(node.or(recorded.as_deref()))?;
    save_node(&runtime, &node)?;
    if runtime_ready_at(&runtime) {
        return Ok(true);
    }
    // Scripts are refreshed below; only the pinned SDK decides whether npm must run.
    let dependencies_ready = dependencies_ready(&runtime);
    sync_scripts(&runtime)?;
    if dependencies_ready && runtime_ready_at(&runtime) {
        return Ok(true);
    }
    let npm = crate::browser::npm_cli(&node)?;
    let mut command = Command::new(node);
    command
        .arg(npm)
        .args([
            "ci",
            "--ignore-scripts",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
        ])
        .current_dir(&runtime)
        .env_remove("NODE_PATH");
    crate::process::hide_console(&mut command);
    state.installing.store(true, Ordering::Release);
    let result = run_install(&mut command, &state.closing);
    state.installing.store(false, Ordering::Release);
    result?;
    if !runtime_ready_at(&runtime) {
        return Err("MCP SDK не прошёл проверку установки".into());
    }
    Ok(true)
}
fn run_install(command: &mut Command, cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("Установка отменена".into());
    }
    crate::process::own_process_group(command);
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| "MCP SDK не запущен")?;
    #[cfg(windows)]
    let _job = crate::process::KillOnCloseJob::attach(&child).ok();
    let _out = child
        .stdout
        .take()
        .map(|p| crate::process::OutputTail::follow(p, 4096));
    let _err = child
        .stderr
        .take()
        .map(|p| crate::process::OutputTail::follow(p, 4096));
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    loop {
        if cancel.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
            crate::process::terminate_group(&mut child, Duration::from_millis(500));
            return Err("Установка отменена или превысила время ожидания".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Не удалось установить закреплённый MCP SDK".into())
                }
            }
            Ok(None) => {}
            Err(_) => {
                crate::process::terminate_group(&mut child, Duration::from_millis(500));
                return Err("Установка прервана".into());
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}
/// Answer to the runtime's `capabilities.prepare` broker request for one
/// project: registry key/root, enabled skill roots, shared MCP readiness, the
/// Enki executable that serves `--shared-mcp`/`--browser-mcp`, the managed
/// browser and the LSP server list. Shape: `CapabilitiesScope` in
/// resources/agent/src/control/broker.ts. Nothing here starts a process.
pub fn runtime_scope(directory: &Path, session: Option<&str>) -> Result<Value, String> {
    let (key, _) = key_for_session(
        if session.is_some() {
            "session"
        } else {
            "project"
        },
        directory.to_str(),
        session,
    )?;
    let project_key = key_for("project", directory.to_str())?.0;
    let root = root()?;
    // Every session start repairs the shared runtime: an app update changes the
    // embedded files, a fresh profile has none, and a lost node.json is restored.
    let _ = repair_shared_runtime(&SharedRuntime::default(), None);
    authoring::ensure(&root)?;
    web_search::ensure(&root)?;
    schedules::ensure(&root)?;
    image_generation::ensure(&root)?;
    let registry =
        effective_with_directory(&root, &key, Some(directory.to_string_lossy().as_ref()))?;
    let skills: Vec<String> = registry
        .sources
        .iter()
        .filter(|s| s.enabled && Path::new(&s.path).is_dir() && !Path::new(&s.path).is_symlink())
        .map(|s| s.path.clone())
        .collect();
    let servers = registry.servers.iter().any(|s| s.enabled);
    let ready = runtime_ready();
    let browser_skills = crate::browser::installed_skills();
    let lsp = crate::lsp::config_path().ok().filter(|p| p.is_file());
    Ok(serde_json::json!({
        "key": key,
        "root": root,
        "skillPaths": skills,
        "registryKeys": if key == "global" {
            vec!["global"]
        } else if key.starts_with("session-") {
            vec!["global", project_key.as_str(), key.as_str()]
        } else {
            vec!["global", key.as_str()]
        },
        "mcp": servers && ready,
        "mcpUnavailable": (servers && !ready).then_some(
            "Включены MCP-подключения, но общие инструменты не установлены: автоматическая установка не удалась. Проверьте сеть и повторите; повторная установка доступна в настройках Enki.",
        ),
        "executable": std::env::current_exe().map_err(|_| "Путь Enki недоступен")?,
        "browser": browser_skills.is_some(),
        "browserSkillPath": browser_skills,
        // Explicitly enabled computer use on this execution host (null otherwise).
        "computerSkillPath": crate::computer::enabled_skill_path(),
        "lspConfig": lsp,
    }))
}
/// Shared MCP credential account `{scopeKey}/{serverId}`, as shipped.
pub(crate) fn credential_account(key: &str, id: &str) -> Result<String, String> {
    if !valid_key(key) || !self::id(id) {
        return Err("Некорректное подключение".into());
    }
    Ok(format!("{key}/{id}"))
}
pub(crate) fn credential(key: &str, id: &str) -> Result<keyring::Entry, String> {
    let account = credential_account(key, id)?;
    keyring::Entry::new(&crate::paths::SHARED_MCP_SECRETS.service()?, &account)
        .map_err(|_| "Связка ключей недоступна".into())
}
#[tauri::command]
pub async fn shared_mcp_key(
    window: tauri::WebviewWindow,
    key: String,
    id: String,
    value: String,
) -> Result<(), String> {
    main_window(&window)?;
    if value.len() > 8192 || value.contains(['\r', '\n']) {
        return Err("Некорректный токен".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let entry = credential(&key, &id)?;
        if value.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("Не удалось удалить токен".into()),
            }
        } else {
            entry
                .set_password(&value)
                .map_err(|_| "Не удалось сохранить токен".into())
        }
    })
    .await
    .map_err(|_| "Операция связки ключей прервана")?
}
fn proxy_command(
    key: &str,
    id: &str,
    node: Option<&str>,
    inspect: bool,
) -> Result<Command, String> {
    let root = root()?;
    if root.is_symlink() {
        return Err("Реестр инструментов не должен быть ссылкой".into());
    }
    if !runtime_ready() {
        return Err("Общие инструменты не установлены".into());
    }
    let registry = effective(&root, key)?;
    // The JS stdio proxy must see the same global→project→session layers as
    // the native registry check. Pass only validated keys, never paths/secrets.
    let mut registry_keys = vec!["global".to_string()];
    if key.starts_with("session-") {
        if let Some(directory) = read_at(&root, key)?.0.directory {
            if let Ok((project_key, _)) = key_for("project", Some(&directory)) {
                registry_keys.push(project_key);
            }
        }
    }
    registry_keys.push(key.to_string());
    let server = registry
        .servers
        .iter()
        .find(|s| s.id == id && s.enabled)
        .ok_or("Подключение выключено")?;
    let recorded = recorded_node(&root.join("runtime"))?;
    let node = crate::browser::node_program(node.or(recorded.as_deref()))?;
    let mut command = Command::new(node);
    command
        .arg(root.join("runtime/proxy.mjs"))
        .arg(&root)
        .arg(key)
        .arg(id)
        .env("ENKI_MCP_REGISTRY_KEYS", registry_keys.join(","));
    if inspect {
        command.arg("inspect");
    }
    command.env_remove("MESH_MCP_BEARER");
    command.env_remove("ENKI_IMAGE_API_KEY");
    if id == "enki-images" {
        command.env("ENKI_IMAGE_API_KEY", crate::images::load_api_key()?);
        command.env(
            "MESH_CAPABILITIES_COMMAND",
            std::env::current_exe().map_err(|_| "Нативный Enki недоступен")?,
        );
    }
    if server.bearer {
        let (project, _) = read_at(&root, key)?;
        let origin = if project.servers.iter().any(|s| s.id == id) {
            key
        } else {
            "global"
        };
        let token = credential(origin, id)?
            .get_password()
            .map_err(|_| "Токен MCP отсутствует или недоступен")?;
        command.env("MESH_MCP_BEARER", token);
    }
    crate::process::hide_console(&mut command);
    Ok(command)
}
#[tauri::command]
pub async fn shared_probe(
    window: tauri::WebviewWindow,
    scope: String,
    directory: Option<String>,
    session: Option<String>,
    id: String,
    node_program: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (key, _) = key_for_session(&scope, directory.as_deref(), session.as_deref())?;
        let mut command = proxy_command(&key, &id, node_program.as_deref(), true)?;
        if scope == "session" {
            let project_key = directory
                .as_deref()
                .and_then(|dir| key_for("project", Some(dir)).ok())
                .map(|value| value.0);
            if let Some(project_key) = project_key {
                command.env(
                    "ENKI_MCP_REGISTRY_KEYS",
                    format!("global,{project_key},{key}"),
                );
            }
        }
        command.current_dir(
            directory
                .map(PathBuf::from)
                .unwrap_or(crate::paths::user_home()?),
        );
        let out = crate::process::output_with_timeout(&mut command, Duration::from_secs(50), 65536)
            .map_err(|_| "MCP не ответил за время проверки")?;
        if !out.status.success() {
            return Err("MCP не подключён. Проверьте программу, зависимости и авторизацию".into());
        }
        serde_json::from_slice(&out.stdout).map_err(|_| "MCP вернул некорректный каталог".into())
    })
    .await
    .map_err(|_| "Проверка MCP прервана")?
}
pub fn mcp_main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err("Некорректный запуск MCP".into());
    }
    let mut command = proxy_command(&args[2], &args[3], None, false)?;
    if args.len() > 4 {
        command.env("ENKI_MCP_REGISTRY_KEYS", args[4..].join(","));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(format!("Мост MCP не запущен: {}", command.exec()))
    }
    #[cfg(not(unix))]
    let mut child = command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Мост MCP не запущен")?;
    #[cfg(windows)]
    let _job = match crate::process::KillOnCloseJob::attach(&child) {
        Ok(job) => job,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Не удалось изолировать процесс MCP".into());
        }
    };
    #[cfg(not(unix))]
    let status = child.wait().map_err(|_| "Мост MCP прерван")?;
    #[cfg(not(unix))]
    {
        if status.success() {
            Ok(())
        } else {
            Err("Общий MCP недоступен; действие не повторялось".into())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shipped_scripts_are_restored_without_network_and_without_touching_dependencies() {
        let root = std::env::temp_dir().join(format!(
            "enki-sync-scripts-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("node_modules/@modelcontextprotocol/sdk")).unwrap();
        fs::write(
            root.join("node_modules/@modelcontextprotocol/sdk/package.json"),
            r#"{"version":"1.32.0"}"#,
        )
        .unwrap();
        assert!(!scripts_ready(&root), "an empty runtime is not ready");
        assert!(dependencies_ready(&root));
        sync_scripts(&root).unwrap();
        assert!(scripts_ready(&root));
        assert!(
            runtime_ready_at(&root),
            "scripts plus the pinned SDK are enough; npm must not run for a file refresh"
        );
        // A stale script is repaired by the same call.
        fs::write(root.join("proxy.mjs"), "stale").unwrap();
        assert!(!scripts_ready(&root));
        sync_scripts(&root).unwrap();
        assert!(runtime_ready_at(&root));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn the_recorded_node_survives_and_can_be_restored_by_repair() {
        let root = std::env::temp_dir().join(format!(
            "enki-node-record-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        assert!(recorded_node(&root).unwrap().is_none());
        let node = crate::browser::node_program(None).unwrap();
        save_node(&root, &node).unwrap();
        assert_eq!(
            recorded_node(&root).unwrap().as_deref(),
            node.to_str()
        );
        // Repair keeps an existing record instead of rewriting it on every call.
        let before = fs::read_to_string(root.join("node.json")).unwrap();
        save_node(&root, &node).unwrap();
        assert_eq!(fs::read_to_string(root.join("node.json")).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_missing_pinned_sdk_is_the_only_reason_to_run_npm() {
        let root = std::env::temp_dir().join(format!(
            "enki-no-sdk-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        assert!(!dependencies_ready(&root));
        sync_scripts(&root).unwrap();
        assert!(scripts_ready(&root));
        assert!(!runtime_ready_at(&root), "without the SDK the runtime stays unready");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shared_runtime_ships_no_agent_engine_plugins() {
        // Agent-side gates and bridges are bundled into the Enki Runtime; the
        // shared MCP runtime only carries the registry and proxy scripts.
        for (name, _) in FILES {
            assert!(!name.ends_with(".ts"), "{name}");
            assert_ne!(*name, "access-policy.mjs");
        }
    }
    #[test]
    fn validates_scope_and_no_shell_or_secret_url() {
        assert!(valid_key("global"));
        assert!(valid_key("project-0123456789abcdef"));
        assert!(valid_key("session-0123456789abcdef"));
        assert!(!valid_key("../keys"));
        let dir = std::env::temp_dir().join(format!("enki-scope-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (project_key, _) = key_for("project", Some(dir.to_str().unwrap())).unwrap();
        let (session_key, _) =
            key_for_session("session", Some(dir.to_str().unwrap()), Some("chat-a")).unwrap();
        assert!(project_key.starts_with("project-"));
        assert!(session_key.starts_with("session-"));
        assert_ne!(project_key, session_key);
        let (other, _) =
            key_for_session("session", Some(dir.to_str().unwrap()), Some("chat-b")).unwrap();
        assert_ne!(session_key, other);
        fs::remove_dir_all(dir).unwrap();
        assert!(!id("name/../../"));
        let mut r = Registry::default();
        r.servers.push(Server {
            id: "demo".into(),
            name: "Demo".into(),
            enabled: true,
            kind: "http".into(),
            command: "".into(),
            args: vec![],
            url: "https://example.com/mcp".into(),
            env_keys: vec![],
            bearer: false,
            auth_revision: None,
        });
        assert!(validate(&r).is_ok());
        r.servers[0].env_keys = vec!["1SECRET".into()];
        assert!(validate(&r).is_err());
        r.servers[0].env_keys.clear();
        for url in [
            "http://remote/mcp",
            "https://user:secret@example.com/mcp",
            "https://example.com/mcp?token=secret",
        ] {
            r.servers[0].url = url.into();
            assert!(validate(&r).is_err());
        }
    }
    #[test]
    fn metadata_reads_do_not_follow_links_and_support_folded_descriptions() {
        let root = std::env::temp_dir().join(format!("mesh-skills-{}", std::process::id()));
        fs::create_dir_all(root.join("demo")).unwrap();
        fs::write(
            root.join("demo/SKILL.md"),
            "---\nname: demo\ndescription: >\n  Two lines\n  of description\n---\nDo work",
        )
        .unwrap();
        let mut out = vec![];
        scan(
            &root,
            &SkillSource {
                source: "demo",
                managed: true,
                enabled: true,
                engines: &["pi"],
            },
            &mut out,
            &mut 20,
            0,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].description, "Two lines of description");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("demo"), root.join("linked")).unwrap();
        }
        let mut again = vec![];
        scan(
            &root,
            &SkillSource {
                source: "demo",
                managed: true,
                enabled: true,
                engines: &["pi"],
            },
            &mut again,
            &mut 20,
            0,
        );
        assert_eq!(
            again.len(),
            1,
            "A symlink duplicated or escaped skill discovery"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_project_overrides_are_isolated_from_global_registry() {
        let root = std::env::temp_dir().join(format!("mesh-registry-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let mut r = Registry::default();
        r.sources.push(Source {
            id: "common".into(),
            path: root.display().to_string(),
            enabled: true,
        });
        fs::write(root.join("global.json"), serde_json::to_string(&r).unwrap()).unwrap();
        r.sources[0].enabled = false;
        fs::write(
            root.join("project-0123456789abcdef.json"),
            serde_json::to_string(&r).unwrap(),
        )
        .unwrap();
        assert!(
            !effective(&root, "project-0123456789abcdef")
                .unwrap()
                .sources[0]
                .enabled
        );
        assert!(effective(&root, "global").unwrap().sources[0].enabled);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recorded_node_refuses_relative_and_linked_configuration() {
        let root = std::env::temp_dir().join(format!("mesh-node-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(recorded_node(&root).unwrap().is_none());
        fs::write(root.join("node.json"), r#"{"nodeProgram":"node"}"#).unwrap();
        assert!(recorded_node(&root).is_err());
        save_node(&root, &root.join("node")).unwrap();
        assert_eq!(
            recorded_node(&root).unwrap(),
            Some(root.join("node").display().to_string())
        );
        #[cfg(unix)]
        {
            fs::remove_file(root.join("node.json")).unwrap();
            fs::write(root.join("other.json"), "{}").unwrap();
            std::os::unix::fs::symlink(root.join("other.json"), root.join("node.json")).unwrap();
            assert!(recorded_node(&root).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oversized_registry_is_refused_before_it_can_be_written() {
        let mut r = Registry::default();
        for i in 0..3 {
            r.servers.push(Server {
                id: format!("server-{i}"),
                name: "Large".into(),
                enabled: true,
                kind: "stdio".into(),
                command: std::env::current_exe().unwrap().display().to_string(),
                args: vec!["a".repeat(4096); 64],
                url: String::new(),
                env_keys: vec![],
                bearer: false,
                auth_revision: None,
            });
        }
        assert!(validate(&r).unwrap_err().contains("256"));
    }
}
