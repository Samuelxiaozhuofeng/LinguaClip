// whisper's DTW token times (t_dtw, in 10 ms) are where the words really are;
// token offsets and segment times are not. With VAD on they sit on the
// silence-stripped clock and go back through the table whisper logs. Anything
// off = None, and read_words keeps its old estimate. See docs/import.md「逐词时间」.

// A line ends this long after its last token starts (utils/resegment.ts TAIL_MS).
pub(crate) const TAIL_MS: u32 = 400;
// Tokens further apart than this inside one whisper segment start a new line
// (utils/resegment.ts GAP_MS, the same number).
pub(crate) const GAP_MS: u32 = 3000;

// Chinese / Japanese pieces shorter than this, or of 1–2 characters, join a neighbour.
const MIN_LINE_MS: u32 = 600;

// A subtitle line being built from tokens: its start, the start of its last
// token, its text, whether a GAP_MS silence comes before it, and the index of
// its first word.
pub(crate) struct Line {
  pub(crate) from: u32,
  pub(crate) last: u32,
  pub(crate) text: String,
  pub(crate) after_gap: bool,
  pub(crate) words: usize,
}

fn cjk(l: &Line) -> bool {
  l.text.chars().any(crate::import::is_cjk)
}

fn ends_sentence(text: &str) -> bool {
  text.trim_end().ends_with(['。', '？', '！', '?', '!'])
}

fn short(l: &Line) -> bool {
  l.last + TAIL_MS - l.from < MIN_LINE_MS || l.text.chars().filter(|c| c.is_alphanumeric()).count() <= 2
}

// Too-short Chinese / Japanese pieces (「へ」「えっ」) join the neighbour with the
// smaller gap, never across a GAP_MS silence nor a sentence end (「はい。」 after
// 「…か？」 is an answer); then each line ends a little after its last token
// starts, never into the next one, and its words are held inside it (a word's
// middle outside its line is lost by repeat_fix). Latin lines pass untouched.
pub(crate) fn cues(mut lines: Vec<Line>, audio_end: u32, words: &mut [crate::import::Word]) -> Vec<crate::repeat_fix::Cue> {
  let mut i = 0;
  while i < lines.len() {
    if !cjk(&lines[i]) || !short(&lines[i]) || ends_sentence(&lines[i].text) {
      i += 1;
      continue;
    }
    let prev = (i > 0 && !lines[i].after_gap && cjk(&lines[i - 1]) && !ends_sentence(&lines[i - 1].text)).then(|| lines[i].from - lines[i - 1].last);
    let next = lines.get(i + 1).filter(|n| !n.after_gap && cjk(n)).map(|n| n.from - lines[i].last);
    let into = match (prev, next) {
      (Some(p), Some(n)) if n < p => i,
      (Some(_), _) => i - 1,
      (None, Some(_)) => i,
      (None, None) => {
        i += 1;
        continue;
      }
    };
    // `into` takes the line after it.
    let gone = lines.remove(into + 1);
    lines[into].last = gone.last;
    // Two whisper segments meet without punctuation or a space: keep them apart.
    if lines[into].text.ends_with(char::is_alphanumeric) && gone.text.starts_with(char::is_alphanumeric) {
      lines[into].text.push(' ');
    }
    lines[into].text.push_str(&gone.text);
    i = into;
  }
  let next: Vec<(u32, usize)> = lines.iter().skip(1).map(|l| (l.from, l.words)).chain([(audio_end, words.len())]).collect();
  lines
    .into_iter()
    .zip(next)
    .map(|(l, (next, next_words))| {
      let to = (l.last + TAIL_MS).min(next).min(audio_end).max(l.from);
      for w in &mut words[l.words..next_words] {
        w.from = w.from.clamp(l.from, to);
        w.to = w.to.clamp(w.from, to);
      }
      crate::repeat_fix::Cue { from: l.from as u64, to: to as u64, text: l.text.trim().to_string() }
    })
    .filter(|c| !c.text.is_empty())
    .collect()
}

// What one whisper run logged about its clock: the VAD table as (vad, original)
// centisecond points when VAD ran (empty = this build logs none), and the audio length.
#[derive(Default)]
pub(crate) struct Clock {
  pub(crate) vad: Option<Vec<(i64, i64)>>,
  pub(crate) audio_ms: Option<i64>,
}

// "whisper_vad: vad_segment_info: orig_start: 51.51, orig_end: 52.98, vad_start: 1.75, vad_end: 3.22"
pub(crate) fn parse_map_line(line: &str) -> Option<[(i64, i64); 2]> {
  let rest = &line[line.find("vad_segment_info:")?..];
  let cs = |key: &str| -> Option<i64> {
    let at = rest.find(key)? + key.len();
    let v: f64 = rest[at..].trim_start().split([',', ' ']).next()?.parse().ok()?;
    Some((v * 100.0).round() as i64)
  };
  Some([(cs("vad_start:")?, cs("orig_start:")?), (cs("vad_end:")?, cs("orig_end:")?)])
}

// "main: processing 'a (1).wav' (2880000 samples, 180.0 sec), 10 threads, …" (16 kHz)
pub(crate) fn parse_audio_line(line: &str) -> Option<i64> {
  if !line.contains("processing '") {
    return None;
  }
  let i = line.rfind(" samples, ")?;
  let n: i64 = line[line[..i].rfind('(')? + 1..i].trim().parse().ok()?;
  Some(n / 16)
}

// Put first in the table when one of its lines did not parse: no table starts
// there, so the whole file keeps the old estimate instead of mapping on what is
// left (a missing last stretch would put a word said at 60.1 s at 20 s).
const SPOILT: (i64, i64) = (-1, -1);

// One line of whisper's log into the clock: a VAD table line, the audio length.
pub(crate) fn read_log_line(clock: &mut Clock, line: &str) {
  if let Some(map) = clock.vad.as_mut().filter(|m| m.first() != Some(&SPOILT)) {
    if line.contains("vad_segment_info:") {
      match parse_map_line(line) {
        Some(points) => map.extend(points),
        None => {
          log::error!("unreadable vad time table line, keeping token offsets: {line}");
          *map = vec![SPOILT];
        }
      }
    }
  }
  if let Some(ms) = parse_audio_line(line) {
    clock.audio_ms = Some(ms);
  }
}

// Points come in pairs, start and end of one kept stretch. Inside a stretch:
// linear, as whisper maps its segment times. In the short silence whisper puts
// between two stretches: the nearer edge (whisper would ramp across the cut-out
// audio, putting a word at 39 s that is said at 1.2 s or 51.8 s). Held at the ends.
fn to_original(map: &[(i64, i64)], t: i64) -> i64 {
  let (first, last) = (map[0], map[map.len() - 1]);
  if t <= first.0 {
    return first.1;
  }
  if t >= last.0 {
    return last.1;
  }
  let k = map.partition_point(|p| p.0 < t);
  let (a, b) = (map[k - 1], map[k]);
  if k % 2 == 0 {
    return if t - a.0 < b.0 - t { a.1 } else { b.1 };
  }
  if b.0 == a.0 {
    a.1
  } else {
    a.1 + (t - a.0) * (b.1 - a.1) / (b.0 - a.0)
  }
}

// whisper puts 0.2 s between two kept stretches; a wider hole is a stretch whose
// log line is missing (or did not parse).
const STRETCH_GAP_CS: i64 = 25;
// A token this far past the table's last stretch: its stretch is missing.
const PAST_TABLE_CS: i64 = 50;

// The table whisper logged, all of it: pairs in order, from 0, no stretch missing.
fn whole_table(m: &[(i64, i64)]) -> bool {
  m.len() >= 2
    && m.len() % 2 == 0
    && m[0].0 == 0
    && m.windows(2).all(|w| w[1].0 >= w[0].0 && w[1].1 >= w[0].1)
    && m.chunks(2).zip(m.chunks(2).skip(1)).all(|(a, b)| b[0].0 - a[1].0 <= STRETCH_GAP_CS)
}

// Start (ms, original audio) of each token that is not a [_…] marker, per
// segment, never running backwards and never past the audio's end. A token of
// only punctuation / spaces takes the start of the one before it: its own t_dtw
// is often far off (OP: a 。 3 s after its line, inside the next stretch), and
// it must neither stretch its word nor start a line of its own. None when
// a token lacks t_dtw, VAD ran without a whole table, or a time jumps back
// more than a second (smaller jitter is held level instead).
pub(crate) fn token_starts(segments: &[serde_json::Value], clock: &Clock) -> Option<Vec<Vec<u32>>> {
  let map = match &clock.vad {
    Some(m) if !whole_table(m) => {
      log::error!("no whole vad time table in whisper's log ({} points), keeping token offsets", m.len());
      return None;
    }
    m => m.as_deref(),
  };
  let mut last = 0i64;
  let mut out = Vec::with_capacity(segments.len());
  for seg in segments {
    let mut times: Vec<u32> = Vec::new();
    for tok in seg.get("tokens")?.as_array()? {
      let text = tok.get("text").and_then(|v| v.as_str()).unwrap_or("");
      if text.starts_with("[_") {
        continue;
      }
      // Half a character (stray byte, see import.rs stray_bytes_as_chars) is speech.
      let spoken = text.chars().any(|c| c.is_alphanumeric() || ('\u{F780}'..='\u{F7FF}').contains(&c));
      if let (false, Some(&prev)) = (spoken, times.last()) {
        times.push(prev);
        continue;
      }
      let Some(cs) = tok.get("t_dtw").and_then(|v| v.as_i64()).filter(|&t| t >= 0) else {
        log::error!("token without t_dtw, keeping token offsets");
        return None;
      };
      if map.is_some_and(|m| cs > m[m.len() - 1].0 + PAST_TABLE_CS) {
        log::error!("dtw time {cs}0ms past the vad time table, keeping token offsets");
        return None;
      }
      let mut ms = map.map_or(cs, |m| to_original(m, cs)) * 10;
      if let Some(end) = clock.audio_ms {
        ms = ms.min(end);
      }
      if ms < last - 1000 {
        log::error!("dtw time runs back from {last}ms to {ms}ms, keeping token offsets");
        return None;
      }
      last = ms.max(last);
      times.push(last as u32);
    }
    out.push(times);
  }
  Some(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  // Real whisper-cli 1.8.4 output, cut down (tests/fixtures/dtw): the json and
  // the log lines run_whisper reads.
  fn fixture(name: &str, vad: bool) -> (std::path::PathBuf, Clock) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dtw");
    let mut clock = Clock { vad: vad.then(Vec::new), audio_ms: None };
    for line in std::fs::read_to_string(dir.join(format!("{name}.log.txt"))).unwrap().lines() {
      if let (Some(m), Some(p)) = (&mut clock.vad, parse_map_line(line)) {
        m.extend(p);
      }
      clock.audio_ms = clock.audio_ms.or(parse_audio_line(line));
    }
    (dir.join(format!("{name}.json")), clock)
  }

  fn spans(cues: &[crate::repeat_fix::Cue]) -> Vec<(u64, u64)> {
    cues.iter().map(|c| (c.from, c.to)).collect()
  }

  // Without VAD: EJ's opening greeting, said at 13.64 s (hand-made reference),
  // whose offsets say 0.96 s and whose segment says 0.00 s.
  #[test]
  fn plain_run_takes_dtw_times() {
    let (json, clock) = fixture("ej_head_novad", false);
    let (words, cues) = crate::import::read_words(&json, Some(&clock)).unwrap();
    let cues = cues.expect("dtw usable");
    assert_eq!((words[0].w.as_str(), words[0].from, words[0].to), ("み", 13640, 13720));
    // Last token ございます at 15.62 s + 400 ms, short of the next line at 16.32 s.
    assert_eq!(spans(&cues), [(13640, 16020), (16320, 19120)]);
    assert_eq!(cues[0].text, "みなさん明けましておめでとうございます");
    let w = words.last().unwrap();
    assert_eq!((w.w.as_str(), w.from, w.to), ("ですか", 18720, 19120));
  }

  // With VAD: OP's first segment holds a shout at 0.5 s and a line said at
  // 51.8 s (whisper's segment: 0.39 → 54.59 s). Back on the original clock the
  // 50 s gap splits it in two; no line spans more than a few seconds.
  #[test]
  fn vad_run_maps_back_and_splits_on_long_gaps() {
    let (json, clock) = fixture("op_head_vad", true);
    let (words, cues) = crate::import::read_words(&json, Some(&clock)).unwrap();
    let cues = cues.expect("dtw usable");
    eprintln!("{:?}", cues);
    assert_eq!(words[0].from, 510, "フ at vad 0.12 s = 0.39 + 0.12");
    assert!(cues[0].to < 2000, "the shout ends by 2 s: {:?}", spans(&cues));
    assert!(cues[1].from >= 51_810 && cues[1].text.starts_with("ッグを引いてる馬"), "{:?}", cues[1]);
    assert!(cues.iter().all(|c| c.to - c.from < 6000), "{:?}", spans(&cues));
    assert!(cues.windows(2).all(|w| w[0].to <= w[1].from), "no overlap: {:?}", spans(&cues));
    // 。 (t_dtw inside the next stretch, 65.19 s) stays on its line and its word.
    assert!(cues.iter().all(|c| c.text.chars().any(char::is_alphanumeric)), "{cues:?}");
    let w = words.iter().find(|w| w.w == "ございます。").expect("joined");
    assert!(w.to < 60_000, "{}..{}", w.from, w.to);
    assert!(words.windows(2).all(|w| w[0].from <= w[1].from));
  }

  // New VAD settings make whisper segments of two or three sentences, even a
  // question and its answer (EJ mid). Japanese lines are cut at each sentence
  // end; a piece too short to practise (「えっ」) joins its nearer neighbour.
  #[test]
  fn japanese_lines_are_cut_into_sentences() {
    let (json, clock) = fixture("ej_mid_vad", true);
    let (_, cues) = crate::import::read_words(&json, Some(&clock)).unwrap();
    let cues = cues.expect("dtw usable");
    let texts: Vec<&str> = cues.iter().map(|c| c.text.as_str()).collect();
    eprintln!("{:?}", cues);
    assert_eq!(texts, [
      "私の中の、理想ですね",
      "身長以外は、彼女を作りたいと思います",
      "大きいです。",
      "今好きな子はいるんですか?",
      "はい、います",
      "でも、アタックするだけですね",
      "そうっすね、この後デートっす えっ",
      "ちょっと、この二人と別れただけです",
    ]);
    assert!(cues.windows(2).all(|w| w[0].from <= w[0].to && w[0].to <= w[1].from), "{cues:?}");
  }

  // One token without t_dtw, or VAD without the table (an older whisper-cli's
  // log): the whole file keeps the old estimate and whisper's own lines.
  #[test]
  fn falls_back_whole_when_dtw_cannot_be_trusted() {
    let (json, clock) = fixture("ej_head_novad", false);
    let old = crate::import::read_words(&json, None).unwrap();
    assert!(old.1.is_none());
    let no_table = Clock { vad: Some(Vec::new()), audio_ms: clock.audio_ms };
    let (words, cues) = crate::import::read_words(&json, Some(&no_table)).unwrap();
    assert!(cues.is_none());
    assert_eq!(words.iter().map(|w| w.from).collect::<Vec<_>>(), old.0.iter().map(|w| w.from).collect::<Vec<_>>());

    let raw = std::fs::read(&json).unwrap();
    let pat = b"\"t_dtw\": 1394";
    let at = raw.windows(pat.len()).position(|w| w == pat).expect("さん's t_dtw");
    let broken = [&raw[..at], &b"\"t_dtw\": -1"[..], &raw[at + pat.len()..]].concat();
    let dir = std::env::temp_dir().join(format!("dtw-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.json");
    std::fs::write(&path, broken).unwrap();
    let (words, cues) = crate::import::read_words(&path, Some(&clock)).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert!(cues.is_none());
    assert_eq!(words[0].from, old.0[0].from, "offsets, not t_dtw");
    assert!(words[0].from < 13_000);
  }

  // EJ mid: 「ですね」 ends its sentence, but the next token in its whisper
  // segment starts the next one 0.6 s later; the word stops where its line does.
  #[test]
  fn words_stay_inside_their_lines() {
    let (json, clock) = fixture("ej_mid_vad", true);
    let (words, cues) = crate::import::read_words(&json, Some(&clock)).unwrap();
    let cues = cues.expect("dtw usable");
    let w = words.iter().find(|w| w.w == "ですね").expect("ですね");
    assert!(w.to as u64 <= cues[0].to, "{}..{} past {:?}", w.from, w.to, cues[0]);
    for w in &words {
      let mid = (w.from as u64 + w.to as u64) / 2;
      assert!(cues.iter().any(|c| (c.from..=c.to).contains(&mid)), "{} {}..{} {cues:?}", w.w, w.from, w.to);
    }
  }

  // A stretch missing from the logged table (here OP's 51.81 s one) would put
  // its words next to the stretch before (「を」 at 1.18 s, said at 51.86 s): the
  // whole file keeps the old estimate. Same for the stretches at the end (the
  // cut-down json's last token, 7.86 s, is in the 8th of 11), or half a line.
  #[test]
  fn partial_vad_table_falls_back_whole() {
    let (json, clock) = fixture("op_head_vad", true);
    let m = clock.vad.clone().unwrap();
    for cut in [2, 0] {
      let mut part = m.clone();
      part.drain(cut..cut + 2);
      let c = Clock { vad: Some(part), audio_ms: clock.audio_ms };
      assert!(crate::import::read_words(&json, Some(&c)).unwrap().1.is_none(), "stretch {} missing", cut / 2);
    }
    let short = Clock { vad: Some(m[..14].to_vec()), audio_ms: clock.audio_ms };
    assert!(crate::import::read_words(&json, Some(&short)).unwrap().1.is_none(), "last stretches missing");
    assert!(crate::import::read_words(&json, Some(&Clock { vad: Some(m[..16].to_vec()), ..short })).unwrap().1.is_some(), "a missing stretch no token is in is harmless");
    let odd = Clock { vad: Some(m[..m.len() - 1].to_vec()), audio_ms: clock.audio_ms };
    assert!(crate::import::read_words(&json, Some(&odd)).unwrap().1.is_none(), "half a line");
  }

  // Two stretches, said at 0–20 s and 60–61 s (20–21.2 s without the silence),
  // and the second table line cut off: the whole file keeps the old estimate.
  // What is left of the table would pass every check and put 「world」 at 20 s.
  #[test]
  fn unreadable_vad_table_line_falls_back_whole() {
    let json = r#"{"transcription":[
      {"offsets":{"from":0,"to":1000},"tokens":[{"text":" Hello","offsets":{"from":0,"to":500},"t_dtw":100}]},
      {"offsets":{"from":60000,"to":61000},"tokens":[{"text":" world","offsets":{"from":20200,"to":20800},"t_dtw":2030}]}]}"#;
    let dir = std::env::temp_dir().join(format!("dtw-spoilt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.json");
    std::fs::write(&path, json).unwrap();
    let mut clock = Clock { vad: Some(Vec::new()), audio_ms: None };
    for line in [
      "whisper_vad: vad_segment_info: orig_start: 0.00, orig_end: 20.00, vad_start: 0.00, vad_end: 20.00",
      "whisper_vad: vad_segment_info: orig_start: 60.00, orig_end: 61.00, vad_start: 20.20, vad_end: ",
      "main: processing 'a.wav' (1000000 samples, 62.5 sec), 10 threads, 1 processors",
    ] {
      read_log_line(&mut clock, line);
    }
    let (words, cues) = crate::import::read_words(&path, Some(&clock)).unwrap();
    let left = Clock { vad: Some(vec![(0, 0), (2000, 2000)]), audio_ms: clock.audio_ms };
    let (left_words, left_cues) = crate::import::read_words(&path, Some(&left)).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert!(cues.is_none());
    assert!(words[1].from >= 60_000, "world at {}", words[1].from);
    assert!(left_cues.is_some() && left_words[1].from == 20_000, "the hazard: {}", left_words[1].from);
  }

  // 「はい。」 answers 「準備はできましたか？」: two lines. A fragment with no
  // sentence end still joins (「へ」 after a line, 「えっ」 before one).
  #[test]
  fn whole_short_sentences_are_not_joined() {
    let line = |from, text: &str| Line { from, last: from + 300, text: text.into(), after_gap: false, words: 0 };
    let texts = |lines| cues(lines, 60_000, &mut []).into_iter().map(|c| c.text).collect::<Vec<_>>();
    assert_eq!(texts(vec![line(0, "準備はできましたか？"), line(1500, "はい。")]), ["準備はできましたか？", "はい。"]);
    assert_eq!(texts(vec![line(0, "そうっすね"), line(1000, "へ")]), ["そうっすね へ"]);
    assert_eq!(texts(vec![line(0, "大きいです。"), line(1000, "えっ"), line(2000, "ちょっと待って")]), ["大きいです。", "えっ ちょっと待って"]);
  }

  #[test]
  fn reads_whisper_log_lines() {
    let l = "whisper_vad: vad_segment_info: orig_start: 51.51, orig_end: 52.98, vad_start: 1.75, vad_end: 3.22";
    assert_eq!(parse_map_line(l), Some([(175, 5151), (322, 5298)]));
    assert_eq!(parse_map_line("whisper_vad: Including segment 1: 51.51 - 53.08 (duration: 1.57)"), None);
    let p = "main: processing 'ej (1).wav' (2880000 samples, 180.0 sec), 10 threads, 1 processors";
    assert_eq!(parse_audio_line(p), Some(180_000));
  }

  #[test]
  fn maps_onto_the_original_clock() {
    let m = [(0, 0), (155, 155), (175, 5151), (322, 5298)];
    assert_eq!(to_original(&m, 100), 100);
    assert_eq!(to_original(&m, 175), 5151);
    assert_eq!(to_original(&m, 200), 5176);
    assert_eq!(to_original(&m, 999), 5298, "held at the last point");
    // In the 0.2 s whisper puts between two stretches: the nearer edge, no ramp.
    assert_eq!(to_original(&m, 160), 155);
    assert_eq!(to_original(&m, 170), 5151);
  }
}
