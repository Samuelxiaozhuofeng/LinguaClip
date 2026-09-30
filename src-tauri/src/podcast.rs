// A podcast episode's audio, fetched straight from the feed's enclosure link
// (docs/private/podcast.md). Always the whole file from the start: most hosts
// stitch ads in per request, so the bytes differ from one try to the next and a
// resumed `.part` would be two files glued together. Follows redirects from the
// original link (the redirected ones are signed and expire); stops between chunks
// when the card is deleted.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const STALL: Duration = Duration::from_secs(30);
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
  on_pct: impl FnMut(u32),
) -> Result<PathBuf, String> {
  if let Some(done) = EXTS.iter().map(|e| dir.join(format!("{stem}.{e}"))).find(|p| p.is_file()) {
    return Ok(done);
  }
  let part = dir.join(format!("{stem}.part"));
  let result = tauri::async_runtime::block_on(fetch(url, &part, &check, on_pct));
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

async fn fetch(url: &str, part: &Path, check: &impl Fn() -> Result<(), String>, mut on_pct: impl FnMut(u32)) -> Result<&'static str, String> {
  let client = reqwest::Client::builder()
    .user_agent(UA)
    .connect_timeout(Duration::from_secs(15))
    .build()
    .map_err(|e| format!("download:{e}"))?;
  let mut res = tokio::time::timeout(STALL, client.get(url).send())
    .await
    .map_err(|_| "download:stalled".to_string())?
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
  let mut last = None;
  loop {
    check()?;
    let chunk = tokio::time::timeout(STALL, res.chunk())
      .await
      .map_err(|_| "download:stalled".to_string())?
      .map_err(|e| format!("download:{e}"))?;
    let Some(chunk) = chunk else { break };
    file.write_all(&chunk).map_err(|e| format!("download:{e}"))?;
    have += chunk.len() as u64;
    if let Some(total) = total {
      let pct = (have * 100 / total.max(1)).min(99) as u32;
      if last != Some(pct) {
        last = Some(pct);
        on_pct(pct);
      }
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
