// Android resumable cloud ASR commands (transcribe_plan / transcribe_piece / transcribe_finalize / android_cancel_job).
// Owned by M1.2; registered in src-tauri/src/lib.rs on merge.
use std::path::PathBuf;

use crate::android_cmds::PreparedTranscribeResult;
use crate::cloud_asr::{self, TranscribePlan};
use crate::paths::own_dir;

#[allow(dead_code)]
#[tauri::command]
pub fn android_cancel_job(id: String, permanent: Option<bool>) {
  if permanent.unwrap_or(false) {
    crate::import_queue::tombstone(&id);
  } else {
    crate::import_queue::cancel(&id);
  }
}

#[allow(dead_code)]
#[tauri::command]
pub fn android_reset_job(id: String, clear_tmp: Option<bool>) -> Result<u32, String> {
  if !crate::cache::valid_id(&id) {
    return Err("bad-id".into());
  }
  crate::import_queue::clear_tombstone(&id);
  let mut removed = 0u32;
  if clear_tmp.unwrap_or(false) {
    let tmp = own_dir()?.join("tmp");
    let prefix = format!("{id}.");
    if let Ok(entries) = std::fs::read_dir(&tmp) {
      for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
          continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if name.starts_with(&prefix) && std::fs::remove_file(entry.path()).is_ok() {
          removed += 1;
        }
      }
    }
  }
  Ok(removed)
}

#[allow(dead_code)]
#[tauri::command]
pub async fn transcribe_plan(
  id: String,
  media_path: String,
  wav_path: String,
  lang: String,
  piece_secs: Option<u64>,
) -> Result<TranscribePlan, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !crate::cache::valid_id(&id) {
      return Err("bad-id".into());
    }
    if crate::import_queue::is_tombstoned(&id) {
      return Err(crate::import_queue::CANCELLED.into());
    }
    let tmp = own_dir()?.join("tmp");
    cloud_asr::plan_or_load(
      &id,
      &PathBuf::from(&media_path),
      &PathBuf::from(&wav_path),
      &lang,
      piece_secs.unwrap_or(60 * 60),
      &tmp,
    )
  })
  .await
  .map_err(|e| e.to_string())?
}

#[allow(dead_code)]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transcribe_piece(
  id: String,
  plan_id: String,
  idx: usize,
  piece_path: String,
  offset_ms: u64,
  provider: String,
  api_key: String,
  base_url: Option<String>,
  model: Option<String>,
  lang: String,
) -> Result<bool, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !crate::cache::valid_id(&id) {
      return Err("bad-id".into());
    }
    if crate::import_queue::is_tombstoned(&id) {
      return Err(crate::import_queue::CANCELLED.into());
    }
    let _turn = crate::import_queue::wait_turn(&id, || {})?;
    let tmp = own_dir()?.join("tmp");
    cloud_asr::transcribe_single_piece(
      &id,
      &plan_id,
      idx,
      &PathBuf::from(&piece_path),
      offset_ms,
      &provider,
      &api_key,
      base_url.as_deref(),
      model.as_deref(),
      &lang,
      &tmp,
    )
  })
  .await
  .map_err(|e| e.to_string())?
}

#[allow(dead_code)]
#[tauri::command]
pub async fn transcribe_finalize(id: String) -> Result<PreparedTranscribeResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !crate::cache::valid_id(&id) {
      return Err("bad-id".into());
    }
    if crate::import_queue::is_tombstoned(&id) {
      return Err(crate::import_queue::CANCELLED.into());
    }
    let own = own_dir()?;
    let tmp = own.join("tmp");
    let (subtitle_text, words) = cloud_asr::finalize_plan(&id, &tmp, &own)?;
    Ok(PreparedTranscribeResult { subtitle_text, words })
  })
  .await
  .map_err(|e| e.to_string())?
}
