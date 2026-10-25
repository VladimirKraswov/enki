//! Durable private file boundary for sanitized config generations.
//!
//! Every path is derived by native code below one app-owned root. Ancestors
//! are checked with lstat (never canonicalized: that would hide a link), files
//! are 0600 and opened without following links, content and directories are
//! fsynced, and publication is a same-volume no-overwrite rename. There is no
//! copy fallback: a cross-device or unsupported rename fails the whole import.

use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
};

pub const ERR_UNSAFE: &str = "CONFIG_UNSAFE_PATH: каталог настроек содержит ссылку или чужой файл";
pub const ERR_IO: &str = "CONFIG_DURABLE_IO: не удалось надёжно записать настройки";
pub const ERR_CROSS_DEVICE: &str =
    "CONFIG_CROSS_DEVICE: публикация настроек между томами не поддерживается";
pub const ERR_EXISTS: &str = "CONFIG_GENERATION_EXISTS: поколение настроек уже опубликовано";

fn linked(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Every absolute ancestor (inclusive) must exist as a real directory.
pub fn check_dir_chain(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(ERR_UNSAFE.into());
    }
    for at in path.ancestors() {
        let meta = fs::symlink_metadata(at).map_err(|_| ERR_UNSAFE)?;
        if linked(&meta) || !meta.is_dir() {
            return Err(ERR_UNSAFE.into());
        }
    }
    Ok(())
}

/// Create (0700) a direct child directory of an already checked directory.
pub fn ensure_child_dir(parent: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(ERR_UNSAFE.into());
    }
    let child = parent.join(name);
    match fs::symlink_metadata(&child) {
        Ok(meta) if linked(&meta) || !meta.is_dir() => return Err(ERR_UNSAFE.into()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&child).map_err(|_| ERR_IO)?;
            sync_dir(parent)?;
        }
        Err(_) => return Err(ERR_IO.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).map_err(|_| ERR_IO)?;
    }
    Ok(child)
}

fn options(write: bool, create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    if write {
        options.write(true);
    }
    if create {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    options
}

fn regular(file: &File) -> Result<Metadata, String> {
    let meta = file.metadata().map_err(|_| ERR_IO)?;
    if !meta.is_file() || linked(&meta) {
        return Err(ERR_UNSAFE.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(ERR_UNSAFE.into());
        }
    }
    Ok(meta)
}

/// Write one chunk at the journal's `offset` (the durable received length);
/// creates the file only for offset 0. Bytes past `offset` can only be a
/// crashed, unjournaled previous attempt of this same chunk and are truncated.
pub fn write_chunk(path: &Path, offset: u64, bytes: &[u8]) -> Result<(), String> {
    let mut file = match options(true, offset == 0).open(path) {
        Ok(file) => file,
        Err(error) if offset == 0 && error.kind() == std::io::ErrorKind::AlreadyExists => {
            options(true, false).open(path).map_err(|_| ERR_UNSAFE)?
        }
        Err(_) => return Err(ERR_UNSAFE.into()),
    };
    let meta = regular(&file)?;
    if meta.len() < offset {
        return Err("CONFIG_CHUNK_ORDER: фрагмент настроек получен не по порядку".into());
    }
    if meta.len() > offset {
        file.set_len(offset).map_err(|_| ERR_IO)?;
    }
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(offset))
        .map_err(|_| ERR_IO)?;
    file.write_all(bytes).map_err(|_| ERR_IO)?;
    Ok(())
}

/// Bytes of an already journaled chunk, for idempotent lost-ACK retries.
pub fn read_range(path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    let mut file = options(false, false).open(path).map_err(|_| ERR_UNSAFE)?;
    regular(&file)?;
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(offset))
        .map_err(|_| ERR_IO)?;
    let mut bytes = vec![0_u8; len];
    file.read_exact(&mut bytes).map_err(|_| ERR_IO)?;
    Ok(bytes)
}

/// Hash, size and private-mode check, then fsync content.
pub fn verify_and_sync(path: &Path, sha256: &str, size: u64) -> Result<(), String> {
    let mut file = options(true, false).open(path).map_err(|_| ERR_UNSAFE)?;
    let meta = regular(&file)?;
    if meta.len() != size {
        return Err("CONFIG_FILE_INCOMPLETE: файл настроек получен не полностью".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| ERR_IO)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual: String = digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if actual != sha256 {
        return Err("CONFIG_FILE_HASH: файл настроек не совпадает с планом".into());
    }
    file.sync_all().map_err(|_| ERR_IO.to_string())
}

/// Directory entry durability. Windows has no portable directory fsync; there
/// the publishing rename itself uses MOVEFILE_WRITE_THROUGH (see `publish`),
/// and file contents were already flushed with FlushFileBuffers (sync_all).
pub fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| ERR_IO)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// No-overwrite, same-volume rename of a staged generation directory. Callers
/// hold the authority's exclusive OS lock, so the absence check cannot race
/// another Enki writer; the OS rename additionally never copies across volumes.
pub fn publish(from: &Path, to: &Path) -> Result<(), String> {
    let (Some(from_parent), Some(to_parent)) = (from.parent(), to.parent()) else {
        return Err(ERR_UNSAFE.into());
    };
    check_dir_chain(from)?;
    check_dir_chain(to_parent)?;
    match fs::symlink_metadata(to) {
        Ok(_) => return Err(ERR_EXISTS.into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(ERR_IO.into()),
    }
    rename_no_copy(from, to)?;
    sync_dir(to_parent)?;
    sync_dir(from_parent)
}

#[cfg(not(windows))]
fn rename_no_copy(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| {
        if error.raw_os_error() == Some(libc::EXDEV) {
            ERR_CROSS_DEVICE.to_string()
        } else {
            ERR_IO.to_string()
        }
    })
}

#[cfg(windows)]
fn rename_no_copy(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    const ERROR_NOT_SAME_DEVICE: i32 = 17;
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Neither MOVEFILE_REPLACE_EXISTING nor MOVEFILE_COPY_ALLOWED: no overwrite
    // and no silent cross-volume copy.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        let error = std::io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(ERROR_NOT_SAME_DEVICE) {
            ERR_CROSS_DEVICE.into()
        } else {
            ERR_IO.into()
        });
    }
    Ok(())
}

/// Remove a directory this authority created (staging or unreferenced
/// generation). Never follows a link and never leaves the owned parent.
pub fn remove_owned_dir(parent: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(ERR_UNSAFE.into());
    }
    check_dir_chain(parent)?;
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(ERR_IO.into()),
        Ok(meta) if linked(&meta) => fs::remove_file(&path).map_err(|_| ERR_IO)?,
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(&path).map_err(|_| ERR_IO)?,
        Ok(_) => return Err(ERR_UNSAFE.into()),
    }
    sync_dir(parent)
}
