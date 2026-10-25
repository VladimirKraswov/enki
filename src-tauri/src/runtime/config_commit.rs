//! Native authority for imported Pi configuration and versioned credentials.
//!
//! One private SQLite journal below the profile-specific app data root is the
//! ONLY commit authority. Its single `head` row is changed by compare-and-set:
//! `{revision, generation, manifestHash}` plus the generation's
//! logical-binding -> immutable vault account map. Keyring writes are never a
//! multi-key transaction; each secret revision gets a fresh account owned by
//! one operation, so a crash at any boundary leaves either the previous head
//! (and owned, unreferenced staged refs that recovery deletes) or the new head
//! with every staged ref already verified. Secret values never enter the
//! journal, staged files, receipts, events or error text.

use super::config_fs as cfs;
use super::vault::{self, SecretOs, VaultError, MAX_SECRET};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const MAX_FILE: u64 = 4 * 1024 * 1024;
pub const MAX_TOTAL: u64 = 12 * 1024 * 1024;
/// Every chunk but the last is exactly this size: retries map to one offset.
pub const CHUNK: usize = 48 * 1024;
pub const MAX_BINDINGS: usize = 1024;
const MAX_MANIFEST: usize = 512 * 1024;
const MAX_OPEN_OPERATIONS: i64 = 4;
const FILES: [&str; 3] = ["models.json", "settings.json", "keybindings.json"];
const KINDS: [&str; 3] = ["api-key", "header", "credential"];

pub const E_REVISION: &str =
    "CONFIG_REVISION_CONFLICT: настройки изменились другим импортом; повторите перенос";
pub const E_OPERATION: &str =
    "CONFIG_OPERATION_CONFLICT: идентификатор операции уже использован с другими данными";
pub const E_OWNER: &str = "CONFIG_OPERATION_OWNER: операция принадлежит другому поколению ядра";
pub const E_PHASE: &str = "CONFIG_OPERATION_PHASE: операция уже завершена или прервана";
pub const E_UNKNOWN: &str = "CONFIG_OPERATION_UNKNOWN: операция импорта не найдена";
pub const E_SCHEMA: &str = "CONFIG_SCHEMA: некорректный или неподдерживаемый манифест настроек";
pub const E_SECRET_CONFLICT: &str =
    "CONFIG_SECRET_CONFLICT: повтор операции содержит другой секрет";
pub const E_SECRET_MISSING: &str =
    "CONFIG_SECRET_UNAVAILABLE: обязательный ключ отсутствует в хранилище ОС";
pub const E_SECRET_SIZE: &str = "CONFIG_SECRET_TOO_LARGE: секрет превышает предел хранилища ОС";
pub const E_INCOMPLETE: &str = "CONFIG_INCOMPLETE: не все файлы или секреты операции получены";
pub const E_BUSY: &str = "CONFIG_BUSY: слишком много незавершённых операций настроек";
pub const E_DB: &str = "CONFIG_JOURNAL: журнал настроек недоступен";
pub const E_CHANGED: &str =
    "CONFIG_REVISION_CHANGED: активные настройки сменились; перечитайте снимок";
/// Typed bounded-wait outcome: the OS authority lease was not obtained before
/// the deadline, so this call performed NO read-modify-write and NO recovery.
/// Only the WAIT is bounded: a keychain/SQLite call that stalls inside the
/// holder's call cannot be interrupted, and its outcome stays unknown until
/// it returns; the caller reconciles it with the same operationId/status.
pub const E_LOCK_BUSY: &str = "CONFIG_AUTHORITY_BUSY: хранилище настроек занято другой операцией; ничего не изменено, повторите позже";
pub const E_REVOKED: &str =
    "CONFIG_GENERATION_REVOKED: поколение ядра завершается; операция не допущена";
/// Shorter than the runtime's 5 s replacement drain (runtime.rs, start of a
/// new child). A waiting call of a revoked generation does not wait it out:
/// its admission is polled during the wait and it returns revoked at once.
pub const LOCK_DEADLINE: Duration = Duration::from_secs(3);

/// Test-only crash injection: an Err at a named boundary aborts the call
/// exactly as process death would, leaving only what is already durable.
pub type Fault = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
/// Live admission of one broker request (production: its retained
/// GenerationPermit, see runtime.rs `BrokerJob::admission`). Checked before
/// the call, polled while the OS lease is awaited and re-checked once it is
/// held, before any claim, recovery or write. A call admitted under the lease
/// runs to completion; drain awaits it because the closure owns a permit share.
pub type Admission = Arc<dyn Fn() -> bool + Send + Sync>;

pub struct Authority {
    root: PathBuf,
    os: Arc<dyn SecretOs>,
    /// Broker generation that owns operations begun through this handle.
    owner: String,
    fault: Option<Fault>,
    lock_deadline: Duration,
    admission: Option<Admission>,
    /// Native process identity whose OS lease proves liveness of its open
    /// operations to other processes (see `recover`).
    process: String,
}

/// One random identity per native process. Never reused, so a lease file of a
/// dead identity can be removed without racing a successor.
fn process_identity() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        vault::random_id().unwrap_or_else(|_| format!("pid{}-{}", std::process::id(), now()))
    })
}

/// Held for the life of the process (or released by tests to model death);
/// the OS drops the lock when the process dies, even after a crash.
fn leases() -> &'static Mutex<HashMap<PathBuf, File>> {
    static LEASES: OnceLock<Mutex<HashMap<PathBuf, File>>> = OnceLock::new();
    LEASES.get_or_init(Default::default)
}

/// Writer exclusivity of broker generations inside one native process, per
/// authority root. The runtime starts a child only after revoking and
/// draining the previous one (runtime.rs: `previous.gate.revoke()` +
/// `wait_drained_until`); this registry ENFORCES that precondition here
/// instead of assuming it: the first claiming (mutating or cancelling) call of
/// a new generation retires the previous claimant, whose every later call is
/// CONFIG_GENERATION_REVOKED. Only a retired owner's open jobs are reclaimed.
#[derive(Default)]
struct Writers {
    /// (root, process) -> the generation that made the latest claiming call.
    current: HashMap<(PathBuf, String), String>,
    /// (root, generation) superseded in this process; never re-admitted.
    retired: HashSet<(PathBuf, String)>,
}

fn writers() -> &'static Mutex<Writers> {
    static WRITERS: OnceLock<Mutex<Writers>> = OnceLock::new();
    WRITERS.get_or_init(Default::default)
}

fn private_lock_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(|_| cfs::ERR_UNSAFE.into())
}

enum Lock {
    Busy,
    Failed,
}

fn try_lock(file: &File) -> Result<(), Lock> {
    match fs2::FileExt::try_lock_exclusive(file) {
        Ok(()) => Ok(()),
        Err(e)
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
        {
            Err(Lock::Busy)
        }
        Err(_) => Err(Lock::Failed),
    }
}

/// Deadline-bounded exclusive lock: try-lock with capped exponential backoff.
/// Never blocks in the OS lock call, never touches a foreign holder. A
/// generation revoked while waiting stops waiting (nothing was done yet), so
/// it never holds its drain open until the deadline.
fn lock_until(file: &File, deadline: Instant, revoked: &dyn Fn() -> bool) -> Result<(), String> {
    let mut pause = Duration::from_millis(2);
    loop {
        match try_lock(file) {
            Ok(()) if Instant::now() <= deadline => return Ok(()),
            // Obtained only after the deadline: admit nothing (drop unlocks).
            Ok(()) => return Err(E_LOCK_BUSY.into()),
            Err(Lock::Failed) => return Err(cfs::ERR_IO.into()),
            Err(Lock::Busy) if revoked() => return Err(E_REVOKED.into()),
            Err(Lock::Busy) => {}
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(E_LOCK_BUSY.into());
        }
        std::thread::sleep(pause.min(left));
        pause = (pause * 2).min(Duration::from_millis(100));
    }
}

struct Open {
    db: Connection,
    _lock: File,
}

#[derive(Clone)]
struct Binding {
    logical: String,
    provider: Option<String>,
    kind: String,
    pointer: String,
}

struct Manifest {
    value: Value,
    hash: String,
    expected: u64,
    files: Vec<(String, String, u64)>,
    bindings: Vec<Binding>,
}

fn db_err(_: rusqlite::Error) -> String {
    E_DB.into()
}
fn os_err(error: VaultError) -> String {
    error.message().into()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const SCHEMA: &str = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS head(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, generation TEXT, manifest_hash TEXT, operation TEXT, receipt TEXT);
INSERT OR IGNORE INTO head(id,revision) VALUES(1,0);
CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('prepared','published','committed','aborted')), expected INTEGER NOT NULL, manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL, generation TEXT NOT NULL UNIQUE, receipt TEXT, error TEXT, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS op_files(operation TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, next_index INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(operation,name));
CREATE TABLE IF NOT EXISTS bindings(generation TEXT NOT NULL, logical TEXT NOT NULL, account TEXT, provider TEXT, kind TEXT NOT NULL, pointer TEXT NOT NULL, PRIMARY KEY(generation,logical));
CREATE TABLE IF NOT EXISTS entries(account TEXT PRIMARY KEY, logical TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('intent','staged','live')));
CREATE TABLE IF NOT EXISTS credentials(logical TEXT PRIMARY KEY, revision INTEGER NOT NULL, account TEXT, source TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cas_receipts(operation TEXT PRIMARY KEY, logical TEXT NOT NULL, expected INTEGER NOT NULL, revision INTEGER NOT NULL, conflict INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cas_requests(operation TEXT PRIMARY KEY, request TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS op_process(operation TEXT PRIMARY KEY, process TEXT NOT NULL);";

impl Authority {
    /// Production authority: profile-specific root and the real OS keychain.
    /// Nothing is created here: the root appears on the first mutating call.
    pub fn production(owner: &str) -> Result<Self, String> {
        let root = crate::paths::app_data_dir()?.join("runtime-config");
        Ok(Self::new(root, vault::platform_os()?, owner, None))
    }

    /// No journal yet means no import and no versioned credential ever existed.
    fn initialized(&self) -> bool {
        std::fs::symlink_metadata(self.root.join("authority.sqlite")).is_ok()
    }

    pub fn new(root: PathBuf, os: Arc<dyn SecretOs>, owner: &str, fault: Option<Fault>) -> Self {
        Self {
            root,
            os,
            owner: owner.to_string(),
            fault,
            lock_deadline: LOCK_DEADLINE,
            admission: None,
            process: process_identity().to_string(),
        }
    }

    /// Tests bound the wait below the production `LOCK_DEADLINE`.
    #[cfg(test)]
    pub fn with_lock_deadline(mut self, deadline: Duration) -> Self {
        self.lock_deadline = deadline;
        self
    }

    /// Production: `serve` (the only local dispatch path) always installs it.
    pub fn with_admission(mut self, admission: Admission) -> Self {
        self.admission = Some(admission);
        self
    }

    fn revoked(&self) -> bool {
        self.admission.as_ref().is_some_and(|admitted| !admitted())
    }

    /// Tests model a second native process inside one test binary.
    #[cfg(test)]
    pub fn with_process(mut self, process: &str) -> Self {
        self.process = process.to_string();
        self
    }

    fn lease_path(&self, process: &str) -> Result<PathBuf, String> {
        if !process
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || process.is_empty()
            || process.len() > 64
        {
            return Err(cfs::ERR_UNSAFE.into());
        }
        Ok(cfs::ensure_child_dir(&self.root, "owners")?.join(format!("{process}.lease")))
    }

    /// Acquire (once per process and root) this process's liveness lease.
    /// Must be held before this process journals any open operation.
    fn hold_process_lease(&self) -> Result<(), String> {
        let path = self.lease_path(&self.process)?;
        let mut held = leases().lock().map_err(|_| E_DB)?;
        if let std::collections::hash_map::Entry::Vacant(slot) = held.entry(path) {
            let file = private_lock_file(slot.key())?;
            try_lock(&file)
                .map_err(|_| "CONFIG_PROCESS_LEASE: идентичность процесса уже занята")?;
            slot.insert(file);
        }
        Ok(())
    }

    /// Proof of death of ANOTHER native process: its lease can be locked (the
    /// OS released it with the process) or was already removed after such a
    /// proof. Any doubt (contended, unreadable, unsafe) means alive.
    fn process_dead(&self, process: &str) -> bool {
        let Ok(path) = self.lease_path(process) else {
            return false;
        };
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
            Ok(meta) if !meta.is_file() => return false,
            Ok(_) => {}
        }
        let Ok(file) = private_lock_file(&path) else {
            return false;
        };
        let dead = try_lock(&file).is_ok();
        drop(file);
        if dead {
            // Identity is never reused; only the authority lock holder gets here.
            let _ = std::fs::remove_file(&path);
        }
        dead
    }

    /// Tests model the death of a `with_process` identity: the OS lease is
    /// released exactly as the OS releases it when that process exits.
    #[cfg(test)]
    pub fn release_process_lease(&self) {
        if let (Ok(path), Ok(mut held)) = (self.lease_path(&self.process), leases().lock()) {
            held.remove(&path);
        }
    }

    /// Under the OS lease: refuse a retired generation; a claiming call makes
    /// this generation the process's writer and retires the previous one.
    fn enter(&self, claim: bool) -> Result<(), String> {
        let mut writers = writers().lock().map_err(|_| E_DB)?;
        if writers
            .retired
            .contains(&(self.root.clone(), self.owner.clone()))
        {
            return Err(E_REVOKED.into());
        }
        if claim {
            let key = (self.root.clone(), self.process.clone());
            if let Some(previous) = writers.current.insert(key, self.owner.clone()) {
                if previous != self.owner {
                    writers.retired.insert((self.root.clone(), previous));
                }
            }
        }
        Ok(())
    }

    fn retired(&self, owner: &str) -> bool {
        writers()
            .lock()
            .is_ok_and(|w| w.retired.contains(&(self.root.clone(), owner.to_string())))
    }

    fn fault(&self, point: &str) -> Result<(), String> {
        self.fault.as_ref().map_or(Ok(()), |fault| fault(point))
    }

    fn staging(&self) -> Result<PathBuf, String> {
        cfs::ensure_child_dir(&self.root, "staging")
    }
    fn generations(&self) -> Result<PathBuf, String> {
        cfs::ensure_child_dir(&self.root, "generations")
    }

    /// Claiming call (mutation or cancellation): see `open_as`.
    fn open(&self) -> Result<Open, String> {
        self.open_as(true)
    }

    /// Read-only call: never supersedes another generation and never
    /// reclaims a job whose owner is not PROVEN dead or retired.
    fn observe(&self) -> Result<Open, String> {
        self.open_as(false)
    }

    /// Exclusive inter-process OS lease for the whole call, obtained within
    /// `lock_deadline` or refused with CONFIG_AUTHORITY_BUSY (nothing read-
    /// modified, nothing recovered). Admission is checked before, during and
    /// after the wait; the check under the lease is authoritative (a revoked
    /// generation claims, recovers and mutates nothing). Then writer
    /// exclusivity and recovery of what crashed calls or dead/retired owners
    /// left behind.
    fn open_as(&self, claim: bool) -> Result<Open, String> {
        if self.revoked() {
            return Err(E_REVOKED.into());
        }
        let deadline = Instant::now() + self.lock_deadline;
        let (Some(parent), Some(name)) = (
            self.root.parent(),
            self.root.file_name().and_then(|n| n.to_str()),
        ) else {
            return Err(cfs::ERR_UNSAFE.into());
        };
        cfs::check_dir_chain(parent)?;
        cfs::ensure_child_dir(parent, name)?;
        cfs::check_dir_chain(&self.root)?;
        let lock = private_lock_file(&self.root.join("authority.lock"))?;
        lock_until(&lock, deadline, &|| self.revoked())?;
        if self.revoked() {
            return Err(E_REVOKED.into());
        }
        self.enter(claim)?;
        self.hold_process_lease()?;
        let path = self.root.join("authority.sqlite");
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            return Err(cfs::ERR_UNSAFE.into());
        }
        let db = Connection::open(&path).map_err(db_err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| cfs::ERR_IO)?;
        }
        // Every journal user holds the OS lease, so SQLite contention is not
        // expected; still bounded by what is left of this call's deadline.
        db.busy_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(50)),
        )
        .map_err(db_err)?;
        db.execute_batch(SCHEMA).map_err(db_err)?;
        let open = Open { db, _lock: lock };
        self.recover(&open, claim)?;
        Ok(open)
    }
}

fn hex64(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn bounded_text(value: &Value, max: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
}
fn exact(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.keys().all(|key| keys.contains(&key.as_str()))
}

/// The manifest is the frozen plan WITHOUT `secrets`: file names/hashes/sizes,
/// source hashes, bindings, deferred resource pointers and discovery policy.
fn manifest(value: &Value) -> Result<Manifest, String> {
    let bad = || E_SCHEMA.to_string();
    let object = value.as_object().ok_or_else(bad)?;
    let keys = [
        "version",
        "origin",
        "expectedRevision",
        "files",
        "sourceHashes",
        "bindings",
        "deferred",
        "discovery",
    ];
    if !exact(object, &keys) || object.len() != keys.len() || value["version"] != 1 {
        return Err(bad());
    }
    bounded_text(&value["origin"], 256).ok_or_else(bad)?;
    let expected = value["expectedRevision"].as_u64().ok_or_else(bad)?;
    let raw_files = value["files"]
        .as_array()
        .filter(|f| f.len() <= FILES.len())
        .ok_or_else(bad)?;
    let mut files = Vec::new();
    let mut total = 0_u64;
    for file in raw_files {
        let item = file
            .as_object()
            .filter(|o| exact(o, &["name", "sha256", "size"]) && o.len() == 3)
            .ok_or_else(bad)?;
        let name = item["name"]
            .as_str()
            .filter(|n| FILES.contains(n))
            .ok_or_else(bad)?;
        let size = item["size"]
            .as_u64()
            .filter(|s| (1..=MAX_FILE).contains(s))
            .ok_or_else(bad)?;
        if !hex64(&item["sha256"])
            || files
                .iter()
                .any(|(n, _, _): &(String, String, u64)| n == name)
        {
            return Err(bad());
        }
        total += size;
        files.push((
            name.to_string(),
            item["sha256"].as_str().unwrap_or_default().to_string(),
            size,
        ));
    }
    if total > MAX_TOTAL {
        return Err(bad());
    }
    let sources = value["sourceHashes"].as_object().ok_or_else(bad)?;
    if sources.len() > 4
        || !sources
            .iter()
            .all(|(k, v)| (FILES.contains(&k.as_str()) || k == "auth.json") && hex64(v))
    {
        return Err(bad());
    }
    let raw_bindings = value["bindings"]
        .as_array()
        .filter(|b| b.len() <= MAX_BINDINGS)
        .ok_or_else(bad)?;
    let mut bindings: Vec<Binding> = Vec::new();
    for binding in raw_bindings {
        let item = binding
            .as_object()
            .filter(|o| exact(o, &["vaultId", "pointer", "provider", "kind"]) && o.len() == 4)
            .ok_or_else(bad)?;
        let logical = item["vaultId"]
            .as_str()
            .filter(|id| vault::valid_import_id(id))
            .ok_or_else(bad)?;
        let pointer = bounded_text(&item["pointer"], 4096)
            .filter(|p| p.starts_with('/'))
            .ok_or_else(bad)?;
        let kind = item["kind"]
            .as_str()
            .filter(|k| KINDS.contains(k))
            .ok_or_else(bad)?;
        let provider = match &item["provider"] {
            Value::Null if kind != "credential" => None,
            Value::String(p) if vault::valid_provider(p) => Some(p.clone()),
            _ => return Err(
                "CONFIG_PROVIDER_ID_UNSUPPORTED: имя провайдера не поддерживается хранилищем Enki"
                    .into(),
            ),
        };
        if bindings.iter().any(|b| b.logical == logical) {
            return Err(bad());
        }
        bindings.push(Binding {
            logical: logical.into(),
            provider,
            kind: kind.into(),
            pointer: pointer.into(),
        });
    }
    let deferred = value["deferred"]
        .as_array()
        .filter(|d| d.len() <= 256)
        .ok_or_else(bad)?;
    if !deferred.iter().all(|d| bounded_text(d, 4096).is_some()) {
        return Err(bad());
    }
    let discovery = value["discovery"].as_object().ok_or_else(bad)?;
    let policy = ["extensions", "skills", "prompts", "packages", "project"];
    if discovery.len() != policy.len()
        || !policy
            .iter()
            .all(|k| discovery.get(*k) == Some(&Value::Bool(false)))
    {
        return Err(bad());
    }
    let bytes = serde_json::to_vec(value).map_err(|_| bad())?;
    if bytes.len() > MAX_MANIFEST {
        return Err(bad());
    }
    Ok(Manifest {
        value: value.clone(),
        hash: vault::sha256_hex(&bytes),
        expected,
        files,
        bindings,
    })
}

struct OpRow {
    owner: String,
    phase: String,
    expected: u64,
    manifest_hash: String,
    generation: String,
    receipt: Option<String>,
    error: Option<String>,
}

fn operation(db: &Connection, id: &str) -> Result<Option<OpRow>, String> {
    db.query_row(
        "SELECT owner,phase,expected,manifest_hash,generation,receipt,error FROM operations WHERE id=?1",
        [id],
        |r| {
            Ok(OpRow {
                owner: r.get(0)?,
                phase: r.get(1)?,
                expected: r.get::<_, i64>(2)? as u64,
                manifest_hash: r.get(3)?,
                generation: r.get(4)?,
                receipt: r.get(5)?,
                error: r.get(6)?,
            })
        },
    )
    .optional()
    .map_err(db_err)
}

fn head(db: &Connection) -> Result<(u64, Option<String>), String> {
    db.query_row("SELECT revision,generation FROM head WHERE id=1", [], |r| {
        Ok((r.get::<_, i64>(0)? as u64, r.get(1)?))
    })
    .map_err(db_err)
}

fn op_id(params: &Value) -> Result<String, String> {
    params["operationId"]
        .as_str()
        .filter(|id| vault::valid_operation_id(id))
        .map(str::to_string)
        .ok_or_else(|| E_SCHEMA.into())
}

impl Authority {
    /// The operation must still be open and owned by this broker generation.
    fn owned(&self, db: &Connection, id: &str) -> Result<OpRow, String> {
        let row = operation(db, id)?.ok_or(E_UNKNOWN)?;
        if row.phase == "committed" || row.phase == "aborted" {
            return Err(E_PHASE.into());
        }
        if row.owner != self.owner {
            return Err(E_OWNER.into());
        }
        Ok(row)
    }

    pub fn begin(&self, params: &Value) -> Result<Value, String> {
        let id = op_id(params)?;
        let manifest = manifest(&params["manifest"])?;
        let mut open = self.open()?;
        let (revision, _) = head(&open.db)?;
        if let Some(row) = operation(&open.db, &id)? {
            // Same id + same sanitized payload is a lost-ACK retry, never a new job.
            if row.manifest_hash != manifest.hash {
                return Err(E_OPERATION.into());
            }
            return Ok(
                json!({ "operationId": id, "phase": row.phase, "configRevision": revision }),
            );
        }
        if manifest.expected != revision {
            return Err(E_REVISION.into());
        }
        let generation = format!("g{}", vault::random_id()?);
        let tx = open
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let open_ops: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM operations WHERE phase IN ('prepared','published')",
                [],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if open_ops >= MAX_OPEN_OPERATIONS {
            return Err(E_BUSY.into());
        }
        tx.execute(
            "INSERT INTO operations(id,owner,phase,expected,manifest,manifest_hash,generation,updated) VALUES(?1,?2,'prepared',?3,?4,?5,?6,?7)",
            params![id, self.owner, manifest.expected as i64, manifest.value.to_string(), manifest.hash, generation, now()],
        )
        .map_err(db_err)?;
        // The process lease is already held (open), so this row is never
        // observable by another process while its owner could be dead-proven.
        tx.execute(
            "INSERT INTO op_process(operation,process) VALUES(?1,?2)",
            params![id, self.process],
        )
        .map_err(db_err)?;
        for (name, sha, size) in &manifest.files {
            tx.execute(
                "INSERT INTO op_files(operation,name,sha256,size) VALUES(?1,?2,?3,?4)",
                params![id, name, sha, *size as i64],
            )
            .map_err(db_err)?;
        }
        for b in &manifest.bindings {
            tx.execute(
                "INSERT INTO bindings(generation,logical,account,provider,kind,pointer) VALUES(?1,?2,NULL,?3,?4,?5)",
                params![generation, b.logical, b.provider, b.kind, b.pointer],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        self.fault("begin.journaled")?;
        cfs::ensure_child_dir(&self.staging()?, &id)?;
        Ok(json!({ "operationId": id, "phase": "prepared", "configRevision": revision }))
    }

    pub fn file_chunk(&self, params: &Value) -> Result<Value, String> {
        let id = op_id(params)?;
        let name = params["name"]
            .as_str()
            .filter(|n| FILES.contains(n))
            .ok_or(E_SCHEMA)?;
        let index = params["index"].as_u64().ok_or(E_SCHEMA)?;
        let encoded = params["dataBase64"]
            .as_str()
            .filter(|d| d.len() <= CHUNK / 3 * 4 + 4)
            .ok_or(E_SCHEMA)?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| E_SCHEMA)?;
        if bytes.is_empty() || bytes.len() > CHUNK {
            return Err(E_SCHEMA.into());
        }
        let open = self.open()?;
        let row = self.owned(&open.db, &id)?;
        if row.phase != "prepared" {
            return Err(E_PHASE.into());
        }
        let (size, received, next): (i64, i64, i64) = open
            .db
            .query_row(
                "SELECT size,received,next_index FROM op_files WHERE operation=?1 AND name=?2",
                params![id, name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_err)?
            .ok_or(E_SCHEMA)?;
        let offset = index.checked_mul(CHUNK as u64).ok_or(E_SCHEMA)?;
        let path = self.staging()?.join(&id).join(name);
        if (index as i64) < next {
            // Lost ACK: the journaled bytes must be exactly these bytes.
            let end = offset + bytes.len() as u64;
            let complete = bytes.len() == CHUNK || end == size as u64;
            if !complete
                || end > received as u64
                || cfs::read_range(&path, offset, bytes.len())? != bytes
            {
                return Err(E_OPERATION.into());
            }
            return Ok(json!({ "received": received }));
        }
        let last = offset + bytes.len() as u64 == size as u64;
        if index as i64 != next
            || offset != received as u64
            || (!last && bytes.len() != CHUNK)
            || offset + bytes.len() as u64 > size as u64
        {
            return Err("CONFIG_CHUNK_ORDER: фрагмент настроек получен не по порядку".into());
        }
        cfs::write_chunk(&path, offset, &bytes)?;
        self.fault("chunk.written")?;
        // (journal update below; a crash before it is truncated on retry)
        let total = received + bytes.len() as i64;
        open.db
            .execute(
                "UPDATE op_files SET received=?1,next_index=?2 WHERE operation=?3 AND name=?4",
                params![total, next + 1, id, name],
            )
            .map_err(db_err)?;
        Ok(json!({ "received": total }))
    }

    /// Stage one secret under a fresh account owned by this operation. A retry
    /// compares with the already staged OS value; no digest is journaled.
    pub fn secret_put(&self, params: &Value) -> Result<Value, String> {
        let id = op_id(params)?;
        let logical = params["logicalId"]
            .as_str()
            .filter(|l| vault::valid_import_id(l))
            .ok_or(E_SCHEMA)?;
        let value = params["value"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or(E_SCHEMA)?;
        if value.len() > MAX_SECRET {
            return Err(E_SECRET_SIZE.into());
        }
        let open = self.open()?;
        let row = self.owned(&open.db, &id)?;
        if row.phase != "prepared" {
            return Err(E_PHASE.into());
        }
        let account: Option<Option<String>> = open
            .db
            .query_row(
                "SELECT account FROM bindings WHERE generation=?1 AND logical=?2",
                params![row.generation, logical],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let account = match account.ok_or(E_SCHEMA)? {
            Some(account) => {
                match self.os.get(&account).map_err(os_err)? {
                    Some(existing) if existing == value => {}
                    Some(_) => return Err(E_SECRET_CONFLICT.into()),
                    // Intent journaled, OS write lost in a crash: same owned name.
                    None => self.os.set(&account, value).map_err(os_err)?,
                }
                account
            }
            None => {
                let account = vault::ref_account(logical, &id, 1);
                let tx = open.db.unchecked_transaction().map_err(db_err)?;
                tx.execute(
                    "INSERT INTO entries(account,logical,owner,revision,state) VALUES(?1,?2,?3,1,'intent')",
                    params![account, logical, id],
                )
                .map_err(db_err)?;
                tx.execute(
                    "UPDATE bindings SET account=?1 WHERE generation=?2 AND logical=?3",
                    params![account, row.generation, logical],
                )
                .map_err(db_err)?;
                tx.commit().map_err(db_err)?;
                self.fault("secret.intent")?;
                self.os.set(&account, value).map_err(os_err)?;
                account
            }
        };
        self.fault("secret.written")?;
        if self.os.get(&account).map_err(os_err)?.as_deref() != Some(value) {
            return Err(VaultError::Write.message().into());
        }
        open.db
            .execute("UPDATE entries SET state='staged' WHERE account=?1 AND owner=?2 AND state='intent'", params![account, id])
            .map_err(db_err)?;
        Ok(json!({ "logicalId": logical, "staged": true }))
    }

    /// Verify everything, publish the immutable generation, CAS the head.
    pub fn commit(&self, params: &Value) -> Result<Value, String> {
        let id = op_id(params)?;
        let mut open = self.open()?;
        let row = operation(&open.db, &id)?.ok_or(E_UNKNOWN)?;
        match row.phase.as_str() {
            "committed" => return committed(&row),
            "aborted" => return Err(row.error.unwrap_or_else(|| E_PHASE.into())),
            _ if row.owner != self.owner => return Err(E_OWNER.into()),
            _ => {}
        }
        let (revision, _) = head(&open.db)?;
        if revision != row.expected {
            self.cleanup(&open.db, &id, E_REVISION)?;
            return Err(E_REVISION.into());
        }
        let files = self.files(&open.db, &id)?;
        let staged = self.staging()?.join(&id);
        let published = self.generations()?.join(&row.generation);
        if row.phase == "prepared" {
            let missing: i64 = open
                .db
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM op_files WHERE operation=?1 AND received<>size) + (SELECT COUNT(*) FROM bindings b LEFT JOIN entries e ON e.account=b.account AND e.owner=?1 WHERE b.generation=?2 AND (e.state IS NULL OR e.state<>'staged'))",
                    params![id, row.generation],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if missing != 0 {
                return Err(E_INCOMPLETE.into());
            }
            if std::fs::symlink_metadata(&published).is_err() {
                for (name, sha, size) in &files {
                    cfs::verify_and_sync(&staged.join(name), sha, *size)?;
                }
                cfs::sync_dir(&staged)?;
                self.fault("files.synced")?;
                cfs::publish(&staged, &published)?;
            }
            self.fault("files.published")?;
            open.db
                .execute(
                    "UPDATE operations SET phase='published',updated=?1 WHERE id=?2",
                    params![now(), id],
                )
                .map_err(db_err)?;
        }
        // Published bytes are re-verified on every attempt, including resume.
        for (name, sha, size) in &files {
            cfs::verify_and_sync(&published.join(name), sha, *size)?;
        }
        self.verify_secrets(&open.db, &row.generation)?;
        let legacy = self.legacy_present(&open.db, &row.generation)?;
        self.fault("head.before")?;
        let receipt = self.swap_head(&mut open.db, &id, &row, &files, &legacy)?;
        self.fault("head.committed")?;
        // Best effort: a failure here leaves garbage that recovery retries.
        let _ = self.collect(&open.db);
        Ok(receipt)
    }

    fn files(&self, db: &Connection, id: &str) -> Result<Vec<(String, String, u64)>, String> {
        let mut statement = db
            .prepare("SELECT name,sha256,size FROM op_files WHERE operation=?1 ORDER BY name")
            .map_err(db_err)?;
        let rows = statement
            .query_map([id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u64))
            })
            .map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)
    }

    fn generation_bindings(
        &self,
        db: &Connection,
        generation: &str,
    ) -> Result<Vec<(Binding, Option<String>)>, String> {
        let mut statement = db
            .prepare("SELECT logical,provider,kind,pointer,account FROM bindings WHERE generation=?1 ORDER BY logical")
            .map_err(db_err)?;
        let rows = statement
            .query_map([generation], |r| {
                Ok((
                    Binding {
                        logical: r.get(0)?,
                        provider: r.get(1)?,
                        kind: r.get(2)?,
                        pointer: r.get(3)?,
                    },
                    r.get(4)?,
                ))
            })
            .map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)
    }

    /// Every bound ref must be present in the OS vault right before the head.
    fn verify_secrets(&self, db: &Connection, generation: &str) -> Result<(), String> {
        for (_, account) in self.generation_bindings(db, generation)? {
            let account = account.ok_or(E_INCOMPLETE)?;
            if self.os.get(&account).map_err(os_err)?.is_none() {
                return Err(E_SECRET_MISSING.into());
            }
        }
        Ok(())
    }

    /// Providers that already have a credential (versioned row or a legacy
    /// `pi-provider:` entry). Read before the head transaction; the exclusive
    /// lease keeps it stable, and only this binary writes provider rows.
    fn legacy_present(&self, db: &Connection, generation: &str) -> Result<Vec<String>, String> {
        let mut present = Vec::new();
        for (binding, _) in self.generation_bindings(db, generation)? {
            if let (Some(provider), "credential") = (&binding.provider, binding.kind.as_str()) {
                if self
                    .os
                    .get(&vault::legacy_account(provider))
                    .map_err(os_err)?
                    .is_some()
                {
                    present.push(provider.clone());
                }
            }
        }
        Ok(present)
    }

    fn swap_head(
        &self,
        db: &mut Connection,
        id: &str,
        row: &OpRow,
        files: &[(String, String, u64)],
        legacy: &[String],
    ) -> Result<Value, String> {
        let bindings = self.generation_bindings(db, &row.generation)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let (revision, _) = head(&tx)?;
        if revision != row.expected {
            drop(tx);
            self.cleanup(db, id, E_REVISION)?;
            return Err(E_REVISION.into());
        }
        let next = revision + 1;
        let mut conflicts = Vec::new();
        for (binding, account) in &bindings {
            let (Some(provider), "credential") = (&binding.provider, binding.kind.as_str()) else {
                continue;
            };
            let logical = vault::provider_logical(provider);
            let existing: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM credentials WHERE logical=?1)",
                    [&logical],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if existing || legacy.contains(provider) {
                // Deterministic policy: an existing provider credential wins and
                // is never overwritten; the imported one stays bound but shadowed.
                conflicts.push(json!({ "vaultId": binding.logical, "policy": "existing-provider-credential-kept" }));
            } else {
                tx.execute(
                    "INSERT INTO credentials(logical,revision,account,source,updated) VALUES(?1,1,?2,?3,?4)",
                    params![logical, account, format!("import:{id}"), now()],
                )
                .map_err(db_err)?;
            }
        }
        tx.execute(
            "UPDATE entries SET state='live' WHERE owner=?1 AND state='staged'",
            [id],
        )
        .map_err(db_err)?;
        let receipt = json!({
            "receiptId": format!("cfg-{}", &vault::sha256_hex(format!("{id}\0{}\0{}", row.generation, row.manifest_hash).as_bytes())[..32]),
            "files": files.iter().map(|(name, sha, _)| json!({ "name": name, "sha256": sha })).collect::<Vec<_>>(),
            "vaultIds": bindings.iter().map(|(b, _)| b.logical.clone()).collect::<Vec<_>>(),
            "configRevision": next,
            "generationId": row.generation,
            "manifestHash": row.manifest_hash,
            "conflicts": conflicts,
        });
        let text = receipt.to_string();
        tx.execute(
            "UPDATE head SET revision=?1,generation=?2,manifest_hash=?3,operation=?4,receipt=?5 WHERE id=1 AND revision=?6",
            params![next as i64, row.generation, row.manifest_hash, id, text, revision as i64],
        )
        .map_err(db_err)?;
        tx.execute(
            "UPDATE operations SET phase='committed',receipt=?1,updated=?2 WHERE id=?3",
            params![text, now(), id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(receipt)
    }
}

fn strings<P: rusqlite::Params>(
    db: &Connection,
    sql: &str,
    values: P,
) -> Result<Vec<String>, String> {
    let mut statement = db.prepare(sql).map_err(db_err)?;
    let rows = statement.query_map(values, |r| r.get(0)).map_err(db_err)?;
    rows.collect::<Result<_, _>>().map_err(db_err)
}

impl Authority {
    /// Roll back exactly this operation's never-referenced refs and files.
    /// Ordering makes every step idempotent: OS delete, then row delete, and
    /// the `aborted` phase only after everything owned is gone.
    fn cleanup(&self, db: &Connection, id: &str, error: &str) -> Result<(), String> {
        let row = operation(db, id)?.ok_or(E_UNKNOWN)?;
        if row.phase == "committed" || row.phase == "aborted" {
            return Ok(());
        }
        let (_, head_generation) = head(db)?;
        let owned = strings(
            db,
            "SELECT account FROM entries WHERE owner=?1 AND state IN ('intent','staged') AND account NOT IN (SELECT account FROM credentials WHERE account IS NOT NULL)",
            [id],
        )?;
        for account in owned {
            self.fault("cleanup.vault")?;
            self.os.delete(&account).map_err(os_err)?;
            db.execute(
                "DELETE FROM entries WHERE account=?1 AND owner=?2",
                params![account, id],
            )
            .map_err(db_err)?;
        }
        cfs::remove_owned_dir(&self.staging()?, id)?;
        if head_generation.as_deref() != Some(row.generation.as_str()) {
            cfs::remove_owned_dir(&self.generations()?, &row.generation)?;
        }
        self.fault("cleanup.files")?;
        let tx = db.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "DELETE FROM bindings WHERE generation=?1",
            [&row.generation],
        )
        .map_err(db_err)?;
        tx.execute("DELETE FROM op_files WHERE operation=?1", [id])
            .map_err(db_err)?;
        tx.execute(
            "UPDATE operations SET phase='aborted',error=?1,updated=?2 WHERE id=?3 AND phase IN ('prepared','published')",
            params![error, now(), id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)
    }

    /// Keep the head and its predecessor generation (a running runtime may
    /// still hold the previous immutable projection until its maintenance
    /// reload). Older generations and unreferenced live refs are removed.
    fn collect(&self, db: &Connection) -> Result<(), String> {
        let (_, generation) = head(db)?;
        let current = generation.unwrap_or_default();
        let stale = strings(
            db,
            "SELECT generation FROM operations WHERE phase='committed' AND error IS NULL AND generation<>?1 AND id NOT IN (SELECT id FROM operations WHERE phase='committed' ORDER BY updated DESC LIMIT 2)",
            [&current],
        )?;
        for old in stale {
            db.execute("DELETE FROM bindings WHERE generation=?1", [&old])
                .map_err(db_err)?;
            cfs::remove_owned_dir(&self.generations()?, &old)?;
            db.execute(
                "UPDATE operations SET error='collected' WHERE generation=?1",
                [&old],
            )
            .map_err(db_err)?;
        }
        let orphans = strings(
            db,
            "SELECT account FROM entries WHERE state='live' AND account NOT IN (SELECT account FROM credentials WHERE account IS NOT NULL) AND account NOT IN (SELECT account FROM bindings WHERE account IS NOT NULL)",
            params![],
        )?;
        for account in orphans {
            self.os.delete(&account).map_err(os_err)?;
            db.execute(
                "DELETE FROM entries WHERE account=?1 AND state='live'",
                [&account],
            )
            .map_err(db_err)?;
        }
        Ok(())
    }

    /// Runs inside every call's exclusive lease, so nothing else is MID-CALL.
    /// That does not prove a staged import dead: staging releases the lease
    /// between calls. An open operation of another generation is reclaimed
    /// only with an ownership-death proof:
    /// * same native process: the owner was RETIRED by a later claiming
    ///   generation (`enter`), so it can never issue another admitted call;
    /// * another native process: its lease file can be locked (process died);
    /// * no recorded process (journal written before process leases existed):
    ///   only by a claiming call.
    ///
    /// A live foreign owner's job is left untouched: reads observe it as
    /// pending, and `commit`/`abort` by another process stay
    /// CONFIG_OPERATION_OWNER. CAS intents never span calls, so every one
    /// seen here is a crash leftover. Failures are retried, never fatal.
    fn recover(&self, open: &Open, claim: bool) -> Result<(), String> {
        let db = &open.db;
        let mut statement = db
            .prepare("SELECT o.id,o.owner,p.process FROM operations o LEFT JOIN op_process p ON p.operation=o.id WHERE o.phase IN ('prepared','published') AND o.owner<>?1")
            .map_err(db_err)?;
        let foreign = statement
            .query_map([&self.owner], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        drop(statement);
        let mut proven = HashMap::new();
        for (id, owner, process) in foreign {
            let dead = match process {
                None => claim,
                Some(p) if p == self.process => self.retired(&owner),
                Some(p) => *proven
                    .entry(p.clone())
                    .or_insert_with(|| self.process_dead(&p)),
            };
            if dead {
                let _ = self.cleanup(
                    db,
                    &id,
                    "CONFIG_INTERRUPTED: перенос прерван до фиксации; прежние настройки активны",
                );
            }
        }
        for account in strings(
            db,
            "SELECT account FROM entries WHERE state='intent' AND owner LIKE 'cas:%' AND account NOT IN (SELECT account FROM credentials WHERE account IS NOT NULL)",
            params![],
        )? {
            if self.os.delete(&account).is_ok() {
                db.execute("DELETE FROM entries WHERE account=?1 AND state='intent'", [&account]).map_err(db_err)?;
            }
        }
        let _ = self.collect(db);
        Ok(())
    }
}

impl Authority {
    /// Lost-ACK reconciliation: never re-executes anything.
    pub fn status(&self, params: &Value) -> Result<Value, String> {
        let id = op_id(params)?;
        let open = self.observe()?;
        let (revision, _) = head(&open.db)?;
        Ok(match operation(&open.db, &id)? {
            None => json!({ "phase": "unknown", "configRevision": revision }),
            Some(row) if row.phase == "committed" => {
                json!({ "phase": "committed", "configRevision": revision, "receipt": committed(&row)? })
            }
            Some(row) => {
                json!({ "phase": row.phase, "configRevision": revision, "error": row.error })
            }
        })
    }

    /// Explicit cancellation before the head. After the head it is a no-op
    /// returning the committed phase: a commit is never reverted.
    pub fn abort(&self, params: &Value) -> Result<Value, String> {
        let id = op_id(params)?;
        let open = self.open()?;
        let row = operation(&open.db, &id)?.ok_or(E_UNKNOWN)?;
        if row.phase != "committed" && row.phase != "aborted" {
            if row.owner != self.owner {
                return Err(E_OWNER.into());
            }
            self.cleanup(
                &open.db,
                &id,
                "CONFIG_CANCELLED: перенос отменён; прежние настройки активны",
            )?;
        }
        let row = operation(&open.db, &id)?.ok_or(E_UNKNOWN)?;
        Ok(json!({ "phase": row.phase }))
    }

    /// Sanitized active snapshot: names, hashes, the generation directory and
    /// binding metadata. Never a value.
    pub fn current(&self) -> Result<Value, String> {
        let open = self.observe()?;
        let (revision, generation) = head(&open.db)?;
        let Some(generation) = generation else {
            return Ok(json!({ "configRevision": revision, "generationId": null }));
        };
        let (operation, manifest_hash, manifest): (String, String, String) = open
            .db
            .query_row(
                "SELECT o.id,o.manifest_hash,o.manifest FROM head h JOIN operations o ON o.id=h.operation WHERE h.id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(db_err)?;
        let manifest: Value = serde_json::from_str(&manifest).map_err(|_| E_DB)?;
        let files = self.files(&open.db, &operation)?;
        let bindings = self.generation_bindings(&open.db, &generation)?;
        Ok(json!({
            "configRevision": revision,
            "generationId": generation,
            "manifestHash": manifest_hash,
            "directory": self.generations()?.join(&generation).to_str().ok_or(cfs::ERR_UNSAFE)?,
            "files": files.iter().map(|(name, sha, size)| json!({ "name": name, "sha256": sha, "size": size })).collect::<Vec<_>>(),
            "bindings": bindings.iter().map(|(b, _)| json!({ "vaultId": b.logical, "provider": b.provider, "kind": b.kind, "pointer": b.pointer })).collect::<Vec<_>>(),
            "deferred": manifest["deferred"],
            "sourceHashes": manifest["sourceHashes"],
        }))
    }

    /// One bound value of the CURRENT head only; a changed head is refused so a
    /// projection can never mix an old endpoint with a new key.
    pub fn secret_read(&self, params: &Value) -> Result<Value, String> {
        let expected = params["configRevision"].as_u64().ok_or(E_SCHEMA)?;
        let logical = params["logicalId"]
            .as_str()
            .filter(|l| vault::valid_import_id(l))
            .ok_or(E_SCHEMA)?;
        let open = self.observe()?;
        let (revision, generation) = head(&open.db)?;
        if revision != expected {
            return Err(E_CHANGED.into());
        }
        let account: Option<String> = open
            .db
            .query_row(
                "SELECT account FROM bindings WHERE generation=?1 AND logical=?2",
                params![generation, logical],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .flatten();
        let account = account.ok_or(E_SECRET_MISSING)?;
        let value = self
            .os
            .get(&account)
            .map_err(os_err)?
            .ok_or(E_SECRET_MISSING)?;
        Ok(json!({ "value": value, "configRevision": revision }))
    }

    /// SDK CredentialStore read: versioned row first; with no row, the legacy
    /// `pi-provider:` entry is a read-only revision 0. A row whose ref is gone
    /// is a damaged vault and fails closed instead of falling back.
    pub fn credential_read(&self, params: &Value) -> Result<Value, String> {
        let provider = params["providerId"]
            .as_str()
            .filter(|p| vault::valid_provider(p))
            .ok_or(E_SCHEMA)?;
        let open = self.observe()?;
        let row: Option<(i64, Option<String>)> = open
            .db
            .query_row(
                "SELECT revision,account FROM credentials WHERE logical=?1",
                [vault::provider_logical(provider)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        Ok(match row {
            Some((revision, None)) => {
                json!({ "value": null, "revision": revision, "source": "deleted" })
            }
            Some((revision, Some(account))) => {
                let value = self
                    .os
                    .get(&account)
                    .map_err(os_err)?
                    .ok_or(E_SECRET_MISSING)?;
                json!({ "value": value, "revision": revision, "source": "versioned" })
            }
            None => self.legacy_credential(provider)?,
        })
    }

    fn legacy_credential(&self, provider: &str) -> Result<Value, String> {
        Ok(
            match self
                .os
                .get(&vault::legacy_account(provider))
                .map_err(os_err)?
            {
                Some(value) => json!({ "value": value, "revision": 0, "source": "legacy" }),
                None => json!({ "value": null, "revision": 0, "source": "none" }),
            },
        )
    }

    fn legacy_providers(
        &self,
        shadowed: &std::collections::BTreeSet<String>,
    ) -> Result<Vec<String>, String> {
        let Some(index) = self.os.get(vault::LEGACY_INDEX).map_err(os_err)? else {
            return Ok(vec![]);
        };
        let accounts: Vec<String> = serde_json::from_str(&index)
            .map_err(|_| "CONFIG_VAULT_INDEX: индекс хранилища повреждён")?;
        Ok(accounts
            .iter()
            .filter_map(|a| a.strip_prefix(vault::LEGACY_PREFIX))
            .filter(|p| vault::valid_provider(p) && !shadowed.contains(*p))
            .map(str::to_string)
            .collect())
    }

    /// Before the first write there is no journal: serve read-only results
    /// (legacy credentials, empty head) without creating any file.
    fn uninitialized(&self, method: &str, params: &Value) -> Option<Result<Value, String>> {
        Some(match method {
            "config.current" => Ok(json!({ "configRevision": 0, "generationId": null })),
            "config.status" => {
                op_id(params).map(|_| json!({ "phase": "unknown", "configRevision": 0 }))
            }
            "config.secretRead" => Err(E_SECRET_MISSING.into()),
            "vault.credentialRead" => params["providerId"]
                .as_str()
                .filter(|p| vault::valid_provider(p))
                .ok_or_else(|| E_SCHEMA.to_string())
                .and_then(|p| self.legacy_credential(p)),
            "vault.credentialList" => self
                .legacy_providers(&Default::default())
                .map(|providers| json!({ "providers": providers })),
            _ => return None,
        })
    }

    /// Provider ids with a stored credential. Never reads a credential value:
    /// versioned rows plus the legacy index of providers without a row.
    pub fn credential_list(&self) -> Result<Value, String> {
        let open = self.observe()?;
        let mut providers = std::collections::BTreeSet::new();
        let mut shadowed = std::collections::BTreeSet::new();
        let mut statement = open
            .db
            .prepare("SELECT logical,account FROM credentials WHERE logical LIKE 'provider:%'")
            .map_err(db_err)?;
        let rows = statement
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(db_err)?;
        for row in rows {
            let (logical, account) = row.map_err(db_err)?;
            let provider = logical.trim_start_matches("provider:").to_string();
            if account.is_some() {
                providers.insert(provider.clone());
            }
            shadowed.insert(provider);
        }
        providers.extend(self.legacy_providers(&shadowed)?);
        Ok(json!({ "providers": providers }))
    }

    /// Authenticated identity of one complete CAS request: HMAC-SHA256 under
    /// the authority's random key kept ONLY in the OS vault, over the
    /// operation, provider, expected revision, an explicit `null`/`value`
    /// discriminator and the value. The journal never holds the value, a
    /// plain hash of it, or the key. Created once under the OS lease.
    fn cas_request(
        &self,
        id: &str,
        logical: &str,
        expected: u64,
        value: Option<&str>,
    ) -> Result<String, String> {
        let key = match self.os.get(vault::CAS_KEY_ACCOUNT).map_err(os_err)? {
            Some(key) if key.len() == 64 => key,
            Some(_) => return Err(VaultError::Read.message().into()),
            None => {
                let key = vault::random_key()?;
                self.os.set(vault::CAS_KEY_ACCOUNT, &key).map_err(os_err)?;
                if self
                    .os
                    .get(vault::CAS_KEY_ACCOUNT)
                    .map_err(os_err)?
                    .as_deref()
                    != Some(key.as_str())
                {
                    return Err(VaultError::Write.message().into());
                }
                key
            }
        };
        let expected = expected.to_string();
        let (kind, bytes) = match value {
            None => (&b"null"[..], &b""[..]),
            Some(value) => (&b"value"[..], value.as_bytes()),
        };
        let parts: [&[u8]; 6] = [
            &b"enki-cas-request-v1"[..],
            id.as_bytes(),
            logical.as_bytes(),
            expected.as_bytes(),
            kind,
            bytes,
        ];
        Ok(vault::hmac_hex(key.as_bytes(), &parts))
    }

    /// The single revision authority for interactive keys and OAuth refresh.
    /// A stale expectedRevision is a conflict, never an overwrite; the caller
    /// must not repeat a one-time refresh. Same operationId with the identical
    /// request = the original receipt (success or conflict), even after newer
    /// writes collected its ref; any changed field is CONFIG_OPERATION_CONFLICT.
    pub fn compare_and_set(&self, params: &Value) -> Result<Value, String> {
        let id = op_id(params)?;
        let provider = params["providerId"]
            .as_str()
            .filter(|p| vault::valid_provider(p))
            .ok_or(E_SCHEMA)?;
        let expected = params["expectedRevision"].as_u64().ok_or(E_SCHEMA)?;
        let value = match &params["value"] {
            Value::Null => None,
            Value::String(v) if !v.is_empty() && v.len() <= MAX_SECRET => Some(v.as_str()),
            Value::String(_) => return Err(E_SECRET_SIZE.into()),
            _ => return Err(E_SCHEMA.into()),
        };
        let logical = vault::provider_logical(provider);
        let owner = format!("cas:{id}");
        let open = self.open()?;
        let request = self.cas_request(&id, &logical, expected, value)?;
        let prior: Option<(String, i64, i64, i64, Option<String>)> = open
            .db
            .query_row(
                "SELECT r.logical,r.expected,r.revision,r.conflict,q.request FROM cas_receipts r LEFT JOIN cas_requests q ON q.operation=r.operation WHERE r.operation=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(db_err)?;
        if let Some((l, e, revision, conflict, journaled)) = prior {
            // The receipt answers only the byte-identical request (provider,
            // expectedRevision, value-vs-null and value). A receipt without a
            // request identity cannot be verified and is never reused.
            if l != logical
                || e as u64 != expected
                || !journaled.is_some_and(|j| vault::tags_equal(&j, &request))
            {
                return Err(E_OPERATION.into());
            }
            return Ok(if conflict != 0 {
                json!({ "conflict": true, "revision": revision })
            } else {
                json!({ "revision": revision })
            });
        }
        let current = |db: &Connection| -> Result<(u64, Option<String>), String> {
            Ok(db
                .query_row(
                    "SELECT revision,account FROM credentials WHERE logical=?1",
                    [&logical],
                    |r| Ok((r.get::<_, i64>(0)? as u64, r.get(1)?)),
                )
                .optional()
                .map_err(db_err)?
                .unwrap_or((0, None)))
        };
        let conflict = |db: &Connection, revision: u64| -> Result<Value, String> {
            let tx = db.unchecked_transaction().map_err(db_err)?;
            tx.execute(
                "INSERT INTO cas_receipts(operation,logical,expected,revision,conflict) VALUES(?1,?2,?3,?4,1)",
                params![id, logical, expected as i64, revision as i64],
            )
            .map_err(db_err)?;
            tx.execute(
                "INSERT INTO cas_requests(operation,request) VALUES(?1,?2)",
                params![id, request],
            )
            .map_err(db_err)?;
            tx.commit().map_err(db_err)?;
            Ok(json!({ "conflict": true, "revision": revision }))
        };
        let (revision, _) = current(&open.db)?;
        if revision != expected {
            return conflict(&open.db, revision);
        }
        let next = expected + 1;
        let account = match value {
            None => None,
            Some(value) => {
                let account = vault::ref_account(&logical, &owner, next);
                open.db
                    .execute("INSERT INTO entries(account,logical,owner,revision,state) VALUES(?1,?2,?3,?4,'intent')", params![account, logical, owner, next as i64])
                    .map_err(db_err)?;
                self.fault("cas.intent")?;
                self.os.set(&account, value).map_err(os_err)?;
                if self.os.get(&account).map_err(os_err)?.as_deref() != Some(value) {
                    return Err(VaultError::Write.message().into());
                }
                self.fault("cas.written")?;
                Some(account)
            }
        };
        let tx = open.db.unchecked_transaction().map_err(db_err)?;
        let (revision, _) = current(&tx)?;
        if revision != expected {
            drop(tx);
            if let Some(account) = &account {
                self.os.delete(account).map_err(os_err)?;
                open.db
                    .execute(
                        "DELETE FROM entries WHERE account=?1 AND state='intent'",
                        [account],
                    )
                    .map_err(db_err)?;
            }
            return conflict(&open.db, revision);
        }
        tx.execute(
            "INSERT INTO credentials(logical,revision,account,source,updated) VALUES(?1,?2,?3,'store',?4) ON CONFLICT(logical) DO UPDATE SET revision=excluded.revision,account=excluded.account,source=excluded.source,updated=excluded.updated",
            params![logical, next as i64, account, now()],
        )
        .map_err(db_err)?;
        if let Some(account) = &account {
            tx.execute(
                "UPDATE entries SET state='live' WHERE account=?1",
                [account],
            )
            .map_err(db_err)?;
        }
        tx.execute(
            "INSERT INTO cas_receipts(operation,logical,expected,revision,conflict) VALUES(?1,?2,?3,?4,0)",
            params![id, logical, expected as i64, next as i64],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO cas_requests(operation,request) VALUES(?1,?2)",
            params![id, request],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        self.fault("cas.committed")?;
        // The previous versioned ref is now unreferenced unless a generation
        // still binds it; the legacy `pi-provider:` entry is never touched.
        let _ = self.collect(&open.db);
        Ok(json!({ "revision": next }))
    }
}

fn committed(row: &OpRow) -> Result<Value, String> {
    row.receipt
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .ok_or_else(|| E_DB.into())
}

const MUTATING: [&str; 5] = [
    "config.begin",
    "config.fileChunk",
    "config.secretPut",
    "config.commit",
    "vault.compareAndSet",
];
const METHODS: [&str; 9] = [
    "config.begin",
    "config.fileChunk",
    "config.secretPut",
    "config.commit",
    "config.status",
    "config.abort",
    "config.current",
    "config.secretRead",
    "vault.compareAndSet",
];

pub fn handles(method: &str) -> bool {
    METHODS.contains(&method) || matches!(method, "vault.credentialRead" | "vault.credentialList")
}

impl Authority {
    pub fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        // Also covers the journal-less read path, which never opens the lease.
        if self.revoked() {
            return Err(E_REVOKED.into());
        }
        if !self.initialized() {
            if let Some(result) = self.uninitialized(method, params) {
                return result;
            }
        }
        match method {
            "config.begin" => self.begin(params),
            "config.fileChunk" => self.file_chunk(params),
            "config.secretPut" => self.secret_put(params),
            "config.commit" => self.commit(params),
            "config.status" => self.status(params),
            "config.abort" => self.abort(params),
            "config.current" => self.current(),
            "config.secretRead" => self.secret_read(params),
            "vault.credentialRead" => self.credential_read(params),
            "vault.credentialList" => self.credential_list(),
            "vault.compareAndSet" => self.compare_and_set(params),
            _ => Err("Неизвестный запрос среды выполнения".into()),
        }
    }
}

/// Entry from the LOCAL supervisor control channel only. `local` is the owned
/// child's broker generation plus the live admission of this one request (its
/// retained GenerationPermit); the remote relay has neither and is refused.
/// Mutations respect the native update maintenance fence; status, abort and
/// reads stay available so a fenced import can still be reconciled/cancelled.
pub fn dispatch(
    method: &str,
    params: &Value,
    local: Option<(&str, Admission)>,
) -> Result<Value, String> {
    let (generation, admission) = local
        .filter(|(generation, _)| !generation.is_empty())
        .ok_or("CONFIG_LOCAL_ONLY: настройки и хранилище доступны только локальному ядру")?;
    if !admission() {
        return Err(E_REVOKED.into());
    }
    if MUTATING.contains(&method) {
        crate::updates::ensure_writable()?;
    }
    serve(
        Authority::production(generation)?,
        admission,
        method,
        params,
    )
}

/// The composition `dispatch` uses, with the authority injectable for tests:
/// the request's admission is enforced at the OS-lease boundary.
fn serve(
    authority: Authority,
    admission: Admission,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    authority.with_admission(admission).call(method, params)
}

#[cfg(test)]
#[path = "config_commit_tests.rs"]
mod tests;
