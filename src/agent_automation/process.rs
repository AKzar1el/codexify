//! OS process identity for stopping an unresponsive private companion.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

#[cfg(target_os = "linux")]
pub(super) fn executable(pid: u32) -> std::io::Result<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
}
#[cfg(target_os = "macos")]
pub(super) fn executable(pid: u32) -> std::io::Result<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let result =
        unsafe { libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if result <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let end = buffer
        .iter()
        .position(|b| *b == 0)
        .ok_or_else(|| std::io::Error::other("Invalid process path"))?;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(
        buffer[..end].to_vec(),
    )))
}
#[cfg(windows)]
pub(super) fn executable(pid: u32) -> std::io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
        },
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let success = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
    let error = std::io::Error::last_os_error();
    unsafe { CloseHandle(handle) };
    if success == 0 {
        return Err(error);
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..size as usize],
    )))
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(super) fn executable(_pid: u32) -> std::io::Result<PathBuf> {
    Err(std::io::Error::other("Process identity is unsupported"))
}

pub(super) fn same_process(pid: u32, path: &Path) -> bool {
    executable(pid)
        .and_then(|path| path.canonicalize())
        .is_ok_and(|current| current == path)
}

/// Chrome's private profile lock identifies an orphan left by a dead launcher.
/// Both executable ownership and the actual profile argument must agree.
#[cfg(unix)]
pub(super) fn orphaned_browser(
    profile: &Path,
    runtime_root: &Path,
) -> Result<Option<(u32, PathBuf)>, String> {
    use std::os::unix::fs::MetadataExt;
    let Ok(profile_meta) = std::fs::symlink_metadata(profile) else {
        return Ok(None);
    };
    if !profile_meta.file_type().is_dir() {
        return Err("Private Chrome profile must be a real directory".into());
    }
    let lock = profile.join("SingletonLock");
    let Ok(meta) = std::fs::symlink_metadata(&lock) else {
        return Ok(None);
    };
    if !meta.file_type().is_symlink() || meta.uid() != unsafe { libc::geteuid() } {
        return Err("Private Chrome profile lock is invalid".into());
    }
    let target = std::fs::read_link(lock).map_err(|e| e.to_string())?;
    let Some(pid) = target
        .to_str()
        .and_then(|value| value.rsplit_once('-'))
        .and_then(|(_, pid)| pid.parse::<u32>().ok())
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
    else {
        return Err("Private Chrome profile lock has no process identity".into());
    };
    let Ok(path) = executable(pid).and_then(|path| path.canonicalize()) else {
        return Ok(None);
    };
    let Some(root) = runtime_root.canonicalize().ok() else {
        return Ok(None);
    };
    if !path.starts_with(root) {
        return Ok(None);
    }
    let Ok(expected) = profile.canonicalize() else {
        return Ok(None);
    };
    let args = arguments(pid).map_err(|e| e.to_string())?;
    let mut profiles = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "--user-data-dir" {
            if let Some(value) = args.next() {
                profiles.push(PathBuf::from(value));
            }
        } else if let Some(value) = arg
            .to_str()
            .and_then(|arg| arg.strip_prefix("--user-data-dir="))
        {
            profiles.push(PathBuf::from(value));
        }
    }
    if profiles.is_empty()
        || !profiles
            .iter()
            .all(|profile| profile.canonicalize().is_ok_and(|path| path == expected))
    {
        return Ok(None);
    }
    Ok(Some((pid, path)))
}
#[cfg(not(unix))]
pub(super) fn orphaned_browser(
    _profile: &Path,
    _runtime_root: &Path,
) -> Result<Option<(u32, PathBuf)>, String> {
    Ok(None)
}

#[cfg(target_os = "linux")]
fn arguments(pid: u32) -> std::io::Result<Vec<std::ffi::OsString>> {
    use std::os::unix::ffi::OsStringExt;
    Ok(std::fs::read(format!("/proc/{pid}/cmdline"))?
        .split(|b| *b == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| std::ffi::OsString::from_vec(arg.to_vec()))
        .collect())
}
#[cfg(target_os = "macos")]
fn arguments(pid: u32) -> std::io::Result<Vec<std::ffi::OsString>> {
    use std::os::unix::ffi::OsStringExt;
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as i32];
    let mut size = 0;
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    if !(4..=1024 * 1024).contains(&size) {
        return Err(std::io::Error::other("Invalid process argument size"));
    }
    let mut bytes = vec![0u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    bytes.truncate(size);
    if bytes.len() < 4 {
        return Err(std::io::Error::other("Invalid process argument size"));
    }
    let count = i32::from_ne_bytes(bytes[..4].try_into().unwrap());
    if !(1..=4096).contains(&count) {
        return Err(std::io::Error::other("Invalid process argument count"));
    }
    let mut index = 4;
    while index < bytes.len() && bytes[index] != 0 {
        index += 1;
    }
    while index < bytes.len() && bytes[index] == 0 {
        index += 1;
    }
    Ok(bytes[index..]
        .split(|b| *b == 0)
        .take(count as usize)
        .map(|arg| std::ffi::OsString::from_vec(arg.to_vec()))
        .collect())
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn arguments(_pid: u32) -> std::io::Result<Vec<std::ffi::OsString>> {
    Err(std::io::Error::other("Process arguments are unsupported"))
}

pub(super) fn managed_descendants(
    pid: u32,
    runtime_root: &Path,
) -> Result<Vec<(u32, PathBuf)>, String> {
    let parents = parents().map_err(|e| format!("Could not inspect browser subprocesses: {e}"))?;
    let mut descendants = HashSet::from([pid]);
    let mut result = Vec::new();
    let root = runtime_root.canonicalize().ok();
    loop {
        let next = parents
            .iter()
            .filter(|(child, parent)| descendants.contains(parent) && !descendants.contains(child))
            .map(|(child, _)| *child)
            .collect::<Vec<_>>();
        if next.is_empty() {
            break;
        }
        for child in next {
            descendants.insert(child);
            if let Ok(path) = executable(child).and_then(|path| path.canonicalize())
                && root.as_ref().is_some_and(|root| path.starts_with(root))
            {
                result.push((child, path));
            }
        }
    }
    result.reverse();
    Ok(result)
}

#[cfg(target_os = "linux")]
fn parents() -> std::io::Result<HashMap<u32, u32>> {
    let mut result = HashMap::new();
    for entry in std::fs::read_dir("/proc")?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        if let Ok(stat) = std::fs::read_to_string(entry.path().join("stat"))
            && let Some((_, tail)) = stat.rsplit_once(')')
            && let Some(parent) = tail.split_whitespace().nth(1).and_then(|s| s.parse().ok())
        {
            result.insert(pid, parent);
        }
    }
    Ok(result)
}
#[cfg(all(unix, not(target_os = "linux")))]
fn parents() -> std::io::Result<HashMap<u32, u32>> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid="])
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other("Process inventory failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect())
}
#[cfg(windows)]
fn parents() -> std::io::Result<HashMap<u32, u32>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut result = HashMap::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) };
    while more != 0 {
        result.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        more = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    Ok(result)
}
#[cfg(not(any(unix, windows)))]
fn parents() -> std::io::Result<HashMap<u32, u32>> {
    Err(std::io::Error::other("Process inventory is unsupported"))
}
