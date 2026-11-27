// Background self-update of our own yt-dlp (docs/youtube.md「自动更新 yt-dlp」). Never
// touches a hand-installed one. Imports must never wait for it: see maybe_update.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::TryLockError;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::yt_tools::{own_yt_dlp_in, tool_dir, yt_dlp_lock, YT_DLP_EXE, YT_DLP_LOCK};

const LAST_UPDATE_FILE: &str = "last_update";
const UPDATE_INTERVAL_SECS: u64 = 3 * 24 * 60 * 60;
const UPDATE_TIMEOUT: Duration = Duration::from_secs(60);

fn now_unix_secs() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn needs_update(dir: &Path, now: u64) -> bool {
  let last = std::fs::read_to_string(dir.join(LAST_UPDATE_FILE))
    .ok()
    .and_then(|s| s.trim().parse::<u64>().ok())
    .unwrap_or(0);
  now.saturating_sub(last) > UPDATE_INTERVAL_SECS
}

fn write_last_update(dir: &Path, now: u64) {
  if let Err(e) = std::fs::write(dir.join(LAST_UPDATE_FILE), now.to_string()) {
    log::error!("write yt-dlp {LAST_UPDATE_FILE}: {e}");
  }
}

fn kill_child(child: &mut std::process::Child) {
  #[cfg(all(unix, not(target_os = "android")))]
  {
    let _ = std::process::Command::new("/bin/kill").args(["-KILL", "--", &format!("-{}", child.id())]).status();
  }
  let _ = child.kill();
}

// Background self-update for our own yt-dlp (never touches a hand-installed one), at most
// every 3 days. The slow part (-U downloading ~37MB) runs on a copy in update/, holding no
// lock, so imports never wait for it; only the final rename takes the write lock, and only
// if no yt-dlp is running right then (otherwise the next window opening tries again).
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn maybe_update() {
  let dir = tool_dir();
  if own_yt_dlp_in(&dir).is_none() || !needs_update(&dir, now_unix_secs()) {
    return;
  }
  static UPDATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
  if UPDATING.swap(true, std::sync::atomic::Ordering::SeqCst) {
    return;
  }
  std::thread::spawn(move || {
    let staged = dir.join("update");
    match update_copy(&dir, &staged) {
      Ok(Some(new)) => match swap_in(&dir, &new) {
        Ok(true) => {
          log::info!("yt-dlp updated");
          write_last_update(&dir, now_unix_secs());
        }
        Ok(false) => log::info!("yt-dlp busy; update swap left for next time"),
        Err(e) => log::error!("yt-dlp update swap: {e}"),
      },
      Ok(None) => write_last_update(&dir, now_unix_secs()),
      Err(e) => {
        log::warn!("yt-dlp -U: {e}");
        write_last_update(&dir, now_unix_secs());
      }
    }
    let _ = std::fs::remove_dir_all(&staged);
    UPDATING.store(false, std::sync::atomic::Ordering::SeqCst);
  });
}

// Copies our yt-dlp into `staged` and runs -U on the copy. Some(path) when it changed.
fn update_copy(dir: &Path, staged: &Path) -> Result<Option<PathBuf>, String> {
  let exe = own_yt_dlp_in(dir).ok_or("yt-dlp missing")?;
  let _ = std::fs::remove_dir_all(staged);
  std::fs::create_dir_all(staged).map_err(|e| e.to_string())?;
  let copy = staged.join(YT_DLP_EXE);
  {
    // Copying while an import runs it is fine; only replacing it is not.
    let _read = yt_dlp_lock();
    std::fs::copy(&exe, &copy).map_err(|e| e.to_string())?;
  }
  let before = std::fs::read(&copy).map_err(|e| e.to_string())?;
  let mut cmd = crate::paths::command(&copy);
  cmd.arg("-U").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
  #[cfg(unix)]
  std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
  let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
  let err_reader = child.stderr.take().map(|mut err| {
    std::thread::spawn(move || {
      let mut s = String::new();
      let _ = err.read_to_string(&mut s);
      s
    })
  });
  let deadline = Instant::now() + UPDATE_TIMEOUT;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() >= deadline => {
        kill_child(&mut child);
        let _ = child.wait();
        return Err(format!("timed out after {}s", UPDATE_TIMEOUT.as_secs()));
      }
      Ok(None) => std::thread::sleep(Duration::from_millis(200)),
      Err(e) => return Err(e.to_string()),
    }
  };
  let stderr = err_reader.and_then(|h| h.join().ok()).unwrap_or_default();
  if !status.success() {
    return Err(format!("exited {status}: {}", crate::import::tail_chars(stderr.trim(), 200)));
  }
  match std::fs::read(&copy) {
    Ok(after) if after != before && !after.is_empty() => Ok(Some(copy)),
    _ => Ok(None),
  }
}

// Puts the updated copy in place, unless a yt-dlp run holds the lock. Ok(false) = busy.
fn swap_in(dir: &Path, new: &Path) -> Result<bool, String> {
  let _write = match YT_DLP_LOCK.try_write() {
    Ok(g) => g,
    Err(TryLockError::Poisoned(p)) => p.into_inner(),
    Err(TryLockError::WouldBlock) => return Ok(false),
  };
  let exe = dir.join(YT_DLP_EXE);
  let old = dir.join(format!("{YT_DLP_EXE}.old"));
  let _ = std::fs::remove_file(&old);
  std::fs::rename(&exe, &old).map_err(|e| e.to_string())?;
  if let Err(e) = std::fs::rename(new, &exe) {
    let _ = std::fs::rename(&old, &exe);
    return Err(e.to_string());
  }
  let _ = std::fs::remove_file(&old);
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn update_swaps_in_only_when_no_yt_dlp_runs() {
    let _serial = crate::yt_tools::LOCK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("lc-yt-swap-{}", uuid::Uuid::new_v4()));
    let staged = dir.join("update");
    std::fs::create_dir_all(&staged).unwrap();
    let exe = dir.join(YT_DLP_EXE);
    let new = staged.join(YT_DLP_EXE);
    std::fs::write(&exe, b"old").unwrap();
    std::fs::write(&new, b"new").unwrap();
    {
      let _running = yt_dlp_lock();
      assert_eq!(swap_in(&dir, &new), Ok(false));
      assert_eq!(std::fs::read(&exe).unwrap(), b"old");
    }
    assert_eq!(swap_in(&dir, &new), Ok(true));
    assert_eq!(std::fs::read(&exe).unwrap(), b"new");
    assert!(!dir.join(format!("{YT_DLP_EXE}.old")).exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn update_interval_checks_three_day_window() {
    let dir = std::env::temp_dir().join(format!("lc-yt-upd-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let now = 1_700_000_000u64;
    assert!(needs_update(&dir, now));
    write_last_update(&dir, now - UPDATE_INTERVAL_SECS);
    assert!(!needs_update(&dir, now));
    write_last_update(&dir, now - UPDATE_INTERVAL_SECS - 1);
    assert!(needs_update(&dir, now));
    std::fs::write(dir.join(LAST_UPDATE_FILE), "not-a-number").unwrap();
    assert!(needs_update(&dir, now));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
