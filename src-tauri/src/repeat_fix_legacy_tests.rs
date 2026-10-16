// When words don't spell the lines (cloud, a dropped word), fix gives exactly
// what the old code gives: the cases from review, and a redo that doesn't spell
// its own lines halfway through.
use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

type Redo = Result<(Vec<Cue>, Vec<Word>), String>;

// The .srt written and the words, word by word.
fn run(c: &[Cue], w: &[Word], old: bool, redo: impl FnMut(u64, u64) -> Redo) -> (String, Vec<(String, u32, u32)>) {
  let p = temp_srt(c);
  let out = if old { legacy::fix(&p, Some(w.to_vec()), |_| {}, redo) } else { fix(&p, Some(w.to_vec()), |_| {}, redo) };
  let srt = std::fs::read_to_string(&p).unwrap();
  std::fs::remove_file(&p).unwrap();
  (srt, out.unwrap().unwrap_or_default().into_iter().map(|w| (w.w, w.from, w.to)).collect())
}

fn same_as_old(c: &[Cue], w: &[Word], redo: impl Fn(u64, u64) -> Redo) {
  assert_eq!(run(c, w, false, &redo), run(c, w, true, &redo));
}

fn failed(_: u64, _: u64) -> Redo {
  Err("cloud:network:x".into())
}

fn looped(from: u64) -> (Vec<Cue>, Vec<Word>) {
  let c = (0..3).map(|i| cue(from + i * 1000, from + i * 1000 + 1000, "Loop line.")).collect();
  let w = (0..3).flat_map(|i| [word("Loop", (from + i * 1000) as u32, (from + i * 1000 + 400) as u32), word("line.", (from + i * 1000 + 500) as u32, (from + i * 1000 + 900) as u32)]).collect();
  (c, w)
}

// The redo's 「Ciao」 sits in the time of its kept line B, nearer the dropped line A's end.
#[test]
fn overlapping_redo_lines_as_before() {
  let c: Vec<Cue> = (1..4).map(|i| cue(i * 1000, i * 1000 + 1000, "Repeat that.")).collect();
  let w: Vec<Word> = (1..4).flat_map(|i| [word("Repeat", i * 1000, i * 1000 + 400), word("that.", i * 1000 + 500, i * 1000 + 900)]).collect();
  same_as_old(&c, &w, |_, _| Ok((vec![cue(0, 1800, "Lead."), cue(1200, 2800, "Goodbye now.")], vec![word("Lead.", 100, 200), word("Ciao", 1500, 1600), word("now.", 2300, 2500)])));
}

// 「One」 runs to 3 s, past 「two.」: the words keep their order.
#[test]
fn word_order_as_before() {
  let mut c = vec![cue(0, 1000, "One two."), cue(1000, 3000, "Three."), cue(4000, 5000, "Goodbye.")];
  let mut w = vec![word("One", 0, 3000), word("two.", 500, 600), word("Three.", 1500, 1600), word("Ciao", 4200, 4500)];
  let (lc, lw) = looped(8000);
  c.extend(lc);
  w.extend(lw);
  same_as_old(&c, &w, failed);
}

// 「Hello.」 runs past its line and nothing next to it changes: its time stays.
#[test]
fn word_times_far_from_a_loop_as_before() {
  let mut c = vec![cue(0, 1000, "Hello."), cue(3000, 4000, "Goodbye.")];
  let mut w = vec![word("Hello.", 100, 1800), word("Ciao", 3200, 3600)];
  let (lc, lw) = looped(10_000);
  c.extend(lc);
  w.extend(lw);
  same_as_old(&c, &w, failed);
}

// The first redo spells its lines, the second doesn't: all of it is done the
// old way, and neither stretch is transcribed twice.
#[test]
fn a_redo_that_does_not_spell_its_lines_goes_to_the_old_code_once() {
  let mut c = vec![cue(0, 1000, "Before.")];
  let mut w = vec![word("Before.", 0, 900)];
  for from in [1000, 20_000] {
    let (lc, lw) = looped(from);
    c.extend(lc);
    w.extend(lw);
    c.push(cue(from + 9000, from + 10_000, "Middle."));
    w.push(word("Middle.", (from + 9000) as u32, (from + 9900) as u32));
  }
    let answer = |a: u64, _: u64| -> Redo {
    if a < 10_000 {
      Ok((vec![cue(1000, 4000, "Real one.")], vec![word("Real", 1000, 2000), word("one.", 2000, 4000)]))
    } else {
      Ok((vec![cue(20_000, 23_000, "Real two.")], vec![word("Ciao", 20_000, 21_000), word("two.", 21_000, 23_000)]))
    }
  };
  let asked = RefCell::new(HashMap::new());
  let got = run(&c, &w, false, |a, b| {
    *asked.borrow_mut().entry((a, b)).or_insert(0) += 1;
    answer(a, b)
  });
  assert_eq!(asked.into_inner(), HashMap::from([((0, 7000), 1), ((17_000, 26_000), 1)]));
  assert_eq!(got, run(&c, &w, true, answer));
  assert!(got.0.contains("Real one."));
}

// The last word runs on into the next line (「home. Now.」): the old code keeps 「Now.」.
#[test]
fn a_word_across_two_lines_as_before() {
  let mut c: Vec<Cue> = (0..3).map(|i| cue(i * 1000, i * 1000 + 1000, "Go home.")).collect();
  c.push(cue(3000, 4000, "Now."));
  let mut w: Vec<Word> = (0..3).flat_map(|i| [word("Go", i * 1000, i * 1000 + 400), word("home.", i * 1000 + 500, i * 1000 + 900)]).collect();
  *w.last_mut().unwrap() = word("home. Now.", 2500, 3800);
  same_as_old(&c, &w, failed);
}

// The whole loop is one word: the old code still cuts the line down to one copy.
#[test]
fn a_loop_inside_one_word_as_before() {
  let text = "我不知道我不知道我不知道我不知道。";
  let c = vec![cue(0, 4000, text)];
  same_as_old(&c, &[word(text, 0, 4000)], failed);
  let p = temp_srt(&c);
  fix(&p, Some(vec![word(text, 0, 4000)]), |_| {}, failed).unwrap();
  assert_eq!(texts(&parse_srt(&std::fs::read_to_string(&p).unwrap())), ["我不知道。"]);
  std::fs::remove_file(&p).unwrap();
}
