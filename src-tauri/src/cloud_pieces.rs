// Cloud transcription pieces (docs/import.md「云端转录」): one piece's upload
// dropped as soon as its card is deleted, and the pieces' lines laid end to end
// with Chinese / Japanese lines that a cut split in two mended.
use std::future::Future;
use std::time::Duration;

use futures_util::future::{select, Either};
use futures_util::pin_mut;

use crate::cloud_asr::Resp;

// Runs one piece's request; deleting the card (checked every second) drops it
// mid-upload or mid-wait instead of letting it finish.
pub(crate) fn until_cancelled<T>(send: impl Future<Output = Result<T, String>>) -> Result<T, String> {
  tauri::async_runtime::block_on(async {
    let watch = async {
      loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        crate::import_queue::check()?;
      }
    };
    pin_mut!(send, watch);
    match select(send, watch).await {
      Either::Left((r, _)) | Either::Right((r, _)) => r,
    }
  })
}

pub(crate) struct Line {
  pub(crate) start: u64, // ms into the whole audio
  pub(crate) end: u64,
  pub(crate) text: String,
}

// Closer than this across a cut, two CJK lines are one sentence cut in half.
const SEAM_GAP_MS: u64 = 300;

// Every piece's lines, offset into the whole audio (`offsets` in ms, one per
// piece). Where a cut split a Chinese / Japanese sentence (barely a pause, the
// line before not ending a sentence), the two halves become one line again.
// Latin-script lines are left for the AI re-split (utils/resegment.ts).
pub(crate) fn lines(resps: &[Resp], offsets: &[u64]) -> Vec<Line> {
  let mut out: Vec<Line> = Vec::new();
  for (resp, &off) in resps.iter().zip(offsets) {
    let mut first = true;
    for seg in &resp.segments {
      let text = seg.text.trim();
      if text.is_empty() {
        continue;
      }
      let start = off + ms(seg.start);
      let end = off + ms(seg.end).max(ms(seg.start));
      let seam = std::mem::replace(&mut first, false);
      match out.last_mut() {
        Some(prev) if seam && start < prev.end + SEAM_GAP_MS && splits_cjk(&prev.text) => {
          prev.text.push_str(text);
          prev.end = prev.end.max(end);
        }
        _ => out.push(Line { start, end, text: text.to_string() }),
      }
    }
  }
  out
}

fn ms(s: f64) -> u64 {
  (s.max(0.0) * 1000.0).round() as u64
}

// Ends in a Chinese / Japanese character rather than a sentence end
// (closing quotes and brackets looked past).
fn splits_cjk(text: &str) -> bool {
  text
    .trim_end_matches(['」', '』', '）', ')', '"', '”', '’', '\''])
    .chars()
    .last()
    .is_some_and(crate::import::is_cjk)
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use crate::cloud_asr::Seg;

  fn resp(segs: &[(f64, f64, &str)]) -> Resp {
    Resp { segments: segs.iter().map(|&(start, end, t)| Seg { start, end, text: t.into() }).collect(), words: Vec::new() }
  }

  fn texts(l: &[Line]) -> Vec<&str> {
    l.iter().map(|l| l.text.as_str()).collect()
  }

  #[test]
  fn cjk_line_cut_in_half_is_joined() {
    // Piece 2 starts at 3600s; the cut fell inside 「今天我们去公园散步」.
    let l = lines(&[resp(&[(0.0, 2.0, "你好。"), (3597.0, 3599.9, "今天我们去")]), resp(&[(0.05, 2.0, "公园散步。"), (3.0, 4.0, "好的。")])], &[0, 3_600_000]);
    assert_eq!(texts(&l), ["你好。", "今天我们去公园散步。", "好的。"]);
    assert_eq!((l[1].start, l[1].end), (3_597_000, 3_602_000));
  }

  #[test]
  fn seam_left_alone_after_a_full_stop_a_pause_or_latin_text() {
    let ends = |prev: &str, next_at: f64| texts(&lines(&[resp(&[(0.0, 9.9, prev)]), resp(&[(next_at, 2.0, "公园散步。")])], &[0, 10_000])).len();
    assert_eq!(ends("今天我们去公园。", 0.05), 2);
    assert_eq!(ends("「今天我们去公园！」", 0.05), 2);
    assert_eq!(ends("今天我们去", 0.5), 2);
    assert_eq!(ends("we went to the", 0.05), 2);
    assert_eq!(ends("今天我们去", 0.05), 1);
  }

  // Run from import_queue's test (the line is shared): deleting the card drops
  // the piece in flight within a second.
  pub(crate) fn cancel_drops_pieces_in_flight() {
    let worker = std::thread::spawn(|| {
      let _turn = crate::import_queue::wait_turn("p-a", || {}).unwrap();
      until_cancelled(async {
        tokio::time::sleep(Duration::from_secs(30)).await;
        Ok(())
      })
    });
    std::thread::sleep(Duration::from_millis(300));
    let t = std::time::Instant::now();
    crate::import_queue::cancel("p-a");
    assert_eq!(worker.join().unwrap().unwrap_err(), crate::import_queue::CANCELLED);
    assert!(t.elapsed() < Duration::from_secs(2));
  }
}
