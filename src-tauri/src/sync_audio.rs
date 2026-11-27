// Streaming WebDAV audio relay for Desktop -> Android sync (docs/sync.md).
// Encodes mono AAC .m4a via ffmpeg to a temp file, streams it atomically to audio/,
// and downloads/verifies SHA-256 into <own>/media/<videoId>.m4a without buffering whole files in RAM.
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::cache::valid_id;
use crate::paths::own_dir;
use crate::sync_webdav::{
  build_client, build_stream_client, build_upload_client, download_to_file_sha256,
  ensure_subdir, put_file_atomic, valid_sha256_hex, validate_rel_path, Endpoint, WebDavConfig,
};

pub(crate) const MAX_SYNC_AUDIO_BYTES: u64 = 100 * 1024 * 1024;
const LONG_AUDIO_SECS: f64 = 7200.0;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedSyncAudio {
  pub file: String,
  pub sha256: String,
  pub bytes: u64,
  pub dur_sec: u32,
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.0);
  }
}

fn io_err(e: impl std::fmt::Display) -> String {
  format!("sync:io:{e}")
}

fn replace_file(src: &Path, dst: &Path) -> Result<(), String> {
  match fs::rename(src, dst) {
    Ok(()) => Ok(()),
    Err(_) if dst.exists() => {
      fs::remove_file(dst).map_err(io_err)?;
      fs::rename(src, dst).map_err(io_err)
    }
    Err(e) => Err(io_err(e)),
  }
}

fn hash_file_bounded(path: &Path) -> Result<(u64, String), String> {
  let meta = fs::metadata(path).map_err(io_err)?;
  if !meta.is_file() {
    return Err("sync:audio_missing_src".into());
  }
  let len = meta.len();
  if len == 0 {
    return Err("sync:audio_empty".into());
  }
  if len > MAX_SYNC_AUDIO_BYTES {
    return Err("sync:audio_too_large".into());
  }
  let mut file = File::open(path).map_err(io_err)?;
  let mut hasher = Sha256::new();
  let mut buf = [0u8; 64 * 1024];
  let mut total = 0u64;
  loop {
    let n = file.read(&mut buf).map_err(io_err)?;
    if n == 0 {
      break;
    }
    total += n as u64;
    if total > MAX_SYNC_AUDIO_BYTES {
      return Err("sync:audio_too_large".into());
    }
    hasher.update(&buf[..n]);
  }
  if total == 0 {
    return Err("sync:audio_empty".into());
  }
  let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
  Ok((total, hex))
}

fn encode_sync_audio_file(src: &Path, out_part: &Path) -> Result<u32, String> {
  if !src.is_file() {
    return Err("sync:audio_missing_src".into());
  }
  let ffmpeg = crate::convert::ensure(|_| {})?;
  let probe = crate::convert::probe_with(&ffmpeg, src).map_err(|e| format!("sync:audio_probe:{e}"))?;
  if probe.audio.is_none() {
    return Err("sync:audio_no_track".into());
  }
  let dur = probe.duration.unwrap_or(0.0);
  if let Some(parent) = out_part.parent() {
    fs::create_dir_all(parent).map_err(io_err)?;
  }
  let mut cmd = crate::paths::command(&ffmpeg);
  cmd.args(["-hide_banner", "-v", "error", "-y", "-i"]).arg(src);
  cmd.args(["-vn", "-map", "0:a:0", "-ac", "1", "-c:a", "aac"]);
  if dur > LONG_AUDIO_SECS {
    cmd.args(["-b:a", "32k", "-ar", "24000"]);
  } else {
    cmd.args(["-b:a", "48k"]);
  }
  cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(out_part);
  let out = cmd.output().map_err(|e| {
    let _ = fs::remove_file(out_part);
    format!("sync:audio_encode:{e}")
  })?;
  if !out.status.success() || !out_part.is_file() {
    let _ = fs::remove_file(out_part);
    let detail = crate::import::tail_chars(&String::from_utf8_lossy(&out.stderr), 300);
    return Err(format!("sync:audio_encode:{detail}"));
  }
  Ok(dur.round().max(0.0) as u32)
}

pub(crate) async fn upload_audio_file_in(
  _own: PathBuf,
  config: WebDavConfig,
  file_path: PathBuf,
  rel_path: String,
  dur_sec: u32,
  max_bytes: Option<u64>,
) -> Result<UploadedSyncAudio, String> {
  let ep = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  let Some(file) = rel_path.strip_prefix("audio/").map(str::to_string) else {
    return Err(format!("sync:invalid_path:{rel_path}"));
  };
  let path_for_hash = file_path.clone();
  let (bytes, sha256) = tauri::async_runtime::spawn_blocking(move || hash_file_bounded(&path_for_hash))
    .await
    .map_err(io_err)??;
  if bytes > MAX_SYNC_AUDIO_BYTES {
    return Err("sync:audio_too_large".into());
  }
  if max_bytes.is_some_and(|cap| bytes > cap) {
    return Err("sync:audio_budget".into());
  }
  let dir_client = build_client(ep.is_local, 60)?;
  ensure_subdir(&dir_client, &ep, "audio").await?;
  let upload_client = build_upload_client(ep.is_local)?;
  put_file_atomic(&upload_client, &ep, &rel_path, &file_path, "audio/mp4").await?;
  Ok(UploadedSyncAudio { file, sha256, bytes, dur_sec })
}

pub(crate) async fn download_audio_in(
  own: PathBuf,
  config: WebDavConfig,
  rel_path: String,
  video_id: String,
  expected_sha256: String,
) -> Result<String, String> {
  if !valid_id(&video_id) {
    return Err("sync:invalid_id".into());
  }
  let ep = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  if !rel_path.starts_with("audio/") {
    return Err(format!("sync:invalid_path:{rel_path}"));
  }
  if !valid_sha256_hex(&expected_sha256) {
    return Err("sync:corrupt:sha256".into());
  }
  let tmp_dir = own.join("tmp");
  fs::create_dir_all(&tmp_dir).map_err(io_err)?;
  let tmp_part = tmp_dir.join(format!("sync-audio-dl-{}.m4a.part", uuid::Uuid::new_v4()));
  let _guard = TempFileGuard(tmp_part.clone());

  let client = build_stream_client(ep.is_local, 120)?;
  let (bytes, actual_sha256) = download_to_file_sha256(&client, &ep, &rel_path, &tmp_part, MAX_SYNC_AUDIO_BYTES).await?;
  if bytes == 0 {
    return Err("sync:corrupt:empty".into());
  }
  if actual_sha256 != expected_sha256 {
    return Err("sync:corrupt:sha256".into());
  }
  let media_dir = own.join("media");
  fs::create_dir_all(&media_dir).map_err(io_err)?;
  let dest = media_dir.join(format!("{video_id}.m4a"));
  replace_file(&tmp_part, &dest)?;
  Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sync_upload_audio(
  config: WebDavConfig,
  src_path: String,
  rel_path: String,
  max_bytes: Option<u64>,
) -> Result<UploadedSyncAudio, String> {
  let _ = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  if !rel_path.starts_with("audio/") {
    return Err(format!("sync:invalid_path:{rel_path}"));
  }
  let own = own_dir()?;
  let tmp_dir = own.join("tmp");
  fs::create_dir_all(&tmp_dir).map_err(io_err)?;
  let out_part = tmp_dir.join(format!("sync-audio-{}.m4a.part", uuid::Uuid::new_v4()));
  let _guard = TempFileGuard(out_part.clone());

  let src = PathBuf::from(&src_path);
  let part_for_encode = out_part.clone();
  let dur_sec = tauri::async_runtime::spawn_blocking(move || encode_sync_audio_file(&src, &part_for_encode))
    .await
    .map_err(io_err)??;
  upload_audio_file_in(own, config, out_part, rel_path, dur_sec, max_bytes).await
}

#[tauri::command]
pub async fn sync_download_audio(
  config: WebDavConfig,
  rel_path: String,
  video_id: String,
  expected_sha256: String,
) -> Result<String, String> {
  download_audio_in(own_dir()?, config, rel_path, video_id, expected_sha256).await
}
