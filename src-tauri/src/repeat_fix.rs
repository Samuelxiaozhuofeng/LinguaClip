// Whisper sometimes gets stuck and writes one phrase or one line over and over
// (seen: the same sentence 74 times). After transcribing, find those stretches,
// transcribe just that audio again, and keep a single copy of whatever still
// repeats. Nothing found = nothing touched. See docs/import.md「复读机字幕」.
use std::path::{Path, PathBuf};

use crate::import::{is_cjk, Word};

// The same phrase this many times in a row inside one line is a loop.
const PHRASE_REPS: usize = 4;
// Longest phrase looked for, in tokens (a word, or one Chinese / Japanese character).
const MAX_UNIT: usize = 40;
// The same line this many times in a row is a loop.
const LINE_REPS: usize = 3;
// Audio kept on each side of a looping stretch when it is transcribed again.
const PAD_MS: u64 = 3000;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Cue {
  pub(crate) from: u64,
  pub(crate) to: u64,
  pub(crate) text: String,
}

fn srt_ms(t: &str) -> Option<u64> {
  let (hms, ms) = t.trim().split_once([',', '.'])?;
  let mut secs = 0u64;
  for part in hms.split(':') {
    secs = secs * 60 + part.trim().parse::<u64>().ok()?;
  }
  Some(secs * 1000 + ms.trim().parse::<u64>().ok()?)
}

pub(crate) fn parse_srt(s: &str) -> Vec<Cue> {
  let mut cues = Vec::new();
  for block in s.replace("\r\n", "\n").split("\n\n") {
    let lines: Vec<&str> = block.lines().collect();
    let Some(i) = lines.iter().position(|l| l.contains("-->")) else { continue };
    let Some((a, b)) = lines[i].split_once("-->") else { continue };
    let (Some(from), Some(to)) = (srt_ms(a), srt_ms(b.split_whitespace().next().unwrap_or(""))) else { continue };
    let text = lines[i + 1..].join("\n").trim().to_string();
    cues.push(Cue { from, to, text });
  }
  cues
}

fn srt_time(ms: u64) -> String {
  format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

pub(crate) fn write_srt(cues: &[Cue]) -> String {
  cues
    .iter()
    .enumerate()
    .map(|(i, c)| format!("{}\n{} --> {}\n{}\n\n", i + 1, srt_time(c.from), srt_time(c.to), c.text))
    .collect()
}

// Words of the text, lowercased, with their byte ranges: each Chinese / Japanese
// character on its own, letters and digits run together, the rest only separates.
fn tokens(text: &str) -> Vec<(String, usize, usize)> {
  let mut out: Vec<(String, usize, usize)> = Vec::new();
  let mut open = false;
  let mut chars = text.char_indices().peekable();
  while let Some((i, c)) = chars.next() {
    let end = i + c.len_utf8();
    // it's, don't: an apostrophe between letters stays in the word.
    let inner = matches!(c, '\'' | '’') && open && chars.peek().is_some_and(|&(_, n)| n.is_alphanumeric() && !is_cjk(n));
    if inner {
      let t = out.last_mut().expect("open token");
      t.0.push('\'');
      t.2 = end;
    } else if is_cjk(c) {
      out.push((c.to_string(), i, end));
      open = false;
    } else if c.is_alphanumeric() {
      match out.last_mut() {
        Some(t) if open => {
          t.0.extend(c.to_lowercase());
          t.2 = end;
        }
        _ => out.push((c.to_lowercase().collect(), i, end)),
      }
      open = true;
    } else {
      open = false;
    }
  }
  out
}

// First phrase repeated PHRASE_REPS+ times in a row: (start, phrase length, times).
// A single repeated token ("no no no no", 哈哈哈哈) is speech, not a loop, and
// so is a two-character Chinese / Japanese phrase (はいはいはいはい).
fn phrase_loop(toks: &[&str]) -> Option<(usize, usize, usize)> {
  let n = toks.len();
  for s in 0..n {
    for u in 2..=MAX_UNIT {
      if s + u * PHRASE_REPS > n {
        break;
      }
      let unit = &toks[s..s + u];
      // "ha ha ha ha" as a two-token phrase is still one token repeated.
      if (1..u).any(|p| u % p == 0 && (p..u).all(|i| unit[i] == unit[i - p])) {
        continue;
      }
      if u < 3 && unit.iter().all(|t| t.chars().all(is_cjk)) {
        continue;
      }
      let mut r = 1;
      while s + u * (r + 1) <= n && toks[s + u * r..s + u * (r + 1)] == *unit {
        r += 1;
      }
      if r >= PHRASE_REPS {
        return Some((s, u, r));
      }
    }
  }
  None
}

fn key(text: &str) -> Vec<String> {
  tokens(text).into_iter().map(|t| t.0).collect()
}

fn line_phrase_loop(text: &str) -> Option<(usize, usize, usize)> {
  let k = key(text);
  phrase_loop(&k.iter().map(String::as_str).collect::<Vec<_>>())
}

// Runs [a, b) of LINE_REPS+ identical lines.
fn line_runs(cues: &[Cue]) -> Vec<(usize, usize)> {
  let keys: Vec<Vec<String>> = cues.iter().map(|c| key(&c.text)).collect();
  let mut runs = Vec::new();
  let mut a = 0;
  while a < keys.len() {
    let mut b = a + 1;
    while b < keys.len() && keys[b] == keys[a] {
      b += 1;
    }
    if !keys[a].is_empty() && b - a >= LINE_REPS {
      runs.push((a, b));
    }
    a = b;
  }
  runs
}

// Looping lines as cue index ranges [a, b), in order.
pub(crate) fn find_loops(cues: &[Cue]) -> Vec<(usize, usize)> {
  let mut out = line_runs(cues);
  for (i, c) in cues.iter().enumerate() {
    if !out.iter().any(|&(a, b)| (a..b).contains(&i)) && line_phrase_loop(&c.text).is_some() {
      out.push((i, i + 1));
    }
  }
  out.sort();
  out
}

// Stretches of time (ms) to transcribe again; ones close together become one.
fn regions(cues: &[Cue]) -> Vec<(u64, u64)> {
  let mut out: Vec<(u64, u64)> = Vec::new();
  for (a, b) in find_loops(cues) {
    let (from, to) = (cues[a].from, cues[a..b].iter().map(|c| c.to).max().unwrap_or(cues[a].to));
    match out.last_mut() {
      Some(last) if from <= last.1 + 2 * PAD_MS => last.1 = last.1.max(to),
      _ => out.push((from, to)),
    }
  }
  out
}

// The line a word belongs to: the first one that has not ended by its middle.
fn owner(cues: &[Cue], w: &Word) -> usize {
  let mid = (w.from as u64 + w.to as u64) / 2;
  cues.iter().position(|c| c.to > mid).unwrap_or(cues.len().saturating_sub(1))
}

// Keeps one copy of every loop still there: the first of identical lines (with
// its words), the first of a repeated phrase (cut the same way in the words).
pub(crate) fn collapse(cues: Vec<Cue>, words: Option<Vec<Word>>) -> (Vec<Cue>, Option<Vec<Word>>) {
  let mut drop_cue = vec![false; cues.len()];
  for (a, b) in line_runs(&cues) {
    drop_cue[a + 1..b].iter_mut().for_each(|d| *d = true);
  }
  let words = words.map(|ws| {
    let owners: Vec<usize> = ws.iter().map(|w| owner(&cues, w)).collect();
    let mut keep: Vec<bool> = owners.iter().map(|&o| !drop_cue.get(o).copied().unwrap_or(false)).collect();
    for ci in 0..cues.len() {
      if drop_cue[ci] {
        continue;
      }
      loop {
        // Every token of this line's remaining words, with the word it came from.
        let idx: Vec<usize> = (0..ws.len()).filter(|&i| keep[i] && owners[i] == ci).collect();
        let toks: Vec<(String, usize)> = idx.iter().flat_map(|&i| key(&ws[i].w).into_iter().map(move |t| (t, i))).collect();
        let Some((s, u, r)) = phrase_loop(&toks.iter().map(|t| t.0.as_str()).collect::<Vec<_>>()) else { break };
        // A word goes when its first token is in a copy after the first.
        let mut first_tok = std::collections::HashMap::new();
        for (k, t) in toks.iter().enumerate() {
          first_tok.entry(t.1).or_insert(k);
        }
        let mut removed = false;
        for (&wi, &k) in &first_tok {
          if (s + u..s + u * r).contains(&k) {
            keep[wi] = false;
            removed = true;
          }
        }
        if !removed {
          break;
        }
      }
    }
    ws.into_iter().zip(keep).filter_map(|(w, k)| k.then_some(w)).collect()
  });
  let cues = cues
    .into_iter()
    .zip(drop_cue)
    .filter_map(|(mut c, d)| {
      if d {
        return None;
      }
      while let Some((s, u, r)) = line_phrase_loop(&c.text) {
        let t = tokens(&c.text);
        // "I know, I know, I know, I know." → "I know."
        c.text = format!("{}{}", &c.text[..t[s + u - 1].2], &c.text[t[s + u * r - 1].2..]);
      }
      Some(c)
    })
    .collect();
  (cues, words)
}

// The padding lets the redo hear a word of the line next door again
// ("…en Ciudad Nezahualcóyotl" + "Nezahualcóyotl porque venimos"). Where the
// new lines meet the old ones with the same word on both sides, close in time,
// the new side's copy goes (text and word). A lone Chinese / Japanese
// character is too common to tell a repeat from speech, so those stay.
// ponytail: one word only; a longer overlap would need a longest-match.
fn trim_edges(prev: Option<&Cue>, next: Option<&Cue>, c: &mut Vec<Cue>, w: &mut Vec<Word>) {
  const NEAR_MS: u64 = 1000;
  let same = |tok: &str, word: Option<&Word>| word.is_some_and(|x| key(&x.w) == [tok]);
  if let (Some(p), Some(first)) = (prev, c.first_mut()) {
    let (a, b) = (tokens(&p.text), tokens(&first.text));
    if let (Some(x), Some(y)) = (a.last(), b.first()) {
      if x.0 == y.0 && !x.0.chars().all(is_cjk) && first.from <= p.to + NEAR_MS {
        // Whatever punctuation the cut word leaves goes too, opening marks of the next word stay.
        first.text = first.text[y.2..].trim_start_matches(|ch: char| !ch.is_alphanumeric() && !"¿¡(\"“「『".contains(ch)).to_string();
        if same(&y.0, w.first()) {
          w.remove(0);
        }
      }
    }
  }
  if let (Some(n), Some(last)) = (next, c.last_mut()) {
    let (a, b) = (tokens(&last.text), tokens(&n.text));
    if let (Some(x), Some(y)) = (a.last(), b.first()) {
      if x.0 == y.0 && !x.0.chars().all(is_cjk) && n.from <= last.to + NEAR_MS {
        last.text = last.text[..x.1].trim_end().trim_end_matches([',', ';', ':']).trim_end().to_string();
        if same(&x.0, w.last()) {
          w.pop();
        }
      }
    }
  }
  c.retain(|c| !key(&c.text).is_empty());
  // A line emptied by the cut takes its words with it.
  w.retain(|w| c.iter().any(|c| covers(c, w)));
}

// A word belongs to a line when its middle is within the line's time.
fn covers(c: &Cue, w: &Word) -> bool {
  (c.from..=c.to).contains(&((w.from as u64 + w.to as u64) / 2))
}

// Finds loops in the .srt at `srt`, has each stretch transcribed again by
// `redo(from_ms, to_ms)` (lines and words in video time), puts the new lines in
// place of the old, keeps one copy of what still repeats, and rewrites the file.
// No loop = the file is not touched and `on_pct` never called. A failed redo
// only means that stretch is collapsed; Err is a cancel or an unwritable file.
pub(crate) fn fix(
  srt: &Path,
  mut words: Option<Vec<Word>>,
  mut on_pct: impl FnMut(u32),
  mut redo: impl FnMut(u64, u64) -> Result<(Vec<Cue>, Vec<Word>), String>,
) -> Result<Option<Vec<Word>>, String> {
  let text = std::fs::read_to_string(srt).map_err(|e| format!("transcribe:{e}"))?;
  let mut cues = parse_srt(&text);
  let regions = regions(&cues);
  if regions.is_empty() {
    return Ok(words);
  }
  for (i, &(from, to)) in regions.iter().enumerate() {
    crate::import_queue::check()?;
    on_pct((i * 100 / regions.len()) as u32);
    let inside = |a: u64, b: u64| (from..=to).contains(&((a + b) / 2));
    let fresh = redo(from.saturating_sub(PAD_MS), to + PAD_MS).and_then(|(c, w)| {
      // New lines by their middle; new words by the kept lines they sit in, so
      // a line across the edge keeps all of its words and no word is orphaned.
      let c: Vec<Cue> = c.into_iter().filter(|c| inside(c.from, c.to)).collect();
      let w: Vec<Word> = w.into_iter().filter(|w| c.iter().any(|c| covers(c, w))).collect();
      // Nothing heard, or lines without the words the rest of the video has:
      // keeping the old lines (collapsed) beats a hole.
      if c.is_empty() || (words.is_some() && w.is_empty()) {
        return Err("nothing came back".into());
      }
      Ok((c, w))
    });
    match fresh {
      Ok((mut c, mut w)) => {
        // Old words go by the old lines that go: everything from the first to
        // the end of the last (gaps between looped lines included).
        let gone = cues.iter().filter(|o| inside(o.from, o.to));
        let span = (gone.clone().map(|o| o.from).min().unwrap_or(from), gone.map(|o| o.to).max().unwrap_or(to));
        cues.retain(|old| !inside(old.from, old.to));
        let prev = cues.iter().filter(|o| o.from < from).last();
        let next = cues.iter().find(|o| o.from >= from);
        trim_edges(prev, next, &mut c, &mut w);
        cues.extend(c);
        cues.sort_by_key(|c| c.from);
        if let Some(ws) = &mut words {
          ws.retain(|old| !(span.0..span.1).contains(&((old.from as u64 + old.to as u64) / 2)));
          ws.extend(w);
          ws.sort_by_key(|w| w.from);
        }
      }
      Err(e) => {
        crate::import_queue::check()?;
        log::error!("re-transcribing {from}-{to}ms failed, keeping one copy: {e}");
      }
    }
  }
  on_pct(100);
  let (cues, words) = collapse(cues, words);
  std::fs::write(srt, write_srt(&cues)).map_err(|e| format!("transcribe:{e}"))?;
  Ok(words.filter(|w| !w.is_empty()))
}

// This machine: just that stretch, without VAD, without carried-over context
// (-mc 0) and quicker to fall back to a higher temperature (-et 2.8).
pub(crate) fn redo_local(
  whisper: &Path,
  model: &Path,
  dtw: &str,
  lang: &str,
  wav: &Path,
  stem: &Path,
  from_ms: u64,
  to_ms: u64,
) -> Result<(Vec<Cue>, Vec<Word>), String> {
  // Appended, never with_extension: a stem with a dot in it would otherwise
  // name the import's own wav / srt.
  let named = |ext: &str| {
    let mut name = stem.as_os_str().to_owned();
    name.push(format!("-fix{ext}"));
    PathBuf::from(name)
  };
  let (out, clip) = (named(""), named(".wav"));
  let result = (|| {
    write_wav_slice(wav, from_ms, to_ms, &clip)?;
    crate::import::run_whisper(&mut |_| {}, whisper, model, None, &["-et", "2.8"], dtw, lang, &clip, &out)?;
    let srt = std::fs::read_to_string(named(".srt")).map_err(|e| format!("transcribe:{e}"))?;
    let cues = parse_srt(&srt).into_iter().map(|c| Cue { from: c.from + from_ms, to: c.to + from_ms, ..c }).collect();
    let words = crate::import::read_words(&named(".json"))
      .unwrap_or_default()
      .into_iter()
      .map(|w| Word { from: w.from + from_ms as u32, to: w.to + from_ms as u32, ..w })
      .collect();
    Ok((cues, words))
  })();
  for ext in [".wav", ".srt", ".json"] {
    let _ = std::fs::remove_file(named(ext));
  }
  result
}

// Samples of the 16k mono wav between the two times (cut off at the end), as a wav of their own.
fn write_wav_slice(wav: &Path, from_ms: u64, to_ms: u64, out: &Path) -> Result<(), String> {
  use std::io::{Read, Seek, SeekFrom};
  const RATE: u64 = crate::cloud_asr::RATE;
  let (data_at, samples) = crate::cloud_asr::wav_data(wav).map_err(|e| format!("extract:{e}"))?;
  let (from, to) = ((from_ms * RATE / 1000).min(samples), (to_ms * RATE / 1000).min(samples));
  let bytes = (to - from) * 2;
  let mut buf = Vec::with_capacity(44 + bytes as usize);
  buf.extend_from_slice(b"RIFF");
  buf.extend_from_slice(&((36 + bytes) as u32).to_le_bytes());
  buf.extend_from_slice(b"WAVEfmt ");
  buf.extend_from_slice(&16u32.to_le_bytes());
  buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
  buf.extend_from_slice(&1u16.to_le_bytes()); // mono
  buf.extend_from_slice(&(RATE as u32).to_le_bytes());
  buf.extend_from_slice(&((RATE * 2) as u32).to_le_bytes());
  buf.extend_from_slice(&2u16.to_le_bytes());
  buf.extend_from_slice(&16u16.to_le_bytes());
  buf.extend_from_slice(b"data");
  buf.extend_from_slice(&(bytes as u32).to_le_bytes());
  let mut f = std::fs::File::open(wav).map_err(|e| format!("extract:{e}"))?;
  f.seek(SeekFrom::Start(data_at + from * 2)).map_err(|e| format!("extract:{e}"))?;
  f.take(bytes).read_to_end(&mut buf).map_err(|e| format!("extract:{e}"))?;
  std::fs::write(out, buf).map_err(|e| format!("extract:{e}"))
}

#[cfg(test)]
#[path = "repeat_fix_tests.rs"]
mod tests;
