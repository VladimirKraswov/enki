//! `enki --enki-build-job`: trusted native process-tree runner and durable
//! directory flush port for scripts/runtime (required on Windows, usable on
//! every host). Exactly one bounded JSON request on stdin, exactly one JSON
//! result line on stdout. Program arguments and environment are never logged.
//! Runs from the CLI dispatcher before any Tauri UI, migration or vault access,
//! and as the standalone `enki-build-runner` (src-tauri/build-runner) that
//! runtime:prepare compiles from the authenticated source on Windows.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const REQUEST_LIMIT: u64 = 1024 * 1024;
const OUTPUT_CEILING: u64 = 16 * 1024 * 1024;
const TIMEOUT_CEILING_MS: u64 = 4 * 60 * 60 * 1000;
const FLUSH_CEILING: usize = 200_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RunRequest {
    schema: u32,
    #[allow(dead_code)]
    kind: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    timeout_ms: u64,
    max_output_bytes: u64,
    capture: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FlushRequest {
    schema: u32,
    #[allow(dead_code)]
    kind: String,
    paths: Vec<String>,
}

struct Job {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    timeout: Duration,
    max_output: u64,
    capture: bool,
}

pub fn cli() -> Result<(), String> {
    if std::env::args_os().len() != 2 {
        return Err("--enki-build-job reads its request from stdin only".into());
    }
    // This process exists only for the job: on Linux, adopt orphaned
    // descendants so tree settlement also covers ones that left the group.
    crate::process::adopt_orphans();
    let response = handle(read_request(std::io::stdin().lock())?)?;
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &response)
        .map_err(|_| "Build job result write failed".to_string())?;
    out.write_all(b"\n")
        .and_then(|_| out.flush())
        .map_err(|_| "Build job result write failed".to_string())
}

fn read_request(input: impl Read) -> Result<Value, String> {
    let mut bytes = Vec::new();
    input
        .take(REQUEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Build job request unreadable".to_string())?;
    if bytes.len() as u64 > REQUEST_LIMIT {
        return Err("Build job request exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Build job request is not JSON".into())
}

fn handle(request: Value) -> Result<Value, String> {
    match request.get("kind").and_then(Value::as_str) {
        Some("run") => {
            let request: RunRequest = serde_json::from_value(request)
                .map_err(|_| "Invalid build job request".to_string())?;
            run(validate_run(request)?)
        }
        Some("flush-directories") => {
            let request: FlushRequest = serde_json::from_value(request)
                .map_err(|_| "Invalid directory flush request".to_string())?;
            if request.schema != 1
                || request.paths.is_empty()
                || request.paths.len() > FLUSH_CEILING
            {
                return Err("Invalid directory flush request".into());
            }
            let paths = request
                .paths
                .iter()
                .map(String::as_str)
                .map(absolute)
                .collect::<Result<Vec<_>, _>>()?;
            for path in &paths {
                flush_directory(path)?;
            }
            Ok(json!({
                "schema": 1,
                "kind": "flush-directories",
                "status": "flushed",
                "count": paths.len(),
            }))
        }
        _ => Err("Unknown build job kind".into()),
    }
}

/// Absolute, lexically normalized and NUL-free. Relative or `..` paths would
/// make the trusted request depend on the runner's own working directory.
fn absolute(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if value.is_empty()
        || value.contains('\0')
        || !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("Build job paths must be absolute and normalized".into());
    }
    Ok(path)
}

fn validate_run(request: RunRequest) -> Result<Job, String> {
    if request.schema != 1 {
        return Err("Unsupported build job schema".into());
    }
    let program = absolute(&request.program)?;
    if !fs::metadata(&program).is_ok_and(|meta| meta.is_file()) {
        return Err("Build program is not a regular file".into());
    }
    let cwd = absolute(&request.cwd)?;
    if !fs::metadata(&cwd).is_ok_and(|meta| meta.is_dir()) {
        return Err("Build working directory is not a directory".into());
    }
    if request.args.iter().any(|arg| arg.contains('\0')) {
        return Err("Build arguments contain NUL".into());
    }
    if request
        .env
        .iter()
        .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err("Build environment contains an invalid entry".into());
    }
    if !(1..=TIMEOUT_CEILING_MS).contains(&request.timeout_ms)
        || !(1..=OUTPUT_CEILING).contains(&request.max_output_bytes)
    {
        return Err("Build deadline or output bound is out of range".into());
    }
    Ok(Job {
        program,
        args: request.args,
        cwd,
        env: request.env,
        timeout: Duration::from_millis(request.timeout_ms),
        max_output: request.max_output_bytes,
        capture: request.capture,
    })
}

/// Captured output is retained up to the bound (exceeding it stops the tree);
/// streamed output goes to the runner's stderr so stdout stays one JSON line.
struct Collector {
    limit: u64,
    total: u64,
    output: Vec<u8>,
    outbox: Option<Outbox>,
}

impl Collector {
    fn push(&mut self, bytes: Vec<u8>) -> bool {
        self.total = self.total.saturating_add(bytes.len() as u64);
        if let Some(outbox) = &mut self.outbox {
            outbox.offer(bytes);
            return true;
        }
        if self.total > self.limit {
            return false;
        }
        self.output.extend_from_slice(&bytes);
        true
    }
}

/// Streamed output leaves through a bounded outbox drained by its own writer
/// thread on a duplicated stderr handle (never std's global stderr lock). The
/// deadline/reaping loop only ever `try_send`s: a full or closed outbox drops
/// and counts bytes. The writer is never joined; it gets a bounded flush grace,
/// and one still blocked (the parent is not reading stderr) is abandoned to
/// process exit and reported as incomplete.
struct Outbox {
    sender: Option<mpsc::SyncSender<Vec<u8>>>,
    idle: mpsc::Receiver<()>,
    dropped: u64,
}

const OUTBOX_CHUNKS: usize = 64;
const READER_CHUNKS: usize = 64;
const OUTBOX_FLUSH_GRACE: Duration = Duration::from_millis(500);

impl Outbox {
    fn start() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(OUTBOX_CHUNKS);
        let (done, idle) = mpsc::channel();
        thread::spawn(move || {
            if let Some(mut stderr) = stderr_handle() {
                for bytes in receiver {
                    if stderr.write_all(&bytes).is_err() {
                        break;
                    }
                }
                let _ = stderr.flush();
            }
            let _ = done.send(());
        });
        Self {
            sender: Some(sender),
            idle,
            dropped: 0,
        }
    }
    fn offer(&mut self, bytes: Vec<u8>) {
        let length = bytes.len() as u64;
        if !matches!(
            self.sender.as_ref().map(|s| s.try_send(bytes)),
            Some(Ok(()))
        ) {
            self.dropped = self.dropped.saturating_add(length);
        }
    }
    /// True when every accepted chunk reached stderr within the grace.
    fn finish(&mut self) -> bool {
        drop(self.sender.take());
        self.idle.recv_timeout(OUTBOX_FLUSH_GRACE).is_ok()
    }
}

fn stderr_handle() -> Option<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsFd;
        let owned = std::io::stderr().as_fd().try_clone_to_owned().ok()?;
        Some(fs::File::from(owned))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsHandle;
        let owned = std::io::stderr().as_handle().try_clone_to_owned().ok()?;
        Some(fs::File::from(owned))
    }
}

fn forward(mut pipe: impl Read + Send + 'static, sender: mpsc::SyncSender<Vec<u8>>) {
    thread::spawn(move || {
        let mut chunk = [0_u8; 16 * 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send(chunk[..read].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

enum Outcome {
    Exited,
    TimedOut,
    OutputLimit,
    Lost,
}

fn run(job: Job) -> Result<Value, String> {
    let mut command = Command::new(&job.program);
    command
        .args(&job.args)
        .current_dir(&job.cwd)
        .env_clear()
        .envs(&job.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut tree = crate::process::OwnedTree::spawn(&mut command)?;
    // Bounded: a slow collector back-pressures the child's pipe, never memory.
    let (sender, receiver) = mpsc::sync_channel(READER_CHUNKS);
    if let Some(pipe) = tree.child.stdout.take() {
        forward(pipe, sender.clone());
    }
    if let Some(pipe) = tree.child.stderr.take() {
        forward(pipe, sender.clone());
    }
    drop(sender);
    let mut collector = Collector {
        limit: job.max_output,
        total: 0,
        output: Vec::new(),
        outbox: (!job.capture).then(Outbox::start),
    };
    let deadline = Instant::now() + job.timeout;
    let outcome = loop {
        // Observed without reaping: the primary keeps the tree id pinned.
        match tree.primary_exited() {
            Ok(true) => break Outcome::Exited,
            Ok(false) => {}
            Err(_) => break Outcome::Lost,
        }
        if Instant::now() >= deadline {
            break Outcome::TimedOut;
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(bytes) => {
                if !collector.push(bytes) {
                    break Outcome::OutputLimit;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => thread::sleep(Duration::from_millis(25)),
        }
    };
    // Every outcome settles the whole owned tree before the primary is reaped;
    // `reaped` is only true when that settlement is proven (see OwnedTree).
    let settlement = tree.settle(Duration::from_secs(5));
    let reaped = settlement.complete;
    let mut outcome = match (outcome, settlement.status) {
        (Outcome::Exited, None) => Outcome::Lost,
        (other, _) => other,
    };
    // Bounded: a descendant outside the tree (macOS only) may still hold a pipe.
    let drain_until = Instant::now() + Duration::from_secs(2);
    while let Some(left) = drain_until.checked_duration_since(Instant::now()) {
        let Ok(bytes) = receiver.recv_timeout(left) else {
            break;
        };
        if !collector.push(bytes) {
            outcome = Outcome::OutputLimit;
            break;
        }
    }
    let (status, code) = match outcome {
        Outcome::Exited => ("exited", settlement.status.and_then(|s| s.code())),
        Outcome::TimedOut => ("timeout", None),
        Outcome::OutputLimit => ("output-limit", None),
        Outcome::Lost => ("lost", None),
    };
    let (stream_complete, stream_dropped) = match &mut collector.outbox {
        Some(outbox) => (outbox.finish(), outbox.dropped),
        None => (true, 0),
    };
    Ok(json!({
        "schema": 1,
        "kind": "run",
        "status": status,
        "code": code,
        "reaped": reaped,
        "scope": settlement.scope,
        "streamComplete": stream_complete && stream_dropped == 0,
        "streamDroppedBytes": stream_dropped,
        "output": String::from_utf8_lossy(&collector.output),
    }))
}

/// Durable directory metadata flush with exact trusted paths: the directory
/// must resolve to itself (no symlink, junction or other reparse point) and is
/// flushed through its own handle. Unsupported filesystems fail closed.
fn flush_directory(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|error| format!("Directory flush target unavailable ({:?})", error.kind()))?;
    if !meta.is_dir() {
        return Err("Directory flush target is not a plain directory".into());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Directory flush target unavailable ({:?})", error.kind()))?;
    if !same_path(&canonical, path) {
        return Err("Directory flush path is not exact (link or junction)".into());
    }
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        // FlushFileBuffers requires write access on the directory handle.
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| format!("Directory flush open failed ({:?})", error.kind()))?;
        let opened = file.metadata().map_err(|_| "Directory flush stat failed")?;
        if !opened.is_dir() || opened.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Directory flush target is not a plain directory".into());
        }
        file
    };
    #[cfg(not(windows))]
    let file = {
        let file = fs::File::open(path)
            .map_err(|error| format!("Directory flush open failed ({:?})", error.kind()))?;
        if !file.metadata().is_ok_and(|opened| opened.is_dir()) {
            return Err("Directory flush target is not a plain directory".into());
        }
        file
    };
    file.sync_all()
        .map_err(|error| format!("Directory flush unsupported or failed ({:?})", error.kind()))
}

#[cfg(windows)]
fn same_path(canonical: &Path, requested: &Path) -> bool {
    let canonical = canonical.to_string_lossy();
    let canonical = match canonical.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => canonical
            .strip_prefix(r"\\?\")
            .unwrap_or(&canonical)
            .to_string(),
    };
    canonical.to_lowercase() == requested.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn same_path(canonical: &Path, requested: &Path) -> bool {
    canonical == requested
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        program: &str,
        args: &[&str],
        cwd: &Path,
        env: Value,
        timeout_ms: u64,
        max: u64,
    ) -> Value {
        json!({"schema":1,"kind":"run","program":program,"args":args,"cwd":cwd,
            "env":env,"timeoutMs":timeout_ms,"maxOutputBytes":max,"capture":true})
    }

    #[cfg(unix)]
    fn sh(script: &str, env: Value, timeout_ms: u64, max: u64) -> Value {
        let cwd = std::env::temp_dir();
        handle(request(
            "/bin/sh",
            &["-c", script],
            &cwd,
            env,
            timeout_ms,
            max,
        ))
        .unwrap()
    }

    fn flush(paths: Value) -> Result<Value, String> {
        handle(json!({"schema":1,"kind":"flush-directories","paths":paths}))
    }

    #[test]
    fn rejects_untrusted_request_shapes_before_spawning() {
        let cwd = std::env::temp_dir();
        let program = std::env::current_exe().unwrap();
        let program = program.to_str().unwrap();
        let valid = request(program, &[], &cwd, json!({}), 1000, 1024);
        let mut cases = Vec::new();
        for (key, value) in [
            ("program", json!("relative/tool")),
            ("cwd", json!("relative")),
            ("timeoutMs", json!(0)),
            ("maxOutputBytes", json!(OUTPUT_CEILING + 1)),
            ("env", json!({"A=B":"x"})),
            ("env", json!({"":"x"})),
            ("args", json!(["a\u{0}b"])),
            ("schema", json!(2)),
            ("unexpected", json!(true)),
        ] {
            let mut case = valid.clone();
            case[key] = value;
            cases.push(case);
        }
        let mut parent = valid.clone();
        parent["cwd"] = json!(cwd.join("..").join("x"));
        cases.push(parent);
        for case in cases {
            assert!(handle(case.clone()).is_err(), "accepted {case}");
        }
        assert!(handle(json!({"schema":1,"kind":"shell","command":"x"})).is_err());
        let oversized = vec![b' '; REQUEST_LIMIT as usize + 1];
        assert!(read_request(oversized.as_slice()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runs_with_exact_explicit_environment_and_reports_exit_code() {
        let cwd = std::env::temp_dir();
        let only = json!({"ONLY": "1"});
        let result = handle(request("/usr/bin/env", &[], &cwd, only, 5000, 4096)).unwrap();
        assert_eq!(result["status"], "exited");
        assert_eq!(result["code"], 0);
        assert_eq!(result["output"], "ONLY=1\n", "no inherited variables");
        let failed = sh("printf partial; exit 3", json!({}), 5000, 4096);
        assert_eq!(failed["status"], "exited");
        assert_eq!(failed["code"], 3);
        assert_eq!(failed["output"], "partial");
    }

    #[cfg(unix)]
    #[test]
    fn deadline_stops_the_whole_tree_even_when_a_descendant_holds_the_pipe() {
        let started = Instant::now();
        let path = json!({"PATH": "/usr/bin:/bin"});
        let result = sh("trap '' TERM; sleep 30 & sleep 30; wait", path, 300, 4096);
        assert_eq!(result["status"], "timeout");
        assert_eq!(result["reaped"], true);
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "descendant kept the runner alive"
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_bound_terminates_instead_of_buffering_unbounded_bytes() {
        let path = json!({"PATH": "/usr/bin:/bin"});
        let result = sh("head -c 1048576 /dev/zero; sleep 30", path, 10_000, 1024);
        assert_eq!(result["status"], "output-limit");
        assert!(result["output"].as_str().unwrap().len() <= 1024);
    }

    /// Frame for the helper result. libtest prints `test <name> ... ` on stdout
    /// without a newline before the test body runs, so the result is written on
    /// its own line behind this explicit marker instead of as a bare JSON line.
    const HELPER_RESULT_FRAME: &str = "ENKI_BUILD_JOB_TEST_RESULT ";

    /// Runner process for the pipe repro below; inert unless that test spawns it.
    #[test]
    #[ignore = "helper child of streamed_output_cannot_block_the_deadline"]
    fn runner_cli_helper() {
        if std::env::var_os("ENKI_BUILD_JOB_TEST_HELPER").is_none() {
            return;
        }
        crate::process::adopt_orphans();
        let response = handle(read_request(std::io::stdin().lock()).unwrap()).unwrap();
        let mut out = std::io::stdout().lock();
        // Leading newline terminates libtest's unterminated `test ... ` prefix.
        writeln!(out, "\n{HELPER_RESULT_FRAME}{response}").unwrap();
        out.flush().unwrap();
    }

    /// Actual RED repro: capture:false, finite 1 MiB child stdout, and the
    /// parent does not read the runner's stderr before waiting. The runner must
    /// still finish (deadline 200 ms) instead of blocking in a stderr write.
    #[cfg(unix)]
    #[test]
    fn streamed_output_cannot_block_the_deadline() {
        use std::io::BufRead;
        let job = json!({"schema":1,"kind":"run","program":"/usr/bin/head",
            "args":["-c","1048576","/dev/zero"],"cwd":std::env::temp_dir(),"env":{},
            "timeoutMs":200,"maxOutputBytes":1024,"capture":false});
        let mut runner = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "build_job::tests::runner_cli_helper",
                "--ignored",
            ])
            .args(["--nocapture", "--test-threads=1"])
            .env("ENKI_BUILD_JOB_TEST_HELPER", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        runner
            .stdin
            .take()
            .unwrap()
            .write_all(job.to_string().as_bytes())
            .unwrap();
        let stdout = runner.stdout.take().unwrap();
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                let _ = sender.send(line);
            }
        });
        let finished = crate::process::wait_until(&mut runner, Duration::from_secs(2)).is_some();
        if !finished {
            // Only our own runner handle; its owned tree is its own business.
            let _ = runner.kill();
            let _ = runner.wait();
        }
        assert!(finished, "runner blocked on its unread stderr");
        let until = Instant::now() + Duration::from_secs(2);
        let mut result = None;
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            let Ok(line) = lines.recv_timeout(left) else {
                break;
            };
            // Only an exactly framed line counts; the whole payload must be JSON.
            result = line
                .strip_prefix(HELPER_RESULT_FRAME)
                .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
                .filter(|v| v["kind"] == "run");
            if result.is_some() {
                break;
            }
        }
        let result = result.expect("runner JSON result");
        assert_eq!(result["reaped"], true);
        assert_eq!(
            result["streamComplete"], false,
            "unread stderr cannot be complete"
        );
    }

    /// Actual RED repro: the primary exits 0 while a self-terminating
    /// descendant keeps running. The runner must settle the owned group before
    /// reporting reaped:true; the descendant must never act after the result.
    #[cfg(unix)]
    #[test]
    fn primary_exit_settles_the_owned_group_before_reporting_reaped() {
        let root = std::env::temp_dir().join(format!("enki-descendant-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("marker");
        let env = json!({"MARKER": marker});
        let result = sh(
            "(/bin/sleep 1; : > \"$MARKER\") & exit 0",
            env,
            10_000,
            4096,
        );
        assert_eq!(result["status"], "exited");
        assert_eq!(result["code"], 0);
        assert_eq!(result["reaped"], true);
        thread::sleep(Duration::from_millis(2000));
        let survived = marker.exists();
        fs::remove_dir_all(&root).unwrap();
        assert!(!survived, "a descendant outlived a reaped:true result");
    }

    /// Windows live (CI windows job): a descendant started after resume is in
    /// the Job; primary exit 0 settles the Job (proven empty) before reaped:true.
    #[cfg(windows)]
    #[test]
    fn windows_primary_exit_settles_the_job_before_reporting_reaped() {
        let system = PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot"));
        let root = std::env::temp_dir().join(format!("enki-descendant-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("marker");
        let powershell = system.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let script = "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 4; Set-Content -LiteralPath $env:MARKER -Value x'; exit 0";
        let mut env = json!({"MARKER": marker, "SystemRoot": system, "WINDIR": system,
            "PATH": system.join("System32")});
        for key in [
            "USERPROFILE",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "PSModulePath",
        ] {
            if let Ok(value) = std::env::var(key) {
                env[key] = json!(value);
            }
        }
        let args = ["-NoProfile", "-NonInteractive", "-Command", script];
        let result = handle(request(
            powershell.to_str().unwrap(),
            &args,
            &root,
            env,
            60_000,
            4096,
        ));
        let result = result.unwrap();
        assert_eq!(result["status"], "exited");
        assert_eq!(result["code"], 0);
        assert_eq!(result["reaped"], true);
        assert_eq!(result["scope"], "job");
        thread::sleep(Duration::from_secs(6));
        let survived = marker.exists();
        let _ = fs::remove_dir_all(&root);
        assert!(!survived, "a Job descendant outlived a reaped:true result");
    }

    #[test]
    fn directory_flush_requires_exact_plain_directories() {
        let root = std::env::temp_dir().join(format!("enki-flush-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("inner")).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        let root = PathBuf::from(root.to_string_lossy().trim_start_matches(r"\\?\"));
        let ok = flush(json!([root, root.join("inner")]));
        assert_eq!(ok.unwrap()["count"], 2);
        fs::write(root.join("file"), b"x").unwrap();
        for bad in [
            json!([root.join("file")]),
            json!(["relative"]),
            json!([root.join("missing")]),
            json!([]),
        ] {
            assert!(flush(bad).is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("inner"), root.join("link")).unwrap();
            let linked = flush(json!([root.join("link")]));
            assert!(linked.unwrap_err().contains("plain directory"));
        }
        fs::remove_dir_all(&root).unwrap();
    }
}
