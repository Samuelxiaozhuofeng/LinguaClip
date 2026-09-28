// Real calls to the cloud services, all #[ignore]d: they need keys, cost
// quota, and need the network. Commands to run each are above each test.
use std::path::Path;

use crate::cloud_asr::{transcribe, transcribe_in_pieces, wav_data, Provider, RATE};
use crate::import::Word;

fn texts(w: &[Word]) -> Vec<&str> {
  w.iter().map(|w| w.w.as_str()).collect()
}

// Real Groq call with the fixture clip. Needs a key:
// GROQ_API_KEY=… cargo test --manifest-path src-tauri/Cargo.toml -- --ignored groq
#[test]
#[ignore]
fn groq_transcribes_fixture() {
  let key = std::env::var("GROQ_API_KEY").expect("GROQ_API_KEY");
  let dir = std::env::temp_dir().join(format!("lc-groq-{}", uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&dir).unwrap();
  let video = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/speech.m4v");
  let wav = dir.join("s.wav");
  crate::import::extract_wav(&video, &wav, |_| {}).unwrap();
  let stem = dir.join("s");
  let words = transcribe(|_| {}, Provider::Groq, &key, "en", &wav, &stem).unwrap();
  let srt = std::fs::read_to_string(stem.with_extension("srt")).unwrap();
  eprintln!("{srt}\n{:?}", texts(&words));
  assert!(srt.to_lowercase().contains("quick brown fox"), "{srt}");
  assert!(words.len() >= 8 && words.iter().any(|w| w.w.ends_with('.')), "{:?}", texts(&words));
  assert!(std::fs::read_dir(&dir).unwrap().count() == 2, "piece files left behind");
  std::fs::remove_dir_all(&dir).unwrap();
}

// Several pieces stitched back together, on a real 11-minute Spanish video cut
// every 4 minutes (uses ~11 minutes of the free daily quota):
// GROQ_API_KEY=… LC_LONG_VIDEO=/path/video.mp4 cargo test … -- --ignored groq_pieces --nocapture
#[test]
#[ignore]
fn groq_pieces_stitch_in_order() {
  let key = std::env::var("GROQ_API_KEY").expect("GROQ_API_KEY");
  let video = std::env::var("LC_LONG_VIDEO").expect("LC_LONG_VIDEO");
  let dir = std::env::temp_dir().join(format!("lc-groq-{}", uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&dir).unwrap();
  let wav = dir.join("s.wav");
  crate::import::extract_wav(Path::new(&video), &wav, |_| {}).unwrap();
  let (_, samples) = wav_data(&wav).unwrap();
  let stem = dir.join("s");
  let mut pcts = Vec::new();
  let words = transcribe_in_pieces(|p| pcts.push(p), Provider::Groq, &key, "es", &wav, &stem, 240).unwrap();
  let srt = std::fs::read_to_string(stem.with_extension("srt")).unwrap();
  eprintln!("progress {pcts:?}, {} words, {} cues", words.len(), srt.matches(" --> ").count());
  for cut in [240_000u32, 480_000] {
    let near: Vec<String> = words.iter().filter(|w| w.from.abs_diff(cut) < 6000).map(|w| format!("{}@{}", w.w, w.from)).collect();
    eprintln!("around {cut}: {}", near.join(" "));
  }
  eprintln!("{}", &srt[srt.len().saturating_sub(300)..]);
  assert_eq!(pcts.len(), 3);
  assert!(words.len() > 500);
  assert!(words.windows(2).all(|p| p[1].from >= p[0].from));
  assert!(u64::from(words.last().unwrap().to) <= samples * 1000 / RATE + 1000);
  assert!(words.last().unwrap().from > 600_000, "last word should be near the end");
  assert!(words.iter().any(|w| w.w.starts_with('¿')), "Spanish opening marks kept");
  std::fs::remove_dir_all(&dir).unwrap();
}

// Real Bailian calls: the fixture clip, then (if LC_LONG_VIDEO is set) a long
// video as one piece. DASHSCOPE_API_KEY=… cargo test … -- --ignored bailian --nocapture
#[test]
#[ignore]
fn bailian_transcribes() {
  let key = std::env::var("DASHSCOPE_API_KEY").expect("DASHSCOPE_API_KEY");
  let dir = std::env::temp_dir().join(format!("lc-bl-{}", uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&dir).unwrap();
  let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/speech.m4v").to_string_lossy().into_owned();
  let long = std::env::var("LC_LONG_VIDEO").ok();
  for (i, (video, lang)) in [(Some(fixture), "en"), (long, "es")].into_iter().enumerate() {
    let Some(video) = video else { continue };
    let wav = dir.join(format!("s{i}.wav"));
    crate::import::extract_wav(Path::new(&video), &wav, |_| {}).unwrap();
    let stem = dir.join(format!("s{i}"));
    let words = transcribe(|_| {}, Provider::Bailian, &key, lang, &wav, &stem).unwrap();
    let srt = std::fs::read_to_string(stem.with_extension("srt")).unwrap();
    let t = texts(&words);
    eprintln!("{} words, {} cues; first: {:?}; last cue: {}", t.len(), srt.matches(" --> ").count(), &t[..t.len().min(14)], &srt[srt.len().saturating_sub(120)..]);
    assert!(words.len() >= 8);
    assert!(words.windows(2).all(|p| p[1].from >= p[0].from));
    assert!(words.iter().any(|w| w.w.ends_with('.')), "punctuation kept");
    if i == 0 {
      assert!(srt.to_lowercase().contains("quick brown fox"), "{srt}");
    } else {
      assert!(words.iter().any(|w| w.w.starts_with('¿')), "Spanish opening marks kept");
      assert!(words.last().unwrap().from > 600_000);
    }
  }
  std::fs::remove_dir_all(&dir).unwrap();
}
