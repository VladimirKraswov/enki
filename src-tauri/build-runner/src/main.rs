//! `enki-build-runner`: the trusted native build-job runner (Windows suspended
//! start + kill-on-close Job, bounded output/deadline, honest tree settlement,
//! durable directory flush) as a minimal standalone program.
//!
//! runtime:prepare compiles it from the authenticated source BEFORE runtime
//! preparation (scripts/runtime/build-runner.mjs), so the first source update
//! driven by an older installed Enki that lacks `--enki-build-job` still runs
//! every Windows build job inside an owned Job. It compiles the exact audited
//! desktop modules; no Tauri, frontend assets, agent runtime or profile state.
#[allow(dead_code)]
#[path = "../../src/process.rs"]
mod process;

#[path = "../../src/build_job.rs"]
mod build_job;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let flag = args.next();
    if flag.as_deref() != Some(std::ffi::OsStr::new("--enki-build-job")) || args.next().is_some() {
        eprintln!("enki-build-runner: usage: enki-build-runner --enki-build-job < request.json");
        std::process::exit(2);
    }
    if let Err(error) = build_job::cli() {
        eprintln!("enki-build-job: {error}");
        std::process::exit(2);
    }
}
