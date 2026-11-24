// Where our files live and how helper programs are started, per OS.
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;
#[cfg(target_os = "android")]
use std::sync::OnceLock;

#[cfg(target_os = "android")]
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

#[cfg(target_os = "android")]
pub fn init_data_dir(dir: PathBuf) {
  let _ = DATA_DIR.set(dir);
}

#[cfg(not(target_os = "android"))]
pub fn home_dir() -> Result<PathBuf, String> {
  let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
  std::env::var_os(var)
    .map(PathBuf::from)
    .ok_or_else(|| "missing:HOME".to_string())
}

#[cfg(target_os = "android")]
pub fn home_dir() -> Result<PathBuf, String> {
  own_dir()
}

// ~/Movies/LinguaClip on macOS, ~/Videos/LinguaClip on Windows, app_local_data_dir on Android:
// downloads, generated .srt files and caches. `ownDir` in utils/desktop.ts must agree.
#[cfg(not(target_os = "android"))]
pub fn own_dir() -> Result<PathBuf, String> {
  let videos = if cfg!(windows) { "Videos" } else { "Movies" };
  Ok(home_dir()?.join(videos).join("LinguaClip"))
}

#[cfg(target_os = "android")]
pub fn own_dir() -> Result<PathBuf, String> {
  DATA_DIR.get().cloned().ok_or_else(|| "missing:data_dir".to_string())
}

// Every helper program goes through here so that on Windows it does not flash
// a console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
  #[allow(unused_mut)]
  let mut cmd = Command::new(program);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  }
  cmd
}
