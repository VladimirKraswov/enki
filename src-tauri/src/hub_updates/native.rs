//! Signed package metadata authorizes a bounded GitHub download, never source execution.
use super::{
    build::Build,
    install::Plan,
    packet::{self, Envelope},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const PREFIX: &str = "https://github.com/VladimirKraswov/enki/releases/download/";
const MAX: u64 = 512 * 1024 * 1024;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    name: String,
    sha256: String,
    bytes: u64,
    url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    kind: String,
    version: String,
    native_fingerprint: String,
    commit: String,
    run_id: u64,
    packages: BTreeMap<String, Package>,
}
fn platform() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64"))
        && std::env::var_os("APPIMAGE").is_none()
        && Path::new("/usr/bin/dpkg").is_file()
    {
        "linux-x64"
    } else {
        "unsupported"
    }
}
fn validate(m: &Manifest, version: &str, fingerprint: &str) -> Result<(), String> {
    if m.schema_version != 1
        || m.kind != "native"
        || m.version != version
        || m.native_fingerprint != fingerprint
        || !packet::hash_ok(fingerprint)
        || m.commit.len() != 40
        || !m
            .commit
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || m.run_id == 0
        || m.packages.len() != 3
    {
        return Err("Готовый пакет не соответствует выбранному выпуску".into());
    }
    for (key, suffix) in [
        ("macos-arm64", ".dmg"),
        ("windows-x64", "-setup.exe"),
        ("linux-x64", ".deb"),
    ] {
        let p = m.packages.get(key).ok_or("Не указан пакет платформы")?;
        if !p.name.starts_with(&format!("Enki_{version}_"))
            || !p.name.ends_with(suffix)
            || !p
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
            || !(1024..=MAX).contains(&p.bytes)
            || !packet::hash_ok(&p.sha256)
            || p.url != format!("{PREFIX}v{version}/{}", p.name)
        {
            return Err("Некорректное описание готового пакета".into());
        }
    }
    Ok(())
}
pub fn verify(value: &Value, version: &str, fingerprint: &str) -> Result<Package, String> {
    let e: Envelope = serde_json::from_value(value["envelope"].clone())
        .map_err(|_| "Нет подписи готового пакета")?;
    if e.payload.len() > 32768 || e.signature.len() > 8192 {
        return Err("Описание пакета слишком велико".into());
    }
    let raw = STANDARD
        .decode(&e.payload)
        .map_err(|_| "Повреждено описание пакета")?;
    if value["digest"].as_str() != Some(packet::digest(&raw).as_str()) {
        return Err("Контрольная сумма описания не совпала".into());
    }
    crate::updates::verify(&raw, &e.signature, version)?;
    let m: Manifest = serde_json::from_slice(&raw).map_err(|_| "Некорректный подписанный пакет")?;
    validate(&m, version, fingerprint)?;
    m.packages
        .get(platform())
        .cloned()
        .ok_or("Для этой платформы готового пакета пока нет".into())
}
pub fn available(identity: &str, channel: &str, version: &str, fingerprint: &str) -> Value {
    match crate::hub::release_get(&format!("native/{channel}"), identity) {
        Ok(v) if v["state"] == "ready" => match verify(&v, version, fingerprint) {
            Ok(_) => v,
            Err(e) => json!({"state":"unavailable","message":e}),
        },
        Ok(v) => {
            json!({"state":if v["state"]=="pending"{"pending"}else{"unavailable"},"message":v["message"].as_str().unwrap_or("Пакет пока не готов.").chars().take(300).collect::<String>()})
        }
        Err(_) => {
            json!({"state":"unavailable","message":"Не удалось проверить готовый пакет. Повторите проверку; локальная сборка остаётся доступна."})
        }
    }
}
fn redirect_allowed(u: &url::Url) -> bool {
    u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none()
        && matches!(
            u.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}
pub fn prepare(
    build: &Build,
    p: &Package,
    version: &str,
    directory: &Path,
) -> Result<Plan, String> {
    let artifact = prepare_artifact(build, p, version, directory)?;
    let plan = Plan::create(&artifact, version)?;
    super::atomic(&directory.join("install-plan.json"), &plan)?;
    Ok(plan)
}
fn prepare_artifact(
    build: &Build,
    p: &Package,
    version: &str,
    directory: &Path,
) -> Result<PathBuf, String> {
    fs::create_dir(directory).map_err(|e| e.to_string())?;
    crate::updates::private(directory)?;
    let file = directory.join(&p.name);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() < 5 && redirect_allowed(a.url()) {
                a.follow()
            } else {
                a.stop()
            }
        }))
        .build()
        .map_err(|_| "Не удалось подготовить загрузку")?;
    build.set(json!({"stage":"downloading","totalBytes":p.bytes,"receivedBytes":0}));
    let mut r = client
        .get(&p.url)
        .send()
        .map_err(|_| "GitHub недоступен. Повторите загрузку.")?;
    if !r.status().is_success() {
        return Err(format!(
            "GitHub вернул HTTP {}. Повторите загрузку.",
            r.status().as_u16()
        ));
    }
    if r.content_length().is_some_and(|n| n != p.bytes) {
        return Err("Размер пакета GitHub не совпал".into());
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    copy_verified(build, p, &mut r, &mut f)?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    build.check_cancel()?;
    build.set(json!({"stage":"unpacking"}));
    let artifact = unpack(build, &file, version, directory)?;
    build.check_cancel()?;
    Ok(artifact)
}
fn copy_verified(
    build: &Build,
    p: &Package,
    r: &mut impl Read,
    f: &mut impl Write,
) -> Result<(), String> {
    let mut hash = Sha256::new();
    let mut received = 0u64;
    let mut buffer = [0u8; 65536];
    let start = Instant::now();
    loop {
        if start.elapsed() > download_limit(p.bytes) {
            return Err("Время загрузки истекло. Повторите попытку.".into());
        }
        build.check_cancel()?;
        let n = r
            .read(&mut buffer)
            .map_err(|_| "Загрузка прервана. Повторите загрузку пакета.")?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > p.bytes {
            return Err("Размер загрузки превышает подписанный размер".into());
        }
        f.write_all(&buffer[..n])
            .map_err(|_| "Не удалось сохранить пакет")?;
        hash.update(&buffer[..n]);
        build.set(json!({"receivedBytes":received}));
    }
    if received != p.bytes || format!("{:x}", hash.finalize()) != p.sha256 {
        return Err("Контрольная сумма пакета не совпала. Установка отменена.".into());
    }
    Ok(())
}
// Allow a slow but active transfer of a full runtime bundle. Individual
// reads/connects remain bounded, and cancellation is checked for every chunk.
// Small downloads keep the existing deadline; no packet gets an unbounded run.
fn download_limit(bytes: u64) -> Duration {
    Duration::from_secs((bytes.div_ceil(32 * 1024) + 120).clamp(15 * 60, 60 * 60))
}
#[cfg(target_os = "macos")]
fn unpack(build: &Build, file: &Path, version: &str, dir: &Path) -> Result<PathBuf, String> {
    let mount = dir.join("mounted");
    fs::create_dir(&mount).map_err(|e| e.to_string())?;
    let log = dir.join("package.log");
    build.set(json!({"logPath":log}));
    let result = (|| {
        build.run(
            Command::new("/usr/bin/hdiutil")
                .args([
                    "attach",
                    "-readonly",
                    "-nobrowse",
                    "-noautoopen",
                    "-mountpoint",
                ])
                .arg(&mount)
                .arg(file),
            &log,
            Duration::from_secs(60),
        )?;
        let app = mount.join("Enki.app");
        if !app.is_dir() || app.is_symlink() {
            return Err("В пакете не найдено приложение Enki".into());
        }
        let mut cmd = Command::new("/usr/bin/plutil");
        cmd.args(["-convert", "json", "-o", "-"])
            .arg(app.join("Contents/Info.plist"));
        let out = crate::process::output_with_timeout(&mut cmd, Duration::from_secs(10), 65536)
            .map_err(|_| "Не удалось прочитать версию приложения")?;
        let info: Value =
            serde_json::from_slice(&out.stdout).map_err(|_| "Некорректный Info.plist")?;
        if !out.status.success()
            || info["CFBundleIdentifier"] != "dev.local.opencodedesktop"
            || info["CFBundleShortVersionString"] != version
        {
            return Err("Версия или идентичность приложения не совпала".into());
        }
        build.run(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&app),
            &log,
            Duration::from_secs(60),
        )?;
        let target = dir.join("Enki.app");
        build.run(
            Command::new("/usr/bin/ditto").arg(&app).arg(&target),
            &log,
            Duration::from_secs(180),
        )?;
        Ok(target)
    })();
    // Always detach, including cancellation. Do not inherit the canceled job gate.
    let mut cmd = Command::new("/usr/bin/hdiutil");
    cmd.arg("detach").arg(&mount);
    let detached = crate::process::output_with_timeout(&mut cmd, Duration::from_secs(20), 4096);
    if result.is_ok() && !detached.is_ok_and(|o| o.status.success()) {
        return Err("Не удалось отключить образ обновления. Повторите загрузку.".into());
    }
    result
}
#[cfg(not(target_os = "macos"))]
fn unpack(_build: &Build, file: &Path, _version: &str, _dir: &Path) -> Result<PathBuf, String> {
    Ok(file.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_large_download_keeps_a_finite_size_aware_deadline() {
        // Actual 2.0.13 transfer timed out at 15 minutes with only 56 MB of
        // its 114 MB bundle received. Even a 40 KiB/s link must get enough time.
        let bytes = 113_857_995;
        assert!(download_limit(bytes) >= Duration::from_secs(bytes / (40 * 1024)));
        assert!(download_limit(MAX) <= Duration::from_secs(60 * 60));
        assert_eq!(download_limit(2048), Duration::from_secs(15 * 60));
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Opt-in real signed GitHub download/unpack; ENKI_NATIVE_ACCEPTANCE contains verified Hub head and native response"]
    fn actual_signed_package_downloads_and_unpacks_without_installation() {
        let input = PathBuf::from(
            std::env::var_os("ENKI_NATIVE_ACCEPTANCE").expect("explicit acceptance input"),
        );
        assert!(fs::metadata(&input).unwrap().len() < 65536);
        let v: Value = super::super::read_json(&input).unwrap();
        let version = v["version"].as_str().unwrap();
        let fp = v["nativeFingerprint"].as_str().unwrap();
        let package = verify(&v["native"], version, fp).unwrap();
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "enki-native-acceptance-{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
        let artifact = prepare_artifact(&Build::default(), &package, version, &directory).unwrap();
        assert!(artifact.join("Contents/MacOS/enki").is_file());
        assert!(
            !directory.join("install-plan.json").exists(),
            "acceptance never prepares installation"
        );
        println!(
            "Verified and unpacked Enki {version}: {} ({} bytes)",
            package.sha256, package.bytes
        );
        fs::remove_dir_all(directory).unwrap();
    }
    fn fixture() -> Manifest {
        let version = "2.0.6";
        Manifest {
            schema_version: 1,
            kind: "native".into(),
            version: version.into(),
            native_fingerprint: "a".repeat(64),
            commit: "b".repeat(40),
            run_id: 1,
            packages: [
                ("macos-arm64", "aarch64.dmg"),
                ("windows-x64", "x64-setup.exe"),
                ("linux-x64", "amd64.deb"),
            ]
            .into_iter()
            .map(|(k, n)| {
                let name = format!("Enki_{version}_{n}");
                (
                    k.into(),
                    Package {
                        url: format!("{PREFIX}v{version}/{name}"),
                        name,
                        bytes: 2048,
                        sha256: "c".repeat(64),
                    },
                )
            })
            .collect(),
        }
    }
    #[test]
    fn package_identity_is_exact() {
        let mut m = fixture();
        assert!(validate(&m, "2.0.6", &"a".repeat(64)).is_ok());
        assert!(validate(&m, "2.0.7", &"a".repeat(64)).is_err());
        m.packages
            .get_mut("macos-arm64")
            .unwrap()
            .url
            .push_str("?token=bad");
        assert!(validate(&m, "2.0.6", &"a".repeat(64)).is_err());
    }
    #[test]
    fn package_paths_and_sizes_are_bounded() {
        for name in [
            "../../Enki_2.0.6_x.dmg",
            "Enki_2.0.6_../x.dmg",
            "Enki_2.0.6_x.dmg\n",
        ] {
            let mut m = fixture();
            m.packages.get_mut("macos-arm64").unwrap().name = name.into();
            assert!(validate(&m, "2.0.6", &"a".repeat(64)).is_err());
        }
        let mut m = fixture();
        m.packages.get_mut("linux-x64").unwrap().bytes = MAX + 1;
        assert!(validate(&m, "2.0.6", &"a".repeat(64)).is_err());
    }
    #[test]
    fn streamed_bytes_must_match_and_cancellation_never_prepares_a_package() {
        let b = Build::default();
        let bytes = vec![8; 2048];
        let mut p = fixture().packages.remove("macos-arm64").unwrap();
        p.sha256 = packet::digest(&bytes);
        let mut output = Vec::new();
        assert!(copy_verified(&b, &p, &mut bytes.as_slice(), &mut output).is_ok());
        assert_eq!(output, bytes);
        for wrong in [vec![9; 2048], vec![8; 2047], vec![8; 2049]] {
            assert!(copy_verified(&b, &p, &mut wrong.as_slice(), &mut Vec::new()).is_err());
        }
        b.cancel();
        let mut canceled = Vec::new();
        assert!(copy_verified(&b, &p, &mut bytes.as_slice(), &mut canceled).is_err());
        assert!(canceled.is_empty());
    }
    #[test]
    fn redirects_cannot_leave_github_https() {
        for s in [
            "http://github.com/file",
            "https://github.com.attacker.test/file",
            "https://user@github.com/file",
            "https://127.0.0.1/file",
        ] {
            assert!(!redirect_allowed(&url::Url::parse(s).unwrap()));
        }
        assert!(redirect_allowed(
            &url::Url::parse("https://release-assets.githubusercontent.com/file?signature=opaque")
                .unwrap()
        ));
    }
}
