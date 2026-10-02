// Backup and restore (docs/backup.md): one zip with manifest.json + data.json,
// plus — for a backup the user saves by hand — the AI caches and card clips from
// the own dir under `files/`. Automatic and before-restore backups live in
// <own dir>/backups. The frontend (utils/backupData.ts, utils/restore.ts) decides
// what goes in and which old ones to drop; here we only read, write and copy files.
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::cache::{valid_id, valid_kind};
use crate::clips::safe_name;
use crate::paths::own_dir;

const STAGED: &str = "restore-staged.zip";
const MANIFEST_MAX: u64 = 1 << 20;
const DATA_MAX: u64 = 500 << 20;

// What one unpack may write: per file, in all, and how many entries. A backup we write never
// carries a file over the per-file limit, so our own backups always unpack.
struct Limits {
  entry: u64,
  total: u64,
  count: usize,
}
const LIMITS: Limits = Limits { entry: 200 << 20, total: 20 << 30, count: 200_000 };

fn backups_dir(own: &Path) -> PathBuf {
  own.join("backups")
}

// The one whitelist, for packing and unpacking alike: a `files/…` entry name →
// where the file lives, relative to the own dir. Anything else is None.
fn target(entry: &str) -> Option<PathBuf> {
  let rest = entry.strip_prefix("files/")?;
  if let Some(name) = rest.strip_prefix("clips/") {
    return safe_name(name).ok().map(|n| Path::new("clips").join(n));
  }
  let (id, kind) = rest.strip_suffix(".json")?.split_once('.')?;
  (valid_id(id) && valid_kind(kind)).then(|| PathBuf::from(rest))
}

// Caches beside the videos and the card clips, the ones the whitelist lets through and
// no bigger than `max` (bigger ones are left out). An unreadable folder that exists fails
// the backup (unreadable ≠ empty).
fn pack_list(own: &Path, max: u64) -> Result<Vec<(String, PathBuf)>, String> {
  let mut out = vec![];
  for (prefix, dir) in [("files/", own.to_path_buf()), ("files/clips/", own.join("clips"))] {
    let rd = match fs::read_dir(&dir) {
      Ok(rd) => rd,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
      Err(e) => return Err(e.to_string()),
    };
    for e in rd {
      let e = e.map_err(|e| e.to_string())?;
      if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
        continue;
      }
      if e.metadata().map_err(|e| e.to_string())?.len() > max {
        continue;
      }
      let Some(name) = e.file_name().to_str().map(String::from) else { continue };
      let entry = format!("{prefix}{name}");
      if target(&entry).is_some() {
        out.push((entry, e.path()));
      }
    }
  }
  out.sort();
  Ok(out)
}

fn tmp_of(dest: &Path) -> PathBuf {
  let mut name = dest.file_name().unwrap_or_default().to_os_string();
  name.push(".tmp");
  dest.with_file_name(name)
}

// <dest>.tmp first, renamed once whole: a file under the real name is never half written.
fn write_zip(dest: &Path, manifest: &str, data: &str, files: &[(String, PathBuf)]) -> Result<(), String> {
  let tmp = tmp_of(dest);
  let res = (|| -> Result<(), String> {
    let s = |e: zip::result::ZipError| e.to_string();
    let io = |e: std::io::Error| e.to_string();
    let mut z = ZipWriter::new(File::create(&tmp).map_err(io)?);
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(true);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true);
    for (name, text) in [("manifest.json", manifest), ("data.json", data)] {
      z.start_file(name, deflate).map_err(s)?;
      z.write_all(text.as_bytes()).map_err(io)?;
    }
    for (name, path) in files {
      z.start_file(name.as_str(), if name.ends_with(".json") { deflate } else { stored }).map_err(s)?;
      std::io::copy(&mut File::open(path).map_err(io)?, &mut z).map_err(io)?;
    }
    z.finish().map_err(s)?.sync_all().map_err(io)
  })();
  match res {
    Ok(()) => fs::rename(&tmp, dest).map_err(|e| e.to_string()),
    Err(e) => {
      let _ = fs::remove_file(&tmp);
      Err(e)
    }
  }
}

fn name_for(kind: &str) -> Result<String, String> {
  let now = chrono::Local::now();
  match kind {
    "auto" => Ok(format!("LinguaClip-auto-{}.zip", now.format("%Y-%m-%d"))),
    "pre" => Ok(format!("LinguaClip-pre-{}.zip", now.format("%Y%m%d-%H%M%S%3f"))),
    _ => Err("badKind".into()),
  }
}

fn write_in(own: &Path, dest: Option<String>, kind: &str, manifest: &str, data: &str, files: bool) -> Result<PathBuf, String> {
  let dest = match dest {
    Some(d) => PathBuf::from(d),
    None => {
      let dir = backups_dir(own);
      fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
      dir.join(name_for(kind)?)
    }
  };
  let list = if files { pack_list(own, LIMITS.entry)? } else { vec![] };
  // Never write what backup_read / backup_unpack would refuse.
  let total: u64 = list.iter().filter_map(|(_, p)| fs::metadata(p).ok()).map(|m| m.len()).sum();
  if manifest.len() as u64 > MANIFEST_MAX || data.len() as u64 > DATA_MAX || total > LIMITS.total || list.len() + 2 > LIMITS.count {
    return Err("tooBig".into());
  }
  write_zip(&dest, manifest, data, &list)?;
  Ok(dest)
}

// A file directly inside backups/ (restore reads only from there).
fn inside(own: &Path, path: &Path) -> Result<PathBuf, String> {
  let dir = backups_dir(own).canonicalize().map_err(|_| "missing:backup".to_string())?;
  let p = path.canonicalize().map_err(|_| "missing:backup".to_string())?;
  if p.parent() == Some(dir.as_path()) && p.is_file() {
    Ok(p)
  } else {
    Err("notInBackups".into())
  }
}

// Always a copy, even of a file already in backups/: the original stays as it is, and the
// copy (never rotated) is what the restore reads.
fn stage_in(own: &Path, path: &str) -> Result<String, String> {
  let dir = backups_dir(own);
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let dest = dir.join(STAGED);
  let tmp = tmp_of(&dest);
  if let Err(e) = fs::copy(path, &tmp).and_then(|_| File::open(&tmp)?.sync_all()) {
    let _ = fs::remove_file(&tmp);
    return Err(e.to_string());
  }
  fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
  Ok(dest.to_string_lossy().into_owned())
}

fn open(path: &Path) -> Result<ZipArchive<File>, String> {
  ZipArchive::new(File::open(path).map_err(|e| e.to_string())?).map_err(|_| "badZip".to_string())
}

fn read_text(z: &mut ZipArchive<File>, name: &str, max: u64) -> Result<String, String> {
  let e = z.by_name(name).map_err(|_| format!("missing:{name}"))?;
  if e.size() > max {
    return Err(format!("tooBig:{name}"));
  }
  let mut s = String::new();
  e.take(max + 1).read_to_string(&mut s).map_err(|e| e.to_string())?;
  if s.len() as u64 > max {
    return Err(format!("tooBig:{name}"));
  }
  Ok(s)
}

fn manifest_of(path: &Path) -> Result<String, String> {
  read_text(&mut open(path)?, "manifest.json", MANIFEST_MAX)
}

fn ours(name: &str) -> bool {
  (name.starts_with("LinguaClip-auto-") || name.starts_with("LinguaClip-pre-")) && name.ends_with(".zip")
}

// Zips in backups/: every *.zip (`staged` = with restore-staged.zip), or with `only_ours`
// just our own names (auto / pre, plus the staged copy when `staged`).
fn zips(own: &Path, staged: bool, only_ours: bool) -> std::io::Result<Vec<PathBuf>> {
  let mut out = vec![];
  for e in fs::read_dir(backups_dir(own))? {
    let p = e?.path();
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let wanted = if name == STAGED { staged } else if only_ours { ours(name) } else { name.ends_with(".zip") };
    if p.is_file() && wanted {
      out.push(p);
    }
  }
  Ok(out)
}

#[derive(serde::Serialize)]
pub struct Listed {
  path: String,
  manifest: String,
}

fn list_in(own: &Path) -> Vec<Listed> {
  let mut out: Vec<(f64, Listed)> = zips(own, false, false)
    .unwrap_or_default()
    .into_iter()
    .filter_map(|p| {
      let manifest = manifest_of(&p).ok()?;
      // No proper time: still listed (last), so the rotation sees it and deletes nothing.
      let at = serde_json::from_str::<serde_json::Value>(&manifest).ok()?.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(f64::MIN);
      Some((at, Listed { path: p.to_string_lossy().into_owned(), manifest }))
    })
    .collect();
  out.sort_by(|a, b| b.0.total_cmp(&a.0));
  out.into_iter().map(|(_, l)| l).collect()
}

#[derive(serde::Serialize)]
pub struct Contents {
  manifest: String,
  data: String,
}

fn read_in(own: &Path, path: &str) -> Result<Contents, String> {
  let mut z = open(&inside(own, Path::new(path))?)?;
  Ok(Contents { manifest: read_text(&mut z, "manifest.json", MANIFEST_MAX)?, data: read_text(&mut z, "data.json", DATA_MAX)? })
}

// Only whitelisted entries, each to the path we build (never the zip's own path);
// same name overwritten, nothing else in the own dir touched.
fn unpack_in(own: &Path, path: &str) -> Result<u32, String> {
  unpack_limited(own, path, &LIMITS)
}

// Over any limit = the whole unpack fails (files already written stay: same names, whole files).
fn unpack_limited(own: &Path, path: &str, lim: &Limits) -> Result<u32, String> {
  let mut z = open(&inside(own, Path::new(path))?)?;
  if z.len() > lim.count {
    return Err("tooBig:entries".into());
  }
  let mut n = 0;
  let mut total: u64 = 0;
  for i in 0..z.len() {
    let mut e = z.by_index(i).map_err(|e| e.to_string())?;
    if !e.is_file() {
      continue;
    }
    let Some(rel) = target(e.name()) else { continue };
    let dest = own.join(rel);
    let dir = dest.parent().ok_or("invalid path")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = tmp_of(&dest);
    // take(): the bytes really written count, not what the entry claims its size is.
    let res = File::create(&tmp).map_err(|e| e.to_string()).and_then(|mut f| {
      let got = std::io::copy(&mut (&mut e).take(lim.entry + 1), &mut f).map_err(|e| e.to_string())?;
      total += got;
      if got > lim.entry {
        return Err("tooBig:file".to_string());
      }
      if total > lim.total {
        return Err("tooBig:total".to_string());
      }
      f.sync_all().map_err(|e| e.to_string())
    });
    if let Err(err) = res {
      let _ = fs::remove_file(&tmp);
      return Err(err);
    }
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    n += 1;
  }
  Ok(n)
}

// Clips our backups in backups/ (auto, pre, staged) still need; None = one of them can't be
// read, so nobody knows (the caller then sweeps nothing). Other zips someone put there are ignored.
fn kept_in(own: &Path) -> Option<Vec<String>> {
  let list = match zips(own, true, true) {
    Ok(l) => l,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
    Err(_) => return None,
  };
  let mut out = vec![];
  for p in list {
    let v: serde_json::Value = serde_json::from_str(&manifest_of(&p).ok()?).ok()?;
    for c in v.get("clips")?.as_array()? {
      out.push(c.as_str()?.to_string());
    }
  }
  out.sort();
  out.dedup();
  Some(out)
}

// Only our own backups by plain name: the old ones rotation names, and the staged copy.
fn removable(name: &str) -> bool {
  name == STAGED || (ours(name) && !name.contains(['/', '\\']) && !name.contains(".."))
}

fn remove_in(own: &Path, names: &[String]) -> Result<(), String> {
  for name in names {
    if !removable(name) {
      return Err(format!("badName:{name}"));
    }
    match fs::remove_file(backups_dir(own).join(name)) {
      Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
      _ => {}
    }
  }
  Ok(())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce(&Path) -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(move || f(&own_dir()?)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_write(dest: Option<String>, kind: String, manifest: String, data: String, files: bool) -> Result<String, String> {
  blocking(move |own| write_in(own, dest, &kind, &manifest, &data, files).map(|p| p.to_string_lossy().into_owned())).await
}

#[tauri::command]
pub async fn backup_stage(path: String) -> Result<String, String> {
  blocking(move |own| stage_in(own, &path)).await
}

#[tauri::command]
pub async fn backup_list() -> Result<Vec<Listed>, String> {
  blocking(|own| Ok(list_in(own))).await
}

#[tauri::command]
pub async fn backup_read(path: String) -> Result<Contents, String> {
  blocking(move |own| read_in(own, &path)).await
}

#[tauri::command]
pub async fn backup_unpack(path: String) -> Result<u32, String> {
  blocking(move |own| unpack_in(own, &path)).await
}

#[tauri::command]
pub async fn backup_kept_clips() -> Result<Option<Vec<String>>, String> {
  blocking(|own| Ok(kept_in(own))).await
}

#[tauri::command]
pub async fn backup_remove(names: Vec<String>) -> Result<(), String> {
  blocking(move |own| remove_in(own, &names)).await
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
