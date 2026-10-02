use super::*;

const ID: &str = "550e8400-e29b-41d4-a716-446655440000";

fn temp(tag: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("backup-test-{tag}-{}", std::process::id()));
  let _ = fs::remove_dir_all(&dir);
  fs::create_dir_all(&dir).unwrap();
  dir
}

fn manifest(clips: &[&str], at: u64) -> String {
  serde_json::json!({ "format": 1, "createdAt": at, "clips": clips }).to_string()
}

#[test]
fn whitelist() {
  assert_eq!(target(&format!("files/{ID}.cloze.json")), Some(PathBuf::from(format!("{ID}.cloze.json"))));
  assert_eq!(target("files/clips/a_1.50.mp4"), Some(Path::new("clips").join("a_1.50.mp4")));
  for bad in [
    "files/../x",
    "files/../../etc/passwd",
    "/etc/passwd",
    "files//etc/x.cloze.json",
    "files/clips/a/b",
    "files/clips/../x",
    "files/clips/.hidden",
    &format!("files/{ID}.exe.json"),
    &format!("files/{ID}.cloze.json.tmp"),
    "files/../abc.cloze.json",
    "manifest.json",
    &format!("{ID}.cloze.json"),
  ] {
    assert_eq!(target(bad), None, "{bad}");
  }
}

#[test]
fn write_read_unpack_round_trip() {
  let own = temp("trip");
  fs::create_dir_all(own.join("clips")).unwrap();
  fs::write(own.join(format!("{ID}.cloze.json")), b"{\"c\":1}").unwrap();
  fs::write(own.join("clips/a_1.50.mp4"), b"clipbytes").unwrap();
  fs::write(own.join("video.mp4"), b"not packed").unwrap();
  fs::write(own.join("cookies.txt"), b"secret").unwrap();
  let man = manifest(&["a_1.50.mp4"], 5);
  let path = write_in(&own, None, "pre", &man, "{\"videos\":[]}", true).unwrap();
  assert!(path.starts_with(backups_dir(&own)) && path.is_file());
  // tmp + rename: no .tmp left behind
  assert!(fs::read_dir(backups_dir(&own)).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
  let names: Vec<String> = {
    let z = open(&path).unwrap();
    z.file_names().map(String::from).collect()
  };
  assert!(names.contains(&"files/clips/a_1.50.mp4".to_string()));
  assert!(!names.iter().any(|n| n.contains("video.mp4") || n.contains("cookies")));
  let got = read_in(&own, path.to_str().unwrap()).unwrap();
  assert_eq!(got.manifest, man);
  assert_eq!(got.data, "{\"videos\":[]}");
  // Unpack into a fresh own dir: the same files come back, nothing else.
  let other = temp("trip2");
  fs::create_dir_all(backups_dir(&other)).unwrap();
  let copy = backups_dir(&other).join("x.zip");
  fs::copy(&path, &copy).unwrap();
  assert_eq!(unpack_in(&other, copy.to_str().unwrap()).unwrap(), 2);
  assert_eq!(fs::read(other.join(format!("{ID}.cloze.json"))).unwrap(), b"{\"c\":1}");
  assert_eq!(fs::read(other.join("clips/a_1.50.mp4")).unwrap(), b"clipbytes");
  assert!(!other.join("video.mp4").exists());
  // Only files inside backups/ are read.
  assert!(read_in(&own, own.join("video.mp4").to_str().unwrap()).is_err());
  // No files when not asked for.
  let lean = write_in(&own, Some(own.join("lean.zip").to_string_lossy().into_owned()), "auto", &man, "{}", false).unwrap();
  assert_eq!(open(&lean).unwrap().len(), 2);
  fs::remove_dir_all(&own).unwrap();
  fs::remove_dir_all(&other).unwrap();
}

#[test]
fn unpack_skips_what_the_whitelist_refuses() {
  let own = temp("evil");
  fs::create_dir_all(backups_dir(&own)).unwrap();
  let path = backups_dir(&own).join("evil.zip");
  let mut z = ZipWriter::new(File::create(&path).unwrap());
  for name in ["files/../escape.cloze.json", "files/clips/a/b", "/abs.json", &format!("files/{ID}.exe.json"), &format!("files/{ID}.words.json")] {
    z.start_file(name, SimpleFileOptions::default()).unwrap();
    z.write_all(b"x").unwrap();
  }
  z.finish().unwrap();
  assert_eq!(unpack_in(&own, path.to_str().unwrap()).unwrap(), 1);
  assert!(own.join(format!("{ID}.words.json")).is_file());
  assert!(!own.parent().unwrap().join("escape.cloze.json").exists());
  assert!(!own.join("clips/a").exists());
  fs::remove_dir_all(&own).unwrap();
}

#[test]
fn kept_clips_union_and_bad_zip() {
  let own = temp("kept");
  assert_eq!(kept_in(&own), Some(vec![])); // no backups folder yet
  write_in(&own, None, "auto", &manifest(&["b.mp4", "a.mp4"], 1), "{}", false).unwrap();
  write_in(&own, Some(backups_dir(&own).join(STAGED).to_string_lossy().into_owned()), "auto", &manifest(&["a.mp4", "c.m4a"], 2), "{}", false).unwrap();
  assert_eq!(kept_in(&own), Some(vec!["a.mp4".into(), "b.mp4".into(), "c.m4a".into()]));
  // A zip that isn't ours (copied in by hand, broken or not) is ignored.
  fs::write(backups_dir(&own).join("broken.zip"), b"not a zip").unwrap();
  fs::write(backups_dir(&own).join("LinguaClip-backup-2026.zip"), b"not a zip").unwrap();
  assert_eq!(kept_in(&own), Some(vec!["a.mp4".into(), "b.mp4".into(), "c.m4a".into()]));
  // One of ours unreadable: nobody knows.
  fs::write(backups_dir(&own).join("LinguaClip-pre-bad.zip"), b"not a zip").unwrap();
  assert_eq!(kept_in(&own), None);
  // The list skips what it can't read, and leaves the staged copy out.
  let listed = list_in(&own);
  assert_eq!(listed.len(), 1);
  assert!(listed[0].path.contains("LinguaClip-auto-"));
  // One of ours with no proper time is still listed (last): the rotation must see it to hold off.
  let odd = backups_dir(&own).join("LinguaClip-pre-odd.zip");
  fs::remove_file(backups_dir(&own).join("LinguaClip-pre-bad.zip")).unwrap();
  write_in(&own, Some(odd.to_string_lossy().into_owned()), "auto", r#"{"format":1,"createdAt":"yesterday"}"#, "{}", false).unwrap();
  let listed = list_in(&own);
  assert_eq!(listed.len(), 2);
  assert!(listed[1].path.contains("LinguaClip-pre-odd"));
  fs::remove_dir_all(&own).unwrap();
}

#[test]
fn refuses_to_write_what_it_could_not_read_back() {
  let own = temp("toobig");
  let big = "x".repeat(MANIFEST_MAX as usize + 1);
  assert_eq!(write_in(&own, None, "auto", &big, "{}", false), Err("tooBig".into()));
  assert!(zips(&own, true, false).unwrap_or_default().is_empty());
  fs::remove_dir_all(&own).unwrap();
}

#[test]
fn stage_always_copies() {
  let own = temp("stage");
  let outside = own.join("picked.zip");
  write_in(&own, Some(outside.to_string_lossy().into_owned()), "auto", &manifest(&[], 1), "{}", false).unwrap();
  let staged = stage_in(&own, outside.to_str().unwrap()).unwrap();
  assert_eq!(PathBuf::from(&staged), backups_dir(&own).join(STAGED));
  assert_eq!(fs::read(&staged).unwrap(), fs::read(&outside).unwrap());
  assert!(!backups_dir(&own).join(format!("{STAGED}.tmp")).exists());
  // One already in backups/ is copied too; the original stays where it is.
  let auto = write_in(&own, None, "auto", &manifest(&[], 2), "{}", false).unwrap();
  let staged = stage_in(&own, auto.to_str().unwrap()).unwrap();
  assert_eq!(PathBuf::from(&staged), backups_dir(&own).join(STAGED));
  assert!(auto.is_file());
  assert_eq!(fs::read(&staged).unwrap(), fs::read(&auto).unwrap());
  fs::remove_dir_all(&own).unwrap();
}

fn zip_with(path: &Path, entries: &[(&str, usize)]) {
  let mut z = ZipWriter::new(File::create(path).unwrap());
  for (name, len) in entries {
    z.start_file(*name, SimpleFileOptions::default()).unwrap();
    z.write_all(&vec![b'x'; *len]).unwrap();
  }
  z.finish().unwrap();
}

#[test]
fn unpack_limits() {
  let own = temp("limits");
  fs::create_dir_all(backups_dir(&own)).unwrap();
  let lim = Limits { entry: 10, total: 25, count: 3 };
  let path = backups_dir(&own).join("x.zip");
  let p = path.to_str().unwrap();
  // One file over the per-file limit: fails, no temp file left.
  zip_with(&path, &[("files/clips/big.mp4", 11)]);
  assert_eq!(unpack_limited(&own, p, &lim), Err("tooBig:file".into()));
  assert!(!own.join("clips/big.mp4").exists() && !own.join("clips/big.mp4.tmp").exists());
  zip_with(&path, &[("files/clips/ok.mp4", 10)]);
  assert_eq!(unpack_limited(&own, p, &lim), Ok(1));
  // Each under the limit, together over the total.
  zip_with(&path, &[("files/clips/a.mp4", 10), ("files/clips/b.mp4", 10), ("files/clips/c.mp4", 10)]);
  assert_eq!(unpack_limited(&own, p, &lim), Err("tooBig:total".into()));
  // Too many entries.
  zip_with(&path, &[("files/clips/a.mp4", 1), ("files/clips/b.mp4", 1), ("files/clips/c.mp4", 1), ("files/clips/d.mp4", 1)]);
  assert_eq!(unpack_limited(&own, p, &lim), Err("tooBig:entries".into()));
  fs::remove_dir_all(&own).unwrap();
}

#[test]
fn packing_leaves_out_files_over_the_limit() {
  let own = temp("packmax");
  fs::create_dir_all(own.join("clips")).unwrap();
  fs::write(own.join("clips/small.mp4"), b"1234").unwrap();
  fs::write(own.join("clips/big.mp4"), b"123456789").unwrap();
  let names: Vec<String> = pack_list(&own, 4).unwrap().into_iter().map(|(n, _)| n).collect();
  assert_eq!(names, vec!["files/clips/small.mp4".to_string()]);
  fs::remove_dir_all(&own).unwrap();
}

#[test]
fn remove_only_our_names() {
  let own = temp("remove");
  let auto = write_in(&own, None, "auto", &manifest(&[], 1), "{}", false).unwrap();
  assert!(remove_in(&own, &["../x.zip".into()]).is_err());
  assert!(remove_in(&own, &["LinguaClip-auto-../../x.zip".into()]).is_err());
  assert!(remove_in(&own, &["other.zip".into()]).is_err());
  remove_in(&own, &[auto.file_name().unwrap().to_string_lossy().into_owned(), STAGED.into()]).unwrap();
  assert!(!auto.exists());
  fs::remove_dir_all(&own).unwrap();
}
