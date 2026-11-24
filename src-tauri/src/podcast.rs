// A podcast episode's audio, fetched straight from the feed's enclosure link
// (docs/private/podcast.md). Always the whole file from the start: most hosts
// stitch ads in per request, so the bytes differ from one try to the next and a
// resumed `.part` would be two files glued together. Follows redirects from the
// original link (the redirected ones are signed and expire); stops between chunks
// when the card is deleted.
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::time::{Duration, Instant};

const STALL: Duration = Duration::from_secs(30);
// Poll cancel check every 500ms while waiting on network I/O so cancelling aborts promptly.
const CANCEL_POLL: Duration = Duration::from_millis(500);
// Throttle progress updates when Content-Length is absent or bytes trickle in.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
// Some hosts turn away clients that don't look like a browser.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
// What plays without converting (convert.rs plays_natively agrees).
const EXTS: [&str; 3] = ["mp3", "m4a", "mp4"];

// The front end names the file; this is the trust boundary, so no separators,
// nothing Windows refuses, no leading dots (no "..", no hidden file), bounded length.
pub(crate) fn safe_stem(name: &str) -> Option<String> {
  let clean: String = name
    .chars()
    .map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { ' ' } else { c })
    .collect();
  let joined = clean.split_whitespace().collect::<Vec<_>>().join(" ");
  let cut: String = joined.trim_start_matches(['.', ' ']).chars().take(120).collect();
  let stem = cut.trim_end_matches(['.', ' ']);
  (!stem.is_empty()).then(|| stem.to_string())
}

// The file type from the answer's Content-Type, else from the link's ending.
fn ext_for(content_type: Option<&str>, urls: &[&str]) -> Option<&'static str> {
  let ct = content_type.unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
  let by_type = match ct.as_str() {
    "audio/mpeg" | "audio/mp3" | "audio/mpeg3" | "audio/x-mpeg" => Some("mp3"),
    "audio/mp4" | "audio/x-m4a" | "audio/m4a" => Some("m4a"),
    "video/mp4" => Some("mp4"),
    _ => None,
  };
  by_type.or_else(|| {
    urls.iter().find_map(|u| {
      let path = u.split(['?', '#']).next().unwrap_or("");
      let ext = path.rsplit('/').next()?.rsplit_once('.')?.1.to_ascii_lowercase();
      EXTS.iter().copied().find(|e| *e == ext)
    })
  })
}

// Downloads into `dir` as `<stem>.<ext>`; a finished file of that name is used as is.
// `check` is the import's cancel check, `on_pct` gets whole percents when the size is known.
pub(crate) fn download(
  url: &str,
  dir: &Path,
  stem: &str,
  check: impl Fn() -> Result<(), String>,
  mut on_pct: impl FnMut(u32),
) -> Result<PathBuf, String> {
  let mut last = None;
  download_with_progress(url, dir, stem, check, move |pct, _| {
    if let Some(p) = pct {
      if last != Some(p) {
        last = Some(p);
        on_pct(p);
      }
    }
  })
}

// Same as `download`, but reports `(Option<u32> percent, u64 bytes)` roughly every second
// or whenever whole-percent progress advances, and polls `check` every 500ms while waiting on I/O.
pub(crate) fn download_with_progress(
  url: &str,
  dir: &Path,
  stem: &str,
  check: impl Fn() -> Result<(), String>,
  on_progress: impl FnMut(Option<u32>, u64),
) -> Result<PathBuf, String> {
  if let Some(done) = EXTS.iter().map(|e| dir.join(format!("{stem}.{e}"))).find(|p| p.is_file()) {
    return Ok(done);
  }
  let part = dir.join(format!("{stem}.part"));
  let result = tauri::async_runtime::block_on(fetch(url, &part, &check, on_progress));
  match result {
    Ok(ext) => {
      let done = dir.join(format!("{stem}.{ext}"));
      std::fs::rename(&part, &done).map_err(|e| format!("download:{e}"))?;
      Ok(done)
    }
    Err(e) => {
      let _ = std::fs::remove_file(&part);
      Err(e)
    }
  }
}

// Polls `check()` every CANCEL_POLL while awaiting `fut` up to `stall`, so cancellation
// interrupts a stalled HTTP send or chunk read within ~0.5s instead of waiting 30s.
async fn await_with_cancel<F, T>(
  fut: F,
  stall: Duration,
  check: &impl Fn() -> Result<(), String>,
) -> Result<T, String>
where
  F: Future<Output = T>,
{
  let mut fut = pin!(fut);
  let started = Instant::now();
  loop {
    check()?;
    let remaining = stall.saturating_sub(started.elapsed());
    if remaining.is_zero() {
      return Err("download:stalled".to_string());
    }
    let step = remaining.min(CANCEL_POLL);
    match tokio::time::timeout(step, &mut fut).await {
      Ok(val) => return Ok(val),
      Err(_) => {
        check()?;
        if started.elapsed() >= stall {
          return Err("download:stalled".to_string());
        }
      }
    }
  }
}

async fn fetch(
  url: &str,
  part: &Path,
  check: &impl Fn() -> Result<(), String>,
  mut on_progress: impl FnMut(Option<u32>, u64),
) -> Result<&'static str, String> {
  #[allow(unused_mut)]
  let mut builder = reqwest::Client::builder()
    .user_agent(UA)
    .connect_timeout(Duration::from_secs(15));
  #[cfg(test)]
  if url.starts_with("http://127.0.0.1:") {
    builder = builder.no_proxy();
  }
  let client = builder.build().map_err(|e| format!("download:{e}"))?;
  let mut res = await_with_cancel(client.get(url).send(), STALL, check)
    .await?
    .map_err(|e| format!("download:{e}"))?;
  let status = res.status();
  if !status.is_success() {
    return Err(format!("download:HTTP {}", status.as_u16()));
  }
  let ct = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
  let ext = ext_for(ct.as_deref(), &[res.url().as_str(), url]).ok_or_else(|| "podcast:format".to_string())?;
  let total = res.content_length();
  let mut have = 0u64;
  let mut file = std::fs::File::create(part).map_err(|e| format!("download:{e}"))?;
  let mut last_pct: Option<u32> = None;
  let mut last_emit: Option<Instant> = None;
  loop {
    check()?;
    let chunk = await_with_cancel(res.chunk(), STALL, check)
      .await?
      .map_err(|e| format!("download:{e}"))?;
    let Some(chunk) = chunk else { break };
    file.write_all(&chunk).map_err(|e| format!("download:{e}"))?;
    have += chunk.len() as u64;
    let pct = total.map(|t| (have * 100 / t.max(1)).min(99) as u32);
    let pct_changed = pct.is_some() && pct != last_pct;
    let interval_due = last_emit.map_or(true, |prev| prev.elapsed() >= PROGRESS_INTERVAL);
    if pct_changed || interval_due {
      last_pct = pct;
      last_emit = Some(Instant::now());
      on_progress(pct, have);
    }
  }
  file.flush().map_err(|e| format!("download:{e}"))?;
  if total.is_some_and(|t| have < t) {
    return Err(format!("download:incomplete {have}/{} bytes", total.unwrap_or(0)));
  }
  Ok(ext)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Read;
  use std::net::TcpListener;
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::Arc;

  #[test]
  fn stems_cannot_leave_the_folder() {
    assert_eq!(safe_stem("../../etc/passwd").as_deref(), Some("etc passwd"));
    assert_eq!(safe_stem("..").as_deref(), None);
    assert_eq!(safe_stem("  ").as_deref(), None);
    assert_eq!(safe_stem("Why: do we \"itch\"? [a1b2c3d4]").as_deref(), Some("Why do we itch [a1b2c3d4]"));
    assert_eq!(safe_stem("a\\b\nc.").as_deref(), Some("a b c"));
    assert_eq!(safe_stem(&"長".repeat(300)).map(|s| s.chars().count()), Some(120));
  }

  #[test]
  fn file_type_from_header_then_link() {
    assert_eq!(ext_for(Some("audio/mpeg"), &["https://x/y"]), Some("mp3"));
    assert_eq!(ext_for(Some("audio/x-m4a; charset=binary"), &[]), Some("m4a"));
    // RFI: no extension anywhere, the header decides.
    assert_eq!(ext_for(Some("audio/mpeg"), &["https://audio.audiomeans.fr/pfx/x/journal_francais_facile_16"]), Some("mp3"));
    assert_eq!(ext_for(Some("application/octet-stream"), &["https://cdn/x.mp3?sig=1", "https://feed/x"]), Some("mp3"));
    assert_eq!(ext_for(None, &["https://cdn/episode.M4A#t=1"]), Some("m4a"));
    assert_eq!(ext_for(Some("audio/ogg"), &["https://cdn/x.ogg"]), None);
    assert_eq!(ext_for(Some("audio/wav"), &["https://cdn/x.wav"]), None);
  }

  #[tokio::test]
  async fn await_with_cancel_aborts_promptly() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(120)).await;
      flag.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let res: Result<(), String> = await_with_cancel(std::future::pending::<()>(), STALL, &|| {
      if cancelled.load(Ordering::SeqCst) {
        Err(crate::import_queue::CANCELLED.to_string())
      } else {
        Ok(())
      }
    })
    .await;
    assert_eq!(res.unwrap_err(), crate::import_queue::CANCELLED);
    assert!(started.elapsed() < Duration::from_secs(2), "cancel took too long: {:?}", started.elapsed());
  }

  #[tokio::test]
  async fn await_with_cancel_times_out_when_stalled() {
    let res: Result<(), String> = await_with_cancel(
      std::future::pending::<()>(),
      Duration::from_millis(120),
      &|| Ok(()),
    )
    .await;
    assert_eq!(res.unwrap_err(), "download:stalled");
  }

  #[test]
  fn download_with_progress_handles_known_length_chunked_and_fast_cancel() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let stop_server = Arc::new(AtomicBool::new(false));
    let server_stop = stop_server.clone();

    let server = std::thread::spawn(move || {
      let _ = listener.set_nonblocking(true);
      while !server_stop.load(Ordering::SeqCst) {
        let Ok((mut stream, _)) = listener.accept() else {
          std::thread::sleep(Duration::from_millis(10));
          continue;
        };
        let _ = stream.set_nonblocking(false);
        std::thread::spawn(move || {
          let mut buf = [0u8; 1024];
          let n = stream.read(&mut buf).unwrap_or(0);
          let req = String::from_utf8_lossy(&buf[..n]);
          let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
          match path {
            "/known.mp3" => {
              let body = vec![b'A'; 4096];
              let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
              );
              let _ = stream.write_all(head.as_bytes());
              let _ = stream.write_all(&body[..2048]);
              let _ = stream.flush();
              std::thread::sleep(Duration::from_millis(30));
              let _ = stream.write_all(&body[2048..]);
            }
            "/chunked.mp3" => {
              let head = "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
              let _ = stream.write_all(head.as_bytes());
              let chunk = vec![b'B'; 1024];
              let frame = format!("{:x}\r\n", chunk.len());
              let _ = stream.write_all(frame.as_bytes());
              let _ = stream.write_all(&chunk);
              let _ = stream.write_all(b"\r\n0\r\n\r\n");
            }
            "/slow.mp3" => {
              let head = "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n";
              let _ = stream.write_all(head.as_bytes());
              let _ = stream.write_all(b"partial");
              let _ = stream.flush();
              std::thread::sleep(Duration::from_secs(5));
            }
            _ => {
              let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            }
          }
        });
      }
    });

    let dir = std::env::temp_dir().join(format!("lc-pod-local-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    // 1. Known Content-Length: reports percent + bytes and reuses finished file.
    let mut events = Vec::new();
    let p1 = download_with_progress(
      &format!("http://{addr}/known.mp3"),
      &dir,
      "ep-known",
      || Ok(()),
      |pct, bytes| events.push((pct, bytes)),
    )
    .unwrap();
    assert_eq!(p1, dir.join("ep-known.mp3"));
    assert_eq!(std::fs::metadata(&p1).unwrap().len(), 4096);
    assert!(events.iter().any(|(pct, bytes)| pct.is_some() && *bytes > 0));
    assert_eq!(
      download(&format!("http://{addr}/known.mp3"), &dir, "ep-known", || Err("should reuse".into()), |_| {}).unwrap(),
      p1
    );

    // 2. Chunked (no Content-Length): reports None percent + bytes.
    let mut chunk_events = Vec::new();
    let p2 = download_with_progress(
      &format!("http://{addr}/chunked.mp3"),
      &dir,
      "ep-chunked",
      || Ok(()),
      |pct, bytes| chunk_events.push((pct, bytes)),
    )
    .unwrap();
    assert_eq!(p2, dir.join("ep-chunked.mp3"));
    assert_eq!(std::fs::metadata(&p2).unwrap().len(), 1024);
    assert!(chunk_events.iter().any(|(pct, bytes)| pct.is_none() && *bytes > 0));

    // 3. Stalled mid-stream: cancel aborts within ~0.5s and removes .part.
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_trigger = cancelled.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(150));
      cancel_trigger.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let err = download_with_progress(
      &format!("http://{addr}/slow.mp3"),
      &dir,
      "ep-slow",
      || {
        if cancelled.load(Ordering::SeqCst) {
          Err(crate::import_queue::CANCELLED.to_string())
        } else {
          Ok(())
        }
      },
      |_, _| {},
    )
    .unwrap_err();
    assert_eq!(err, crate::import_queue::CANCELLED);
    assert!(started.elapsed() < Duration::from_secs(2), "cancel took too long: {:?}", started.elapsed());
    assert!(!dir.join("ep-slow.part").exists(), ".part must be removed on cancel");

    stop_server.store(true, Ordering::SeqCst);
    let _ = server.join();
    let _ = std::fs::remove_dir_all(&dir);
  }

  // Real network: cargo test --manifest-path src-tauri/Cargo.toml -- --ignored downloads_episode --nocapture
  // (LC_PODCAST_URL=… for another episode).
  #[test]
  #[ignore]
  fn downloads_episode() {
    let url = std::env::var("LC_PODCAST_URL").unwrap_or_else(|_| "https://www3.nhk.or.jp/nhkworld/lesson/en/mp3/audio_lesson_01.mp3".into());
    let dir = std::env::temp_dir().join(format!("lc-podcast-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // First try gives up after about a megabyte, like a deleted card would.
    let got = std::cell::Cell::new(0u32);
    let stop = || if got.get() >= 10 { Err(crate::import_queue::CANCELLED.to_string()) } else { Ok(()) };
    let err = download(&url, &dir, "half", stop, |p| got.set(p)).unwrap_err();
    assert_eq!(err, crate::import_queue::CANCELLED);
    assert!(!dir.join("half.part").exists(), "a cancelled download leaves nothing");
    // A .part left by anything earlier is never glued onto: the file starts over.
    std::fs::write(dir.join("ep.part"), b"left over").unwrap();
    let path = download(&url, &dir, "ep", || Ok(()), |_| {}).unwrap();
    let len = std::fs::metadata(&path).unwrap().len();
    println!("{} {len} bytes", path.display());
    assert!(len > 1_000_000);
    assert_ne!(&std::fs::read(&path).unwrap()[..9], b"left over");
    assert!(!dir.join("ep.part").exists());
    assert_eq!(download(&url, &dir, "ep", || Err("must not fetch".into()), |_| {}).unwrap(), path, "a finished file is reused");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
