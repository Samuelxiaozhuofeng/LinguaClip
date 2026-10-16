// repeat_fix as it was before words were handed to lines by their letters.
// Kept as is for every case those letters do not line up (cloud text and words
// differ, a word dropped, no words at all), so that output stays byte for byte
// what it was. See docs/import.md「复读机字幕」.
use std::path::Path;

use super::{covers, key, line_phrase_loop, line_runs, parse_srt, phrase_loop, regions, tokens, write_srt, Cue, PAD_MS};
use crate::import::{is_cjk, Word};

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
