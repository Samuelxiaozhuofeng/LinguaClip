use super::*;
use std::io::Write;

fn temp_dir(tag: &str) -> PathBuf {
  let d = std::env::temp_dir().join(format!("dicts-test-{tag}-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&d);
  std::fs::create_dir_all(&d).unwrap();
  d
}

// A dictionary zip made of the given files.
fn make_zip(dir: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
  let path = dir.join(name);
  let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
  for (n, body) in files {
    zip.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(body.as_bytes()).unwrap();
  }
  zip.finish().unwrap();
  path
}

const WTY_INDEX: &str = r#"{"title":"wty-es-en","revision":"2026.09.20","format":3,"sourceLanguage":"es","attribution":"https://kaikki.org/"}"#;
// Shapes cut from the real wty-es-en: a form row pointing at its lemma, the lemma
// with structured content, and a word that is both a form and a noun.
const WTY_TERMS: &str = r#"[
  ["llegué","","non-lemma","v",0,[["llegar",["first-person singular indicative preterite"]]],0,""],
  ["llegar","","v vi","v",0,[{"type":"structured-content","content":[{"tag":"ol","data":{"content":"glosses"},"content":[{"tag":"li","content":"to arrive"}]}]}],0,""],
  ["casa","","n fem","n",0,["house"],0,""]
]"#;

fn noop() -> impl FnMut(u32) {
  |_| {}
}

#[test]
fn imports_and_looks_up() {
  let dir = temp_dir("basic");
  let zip = make_zip(&dir, "d.zip", &[("index.json", WTY_INDEX), ("term_bank_1.json", WTY_TERMS), ("tag_bank_1.json", r#"[["v","partOfSpeech",0,"verb",0]]"#)]);
  let out = dir.join("dicts");
  imp::import(&zip, &out, "a1", None, 0, None, &mut noop()).unwrap();
  let list = list_in(&out);
  assert_eq!(list.len(), 1);
  let d = &list[0];
  assert_eq!((d.title.as_str(), d.lang.as_deref(), d.enabled, d.broken, d.needs_reimport), ("wty-es-en", Some("es"), true, false, false));
  let db = Connection::open(db_path(&out, "a1")).unwrap();
  let (rows, tags) = lookup_one(&db, &["llegué".into()]).unwrap();
  assert_eq!(rows.len(), 1);
  assert!(rows[0].get().contains("first-person singular"));
  assert!(tags.is_empty());
  let (rows, tags) = lookup_one(&db, &["llegar".into(), "nada".into()]).unwrap();
  assert_eq!(rows.len(), 1);
  assert_eq!(tags["v"].1.as_deref(), Some("verb"));
  assert!(lookup_one(&db, &["Casa".into()]).unwrap().0.is_empty(), "keys are exact; the frontend tries the lowercase");
  assert!(std::fs::read_dir(&out).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".part")));
}

#[test]
fn bad_row_leaves_nothing() {
  let dir = temp_dir("bad");
  let zip = make_zip(&dir, "d.zip", &[("index.json", WTY_INDEX), ("term_bank_1.json", WTY_TERMS), ("term_bank_2.json", r#"[["x"]]"#)]);
  let out = dir.join("dicts");
  assert_eq!(imp::import(&zip, &out, "b1", None, 0, None, &mut noop()).unwrap_err(), "badRow:term_bank_2.json");
  assert_eq!(std::fs::read_dir(&out).unwrap().count(), 0);
}

#[test]
fn rejects_bad_packages() {
  let dir = temp_dir("pkg");
  let nested = make_zip(&dir, "n.zip", &[("wty/index.json", WTY_INDEX)]);
  assert_eq!(imp::peek_index(&nested).err().as_deref(), Some("nested"));
  let untitled = make_zip(&dir, "u.zip", &[("index.json", r#"{"revision":"1","format":3}"#)]);
  assert_eq!(imp::peek_index(&untitled).err().as_deref(), Some("badIndex"));
  let empty = make_zip(&dir, "e.zip", &[("index.json", WTY_INDEX)]);
  assert_eq!(imp::import(&empty, &dir.join("dicts"), "e1", None, 0, None, &mut noop()).unwrap_err(), "noTerms");
  std::fs::write(dir.join("junk.zip"), b"not a zip").unwrap();
  assert_eq!(imp::peek_index(&dir.join("junk.zip")).err().as_deref(), Some("badZip"));
}

#[test]
fn japanese_without_language_is_guessed_and_format1_read() {
  let dir = temp_dir("ja");
  let index = r#"{"title":"JMdict [2026-09-29]","revision":"JMdict.2026-09-29","version":1}"#;
  let terms = r#"[["食べる","たべる","v1","v1",100,"to eat","to live on"]]"#;
  let zip = make_zip(&dir, "j.zip", &[("index.json", index), ("term_bank_1.json", terms)]);
  let out = dir.join("dicts");
  imp::import(&zip, &out, "j1", None, 0, None, &mut noop()).unwrap();
  assert_eq!(list_in(&out)[0].lang.as_deref(), Some("ja"));
  let db = Connection::open(db_path(&out, "j1")).unwrap();
  let (rows, _) = lookup_one(&db, &["たべる".into()]).unwrap();
  let row: serde_json::Value = serde_json::from_str(rows[0].get()).unwrap();
  assert_eq!(row[5], serde_json::json!(["to eat", "to live on"]));
  assert_eq!(imp::base_title("JMdict [2026-09-29]"), "JMdict");
  assert_eq!(imp::base_title("wty-es-en"), "wty-es-en");
  assert_eq!(imp::base_title("Jitendex.org [2026-08-11]"), "Jitendex.org");
  assert_eq!(imp::base_title("Pocket [English]"), "Pocket [English]", "only a date is dropped");
}

#[test]
fn latin_without_language_stays_unset() {
  let dir = temp_dir("nolang");
  let zip = make_zip(&dir, "d.zip", &[("index.json", r#"{"title":"x","revision":"1","format":3}"#), ("term_bank_1.json", WTY_TERMS)]);
  let out = dir.join("dicts");
  imp::import(&zip, &out, "n1", None, 0, None, &mut noop()).unwrap();
  assert_eq!(list_in(&out)[0].lang, None);
}

#[test]
fn replacing_keeps_place_switch_and_language() {
  let dir = temp_dir("carry");
  let zip = make_zip(&dir, "d.zip", &[("index.json", WTY_INDEX), ("term_bank_1.json", WTY_TERMS)]);
  let out = dir.join("dicts");
  imp::import(&zip, &out, "c1", Some(&Carry { lang: Some("fr".into()), enabled: false, order: 7 }), 0, Some("https://x/y.zip"), &mut noop()).unwrap();
  let d = &list_in(&out)[0];
  assert_eq!((d.lang.as_deref(), d.enabled, d.order, d.download_url.as_deref()), (Some("fr"), false, 7, Some("https://x/y.zip")));
}

#[test]
fn settings_and_removal() {
  let dir = temp_dir("edit");
  let zip = make_zip(&dir, "d.zip", &[("index.json", WTY_INDEX), ("term_bank_1.json", WTY_TERMS)]);
  let out = dir.join("dicts");
  imp::import(&zip, &out, "e1", None, 0, None, &mut noop()).unwrap();
  imp::import(&zip, &out, "e2", None, 1, None, &mut noop()).unwrap();
  set_info(&out, "e2", "order", Some("-1")).unwrap();
  assert_eq!(list_in(&out)[0].id, "e2");
  assert_eq!(set_info(&out, "gone-id", "enabled", Some("1")).unwrap_err(), "gone");
  assert!(!db_path(&out, "gone-id").exists(), "a stale id must not create a file");
  remove_in(&out, "e2").unwrap();
  assert_eq!(list_in(&out).len(), 1);
  // A file that is not a dictionary shows up as broken, and is never deleted by us.
  std::fs::write(out.join("zz.db"), b"garbage").unwrap();
  let list = list_in(&out);
  assert!(list.iter().any(|d| d.id == "zz" && d.broken));
  assert!(out.join("zz.db").exists());
  // Moving past a damaged book works (it is left out of the numbering).
  let good = list_in(&out).into_iter().find(|d| !d.broken).unwrap().id;
  imp::import(&zip, &out, "e3", None, 5, None, &mut noop()).unwrap();
  let _ = dict_move_in(&out, &good, 1).unwrap();
  assert_eq!(list_in(&out).iter().filter(|d| !d.broken).map(|d| d.id.as_str()).collect::<Vec<_>>(), ["e3", good.as_str()]);
  remove_in(&out, "e3").unwrap();
  // The sweep only takes leftovers of interrupted imports.
  std::fs::write(out.join("x.db.part"), b"").unwrap();
  std::fs::write(out.join("download.zip.part"), b"").unwrap();
  imp::sweep_parts(&out);
  assert_eq!(list_in(&out).len(), 2);
  assert!(!out.join("x.db.part").exists() && !out.join("download.zip.part").exists());
  assert!(check_id("../x").is_err() && check_id("a-1").is_ok());
}

// Live: the real JMdict zip from ~/Downloads (see docs/yomitan.md).
#[test]
#[ignore]
fn imports_real_jmdict() {
  // DICT_ZIP=<path> tries another real dictionary (the 食べる check then only runs for JMdict).
  let other = std::env::var_os("DICT_ZIP").map(PathBuf::from);
  let zip = other.clone().unwrap_or_else(|| crate::paths::home_dir().unwrap().join("Downloads/JMdict_english.zip"));
  let out = temp_dir("real").join("dicts");
  let t = std::time::Instant::now();
  imp::import(&zip, &out, "r1", None, 0, None, &mut noop()).unwrap();
  let d = &list_in(&out)[0];
  eprintln!("{} {:?} {}MB in {:?}", d.title, d.lang, d.bytes / 1_000_000, t.elapsed());
  if other.is_some() {
    return;
  }
  let db = Connection::open(db_path(&out, "r1")).unwrap();
  let (rows, tags) = lookup_one(&db, &["食べる".into()]).unwrap();
  assert!(rows.len() >= 2 && tags.contains_key("v1"));
}
