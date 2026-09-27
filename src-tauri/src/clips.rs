// Review cards' own copies of their line: a small video, or sound plus one
// still, cut from the source video with ffmpeg (convert.rs) so a card keeps
// playing after the user deletes the episode. Files live in <own dir>/clips;
// utils/clips.ts decides what to cut and which files are still wanted.
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

fn clips_dir() -> Result<PathBuf, String> {
  Ok(crate::paths::own_dir()?.join("clips"))
}

// Names come from the frontend (`<video id>_<start>`); keep them to plain file names.
fn safe_name(name: &str) -> Result<&str, String> {
  if !name.is_empty() && name.len() <= 200 && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && !name.starts_with('.') {
    Ok(name)
  } else {
    Err(format!("bad clip name: {name}"))
  }
}

fn secs(s: f64) -> String {
  format!("{s:.3}")
}

// ffmpeg arguments for one output: "video" = a 480p mp4 with sound, "audio" = m4a,
// "image" = one jpg from the middle of the stretch.
fn args(kind: &str, src: &Path, from: f64, to: f64, out: &Path) -> Vec<String> {
  let at = if kind == "image" { from + (to - from) / 2.0 } else { from };
  let mut a: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-ss"].map(String::from).to_vec();
  a.push(secs(at));
  a.push("-i".into());
  a.push(src.to_string_lossy().into_owned());
  let tail: &[&str] = match kind {
    "video" => &["-map", "0:v:0?", "-map", "0:a:0?", "-vf", "scale=-2:'min(480,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4"],
    "audio" => &["-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-f", "mp4"],
    _ => &["-frames:v", "1", "-vf", "scale=-2:'min(480,ih)'", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg"],
  };
  if kind != "image" {
    a.push("-t".into());
    a.push(secs((to - from).max(0.1)));
  }
  a.extend(tail.iter().map(|s| s.to_string()));
  a.push(out.to_string_lossy().into_owned());
  a
}

// Cut one file unless it is already there. Written to .part first, so a file
// under its real name is always whole.
fn cut(ffmpeg: &Path, kind: &str, src: &Path, from: f64, to: f64, out: &Path) -> Result<(), String> {
  if out.is_file() {
    return Ok(());
  }
  // Its own .part name: the background queue and a pre-delete cut may cut the same line at once.
  static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
  let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  let part = out.with_extension(format!("{}.{n}.part", out.extension().and_then(|e| e.to_str()).unwrap_or("")));
  let res = crate::paths::command(ffmpeg).args(args(kind, src, from, to, &part)).output().map_err(|e| format!("ffmpeg:{e}"))?;
  if !res.status.success() || !part.is_file() {
    let _ = std::fs::remove_file(&part);
    let err = String::from_utf8_lossy(&res.stderr);
    return Err(format!("ffmpeg:{}", err.lines().last().unwrap_or("failed")));
  }
  std::fs::rename(&part, out).map_err(|e| format!("clip:{e}"))
}

#[derive(serde::Serialize)]
pub struct ClipFiles {
  file: String,
  image: Option<String>,
}

// `kind` "video" → <name>.mp4; "audio" → <name>.m4a + <name>.jpg. Downloads
// ffmpeg first when there is none (quietly: Settings shows the clip progress).
#[tauri::command]
pub async fn cut_clip(src: String, from: f64, to: f64, name: String, kind: String) -> Result<ClipFiles, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let name = safe_name(&name)?;
    let src = PathBuf::from(&src);
    if !src.is_file() {
      return Err("missing:video".into());
    }
    let dir = clips_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("clip:{e}"))?;
    let ffmpeg = crate::convert::ensure(|_| {})?;
    if kind == "video" {
      let file = format!("{name}.mp4");
      cut(&ffmpeg, "video", &src, from, to, &dir.join(&file))?;
      Ok(ClipFiles { file, image: None })
    } else {
      let (file, image) = (format!("{name}.m4a"), format!("{name}.jpg"));
      cut(&ffmpeg, "audio", &src, from, to, &dir.join(&file))?;
      // A still is a nice-to-have: sound alone still makes the card playable.
      let image = cut(&ffmpeg, "image", &src, from, to, &dir.join(&image)).ok().map(|_| image);
      Ok(ClipFiles { file, image })
    }
  })
  .await
  .map_err(|e| format!("clip:{e}"))?
}

// Files in the clips folder no card uses any more, left for an hour first so a
// clip cut a moment ago (its card not yet updated) is never taken.
fn stale(dir: &Path, keep: &[String], older_than: Duration) -> Vec<PathBuf> {
  let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
  let now = SystemTime::now();
  entries
    .flatten()
    .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
    .filter(|e| !keep.iter().any(|k| e.file_name().to_str() == Some(k.as_str())))
    .filter(|e| e.metadata().and_then(|m| m.modified()).map(|m| now.duration_since(m).unwrap_or_default() >= older_than).unwrap_or(false))
    .map(|e| e.path())
    .collect()
}

#[tauri::command]
pub fn sweep_clips(keep: Vec<String>) -> Result<u32, String> {
  let gone = stale(&clips_dir()?, &keep, Duration::from_secs(3600));
  Ok(gone.iter().filter(|p| std::fs::remove_file(p).is_ok()).count() as u32)
}

#[derive(serde::Serialize)]
pub struct ClipsInfo {
  dir: String,
  bytes: u64,
}

#[tauri::command]
pub fn clips_info() -> Result<ClipsInfo, String> {
  let dir = clips_dir()?;
  let bytes = std::fs::read_dir(&dir).map(|es| es.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0);
  Ok(ClipsInfo { dir: dir.to_string_lossy().into_owned(), bytes })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_stay_file_names() {
    assert!(safe_name("0424121f-cc22_12.50").is_ok());
    for bad in ["", "../x", "a/b", "a\\b", ".hidden", "a b"] {
      assert!(safe_name(bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn args_per_kind() {
    let src = Path::new("/v/a.mp4");
    let out = Path::new("/c/x.mp4.part");
    let v = args("video", src, 10.0, 14.5, out);
    assert_eq!(&v[4..8], &["-ss", "10.000", "-i", "/v/a.mp4"]);
    assert!(v.windows(2).any(|w| w == ["-t", "4.500"]));
    assert!(v.contains(&"libx264".to_string()) && v.last().unwrap() == "/c/x.mp4.part");
    let img = args("image", src, 10.0, 14.0, out);
    assert_eq!(img[5], "12.000"); // the middle
    assert!(!img.contains(&"-t".to_string()));
    assert!(args("audio", src, 1.0, 2.0, out).contains(&"-vn".to_string()));
  }

  #[test]
  fn sweep_keeps_used_and_fresh_files() {
    let dir = std::env::temp_dir().join(format!("clips-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for f in ["used.mp4", "gone.mp4"] {
      std::fs::write(dir.join(f), b"x").unwrap();
    }
    // Fresh files are never taken, used or not.
    assert!(stale(&dir, &["used.mp4".into()], Duration::from_secs(3600)).is_empty());
    let old = stale(&dir, &["used.mp4".into()], Duration::ZERO);
    assert_eq!(old, vec![dir.join("gone.mp4")]);
    std::fs::remove_dir_all(&dir).unwrap();
  }

  // Real cut with a real ffmpeg on the sample video; skipped when either is missing.
  #[test]
  fn cuts_sample() {
    let home = crate::paths::home_dir().unwrap();
    let src = home.join("Movies/LinguaClip/Me at the zoo [jNQXAC9IVRw].mp4");
    let Some(ffmpeg) = crate::convert::find() else { return };
    if !src.is_file() {
      return;
    }
    let dir = std::env::temp_dir().join(format!("clips-cut-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (kind, file) in [("video", "a.mp4"), ("audio", "a.m4a"), ("image", "a.jpg")] {
      cut(&ffmpeg, kind, &src, 2.0, 5.0, &dir.join(file)).unwrap();
      assert!(std::fs::metadata(dir.join(file)).unwrap().len() > 1000, "{kind}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
