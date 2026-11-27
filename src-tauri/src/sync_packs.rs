// Streaming clip-pack zip upload/download, offline merge-pack zip read/write/unpack,
// and local cache/media rekey commands for Desktop + Android sync (docs/sync.md).
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::cache::valid_id;
use crate::clips::safe_name;
use crate::paths::own_dir;
use crate::sync_webdav::{
  build_client, download_to_file_limited, gzip_compress, gzip_decompress_utf8, put_bytes_atomic,
  valid_sha256_hex, validate_rel_path, Endpoint, WebDavConfig,
};

const DEFAULT_PACK_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_CLIP_MAX_BYTES: u64 = 1_572_864; // 1.5 MiB
const DOWNLOAD_PACK_MAX_BYTES: u64 = 20 * 1024 * 1024;
const CLIP_EXTRACT_MAX_FILE: u64 = 20 * 1024 * 1024;
const CLIP_EXTRACT_MAX_TOTAL: u64 = 32 * 1024 * 1024;
const MERGE_SNAPSHOT_MAX: u64 = 64 * 1024 * 1024;
const MERGE_SUB_GZ_MAX: u64 = 16 * 1024 * 1024;
const MERGE_SUB_RAW_MAX: u64 = 32 * 1024 * 1024;
const MERGE_SUBS_TOTAL_MAX: u64 = 256 * 1024 * 1024;
const MERGE_CLIP_MAX_FILE: u64 = 50 * 1024 * 1024;
const MERGE_CLIP_MAX_TOTAL: u64 = 500 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 50_000;
const REKEY_CACHE_KINDS: [&str; 8] = [
  "words", "cloze", "breakdown", "segments", "levels", "trans", "keywords", "phrases",
];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePackContents {
  pub snapshot_json: String,
  pub subs: Vec<(String, String)>,
  pub clip_names: Vec<String>,
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.0);
  }
}

fn tmp_sibling(dest: &Path) -> PathBuf {
  let mut name = dest.file_name().unwrap_or_default().to_os_string();
  name.push(".tmp");
  dest.with_file_name(name)
}

fn io_err(e: impl std::fmt::Display) -> String {
  format!("sync:io:{e}")
}

// Writes a zip entry to `<clips_dir>/<name>.sync.part` (removing any stale .sync.part first
// so the newly created file always carries a fresh current mtime), syncs, then renames atomically.
fn extract_clip_entry<R: Read>(entry: &mut R, clips_dir: &Path, name: &str, max_file: u64) -> Result<u64, String> {
  fs::create_dir_all(clips_dir).map_err(io_err)?;
  let dest = clips_dir.join(name);
  let part = clips_dir.join(format!("{name}.sync.part"));
  let _ = fs::remove_file(&part);
  let res = (|| -> Result<u64, String> {
    let mut f = File::create(&part).map_err(io_err)?;
    let got = std::io::copy(&mut entry.take(max_file + 1), &mut f).map_err(|e| format!("sync:corrupt:{e}"))?;
    if got > max_file {
      return Err("sync:corrupt:clip_too_large".into());
    }
    f.sync_all().map_err(io_err)?;
    Ok(got)
  })();
  match res {
    Ok(got) => {
      fs::rename(&part, &dest).map_err(|e| {
        let _ = fs::remove_file(&part);
        io_err(e)
      })?;
      Ok(got)
    }
    Err(e) => {
      let _ = fs::remove_file(&part);
      Err(e)
    }
  }
}

fn pack_clips_to_zip(own: &Path, zip_path: &Path, files: &[String], max_bytes: u64, max_file_bytes: u64) -> Result<Vec<String>, String> {
  if let Some(parent) = zip_path.parent() {
    fs::create_dir_all(parent).map_err(io_err)?;
  }
  let clips_dir = own.join("clips");
  let (mut seen, mut selected, mut raw_total) = (HashSet::new(), Vec::new(), 0u64);
  for name in files {
    safe_name(name)?;
    if !seen.insert(name.clone()) {
      continue;
    }
    let path = clips_dir.join(name);
    let Ok(meta) = fs::metadata(&path) else { continue };
    let len = meta.len();
    if !meta.is_file() || len > max_file_bytes || raw_total.saturating_add(len) > max_bytes {
      continue;
    }
    raw_total += len;
    selected.push((name.clone(), path));
  }
  if selected.is_empty() {
    return Ok(vec![]);
  }
  let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true);
  let mut z = ZipWriter::new(File::create(zip_path).map_err(io_err)?);
  let mut packed = Vec::with_capacity(selected.len());
  for (name, path) in selected {
    z.start_file(&name, stored).map_err(io_err)?;
    std::io::copy(&mut File::open(&path).map_err(io_err)?, &mut z).map_err(io_err)?;
    packed.push(name);
  }
  z.finish().map_err(io_err)?.sync_all().map_err(io_err)?;
  Ok(packed)
}

fn unpack_clips_from_zip(
  own: &Path,
  zip_path: &Path,
  wanted: &HashSet<String>,
  require_clips_prefix: bool,
  max_file: u64,
  max_total: u64,
) -> Result<Vec<String>, String> {
  let mut z = ZipArchive::new(File::open(zip_path).map_err(io_err)?).map_err(|e| format!("sync:corrupt:bad_zip:{e}"))?;
  if z.len() > MAX_ZIP_ENTRIES {
    return Err("sync:corrupt:too_many_entries".into());
  }
  let clips_dir = own.join("clips");
  let (mut total, mut extracted, mut seen) = (0u64, Vec::new(), HashSet::new());
  for i in 0..z.len() {
    let mut entry = z.by_index(i).map_err(|e| format!("sync:corrupt:{e}"))?;
    if !entry.is_file() {
      continue;
    }
    let raw_name = entry.name().to_string();
    let name = if require_clips_prefix {
      let Some(rest) = raw_name.strip_prefix("clips/") else { continue };
      rest
    } else {
      raw_name.strip_prefix("clips/").unwrap_or(&raw_name)
    };
    if safe_name(name).is_err() || !wanted.contains(name) || !seen.insert(name.to_string()) {
      continue;
    }
    total += extract_clip_entry(&mut entry, &clips_dir, name, max_file)?;
    if total > max_total {
      return Err("sync:corrupt:pack_total_too_large".into());
    }
    extracted.push(name.to_string());
  }
  Ok(extracted)
}

pub(crate) async fn upload_clip_pack_in(
  own: PathBuf,
  config: WebDavConfig,
  rel_path: String,
  files: Vec<String>,
  max_bytes: Option<u64>,
  max_file_bytes: Option<u64>,
) -> Result<Vec<String>, String> {
  let ep = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  if !rel_path.starts_with("clip-packs/") {
    return Err(format!("sync:invalid_path:{rel_path}"));
  }
  let (pack_cap, file_cap) = (max_bytes.unwrap_or(DEFAULT_PACK_MAX_BYTES), max_file_bytes.unwrap_or(DEFAULT_CLIP_MAX_BYTES));
  let tmp_zip = own.join("tmp").join(format!("sync-up-{}.zip", uuid::Uuid::new_v4()));
  let _guard = TempFileGuard(tmp_zip.clone());

  let zip_for_pack = tmp_zip.clone();
  let packed = tauri::async_runtime::spawn_blocking(move || pack_clips_to_zip(&own, &zip_for_pack, &files, pack_cap, file_cap))
    .await
    .map_err(io_err)??;
  if packed.is_empty() {
    return Ok(vec![]);
  }
  let bytes = tokio::fs::read(&tmp_zip).await.map_err(io_err)?;
  put_bytes_atomic(&build_client(ep.is_local, 180)?, &ep, &rel_path, bytes, "application/zip").await?;
  Ok(packed)
}

pub(crate) async fn download_clip_pack_in(
  own: PathBuf,
  config: WebDavConfig,
  rel_path: String,
  wanted_files: Vec<String>,
) -> Result<Vec<String>, String> {
  let ep = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  if !rel_path.starts_with("clip-packs/") {
    return Err(format!("sync:invalid_path:{rel_path}"));
  }
  let mut wanted = HashSet::with_capacity(wanted_files.len());
  for name in wanted_files {
    safe_name(&name)?;
    wanted.insert(name);
  }
  if wanted.is_empty() {
    return Ok(vec![]);
  }
  let tmp_dir = own.join("tmp");
  fs::create_dir_all(&tmp_dir).map_err(io_err)?;
  let tmp_zip = tmp_dir.join(format!("sync-dl-{}.zip", uuid::Uuid::new_v4()));
  let _guard = TempFileGuard(tmp_zip.clone());

  let client = build_client(ep.is_local, 180)?;
  download_to_file_limited(&client, &ep, &rel_path, &tmp_zip, DOWNLOAD_PACK_MAX_BYTES).await?;
  let zip_for_unpack = tmp_zip.clone();
  tauri::async_runtime::spawn_blocking(move || {
    unpack_clips_from_zip(&own, &zip_for_unpack, &wanted, false, CLIP_EXTRACT_MAX_FILE, CLIP_EXTRACT_MAX_TOTAL)
  })
  .await
  .map_err(io_err)?
}

pub(crate) fn write_merge_pack_in(
  own: &Path,
  dest: Option<String>,
  snapshot_json: &str,
  subs: &[(String, String)],
  clip_files: &[String],
) -> Result<String, String> {
  if snapshot_json.len() as u64 > MERGE_SNAPSHOT_MAX {
    return Err("sync:corrupt:snapshot_too_large".into());
  }
  let out_path = match dest {
    Some(d) => {
      let p = PathBuf::from(d);
      if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
      }
      p
    }
    None => {
      let dir = own.join("tmp").join("exports").join(uuid::Uuid::new_v4().to_string());
      fs::create_dir_all(&dir).map_err(io_err)?;
      dir.join(format!("LinguaClip-sync-{}.zip", chrono::Local::now().format("%Y-%m-%d")))
    }
  };
  let tmp = tmp_sibling(&out_path);
  let res = (|| -> Result<(), String> {
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(true);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true);
    let mut z = ZipWriter::new(File::create(&tmp).map_err(io_err)?);
    z.start_file("sync.json", deflate).map_err(io_err)?;
    z.write_all(snapshot_json.as_bytes()).map_err(io_err)?;

    let mut seen_subs = HashSet::new();
    for (hash, srt) in subs {
      if !valid_sha256_hex(hash) {
        return Err(format!("sync:invalid_path:subs/{hash}.srt.gz"));
      }
      if seen_subs.insert(hash.as_str()) {
        let gz = gzip_compress(srt.as_bytes())?;
        z.start_file(format!("subs/{hash}.srt.gz"), stored).map_err(io_err)?;
        z.write_all(&gz).map_err(io_err)?;
      }
    }
    let clips_dir = own.join("clips");
    let mut seen_clips = HashSet::new();
    for name in clip_files {
      safe_name(name)?;
      if !seen_clips.insert(name.as_str()) {
        continue;
      }
      let src_path = clips_dir.join(name);
      if src_path.is_file() {
        z.start_file(format!("clips/{name}"), stored).map_err(io_err)?;
        std::io::copy(&mut File::open(&src_path).map_err(io_err)?, &mut z).map_err(io_err)?;
      }
    }
    z.finish().map_err(io_err)?.sync_all().map_err(io_err)
  })();
  match res {
    Ok(()) => {
      fs::rename(&tmp, &out_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err(e)
      })?;
      Ok(out_path.to_string_lossy().into_owned())
    }
    Err(e) => {
      let _ = fs::remove_file(&tmp);
      Err(e)
    }
  }
}

pub(crate) fn read_merge_pack_at(path: &Path) -> Result<MergePackContents, String> {
  let mut z = ZipArchive::new(File::open(path).map_err(io_err)?).map_err(|e| format!("sync:corrupt:bad_zip:{e}"))?;
  if z.len() > MAX_ZIP_ENTRIES {
    return Err("sync:corrupt:too_many_entries".into());
  }
  let (mut snapshot_json, mut subs, mut clip_names, mut subs_total) = (None, Vec::new(), Vec::new(), 0u64);
  for i in 0..z.len() {
    let mut entry = z.by_index(i).map_err(|e| format!("sync:corrupt:{e}"))?;
    if !entry.is_file() {
      continue;
    }
    let name = entry.name().to_string();
    if name == "sync.json" {
      if entry.size() > MERGE_SNAPSHOT_MAX {
        return Err("sync:corrupt:snapshot_too_large".into());
      }
      let mut s = String::new();
      (&mut entry).take(MERGE_SNAPSHOT_MAX + 1).read_to_string(&mut s).map_err(|e| format!("sync:corrupt:{e}"))?;
      if s.len() as u64 > MERGE_SNAPSHOT_MAX {
        return Err("sync:corrupt:snapshot_too_large".into());
      }
      snapshot_json = Some(s);
    } else if let Some(hash) = name.strip_prefix("subs/").and_then(|r| r.strip_suffix(".srt.gz")) {
      if !valid_sha256_hex(hash) {
        continue;
      }
      let mut gz_buf = Vec::new();
      (&mut entry).take(MERGE_SUB_GZ_MAX + 1).read_to_end(&mut gz_buf).map_err(|e| format!("sync:corrupt:{e}"))?;
      if gz_buf.len() as u64 > MERGE_SUB_GZ_MAX {
        return Err("sync:corrupt:sub_too_large".into());
      }
      let text = gzip_decompress_utf8(&gz_buf, MERGE_SUB_RAW_MAX)?;
      subs_total += text.len() as u64;
      if subs_total > MERGE_SUBS_TOTAL_MAX {
        return Err("sync:corrupt:subs_too_large".into());
      }
      subs.push((hash.to_string(), text));
    } else if let Some(clip) = name.strip_prefix("clips/") {
      // Never read audio/video bytes into memory here — only collect validated names.
      if safe_name(clip).is_ok() {
        clip_names.push(clip.to_string());
      }
    }
  }
  let snapshot_json = snapshot_json.ok_or_else(|| "sync:corrupt:missing_sync_json".to_string())?;
  Ok(MergePackContents { snapshot_json, subs, clip_names })
}

pub(crate) fn unpack_merge_pack_in(own: &Path, path: &Path, wanted_files: Vec<String>) -> Result<Vec<String>, String> {
  let mut wanted = HashSet::with_capacity(wanted_files.len());
  for name in wanted_files {
    safe_name(&name)?;
    wanted.insert(name);
  }
  if wanted.is_empty() {
    return Ok(vec![]);
  }
  unpack_clips_from_zip(own, path, &wanted, true, MERGE_CLIP_MAX_FILE, MERGE_CLIP_MAX_TOTAL)
}

#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyResult {
  pub moved: u32,
  pub media_paths: Vec<(String, String)>,
}

pub(crate) fn write_merge_json_in(own: &Path, dest: Option<String>, content: &str) -> Result<String, String> {
  let out_path = match dest {
    Some(d) if !d.trim().is_empty() => {
      let p = PathBuf::from(d);
      if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
      }
      p
    }
    _ => {
      let dir = own.join("tmp").join("exports").join(uuid::Uuid::new_v4().to_string());
      fs::create_dir_all(&dir).map_err(io_err)?;
      dir.join(format!("LinguaClip-sync-{}.json", chrono::Local::now().format("%Y-%m-%d")))
    }
  };
  let tmp = tmp_sibling(&out_path);
  let res = (|| -> Result<(), String> {
    let mut f = File::create(&tmp).map_err(io_err)?;
    f.write_all(content.as_bytes()).map_err(io_err)?;
    f.sync_all().map_err(io_err)
  })();
  match res {
    Ok(()) => {
      fs::rename(&tmp, &out_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err(e)
      })?;
      Ok(out_path.to_string_lossy().into_owned())
    }
    Err(e) => {
      let _ = fs::remove_file(&tmp);
      Err(e)
    }
  }
}

pub(crate) fn rekey_files_in(own: &Path, from_id: &str, to_id: &str, include_media: bool) -> Result<RekeyResult, String> {
  if !valid_id(from_id) || !valid_id(to_id) {
    return Err("sync:invalid_id".into());
  }
  if from_id == to_id {
    return Ok(RekeyResult::default());
  }
  let mut moved = 0u32;
  let mut media_paths = Vec::new();
  for kind in REKEY_CACHE_KINDS {
    let (src, dst) = (own.join(format!("{from_id}.{kind}.json")), own.join(format!("{to_id}.{kind}.json")));
    if src.is_file() && !dst.exists() {
      fs::rename(&src, &dst).map_err(io_err)?;
      moved += 1;
    }
  }
  if include_media {
    let media_dir = own.join("media");
    let prefix = format!("{from_id}.");
    if let Ok(entries) = fs::read_dir(&media_dir) {
      for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
          continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let Some(ext) = name.strip_prefix(&prefix) else { continue };
        let skip = ext.is_empty()
          || ext.contains(['/', '\\'])
          || ext == "part"
          || ext == "tmp"
          || ext.ends_with(".part")
          || ext.ends_with(".tmp");
        if skip {
          continue;
        }
        let src_path = entry.path();
        let dst = media_dir.join(format!("{to_id}.{ext}"));
        let pair = (src_path.to_string_lossy().into_owned(), dst.to_string_lossy().into_owned());
        if !dst.exists() {
          fs::rename(&src_path, &dst).map_err(io_err)?;
          moved += 1;
          media_paths.push(pair);
        } else {
          media_paths.push(pair);
        }
      }
    }
  }
  Ok(RekeyResult { moved, media_paths })
}

#[tauri::command]
pub async fn sync_upload_clip_pack(
  config: WebDavConfig,
  rel_path: String,
  files: Vec<String>,
  max_bytes: Option<u64>,
  max_file_bytes: Option<u64>,
) -> Result<Vec<String>, String> {
  upload_clip_pack_in(own_dir()?, config, rel_path, files, max_bytes, max_file_bytes).await
}

#[tauri::command]
pub async fn sync_download_clip_pack(config: WebDavConfig, rel_path: String, wanted_files: Vec<String>) -> Result<Vec<String>, String> {
  download_clip_pack_in(own_dir()?, config, rel_path, wanted_files).await
}

#[tauri::command]
pub async fn sync_write_merge_pack(
  dest: Option<String>,
  snapshot_json: String,
  subs: Vec<(String, String)>,
  clip_files: Vec<String>,
) -> Result<String, String> {
  let own = own_dir()?;
  tauri::async_runtime::spawn_blocking(move || write_merge_pack_in(&own, dest, &snapshot_json, &subs, &clip_files))
    .await
    .map_err(io_err)?
}

#[tauri::command]
pub async fn sync_write_merge_json(dest: Option<String>, content: String) -> Result<String, String> {
  let own = own_dir()?;
  tauri::async_runtime::spawn_blocking(move || write_merge_json_in(&own, dest, &content))
    .await
    .map_err(io_err)?
}

#[tauri::command]
pub async fn sync_read_merge_pack(path: String) -> Result<MergePackContents, String> {
  tauri::async_runtime::spawn_blocking(move || read_merge_pack_at(Path::new(&path)))
    .await
    .map_err(io_err)?
}

#[tauri::command]
pub async fn sync_unpack_merge_pack(path: String, wanted_files: Vec<String>) -> Result<Vec<String>, String> {
  let own = own_dir()?;
  tauri::async_runtime::spawn_blocking(move || unpack_merge_pack_in(&own, Path::new(&path), wanted_files))
    .await
    .map_err(io_err)?
}

#[tauri::command]
pub async fn sync_rekey_files(from_id: String, to_id: String) -> Result<RekeyResult, String> {
  let own = own_dir()?;
  tauri::async_runtime::spawn_blocking(move || rekey_files_in(&own, &from_id, &to_id, cfg!(target_os = "android")))
    .await
    .map_err(io_err)?
}
