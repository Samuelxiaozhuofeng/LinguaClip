// Reads a Yomitan dictionary zip (the format of github.com/yomidevs/yomitan,
// written from its published schema, not its code) into one SQLite file. The
// whole book goes into `<id>.db.part` in one pass and only a finished file is
// renamed to `<id>.db`, so a failed or interrupted import leaves nothing behind.
// Layout and rules: docs/yomitan.md.
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::write::ZlibEncoder;
use rusqlite::{params, Connection};
use serde_json::value::RawValue;
use serde_json::Value;

pub const SCHEMA: &str = "1";
pub const LANGS: [&str; 5] = ["en", "es", "fr", "de", "ja"];
const BLOCK_ROWS: usize = 64;
// The biggest bank of the recommended ones is wty-en-en's 73MB; rows stay
// borrowed from the buffer (RawValue), so memory is about the file size.
const MAX_BANK: u64 = 128 * 1024 * 1024;

// What a replaced older version hands on to its successor.
pub struct Carry {
  pub lang: Option<String>,
  pub enabled: bool,
  pub order: i64,
}

#[derive(Debug)]
pub struct Index {
  pub title: String,
  pub revision: String,
  format: u8,
  raw: String,
}

// A dictionary's name without the release date some put at its end
// ("JMdict [2026-09-29]"), so a newer release reads as the same book. Only a
// date: "Pocket [English]" and "Pocket [French]" stay two books.
pub fn base_title(title: &str) -> &str {
  let t = title.trim_end();
  let is_date = |s: &str| s.len() == 10 && s.char_indices().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
  match t.strip_suffix(']').and_then(|x| x.rsplit_once(" [")) {
    Some((head, date)) if is_date(date) => head,
    _ => t,
  }
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<File>, String> {
  let file = File::open(path).map_err(|_| "badZip".to_string())?;
  zip::ZipArchive::new(file).map_err(|_| "badZip".to_string())
}

fn read_entry(zip: &mut zip::ZipArchive<File>, name: &str) -> Result<Vec<u8>, String> {
  let mut entry = zip.by_name(name).map_err(|_| "badZip".to_string())?;
  if entry.size() > MAX_BANK {
    return Err(format!("tooBig:{name}"));
  }
  let mut buf = Vec::with_capacity(entry.size() as usize);
  entry.read_to_end(&mut buf).map_err(|_| "badZip".to_string())?;
  Ok(buf)
}

fn read_index(zip: &mut zip::ZipArchive<File>) -> Result<Index, String> {
  if zip.index_for_name("index.json").is_none() {
    // A zip of a folder rather than of the folder's contents.
    let nested = zip.file_names().any(|n| n.ends_with("/index.json"));
    return Err(if nested { "nested" } else { "badIndex" }.into());
  }
  let raw = String::from_utf8(read_entry(zip, "index.json")?).map_err(|_| "badIndex".to_string())?;
  let v: Value = serde_json::from_str(&raw).map_err(|_| "badIndex".to_string())?;
  let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
  let format = v.get("format").or(v.get("version")).and_then(Value::as_u64).unwrap_or(0);
  match (s("title"), s("revision")) {
    (Some(title), Some(revision)) if (1..=3).contains(&format) && !title.trim().is_empty() => {
      Ok(Index { title, revision, format: format as u8, raw })
    }
    _ => Err("badIndex".into()),
  }
}

pub fn peek_index(path: &Path) -> Result<Index, String> {
  read_index(&mut open_zip(path)?)
}

// term_bank_2.json before term_bank_10.json.
fn banks(zip: &zip::ZipArchive<File>, prefix: &str) -> Vec<String> {
  let mut names: Vec<(u64, String)> = zip
    .file_names()
    .filter_map(|n| {
      let num = n.strip_prefix(prefix)?.strip_suffix(".json")?.parse().ok()?;
      Some((num, n.to_string()))
    })
    .collect();
  names.sort();
  names.into_iter().map(|(_, n)| n).collect()
}

fn text(v: &RawValue) -> Option<String> {
  serde_json::from_str::<String>(v.get()).ok()
}

// One term_bank row as the format-3 JSON we store, plus its headword and
// reading. Format 1 lists the glosses flat at the end of the row.
fn term_row(row: &[&RawValue], format: u8) -> Option<(String, String, String)> {
  let term = text(row.first()?)?;
  let reading = text(row.get(1)?)?;
  let is_num = |v: &RawValue| v.get().parse::<f64>().is_ok();
  let tags_ok = |v: &RawValue| v.get() == "null" || text(v).is_some();
  if !tags_ok(row.get(2)?) || text(row.get(3)?).is_none() || !is_num(row.get(4)?) || term.is_empty() {
    return None;
  }
  let json = if format == 1 {
    let glosses: Vec<&str> = row[5..].iter().map(|g| g.get()).collect();
    let head: Vec<&str> = row[..5].iter().map(|v| v.get()).collect();
    format!("[{},[{}],0,\"\"]", head.join(","), glosses.join(","))
  } else {
    if row.len() < 8 || !row[5].get().starts_with('[') || !is_num(row[6]) || text(row[7]).is_none() {
      return None;
    }
    let cells: Vec<&str> = row.iter().map(|v| v.get()).collect();
    format!("[{}]", cells.join(","))
  };
  Some((term, reading, json))
}

fn compress(rows: &[String]) -> Result<Vec<u8>, String> {
  let mut enc = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
  enc.write_all(b"[").and_then(|_| enc.write_all(rows.join(",").as_bytes())).and_then(|_| enc.write_all(b"]")).map_err(|e| format!("disk:{e}"))?;
  enc.finish().map_err(|e| format!("disk:{e}"))
}

fn has_cjk(s: &str) -> bool {
  s.chars().any(|c| matches!(c as u32, 0x3040..=0x30FF | 0x4E00..=0x9FFF))
}

fn create_tables(db: &Connection) -> rusqlite::Result<()> {
  db.execute_batch(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
     CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT);
     CREATE TABLE blocks(id INTEGER PRIMARY KEY, data BLOB NOT NULL);
     CREATE TABLE keys(k TEXT NOT NULL, block INTEGER NOT NULL, PRIMARY KEY(k, block)) WITHOUT ROWID;
     CREATE TABLE tags(name TEXT PRIMARY KEY, category TEXT, notes TEXT);
     CREATE TABLE meta(k TEXT NOT NULL, mode TEXT, data TEXT);
     CREATE INDEX meta_k ON meta(k);",
  )
}

fn write_block(db: &Connection, id: i64, rows: &mut Vec<String>, keys: &mut Vec<String>) -> Result<(), String> {
  let sql = |e: rusqlite::Error| format!("disk:{e}");
  db.execute("INSERT INTO blocks VALUES (?1, ?2)", params![id, compress(rows)?]).map_err(sql)?;
  let mut ins = db.prepare_cached("INSERT OR IGNORE INTO keys VALUES (?1, ?2)").map_err(sql)?;
  for k in keys.drain(..) {
    ins.execute(params![k, id]).map_err(sql)?;
  }
  rows.clear();
  Ok(())
}

fn parse_rows<'a>(buf: &'a [u8], name: &str) -> Result<Vec<Vec<&'a RawValue>>, String> {
  serde_json::from_slice(buf).map_err(|_| format!("badRow:{name}"))
}

// Writes the whole book to `part`; the caller renames it when this succeeds
// and deletes it when it fails.
fn write_db(
  zip: &mut zip::ZipArchive<File>,
  index: &Index,
  part: &Path,
  carry: Option<&Carry>,
  order: i64,
  download_url: Option<&str>,
  on_pct: &mut dyn FnMut(u32),
) -> Result<(), String> {
  let sql = |e: rusqlite::Error| format!("disk:{e}");
  let db = Connection::open(part).map_err(sql)?;
  create_tables(&db).map_err(sql)?;
  db.execute_batch("BEGIN").map_err(sql)?;

  let term_banks = banks(zip, "term_bank_");
  if term_banks.is_empty() {
    return Err("noTerms".into());
  }
  let total: u64 = term_banks.iter().filter_map(|n| zip.by_name(n).ok().map(|e| e.size())).sum::<u64>().max(1);
  let (mut done, mut block, mut sample) = (0u64, 0i64, Vec::new());
  let (mut rows, mut keys) = (Vec::with_capacity(BLOCK_ROWS), Vec::new());
  for name in &term_banks {
    let buf = read_entry(zip, name)?;
    for row in parse_rows(&buf, name)? {
      let (term, reading, json) = term_row(&row, index.format).ok_or_else(|| format!("badRow:{name}"))?;
      if sample.len() < 200 {
        sample.push(term.clone());
      }
      if !reading.is_empty() && reading != term {
        keys.push(reading);
      }
      keys.push(term);
      rows.push(json);
      if rows.len() == BLOCK_ROWS {
        write_block(&db, block, &mut rows, &mut keys)?;
        block += 1;
      }
    }
    done += buf.len() as u64;
    on_pct((done * 99 / total) as u32);
  }
  if !rows.is_empty() {
    write_block(&db, block, &mut rows, &mut keys)?;
  }

  for name in banks(zip, "tag_bank_") {
    let buf = read_entry(zip, &name)?;
    let mut ins = db.prepare_cached("INSERT OR REPLACE INTO tags VALUES (?1, ?2, ?3)").map_err(sql)?;
    for row in parse_rows(&buf, &name)? {
      let cell = |i: usize| row.get(i).and_then(|v| text(v));
      let tag = cell(0).ok_or_else(|| format!("badRow:{name}"))?;
      ins.execute(params![tag, cell(1), cell(3)]).map_err(sql)?;
    }
  }
  // Kept for later (IPA, frequency); nothing reads it yet.
  for name in banks(zip, "term_meta_bank_") {
    let buf = read_entry(zip, &name)?;
    let mut ins = db.prepare_cached("INSERT INTO meta VALUES (?1, ?2, ?3)").map_err(sql)?;
    for row in parse_rows(&buf, &name)? {
      match (row.first().and_then(|v| text(v)), row.get(1).and_then(|v| text(v)), row.get(2)) {
        (Some(k), Some(mode), Some(data)) => ins.execute(params![k, mode, data.get()]).map_err(sql)?,
        _ => return Err(format!("badRow:{name}")),
      };
    }
  }

  let v: Value = serde_json::from_str(&index.raw).unwrap_or(Value::Null);
  let source = v.get("sourceLanguage").and_then(Value::as_str).filter(|l| LANGS.contains(l));
  let guessed = source.map(str::to_string).or_else(|| sample.iter().any(|t| has_cjk(t)).then(|| "ja".to_string()));
  let lang = carry.map_or(guessed, |c| c.lang.clone());
  let enabled = carry.map_or(true, |c| c.enabled);
  let order = carry.map_or(order, |c| c.order);
  let mut put = db.prepare("INSERT INTO info VALUES (?1, ?2)").map_err(sql)?;
  put.execute(params!["index", index.raw]).map_err(sql)?;
  put.execute(params!["schema", SCHEMA]).map_err(sql)?;
  put.execute(params!["enabled", if enabled { "1" } else { "0" }]).map_err(sql)?;
  put.execute(params!["order", order.to_string()]).map_err(sql)?;
  if let Some(l) = lang {
    put.execute(params!["lang", l]).map_err(sql)?;
  }
  if let Some(u) = download_url {
    put.execute(params!["downloadUrl", u]).map_err(sql)?;
  }
  drop(put);
  db.execute_batch("COMMIT").map_err(sql)?;
  db.close().map_err(|(_, e)| sql(e))?;
  // Writable handle: Windows refuses to flush a read-only one.
  std::fs::OpenOptions::new().write(true).open(part).and_then(|f| f.sync_all()).map_err(|e| format!("disk:{e}"))
}

pub fn part_of(dir: &Path, id: &str) -> PathBuf {
  dir.join(format!("{id}.db.part"))
}

// Imports `zip_path` as dictionary `id` into `dir`. On any failure nothing is
// left in `dir`.
pub fn import(
  zip_path: &Path,
  dir: &Path,
  id: &str,
  carry: Option<&Carry>,
  order: i64,
  download_url: Option<&str>,
  on_pct: &mut dyn FnMut(u32),
) -> Result<Index, String> {
  let mut zip = open_zip(zip_path)?;
  let index = read_index(&mut zip)?;
  std::fs::create_dir_all(dir).map_err(|e| format!("disk:{e}"))?;
  let part = part_of(dir, id);
  let _ = std::fs::remove_file(&part);
  let done = write_db(&mut zip, &index, &part, carry, order, download_url, on_pct)
    .and_then(|_| std::fs::rename(&part, dir.join(format!("{id}.db"))).map_err(|e| format!("disk:{e}")));
  if let Err(e) = done {
    let _ = std::fs::remove_file(&part);
    return Err(e);
  }
  Ok(index)
}

// Leftovers of an import the app was closed in the middle of.
pub fn sweep_parts(dir: &Path) {
  let Ok(entries) = std::fs::read_dir(dir) else { return };
  for e in entries.flatten() {
    let name = e.file_name().to_string_lossy().into_owned();
    if name.contains(".part") {
      let _ = std::fs::remove_file(e.path());
    }
  }
}
