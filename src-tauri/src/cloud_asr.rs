// Cloud transcription (Settings → Transcription): Groq's hosted Whisper or
// Alibaba Cloud Bailian's Qwen3-ASR. The 16k mono wav import.rs extracted is
// cut into pieces that each fit one upload, at a quiet spot near each cut, sent
// one by one, and stitched back into the same .srt file and word list the local
// engine gives. The providers themselves live in groq.rs and bailian.rs.
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use tauri_plugin_http::reqwest;

use crate::import::Word;

pub(crate) const RATE: u64 = 16_000; // samples per second, mono 16-bit (extract_wav)

#[derive(Clone, Copy)]
pub(crate) enum Provider {
  Groq,
  Bailian,
}

impl Provider {
  // macOS compresses each piece to AAC (~36kbps measured → ~16MB an hour);
  // elsewhere pieces go up as plain wav (32KB/s). Groq's free tier takes 25MB
  // an upload (11 minutes of wav); Bailian takes 1GB, so an hour is plenty.
  fn piece_secs(self) -> u64 {
    match self {
      Self::Groq if cfg!(target_os = "macos") => 60 * 60,
      Self::Groq => 11 * 60,
      Self::Bailian => 60 * 60,
    }
  }
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

  let mut srt = String::new();
  let mut cues = 0usize;
  let mut words: Vec<Word> = Vec::new();
  let pieces: Vec<(u64, u64)> = cuts.windows(2).map(|w| (w[0], w[1])).collect();
  for (i, &(from, to)) in pieces.iter().enumerate() {
    let audio = piece_audio(&mut file, data_at, from, to, stem, i)?;
    let resp = tauri::async_runtime::block_on(async {
      match provider {
        Provider::Groq => crate::groq::send(&client, api_key, lang, audio).await,
        Provider::Bailian => crate::bailian::send(&client, api_key, lang, audio).await,
      }
    })?;
    let offset_ms = from * 1000 / RATE;
    for seg in &resp.segments {
      let text = seg.text.trim();
      if text.is_empty() {
        continue;
      }
      cues += 1;
      let start = offset_ms + secs_to_ms(seg.start);
      let end = offset_ms + secs_to_ms(seg.end).max(secs_to_ms(seg.start));
      srt.push_str(&format!("{cues}\n{} --> {}\n{text}\n\n", srt_time(start), srt_time(end)));
    }
    words.extend(punctuate(&resp, offset_ms));
    on_pct(((i + 1) * 100 / pieces.len()) as u32);
  }
  if cues == 0 {
    return Err("cloud:empty".into());
  }
  std::fs::write(stem.with_extension("srt"), srt).map_err(|e| format!("transcribe:{e}"))?;
  // Groq's word times overlap a little (a word often starts 0.1–0.3s before
  // the previous one does); nudge those into order. A bigger jump backwards
  // means the list is off, and as with the local engine, no word timings beat
  // wrong ones: the lines would jump around the video.
  let mut prev = 0u32;
  for w in words.iter_mut() {
    if w.from + 1000 < prev {
      log::error!("cloud words run backwards at {}ms, dropping word timings", w.from);
      return Ok(Vec::new());
    }
    w.from = w.from.max(prev);
    w.to = w.to.max(w.from);
    prev = w.from;
  }
  Ok(words)
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
#[derive(serde::Deserialize, Default)]
pub(crate) struct Resp {
  #[serde(default)]
  pub(crate) segments: Vec<Seg>,
  #[serde(default)]
  pub(crate) words: Vec<RawWord>,
}

#[derive(serde::Deserialize)]
pub(crate) struct Seg {
  pub(crate) start: f64,
  pub(crate) end: f64,
  pub(crate) text: String,
}

#[derive(serde::Deserialize)]
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
// word — the same rule the local engine uses for whisper's sub-word tokens.
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
    let joins = a > 0 && a == end && !text[a - 1].is_whitespace() && !out.is_empty();
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
  fn cjk_characters_merge_per_segment() {
    let r = resp(&["今天天气很好。", "我们走吧！"], &[("今天", 0.0, 0.3), ("天气", 0.3, 0.6), ("很好", 0.6, 0.9), ("我们", 1.0, 1.2), ("走吧", 1.2, 1.5)]);
    let w = punctuate(&r, 0);
    assert_eq!(texts(&w), ["今天天气很好。", "我们走吧！"]);
    assert_eq!((w[1].from, w[1].to), (1000, 1500));
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
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
