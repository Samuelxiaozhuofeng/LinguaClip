// YouTube downloader parts (yt-dlp + deno JS runtime, plus ffmpeg from convert.rs):
// downloaded on first use into <app data>/youtube/ when not already installed by
// the user. Keeping it fresh is yt_update.rs.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock, RwLockReadGuard};

use tauri::{AppHandle, Emitter};

use crate::whisper_setup::{fetch, parts_dir, Asset};

// yt-dlp 2026.11.23 (official GitHub release).
#[cfg(target_os = "macos")]
const YT_DLP: Asset = Asset {
  name: "yt-dlp_macos",
  size: 37_478_576,
  sha256: "57654854886d0398a798895aadf5173e2749fbb5e249b9f3728022ab376e11fb",
  urls: &["https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp_macos"],
};
#[cfg(windows)]
const YT_DLP: Asset = Asset {
  name: "yt-dlp.exe",
  size: 23_627_865,
  sha256: "622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c",
  urls: &["https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp.exe"],
};
#[cfg(not(any(target_os = "macos", windows)))]
const YT_DLP: Asset = Asset { name: "", size: 0, sha256: "", urls: &[] };

// deno v2.9.8 (official GitHub release): JS runtime yt-dlp needs for YouTube challenges.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const DENO: Asset = Asset {
  name: "deno-aarch64-apple-darwin.zip",
  size: 38_770_795,
  sha256: "9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e",
  urls: &["https://github.com/denoland/deno/releases/download/v2.9.8/deno-aarch64-apple-darwin.zip"],
};
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const DENO: Asset = Asset {
  name: "deno-x86_64-apple-darwin.zip",
  size: 42_797_031,
  sha256: "4b2f5edd2639b7470f034238b321d7002d8dfb4726d8558f52c17afac370eb2c",
  urls: &["https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-apple-darwin.zip"],
};
#[cfg(windows)]
const DENO: Asset = Asset {
  name: "deno-x86_64-pc-windows-msvc.zip",
  size: 42_917_472,
  sha256: "cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf",
  urls: &["https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-pc-windows-msvc.zip"],
};
#[cfg(not(any(all(target_os = "macos", any(target_arch = "aarch64", target_arch = "x86_64")), windows)))]
const DENO: Asset = Asset { name: "", size: 0, sha256: "", urls: &[] };

pub(crate) const YT_DLP_EXE: &str = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
const DENO_EXE: &str = if cfg!(windows) { "deno.exe" } else { "deno" };
const EVENT: &str = "youtube-tool-progress";

// Prevents concurrent downloads (e.g. YouTube window button + add-video dialog).
static INSTALLING: Mutex<()> = Mutex::new(());
// Running yt-dlp holds a read lock; background self-update takes try_write so
// an import never waits for an update and an update never overwrites a live binary.
pub(crate) static YT_DLP_LOCK: RwLock<()> = RwLock::new(());
// Tests that take YT_DLP_LOCK run one at a time.
#[cfg(test)]
pub(crate) static LOCK_TESTS: Mutex<()> = Mutex::new(());

pub(crate) fn tool_dir() -> PathBuf {
  parts_dir().with_file_name("youtube")
}

// Restores <name>.old if a previous self-update failed mid-replace.
pub(crate) fn own_yt_dlp_in(dir: &Path) -> Option<PathBuf> {
  let exe = dir.join(YT_DLP_EXE);
  if exe.is_file() {
    return Some(exe);
  }
  let old = dir.join(format!("{YT_DLP_EXE}.old"));
  if old.is_file() {
    if let Err(e) = std::fs::rename(&old, &exe) {
      log::error!("restore {YT_DLP_EXE}.old: {e}");
      return None;
    }
    if exe.is_file() {
      return Some(exe);
    }
  }
  None
}

// Ours first, then a hand-installed yt-dlp.
pub(crate) fn find_yt_dlp() -> Option<PathBuf> {
  own_yt_dlp_in(&tool_dir()).or_else(|| crate::import::find_bin("yt-dlp").ok())
}

fn find_js_runtime_in(dir: &Path) -> Option<(&'static str, PathBuf)> {
  let own = dir.join(DENO_EXE);
  if own.is_file() {
    return Some(("deno", own));
  }
  if let Ok(deno) = crate::import::find_bin("deno") {
    return Some(("deno", deno));
  }
  crate::import::find_bin("node").ok().map(|node| ("node", node))
}

fn format_js_runtime_args(found: Option<(&'static str, PathBuf)>) -> Vec<String> {
  match found {
    Some((kind, path)) => vec!["--js-runtimes".into(), format!("{kind}:{}", path.to_string_lossy())],
    None => Vec::new(),
  }
}

// Ours deno -> hand-installed deno -> hand-installed node -> none.
pub(crate) fn js_runtime_args() -> Vec<String> {
  format_js_runtime_args(find_js_runtime_in(&tool_dir()))
}

#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn ready() -> bool {
  find_yt_dlp().is_some() && find_js_runtime_in(&tool_dir()).is_some() && crate::convert::find().is_some()
}

#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn missing_bytes() -> u64 {
  let mut total = 0u64;
  if find_yt_dlp().is_none() {
    total = total.saturating_add(YT_DLP.size);
  }
  if find_js_runtime_in(&tool_dir()).is_none() {
    total = total.saturating_add(DENO.size);
  }
  if crate::convert::find().is_none() {
    total = total.saturating_add(crate::convert::download_bytes());
  }
  total
}

fn yt_err(err: String) -> String {
  if err.starts_with("ytSetup:") {
    err
  } else if let Some(rest) = err.strip_prefix("setup:").or_else(|| err.strip_prefix("convertSetup:")) {
    format!("ytSetup:{rest}")
  } else {
    format!("ytSetup:{err}")
  }
}

#[cfg(unix)]
fn prepare_executable(path: &Path) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;
  std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("ytSetup:{e}"))?;
  #[cfg(target_os = "macos")]
  {
    let _ = crate::paths::command("/usr/bin/xattr").args(["-d", "com.apple.quarantine"]).arg(path).output();
  }
  Ok(())
}

#[cfg(not(unix))]
fn prepare_executable(_path: &Path) -> Result<(), String> {
  Ok(())
}

struct ProgressTracker<F: FnMut(u32)> {
  total: u64,
  shown: Option<u32>,
  on_pct: F,
}

impl<F: FnMut(u32)> ProgressTracker<F> {
  fn new(total: u64, on_pct: F) -> Self {
    Self { total: total.max(1), shown: None, on_pct }
  }

  fn report(&mut self, done_bytes: u64) {
    let pct = (done_bytes.saturating_mul(100) / self.total).min(99) as u32;
    let advance = match self.shown {
      None => true,
      Some(prev) => pct > prev,
    };
    if advance {
      self.shown = Some(pct);
      (self.on_pct)(pct);
    }
  }
}

fn download_yt_dlp(dir: &Path, mut on_bytes: impl FnMut(u64)) -> Result<PathBuf, String> {
  if YT_DLP.urls.is_empty() {
    return Err("ytSetup:unsupported".into());
  }
  std::fs::create_dir_all(dir).map_err(|e| format!("ytSetup:{e}"))?;
  tauri::async_runtime::block_on(fetch(&YT_DLP, dir, |got| on_bytes(got.min(YT_DLP.size)))).map_err(yt_err)?;
  let fetched = dir.join(YT_DLP.name);
  prepare_executable(&fetched)?;
  let target = dir.join(YT_DLP_EXE);
  if fetched != target {
    std::fs::rename(&fetched, &target).map_err(|e| format!("ytSetup:{e}"))?;
  }
  Ok(target)
}

fn download_deno(dir: &Path, mut on_bytes: impl FnMut(u64)) -> Result<PathBuf, String> {
  if DENO.urls.is_empty() {
    return Err("ytSetup:unsupported".into());
  }
  let unpack = dir.join(".unpack-deno");
  std::fs::create_dir_all(&unpack).map_err(|e| format!("ytSetup:{e}"))?;
  // Clear a half-unpacked binary from an interrupted run while keeping any .part to resume.
  let unpacked = unpack.join(DENO_EXE);
  let _ = std::fs::remove_file(&unpacked);
  tauri::async_runtime::block_on(fetch(&DENO, &unpack, |got| on_bytes(got.min(DENO.size)))).map_err(yt_err)?;
  if !unpacked.is_file() {
    return Err("ytSetup:deno missing after unpack".into());
  }
  prepare_executable(&unpacked)?;
  let target = dir.join(DENO_EXE);
  std::fs::rename(&unpacked, &target).map_err(|e| format!("ytSetup:{e}"))?;
  let _ = std::fs::remove_dir_all(&unpack);
  Ok(target)
}

fn ensure_missing_in(dir: &Path, need_yt: bool, need_js: bool, need_ffmpeg: bool, on_pct: impl FnMut(u32)) -> Result<(), String> {
  if !need_yt && !need_js && !need_ffmpeg {
    return Ok(());
  }
  if (need_yt && YT_DLP.urls.is_empty()) || (need_js && DENO.urls.is_empty()) {
    return Err("ytSetup:unsupported".into());
  }
  let ffmpeg_bytes = if need_ffmpeg { crate::convert::download_bytes() } else { 0 };
  let total = (if need_yt { YT_DLP.size } else { 0 })
    .saturating_add(if need_js { DENO.size } else { 0 })
    .saturating_add(ffmpeg_bytes);
  let mut progress = ProgressTracker::new(total, on_pct);
  let mut before = 0u64;
  if need_yt {
    download_yt_dlp(dir, |got| progress.report(before.saturating_add(got)))?;
    before = before.saturating_add(YT_DLP.size);
  }
  if need_js {
    download_deno(dir, |got| progress.report(before.saturating_add(got)))?;
    before = before.saturating_add(DENO.size);
  }
  if need_ffmpeg {
    crate::convert::ensure(|fpct| {
      progress.report(before.saturating_add(ffmpeg_bytes.saturating_mul(u64::from(fpct)) / 100));
    })
    .map_err(yt_err)?;
  }
  Ok(())
}

// Downloads whichever YouTube parts are missing (yt-dlp, deno, ffmpeg).
// `on_pct` reports monotonic overall progress capped at 99, and is not called when ready.
pub(crate) fn ensure(on_pct: impl FnMut(u32)) -> Result<(), String> {
  let _guard = INSTALLING.lock().unwrap_or_else(|e| e.into_inner());
  let dir = tool_dir();
  let need_yt = find_yt_dlp().is_none();
  let need_js = find_js_runtime_in(&dir).is_none();
  let need_ffmpeg = crate::convert::find().is_none();
  ensure_missing_in(&dir, need_yt, need_js, need_ffmpeg, on_pct)?;
  if !ready() {
    return Err("ytSetup:tools still missing after download".into());
  }
  Ok(())
}

pub(crate) fn yt_dlp_lock() -> RwLockReadGuard<'static, ()> {
  YT_DLP_LOCK.read().unwrap_or_else(|e| e.into_inner())
}

#[derive(serde::Serialize)]
pub struct YoutubeTool {
  ready: bool,
  path: Option<String>,
  dir: String,
  bytes: u64,
}

#[tauri::command]
pub fn youtube_tool_status() -> YoutubeTool {
  let path = find_yt_dlp();
  let ready = path.is_some() && find_js_runtime_in(&tool_dir()).is_some() && crate::convert::find().is_some();
  YoutubeTool {
    ready,
    path: path.map(|p| p.to_string_lossy().into_owned()),
    dir: tool_dir().to_string_lossy().into_owned(),
    bytes: if ready { 0 } else { missing_bytes() },
  }
}

#[tauri::command]
pub async fn install_youtube_tool(app: AppHandle) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || ensure(|pct| { let _ = app.emit(EVENT, pct); }))
    .await
    .map_err(|e| format!("ytSetup:{e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn restores_old_yt_dlp_when_main_is_missing() {
    let dir = std::env::temp_dir().join(format!("lc-yt-old-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let old = dir.join(format!("{YT_DLP_EXE}.old"));
    let exe = dir.join(YT_DLP_EXE);
    std::fs::write(&old, b"backup").unwrap();
    assert_eq!(own_yt_dlp_in(&dir), Some(exe.clone()));
    assert!(exe.is_file() && !old.exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn progress_tracker_is_monotonic_and_caps_at_99() {
    let mut seen = Vec::new();
    let mut t = ProgressTracker::new(200, |p| seen.push(p));
    for b in [0, 50, 40, 100, 100, 200, 250] {
      t.report(b);
    }
    assert_eq!(seen, vec![0, 25, 50, 99]);
  }

  #[test]
  fn yt_err_normalizes_prefixes() {
    assert_eq!(yt_err("setup:no response".into()), "ytSetup:no response");
    assert_eq!(yt_err("convertSetup:HTTP 500".into()), "ytSetup:HTTP 500");
    assert_eq!(yt_err("ytSetup:unsupported".into()), "ytSetup:unsupported");
    assert_eq!(yt_err("io error".into()), "ytSetup:io error");
  }

  #[test]
  fn js_runtime_args_formats_deno_node_and_empty() {
    assert_eq!(format_js_runtime_args(Some(("deno", PathBuf::from("/tmp/deno")))), vec!["--js-runtimes", "deno:/tmp/deno"]);
    assert_eq!(format_js_runtime_args(Some(("node", PathBuf::from("/usr/local/bin/node")))), vec!["--js-runtimes", "node:/usr/local/bin/node"]);
    assert!(format_js_runtime_args(None).is_empty());
  }

  #[test]
  fn read_lock_blocks_try_write_until_dropped() {
    let _serial = LOCK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    let guard = yt_dlp_lock();
    assert!(matches!(YT_DLP_LOCK.try_write(), Err(std::sync::TryLockError::WouldBlock)));
    drop(guard);
    assert!(YT_DLP_LOCK.try_write().is_ok());
  }

  // Real network: downloads yt-dlp and deno into an isolated temp directory,
  // verifies sha256/unpack/permissions, and runs `--version` on both.
  // cargo test --manifest-path src-tauri/Cargo.toml -- --ignored downloads_youtube_tools --nocapture
  #[test]
  #[ignore]
  fn downloads_youtube_tools() {
    let dir = std::env::temp_dir().join(format!("lc-yt-tools-{}", uuid::Uuid::new_v4()));
    let mut pcts = Vec::new();
    ensure_missing_in(&dir, true, true, false, |p| {
      pcts.push(p);
      print!("{p} ");
    })
    .unwrap();
    println!();
    assert!(!pcts.is_empty() && pcts.windows(2).all(|w| w[1] > w[0]) && *pcts.last().unwrap() <= 99);
    assert!(!dir.join(".unpack-deno").exists(), "temp unpack dir must be cleaned up");
    let (yt, deno) = (dir.join(YT_DLP_EXE), dir.join(DENO_EXE));
    assert!(yt.is_file() && deno.is_file());
    let yt_out = crate::paths::command(&yt).arg("--version").output().unwrap();
    println!("yt-dlp: {}", String::from_utf8_lossy(&yt_out.stdout).trim());
    assert!(yt_out.status.success(), "yt-dlp --version failed: {}", String::from_utf8_lossy(&yt_out.stderr));
    let deno_out = crate::paths::command(&deno).arg("--version").output().unwrap();
    println!("deno: {}", String::from_utf8_lossy(&deno_out.stdout).lines().next().unwrap_or(""));
    assert!(deno_out.status.success(), "deno --version failed: {}", String::from_utf8_lossy(&deno_out.stderr));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
