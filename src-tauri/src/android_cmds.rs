// Commands bridging Android's Kotlin MediaCodec/MediaExtractor layer with our shared
// Rust cloud ASR, podcast downloader, and sandboxed app_local_data_dir paths.
use std::path::PathBuf;

use crate::cloud_asr::{self, CutPiece, PreparedPiece};
use crate::import::Word;
use crate::paths::own_dir;
use crate::podcast;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPaths {
  pub own_dir: String,
  pub media_dir: String,
  pub clips_dir: String,
  pub tmp_dir: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTranscribeResult {
  pub subtitle_text: String,
  pub words: Vec<Word>,
}

#[tauri::command]
pub fn android_paths() -> Result<AndroidPaths, String> {
  let own = own_dir()?;
  let media = own.join("media");
  let clips = own.join("clips");
  let tmp = own.join("tmp");
  for d in [&own, &media, &clips, &tmp] {
    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
  }
  Ok(AndroidPaths {
    own_dir: own.to_string_lossy().into_owned(),
    media_dir: media.to_string_lossy().into_owned(),
    clips_dir: clips.to_string_lossy().into_owned(),
    tmp_dir: tmp.to_string_lossy().into_owned(),
  })
}

#[tauri::command]
pub async fn plan_wav_cuts(wav_path: String, piece_secs: Option<u64>) -> Result<Vec<CutPiece>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let p = PathBuf::from(&wav_path);
    cloud_asr::plan_cuts(&p, piece_secs.unwrap_or(60 * 60))
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn transcribe_prepared_pieces(
  id: String,
  provider: String,
  api_key: String,
  base_url: Option<String>,
  model: Option<String>,
  lang: String,
  pieces: Vec<PreparedPiece>,
) -> Result<PreparedTranscribeResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !crate::cache::valid_id(&id) {
      return Err("bad-id".into());
    }
    let _turn = crate::import_queue::wait_turn(&id, || {})?;
    let own = own_dir()?;
    std::fs::create_dir_all(&own).map_err(|e| e.to_string())?;
    let stem = own.join(&id);
    let (subtitle_text, words) = cloud_asr::transcribe_prepared_pieces(
      &provider,
      &api_key,
      base_url.as_deref(),
      model.as_deref(),
      &lang,
      &pieces,
      &stem,
    )?;
    let words_json = serde_json::to_string(&words).map_err(|e| e.to_string())?;
    let _ = std::fs::write(own.join(format!("{id}.words.json")), words_json);
    Ok(PreparedTranscribeResult { subtitle_text, words })
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_podcast_audio(id: String, url: String, stem: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !crate::cache::valid_id(&id) {
      return Err("bad-id".into());
    }
    let _turn = crate::import_queue::wait_turn(&id, || {})?;
    let media = own_dir()?.join("media");
    std::fs::create_dir_all(&media).map_err(|e| e.to_string())?;
    let safe = podcast::safe_stem(&stem).unwrap_or_else(|| id.clone());
    let path = podcast::download(&url, &media, &safe, crate::import_queue::check, |_| {})?;
    Ok(path.to_string_lossy().into_owned())
  })
  .await
  .map_err(|e| e.to_string())?
}
