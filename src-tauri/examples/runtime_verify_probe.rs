//! Read-only A/B measurement against the immutable 2.0.30 verifier. Never
//! executes Node or opens an Enki profile. Run only on a test-owned artifact.
#[allow(dead_code)]
#[path = "../../test/fixtures/runtime-artifact-2.0.30.rs"]
mod baseline;
#[allow(dead_code)]
#[path = "../src/runtime/artifact.rs"]
mod current;
use serde_json::json;
use std::{path::PathBuf, time::Instant};

fn run() -> Result<(), String> {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("expected an absolute test artifact path")?;
    if !root.is_absolute() {
        return Err("test artifact path must be absolute".into());
    }
    let mut identity = None;
    // Same immutable files, both orders, without disabling filesystem/AV checks.
    for mode in ["baseline", "locked_paths", "locked_paths", "baseline"] {
        let start = Instant::now();
        let (digest, files) = if mode == "baseline" {
            let verified = baseline::verify(&root, baseline::Expected::default())?;
            (verified.manifest_sha256, verified.manifest.files.len())
        } else {
            let verified = current::verify(&root, current::Expected::default())?;
            (verified.manifest_sha256, verified.manifest.files.len())
        };
        if identity
            .as_ref()
            .is_some_and(|old| old != &(digest.clone(), files))
        {
            return Err("verifiers saw different artifact bytes".into());
        }
        identity = Some((digest.clone(), files));
        println!(
            "{}",
            json!({"type":"runtime-integrity-benchmark","mode":mode,"files":files,"manifestSha256":digest,"elapsedMs":start.elapsed().as_millis()})
        );
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Runtime verification probe failed: {error}");
        std::process::exit(1);
    }
}
