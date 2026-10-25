//! Shared ownership rules for child processes that Desktop itself spawns.
//!
//! - Every wait is bounded: no native command may pin a worker thread forever.
//! - Release builds on Windows have no console, so every console child (node,
//!   ssh, opencode) is created without a window of its own.
//! - Children that may spawn descendants lead their own Unix process group, so
//!   the whole tree can be signalled. Windows uses a kill-on-close Job Object.
//!
//! Nothing here discovers or signals a process Desktop did not start itself.

use std::{
    io::{Read, Write},
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

/// Create a console program without a visible window on Windows; no-op elsewhere.
pub fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Make the child the leader of a new Unix process group; no-op elsewhere.
pub fn own_process_group(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

/// Poll until the child exits or `limit` passes. `None` means still running
/// (or its state could not be read), never "exited successfully".
pub fn wait_until(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => return None,
        }
    }
}

/// Stop a child that leads its own process group (see [`own_process_group`]):
/// SIGTERM to the group, a bounded grace period, then SIGKILL, then reap.
/// On Windows only the direct child is killed here; descendants are covered by
/// a [`KillOnCloseJob`] owned next to the child.
pub fn terminate_group(child: &mut Child, grace: Duration) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    signal_group(child, libc::SIGTERM);
    #[cfg(not(unix))]
    let _ = child.kill();
    if wait_until(child, grace).is_some() {
        return;
    }
    #[cfg(unix)]
    signal_group(child, libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

/// Bounded variant for supervised lifecycles. Retain the owned Child handle
/// when this returns false; a timeout must never authorize a second instance.
pub fn terminate_group_until(child: &mut Child, until: Instant) -> bool {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    #[cfg(unix)]
    signal_group(child, libc::SIGTERM);
    #[cfg(not(unix))]
    let _ = child.kill();
    let grace = until
        .saturating_duration_since(Instant::now())
        .min(Duration::from_millis(200));
    if wait_until(child, grace).is_some() {
        return true;
    }
    #[cfg(unix)]
    signal_group(child, libc::SIGKILL);
    let _ = child.kill();
    wait_until(child, until.saturating_duration_since(Instant::now())).is_some()
}

#[cfg(unix)]
fn signal_group(child: &Child, signal: libc::c_int) {
    // Safety: a plain syscall addressed to the group led by our own, not yet
    // reaped child, so its pid cannot have been reused by another process.
    unsafe {
        libc::killpg(child.id() as libc::pid_t, signal);
    }
}

#[derive(Debug)]
pub enum RunError {
    Spawn(std::io::Error),
    TimedOut,
}

/// Run a short command (version probes, small SSH helpers) to completion with
/// a deadline. Both pipes are drained concurrently and each is capped at
/// `max_bytes`; on timeout the child's process group is stopped and reaped.
pub fn output_with_timeout(
    command: &mut Command,
    limit: Duration,
    max_bytes: u64,
) -> Result<Output, RunError> {
    output_with_input_timeout(command, limit, max_bytes, None)
}

/// Upload bytes through stdin rather than command arguments, with the same owned-child deadline.
pub fn output_with_input_timeout(
    command: &mut Command,
    limit: Duration,
    max_bytes: u64,
    input: Option<Vec<u8>>,
) -> Result<Output, RunError> {
    own_process_group(command);
    hide_console(command);
    let mut child = command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunError::Spawn)?;
    let writer = input.map(|bytes| {
        let mut pipe = child.stdin.take().expect("piped stdin");
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(pipe.write_all(&bytes));
        });
        receiver
    });
    let stdout = child.stdout.take().map(|pipe| drain(pipe, max_bytes));
    let stderr = child.stderr.take().map(|pipe| drain(pipe, max_bytes));
    let Some(status) = wait_until(&mut child, limit) else {
        terminate_group(&mut child, Duration::from_millis(500));
        return Err(RunError::TimedOut);
    };
    if let Some(writer) = writer {
        writer
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| RunError::TimedOut)?
            .map_err(RunError::Spawn)?;
    }
    // A descendant may still hold a pipe open; never wait for it unbounded.
    let collect = |pipe: Option<mpsc::Receiver<Vec<u8>>>| {
        pipe.and_then(|receiver| receiver.recv_timeout(Duration::from_secs(1)).ok())
            .unwrap_or_default()
    };
    Ok(Output {
        status,
        stdout: collect(stdout),
        stderr: collect(stderr),
    })
}

fn drain<R: Read + Send + 'static>(pipe: R, max_bytes: u64) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut captured = Vec::new();
        let mut limited = pipe.take(max_bytes);
        let _ = limited.read_to_end(&mut captured);
        let _ = sender.send(captured);
        // Keep consuming so a verbose child never blocks on a full pipe.
        let _ = std::io::copy(&mut limited.into_inner(), &mut std::io::sink());
    });
    receiver
}

/// The last bytes a long-lived child wrote to a pipe. The pipe is drained
/// continuously, so the child can never block on it, and memory stays bounded.
#[derive(Clone, Default)]
pub struct OutputTail(Arc<Mutex<Vec<u8>>>);

impl OutputTail {
    pub fn follow<R: Read + Send + 'static>(mut pipe: R, limit: usize) -> Self {
        let tail = Self::default();
        let sink = tail.0.clone();
        thread::spawn(move || {
            let mut chunk = [0_u8; 4096];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        if let Ok(mut buffer) = sink.lock() {
                            buffer.extend_from_slice(&chunk[..read]);
                            if buffer.len() > limit {
                                let excess = buffer.len() - limit;
                                let recent = buffer.split_off(excess);
                                *buffer = recent;
                            }
                        }
                    }
                }
            }
        });
        tail
    }

    pub fn text(&self) -> String {
        self.0
            .lock()
            .map(|buffer| String::from_utf8_lossy(&buffer).trim().to_string())
            .unwrap_or_default()
    }
}

#[cfg(target_os = "windows")]
pub use windows_job::KillOnCloseJob;

#[cfg(target_os = "windows")]
mod windows_job {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, process::Child};
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Io {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Extended {
        basic: Basic,
        io: Io,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: u32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// Closing this handle (drop, or Desktop exiting/crashing) terminates every
    /// process in the job: the child and all descendants it started.
    pub struct KillOnCloseJob(*mut c_void);
    // Job handles can be closed from any thread; ownership remains unique.
    unsafe impl Send for KillOnCloseJob {}
    impl KillOnCloseJob {
        pub fn attach(child: &Child) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err("Windows не создал Job Object для дочернего процесса.".into());
                }
                let mut info = Extended::default();
                info.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<Extended>() as u32,
                ) == 0
                    || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
                {
                    CloseHandle(job);
                    return Err(
                        "Windows не смог привязать дочерний процесс к Job Object Desktop.".into(),
                    );
                }
                Ok(KillOnCloseJob(job))
            }
        }
    }
    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0400;
    const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;
    const THREAD_QUERY_LIMITED_INFORMATION: u32 = 0x0800;
    const INVALID_HANDLE_VALUE: isize = -1;
    // Exact THREADENTRY32 layout; most fields are written by Windows only.
    #[repr(C)]
    #[allow(dead_code)]
    struct ThreadEntry32 {
        size: u32,
        usage: u32,
        thread_id: u32,
        owner_process_id: u32,
        base_priority: i32,
        delta_priority: i32,
        flags: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn TerminateJobObject(job: *mut c_void, exit_code: u32) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Thread32First(snapshot: *mut c_void, entry: *mut ThreadEntry32) -> i32;
        fn Thread32Next(snapshot: *mut c_void, entry: *mut ThreadEntry32) -> i32;
        fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> *mut c_void;
        fn GetProcessIdOfThread(thread: *mut c_void) -> u32;
        fn ResumeThread(thread: *mut c_void) -> u32;
        fn QueryInformationJobObject(
            job: *mut c_void,
            class: u32,
            info: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }
    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    impl KillOnCloseJob {
        fn create(extra_flags: u32) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err("Windows did not create a Job Object".into());
                }
                let owned = KillOnCloseJob(job);
                let mut info = Extended::default();
                // No BREAKAWAY_OK flags: descendants cannot leave the job.
                info.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | extra_flags;
                if SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<Extended>() as u32,
                ) == 0
                {
                    return Err("Windows rejected the kill-on-close Job limits".into());
                }
                Ok(owned)
            }
        }
        /// Terminate every process currently in this owned job. The handle
        /// stays open; dropping it afterwards is still required.
        pub fn terminate(&self) -> bool {
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }
        #[cfg(test)]
        pub fn raw(&self) -> *mut c_void {
            self.0
        }
        /// True once the job reports no active process before `until`.
        /// TerminateJobObject does not wait, so this is the settlement proof.
        pub fn wait_empty(&self, until: std::time::Instant) -> bool {
            // Exact JOBOBJECT_BASIC_ACCOUNTING_INFORMATION layout.
            #[repr(C)]
            #[derive(Default)]
            struct Accounting {
                user: i64,
                kernel: i64,
                period_user: i64,
                period_kernel: i64,
                page_faults: u32,
                total: u32,
                active: u32,
                terminated: u32,
            }
            const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION: u32 = 1;
            loop {
                let mut info = Accounting::default();
                let ok = unsafe {
                    QueryInformationJobObject(
                        self.0,
                        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                        &mut info as *mut _ as *mut c_void,
                        std::mem::size_of::<Accounting>() as u32,
                        std::ptr::null_mut(),
                    )
                } != 0;
                if !ok {
                    return false;
                }
                if info.active == 0 {
                    return true;
                }
                if std::time::Instant::now() >= until {
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }

    /// Resume the only thread of a suspended process we created and still own.
    /// The owned process handle prevents PID reuse; the thread is re-checked
    /// against that PID after opening, and the previous suspend count must be 1.
    fn resume_primary_thread(child: &Child) -> Result<(), String> {
        let pid = child.id();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot as isize == INVALID_HANDLE_VALUE || snapshot.is_null() {
                return Err("Windows thread snapshot failed".into());
            }
            let snapshot = Handle(snapshot);
            let mut entry = ThreadEntry32 {
                size: std::mem::size_of::<ThreadEntry32>() as u32,
                usage: 0,
                thread_id: 0,
                owner_process_id: 0,
                base_priority: 0,
                delta_priority: 0,
                flags: 0,
            };
            let mut threads = Vec::new();
            let mut more = Thread32First(snapshot.0, &mut entry) != 0;
            while more {
                if entry.owner_process_id == pid {
                    threads.push(entry.thread_id);
                }
                entry.size = std::mem::size_of::<ThreadEntry32>() as u32;
                more = Thread32Next(snapshot.0, &mut entry) != 0;
            }
            let &[thread_id] = threads.as_slice() else {
                return Err("Suspended build process does not have exactly one thread".into());
            };
            let thread = OpenThread(
                THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                0,
                thread_id,
            );
            if thread.is_null() {
                return Err("Windows did not open the suspended primary thread".into());
            }
            let thread = Handle(thread);
            if GetProcessIdOfThread(thread.0) != pid {
                return Err("Primary thread ownership changed".into());
            }
            match ResumeThread(thread.0) {
                1 => Ok(()),
                u32::MAX => Err("Windows did not resume the primary thread".into()),
                _ => Err("Primary thread had an unexpected suspend count".into()),
            }
        }
    }

    /// Create `command` suspended and hidden, assign it to a fresh kill-on-close
    /// Job, and only then resume it, so no descendant can start outside the job.
    /// Any failure terminates the never-resumed child through its own handle.
    pub fn spawn_in_job(
        command: &mut std::process::Command,
    ) -> Result<(Child, KillOnCloseJob), String> {
        use std::os::windows::process::CommandExt;
        let job = KillOnCloseJob::create(JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION)?;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Build process did not start ({:?})", error.kind()))?;
        let assigned = unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) != 0 };
        let result = if assigned {
            resume_primary_thread(&child)
        } else {
            Err("Windows did not assign the suspended build process to its Job".into())
        };
        if let Err(error) = result {
            // Never resumed (or resume failed): terminate the owned handle, then
            // the job, and reap. No PID-based lookup is used for cleanup.
            let _ = child.kill();
            job.terminate();
            let _ = super::wait_until(&mut child, std::time::Duration::from_secs(5));
            return Err(error);
        }
        Ok((child, job))
    }
}

#[cfg(target_os = "windows")]
pub use windows_job::spawn_in_job;

/// A started process tree owned by Desktop: a Windows kill-on-close Job created
/// before the primary thread ran, or a Unix process group led by the child.
pub struct OwnedTree {
    pub child: Child,
    #[cfg(target_os = "windows")]
    job: KillOnCloseJob,
}

impl OwnedTree {
    pub fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        {
            let (child, job) = spawn_in_job(command)?;
            Ok(Self { child, job })
        }
        #[cfg(not(target_os = "windows"))]
        {
            own_process_group(command);
            let child = command
                .spawn()
                .map_err(|error| format!("Build process did not start ({:?})", error.kind()))?;
            Ok(Self { child })
        }
    }
    /// Whether the primary exited, WITHOUT reaping it on Unix: the zombie keeps
    /// its PID and therefore the process-group id pinned until [`Self::settle`].
    pub fn primary_exited(&mut self) -> std::io::Result<bool> {
        #[cfg(unix)]
        {
            observe(&self.child).map(|state| !matches!(state, Observed::Running))
        }
        #[cfg(not(unix))]
        {
            self.child.try_wait().map(|status| status.is_some())
        }
    }
    /// SIGTERM to the group (Unix), a bounded grace, then [`Self::settle`].
    pub fn stop(&mut self, grace: Duration, limit: Duration) -> Settlement {
        #[cfg(unix)]
        if matches!(observe(&self.child), Ok(Observed::Running)) {
            signal_group(&self.child, libc::SIGTERM);
            let until = Instant::now() + grace;
            while Instant::now() < until && matches!(observe(&self.child), Ok(Observed::Running)) {
                thread::sleep(Duration::from_millis(25));
            }
        }
        #[cfg(not(unix))]
        let _ = grace;
        self.settle(limit)
    }
    /// Stop everything still inside the owned tree, then reap the primary.
    /// `complete` is true only when the whole owned scope is proven empty:
    /// Windows: the Job reports no active process. Unix: the group was killed
    /// while the unreaped primary pinned its id (never a reusable PGID), plus,
    /// for a Linux runner that adopted orphans, every re-parented descendant
    /// (including ones that left the group) was reaped. `scope` names what was
    /// covered; macOS cannot see descendants that left the group (`"group"`).
    pub fn settle(&mut self, limit: Duration) -> Settlement {
        let until = Instant::now() + limit;
        #[cfg(target_os = "windows")]
        {
            self.job.terminate();
            let _ = self.child.kill();
            let status = wait_until(&mut self.child, limit);
            let empty = self.job.wait_empty(until);
            Settlement {
                complete: status.is_some() && empty,
                status,
                scope: "job",
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let signalled = match observe(&self.child) {
                Ok(Observed::Running | Observed::Exited) => {
                    signal_group(&self.child, libc::SIGKILL);
                    true
                }
                Ok(Observed::Gone) | Err(_) => false,
            };
            let status = wait_until(&mut self.child, limit);
            #[cfg(target_os = "linux")]
            if ADOPTS_ORPHANS.load(std::sync::atomic::Ordering::Acquire) {
                let swept = sweep_orphans(until);
                return Settlement {
                    complete: signalled && status.is_some() && swept,
                    status,
                    scope: "group+orphans",
                };
            }
            #[cfg(not(target_os = "linux"))]
            let _ = until;
            Settlement {
                complete: signalled && status.is_some(),
                status,
                scope: "group",
            }
        }
    }
}

pub struct Settlement {
    pub status: Option<ExitStatus>,
    pub complete: bool,
    pub scope: &'static str,
}

#[cfg(unix)]
enum Observed {
    Running,
    Exited,
    Gone,
}

/// `waitid(WNOWAIT)`: report an exit without reaping. `Gone` = already reaped,
/// so its PID/PGID must never be signalled again.
#[cfg(unix)]
fn observe(child: &Child) -> std::io::Result<Observed> {
    // Safety: zeroed siginfo is the documented "no event" value for WNOHANG.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    if unsafe { libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info, flags) } != 0 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ECHILD) => Ok(Observed::Gone),
            _ => Err(error),
        };
    }
    Ok(if info.si_signo == libc::SIGCHLD {
        Observed::Exited
    } else {
        Observed::Running
    })
}

#[cfg(target_os = "linux")]
static ADOPTS_ORPHANS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// For the single-purpose runner process only (never the desktop app): become
/// a Linux child subreaper so descendants that leave the process group are
/// re-parented to us, stay pinned as our own children and are settled too.
pub fn adopt_orphans() -> bool {
    #[cfg(target_os = "linux")]
    {
        let ok = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0;
        ADOPTS_ORPHANS.store(ok, std::sync::atomic::Ordering::Release);
        ok
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Reap exited adopted orphans; SIGKILL live ones. Each PID comes from our own
/// children list and is still unreaped (only this thread reaps), so it cannot
/// name a foreign process. False when children remain at `until` or cannot
/// be listed.
#[cfg(target_os = "linux")]
fn sweep_orphans(until: Instant) -> bool {
    loop {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid > 0 {
            continue;
        }
        if pid < 0 {
            return std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD);
        }
        if Instant::now() >= until {
            return false;
        }
        let mut children = Vec::new();
        let Ok(tasks) = std::fs::read_dir("/proc/self/task") else {
            return false;
        };
        for task in tasks.flatten() {
            let Ok(text) = std::fs::read_to_string(task.path().join("children")) else {
                return false;
            };
            children.extend(
                text.split_whitespace()
                    .filter_map(|p| p.parse::<i32>().ok()),
            );
        }
        for pid in children {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn job_close_terminates_its_child_and_grandchild() {
        use std::ffi::c_void;
        use std::io::{BufRead, BufReader, Write};
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        struct ProcessHandle(*mut c_void);
        impl Drop for ProcessHandle {
            fn drop(&mut self) {
                unsafe { CloseHandle(self.0) };
            }
        }
        let powershell =
            std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot"))
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(powershell);
        // Attach before releasing stdin, so the fixture's descendant inherits
        // the job. All processes are test-owned; no process-name discovery.
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$null=[Console]::ReadLine(); $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; [Console]::WriteLine($p.Id); [Console]::Out.Flush(); Start-Sleep -Seconds 60",
        ]);
        hide_console(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fixture child");
        let job = match KillOnCloseJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                terminate_group(&mut child, Duration::from_secs(1));
                panic!("fixture job attachment failed: {error}");
            }
        };
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line);
            let _ = sender.send(result.map(|_| line));
        });
        child.stdin.take().unwrap().write_all(b"start\n").unwrap();
        let pid: u32 = receiver
            .recv_timeout(Duration::from_secs(15))
            .expect("bounded grandchild startup")
            .expect("read fixture PID")
            .trim()
            .parse()
            .expect("grandchild PID");
        // SYNCHRONIZE only. Retain the actual handle to avoid PID reuse races.
        let grandchild = ProcessHandle(unsafe { OpenProcess(0x0010_0000, 0, pid) });
        assert!(!grandchild.0.is_null(), "open test-owned descendant");
        assert_eq!(unsafe { WaitForSingleObject(grandchild.0, 0) }, 258);
        assert!(matches!(child.try_wait(), Ok(None)));
        drop(job);
        assert_eq!(unsafe { WaitForSingleObject(grandchild.0, 5000) }, 0);
        assert!(wait_until(&mut child, Duration::from_secs(5)).is_some());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn suspended_spawn_resumes_only_after_job_assignment_and_owns_descendants() {
        use std::ffi::c_void;
        use std::io::{BufRead, BufReader};
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
            fn IsProcessInJob(process: *mut c_void, job: *mut c_void, result: *mut i32) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        let system = std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"));
        // Resume proof: a never-resumed child could not produce its exit code.
        let mut quick = Command::new(system.join("System32/cmd.exe"));
        quick
            .args(["/D", "/C", "exit 7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, _job) = spawn_in_job(&mut quick).expect("suspended spawn");
        let status = wait_until(&mut child, Duration::from_secs(15));
        assert_eq!(status.and_then(|s| s.code()), Some(7));
        // Descendant started by the child is inside the job from its first instruction.
        let mut parent =
            Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
        parent.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; [Console]::WriteLine($p.Id); [Console]::Out.Flush(); Start-Sleep -Seconds 60",
        ]);
        parent
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let (mut child, job) = spawn_in_job(&mut parent).expect("suspended spawn");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .expect("descendant PID");
        let pid: u32 = line.trim().parse().expect("descendant PID");
        // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION on a test-owned descendant.
        let handle = unsafe { OpenProcess(0x0010_1000, 0, pid) };
        assert!(!handle.is_null());
        let mut inside = 0;
        assert_ne!(unsafe { IsProcessInJob(handle, job.raw(), &mut inside) }, 0);
        assert_eq!(inside, 1, "descendant must be inside the owned job");
        assert!(job.terminate());
        assert_eq!(unsafe { WaitForSingleObject(handle, 5000) }, 0);
        unsafe { CloseHandle(handle) };
        assert!(wait_until(&mut child, Duration::from_secs(5)).is_some());
    }

    #[test]
    #[cfg(unix)]
    fn bounded_output_returns_captured_streams() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf out; printf err >&2; exit 3"]);
        let output = output_with_timeout(&mut command, Duration::from_secs(5), 1024).unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }

    #[test]
    #[cfg(unix)]
    fn input_upload_is_complete_and_stalled_input_has_a_deadline() {
        let data = vec![42; 256 * 1024];
        let mut cat = Command::new("/bin/cat");
        let output = output_with_input_timeout(
            &mut cat,
            Duration::from_secs(5),
            data.len() as u64,
            Some(data.clone()),
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, data);
        let mut unrelated = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        let mut stalled = Command::new("/bin/sleep");
        stalled.arg("30");
        let result = output_with_input_timeout(
            &mut stalled,
            Duration::from_millis(200),
            1024,
            Some(vec![0; 1024 * 1024]),
        );
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        assert!(matches!(result, Err(RunError::TimedOut)));
        assert!(unrelated_alive);
    }

    #[test]
    #[cfg(unix)]
    fn bounded_output_kills_a_hanging_child_within_its_deadline() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let started = Instant::now();
        assert!(matches!(
            output_with_timeout(&mut command, Duration::from_millis(300), 1024),
            Err(RunError::TimedOut)
        ));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    #[cfg(unix)]
    fn verbose_children_cannot_deadlock_and_capture_is_capped() {
        // 512 KiB is far beyond any pipe buffer; a reader that stopped at the
        // cap would leave the child blocked until the deadline.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "head -c 524288 /dev/zero"]);
        let started = Instant::now();
        let output = output_with_timeout(&mut command, Duration::from_secs(10), 1024).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 1024);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn output_tail_keeps_only_the_most_recent_bytes() {
        let tail = OutputTail::follow(std::io::Cursor::new(b"0123456789abcdef".to_vec()), 6);
        let deadline = Instant::now() + Duration::from_secs(2);
        while tail.text() != "abcdef" && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(tail.text(), "abcdef");
    }
}
