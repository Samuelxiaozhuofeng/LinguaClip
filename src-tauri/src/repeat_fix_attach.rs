// Which subtitle line each word was said in, for repeat_fix: the words'
// letters lined up with the lines' letters.
use super::{key, Cue};
use crate::import::Word;

// A subtitle line with the words said in it, in order. Which line a word is in
// is settled once (attach) and carried through every step after it: nothing
// guesses it again from a word's time.
pub(crate) struct Line {
  pub(crate) cue: Cue,
  pub(crate) words: Vec<Word>,
}

fn spell(text: &str) -> String {
  key(text).concat()
}

// Hands the words of a transcript (an .srt and its words, or one redo) to its
// lines, when the words spell the lines' text, in order (local DTW runs always
// do): a word goes to the line its first letter is in, so a word of no length
// right on a line's end stays put. None when they don't (cloud text and words
// differ, a word was dropped) or a word runs across two lines: repeat_fix then
// leaves it all to the old code.
pub(super) fn attach(cues: Vec<Cue>, words: Vec<Word>) -> Option<Vec<Line>> {
  let mut lines: Vec<Line> = cues.into_iter().map(|cue| Line { cue, words: Vec::new() }).collect();
  if lines.is_empty() {
    return Some(lines);
  }
  let (mut text, mut line_of) = (String::new(), Vec::new());
  for (i, l) in lines.iter().enumerate() {
    let s = spell(&l.cue.text);
    line_of.extend(s.chars().map(|_| i));
    text += &s;
  }
  let spelt: Vec<String> = words.iter().map(|w| spell(&w.w)).collect();
  if spelt.concat() != text {
    return None;
  }
  let mut start = 0;
  for (w, s) in words.into_iter().zip(spelt) {
    let n = s.chars().count();
    // No letters: stays with the letter before it.
    let i = if n > 0 { line_of[start] } else { start.checked_sub(1).map_or(0, |j| line_of[j]) };
    if n > 0 && line_of[start + n - 1] != i {
      return None;
    }
    lines[i].words.push(w);
    start += n;
  }
  Some(lines)
}
