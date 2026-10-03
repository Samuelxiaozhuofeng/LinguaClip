use super::*;

fn cue(from: u64, to: u64, text: &str) -> Cue {
  Cue { from, to, text: text.into() }
}

fn word(w: &str, from: u32, to: u32) -> Word {
  Word { w: w.into(), from, to }
}

fn texts(c: &[Cue]) -> Vec<&str> {
  c.iter().map(|c| c.text.as_str()).collect()
}

#[test]
fn english_phrase_loop_in_one_line() {
  let c = [cue(0, 9000, "Well I know, I know, I know, I know, I know you.")];
  assert_eq!(find_loops(&c), [(0, 1)]);
  let (c, _) = collapse(c.to_vec(), None);
  assert_eq!(texts(&c), ["Well I know you."]);
}

#[test]
fn chinese_and_japanese_loops() {
  assert_eq!(find_loops(&[cue(0, 5000, "我不知道我不知道我不知道我不知道")]), [(0, 1)]);
  assert_eq!(find_loops(&[cue(0, 5000, "ありがとうございますありがとうございますありがとうございますありがとうございます")]), [(0, 1)]);
  let (c, _) = collapse(vec![cue(0, 5000, "我不知道。我不知道。我不知道。我不知道。")], None);
  assert_eq!(texts(&c), ["我不知道。"]);
  // The same line over and over, in Japanese.
  let c: Vec<Cue> = (0..5).map(|i| cue(i * 2000, i * 2000 + 2000, "そうですね。")).collect();
  assert_eq!(find_loops(&c), [(0, 5)]);
}

#[test]
fn ordinary_repeats_are_not_loops() {
  // Three times or fewer, one repeated word, laughter, a two-kana word.
  for t in ["No, no, no.", "I know, I know, I know.", "No, no, no, no, no!", "哈哈哈哈哈哈哈哈", "はいはいはいはい", "ああああああ", "hahahahaha"] {
    assert!(find_loops(&[cue(0, 1000, t)]).is_empty(), "{t}");
  }
  // A chorus that comes back after other lines, and a line said twice.
  let c = [
    cue(0, 1, "Let it go, let it go"),
    cue(1, 2, "Can't hold it back anymore"),
    cue(2, 3, "Let it go, let it go"),
    cue(3, 4, "Turn away and slam the door"),
    cue(4, 5, "Let it go, let it go"),
    cue(5, 6, "Thank you."),
    cue(6, 7, "Thank you."),
  ];
  assert!(find_loops(&c).is_empty());
}

#[test]
fn identical_lines_keep_the_first_with_its_words() {
  let c = vec![cue(0, 1000, "Hello there."), cue(1000, 2000, "Hello there."), cue(2000, 3000, "hello, there"), cue(3000, 4000, "Bye.")];
  assert_eq!(find_loops(&c), [(0, 3)]);
  let w = vec![word("Hello", 0, 400), word("there.", 400, 900), word("Hello", 1000, 1400), word("there.", 1400, 1900), word("hello,", 2000, 2400), word("there", 2400, 2900), word("Bye.", 3000, 3500)];
  let (c, w) = collapse(c, Some(w));
  assert_eq!(texts(&c), ["Hello there.", "Bye."]);
  let w = w.unwrap();
  assert_eq!(w.iter().map(|w| (w.w.as_str(), w.from)).collect::<Vec<_>>(), [("Hello", 0), ("there.", 400), ("Bye.", 3000)]);
}

#[test]
fn phrase_loop_cut_the_same_way_in_words() {
  // Chinese words from whisper may hold several characters.
  let c = vec![cue(0, 8000, "我不知道我不知道我不知道我不知道")];
  let w: Vec<Word> = (0..8).map(|i| word(if i % 2 == 0 { "我不" } else { "知道" }, i * 1000, i * 1000 + 900)).collect();
  let (c, w) = collapse(c, Some(w));
  assert_eq!(texts(&c), ["我不知道"]);
  assert_eq!(w.unwrap().iter().map(|w| w.w.as_str()).collect::<Vec<_>>(), ["我不", "知道"]);
}

#[test]
fn srt_round_trip() {
  let s = "1\n00:00:01,000 --> 00:00:02,500\n Hello\n\n2\n01:02:03.004 --> 01:02:04,000\nTwo\nlines\n\n";
  let c = parse_srt(s);
  assert_eq!(c, [cue(1000, 2500, "Hello"), cue(3_723_004, 3_724_000, "Two\nlines")]);
  assert_eq!(parse_srt(&write_srt(&c)), c);
}

fn temp_srt(cues: &[Cue]) -> std::path::PathBuf {
  let p = std::env::temp_dir().join(format!("lc-repeat-{}.srt", uuid::Uuid::new_v4()));
  std::fs::write(&p, write_srt(cues)).unwrap();
  p
}

#[test]
fn no_loop_touches_nothing() {
  let c = [cue(0, 1000, "One."), cue(1000, 2000, "Two.")];
  let p = temp_srt(&c);
  let before = std::fs::read_to_string(&p).unwrap();
  let mut called = false;
  let w = fix(&p, Some(vec![word("One.", 0, 500)]), |_| called = true, |_, _| panic!("no redo")).unwrap();
  assert!(!called);
  assert_eq!(w.unwrap().len(), 1);
  assert_eq!(std::fs::read_to_string(&p).unwrap(), before);
  std::fs::remove_file(p).unwrap();
}

#[test]
fn redo_replaces_the_stretch_and_failure_keeps_one_copy() {
  let mut c = vec![cue(0, 1000, "Before.")];
  c.extend((1..7).map(|i| cue(i * 1000, i * 1000 + 1000, "Loop line.")));
  c.push(cue(20_000, 21_000, "After."));
  let words = vec![word("Before.", 0, 900), word("Loop", 1000, 1500), word("line.", 1500, 1900), word("After.", 20_000, 20_900)];

  let p = temp_srt(&c);
  let mut asked = Vec::new();
  let w = fix(&p, Some(words.clone()), |_| {}, |from, to| {
    asked.push((from, to));
    // The neighbours come back too (they are in the padding) and must not double up.
    Ok((vec![cue(0, 900, "Before."), cue(1000, 4000, "The real line."), cue(4000, 7000, "Another one.")], vec![word("Before.", 0, 900), word("The", 1000, 1500), word("real", 1500, 2000), word("line.", 2000, 4000), word("Another", 4000, 5000), word("one.", 5000, 7000)]))
  })
  .unwrap()
  .unwrap();
  assert_eq!(asked, [(0, 10_000)]);
  let out = parse_srt(&std::fs::read_to_string(&p).unwrap());
  assert_eq!(texts(&out), ["Before.", "The real line.", "Another one.", "After."]);
  assert_eq!(w.iter().map(|w| w.w.as_str()).collect::<Vec<_>>(), ["Before.", "The", "real", "line.", "Another", "one.", "After."]);
  std::fs::remove_file(&p).unwrap();

  // Network down / whisper died / nothing heard: never a hole, one copy stays.
  for redo in [Err("cloud:network:x".to_string()), Ok((Vec::new(), Vec::new()))] {
    let p = temp_srt(&c);
    let w = fix(&p, Some(words.clone()), |_| {}, |_, _| redo.clone()).unwrap().unwrap();
    let out = parse_srt(&std::fs::read_to_string(&p).unwrap());
    assert_eq!(texts(&out), ["Before.", "Loop line.", "After."]);
    assert_eq!(w.len(), 4);
    std::fs::remove_file(&p).unwrap();
  }

  // Lines but no words while the video has words: treated as a failure too.
  let p = temp_srt(&c);
  fix(&p, Some(words.clone()), |_| {}, |_, _| Ok((vec![cue(1000, 3000, "X.")], Vec::new()))).unwrap();
  assert_eq!(texts(&parse_srt(&std::fs::read_to_string(&p).unwrap())), ["Before.", "Loop line.", "After."]);
  std::fs::remove_file(&p).unwrap();

  // No word timings at all: only the subtitles change.
  let p = temp_srt(&c);
  let w = fix(&p, None, |_| {}, |_, _| Ok((vec![cue(1000, 3000, "X.")], Vec::new()))).unwrap();
  assert!(w.is_none());
  assert_eq!(texts(&parse_srt(&std::fs::read_to_string(&p).unwrap())), ["Before.", "X.", "After."]);
  std::fs::remove_file(&p).unwrap();
}

#[test]
fn a_word_heard_again_at_the_seams_is_dropped_once() {
  // Loop lines 3900–9300ms between a line ending in "Nezahualcóyotl" and one starting "Gracias".
  let mut c = vec![cue(0, 3480, "El día de hoy, en Ciudad Nezahualcóyotl")];
  c.extend((0..6).map(|i| cue(3900 + i * 900, 4800 + i * 900, "Loop line.")));
  c.push(cue(9800, 11_000, "Gracias por ver."));
  let words = vec![word("Nezahualcóyotl", 2500, 3480), word("Gracias", 9800, 10_200)];
  let redo = |end_gap: u64| {
    move |_: u64, _: u64| -> Result<(Vec<Cue>, Vec<Word>), String> {
      Ok((
        vec![cue(3900, 5000, "nezahualcóyotl, porque venimos"), cue(5000, 9300 - end_gap, "a probar el pan. Gracias")],
        vec![word("nezahualcóyotl,", 3900, 4300), word("porque", 4300, 4600), word("venimos", 4600, 5000), word("pan.", 5000, 8000), word("Gracias", 8000, 9000)],
      ))
    }
  };
  let p = temp_srt(&c);
  let w = fix(&p, Some(words.clone()), |_| {}, redo(0)).unwrap().unwrap();
  let out = parse_srt(&std::fs::read_to_string(&p).unwrap());
  assert_eq!(texts(&out), ["El día de hoy, en Ciudad Nezahualcóyotl", "porque venimos", "a probar el pan.", "Gracias por ver."]);
  let ws: Vec<&str> = w.iter().map(|w| w.w.as_str()).collect();
  assert_eq!(ws, ["Nezahualcóyotl", "porque", "venimos", "pan.", "Gracias"]);
  std::fs::remove_file(&p).unwrap();

  // The same word far apart in time is said twice: both stay.
  let mut far = c.clone();
  far.last_mut().unwrap().from = 12_000;
  let p = temp_srt(&far);
  let w = fix(&p, Some(words), |_| {}, redo(0)).unwrap().unwrap();
  assert_eq!(texts(&parse_srt(&std::fs::read_to_string(&p).unwrap()))[2], "a probar el pan. Gracias");
  assert_eq!(w.iter().filter(|w| w.w == "Gracias").count(), 2);
  std::fs::remove_file(&p).unwrap();
}

#[test]
fn next_line_starting_right_at_the_end_is_the_seam() {
  // The loop ends at 6000 and the next line starts at 6000.
  let c: Vec<Cue> = (0..3).map(|i| cue(3000 + i * 1000, 4000 + i * 1000, "Loop line.")).chain([cue(6000, 7000, "Going home.")]).collect();
  let p = temp_srt(&c);
  let w = fix(&p, Some(vec![word("Going", 6000, 6400), word("home.", 6400, 7000)]), |_| {}, |_, _| {
    Ok((vec![cue(3000, 5900, "We are going")], vec![word("We", 3000, 3500), word("are", 3500, 4000), word("going", 5500, 5900)]))
  })
  .unwrap()
  .unwrap();
  assert_eq!(texts(&parse_srt(&std::fs::read_to_string(&p).unwrap())), ["We are", "Going home."]);
  assert_eq!(w.iter().map(|w| w.w.as_str()).collect::<Vec<_>>(), ["We", "are", "Going", "home."]);
  std::fs::remove_file(&p).unwrap();
}

#[test]
fn lines_across_the_edges_keep_exactly_their_words() {
  let mut c = vec![cue(0, 2000, "Start here.")];
  c.extend((0..4).map(|i| cue(2000 + i * 1000, 3000 + i * 1000, "Loop line.")));
  c.push(cue(6000, 8000, "The end."));
  let old = vec![word("Start", 0, 900), word("here.", 900, 2000), word("Loop", 2000, 2500), word("line.", 2500, 2900), word("Loop", 4000, 4500), word("The", 6000, 7000), word("end.", 7000, 8000)];
  let p = temp_srt(&c);
  // One new line starts before the loop (its middle inside), one runs past it.
  let w = fix(&p, Some(old), |_| {}, |_, _| {
    Ok((
      vec![cue(1500, 3500, "One two three"), cue(3500, 6300, "four five six")],
      vec![word("One", 1500, 1900), word("two", 1900, 2600), word("three", 2600, 3500), word("four", 3500, 4500), word("five", 4500, 5500), word("six", 5500, 6300)],
    ))
  })
  .unwrap()
  .unwrap();
  let out = parse_srt(&std::fs::read_to_string(&p).unwrap());
  assert_eq!(texts(&out), ["Start here.", "One two three", "four five six", "The end."]);
  // Words in order spell the subtitles exactly (the front end lines them up this way)…
  let line_keys: Vec<String> = out.iter().flat_map(|l| key(&l.text)).collect();
  let word_keys: Vec<String> = w.iter().flat_map(|x| key(&x.w)).collect();
  assert_eq!(word_keys, line_keys);
  // …and each new line's words all sit in its time, none dropped at the edges.
  for l in &out[1..3] {
    let mine: Vec<String> = w.iter().filter(|x| covers(l, x)).flat_map(|x| key(&x.w)).collect();
    assert_eq!(mine, key(&l.text), "{}", l.text);
  }
  std::fs::remove_file(&p).unwrap();
}

#[test]
fn apostrophes_stay_inside_words() {
  assert_eq!(key("It's, don’t I'm 'quoted'"), ["it's", "don't", "i'm", "quoted"]);
  // "…it" then "it's going": not the same word, nothing cut.
  let c: Vec<Cue> = [cue(0, 2000, "Look at it")].into_iter().chain((0..3).map(|i| cue(2000 + i * 1000, 3000 + i * 1000, "Loop line."))).collect();
  let p = temp_srt(&c);
  fix(&p, None, |_| {}, |_, _| Ok((vec![cue(2000, 5000, "it's going, don't stop")], Vec::new()))).unwrap();
  assert_eq!(texts(&parse_srt(&std::fs::read_to_string(&p).unwrap())), ["Look at it", "it's going, don't stop"]);
  std::fs::remove_file(&p).unwrap();
  // "…it" then "it, 's fine": the cut leaves no stray punctuation.
  let p = temp_srt(&c);
  fix(&p, None, |_| {}, |_, _| Ok((vec![cue(2000, 5000, "It, ¿fine")], Vec::new()))).unwrap();
  assert_eq!(texts(&parse_srt(&std::fs::read_to_string(&p).unwrap())), ["Look at it", "¿fine"]);
  std::fs::remove_file(&p).unwrap();
}

// Real whisper on a real wav: transcribe it, fake a loop over one stretch, then
// let the local redo transcribe that stretch again.
// LC_WAV=/path/16k.wav [LC_LANG=en] cargo test … -- --ignored retranscribes_loop --nocapture
// With GROQ_API_KEY set the stretch goes to Groq instead (transcribe_range).
#[test]
#[ignore]
fn retranscribes_loop() {
  let wav = PathBuf::from(std::env::var("LC_WAV").expect("LC_WAV"));
  let lang = std::env::var("LC_LANG").unwrap_or("en".into());
  let models = crate::paths::home_dir().unwrap().join(".cache/whisper.cpp");
  let (whisper, model) = (Path::new("/opt/homebrew/bin/whisper-cli"), models.join("ggml-large-v3-turbo.bin"));
  let stem = wav.with_extension("");
  crate::import::transcribe(|_| {}, whisper, &model, &models.join("ggml-silero-v5.1.2.bin"), "large.v3.turbo", &lang, &wav, &stem).unwrap();
  let srt = stem.with_extension("srt");
  let mut cues = parse_srt(&std::fs::read_to_string(&srt).unwrap());
  let words = crate::import::read_words(&stem.with_extension("json")).unwrap();
  assert!(cues.len() >= 3, "need a few lines, got {}", cues.len());
  // Lines 1..3 become six copies of line 1, squeezed into their time.
  let (from, to) = (cues[1].from, cues[2].to);
  let fake = cues[1].text.clone();
  let step = (to - from) / 6;
  let looped: Vec<Cue> = (0..6).map(|i| cue(from + i * step, from + (i + 1) * step, &fake)).collect();
  cues.splice(1..3, looped);
  std::fs::write(&srt, write_srt(&cues)).unwrap();
  eprintln!("BEFORE:\n{}", write_srt(&cues));
  let mut asked = Vec::new();
  let w = fix(&srt, Some(words), |p| eprintln!("retranscribe {p}%"), |a, b| {
    asked.push((a, b));
    let r = match std::env::var("GROQ_API_KEY") {
      Ok(key) => crate::cloud_asr::transcribe_range(crate::cloud_asr::Provider::Groq, &key, &lang, &wav, &stem, a, b),
      Err(_) => redo_local(whisper, &model, "large.v3.turbo", &lang, &wav, &stem, a, b),
    };
    eprintln!("redo {a}-{b}ms: {:?}", r.as_ref().map(|(c, w)| (texts(c).join(" | "), w.len())));
    r
  })
  .unwrap()
  .unwrap();
  let out = parse_srt(&std::fs::read_to_string(&srt).unwrap());
  eprintln!("AFTER:\n{}", write_srt(&out));
  assert_eq!(asked.len(), 1);
  assert!(find_loops(&out).is_empty());
  assert!(out.windows(2).all(|p| p[0].from <= p[1].from));
  assert!(w.windows(2).all(|p| p[0].from <= p[1].from));
  eprintln!("WORDS: {}", w.iter().take(14).map(|x| x.w.as_str()).collect::<Vec<_>>().join(" "));
  // No word doubled where one line meets the next ("muy muy" inside one line is speech),
  // and the words spell the same thing across each seam.
  let words_text: Vec<String> = w.iter().flat_map(|x| key(&x.w)).collect();
  for p in out.windows(2) {
    let (a, b) = (key(&p[0].text), key(&p[1].text));
    assert!(a.last() != b.first(), "{:?} doubled at a seam", a.last());
    let seam = [a.last().unwrap().clone(), b.first().unwrap().clone()];
    assert!(words_text.windows(2).any(|x| x == seam), "words miss the seam {seam:?}");
  }
  // Every word sits inside some line's time (srt and words agree).
  for x in &w {
    let mid = (x.from as u64 + x.to as u64) / 2;
    assert!(out.iter().any(|c| c.from <= mid + 500 && mid <= c.to + 500), "{} at {mid}", x.w);
  }
  for ext in ["srt", "json"] {
    let _ = std::fs::remove_file(stem.with_extension(ext));
  }
  for ext in ["wav", "srt", "json"] {
    assert!(!PathBuf::from(format!("{}-fix.{ext}", stem.display())).exists());
  }
}

// Deleting the card while a stretch is being transcribed again: whisper is
// killed, the import ends as cancelled, no work file is left.
// LC_WAV=/path/16k.wav cargo test … -- --ignored cancels_during_redo --nocapture
#[test]
#[ignore]
fn cancels_during_redo() {
  let wav = PathBuf::from(std::env::var("LC_WAV").expect("LC_WAV"));
  let models = crate::paths::home_dir().unwrap().join(".cache/whisper.cpp");
  let stem = wav.with_extension("cancel");
  let srt = stem.with_extension("srt");
  std::fs::write(&srt, write_srt(&(0..6).map(|i| cue(i * 2000, i * 2000 + 2000, "Loop line.")).collect::<Vec<_>>())).unwrap();
  let (srt2, stem2) = (srt.clone(), stem.clone());
  let started = std::time::Instant::now();
  let worker = std::thread::spawn(move || {
    let _turn = crate::import_queue::wait_turn("redo-cancel", || {}).unwrap();
    fix(&srt2, None, |_| {}, |a, b| {
      let r = redo_local(Path::new("/opt/homebrew/bin/whisper-cli"), &models.join("ggml-large-v3-turbo.bin"), "large.v3.turbo", "es", &wav, &stem2, a, b);
      eprintln!("redo returned after {:?}: {:?}", started.elapsed(), r.as_ref().err());
      r
    })
  });
  std::thread::sleep(std::time::Duration::from_millis(1500));
  crate::import_queue::cancel("redo-cancel");
  let result = worker.join().unwrap();
  eprintln!("fix: {:?} after {:?}", result.as_ref().err(), started.elapsed());
  assert_eq!(result.err().as_deref(), Some(crate::import_queue::CANCELLED));
  assert!(started.elapsed() < std::time::Duration::from_secs(5));
  for ext in ["wav", "srt", "json"] {
    assert!(!PathBuf::from(format!("{}-fix.{ext}", stem.display())).exists(), "{ext} left");
  }
  // The stem has a dot in it ("es.cancel"): the import's own wav must survive.
  assert!(PathBuf::from(std::env::var("LC_WAV").unwrap()).exists(), "input wav was overwritten");
  let left = std::process::Command::new("pgrep").args(["-f", &format!("{}-fix", stem.display())]).output().unwrap();
  assert!(left.stdout.is_empty(), "whisper still running");
  std::fs::remove_file(srt).unwrap();
}
