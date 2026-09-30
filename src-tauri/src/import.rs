use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::paths::{command, home_dir, own_dir as movies_dir};

const EVENT: &str = "import-progress";

// One spoken word with its own start/end, merged back together from whisper's
// sub-word tokens. This is what lets the front end re-cut long lines by meaning.
#[derive(Clone, serde::Serialize)]
pub(crate) struct Word {
  pub(crate) w: String,
  pub(crate) from: u32,
  pub(crate) to: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
  id: String,
  stage: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  percent: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  video_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  subtitle_text: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  words: Option<Vec<Word>>,
}

impl ImportProgress {
  fn stage(id: &str, stage: &str, percent: Option<u32>) -> Self {
    Self {
      id: id.to_string(),
      stage: stage.to_string(),
      percent,
      error: None,
      video_path: None,
      subtitle_text: None,
      words: None,
    }
  }
}

fn emit(app: &AppHandle, payload: ImportProgress) {
  if let Err(e) = app.emit(EVENT, payload) {
    log::error!("emit {EVENT}: {e}");
  }
}

pub(crate) fn tail_chars(s: &str, max: usize) -> String {
  let count = s.chars().count();
  if count <= max {
    return s.to_string();
  }
  s.chars().skip(count - max).collect()
}


// A Chrome profile we own. Chrome's real profile dir is shielded by macOS app-data
// protection (yt-dlp just reports "could not find cookies database"), but a dir of
// ours is readable, so the user signs in once here and yt-dlp reads it directly.
fn yt_login_dir() -> Result<PathBuf, String> {
  Ok(movies_dir()?.join(".yt-login"))
}

// Chrome creates the cookie DB the moment it launches, so "file exists" would wrongly
// claim a sign-in and make us drop a working cookies.txt. Cookie *names* sit in the
// sqlite file as plain bytes (only values are encrypted), and LOGIN_INFO only appears
// once a Google account is signed in — so scan for that name.
// ponytail: byte scan, not sqlite; switch to a real sqlite read only if this misfires.
fn db_shows_login(bytes: &[u8]) -> bool {
  bytes.windows(10).any(|w| w == b"LOGIN_INFO")
}

fn yt_login_ready() -> bool {
  let Ok(db) = yt_login_dir().map(|d| d.join("Default").join("Cookies")) else {
    return false;
  };
  std::fs::read(&db).map(|b| db_shows_login(&b)).unwrap_or(false)
}

// The in-app sign-in is the only source of a YouTube session. A hand-exported
// cookies.txt used to be a fallback, but it could never be reached once the user
// had signed in here even if that session had since expired, so a stale sign-in
// silently shadowed a good file. One source, no shadowing.
//
// Not signed in at all -> send nothing: YouTube then answers with its own
// "sign in to confirm you're not a bot", which the front end recognises and turns
// into the sign-in button. Forcing an empty profile on yt-dlp instead would make it
// fail with "could not find cookies database", which nothing recognises and which
// leaves the user with no way forward.
fn yt_cookie_args() -> Result<Vec<String>, String> {
  if !yt_login_ready() {
    return Ok(Vec::new());
  }
  Ok(vec![
    "--cookies-from-browser".into(),
    format!("chrome:{}", yt_login_dir()?.to_string_lossy()),
  ])
}

// Recent YouTube clients require yt-dlp's JavaScript challenge solver. The
// Finder-launched app has Node on PATH, but yt-dlp does not reliably discover
// that runtime from PATH, so pass the executable explicitly.
fn yt_runtime_args() -> Result<Vec<String>, String> {
  let node = find_bin("node")?;
  Ok(vec![
    "--js-runtimes".into(),
    format!("node:{}", node.to_string_lossy()),
  ])
}

// Finder-launched apps get a bare PATH; yt-dlp needs node (YouTube's n-challenge)
// and ffmpeg from these dirs, so every child process gets the same augmented PATH.
fn tool_dirs() -> Vec<PathBuf> {
  let home = home_dir().unwrap_or_default();
  let mut dirs: Vec<PathBuf> = vec![
    PathBuf::from("/opt/homebrew/bin"),
    home.join(".local/bin"),
    PathBuf::from("/usr/local/bin"),
  ];
  if let Some(path) = std::env::var_os("PATH") {
    dirs.extend(std::env::split_paths(&path));
  }
  dirs
}

fn augmented_path() -> std::ffi::OsString {
  std::env::join_paths(tool_dirs()).unwrap_or_default()
}

pub(crate) fn find_bin(name: &str) -> Result<PathBuf, String> {
  for dir in tool_dirs() {
    let candidate = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    if candidate.is_file() {
      return Ok(candidate);
    }
  }
  Err(format!("missing:{name}"))
}

fn is_url(source: &str) -> bool {
  let t = source.trim();
  t.starts_with("https://") || t.starts_with("http://")
}

fn is_youtube_url(source: &str) -> bool {
  let t = source.trim();
  let rest = if let Some(r) = t.strip_prefix("https://") {
    r
  } else if let Some(r) = t.strip_prefix("http://") {
    r
  } else {
    return false;
  };
  let host = rest
    .split('/')
    .next()
    .unwrap_or("")
    .split(':')
    .next()
    .unwrap_or("")
    .trim_start_matches("www.")
    .to_ascii_lowercase();
  host == "youtube.com" || host.ends_with(".youtube.com") || host == "youtu.be"
}

fn parse_download_pct(line: &str) -> Option<u32> {
  let idx = line.rfind("[download]")?;
  let after = &line[idx..];
  let pct_idx = after.find('%')?;
  let before = after[..pct_idx].trim_end();
  let num = before.split_whitespace().last()?;
  let v: f32 = num.parse().ok()?;
  Some(v.clamp(0.0, 100.0).round() as u32)
}

fn parse_whisper_pct(line: &str) -> Option<u32> {
  let marker = "progress = ";
  let pos = line.rfind(marker)?;
  // whisper pads the number: "progress =  42%".
  let rest = line[pos + marker.len()..].trim_start();
  let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
  let v: u32 = digits.parse().ok()?;
  Some(v.min(100))
}

fn looks_like_video_path(line: &str) -> bool {
  let t = line.trim();
  let lower = t.to_ascii_lowercase();
  let ok_ext = lower.ends_with(".mp4") || lower.ends_with(".mov") || lower.ends_with(".m4v");
  ok_ext && t.starts_with('/')
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct QualitySizes {
  #[serde(rename = "1080")]
  h1080: Option<u64>,
  #[serde(rename = "720")]
  h720: Option<u64>,
  #[serde(rename = "480")]
  h480: Option<u64>,
}

fn json_u64(v: &serde_json::Value) -> Option<u64> {
  v.as_u64()
    .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
    .or_else(|| {
      v.as_f64().and_then(|n| {
        if n.is_finite() && n > 0.0 {
          Some(n.round() as u64)
        } else {
          None
        }
      })
    })
}

fn format_height(fmt: &serde_json::Value) -> Option<u32> {
  fmt.get("height").and_then(json_u64).and_then(|n| u32::try_from(n).ok())
}

fn format_bytes(fmt: &serde_json::Value) -> Option<u64> {
  fmt
    .get("filesize")
    .and_then(json_u64)
    .or_else(|| fmt.get("filesize_approx").and_then(json_u64))
    .filter(|&n| n > 0)
}

fn is_h264(fmt: &serde_json::Value) -> bool {
  let c = fmt
    .get("vcodec")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  c.contains("avc1") || c.contains("h264")
}

fn is_m4a_audio(fmt: &serde_json::Value) -> bool {
  let vcodec = fmt.get("vcodec").and_then(|v| v.as_str()).unwrap_or("none");
  if vcodec != "none" && !vcodec.is_empty() {
    return false;
  }
  let ext = fmt.get("ext").and_then(|v| v.as_str()).unwrap_or("");
  let acodec = fmt
    .get("acodec")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  ext.eq_ignore_ascii_case("m4a") || acodec.starts_with("mp4a")
}

fn best_m4a_bytes(formats: &[serde_json::Value]) -> Option<u64> {
  formats
    .iter()
    .filter(|f| is_m4a_audio(f))
    .max_by_key(|f| {
      let abr = f.get("abr").and_then(json_u64).unwrap_or(0);
      let tbr = f.get("tbr").and_then(json_u64).unwrap_or(0);
      (abr.max(tbr), format_bytes(f).unwrap_or(0))
    })
    .and_then(format_bytes)
}

fn video_bytes_for_cap(formats: &[serde_json::Value], cap: u32) -> Option<u64> {
  formats
    .iter()
    .filter(|f| is_h264(f) && format_height(f).is_some_and(|h| h <= cap))
    .max_by_key(|f| (format_height(f).unwrap_or(0), format_bytes(f).unwrap_or(0)))
    .and_then(format_bytes)
}

fn parse_quality_sizes(json: &serde_json::Value) -> QualitySizes {
  let empty: Vec<serde_json::Value> = Vec::new();
  let formats = json
    .get("formats")
    .and_then(|v| v.as_array())
    .unwrap_or(&empty);
  let audio = best_m4a_bytes(formats);
  let pair = |cap: u32| match (video_bytes_for_cap(formats, cap), audio) {
    (Some(v), Some(a)) => Some(v.saturating_add(a)),
    _ => None,
  };
  QualitySizes {
    h1080: pair(1080),
    h720: pair(720),
    h480: pair(480),
  }
}

pub(crate) fn run_streaming(mut cmd: Command, mut on_line: impl FnMut(&str)) -> Result<(i32, String), String> {
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());
  // Its own process group, so a cancel also stops helpers it starts (a
  // single-file yt-dlp unpacks itself and runs as a child that holds our pipes).
  #[cfg(unix)]
  std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
  let mut child = cmd.spawn().map_err(|e| e.to_string())?;
  let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
  let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
  // Deleting the card kills it (only when this runs on an import's thread).
  let child = Arc::new(Mutex::new(child));
  crate::import_queue::watch(&child);
  let (tx, rx) = mpsc::channel::<(bool, String)>();
  let tx_out = tx.clone();
  thread::spawn(move || {
    for line in BufReader::new(stdout).lines().flatten() {
      let _ = tx_out.send((false, line));
    }
  });
  thread::spawn(move || {
    for line in BufReader::new(stderr).lines().flatten() {
      let _ = tx.send((true, line));
    }
  });
  let mut err_acc = String::new();
  loop {
    match rx.recv_timeout(Duration::from_millis(200)) {
      Ok((is_err, line)) => {
        on_line(&line);
        if is_err {
          err_acc.push_str(&line);
          err_acc.push('\n');
        }
      }
      // Cancelled: don't wait for whatever still holds the pipes.
      Err(RecvTimeoutError::Timeout) if crate::import_queue::check().is_err() => {
        crate::import_queue::kill(&child);
        break;
      }
      Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => break,
    }
  }
  // Polled, never held across a wait, so cancel_import can't block on this lock.
  let status = loop {
    match child.lock().unwrap_or_else(PoisonError::into_inner).try_wait() {
      Ok(Some(status)) => break Ok(status),
      Ok(None) => {}
      Err(e) => break Err(e),
    }
    thread::sleep(Duration::from_millis(50));
  };
  crate::import_queue::unwatch();
  let code = status.map_err(|e| e.to_string())?.code().unwrap_or(-1);
  // yt-dlp puts the useful part at the start of its last "ERROR:" line, so keep
  // the head of that line; other tools get the plain tail.
  let summary = match err_acc.rfind("ERROR:") {
    Some(i) => err_acc[i..].lines().next().unwrap_or("").chars().take(300).collect(),
    None => tail_chars(&err_acc, 300),
  };
  Ok((code, summary))
}

fn download_video(
  app: &AppHandle,
  id: &str,
  url: &str,
  yt_dlp: &Path,
  dir: &Path,
  quality: u32,
) -> Result<PathBuf, String> {
  let template = dir.join("%(title).80s [%(id)s].%(ext)s");
  let mut args: Vec<String> = yt_cookie_args()?;
  args.extend(yt_runtime_args()?);
  // The codec belongs in the filter, not only in `-S`: `-S` merely sorts, so a clip
  // with no H.264 at this height would still download as VP9/AV1, which this Mac's
  // player cannot show — and the file then sits on disk with no way to delete it from
  // the app. Restricting the selector makes that case a visible error instead.
  args.push("-f".into());
  args.push(format!(
    "bv*[height<={quality}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<={quality}][vcodec^=avc1]"
  ));
  // A watch URL copied out of a playlist carries `list=`; without this yt-dlp would
  // fetch the whole playlist while the size we showed was for one video.
  args.push("--no-playlist".into());
  args.push("-S".into());
  args.push("vcodec:h264,res:1080,acodec:m4a".into());
  args.push("--merge-output-format".into());
  args.push("mp4".into());
  args.push("-o".into());
  args.push(template.to_string_lossy().into_owned());
  args.push("--print".into());
  args.push("after_move:filepath".into());
  args.push("--no-simulate".into());
  args.push("--newline".into());
  // `--print` puts yt-dlp in quiet mode, which swallows the `[download] xx%` lines;
  // `--progress` brings them back without losing the filepath line we parse below.
  args.push("--progress".into());
  args.push(url.trim().into());

  let mut cmd = command(yt_dlp);
  cmd.args(&args);
  cmd.current_dir(dir);
  cmd.env("PATH", augmented_path());

  let mut last_path: Option<String> = None;
  let mut shown_pct: u32 = 0;
  let (code, err_tail) = run_streaming(cmd, |line| {
    if looks_like_video_path(line) {
      last_path = Some(line.trim().to_string());
    }
    if let Some(pct) = parse_download_pct(line) {
      // Video and audio are fetched as two passes that each count 0->100, so report a
      // running max or the bar would snap back to zero partway through. Capped at 99
      // because "download done" is the stage change, and the audio pass is a rounding
      // error next to the video one.
      let pct = pct.min(99);
      if pct > shown_pct {
        shown_pct = pct;
        emit(app, ImportProgress::stage(id, "download", Some(pct)));
      }
    }
  })
  .map_err(|e| format!("download:{e}"))?;

  if code != 0 {
    return Err(format!("download:{err_tail}"));
  }
  let path = last_path.ok_or_else(|| format!("download:{err_tail}"))?;
  let pb = PathBuf::from(&path);
  let ext = pb
    .extension()
    .and_then(|e| e.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  if ext != "mp4" || !pb.is_file() {
    return Err(format!("download:{err_tail}"));
  }
  Ok(pb)
}

// Needs no ffmpeg: macOS's own afconvert, or our built-in decoder elsewhere,
// reads the audio of nearly every video we accept (mp4/mov/m4v). The odd codec
// they refuse (e.g. AAC with a program config element) goes to ffmpeg,
// downloaded first if need be; `on_setup` reports that download, with a
// final 100 once it is over and extracting goes on.
pub(crate) fn extract_wav(video: &Path, wav: &Path, mut on_setup: impl FnMut(u32)) -> Result<(), String> {
  let video_s = video.to_str().ok_or_else(|| "extract:bad path".to_string())?;
  let wav_s = wav.to_str().ok_or_else(|| "extract:bad path".to_string())?;
  if let Err(first) = native_extract(video_s, wav_s) {
    crate::import_queue::check()?;
    log::error!("native extract failed, trying ffmpeg: {first}");
    let mut downloaded = false;
    let ffmpeg = crate::convert::ensure(|pct| {
      downloaded = true;
      on_setup(pct);
    })?;
    if downloaded {
      on_setup(100);
    }
    let mut cmd = command(ffmpeg);
    cmd.env("PATH", augmented_path())
      .args(["-y", "-loglevel", "error", "-i", video_s, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav_s]);
    // run_streaming, so deleting the card stops it.
    let (code, err) = run_streaming(cmd, |_| {}).map_err(|e| format!("extract:{e}"))?;
    if code != 0 {
      return Err(format!("extract:{err}"));
    }
  }
  if !wav.is_file() {
    return Err("extract:wav not created".into());
  }
  Ok(())
}

#[cfg(target_os = "macos")]
fn native_extract(video: &str, wav: &str) -> Result<(), String> {
  let mut cmd = command("/usr/bin/afconvert");
  cmd.args(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", video, wav]);
  // run_streaming, so deleting the card stops it.
  match run_streaming(cmd, |_| {})? {
    (0, _) => Ok(()),
    (_, err) => Err(err),
  }
}

#[cfg(not(target_os = "macos"))]
fn native_extract(video: &str, wav: &str) -> Result<(), String> {
  crate::decode::to_wav(Path::new(video), Path::new(wav))
}

pub(crate) fn transcribe(
  mut on_pct: impl FnMut(u32),
  whisper: &Path,
  model: &Path,
  vad: &Path,
  dtw: &str,
  lang: &str,
  wav: &Path,
  stem: &Path,
) -> Result<(), String> {
  let speech = run_whisper(&mut on_pct, whisper, model, Some(vad), dtw, lang, wav, stem)?;
  // Silero hears speech under a constant music bed (anime, variety shows) as
  // background: a 25-minute episode came back with 40 s of "speech" and
  // subtitles that stopped at minute 10. Too little speech for the length =
  // run the whole audio through again, without VAD.
  if let Some((speech, total)) = speech {
    if speech < total * 0.2 {
      log::error!("vad kept {speech:.0}s of {total:.0}s, transcribing without vad");
      on_pct(0);
      run_whisper(&mut on_pct, whisper, model, None, dtw, lang, wav, stem)?;
    }
  }
  Ok(())
}

// Returns (speech seconds VAD kept, audio seconds) when VAD ran and said so.
fn run_whisper(
  on_pct: &mut impl FnMut(u32),
  whisper: &Path,
  model: &Path,
  vad: Option<&Path>,
  dtw: &str,
  lang: &str,
  wav: &Path,
  stem: &Path,
) -> Result<Option<(f64, f64)>, String> {
  let path = |p: &Path| p.to_str().map(str::to_string).ok_or_else(|| "transcribe:bad path".to_string());
  let mut cmd = command(whisper);
  cmd.env("PATH", augmented_path());
  // whisper-cli defaults to at most 4 threads; use every core.
  let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).to_string();
  cmd.args(["-t", &threads, "-m", &path(model)?, "-l", lang]);
  match vad {
    Some(v) => {
      cmd.args(["--vad", "--vad-model", &path(v)?]);
    }
    // Over music and long silences whisper without VAD can loop on one line
    // (seen: the same sentence 74 times); no carried-over context stops that.
    None => {
      cmd.args(["-mc", "0"]);
    }
  }
  cmd.args([
    "-pp",
    // Token-level timestamps via DTW. It only runs with flash attention off,
    // and the aheads preset has to match the model (Tier::dtw).
    "-nfa",
    "--dtw",
    dtw,
    "-f",
    &path(wav)?,
    "-osrt",
    "-oj",
    "-ojf",
    "-of",
    &path(stem)?,
  ]);
  let mut last_pct: Option<u32> = None;
  let (mut speech, mut total) = (0.0, None);
  let (code, err_tail) = run_streaming(cmd, |line| {
    if let Some(pct) = parse_whisper_pct(line) {
      if last_pct != Some(pct) {
        last_pct = Some(pct);
        on_pct(pct);
      }
    }
    match parse_vad_line(line) {
      Some(VadLine::Total(t)) => total = Some(t),
      Some(VadLine::Segment(d)) => speech += d,
      None => {}
    }
  })
  .map_err(|e| format!("transcribe:{e}"))?;
  if code != 0 {
    return Err(format!("transcribe:{err_tail}"));
  }
  Ok(total.map(|t| (speech, t)))
}

enum VadLine {
  Total(f64),
  Segment(f64),
}

// whisper's VAD log: "...: detecting speech timestamps in 23838912 samples"
// (16 kHz) and one "...: VAD segment 3: start = 93.28, end = 93.89 (duration: 0.61)"
// per kept stretch. No such lines (older build) = no verdict, keep the result.
fn parse_vad_line(line: &str) -> Option<VadLine> {
  if let Some(i) = line.find("detecting speech timestamps in ") {
    let n: f64 = line[i..].split_whitespace().nth(4)?.parse().ok()?;
    return Some(VadLine::Total(n / 16000.0));
  }
  if line.contains("VAD segment ") {
    let i = line.rfind("(duration: ")?;
    let d: f64 = line[i + 11..].trim_end_matches(|c: char| c == ')' || c.is_whitespace()).parse().ok()?;
    return Some(VadLine::Segment(d));
  }
  None
}

// whisper emits sub-word tokens (" mer" + "cado"); a token that does not start
// with a space continues the word before it. Punctuation rides along with its word.
pub(crate) fn read_words(json_path: &Path) -> Result<Vec<Word>, String> {
  let raw = std::fs::read(json_path).map_err(|e| format!("transcribe:{e}"))?;
  let doc: serde_json::Value =
    serde_json::from_str(&stray_bytes_as_chars(&raw)).map_err(|e| format!("transcribe:{e}"))?;
  let segments = doc
    .get("transcription")
    .and_then(|v| v.as_array())
    .ok_or_else(|| "transcribe:no transcription in json".to_string())?;

  let mut words: Vec<Word> = Vec::new();
  for seg in segments {
    // Bytes of a character whisper split across tokens, waiting for the rest,
    // and the start time of the token they came in.
    let mut pending: (Vec<u8>, u32) = (Vec::new(), 0);
    // A segment's first word never joins the last one of the segment before.
    let first_word_at = words.len();
    let Some(tokens) = seg.get("tokens").and_then(|v| v.as_array()) else {
      return Err("transcribe:segment without tokens".into());
    };
    // With VAD on, whisper maps the SEGMENT times back onto the original audio
    // but leaves the token times on the silence-stripped clock, so they drift
    // further behind the longer the video runs. The segment's own start and end
    // are the two points we know on both clocks: stretch the tokens onto them.
    let seg_from = seg.pointer("/offsets/from").and_then(|v| v.as_i64());
    let seg_to = seg.pointer("/offsets/to").and_then(|v| v.as_i64());
    let speech: Vec<&serde_json::Value> = tokens
      .iter()
      .filter(|t| {
        t.get("text")
          .and_then(|v| v.as_str())
          .is_some_and(|s| !s.starts_with("[_") && !s.trim().is_empty())
      })
      .collect();
    let span = match (seg_from, seg_to, speech.first(), speech.last()) {
      (Some(sf), Some(st), Some(first), Some(last)) => {
        let tf = first.pointer("/offsets/from").and_then(|v| v.as_i64());
        let tl = last.pointer("/offsets/to").and_then(|v| v.as_i64());
        match (tf, tl) {
          (Some(tf), Some(tl)) if tl > tf && st > sf => Some((tf, tl, sf, st)),
          _ => None,
        }
      }
      _ => None,
    };
    let to_audio = |t: i64| -> i64 {
      match span {
        Some((tf, tl, sf, st)) => sf + (t - tf) * (st - sf) / (tl - tf),
        None => t,
      }
    };
    for tok in tokens {
      let Some(text) = tok.get("text").and_then(|v| v.as_str()) else {
        return Err("transcribe:token without text".into());
      };
      if text.starts_with("[_") {
        continue; // whisper's own markers, not speech
      }
      // A word placed at a guessed time is worse than no word timings at all:
      // the front end would re-cut the lines around it and the audio would no
      // longer match what is written. Refuse instead, and keep whisper's lines.
      let (Some(raw_from), Some(raw_to)) = (
        tok.pointer("/offsets/from").and_then(|v| v.as_i64()),
        tok.pointer("/offsets/to").and_then(|v| v.as_i64()),
      ) else {
        return Err("transcribe:token without offsets".into());
      };
      let mut from = to_audio(raw_from).max(0) as u32;
      let to = to_audio(raw_to).max(0) as u32;
      if pending.0.is_empty() {
        pending.1 = from;
      } else {
        from = pending.1;
      }
      let text = take_complete_chars(&mut pending.0, text);
      let trimmed = text.trim();
      if trimmed.is_empty() {
        continue;
      }
      // Chinese and Japanese put no spaces between words, so every token there
      // is a word of its own: one per character or kana run, each with its time.
      if text.starts_with(' ') || words.len() == first_word_at || trimmed.starts_with(is_cjk) {
        words.push(Word { w: trimmed.to_string(), from, to });
      } else {
        let last = words.last_mut().expect("checked non-empty");
        last.w.push_str(trimmed);
        last.to = to;
      }
    }
  }

  // Times have to run forward. If they do not, the lines built from them would
  // jump around the video, so drop the lot and let whisper's own lines stand.
  if words.iter().any(|w| w.to < w.from)
    || words.windows(2).any(|pair| pair[1].from < pair[0].from)
  {
    return Err("transcribe:word times out of order".into());
  }
  Ok(words)
}

// Han, kana and the long-vowel mark: scripts written without spaces between words.
pub(crate) fn is_cjk(c: char) -> bool {
  matches!(c, '\u{3005}' | '\u{3040}'..='\u{30FF}' | '\u{31F0}'..='\u{31FF}' | '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{FF66}'..='\u{FF9F}')
}

// whisper cuts tokens on bytes, so one Japanese character can arrive as two
// tokens, each holding half of it: not UTF-8, and the whole json would be
// refused. Each stray byte becomes a private-use character (U+F780 + low 7
// bits) that take_complete_chars turns back into the byte.
fn stray_bytes_as_chars(raw: &[u8]) -> String {
  let mut out = String::with_capacity(raw.len());
  let mut rest = raw;
  loop {
    match std::str::from_utf8(rest) {
      Ok(s) => {
        out.push_str(s);
        return out;
      }
      Err(e) => {
        let (good, bad) = rest.split_at(e.valid_up_to());
        out.push_str(std::str::from_utf8(good).expect("checked valid"));
        let n = e.error_len().unwrap_or(bad.len());
        out.extend(bad[..n].iter().map(|&b| char::from_u32(0xF700 + b as u32).expect("in range")));
        rest = &bad[n..];
      }
    }
  }
}

// Appends a token's bytes to what an earlier token left unfinished and returns
// the whole characters; an unfinished tail waits in `pending` for the next token.
fn take_complete_chars(pending: &mut Vec<u8>, text: &str) -> String {
  for c in text.chars() {
    match c as u32 {
      b @ 0xF780..=0xF7FF => pending.push((b - 0xF700) as u8),
      _ => pending.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
    }
  }
  let mut out = String::new();
  let mut rest = std::mem::take(pending);
  loop {
    match std::str::from_utf8(&rest) {
      Ok(s) => {
        out.push_str(s);
        return out;
      }
      Err(e) => {
        out.push_str(std::str::from_utf8(&rest[..e.valid_up_to()]).expect("checked valid"));
        match e.error_len() {
          // Cut off at the end: the rest of the character is in the next token.
          None => {
            *pending = rest[e.valid_up_to()..].to_vec();
            return out;
          }
          // Not part of any character: drop it.
          Some(n) => rest.drain(..e.valid_up_to() + n),
        };
      }
    }
  }
}

// Settings → Transcription: this machine (with a model size) or a cloud service.
pub(crate) enum Engine {
  // The bool: Windows "Transcribe on the graphics card".
  Local(crate::whisper_setup::Tier, bool),
  Cloud { provider: crate::cloud_asr::Provider, api_key: String },
}

// Subtitles the user brought: then nothing is transcribed.
pub(crate) enum Subs {
  // Their own .srt; the front end already holds its text.
  Own,
  // A text track inside the video (ffmpeg's 0:s:N), read out while converting.
  Track(u32),
}

fn done(app: &AppHandle, id: &str, video: &Path, subtitle_text: Option<String>, words: Option<Vec<Word>>) {
  emit(
    app,
    ImportProgress {
      id: id.to_string(),
      stage: "done".into(),
      percent: Some(100),
      error: None,
      video_path: Some(video.to_string_lossy().into_owned()),
      subtitle_text,
      words,
    },
  );
}

fn run_import(app: &AppHandle, id: &str, source: &str, lang: &str, quality: u32, engine: &Engine, convert: bool, subs: Option<Subs>) -> Result<(), String> {
  let dir = movies_dir()?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

  // First import on a new Mac: fetch the transcription parts before anything
  // else, so a failure here never leaves a half-downloaded video behind.
  let parts = match engine {
    _ if subs.is_some() => None,
    Engine::Local(tier, gpu) => Some((
      crate::whisper_setup::ensure(*tier, *gpu, |pct| {
        emit(app, ImportProgress::stage(id, "setup", Some(pct)));
      })?,
      *tier,
    )),
    Engine::Cloud { .. } => None,
  };
  crate::import_queue::check()?;

  let video = if is_url(source) {
    if !is_youtube_url(source) {
      return Err("download:not a YouTube URL".into());
    }
    let yt = find_bin("yt-dlp")?;
    emit(app, ImportProgress::stage(id, "download", Some(0)));
    download_video(app, id, source, &yt, &dir, quality)?
  } else {
    let p = PathBuf::from(source.trim());
    if !p.is_file() {
      return Err("extract:video not found".into());
    }
    p
  };

  // What the player cannot open becomes an mp4 in our folder first. Its path
  // goes out with the last progress event, so a retry can skip this step.
  crate::import_queue::check()?;
  let mut track_text = None;
  let video = if convert || !crate::convert::plays_natively(&video) {
    let ffmpeg = crate::convert::ensure(|pct| emit(app, ImportProgress::stage(id, "convertSetup", Some(pct))))?;
    emit(app, ImportProgress::stage(id, "convert", Some(0)));
    let track = match subs {
      Some(Subs::Track(n)) => Some(n),
      _ => None,
    };
    let (mp4, text) = crate::convert::convert(&ffmpeg, &video, &dir, track, |pct| {
      emit(app, ImportProgress::stage(id, "convert", Some(pct)));
    })?;
    let mut converted = ImportProgress::stage(id, "convert", Some(100));
    converted.video_path = Some(mp4.to_string_lossy().into_owned());
    emit(app, converted);
    track_text = text;
    mp4
  } else {
    video
  };
  if subs.is_some() {
    done(app, id, &video, track_text, None);
    return Ok(());
  }

  // Work files always land in our own folder, never beside a user-picked video
  // (it may already have a hand-made lesson.srt next to it).
  let file_stem = video
    .file_stem()
    .ok_or_else(|| "extract:bad path".to_string())?;
  // whisper-cli on Windows reads its arguments in the ANSI code page, so a
  // video named in Chinese would come through as "???". Its work files are
  // named by record id (ASCII); only the finished .srt takes the video's name.
  // That also keeps two lesson.mp4 imports from sharing work files.
  let work = dir.join(id);
  let wav = work.with_extension("wav");
  let json = work.with_extension("json");
  // Append, not with_extension: a title like "Chinese... [id]" has dots in it.
  let mut srt_name = file_stem.to_os_string();
  srt_name.push(".srt");
  let srt = dir.join(srt_name);

  crate::import_queue::check()?;
  emit(app, ImportProgress::stage(id, "extract", None));
  extract_wav(&video, &wav, |pct| {
    let stage = if pct < 100 { ImportProgress::stage(id, "convertSetup", Some(pct)) } else { ImportProgress::stage(id, "extract", Some(0)) };
    emit(app, stage);
  })?;

  let result = crate::import_queue::check().and_then(|()| match (&parts, engine) {
    (Some((parts, tier)), _) => {
      emit(app, ImportProgress::stage(id, "transcribe", Some(0)));
      let on_pct = |pct| emit(app, ImportProgress::stage(id, "transcribe", Some(pct)));
      let run = |whisper: &Path| transcribe(on_pct, whisper, &parts.model, &parts.vad, tier.dtw(), lang, &wav, &work);
      // A graphics card whose driver cannot run it: same job again on the CPU.
      match (run(&parts.whisper), &parts.fallback) {
        (Err(e), Some(cpu)) if crate::import_queue::check().is_ok() => {
          log::error!("gpu transcribe failed, retrying on cpu: {e}");
          emit(app, ImportProgress::stage(id, "transcribe", Some(0)));
          run(cpu)
        }
        (r, _) => r,
      }
      .map(|()| None)
    }
    (None, Engine::Cloud { provider, api_key }) => {
      emit(app, ImportProgress::stage(id, "cloud", Some(0)));
      let on_pct = |pct| emit(app, ImportProgress::stage(id, "cloud", Some(pct)));
      // Writes <work>.srt like whisper-cli; the words come back directly.
      crate::cloud_asr::transcribe(on_pct, *provider, api_key, lang, &wav, &work).map(Some)
    }
    (None, Engine::Local(..)) => unreachable!("local engine without subtitles always has parts"),
  })
  .and_then(|words| {
    std::fs::rename(work.with_extension("srt"), &srt).map_err(|e| format!("transcribe:{e}"))?;
    Ok(words)
  });
  let _ = std::fs::remove_file(&wav);
  if result.is_err() {
    // Whisper may have left a half-written json behind; it holds the whole
    // transcript, so it must not pile up in the user's Movies folder.
    let _ = std::fs::remove_file(&json);
    let _ = std::fs::remove_file(work.with_extension("srt"));
  }
  let cloud_words = result?;
  // Deleted while a cloud upload finished: its subtitles belong to no card.
  if let Err(e) = crate::import_queue::check() {
    let _ = std::fs::remove_file(&json);
    let _ = std::fs::remove_file(&srt);
    return Err(e);
  }

  let subtitle_text = std::fs::read_to_string(&srt).map_err(|e| {
    let _ = std::fs::remove_file(&json);
    format!("transcribe:{e}")
  })?;
  // Word timings are a bonus: if they are missing the front end just keeps
  // whisper's own line breaks, so a failure here must not fail the import.
  let words = cloud_words
    .or_else(|| read_words(&json).ok())
    .filter(|w: &Vec<Word>| !w.is_empty());
  let _ = std::fs::remove_file(&json);
  // Only whisper can produce these, so keep them for "break it down" before
  // `done` lets the front end open the record. Named by record id, never by
  // video file name: two lesson.mp4 files would overwrite each other. A failed
  // write just means this video has no word timings; the import still succeeds.
  if let Some(w) = &words {
    let saved = serde_json::to_string(w)
      .map_err(|e| e.to_string())
      .and_then(|text| crate::cache::write_cache(id.to_string(), "words".into(), text));
    if let Err(e) = saved {
      log::error!("write words cache for {id}: {e}");
    }
  }
  done(app, id, &video, Some(subtitle_text), words);
  Ok(())
}

#[tauri::command]
pub fn start_import(
  app: AppHandle,
  id: String,
  source: String,
  lang: String,
  quality: u32,
  engine: Option<String>,
  model: Option<String>,
  gpu: Option<bool>,
  api_key: Option<String>,
  convert: Option<bool>,
  subs: Option<String>,
) -> Result<(), String> {
  if id.trim().is_empty() || source.trim().is_empty() {
    return Err("missing id or source".into());
  }
  // The id names work files on disk, so it must not carry a path.
  if id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
    return Err("bad id".into());
  }
  let lang = lang.trim().to_string();
  if !matches!(lang.as_str(), "en" | "es" | "ja" | "zh" | "auto") {
    return Err("bad-lang".into());
  }
  if !matches!(quality, 1080 | 720 | 480) {
    return Err("bad-quality".into());
  }
  // Older front ends send neither: convert only what the player cannot open, transcribe.
  let subs = match subs.as_deref() {
    None | Some("") => None,
    Some("own") => Some(Subs::Own),
    Some(n) => Some(Subs::Track(n.parse().map_err(|_| "bad-subs".to_string())?)),
  };
  // Older front ends send no engine: that is the local standard model. With
  // subtitles nothing is transcribed, so a missing cloud key does not matter.
  let engine = match engine.as_deref().unwrap_or("local") {
    _ if subs.is_some() => Engine::Local(crate::whisper_setup::Tier::Standard, false),
    "local" => Engine::Local(crate::whisper_setup::Tier::parse(model.as_deref().unwrap_or("standard"))?, gpu.unwrap_or(false)),
    cloud @ ("groq" | "bailian") => {
      let key = api_key.unwrap_or_default().trim().to_string();
      if key.is_empty() {
        return Err("cloud:key".into());
      }
      let provider = if cloud == "groq" { crate::cloud_asr::Provider::Groq } else { crate::cloud_asr::Provider::Bailian };
      Engine::Cloud { provider, api_key: key }
    }
    _ => return Err("bad-engine".into()),
  };
  let convert = convert.unwrap_or(false);
  // Their own .srt and a video the player opens: nothing heavy to do, no waiting.
  let light = subs.is_some() && !convert && !is_url(&source) && crate::convert::plays_natively(Path::new(source.trim()));
  thread::spawn(move || {
    let run = || run_import(&app, &id, &source, &lang, quality, &engine, convert, subs);
    let result = if light {
      run()
    } else {
      crate::import_queue::wait_turn(&id, || emit(&app, ImportProgress::stage(&id, "queued", None))).and_then(|_turn| run())
    };
    if let Err(e) = result {
      emit(
        &app,
        ImportProgress {
          id: id.clone(),
          stage: "error".into(),
          percent: None,
          error: Some(e),
          video_path: None,
          subtitle_text: None,
          words: None,
        },
      );
    }
  });
  Ok(())
}

// The card is being deleted: stop its import, queued or running.
#[tauri::command]
pub fn cancel_import(id: String) {
  crate::import_queue::cancel(&id);
}

#[tauri::command]
pub fn open_youtube_login() -> Result<(), String> {
  const CHROME: &str = "Google Chrome";
  if !Path::new("/Applications/Google Chrome.app").is_dir() {
    return Err("missing:Google Chrome".into());
  }
  let dir = yt_login_dir()?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  // `-n` forces a second Chrome instance, so the user's own windows and session
  // are untouched; the sign-in lands in our profile dir only.
  let status = command("open")
    .args(["-na", CHROME, "--args"])
    .arg(format!("--user-data-dir={}", dir.to_string_lossy()))
    .args([
      "--no-first-run",
      "--no-default-browser-check",
      "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/",
    ])
    .status()
    .map_err(|e| format!("login:{e}"))?;
  if !status.success() {
    return Err("login:could not launch Google Chrome".into());
  }
  Ok(())
}

// Asking YouTube takes a few seconds. A plain (non-async) command runs inline on
// the main thread, which would freeze the window — including dragging it — for the
// whole query, so hand the blocking work to a worker thread.
#[tauri::command]
pub async fn probe_import_sizes(url: String) -> Result<QualitySizes, String> {
  tauri::async_runtime::spawn_blocking(move || probe_sizes_blocking(url))
    .await
    .map_err(|e| format!("probe:{e}"))?
}

fn probe_sizes_blocking(url: String) -> Result<QualitySizes, String> {
  let url = url.trim().to_string();
  if !is_youtube_url(&url) {
    return Err("download:not a YouTube URL".into());
  }
  let yt = find_bin("yt-dlp")?;
  let mut cmd = command(&yt);
  cmd.env("PATH", augmented_path());
  cmd.args(yt_cookie_args()?);
  cmd.args(yt_runtime_args()?);
  // Without a socket timeout a stalled connection leaves the dropdown on "checking…"
  // for good, and every re-typed URL would start another yt-dlp that never exits.
  cmd.args(["--socket-timeout", "15", "-J", "--no-playlist", &url]);
  let output = cmd.output().map_err(|e| format!("probe:{e}"))?;
  if !output.status.success() {
    let err = String::from_utf8_lossy(&output.stderr);
    return Err(format!("probe:{}", tail_chars(&err, 300)));
  }
  let json: serde_json::Value =
    serde_json::from_slice(&output.stdout).map_err(|e| format!("probe:{e}"))?;
  Ok(parse_quality_sizes(&json))
}

#[cfg(test)]
mod tests {
  use super::*;

  // LC_WAV=/path/16k.wav [LC_LANG=ja] cargo test … -- --ignored transcribes_sample --nocapture
  // Uses the Homebrew whisper-cli and ~/.cache/whisper.cpp models; writes next to the wav.
  #[test]
  #[ignore]
  fn transcribes_sample() {
    let wav = PathBuf::from(std::env::var("LC_WAV").expect("LC_WAV"));
    let models = home_dir().unwrap().join(".cache/whisper.cpp");
    let stem = wav.with_extension("");
    transcribe(
      |p| eprintln!("{p}%"),
      Path::new("/opt/homebrew/bin/whisper-cli"),
      &models.join("ggml-large-v3-turbo.bin"),
      &models.join("ggml-silero-v5.1.2.bin"),
      "large.v3.turbo",
      &std::env::var("LC_LANG").unwrap_or("ja".into()),
      &wav,
      &stem,
    )
    .unwrap();
    let srt = std::fs::read_to_string(stem.with_extension("srt")).unwrap();
    eprintln!("cues: {}", srt.matches("-->").count());
  }

  // LC_JSON=/path/whisper.json cargo test … -- --ignored reads_sample_words --nocapture
  #[test]
  #[ignore]
  fn reads_sample_words() {
    let words = read_words(Path::new(&std::env::var("LC_JSON").expect("LC_JSON"))).unwrap();
    eprintln!("words: {}", words.len());
    eprintln!("{}", serde_json::to_string(&words).unwrap());
  }

  #[test]
  fn reads_vad_log() {
    let total = "whisper_vad_segments_from_samples: detecting speech timestamps in 23838912 samples";
    assert!(matches!(parse_vad_line(total), Some(VadLine::Total(t)) if (t - 1489.932).abs() < 0.01));
    let seg = "whisper_vad_segments_from_probs: VAD segment 3: start = 93.28, end = 93.89 (duration: 0.61)";
    assert!(matches!(parse_vad_line(seg), Some(VadLine::Segment(d)) if (d - 0.61).abs() < 1e-9));
    // The later "Including segment" lines repeat the same stretches; don't count them twice.
    assert!(parse_vad_line("whisper_vad: Including segment 0: 82.47 - 84.13 (duration: 1.66)").is_none());
    assert!(parse_vad_line("whisper_vad_detect_speech: detecting speech in 23838912 samples").is_none());
  }

  #[test]
  fn reads_padded_whisper_progress() {
    assert_eq!(parse_whisper_pct("whisper_print_progress_callback: progress =  42%"), Some(42));
    assert_eq!(parse_whisper_pct("whisper_print_progress_callback: progress = 100%"), Some(100));
  }

  // With VAD on, whisper reports segment times on the original audio clock but
  // leaves token times on the silence-stripped one. Unmapped, the gap grows all
  // through a video (measured: 2.8s adrift by the one-minute mark), and every
  // re-cut line would then play the wrong stretch of audio.
  #[test]
  fn maps_token_times_back_onto_the_original_audio_clock() {
    let json = serde_json::json!({
      "transcription": [{
        "offsets": { "from": 10000, "to": 14000 },
        "tokens": [
          { "text": " uno",  "offsets": { "from": 7000, "to": 8000 } },
          { "text": " dos",  "offsets": { "from": 8000, "to": 9000 } },
          { "text": " tres", "offsets": { "from": 9000, "to": 11000 } }
        ]
      }]
    });
    let dir = std::env::temp_dir().join(format!("vadmap-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.json");
    std::fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();

    let words = read_words(&path).unwrap();
    std::fs::remove_dir_all(&dir).ok();

    // Tokens span 7000..11000 and the segment really runs 10000..14000, so the
    // whole run shifts forward and the ends land on the segment's own edges.
    assert_eq!(words[0].from, 10000, "first word starts where the segment does");
    assert_eq!(words[2].to, 14000, "last word ends where the segment does");
    assert_eq!(words[1].from, 11000);
  }

  // Times that run backwards would build lines that jump around the video, so
  // the whole set is refused and whisper's own lines stand instead.
  #[test]
  fn refuses_word_times_that_run_backwards() {
    let json = serde_json::json!({
      "transcription": [
        { "offsets": { "from": 5000, "to": 6000 },
          "tokens": [{ "text": " tarde", "offsets": { "from": 5000, "to": 6000 } }] },
        { "offsets": { "from": 1000, "to": 2000 },
          "tokens": [{ "text": " pronto", "offsets": { "from": 1000, "to": 2000 } }] }
      ]
    });
    let dir = std::env::temp_dir().join(format!("order-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.json");
    std::fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();
    let out = read_words(&path);
    std::fs::remove_dir_all(&dir).ok();
    assert!(out.is_err(), "backwards times must be refused, not passed on");
  }


  // whisper splits rare words across tokens and hands punctuation its own
  // token; a line we hand the model has to read as whole words again.
  #[test]
  fn merges_sub_word_tokens_back_into_words() {
    let json = serde_json::json!({
      "transcription": [{
        "tokens": [
          { "text": "[_BEG_]", "offsets": { "from": 0, "to": 0 } },
          { "text": " mer",    "offsets": { "from": 100, "to": 200 } },
          { "text": "cado",    "offsets": { "from": 200, "to": 400 } },
          { "text": ",",       "offsets": { "from": 400, "to": 430 } },
          { "text": " está",   "offsets": { "from": 500, "to": 700 } }
        ]
      }]
    });
    let dir = std::env::temp_dir().join(format!("words-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.json");
    std::fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();

    let words = read_words(&path).unwrap();
    std::fs::remove_dir_all(&dir).ok();

    assert_eq!(words.len(), 2);
    assert_eq!(words[0].w, "mercado,");
    assert_eq!(words[0].from, 100);
    assert_eq!(words[0].to, 430, "punctuation extends the word it belongs to");
    assert_eq!(words[1].w, "está");
    assert_eq!(words[1].from, 500);
  }

  // whisper cut 予 (e4 ba 88) into two tokens: raw bytes, not UTF-8. The json
  // must still read, the halves join into one character, and Japanese comes
  // out one word per token, punctuation riding on the word before it.
  #[test]
  fn japanese_tokens_with_split_characters() {
    let tok = |text: &[u8], from: u32, to: u32| {
      [&br#"{"text":""#[..], text, format!(r#"","offsets":{{"from":{from},"to":{to}}}}}"#).as_bytes()].concat()
    };
    let toks: Vec<Vec<u8>> = vec![
      tok(b"[_BEG_]", 0, 0),
      tok(b"\xe4\xba", 100, 200),
      tok(b"\x88", 200, 300),
      tok("告".as_bytes(), 300, 400),
      tok("だよ".as_bytes(), 400, 500),
      tok("。".as_bytes(), 500, 550),
      tok(b" OK", 600, 700),
      tok(b"\xff", 700, 720),
    ];
    let next = [tok("「".as_bytes(), 800, 850), tok(b"30", 850, 900), tok("分".as_bytes(), 900, 1000)];
    let raw = [
      &br#"{"transcription":[{"tokens":["#[..], &toks.join(&b","[..]),
      br#"]},{"tokens":["#, &next.join(&b","[..]), br#"]}]}"#,
    ].concat();
    let dir = std::env::temp_dir().join(format!("ja-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.json");
    std::fs::write(&path, &raw).unwrap();
    let words = read_words(&path).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    let got: Vec<(&str, u32, u32)> = words.iter().map(|w| (w.w.as_str(), w.from, w.to)).collect();
    // The stray 0xff belongs to no character and is dropped.
    // The next segment opens with a bracket and a number: they start a word of
    // their own, not the tail of "OK".
    assert_eq!(got, [("予", 100, 300), ("告", 300, 400), ("だよ。", 400, 550), ("OK", 600, 700), ("「30", 800, 900), ("分", 900, 1000)]);
  }

  #[test]
  fn login_marker_needs_a_real_sign_in() {
    // A just-launched Chrome profile has a cookie DB but no account cookies.
    assert!(!db_shows_login(b""));
    assert!(!db_shows_login(b"SQLite format 3\0cookiesVISITOR_INFO1_LIVEYSCPREF"));
    // Signing in adds LOGIN_INFO; names are plain bytes even though values are not.
    assert!(db_shows_login(b"SQLite format 3\0cookies\x01LOGIN_INFO\x7f\x80junk"));
    assert!(db_shows_login(b"LOGIN_INFO"));
  }

  #[test]
  fn download_pct_parses_real_yt_dlp_progress_lines() {
    // Captured from `yt-dlp --newline --progress` with the flags download_video uses.
    assert_eq!(parse_download_pct("[download]   0.0% of  461.80MiB at    3.95KiB/s ETA 33:15:06"), Some(0));
    assert_eq!(parse_download_pct("[download]   5.9% of  461.80MiB at    8.01MiB/s ETA 00:54"), Some(6));
    assert_eq!(parse_download_pct("[download]  83.2% of  614.43KiB at    1.01MiB/s ETA 00:00"), Some(83));
    assert_eq!(parse_download_pct("[download] 100% of  614.43KiB in 00:00:01 at 595.76KiB/s"), Some(100));
    // The filepath line yt-dlp prints last must not look like progress.
    assert_eq!(parse_download_pct("/Users/me/Movies/LinguaClip/Clip [abc].mp4"), None);
  }

  #[test]
  fn yt_dlp_error_tail_keeps_the_head_of_the_last_error_line() {
    assert_eq!(tail_chars("abcdef", 3), "def");
    assert_eq!(tail_chars("ab", 5), "ab");
  }

  #[test]
  fn quality_size_uses_h264_m4a_filesize_approx_and_missing() {
    let json = serde_json::json!({
      "formats": [
        { "format_id": "137", "vcodec": "avc1.640028", "acodec": "none", "height": 1080 },
        { "format_id": "136", "vcodec": "avc1.4d401f", "acodec": "none", "height": 720, "filesize": 200000000 },
        { "format_id": "135", "vcodec": "avc1.4d401e", "acodec": "none", "height": 480, "filesize_approx": 100000000 },
        { "format_id": "248", "vcodec": "vp9", "acodec": "none", "height": 1080, "filesize": 999999999 },
        { "format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "abr": 128, "filesize": 10000000 },
        { "format_id": "139", "vcodec": "none", "acodec": "mp4a.40.5", "ext": "m4a", "abr": 48, "filesize": 5000000 },
        { "format_id": "251", "vcodec": "none", "acodec": "opus", "ext": "webm", "abr": 160, "filesize": 8000000 }
      ]
    });
    let sizes = parse_quality_sizes(&json);
    assert_eq!(sizes.h1080, None, "1080 avc1 has no filesize so the tier is missing");
    assert_eq!(sizes.h720, Some(210000000));
    assert_eq!(sizes.h480, Some(110000000));
  }
}
