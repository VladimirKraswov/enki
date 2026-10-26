#[path = "src/runtime/artifact.rs"]
#[allow(dead_code)]
mod artifact;
mod build_runtime_resources;
mod native_fingerprint;
fn main() {
    let lock: serde_json::Value = serde_json::from_slice(
        &std::fs::read("resources/agent/runtime-lock.json").expect("pinned runtime lock"),
    )
    .expect("runtime lock JSON");
    let sdk = lock["sdk"]["version"]
        .as_str()
        .expect("pinned Pi SDK version");
    assert!(sdk
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b)));
    println!("cargo:rustc-env=ENKI_PINNED_PI_SDK={sdk}");
    let protocol = std::fs::read_to_string("resources/agent/src/protocol.ts")
        .expect("runtime protocol constants");
    let schema = protocol
        .lines()
        .find_map(|line| {
            line.strip_prefix("export const SCHEMA_VERSION = ")?
                .strip_suffix(';')?
                .parse::<u64>()
                .ok()
        })
        .expect("runtime schema version");
    println!("cargo:rustc-env=ENKI_RUNTIME_SCHEMA={schema}");
    let fingerprint = native_fingerprint::fingerprint(std::path::Path::new("."))
        .expect("native compatibility fingerprint");
    println!("cargo:rustc-env=ARVELA_NATIVE_FINGERPRINT={fingerprint}");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=resources");
    println!("cargo:rerun-if-changed=native_fingerprint.rs");
    println!("cargo:rerun-if-changed=build_runtime_resources.rs");
    println!("cargo:rerun-if-changed=src/runtime/artifact.rs");
    println!("cargo:rerun-if-changed=target/enki-agent/current/runtime-manifest.json");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=updater.pub");
    let prepared = std::path::Path::new("target/enki-agent/current");
    if prepared.exists() {
        let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
        let profile = output
            .ancestors()
            .nth(3)
            .expect("Cargo profile output directory");
        build_runtime_resources::synchronize(prepared, profile)
            .expect("exact Enki runtime build resources");
    }
    tauri_build::build()
}
