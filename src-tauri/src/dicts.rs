// Local dictionaries (docs/yomitan.md): one SQLite file per imported Yomitan
// dictionary in App Support's `dicts/`. Each file carries its own settings
// (language, on/off, order) in its `info` table — there is no list file that
// could get out of step with the dictionaries, and nothing here ever deletes a
// finished `.db` except the user's own remove.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::value::RawValue;
use tauri::{AppHandle, Emitter};
use tauri_plugin_http::reqwest;

use crate::dicts_import::{self as imp, Carry, LANGS, SCHEMA};
use crate::whisper_setup::parts_dir;

const EVENT: &str = "dict-import-progress";

// Import, download and the startup sweep: one at a time (a second import gets
// "busy"). Settings and removal take EDIT, so they work while an import runs —
// the book being imported is still a .part and not in the list.
static IMPORT: Mutex<()> = Mutex::new(());
static EDIT: Mutex<()> = Mutex::new(());
// Read-only connections kept open for lookups; closed before a file is removed
// (Windows cannot delete an open file).
static CONNS: Mutex<Option<HashMap<String, Connection>>> = Mutex::new(None);

pub fn dicts_dir() -> PathBuf {
  parts_dir().with_file_name("dicts")
}

fn db_path(dir: &Path, id: &str) -> PathBuf {
  dir.join(format!("{id}.db"))
}

// Ids are our own uuids; refuse anything that could point outside the folder.
fn check_id(id: &str) -> Result<(), String> {
  if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
    Ok(())
  } else {
    Err("badId".into())
  }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictInfo {
  id: String,
  title: String,
  revision: String,
  lang: Option<String>,
  enabled: bool,
  order: i64,
  bytes: u64,
  attribution: String,
  download_url: Option<String>,
  // Unreadable file, or stored by a later way this version does not know.
  broken: bool,
  needs_reimport: bool,
}

fn read_info(path: &Path, id: &str) -> DictInfo {
  let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
  let mut info = DictInfo {
    id: id.to_string(),
    title: id.to_string(),
    revision: String::new(),
    lang: None,
    enabled: false,
    order: i64::MAX,
    bytes,
    attribution: String::new(),
    download_url: None,
    broken: true,
    needs_reimport: false,
  };
  let Ok(db) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return info };
  let Ok(mut q) = db.prepare("SELECT key, value FROM info") else { return info };
  let Ok(rows) = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))) else { return info };
  let map: HashMap<String, Option<String>> = rows.flatten().collect();
  let get = |k: &str| map.get(k).cloned().flatten();
  let Some(index) = get("index").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) else { return info };
  let s = |k: &str| index.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
  info.title = s("title");
  info.revision = s("revision");
  info.attribution = s("attribution");
  info.lang = get("lang").filter(|l| LANGS.contains(&l.as_str()));
  info.enabled = get("enabled").as_deref() == Some("1");
  info.order = get("order").and_then(|o| o.parse().ok()).unwrap_or(i64::MAX);
  info.download_url = get("downloadUrl");
  info.needs_reimport = get("schema").as_deref() != Some(SCHEMA);
  info.broken = false;
  info
}

fn list_in(dir: &Path) -> Vec<DictInfo> {
  let mut out: Vec<DictInfo> = std::fs::read_dir(dir)
    .into_iter()
    .flatten()
    .flatten()
    .filter_map(|e| {
      let name = e.file_name().to_string_lossy().into_owned();
      let id = name.strip_suffix(".db")?.to_string();
      check_id(&id).ok()?;
      Some(read_info(&e.path(), &id))
    })
    .collect();
  // Two books can share an order after an interrupted move; the id settles it.
  out.sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
  out
}

fn set_info(dir: &Path, id: &str, key: &str, value: Option<&str>) -> Result<(), String> {
  // Never OPEN_CREATE: a stale id must not leave an empty dictionary behind.
  let db = Connection::open_with_flags(db_path(dir, id), OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|_| "gone".to_string())?;
  match value {
    Some(v) => db.execute("INSERT OR REPLACE INTO info VALUES (?1, ?2)", params![key, v]),
    None => db.execute("DELETE FROM info WHERE key = ?1", params![key]),
  }
  .map(|_| ())
  .map_err(|e| format!("disk:{e}"))
}

fn close_conn(id: &str) {
  if let Some(map) = CONNS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
    map.remove(id);
  }
}

fn remove_in(dir: &Path, id: &str) -> Result<(), String> {
  close_conn(id);
  std::fs::remove_file(db_path(dir, id)).map_err(|e| format!("disk:{e}"))
}

// Called once from setup: clear what an interrupted import left, under the
// import lock so it can never catch a live one.
pub fn sweep() {
  std::thread::spawn(|| {
    let _guard = IMPORT.lock().unwrap_or_else(|e| e.into_inner());
    imp::sweep_parts(&dicts_dir());
  });
}

#[tauri::command]
pub fn dict_list() -> Vec<DictInfo> {
  list_in(&dicts_dir())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictCheck {
  title: String,
  revision: String,
  // An installed book of the same name, to ask before replacing it.
  same: Option<DictInfo>,
}

fn same_book(dir: &Path, title: &str) -> Option<DictInfo> {
  list_in(dir).into_iter().find(|d| !d.broken && imp::base_title(&d.title) == imp::base_title(title))
}

#[tauri::command]
pub fn dict_check(path: String) -> Result<DictCheck, String> {
  let index = imp::peek_index(Path::new(&path))?;
  let same = same_book(&dicts_dir(), &index.title);
  Ok(DictCheck { title: index.title, revision: index.revision, same })
}

// The import proper, run with IMPORT held. `replace` = the id of the older
// version the user agreed to swap out; it keeps its place, switch and language.
fn import_locked(app: &AppHandle, dir: &Path, zip: &Path, replace: Option<&str>, url: Option<&str>) -> Result<Vec<DictInfo>, String> {
  let index = imp::peek_index(zip)?;
  let old = match replace {
    Some(id) => {
      check_id(id)?;
      let o = list_in(dir).into_iter().find(|d| d.id == id).ok_or("gone")?;
      // Only ever swap out an older version of this same book.
      if o.broken || imp::base_title(&o.title) != imp::base_title(&index.title) {
        return Err("sameName".into());
      }
      Some(o)
    }
    None => None,
  };
  if let Some(same) = same_book(dir, &index.title) {
    if same.revision == index.revision {
      return Err("already".into());
    }
    if old.as_ref().map(|o| &o.id) != Some(&same.id) {
      return Err("sameName".into());
    }
  }
  let carry = old.as_ref().map(|o| Carry { lang: o.lang.clone(), enabled: o.enabled, order: o.order });
  let next = list_in(dir).iter().map(|d| d.order).filter(|o| *o != i64::MAX).max().map_or(0, |o| o + 1);
  let id = uuid::Uuid::new_v4().to_string();
  let mut last = None;
  imp::import(zip, dir, &id, carry.as_ref(), next, url, &mut |pct| {
    if last != Some(pct) {
      last = Some(pct);
      let _ = app.emit(EVENT, serde_json::json!({ "stage": "import", "pct": pct }));
    }
  })?;
  if let Some(o) = old {
    // The new one is in place. Its settings came from the old one when the
    // import began; the user may have changed them since, so copy them again
    // (under EDIT, so no change slips in between) before the old file goes. If
    // it cannot go, both stay listed and the user removes one.
    let _edit = EDIT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(now) = list_in(dir).into_iter().find(|d| d.id == o.id && !d.broken) {
      let _ = set_info(dir, &id, "enabled", Some(if now.enabled { "1" } else { "0" }));
      let _ = set_info(dir, &id, "order", Some(&now.order.to_string()));
      if let Some(l) = &now.lang {
        let _ = set_info(dir, &id, "lang", Some(l));
      }
    }
    if let Err(e) = remove_in(dir, &o.id) {
      log::warn!("could not remove replaced dictionary {}: {e}", o.id);
    }
  }
  Ok(list_in(dir))
}

#[tauri::command]
pub async fn dict_import(app: AppHandle, path: String, replace: Option<String>) -> Result<Vec<DictInfo>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let _guard = IMPORT.try_lock().map_err(|_| "busy".to_string())?;
    import_locked(&app, &dicts_dir(), Path::new(&path), replace.as_deref(), None)
  })
  .await
  .map_err(|e| format!("disk:{e}"))?
}

const STALL: Duration = Duration::from_secs(30);

async fn download(url: &str, to: &Path, on_pct: &mut dyn FnMut(u32)) -> Result<(), String> {
  let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
  let mut res = tokio::time::timeout(STALL, client.get(url).send())
    .await
    .map_err(|_| "no response".to_string())?
    .map_err(|e| e.to_string())?;
  if !res.status().is_success() {
    return Err(format!("HTTP {}", res.status().as_u16()));
  }
  let total = res.content_length().unwrap_or(0).max(1);
  let mut file = std::fs::File::create(to).map_err(|e| format!("disk:{e}"))?;
  let mut got = 0u64;
  while let Some(chunk) = tokio::time::timeout(STALL, res.chunk())
    .await
    .map_err(|_| "download stalled".to_string())?
    .map_err(|e| e.to_string())?
  {
    file.write_all(&chunk).map_err(|e| format!("disk:{e}"))?;
    got += chunk.len() as u64;
    on_pct((got * 99 / total).min(99) as u32);
  }
  file.sync_all().map_err(|e| format!("disk:{e}"))
}

// Tries each address in turn (the second is a mirror reachable from China),
// then imports the file as if the user had picked it. `urls[0]` is kept in the
// book so the settings page can tell a recommended one is installed.
#[tauri::command]
pub async fn dict_download(app: AppHandle, urls: Vec<String>, replace: Option<String>) -> Result<Vec<DictInfo>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let _guard = IMPORT.try_lock().map_err(|_| "busy".to_string())?;
    let dir = dicts_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("disk:{e}"))?;
    let zip = dir.join("download.zip.part");
    let mut last_err = "noUrl".to_string();
    let mut ok = false;
    for url in &urls {
      if !url.starts_with("https://") {
        continue;
      }
      let mut last = None;
      let got = tauri::async_runtime::block_on(download(url, &zip, &mut |pct| {
        if last != Some(pct) {
          last = Some(pct);
          let _ = app.emit(EVENT, serde_json::json!({ "stage": "download", "pct": pct }));
        }
      }));
      match got {
        Ok(()) => {
          ok = true;
          break;
        }
        Err(e) => last_err = format!("net:{e}"),
      }
    }
    let result = if ok { import_locked(&app, &dir, &zip, replace.as_deref(), urls.first().map(String::as_str)) } else { Err(last_err) };
    let _ = std::fs::remove_file(&zip);
    result
  })
  .await
  .map_err(|e| format!("disk:{e}"))?
}

#[tauri::command]
pub fn dict_update(id: String, enabled: Option<bool>, lang: Option<String>) -> Result<Vec<DictInfo>, String> {
  check_id(&id)?;
  let dir = dicts_dir();
  let _edit = EDIT.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(on) = enabled {
    set_info(&dir, &id, "enabled", Some(if on { "1" } else { "0" }))?;
  }
  if let Some(l) = lang {
    if !LANGS.contains(&l.as_str()) {
      return Err("badLang".into());
    }
    set_info(&dir, &id, "lang", Some(&l))?;
  }
  Ok(list_in(&dir))
}

// Swaps places with the neighbour above (-1) or below (1).
#[tauri::command]
pub fn dict_move(id: String, dir_step: i32) -> Result<Vec<DictInfo>, String> {
  let _edit = EDIT.lock().unwrap_or_else(|e| e.into_inner());
  dict_move_in(&dicts_dir(), &id, dir_step)
}

fn dict_move_in(dir: &Path, id: &str, dir_step: i32) -> Result<Vec<DictInfo>, String> {
  // A damaged book cannot be written to; it stays at the end, out of the numbering.
  let list: Vec<DictInfo> = list_in(dir).into_iter().filter(|d| !d.broken).collect();
  let at = list.iter().position(|d| d.id == id).ok_or("gone")?;
  let other = if dir_step < 0 { at.checked_sub(1) } else { Some(at + 1).filter(|i| *i < list.len()) };
  if let Some(o) = other {
    // Renumber everyone 0.. so equal or missing orders cannot stall the swap.
    let mut ids: Vec<&str> = list.iter().map(|d| d.id.as_str()).collect();
    ids.swap(at, o);
    for (i, d) in ids.iter().enumerate() {
      if list.iter().find(|x| x.id == *d).map(|x| x.order) != Some(i as i64) {
        set_info(dir, d, "order", Some(&i.to_string()))?;
      }
    }
  }
  Ok(list_in(dir))
}

#[tauri::command]
pub fn dict_remove(id: String) -> Result<Vec<DictInfo>, String> {
  check_id(&id)?;
  let dir = dicts_dir();
  let _edit = EDIT.lock().unwrap_or_else(|e| e.into_inner());
  remove_in(&dir, &id)?;
  Ok(list_in(&dir))
}

#[derive(serde::Serialize)]
pub struct DictHits {
  id: String,
  // Format-3 term rows, in file order.
  rows: Vec<Box<RawValue>>,
  // name → [category, notes] for the tags those rows use.
  tags: HashMap<String, (Option<String>, Option<String>)>,
}

fn lookup_one(db: &Connection, keys: &[String]) -> rusqlite::Result<(Vec<Box<RawValue>>, HashMap<String, (Option<String>, Option<String>)>)> {
  let marks = vec!["?"; keys.len()].join(",");
  let mut q = db.prepare(&format!("SELECT DISTINCT block FROM keys WHERE k IN ({marks}) ORDER BY block"))?;
  let blocks: Vec<i64> = q.query_map(rusqlite::params_from_iter(keys), |r| r.get(0))?.flatten().collect();
  let mut rows = Vec::new();
  let mut tag_names: Vec<String> = Vec::new();
  for b in blocks {
    let Some(data) = db.query_row("SELECT data FROM blocks WHERE id = ?1", [b], |r| r.get::<_, Vec<u8>>(0)).optional()? else { continue };
    let mut json = String::new();
    if flate2::read::ZlibDecoder::new(&data[..]).read_to_string(&mut json).is_err() {
      continue;
    }
    let Ok(block) = serde_json::from_str::<Vec<Box<RawValue>>>(&json) else { continue };
    for row in block {
      let Ok(cells) = serde_json::from_str::<Vec<&RawValue>>(row.get()) else { continue };
      let cell = |i: usize| cells.get(i).and_then(|v| serde_json::from_str::<String>(v.get()).ok()).unwrap_or_default();
      if keys.contains(&cell(0)) || keys.contains(&cell(1)) {
        for i in [2, 7] {
          tag_names.extend(cell(i).split_whitespace().map(str::to_string));
        }
        rows.push(row);
      }
    }
  }
  tag_names.sort();
  tag_names.dedup();
  let mut tags = HashMap::new();
  let mut tq = db.prepare_cached("SELECT category, notes FROM tags WHERE name = ?1")?;
  for t in tag_names {
    if let Some(v) = tq.query_row([&t], |r| Ok((r.get(0)?, r.get(1)?))).optional()? {
      tags.insert(t, v);
    }
  }
  Ok((rows, tags))
}

// Looks `keys` (headwords or readings) up in each of `ids`, in that order. A
// book that cannot be read is skipped and logged, not taken as "no such word"
// by accident: the caller falls through to the online dictionaries either way.
#[tauri::command]
pub async fn dict_lookup(ids: Vec<String>, keys: Vec<String>) -> Result<Vec<DictHits>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let keys: Vec<String> = keys.into_iter().filter(|k| !k.is_empty()).take(50).collect();
    if keys.is_empty() {
      return Ok(Vec::new());
    }
    let dir = dicts_dir();
    let mut conns = CONNS.lock().unwrap_or_else(|e| e.into_inner());
    let map = conns.get_or_insert_with(HashMap::new);
    let mut out = Vec::new();
    for id in ids {
      if check_id(&id).is_err() {
        continue;
      }
      if !map.contains_key(&id) {
        match Connection::open_with_flags(db_path(&dir, &id), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) {
          Ok(c) => {
            map.insert(id.clone(), c);
          }
          Err(e) => {
            log::warn!("dictionary {id} unreadable: {e}");
            continue;
          }
        }
      }
      match lookup_one(&map[&id], &keys) {
        Ok((rows, tags)) if !rows.is_empty() => out.push(DictHits { id, rows, tags }),
        Ok(_) => {}
        Err(e) => log::warn!("dictionary {id} lookup failed: {e}"),
      }
    }
    Ok(out)
  })
  .await
  .map_err(|e| format!("disk:{e}"))?
}

#[cfg(test)]
#[path = "dicts_tests.rs"]
mod tests;
