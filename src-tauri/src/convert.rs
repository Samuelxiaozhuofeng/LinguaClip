// Video conversion. The system player only opens mp4/mov/m4v, so anything else
// (mkv, avi, webm…) or an mp4 whose sound it cannot read becomes a fresh mp4 in
// our own folder. The tool, ffmpeg, is downloaded on first use, never bundled;
// a Homebrew ffmpeg is used when there is one. It can also pull a text subtitle
// track out of the video as .srt.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::whisper_setup::{fetch, parts_dir, Asset};

// macOS builds from ffmpeg.martin-riedl.de: a single binary linking only system
// frameworks. Windows: gyan.dev's "essentials" build, of which we keep ffmpeg.exe.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const FFMPEG: Asset = Asset {
  name: "ffmpeg-9.0.2-arm64.zip",
  size: 28_395_699,
  sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
  urls: &["https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip"],
};
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const FFMPEG: Asset = Asset {
  name: "ffmpeg-9.0.2-x86_64.zip",
  size: 33_816_391,
  sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
  urls: &["https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip"],
};
#[cfg(windows)]
const FFMPEG: Asset = Asset {
  name: "ffmpeg-8.0.1-essentials_build.zip",
  size: 106_259_850,
  sha256: "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673",
  urls: &["https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip"],
};
// Where the zip keeps it; moved up to tool_dir()/ffmpeg(.exe) after unpacking.
#[cfg(windows)]
const IN_ZIP: &str = "ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe";
#[cfg(not(windows))]
const IN_ZIP: &str = "ffmpeg";

const EVENT: &str = "convert-tool-progress";

// Settings and an import (or two imports) must not write the same files.
static INSTALLING: Mutex<()> = Mutex::new(());

fn tool_dir() -> PathBuf {
  parts_dir().with_file_name("convert")
}

fn own_exe() -> PathBuf {
  tool_dir().join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX))
}

// Ours first, then a hand-installed one.
pub(crate) fn find() -> Option<PathBuf> {
  let own = own_exe();
  if own.is_file() {
    return Some(own);
  }
  crate::import::find_bin("ffmpeg").ok()
}

// Returns ffmpeg, downloading it first when there is none. `on_pct` is not
// called at all when nothing needs downloading. A failed download says
// "convertSetup:", so the user is not told the transcription parts failed.
pub(crate) fn ensure(on_pct: impl FnMut(u32)) -> Result<PathBuf, String> {
  let _guard = INSTALLING.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(found) = find() {
    return Ok(found);
  }
  download(&tool_dir(), on_pct).map_err(|e| match e.strip_prefix("setup:") {
    Some(rest) => format!("convertSetup:{rest}"),
    None => e,
  })
}

fn download(dir: &Path, mut on_pct: impl FnMut(u32)) -> Result<PathBuf, String> {
  std::fs::create_dir_all(dir).map_err(|e| format!("setup:{e}"))?;
  let mut last = None;
  tauri::async_runtime::block_on(fetch(&FFMPEG, dir, |got| {
    let pct = (got * 100 / FFMPEG.size.max(1)).min(99) as u32;
    if last != Some(pct) {
      last = Some(pct);
      on_pct(pct);
    }
  }))?;
  let unpacked = dir.join(IN_ZIP);
  let exe = dir.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX));
  if unpacked != exe {
    std::fs::rename(&unpacked, &exe).map_err(|e| format!("setup:{e}"))?;
    // The rest of the zip (ffplay, ffprobe, docs) is 200MB we never use.
    if let Some(top) = Path::new(IN_ZIP).components().next() {
      let _ = std::fs::remove_dir_all(dir.join(top));
    }
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("setup:{e}"))?;
  }
  Ok(exe)
}

#[derive(serde::Serialize)]
pub struct ConvertTool {
  // The ffmpeg in use, wherever it was found; None = not downloaded yet.
  path: Option<String>,
  // Where we download it to (may not exist yet).
  dir: String,
  bytes: u64,
}

#[tauri::command]
pub fn convert_tool_status() -> ConvertTool {
  ConvertTool {
    path: find().map(|p| p.to_string_lossy().into_owned()),
    dir: tool_dir().to_string_lossy().into_owned(),
    bytes: FFMPEG.size,
  }
}

// Emits convert-tool-progress with the percent while it downloads.
#[tauri::command]
pub async fn install_convert_tool(app: AppHandle) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || ensure(|pct| { let _ = app.emit(EVENT, pct); }).map(|_| ()))
    .await
    .map_err(|e| format!("setup:{e}"))?
}

// What the player opens as is. Anything else is converted.
pub(crate) fn plays_natively(path: &Path) -> bool {
  let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
  matches!(ext.as_str(), "mp4" | "mov" | "m4v")
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct SubTrack {
  // Among the subtitle tracks only: ffmpeg's 0:s:N.
  index: u32,
  lang: Option<String>,
  title: Option<String>,
  codec: String,
  // Picture subtitles (Blu-ray, DVD) have no text to read.
  text: bool,
}

#[derive(serde::Serialize, Debug, Default, PartialEq)]
pub struct Probe {
  duration: Option<f64>,
  video: Option<String>,
  audio: Option<String>,
  subtitles: Vec<SubTrack>,
  // ffmpeg's index of the real picture (cover art can come first).
  #[serde(skip)]
  video_stream: Option<u32>,
  // Copying the picture as is would not play (10-bit H.264, VP9…).
  #[serde(skip)]
  reencode_video: bool,
  #[serde(skip)]
  hevc: bool,
  #[serde(skip)]
  copy_audio: bool,
}

const TEXT_SUBS: &[&str] = &["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"];

fn parse_duration(line: &str) -> Option<f64> {
  let rest = line.trim().strip_prefix("Duration: ")?;
  let hms = rest.split(',').next()?;
  let mut total = 0.0;
  for part in hms.split(':') {
    total = total * 60.0 + part.trim().parse::<f64>().ok()?;
  }
  Some(total)
}

// Reads what `ffmpeg -i` prints about the input (stderr).
fn parse_probe(text: &str) -> Probe {
  let mut probe = Probe::default();
  let mut in_sub = false;
  for line in text.lines() {
    let trimmed = line.trim();
    if let Some(d) = parse_duration(trimmed) {
      probe.duration.get_or_insert(d);
      continue;
    }
    if let Some(rest) = trimmed.strip_prefix("Stream #") {
      in_sub = false;
      let Some((head, body)) = rest.split_once(": ") else { continue };
      let lang = head.split_once('(').and_then(|(_, l)| l.split_once(')')).map(|(l, _)| l.to_string()).filter(|l| l != "und");
      let codec_of = |kind: &str| body.strip_prefix(kind).map(|r| r.split([' ', ',']).next().unwrap_or("").to_string());
      if let Some(codec) = codec_of("Video: ") {
        // Cover art is a "video" stream too; the first real one wins.
        if probe.video.is_some() || body.contains("attached pic") {
          continue;
        }
        let eight_bit = ["yuv420p,", "yuv420p(", "yuvj420p,", "yuvj420p("].iter().any(|p| body.contains(p));
        probe.video_stream = head.split(':').nth(1).and_then(|n| n.split(['[', '(']).next()).and_then(|n| n.parse().ok());
        probe.hevc = codec == "hevc";
        // Windows' player cannot count on HEVC; there it becomes H.264 too.
        probe.reencode_video = !((codec == "h264" && eight_bit) || (probe.hevc && cfg!(target_os = "macos")));
        probe.video = Some(codec);
      } else if let Some(codec) = codec_of("Audio: ") {
        if probe.audio.is_none() {
          probe.copy_audio = codec == "aac";
          probe.audio = Some(codec);
        }
      } else if let Some(codec) = codec_of("Subtitle: ") {
        let index = probe.subtitles.len() as u32;
        let text = TEXT_SUBS.contains(&codec.as_str());
        probe.subtitles.push(SubTrack { index, lang, title: None, codec, text });
        in_sub = true;
      }
      continue;
    }
    if in_sub {
      if let Some(v) = trimmed.strip_prefix("title").and_then(|r| r.trim_start().strip_prefix(':')) {
        if let Some(last) = probe.subtitles.last_mut() {
          last.title = Some(v.trim().to_string()).filter(|t| !t.is_empty());
        }
      }
    }
  }
  probe
}

fn probe_with(ffmpeg: &Path, video: &Path) -> Result<Probe, String> {
  // No output file: ffmpeg describes the input, then exits with an error.
  let out = crate::paths::command(ffmpeg).arg("-hide_banner").arg("-i").arg(video).output().map_err(|e| e.to_string())?;
  let probe = parse_probe(&String::from_utf8_lossy(&out.stderr));
  if probe.video.is_none() && probe.audio.is_none() {
    return Err(crate::import::tail_chars(&String::from_utf8_lossy(&out.stderr), 300));
  }
  Ok(probe)
}

// The add-video dialog: which subtitle tracks the video carries. Needs ffmpeg.
#[tauri::command]
pub async fn probe_video(path: String) -> Result<Probe, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let ffmpeg = find().ok_or_else(|| "missing:ffmpeg".to_string())?;
    probe_with(&ffmpeg, Path::new(&path))
  })
  .await
  .map_err(|e| e.to_string())?
}

// <dir>/<stem>.mp4, or "<stem> (2).mp4"… when that name is taken, counting the
// .srt a subtitle track would be written to (an earlier import's may sit there).
fn free_name(dir: &Path, stem: &std::ffi::OsStr) -> PathBuf {
  (1..)
    .map(|n| {
      let mut name = stem.to_os_string();
      if n > 1 {
        name.push(format!(" ({n})"));
      }
      name.push(".mp4");
      dir.join(name)
    })
    .find(|p| !p.exists() && !p.with_extension("mp4.part").exists() && !p.with_extension("srt").exists())
    .unwrap()
}

// Some line in the .srt besides cue numbers, timings and blanks.
fn has_cue_text(srt: &str) -> bool {
  srt.lines().map(str::trim).any(|l| !l.is_empty() && !l.contains("-->") && !l.chars().all(|c| c.is_ascii_digit()))
}

fn out_time_secs(line: &str) -> Option<f64> {
  let us: f64 = line.strip_prefix("out_time_us=")?.trim().parse().ok()?;
  Some(us / 1_000_000.0)
}

// Converts `video` to an mp4 in `dir` and, when asked, pulls subtitle track
// `subs` out to <new stem>.srt next to it. Returns (mp4, srt text).
pub(crate) fn convert(
  ffmpeg: &Path,
  video: &Path,
  dir: &Path,
  subs: Option<u32>,
  mut on_pct: impl FnMut(u32),
) -> Result<(PathBuf, Option<String>), String> {
  let probe = probe_with(ffmpeg, video).map_err(|e| format!("convert:{e}"))?;
  let stem = video.file_stem().ok_or_else(|| "convert:bad path".to_string())?;
  let out = free_name(dir, stem);
  // Written under a temporary name: quitting halfway never leaves a broken .mp4.
  let part = out.with_extension("mp4.part");
  let srt = out.with_extension("srt");
  let mut cmd = crate::paths::command(ffmpeg);
  cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-i"]).arg(video);
  let picture = probe.video_stream.map_or("0:v:0?".to_string(), |n| format!("0:{n}"));
  cmd.args(["-map", &picture, "-map", "0:a:0?", "-sn", "-dn"]);
  if probe.reencode_video {
    // Even sizes and 8-bit 4:2:0: what every player's H.264 decoder takes.
    cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]);
  } else {
    cmd.args(["-c:v", "copy"]);
    if probe.hevc {
      cmd.args(["-tag:v", "hvc1"]);
    }
  }
  if probe.copy_audio {
    cmd.args(["-c:a", "copy"]);
  } else {
    cmd.args(["-c:a", "aac", "-b:a", "192k"]);
  }
  cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(&part);
  if let Some(n) = subs {
    cmd.args(["-map", &format!("0:s:{n}"), "-c:s", "srt", "-f", "srt"]).arg(&srt);
  }
  let total = probe.duration.unwrap_or(0.0);
  let mut last = None;
  let run = crate::import::run_streaming(cmd, |line| {
    if let (Some(t), true) = (out_time_secs(line), total > 0.0) {
      let pct = ((t / total) * 100.0).clamp(0.0, 99.0) as u32;
      if last != Some(pct) {
        last = Some(pct);
        on_pct(pct);
      }
    }
  });
  let failed = match run {
    Ok((0, _)) if part.is_file() => None,
    Ok((_, err)) => Some(err),
    Err(e) => Some(e),
  };
  let clean_up = || {
    let _ = std::fs::remove_file(&part);
    // Only ever ours: free_name picked a name with no .srt beside it.
    if subs.is_some() {
      let _ = std::fs::remove_file(&srt);
    }
  };
  if let Some(err) = failed {
    clean_up();
    return Err(format!("convert:{err}"));
  }
  let text = match subs {
    Some(_) => match std::fs::read_to_string(&srt) {
      // A track with nothing to say (signs-only, empty) must not pass for subtitles.
      Ok(t) if has_cue_text(&t) => Some(t),
      Ok(_) => {
        clean_up();
        return Err("convert:nosubs".into());
      }
      Err(e) => {
        clean_up();
        return Err(format!("convert:subtitles {e}"));
      }
    },
    None => None,
  };
  std::fs::rename(&part, &out).map_err(|e| format!("convert:{e}"))?;
  Ok((out, text))
}

#[cfg(test)]
mod tests {
  use super::*;

  // Real `ffmpeg -i` output (9.0, an mkv with two text tracks and a PGS one).
  const MKV: &str = "Input #0, matroska,webm, from 'a.mkv':
  Duration: 00:01:18.96, start: 0.000000, bitrate: 329 kb/s
  Stream #0:0: Video: h264 (High 10), yuv420p10le(tv, bt709, progressive), 1920x1080, 23.98 fps (default)
  Stream #0:1(jpn): Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s (default)
  Stream #0:2(eng): Subtitle: subrip (srt) (default)
    Metadata:
      ENCODER         : Lavc63.1.102 srt
  Stream #0:3[0x4](jpn): Subtitle: ass (ssa)
    Metadata:
      title           : 日本語
  Stream #0:4(und): Subtitle: hdmv_pgs_subtitle (pgssub)
  Stream #0:5: Video: mjpeg (Baseline), yuvj420p(pc), 600x800 (attached pic)
  Stream #0:6[0x7]: Video: hevc (Main), yuv420p(tv), 1920x1080
At least one output file must be specified";

  #[test]
  fn reads_tracks_from_ffmpeg_output() {
    let p = parse_probe(MKV);
    assert!((p.duration.unwrap() - 78.96).abs() < 1e-6);
    assert_eq!(p.video.as_deref(), Some("h264"));
    assert_eq!(p.video_stream, Some(0));
    assert!(p.reencode_video, "10-bit H.264 does not play: re-encode");
    assert_eq!(p.audio.as_deref(), Some("ac3"));
    assert!(!p.copy_audio);
    let langs: Vec<_> = p.subtitles.iter().map(|s| (s.index, s.lang.as_deref(), s.title.as_deref(), s.text)).collect();
    assert_eq!(langs, vec![(0, Some("eng"), None, true), (1, Some("jpn"), Some("日本語"), true), (2, None, None, false)]);
  }

  #[test]
  fn cover_art_first_is_skipped() {
    let p = parse_probe("  Stream #0:0: Video: mjpeg, yuvj420p(pc), 600x800 (attached pic)\n  Stream #0:1[0x2](jpn): Video: h264 (High), yuv420p(tv), 1920x1080\n  Stream #0:2: Audio: aac (LC)");
    assert_eq!(p.video_stream, Some(1));
    assert!(!p.reencode_video);
  }

  #[test]
  fn plain_h264_aac_is_copied() {
    let p = parse_probe("  Duration: 00:00:18.96, start: 0.0\n  Stream #0:0: Video: h264 (Main), yuv420p(tv, bt709), 320x240\n  Stream #0:1: Audio: aac (LC), 44100 Hz");
    assert!(!p.reencode_video);
    assert!(p.copy_audio);
    assert!(p.subtitles.is_empty());
  }

  #[test]
  fn empty_track_has_no_cue_text() {
    assert!(!has_cue_text("1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\n \n"));
    assert!(!has_cue_text(""));
    assert!(has_cue_text("1\n00:00:01,000 --> 00:00:02,000\n1995\n\n2\n00:00:03,000 --> 00:00:04,000\nこんにちは\n"));
  }

  #[test]
  fn free_name_skips_taken_names() {
    let dir = std::env::temp_dir().join(format!("lc-convert-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.mp4"), "").unwrap();
    std::fs::write(dir.join("a (2).mp4.part"), "").unwrap();
    std::fs::write(dir.join("a (3).srt"), "").unwrap();
    assert_eq!(free_name(&dir, std::ffi::OsStr::new("a")), dir.join("a (4).mp4"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  // Real network: downloads this platform's ffmpeg into a temp folder, checks its
  // sha256, unpacks it, then converts a clip it makes itself (mpeg4 + AC-3 in mkv,
  // so both picture and sound get re-encoded).
  // cargo test --manifest-path src-tauri/Cargo.toml -- --ignored downloads_ffmpeg --nocapture
  #[test]
  #[ignore]
  fn downloads_ffmpeg() {
    let dir = std::env::temp_dir().join(format!("lc-ffmpeg-{}", std::process::id()));
    let exe = download(&dir, |p| print!("{p} ")).unwrap();
    let out = crate::paths::command(&exe).arg("-version").output().unwrap();
    println!("\n{}", String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or(""));
    assert!(out.status.success());
    let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(left.len(), 1, "only ffmpeg stays: {left:?}");
    let clip = dir.join("clip.mkv");
    let made = crate::paths::command(&exe)
      .args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=d=2:s=320x240", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "mpeg4", "-c:a", "ac3"])
      .arg(&clip)
      .status()
      .unwrap();
    assert!(made.success());
    let (mp4, _) = convert(&exe, &clip, &dir, None, |_| {}).unwrap();
    let back = probe_with(&exe, &mp4).unwrap();
    assert_eq!((back.video.as_deref(), back.audio.as_deref()), (Some("h264"), Some("aac")));
    let _ = std::fs::remove_dir_all(&dir);
  }

  // Real conversion with the ffmpeg on this machine (ours or Homebrew's):
  // LC_CONVERT_SAMPLE=/path/to.mkv cargo test --manifest-path src-tauri/Cargo.toml -- --ignored converts_sample --nocapture
  #[test]
  #[ignore]
  fn converts_sample() {
    let sample = PathBuf::from(std::env::var("LC_CONVERT_SAMPLE").expect("LC_CONVERT_SAMPLE"));
    let ffmpeg = find().expect("ffmpeg");
    let dir = std::env::temp_dir().join(format!("lc-convert-run-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let probe = probe_with(&ffmpeg, &sample).unwrap();
    println!("{probe:?}");
    let subs = probe.subtitles.iter().find(|s| s.text).map(|s| s.index);
    let (mp4, text) = convert(&ffmpeg, &sample, &dir, subs, |p| print!("{p} ")).unwrap();
    println!("\n{} {:?}", mp4.display(), text.as_deref().map(|t| t.lines().take(3).collect::<Vec<_>>()));
    let back = probe_with(&ffmpeg, &mp4).unwrap();
    assert_eq!(back.video.as_deref(), Some(if probe.reencode_video { "h264" } else { probe.video.as_deref().unwrap() }));
    assert_eq!(back.audio.as_deref(), Some("aac"));
    assert!(back.subtitles.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
