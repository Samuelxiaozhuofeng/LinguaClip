// Android podcast download progress, safe per-id file purge, and orphan media sweep commands.
// Owned by M1.3; registered in src-tauri/src/lib.rs on merge.
#![allow(dead_code)]

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use tauri::Emitter;

use crate::cache::valid_id;
use crate::import_queue;
use crate::paths::own_dir;
use crate::podcast;

const MEDIA_ORPHAN_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const TMP_ORPHAN_AGE: Duration = Duration::from_secs(60 * 60);
const EMIT_INTERVAL: Duration = Duration::from_secs(1);

const CACHE_KINDS: [&str; 9] = [
  "srt",
  "words",
  "cloze",
  "breakdown",
  "segments",
  "levels",
  "trans",
  "keywords",
  "phrases",
];

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadEvent {
  pub id: String,
  pub stage: &'static str,
  pub percent: Option<u32>,
  pub bytes: u64,
}

#[tauri::command]
pub async fn download_podcast_audio_stream(
  app: tauri::AppHandle,
  id: String,
  url: String,
) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !valid_id(&id) {
      return Err("bad-id".into());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
      return Err("download:invalid-url".into());
    }
    let _turn = import_queue::wait_turn(&id, || {
      let _ = app.emit(
        "podcast-download",
        PodcastDownloadEvent {
          id: id.clone(),
          stage: "queued",
          percent: None,
          bytes: 0,
        },
      );
    })?;
    let media = own_dir()?.join("media");
    std::fs::create_dir_all(&media).map_err(|e| e.to_string())?;

    let mut last_emit: Option<Instant> = None;
    let mut last_pct: Option<u32> = None;
    // Always store under `media/<id>.<ext>` so episodes with identical titles never collide.
    let path = podcast::download_with_progress(
      &url,
      &media,
      &id,
      import_queue::check,
      |percent, bytes| {
        let now = Instant::now();
        let due = last_emit.map_or(true, |prev| now.duration_since(prev) >= EMIT_INTERVAL);
        let pct_jumped = percent.is_some() && percent != last_pct;
        if due || (pct_jumped && last_emit.map_or(true, |prev| now.duration_since(prev) >= Duration::from_millis(250))) {
          last_emit = Some(now);
          last_pct = percent;
          let _ = app.emit(
            "podcast-download",
            PodcastDownloadEvent {
              id: id.clone(),
              stage: "download",
              percent,
              bytes,
            },
          );
        }
      },
    )?;
    Ok(path.to_string_lossy().into_owned())
  })
  .await
  .map_err(|e| e.to_string())?
}

fn remove_prefixed_files(dir: &Path, prefix: &str) -> u32 {
  let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
  let mut removed = 0u32;
  for entry in entries.flatten() {
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
    if name.starts_with(prefix) && std::fs::remove_file(entry.path()).is_ok() {
      removed += 1;
    }
  }
  removed
}

pub(crate) fn purge_files_in(own: &Path, id: &str) -> Result<u32, String> {
  if !valid_id(id) {
    return Err("bad-id".into());
  }
  let prefix = format!("{id}.");
  let mut removed = 0u32;
  removed += remove_prefixed_files(&own.join("media"), &prefix);
  removed += remove_prefixed_files(&own.join("tmp"), &prefix);

  // Per-record subtitle & JSON caches directly under own_dir (never touches clips/).
  let srt = own.join(format!("{id}.srt"));
  if srt.is_file() && std::fs::remove_file(&srt).is_ok() {
    removed += 1;
  }
  for kind in CACHE_KINDS {
    for suffix in ["json", "json.tmp"] {
      let path = own.join(format!("{id}.{kind}.{suffix}"));
      if path.is_file() && std::fs::remove_file(&path).is_ok() {
        removed += 1;
      }
    }
  }
  Ok(removed)
}

#[tauri::command]
pub fn android_purge_files(id: String) -> Result<u32, String> {
  let own = own_dir()?;
  purge_files_in(&own, &id)
}

fn extract_prefix_id(name: &str) -> Option<&str> {
  let (stem, _rest) = name.split_once('.')?;
  valid_id(stem).then_some(stem)
}

fn is_older_than(entry: &std::fs::DirEntry, now: SystemTime, min_age: Duration) -> bool {
  entry
    .metadata()
    .and_then(|m| m.modified())
    .map(|modified| now.duration_since(modified).unwrap_or_default() >= min_age)
    .unwrap_or(false)
}

pub(crate) fn sweep_orphans_with_ages(
  own: &Path,
  keep_ids: &[String],
  active_import_ids: &[String],
  now: SystemTime,
  media_age: Duration,
  tmp_age: Duration,
) -> Result<u32, String> {
  // Never sweep anything when keep_ids is empty (protects against unreadable/empty DB states).
  if keep_ids.is_empty() {
    return Ok(0);
  }
  let keep: HashSet<&str> = keep_ids.iter().map(String::as_str).collect();
  let active: HashSet<&str> = active_import_ids.iter().map(String::as_str).collect();
  let mut removed = 0u32;

  if let Ok(entries) = std::fs::read_dir(own.join("media")) {
    for entry in entries.flatten() {
      if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
        continue;
      }
      let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
      let Some(id) = extract_prefix_id(&name) else { continue };
      let is_partial = name.ends_with(".part") || name.ends_with(".tmp");
      if is_partial {
        if !active.contains(id) && is_older_than(&entry, now, tmp_age) && std::fs::remove_file(entry.path()).is_ok() {
          removed += 1;
        }
      } else if !keep.contains(id)
        && !active.contains(id)
        && is_older_than(&entry, now, media_age)
        && std::fs::remove_file(entry.path()).is_ok()
      {
        removed += 1;
      }
    }
  }

  if let Ok(entries) = std::fs::read_dir(own.join("tmp")) {
    for entry in entries.flatten() {
      if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
        continue;
      }
      let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
      let Some(id) = extract_prefix_id(&name) else { continue };
      if !active.contains(id) && is_older_than(&entry, now, tmp_age) && std::fs::remove_file(entry.path()).is_ok() {
        removed += 1;
      }
    }
  }

  // Sweep stale per-export ZIP directories under tmp/exports/<uuid>/ once older than tmp_age.
  if let Ok(entries) = std::fs::read_dir(own.join("tmp").join("exports")) {
    for entry in entries.flatten() {
      if is_older_than(&entry, now, tmp_age) {
        let p = entry.path();
        let ok = if p.is_dir() {
          std::fs::remove_dir_all(&p).is_ok()
        } else {
          std::fs::remove_file(&p).is_ok()
        };
        if ok {
          removed += 1;
        }
      }
    }
  }

  // Sweep orphaned per-record root .srt and .<kind>.json caches directly under own_dir (never touches clips/).
  if let Ok(entries) = std::fs::read_dir(own) {
    for entry in entries.flatten() {
      if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
        continue;
      }
      let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
      let Some((stem, rest)) = name.split_once('.') else { continue };
      if !valid_id(stem) || keep.contains(stem) || active.contains(stem) {
        continue;
      }
      let is_known_cache = rest == "srt"
        || CACHE_KINDS
          .iter()
          .any(|k| rest == format!("{k}.json") || rest == format!("{k}.json.tmp"));
      if is_known_cache && is_older_than(&entry, now, media_age) && std::fs::remove_file(entry.path()).is_ok() {
        removed += 1;
      }
    }
  }

  Ok(removed)
}

#[tauri::command]
pub fn android_sweep_orphans(keep_ids: Vec<String>, active_import_ids: Vec<String>) -> Result<u32, String> {
  let own = own_dir()?;
  sweep_orphans_with_ages(&own, &keep_ids, &active_import_ids, SystemTime::now(), MEDIA_ORPHAN_AGE, TMP_ORPHAN_AGE)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn temp_own(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lc-android-pod-{tag}-{}", uuid::Uuid::new_v4()));
    for sub in ["media", "tmp", "clips"] {
      std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    dir
  }

  #[test]
  fn purge_files_rejects_invalid_ids_and_preserves_other_ids_and_clips() {
    let own = temp_own("purge");
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let other = "550e8400-e29b-41d4-a716-446655440001";
    let prefix_peer = "550e8400-e29b-41d4-a716-446655440000-1";

    for bad in ["", "../etc", "foo/bar", "a.b", "id with space"] {
      assert!(purge_files_in(&own, bad).is_err(), "expected invalid id {bad:?} to fail");
    }

    // Target files
    std::fs::write(own.join("media").join(format!("{id}.mp3")), b"audio").unwrap();
    std::fs::write(own.join("media").join(format!("{id}.part")), b"part").unwrap();
    std::fs::create_dir_all(own.join("media").join(format!("{id}.dir"))).unwrap();
    std::fs::write(own.join("tmp").join(format!("{id}.plan.json")), b"{}").unwrap();
    std::fs::write(own.join("tmp").join(format!("{id}.piece.0.json")), b"{}").unwrap();
    std::fs::write(own.join("tmp").join(format!("{id}.wav")), b"wav").unwrap();
    std::fs::write(own.join("tmp").join(format!("{id}.m4a")), b"m4a").unwrap();
    std::fs::write(own.join(format!("{id}.srt")), b"1\n").unwrap();
    std::fs::write(own.join(format!("{id}.srt.json")), b"{}").unwrap();
    std::fs::write(own.join(format!("{id}.words.json")), b"[]").unwrap();
    std::fs::write(own.join(format!("{id}.cloze.json")), b"{}").unwrap();
    std::fs::write(own.join(format!("{id}.trans.json")), b"{}").unwrap();
    std::fs::write(own.join(format!("{id}.keywords.json")), b"{}").unwrap();
    std::fs::write(own.join(format!("{id}.phrases.json")), b"{}").unwrap();

    // Must NOT be touched
    let clip = own.join("clips").join(format!("{id}_1.20.m4a"));
    let other_media = own.join("media").join(format!("{other}.mp3"));
    let peer_media = own.join("media").join(format!("{prefix_peer}.mp3"));
    let other_tmp = own.join("tmp").join(format!("{other}.wav"));
    let other_words = own.join(format!("{other}.words.json"));
    for p in [&clip, &other_media, &peer_media, &other_tmp, &other_words] {
      std::fs::write(p, b"keep").unwrap();
    }

    let removed = purge_files_in(&own, id).unwrap();
    assert_eq!(removed, 13);

    assert!(!own.join("media").join(format!("{id}.mp3")).exists());
    assert!(!own.join("media").join(format!("{id}.part")).exists());
    assert!(own.join("media").join(format!("{id}.dir")).is_dir(), "must not delete subdirectories");
    assert!(!own.join("tmp").join(format!("{id}.plan.json")).exists());
    assert!(!own.join("tmp").join(format!("{id}.piece.0.json")).exists());
    assert!(!own.join("tmp").join(format!("{id}.wav")).exists());
    assert!(!own.join("tmp").join(format!("{id}.m4a")).exists());
    assert!(!own.join(format!("{id}.srt")).exists());
    assert!(!own.join(format!("{id}.words.json")).exists());
    assert!(!own.join(format!("{id}.phrases.json")).exists());

    for p in [&clip, &other_media, &peer_media, &other_tmp, &other_words] {
      assert!(p.is_file(), "must keep {}", p.display());
    }
    let _ = std::fs::remove_dir_all(&own);
  }

  #[test]
  fn sweep_orphans_does_nothing_when_keep_ids_empty() {
    let own = temp_own("empty-keep");
    let orphan_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let m = own.join("media").join(format!("{orphan_id}.mp3"));
    let t = own.join("tmp").join(format!("{orphan_id}.wav"));
    std::fs::write(&m, b"x").unwrap();
    std::fs::write(&t, b"y").unwrap();

    let far_future = SystemTime::now() + Duration::from_secs(48 * 3600);
    let n = sweep_orphans_with_ages(&own, &[], &[], far_future, MEDIA_ORPHAN_AGE, TMP_ORPHAN_AGE).unwrap();
    assert_eq!(n, 0);
    assert!(m.is_file());
    assert!(t.is_file());
    let _ = std::fs::remove_dir_all(&own);
  }

  #[test]
  fn sweep_orphans_respects_ages_keep_active_and_never_touches_clips() {
    let own = temp_own("sweep");
    let keep_id = "11111111-1111-1111-1111-111111111111";
    let active_id = "22222222-2222-2222-2222-222222222222";
    let orphan_id = "33333333-3333-3333-3333-333333333333";

    let kept_media = own.join("media").join(format!("{keep_id}.mp3"));
    let orphan_media = own.join("media").join(format!("{orphan_id}.mp3"));
    let orphan_part = own.join("media").join(format!("{orphan_id}.part"));
    let active_part = own.join("media").join(format!("{active_id}.part"));
    let unknown_media = own.join("media").join("not-a-valid-id.mp3");
    let orphan_tmp = own.join("tmp").join(format!("{orphan_id}.piece.0.json"));
    let active_tmp = own.join("tmp").join(format!("{active_id}.wav"));
    let orphan_clip = own.join("clips").join(format!("{orphan_id}_0.00.m4a"));
    let export_dir = own.join("tmp").join("exports").join("exp-uuid-1");
    std::fs::create_dir_all(&export_dir).unwrap();
    let export_zip = export_dir.join("LinguaClip-backup-2026-11-24.zip");
    let orphan_root_words = own.join(format!("{orphan_id}.words.json"));
    let kept_root_words = own.join(format!("{keep_id}.words.json"));

    for p in [&kept_media, &orphan_media, &orphan_part, &active_part, &unknown_media, &orphan_tmp, &active_tmp, &orphan_clip, &export_zip, &orphan_root_words, &kept_root_words] {
      std::fs::write(p, b"data").unwrap();
    }

    let keep = vec![keep_id.to_string()];
    let active = vec![active_id.to_string()];

    // Fresh files (now): nothing deleted.
    let n0 = sweep_orphans_with_ages(&own, &keep, &active, SystemTime::now(), MEDIA_ORPHAN_AGE, TMP_ORPHAN_AGE).unwrap();
    assert_eq!(n0, 0);
    assert!(orphan_media.is_file());
    assert!(orphan_part.is_file());
    assert!(orphan_tmp.is_file());
    assert!(export_zip.is_file());
    assert!(orphan_root_words.is_file());

    // After 2 hours: orphan .part, orphan tmp, and stale export dir are deleted; orphan finished media (<24h) & active tmp/part stay.
    let plus_2h = SystemTime::now() + Duration::from_secs(2 * 3600);
    let n1 = sweep_orphans_with_ages(&own, &keep, &active, plus_2h, MEDIA_ORPHAN_AGE, TMP_ORPHAN_AGE).unwrap();
    assert_eq!(n1, 3);
    assert!(!orphan_part.exists());
    assert!(!orphan_tmp.exists());
    assert!(!export_dir.exists());
    assert!(orphan_media.is_file(), "finished media under 24h must stay");
    assert!(orphan_root_words.is_file(), "root cache under 24h must stay");
    assert!(active_part.is_file(), "active import .part must stay");
    assert!(active_tmp.is_file(), "active import tmp must stay");
    assert!(kept_media.is_file());
    assert!(unknown_media.is_file());
    assert!(orphan_clip.is_file());

    // After 25 hours: orphan finished media and orphan root cache are now deleted; kept, active, unknown, and clips remain untouched.
    let plus_25h = SystemTime::now() + Duration::from_secs(25 * 3600);
    let n2 = sweep_orphans_with_ages(&own, &keep, &active, plus_25h, MEDIA_ORPHAN_AGE, TMP_ORPHAN_AGE).unwrap();
    assert_eq!(n2, 2);
    assert!(!orphan_media.exists());
    assert!(!orphan_root_words.exists());
    assert!(kept_media.is_file());
    assert!(kept_root_words.is_file());
    assert!(active_part.is_file());
    assert!(active_tmp.is_file());
    assert!(unknown_media.is_file());
    assert!(orphan_clip.is_file(), "clips/ must never be touched");

    let _ = std::fs::remove_dir_all(&own);
  }
}
