// Puts a transcript's word times in order (the front end relies on it); used by
// the cloud engines (cloud_asr.rs) and the local one (import.rs read_words).
use crate::import::Word;

// Word times in order (the front end relies on it); shared with the local
// engine (import.rs read_words). Words often start 0.1–0.3s before the previous
// one does: nudge those forward. Bigger jumps are glitches — measured on Groq
// Japanese: a phrase stretched over a pause, then repeated at its real time.
// Keep the longest run of start times that never goes back, and drop the rest:
// the fewest words lost, whichever side the strays are on.
pub(crate) fn in_order(mut words: Vec<Word>) -> Vec<Word> {
  for i in 1..words.len() {
    let prev = words[i - 1].from;
    if words[i].from < prev && words[i].from + 1000 >= prev {
      words[i].from = prev;
    }
  }
  // Longest non-decreasing subsequence by `from` (patience sorting).
  let mut tails: Vec<usize> = Vec::new();
  let mut parent: Vec<Option<usize>> = vec![None; words.len()];
  for i in 0..words.len() {
    let k = tails.partition_point(|&t| words[t].from <= words[i].from);
    parent[i] = k.checked_sub(1).map(|k| tails[k]);
    if k == tails.len() {
      tails.push(i);
    } else {
      tails[k] = i;
    }
  }
  let mut keep = vec![false; words.len()];
  let mut at = tails.last().copied();
  while let Some(i) = at {
    keep[i] = true;
    at = parent[i];
  }
  let total = words.len();
  let out: Vec<Word> = words
    .into_iter()
    .zip(keep)
    .filter_map(|(mut w, k)| k.then(|| {
      w.to = w.to.max(w.from);
      w
    }))
    .collect();
  if out.len() < total {
    log::warn!("word times ran backwards; dropped {} words", total - out.len());
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn timed(t: &[u32]) -> Vec<Word> {
    t.iter().enumerate().map(|(i, &f)| Word { w: i.to_string(), from: f, to: f + 200 }).collect()
  }

  fn froms(w: &[Word]) -> Vec<(&str, u32)> {
    w.iter().map(|w| (w.w.as_str(), w.from)).collect()
  }

  #[test]
  fn word_times_in_order_stay_as_they_are() {
    assert_eq!(froms(&in_order(timed(&[0, 300, 300, 900]))), [("0", 0), ("1", 300), ("2", 300), ("3", 900)]);
    assert!(in_order(Vec::new()).is_empty());
  }

  #[test]
  fn small_overlaps_are_nudged_forward() {
    let w = in_order(timed(&[1000, 1500, 1300, 1200, 2000]));
    assert_eq!(froms(&w), [("0", 1000), ("1", 1500), ("2", 1500), ("3", 1500), ("4", 2000)]);
    assert!(w.iter().all(|w| w.to >= w.from));
  }

  #[test]
  fn a_glitch_drops_only_the_words_it_contradicts() {
    // Groq on Japanese (real response, 25-minute episode): ほ んと に し ず か ね。
    // stretched over a pause up to 375s, then どう 静 香 ちゃん 本当 に 静 か ね from 367s.
    let t = [348_720, 351_520, 356_940, 374_420, 374_660, 374_880, 375_000, 375_200, 367_480, 371_840, 372_480, 372_620, 373_920, 374_380, 374_660, 374_960, 375_180, 376_020];
    let w = in_order(timed(&t));
    assert!(w.windows(2).all(|p| p[1].from >= p[0].from));
    assert!(w.len() >= t.len() - 6, "{:?}", froms(&w));
    assert_eq!(w.last().unwrap().from, 376_020);
  }

  #[test]
  fn many_words_run_ahead_then_time_comes_back() {
    // 30 good words, 25 placed far in the future, then 100 good words: only the 25 go.
    let t: Vec<u32> = (0..30).map(|i| i * 500).chain((0..25).map(|i| 900_000 + i * 500)).chain((30..130).map(|i| i * 500)).collect();
    let w = in_order(timed(&t));
    assert_eq!(w.len(), 130);
    assert!(w.iter().all(|w| w.from < 900_000));
  }

  #[test]
  fn one_word_far_behind_goes_alone() {
    let w = in_order(timed(&[10_000, 10_500, 11_000, 11_500, 12_000, 12_500, 13_000, 13_500, 500, 14_000]));
    assert_eq!(w.len(), 9);
    assert!(w.iter().all(|w| w.w != "8"));
    // And one far ahead.
    assert_eq!(froms(&in_order(timed(&[1000, 2000, 900_000, 3000, 4000]))), [("0", 1000), ("1", 2000), ("3", 3000), ("4", 4000)]);
  }
}
