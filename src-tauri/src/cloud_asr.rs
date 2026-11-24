// Cloud transcription (Settings → Transcription): Groq's hosted Whisper or
// Alibaba Cloud Bailian's Qwen3-ASR. The 16k mono wav import.rs extracted is
// cut into pieces that each fit one upload, at a quiet spot near each cut, sent
// one by one, and stitched back (seams mended in cloud_pieces.rs) into the same .srt file and word list the local
// engine gives. The providers themselves live in groq.rs and bailian.rs.
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use tauri_plugin_http::reqwest;

use crate::import::Word;
use crate::word_order::in_order;

pub(crate) const RATE: u64 = 16_000; // samples per second, mono 16-bit (extract_wav)

#[derive(Clone, Copy)]
pub(crate) enum Provider {
  Groq,
  Bailian,
}

impl Provider {
  // macOS compresses each piece to AAC (~32–36kbps → ~14–16MB an hour);
  // Android compresses in Kotlin MediaCodec and uploads via `transcribe_prepared_pieces`.
  // Elsewhere pieces go up as plain wav (32KB/s). Groq's free tier takes 25MB
  // an upload (11 minutes of wav); Bailian takes 1GB, so an hour is plenty.
  fn piece_secs(self) -> u64 {
    match self {
      Self::Groq if cfg!(target_os = "macos") => 60 * 60,
      Self::Groq => 11 * 60,
      Self::Bailian => 60 * 60,
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CutPiece {
  pub(crate) index: usize,
  pub(crate) from_sample: u64,
  pub(crate) to_sample: u64,
  pub(crate) offset_ms: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribePlan {
  pub(crate) plan_id: String,
  pub(crate) lang: String,
  pub(crate) piece_secs: u64,
  pub(crate) wav_samples: u64,
  pub(crate) pieces: Vec<CutPiece>,
  #[serde(default)]
  pub(crate) done_indices: Vec<usize>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PieceCache {
  plan_id: String,
  idx: usize,
  offset_ms: u64,
  provider: String,
  resp: Resp,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedPiece {
  pub(crate) path: String,
  pub(crate) offset_ms: u64,
}

// Computes silence-aligned cut points for a 16kHz mono PCM WAV so Android's
// native MediaCodec can encode each piece to 32kbps AAC before cloud upload.
pub(crate) fn plan_cuts(wav: &Path, piece_secs: u64) -> Result<Vec<CutPiece>, String> {
  let piece_secs = piece_secs.clamp(60, 60 * 60);
  let (data_at, samples) = wav_data(wav).map_err(|e| format!("extract:{e}"))?;
  let mut file = std::fs::File::open(wav).map_err(|e| format!("extract:{e}"))?;
  let cuts = cut_points(samples, piece_secs * RATE, SLACK_SECS * RATE, |from, len| {
    read_samples(&mut file, data_at, from, len).unwrap_or_default()
  });
  Ok(
    cuts
      .windows(2)
      .enumerate()
      .map(|(index, w)| CutPiece {
        index,
        from_sample: w[0],
        to_sample: w[1],
        offset_ms: w[0] * 1000 / RATE,
      })
      .collect(),
  )
}

// Uploads already-compressed audio pieces (e.g. Android MediaCodec 32kbps AAC .m4a),
// stitches CJK seams, restores word punctuation, orders timestamps, and writes .srt.
pub(crate) fn transcribe_prepared_pieces(
  provider_kind: &str,
  api_key: &str,
  base_url: Option<&str>,
  model: Option<&str>,
  lang: &str,
  pieces: &[PreparedPiece],
  stem: &Path,
) -> Result<(String, Vec<Word>), String> {
  if pieces.is_empty() {
    return Err("cloud:empty".into());
  }
  let is_loopback = base_url.is_some_and(|u| {
    let l = u.trim().to_ascii_lowercase();
    l.starts_with("http://127.0.0.1") || l.starts_with("http://localhost") || l.starts_with("http://[::1]")
  });
  let mut builder = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(10 * 60));
  if is_loopback {
    builder = builder.no_proxy();
  }
  let client = builder.build().map_err(|e| format!("cloud:network:{e}"))?;

  let mut resps: Vec<Resp> = Vec::with_capacity(pieces.len());
  let mut offsets: Vec<u64> = Vec::with_capacity(pieces.len());
  for p in pieces {
    crate::import_queue::check()?;
    let bytes = std::fs::read(&p.path).map_err(|e| format!("extract:{e}"))?;
    let (fname, mime) = if p.path.ends_with(".wav") {
      ("audio.wav", "audio/wav")
    } else if p.path.ends_with(".mp3") {
      ("audio.mp3", "audio/mpeg")
    } else {
      ("audio.m4a", "audio/mp4")
    };
    let resp = crate::cloud_pieces::until_cancelled(async {
      match provider_kind {
        "groq" => crate::groq::send(&client, api_key, lang, (bytes, fname, mime)).await,
        "bailian" => crate::bailian::send(&client, api_key, lang, (bytes, fname, mime)).await,
        "custom" => {
          let raw_url = base_url.filter(|s| !s.trim().is_empty()).ok_or_else(|| "cloud:missing-url".to_string())?.trim().trim_end_matches('/');
          let url = if raw_url.ends_with("/transcriptions") {
            raw_url.to_string()
          } else {
            format!("{raw_url}/audio/transcriptions")
          };
          let mdl = model.filter(|s| !s.trim().is_empty()).unwrap_or("whisper-1");
          crate::groq::send_to(&client, &url, mdl.trim(), api_key, lang, (bytes, fname, mime)).await
        }
        _ => Err("bad-engine".into()),
      }
    })?;
    resps.push(resp);
    offsets.push(p.offset_ms);
  }
  let lines = crate::cloud_pieces::lines(&resps, &offsets);
  if lines.is_empty() {
    return Err("cloud:empty".into());
  }
  let srt: String = lines
    .iter()
    .enumerate()
    .map(|(n, l)| format!("{}\n{} --> {}\n{}\n\n", n + 1, srt_time(l.start), srt_time(l.end), l.text))
    .collect();
  let words: Vec<Word> = in_order(resps.iter().zip(&offsets).flat_map(|(r, &off)| punctuate(r, off)).collect());
  std::fs::write(stem.with_extension("srt"), &srt).map_err(|e| format!("transcribe:{e}"))?;
  Ok((srt, words))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("transcribe:{e}"))?;
  }
  let mut tmp_os = path.as_os_str().to_os_string();
  tmp_os.push(".tmp");
  let tmp = std::path::PathBuf::from(tmp_os);
  if let Err(e) = std::fs::write(&tmp, bytes) {
    let _ = std::fs::remove_file(&tmp);
    return Err(format!("transcribe:{e}"));
  }
  if let Err(e) = std::fs::rename(&tmp, path) {
    let _ = std::fs::remove_file(&tmp);
    return Err(format!("transcribe:{e}"));
  }
  Ok(())
}

fn compute_plan_id(media_size: u64, media_mtime_secs: u64, wav_samples: u64, piece_secs: u64, lang: &str) -> String {
  let mut h: u64 = 0xcbf29ce484222325;
  let mut mix = |bytes: &[u8]| {
    for &b in bytes {
      h ^= b as u64;
      h = h.wrapping_mul(0x100000001b3);
    }
  };
  mix(&media_size.to_le_bytes());
  mix(&media_mtime_secs.to_le_bytes());
  mix(&wav_samples.to_le_bytes());
  mix(&piece_secs.to_le_bytes());
  mix(lang.as_bytes());
  format!("{h:016x}")
}

fn build_http_client(base_url: Option<&str>) -> Result<reqwest::Client, String> {
  let is_loopback = base_url.is_some_and(|u| {
    let l = u.trim().to_ascii_lowercase();
    l.starts_with("http://127.0.0.1") || l.starts_with("http://localhost") || l.starts_with("http://[::1]")
  });
  let mut builder = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(10 * 60));
  if is_loopback {
    builder = builder.no_proxy();
  }
  builder.build().map_err(|e| format!("cloud:network:{e}"))
}

fn send_cloud_piece(
  client: &reqwest::Client,
  provider_kind: &str,
  api_key: &str,
  base_url: Option<&str>,
  model: Option<&str>,
  lang: &str,
  piece_path: &Path,
) -> Result<Resp, String> {
  let bytes = std::fs::read(piece_path).map_err(|e| format!("extract:{e}"))?;
  let path_str = piece_path.to_string_lossy();
  let (fname, mime) = if path_str.ends_with(".wav") {
    ("audio.wav", "audio/wav")
  } else if path_str.ends_with(".mp3") {
    ("audio.mp3", "audio/mpeg")
  } else {
    ("audio.m4a", "audio/mp4")
  };
  crate::cloud_pieces::until_cancelled(async {
    match provider_kind {
      "groq" => crate::groq::send(client, api_key, lang, (bytes, fname, mime)).await,
      "bailian" => crate::bailian::send(client, api_key, lang, (bytes, fname, mime)).await,
      "custom" => {
        let raw_url = base_url
          .filter(|s| !s.trim().is_empty())
          .ok_or_else(|| "cloud:missing-url".to_string())?
          .trim()
          .trim_end_matches('/');
        let url = if raw_url.ends_with("/transcriptions") {
          raw_url.to_string()
        } else {
          format!("{raw_url}/audio/transcriptions")
        };
        let mdl = model.filter(|s| !s.trim().is_empty()).unwrap_or("whisper-1");
        crate::groq::send_to(client, &url, mdl.trim(), api_key, lang, (bytes, fname, mime)).await
      }
      _ => Err("bad-engine".into()),
    }
  })
}

fn scan_done_pieces(id: &str, plan_id: &str, count: usize, tmp_dir: &Path) -> Vec<usize> {
  let mut done = Vec::new();
  for idx in 0..count {
    let p = tmp_dir.join(format!("{id}.piece.{idx}.json"));
    if let Ok(raw) = std::fs::read_to_string(&p) {
      if let Ok(cached) = serde_json::from_str::<PieceCache>(&raw) {
        if cached.plan_id == plan_id && cached.idx == idx {
          done.push(idx);
        }
      }
    }
  }
  done
}

fn clear_old_piece_caches(id: &str, tmp_dir: &Path) {
  let prefix = format!("{id}.piece.");
  if let Ok(entries) = std::fs::read_dir(tmp_dir) {
    for entry in entries.flatten() {
      let name = entry.file_name();
      let name = name.to_string_lossy();
      if name.starts_with(&prefix) && name.ends_with(".json") {
        let _ = std::fs::remove_file(entry.path());
      }
    }
  }
}

// Loads a valid resumable transcription plan from `tmp/<id>.plan.json` (preserving already-finished
// piece caches across retries and provider switches) or creates and atomically writes a fresh one.
#[allow(dead_code)]
pub(crate) fn plan_or_load(
  id: &str,
  media_path: &Path,
  wav_path: &Path,
  lang: &str,
  piece_secs: u64,
  tmp_dir: &Path,
) -> Result<TranscribePlan, String> {
  let piece_secs = piece_secs.clamp(60, 60 * 60);
  std::fs::create_dir_all(tmp_dir).map_err(|e| format!("extract:{e}"))?;
  let (_, wav_samples) = wav_data(wav_path).map_err(|e| format!("extract:{e}"))?;
  let plan_path = tmp_dir.join(format!("{id}.plan.json"));

  if let Ok(raw) = std::fs::read_to_string(&plan_path) {
    if let Ok(mut existing) = serde_json::from_str::<TranscribePlan>(&raw) {
      if existing.lang == lang
        && existing.piece_secs == piece_secs
        && existing.wav_samples.abs_diff(wav_samples) <= RATE
        && !existing.pieces.is_empty()
      {
        existing.done_indices = scan_done_pieces(id, &existing.plan_id, existing.pieces.len(), tmp_dir);
        return Ok(existing);
      }
    }
  }

  clear_old_piece_caches(id, tmp_dir);
  let (media_size, media_mtime_secs) = std::fs::metadata(media_path)
    .map(|m| {
      let mt = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
      (m.len(), mt)
    })
    .unwrap_or((0, 0));
  let plan_id = compute_plan_id(media_size, media_mtime_secs, wav_samples, piece_secs, lang);
  let pieces = plan_cuts(wav_path, piece_secs)?;
  let plan = TranscribePlan {
    plan_id,
    lang: lang.to_string(),
    piece_secs,
    wav_samples,
    pieces,
    done_indices: Vec::new(),
  };
  let json = serde_json::to_vec(&plan).map_err(|e| format!("transcribe:{e}"))?;
  atomic_write(&plan_path, &json)?;
  Ok(plan)
}

// Uploads a single compressed piece unless `tmp/<id>.piece.<idx>.json` already holds a cache
// matching `plan_id`. Returns Ok(false) when skipped, Ok(true) when newly transcribed.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn transcribe_single_piece(
  id: &str,
  plan_id: &str,
  idx: usize,
  piece_path: &Path,
  offset_ms: u64,
  provider_kind: &str,
  api_key: &str,
  base_url: Option<&str>,
  model: Option<&str>,
  lang: &str,
  tmp_dir: &Path,
) -> Result<bool, String> {
  std::fs::create_dir_all(tmp_dir).map_err(|e| format!("extract:{e}"))?;
  let cache_path = tmp_dir.join(format!("{id}.piece.{idx}.json"));
  if let Ok(raw) = std::fs::read_to_string(&cache_path) {
    if let Ok(cached) = serde_json::from_str::<PieceCache>(&raw) {
      if cached.plan_id == plan_id && cached.idx == idx {
        return Ok(false);
      }
    }
  }
  crate::import_queue::check()?;
  let client = build_http_client(base_url)?;
  let resp = send_cloud_piece(&client, provider_kind, api_key, base_url, model, lang, piece_path)?;
  let cache = PieceCache {
    plan_id: plan_id.to_string(),
    idx,
    offset_ms,
    provider: provider_kind.to_string(),
    resp,
  };
  let json = serde_json::to_vec(&cache).map_err(|e| format!("transcribe:{e}"))?;
  atomic_write(&cache_path, &json)?;
  Ok(true)
}

// Stitches all cached pieces for `id`, applies CJK seam mending, punctuation, timestamp ordering,
// and collapse-only repeat_fix cleanup (never re-transcribing), then atomically writes .srt and .words.json.
#[allow(dead_code)]
pub(crate) fn finalize_plan(id: &str, tmp_dir: &Path, own_dir: &Path) -> Result<(String, Vec<Word>), String> {
  let plan_path = tmp_dir.join(format!("{id}.plan.json"));
  let raw_plan = std::fs::read_to_string(&plan_path).map_err(|e| format!("transcribe:missing-plan:{e}"))?;
  let plan: TranscribePlan = serde_json::from_str(&raw_plan).map_err(|e| format!("transcribe:bad-plan:{e}"))?;
  if plan.pieces.is_empty() {
    return Err("cloud:empty".into());
  }

  let mut resps = Vec::with_capacity(plan.pieces.len());
  let mut offsets = Vec::with_capacity(plan.pieces.len());
  for idx in 0..plan.pieces.len() {
    let cache_path = tmp_dir.join(format!("{id}.piece.{idx}.json"));
    let raw = std::fs::read_to_string(&cache_path).map_err(|_| format!("cloud:missing-piece:{idx}"))?;
    let cached: PieceCache = serde_json::from_str(&raw).map_err(|_| format!("cloud:bad-piece:{idx}"))?;
    if cached.plan_id != plan.plan_id {
      return Err(format!("cloud:stale-piece:{idx}"));
    }
    resps.push(cached.resp);
    offsets.push(cached.offset_ms);
  }

  let lines = crate::cloud_pieces::lines(&resps, &offsets);
  if lines.is_empty() {
    return Err("cloud:empty".into());
  }
  let initial_srt: String = lines
    .iter()
    .enumerate()
    .map(|(n, l)| format!("{}\n{} --> {}\n{}\n\n", n + 1, srt_time(l.start), srt_time(l.end), l.text))
    .collect();
  let words: Vec<Word> = in_order(resps.iter().zip(&offsets).flat_map(|(r, &off)| punctuate(r, off)).collect());

  // Collapse-only repeat_fix pass: keep a single copy of any Whisper repetition loop without re-transcribing.
  let tmp_srt = tmp_dir.join(format!("{id}.collapse.srt.tmp"));
  std::fs::write(&tmp_srt, &initial_srt).map_err(|e| format!("transcribe:{e}"))?;
  let collapsed_res = crate::repeat_fix::fix(
    &tmp_srt,
    if words.is_empty() { None } else { Some(words) },
    |_| {},
    |_, _| Err("collapse-only".into()),
  );
  let collapsed_words = match collapsed_res {
    Ok(w) => w.unwrap_or_default(),
    Err(e) => {
      let _ = std::fs::remove_file(&tmp_srt);
      return Err(e);
    }
  };
  let final_srt = std::fs::read_to_string(&tmp_srt).map_err(|e| format!("transcribe:{e}"))?;
  let _ = std::fs::remove_file(&tmp_srt);
  if final_srt.trim().is_empty() {
    return Err("cloud:empty".into());
  }

  if crate::import_queue::is_tombstoned(id) {
    return Err(crate::import_queue::CANCELLED.into());
  }
  std::fs::create_dir_all(own_dir).map_err(|e| format!("transcribe:{e}"))?;
  atomic_write(&own_dir.join(format!("{id}.srt")), final_srt.as_bytes())?;
  let words_json = serde_json::to_vec(&collapsed_words).map_err(|e| format!("transcribe:{e}"))?;
  atomic_write(&own_dir.join(format!("{id}.words.json")), &words_json)?;
  Ok((final_srt, collapsed_words))
}
// A cut moves at most this far to land in a pause instead of mid-word.
const SLACK_SECS: u64 = 3;

pub(crate) fn transcribe(
  on_pct: impl FnMut(u32),
  provider: Provider,
  api_key: &str,
  lang: &str,
  wav: &Path,
  stem: &Path,
) -> Result<Vec<Word>, String> {
  transcribe_in_pieces(on_pct, provider, api_key, lang, wav, stem, provider.piece_secs())
}

pub(crate) fn transcribe_in_pieces(
  mut on_pct: impl FnMut(u32),
  provider: Provider,
  api_key: &str,
  lang: &str,
  wav: &Path,
  stem: &Path,
  piece_secs: u64,
) -> Result<Vec<Word>, String> {
  let (data_at, samples) = wav_data(wav).map_err(|e| format!("extract:{e}"))?;
  let mut file = std::fs::File::open(wav).map_err(|e| format!("extract:{e}"))?;
  let cuts = cut_points(samples, piece_secs * RATE, SLACK_SECS * RATE, |from, len| {
    read_samples(&mut file, data_at, from, len).unwrap_or_default()
  });

  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    // A 16MB upload on a slow line; generous, but not forever. (Bailian's
    // wait for its queue is polled, not held open, so this covers it too.)
    .timeout(Duration::from_secs(10 * 60))
    .build()
    .map_err(|e| format!("cloud:network:{e}"))?;

  let mut resps: Vec<Resp> = Vec::new();
  let mut offsets: Vec<u64> = Vec::new();
  let pieces: Vec<(u64, u64)> = cuts.windows(2).map(|w| (w[0], w[1])).collect();
  for (i, &(from, to)) in pieces.iter().enumerate() {
    // The card was deleted: send no more pieces (each one costs the user's quota).
    crate::import_queue::check()?;
    let audio = piece_audio(&mut file, data_at, from, to, stem, i)?;
    resps.push(crate::cloud_pieces::until_cancelled(async {
      match provider {
        Provider::Groq => crate::groq::send(&client, api_key, lang, audio).await,
        Provider::Bailian => crate::bailian::send(&client, api_key, lang, audio).await,
      }
    })?);
    offsets.push(from * 1000 / RATE);
    on_pct(((i + 1) * 100 / pieces.len()) as u32);
  }
  // Lines a cut split in two (Chinese / Japanese) come back as one.
  let lines = crate::cloud_pieces::lines(&resps, &offsets);
  if lines.is_empty() {
    return Err("cloud:empty".into());
  }
  let srt: String = lines
    .iter()
    .enumerate()
    .map(|(n, l)| format!("{}\n{} --> {}\n{}\n\n", n + 1, srt_time(l.start), srt_time(l.end), l.text))
    .collect();
  let words: Vec<Word> = resps.iter().zip(&offsets).flat_map(|(r, &off)| punctuate(r, off)).collect();
  std::fs::write(stem.with_extension("srt"), srt).map_err(|e| format!("transcribe:{e}"))?;
  Ok(in_order(words))
}

// ---- audio ----------------------------------------------------------------

// Byte offset and sample count of the PCM data. afconvert writes extra chunks
// (FLLR padding) before `data`, so walk the chunk list instead of assuming 44.
pub(crate) fn wav_data(path: &Path) -> std::io::Result<(u64, u64)> {
  let mut f = std::fs::File::open(path)?;
  let mut head = [0u8; 12];
  f.read_exact(&mut head)?;
  if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
    return Err(std::io::Error::other("not a wav file"));
  }
  let mut pos = 12u64;
  loop {
    let mut ch = [0u8; 8];
    f.read_exact(&mut ch)?;
    let len = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
    if &ch[0..4] == b"data" {
      return Ok((pos + 8, len / 2));
    }
    pos += 8 + len + (len & 1);
    f.seek(SeekFrom::Start(pos))?;
  }
}

fn read_samples(f: &mut std::fs::File, data_at: u64, from: u64, len: u64) -> std::io::Result<Vec<i16>> {
  f.seek(SeekFrom::Start(data_at + from * 2))?;
  let mut bytes = Vec::new();
  f.take(len * 2).read_to_end(&mut bytes)?;
  Ok(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

// Sample positions [0, c1, c2, …, total]. Each cut starts at a multiple of
// `piece` and moves (by at most `slack`) to the quietest 50ms around it; a
// sliver left at the end joins the piece before it.
fn cut_points(total: u64, piece: u64, slack: u64, mut read: impl FnMut(u64, u64) -> Vec<i16>) -> Vec<u64> {
  let mut cuts = vec![0];
  let mut at = piece;
  while at + slack < total {
    let from = at - slack;
    let window = read(from, slack * 2);
    let cut = from + quietest(&window).unwrap_or(slack);
    cuts.push(cut);
    at = cut + piece;
  }
  // A tail under 2s would be a lone upload that Whisper tends to fill with made-up words.
  if cuts.len() > 1 && total - cuts[cuts.len() - 1] < 2 * RATE {
    cuts.pop();
  }
  cuts.push(total);
  cuts
}

// Middle of the lowest-energy 50ms frame, as a sample offset into `samples`.
// On a tie (e.g. all music) the frame nearest the middle wins, so the cut stays put.
fn quietest(samples: &[i16]) -> Option<u64> {
  const FRAME: usize = (RATE / 20) as usize;
  let frames = samples.len() / FRAME;
  (0..frames)
    .min_by_key(|&i| {
      let energy: i64 = samples[i * FRAME..(i + 1) * FRAME].iter().map(|&s| (s as i64).abs()).sum();
      (energy, (2 * i).abs_diff(frames))
    })
    .map(|i| (i * FRAME + FRAME / 2) as u64)
}

// One piece as the bytes to upload, plus its file name and type.
fn piece_audio(
  f: &mut std::fs::File,
  data_at: u64,
  from: u64,
  to: u64,
  stem: &Path,
  i: usize,
) -> Result<(Vec<u8>, &'static str, &'static str), String> {
  let bytes = (to - from) * 2;
  let mut wav = Vec::with_capacity(44 + bytes as usize);
  wav.extend_from_slice(b"RIFF");
  wav.extend_from_slice(&((36 + bytes) as u32).to_le_bytes());
  wav.extend_from_slice(b"WAVEfmt ");
  wav.extend_from_slice(&16u32.to_le_bytes());
  wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
  wav.extend_from_slice(&1u16.to_le_bytes()); // mono
  wav.extend_from_slice(&(RATE as u32).to_le_bytes());
  wav.extend_from_slice(&((RATE * 2) as u32).to_le_bytes());
  wav.extend_from_slice(&2u16.to_le_bytes());
  wav.extend_from_slice(&16u16.to_le_bytes());
  wav.extend_from_slice(b"data");
  wav.extend_from_slice(&(bytes as u32).to_le_bytes());
  f.seek(SeekFrom::Start(data_at + from * 2)).map_err(|e| format!("extract:{e}"))?;
  f.take(bytes).read_to_end(&mut wav).map_err(|e| format!("extract:{e}"))?;
  compress(wav, stem, i)
}

#[cfg(target_os = "macos")]
fn compress(wav: Vec<u8>, stem: &Path, i: usize) -> Result<(Vec<u8>, &'static str, &'static str), String> {
  let tmp_wav = stem.with_extension(format!("part{i}.wav"));
  let tmp_m4a = stem.with_extension(format!("part{i}.m4a"));
  let result = (|| {
    std::fs::write(&tmp_wav, &wav).map_err(|e| e.to_string())?;
    let out = crate::paths::command("/usr/bin/afconvert")
      .args(["-f", "m4af", "-d", "aac", "-b", "32000"])
      .arg(&tmp_wav)
      .arg(&tmp_m4a)
      .output()
      .map_err(|e| e.to_string())?;
    if !out.status.success() {
      return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    std::fs::read(&tmp_m4a).map_err(|e| e.to_string())
  })();
  let _ = std::fs::remove_file(&tmp_wav);
  let _ = std::fs::remove_file(&tmp_m4a);
  result.map(|b| (b, "audio.m4a", "audio/mp4")).map_err(|e| format!("extract:{e}"))
}

#[cfg(not(target_os = "macos"))]
fn compress(wav: Vec<u8>, _stem: &Path, _i: usize) -> Result<(Vec<u8>, &'static str, &'static str), String> {
  Ok((wav, "audio.wav", "audio/wav"))
}

// ---- what every provider hands back ----------------------------------------

// A provider's answer in one shape: its lines (seconds, punctuated text) and
// its words (seconds; spelling may lack punctuation, see punctuate()).
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub(crate) struct Resp {
  #[serde(default)]
  pub(crate) segments: Vec<Seg>,
  #[serde(default)]
  pub(crate) words: Vec<RawWord>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct Seg {
  pub(crate) start: f64,
  pub(crate) end: f64,
  pub(crate) text: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct RawWord {
  pub(crate) word: String,
  pub(crate) start: f64,
  pub(crate) end: f64,
}

// multipart/form-data by hand (reqwest is built without its multipart feature).
pub(crate) fn form_body(boundary: &str, fields: &[(&str, &str)], (file, name, mime): (&[u8], &str, &str)) -> Vec<u8> {
  let mut body = Vec::with_capacity(file.len() + 2048);
  for (k, v) in fields {
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
  }
  body.extend_from_slice(
    format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes(),
  );
  body.extend_from_slice(file);
  body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
  body
}

// ---- words ----------------------------------------------------------------

fn secs_to_ms(s: f64) -> u64 {
  (s.max(0.0) * 1000.0).round() as u64
}

fn srt_time(ms: u64) -> String {
  format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

// Groq's word list carries no punctuation, and for Chinese / Japanese one entry
// may be a single character. Walk the (punctuated) segment text alongside it:
// each word takes its exact spelling from the text plus the punctuation around
// it, and an entry not preceded by a space in the text continues the previous
// word — the same rule the local engine uses for whisper's sub-word tokens —
// except in Chinese / Japanese, where every entry is a word.
// Segments are joined with a space, so a word never runs across two of them.
fn punctuate(resp: &Resp, offset_ms: u64) -> Vec<Word> {
  let text: Vec<char> = resp
    .segments
    .iter()
    .map(|s| s.text.trim())
    .collect::<Vec<_>>()
    .join(" ")
    .chars()
    .collect();
  let letters: Vec<(char, usize)> = text
    .iter()
    .enumerate()
    .filter(|(_, c)| c.is_alphanumeric())
    .flat_map(|(i, c)| c.to_lowercase().map(move |l| (l, i)))
    .collect();

  let mut out: Vec<Word> = Vec::new();
  let mut li = 0usize; // next unused entry in `letters`
  let mut end = 0usize; // text consumed so far
  for raw in &resp.words {
    let want: Vec<char> = raw.word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect();
    if want.is_empty() {
      continue;
    }
    let from = (offset_ms + secs_to_ms(raw.start)) as u32;
    let to = (offset_ms + secs_to_ms(raw.end).max(secs_to_ms(raw.start))) as u32;
    // Look a little ahead: Groq occasionally drops or splits a word differently.
    let found = (li..letters.len().min(li + 40))
      .find(|&s| s + want.len() <= letters.len() && (0..want.len()).all(|k| letters[s + k].0 == want[k]));
    let Some(s) = found else {
      out.push(Word { w: raw.word.trim().to_string(), from, to });
      continue;
    };
    let mut a = letters[s].1;
    let mut b = letters[s + want.len() - 1].1 + 1;
    while a > end && !text[a - 1].is_whitespace() && !text[a - 1].is_alphanumeric() {
      a -= 1; // opening punctuation: ¿ ¡ " (
    }
    while b < text.len() && !text[b].is_whitespace() && !text[b].is_alphanumeric() {
      b += 1; // closing punctuation: , . ? ! "
    }
    // Chinese / Japanese have no spaces, yet each entry stays its own word, timed.
    let joins = a > 0 && a == end && !text[a - 1].is_whitespace() && !out.is_empty() && !crate::import::is_cjk(text[letters[s].1]);
    let piece: String = text[a.max(end)..b].iter().collect();
    if joins {
      let last = out.last_mut().expect("checked non-empty");
      last.w.push_str(&piece);
      last.to = to;
    } else {
      out.push(Word { w: piece.trim().to_string(), from, to });
    }
    li = s + want.len();
    end = b;
  }
  out
}

// A looping stretch sent once more on its own (repeat_fix.rs): its lines and
// words in video time.
pub(crate) fn transcribe_range(
  provider: Provider,
  api_key: &str,
  lang: &str,
  wav: &Path,
  stem: &Path,
  from_ms: u64,
  to_ms: u64,
) -> Result<(Vec<crate::repeat_fix::Cue>, Vec<Word>), String> {
  crate::import_queue::check()?;
  let (data_at, samples) = wav_data(wav).map_err(|e| format!("extract:{e}"))?;
  let mut file = std::fs::File::open(wav).map_err(|e| format!("extract:{e}"))?;
  let (from, to) = ((from_ms * RATE / 1000).min(samples), (to_ms * RATE / 1000).min(samples));
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(10 * 60))
    .build()
    .map_err(|e| format!("cloud:network:{e}"))?;
  let audio = piece_audio(&mut file, data_at, from, to, stem, 0)?;
  let resp = tauri::async_runtime::block_on(async {
    match provider {
      Provider::Groq => crate::groq::send(&client, api_key, lang, audio).await,
      Provider::Bailian => crate::bailian::send(&client, api_key, lang, audio).await,
    }
  })?;
  let offset_ms = from * 1000 / RATE;
  let cues = resp
    .segments
    .iter()
    .filter(|seg| !seg.text.trim().is_empty())
    .map(|seg| crate::repeat_fix::Cue {
      from: offset_ms + secs_to_ms(seg.start),
      to: offset_ms + secs_to_ms(seg.end).max(secs_to_ms(seg.start)),
      text: seg.text.trim().to_string(),
    })
    .collect();
  Ok((cues, in_order(punctuate(&resp, offset_ms))))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn resp(segs: &[&str], words: &[(&str, f64, f64)]) -> Resp {
    Resp {
      segments: segs.iter().map(|t| Seg { start: 0.0, end: 1.0, text: t.to_string() }).collect(),
      words: words.iter().map(|&(w, s, e)| RawWord { word: w.into(), start: s, end: e }).collect(),
    }
  }

  fn texts(w: &[Word]) -> Vec<&str> {
    w.iter().map(|w| w.w.as_str()).collect()
  }

  #[test]
  fn punctuation_comes_back_from_the_text() {
    let r = resp(
      &[" ¿Qué tal? Muy bien,", " gracias."],
      &[("Qué", 0.0, 0.2), ("tal", 0.2, 0.4), ("Muy", 0.5, 0.6), ("bien", 0.6, 0.8), ("gracias", 1.0, 1.4)],
    );
    let w = punctuate(&r, 10_000);
    assert_eq!(texts(&w), ["¿Qué", "tal?", "Muy", "bien,", "gracias."]);
    assert_eq!((w[0].from, w[4].to), (10_000, 11_400));
  }

  #[test]
  fn contractions_and_split_entries_stay_one_word() {
    let r = resp(&[" I don't know."], &[("I", 0.0, 0.1), ("don", 0.1, 0.2), ("'t", 0.2, 0.3), ("know", 0.3, 0.6)]);
    assert_eq!(texts(&punctuate(&r, 0)), ["I", "don't", "know."]);
  }

  #[test]
  fn cjk_entries_stay_separate_words() {
    let r = resp(&["今天天气很好。", "我们走吧！"], &[("今天", 0.0, 0.3), ("天气", 0.3, 0.6), ("很好", 0.6, 0.9), ("我们", 1.0, 1.2), ("走吧", 1.2, 1.5)]);
    let w = punctuate(&r, 0);
    assert_eq!(texts(&w), ["今天", "天气", "很好。", "我们", "走吧！"]);
    assert_eq!((w[4].from, w[4].to), (1200, 1500));
  }

  #[test]
  fn unknown_word_is_kept_not_dropped() {
    let r = resp(&[" Hello world."], &[("Hello", 0.0, 0.5), ("zzz", 0.5, 0.6), ("world", 0.6, 1.0)]);
    assert_eq!(texts(&punctuate(&r, 0)), ["Hello", "zzz", "world."]);
  }

  #[test]
  fn cuts_land_in_the_quiet_and_tails_merge() {
    // 25 "seconds" of loud noise (RATE samples each) with a silent 50ms at 10.2s.
    let total = 25 * RATE;
    let quiet_at = 10 * RATE + RATE / 5;
    let sample = |i: u64| if (quiet_at..quiet_at + RATE / 20).contains(&i) { 0 } else { 1000 };
    let cuts = cut_points(total, 10 * RATE, 3 * RATE, |from, len| (from..from + len).map(sample).collect());
    assert_eq!(cuts[0], 0);
    assert!(cuts[1].abs_diff(quiet_at + RATE / 40) < RATE / 20, "{cuts:?}");
    assert_eq!(*cuts.last().unwrap(), total);
    assert_eq!(cuts.len(), 4);
    // 21s with 10s pieces: the 1s tail joins the second piece.
    let cuts = cut_points(21 * RATE, 10 * RATE, 0, |_, _| Vec::new());
    assert_eq!(cuts, [0, 10 * RATE, 21 * RATE]);
    // Short audio: one piece.
    assert_eq!(cut_points(5 * RATE, 10 * RATE, 3 * RATE, |_, _| Vec::new()), [0, 5 * RATE]);
  }

  #[test]
  fn wav_data_skips_extra_chunks() {
    let dir = std::env::temp_dir().join(format!("lc-wav-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let video = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/speech.m4v");
    let wav = dir.join("s.wav");
    crate::import::extract_wav(&video, &wav, |_| {}).unwrap();
    let (at, n) = wav_data(&wav).unwrap();
    let len = std::fs::metadata(&wav).unwrap().len();
    assert_eq!(at + n * 2, len);
    assert!(n > RATE * 3, "{n} samples");
    let cuts = plan_cuts(&wav, 60 * 60).unwrap();
    assert_eq!(cuts.len(), 1);
    assert_eq!(cuts[0].from_sample, 0);
    assert_eq!(cuts[0].to_sample, n);
    assert_eq!(cuts[0].offset_ms, 0);
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn prepared_pieces_multipart_roundtrip() {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let srv = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut buf = vec![0u8; 16 * 1024];
      let n = stream.read(&mut buf).unwrap();
      let req = String::from_utf8_lossy(&buf[..n]);
      assert!(req.starts_with("POST /v1/audio/transcriptions HTTP/1.1"), "{req}");
      assert!(req.contains("authorization: Bearer test-key") || req.contains("Authorization: Bearer test-key"));
      let body = r#"{"segments":[{"start":0.0,"end":1.5,"text":"Hello Android."}],"words":[{"word":"Hello","start":0.0,"end":0.6},{"word":"Android","start":0.7,"end":1.5}]}"#;
      let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
      );
      stream.write_all(resp.as_bytes()).unwrap();
    });

    let dir = std::env::temp_dir().join(format!("lc-prep-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let piece = dir.join("p0.m4a");
    std::fs::write(&piece, b"fake-m4a-payload").unwrap();
    let stem = dir.join("ep1");
    let (srt, words) = transcribe_prepared_pieces(
      "custom",
      "test-key",
      Some(&format!("http://{addr}/v1")),
      Some("whisper-1"),
      "en",
      &[PreparedPiece { path: piece.to_string_lossy().into_owned(), offset_ms: 1000 }],
      &stem,
    )
    .unwrap();
    srv.join().unwrap();
    assert!(srt.contains("Hello Android."), "{srt}");
    assert_eq!(words.len(), 2);
    assert_eq!((words[0].w.as_str(), words[0].from), ("Hello", 1000));
    assert_eq!((words[1].w.as_str(), words[1].to), ("Android.", 2500));
    std::fs::remove_dir_all(&dir).unwrap();
  }

  fn write_silent_wav(path: &Path, secs: u64) {
    let samples = secs * RATE;
    let data_bytes = (samples * 2) as u32;
    let mut buf = Vec::with_capacity(44 + data_bytes as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    buf.extend_from_slice(b"WAVEfmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&(RATE as u32).to_le_bytes());
    buf.extend_from_slice(&((RATE * 2) as u32).to_le_bytes());
    buf.extend_from_slice(&2u16.to_le_bytes());
    buf.extend_from_slice(&16u16.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_bytes.to_le_bytes());
    buf.resize(44 + data_bytes as usize, 0);
    std::fs::write(path, buf).unwrap();
  }

  #[test]
  fn resumable_plan_skips_done_switches_provider_invalidates_lang_and_collapses() {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::{
      atomic::{AtomicUsize, Ordering},
      Arc,
    };

    let dir = std::env::temp_dir().join(format!("lc-resume-{}", uuid::Uuid::new_v4()));
    let tmp_dir = dir.join("tmp");
    let own_dir = dir.join("own");
    std::fs::create_dir_all(&tmp_dir).unwrap();
    std::fs::create_dir_all(&own_dir).unwrap();
    let media = dir.join("ep.m4a");
    std::fs::write(&media, b"fake-media-bytes").unwrap();
    let wav = tmp_dir.join("job1.wav");
    // 130 seconds with 60s pieces => 2 pieces ([0..60s], [60s..130s] or 3 pieces).
    write_silent_wav(&wav, 130);

    let plan1 = plan_or_load("job1", &media, &wav, "zh", 60, &tmp_dir).unwrap();
    assert!(plan1.pieces.len() >= 2, "{:?}", plan1.pieces);
    assert!(plan1.done_indices.is_empty());

    // Mock HTTP server returning piece responses:
    // - Piece 0 ends mid-CJK sentence ("今天我们去")
    // - Piece 1 starts with continuation ("公园散步。") plus a 4x repeated loop line to verify repeat_fix collapse
    let req_count = Arc::new(AtomicUsize::new(0));
    let req_count_srv = req_count.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let total_pieces = plan1.pieces.len();
    let srv = std::thread::spawn(move || {
      for i in 0..total_pieces {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = vec![0u8; 16 * 1024];
        let _ = stream.read(&mut buf).unwrap();
        req_count_srv.fetch_add(1, Ordering::SeqCst);
        let body = if i == 0 {
          r#"{"segments":[{"start":0.0,"end":2.0,"text":"你好。"},{"start":57.0,"end":59.95,"text":"今天我们去"}],"words":[{"word":"你好","start":0.0,"end":2.0},{"word":"今天","start":57.0,"end":58.0},{"word":"我们","start":58.0,"end":59.0},{"word":"去","start":59.0,"end":59.95}]}"#
        } else if i == 1 {
          r#"{"segments":[{"start":0.05,"end":2.0,"text":"公园散步。"},{"start":3.0,"end":4.0,"text":"重复的句子。"},{"start":4.0,"end":5.0,"text":"重复的句子。"},{"start":5.0,"end":6.0,"text":"重复的句子。"},{"start":6.0,"end":7.0,"text":"重复的句子。"}],"words":[{"word":"公园","start":0.05,"end":1.0},{"word":"散步","start":1.0,"end":2.0},{"word":"重复的句子","start":3.0,"end":4.0},{"word":"重复的句子","start":4.0,"end":5.0},{"word":"重复的句子","start":5.0,"end":6.0},{"word":"重复的句子","start":6.0,"end":7.0}]}"#
        } else {
          r#"{"segments":[{"start":0.5,"end":1.5,"text":"结束了。"}],"words":[{"word":"结束","start":0.5,"end":1.0},{"word":"了","start":1.0,"end":1.5}]}"#
        };
        let resp = format!(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
          body.len(),
          body
        );
        stream.write_all(resp.as_bytes()).unwrap();
      }
    });

    let piece_file = tmp_dir.join("piece.m4a");
    std::fs::write(&piece_file, b"fake-aac").unwrap();
    let base = format!("http://{addr}/v1");

    // 1. Transcribe piece 0.
    let sent0 = transcribe_single_piece(
      "job1",
      &plan1.plan_id,
      0,
      &piece_file,
      plan1.pieces[0].offset_ms,
      "custom",
      "k1",
      Some(&base),
      Some("whisper-1"),
      "zh",
      &tmp_dir,
    )
    .unwrap();
    assert!(sent0);
    assert_eq!(req_count.load(Ordering::SeqCst), 1);

    // 2. Reload plan: same lang & wav -> reuses plan_id and reports piece 0 done.
    let plan_reloaded = plan_or_load("job1", &media, &wav, "zh", 60, &tmp_dir).unwrap();
    assert_eq!(plan_reloaded.plan_id, plan1.plan_id);
    assert_eq!(plan_reloaded.done_indices, vec![0]);

    // 3. Calling transcribe_single_piece for piece 0 again (even after switching provider to "groq") MUST skip without HTTP.
    let skipped0 = transcribe_single_piece(
      "job1",
      &plan_reloaded.plan_id,
      0,
      &piece_file,
      plan1.pieces[0].offset_ms,
      "groq",
      "other-key",
      None,
      None,
      "zh",
      &tmp_dir,
    )
    .unwrap();
    assert!(!skipped0);
    assert_eq!(req_count.load(Ordering::SeqCst), 1);

    // 4. Transcribe remaining pieces.
    for p in &plan_reloaded.pieces[1..] {
      let sent = transcribe_single_piece(
        "job1",
        &plan_reloaded.plan_id,
        p.index,
        &piece_file,
        p.offset_ms,
        "custom",
        "k2",
        Some(&base),
        Some("whisper-1"),
        "zh",
        &tmp_dir,
      )
      .unwrap();
      assert!(sent);
    }
    srv.join().unwrap();
    assert_eq!(req_count.load(Ordering::SeqCst), total_pieces);

    // 5. Finalize: CJK seam joined ("今天我们去公园散步。"), 4x repeated line collapsed to 1 copy, files atomically written.
    let (srt, words) = finalize_plan("job1", &tmp_dir, &own_dir).unwrap();
    assert!(srt.contains("今天我们去公园散步。"), "CJK seam not joined:\n{srt}");
    assert_eq!(srt.matches("重复的句子。").count(), 1, "repeat_fix collapse failed:\n{srt}");
    assert!(!words.is_empty());
    assert_eq!(std::fs::read_to_string(own_dir.join("job1.srt")).unwrap(), srt);
    assert!(own_dir.join("job1.words.json").is_file());

    // 6. Changing language invalidates plan and wipes old piece caches.
    let plan_en = plan_or_load("job1", &media, &wav, "en", 60, &tmp_dir).unwrap();
    assert_ne!(plan_en.plan_id, plan1.plan_id);
    assert!(plan_en.done_indices.is_empty());
    assert!(!tmp_dir.join("job1.piece.0.json").exists());

    std::fs::remove_dir_all(&dir).unwrap();
  }
}
