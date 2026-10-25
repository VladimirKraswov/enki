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
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=updater.pub");
    tauri_build::build()
}
