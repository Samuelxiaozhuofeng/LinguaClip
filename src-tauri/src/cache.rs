use std::fs;
use std::path::PathBuf;

use crate::paths::own_dir as movies_dir;

pub(crate) fn valid_id(id: &str) -> bool {
  !id.is_empty()
    && id.len() <= 80
    && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub(crate) fn valid_kind(kind: &str) -> bool {
  kind == "words" || kind == "cloze" || kind == "breakdown" || kind == "segments" || kind == "levels" || kind == "trans"
}

fn cache_path(id: &str, kind: &str) -> Result<PathBuf, String> {
  if !valid_id(id) {
    return Err("invalid id".into());
  }
  if !valid_kind(kind) {
    return Err("invalid kind".into());
  }
  let dir = movies_dir()?;
  let dest = dir.join(format!("{id}.{kind}.json"));
  if dest.parent() != Some(dir.as_path()) {
    return Err("invalid path".into());
  }
  Ok(dest)
}

// Frontend never passes a path: we join ~/Movies/LinguaClip/<id>.<kind>.json
// ourselves. Write <dest>.tmp then rename so a crash cannot leave half a JSON.
#[tauri::command]
pub fn write_cache(id: String, kind: String, text: String) -> Result<(), String> {
  let dest = cache_path(&id, &kind)?;
  let dir = dest.parent().ok_or("invalid path")?.to_path_buf();
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let tmp = dir.join(format!("{id}.{kind}.json.tmp"));
  fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
  fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_ids_that_could_leave_the_cache_dir() {
    assert!(!valid_id("../secret"));
    assert!(!valid_id("foo/bar"));
    assert!(!valid_id("foo.bar"));
    assert!(!valid_id("id with space"));
    assert!(!valid_id(""));
    assert!(valid_id("550e8400-e29b-41d4-a716-446655440000"));
    assert!(valid_id("abc-def"));
  }

  #[test]
  fn only_known_cache_kinds() {
    assert!(valid_kind("words"));
    assert!(valid_kind("cloze"));
    assert!(valid_kind("breakdown"));
    assert!(valid_kind("segments"));
    assert!(valid_kind("levels"));
    assert!(valid_kind("trans"));
    assert!(!valid_kind("json"));
    assert!(!valid_kind("cloze.json"));
    assert!(!valid_kind("../cloze"));
  }

  #[test]
  fn cache_path_stays_inside_movies_dir() {
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let dest = cache_path(id, "cloze").unwrap();
    let dir = movies_dir().unwrap();
    assert_eq!(dest.parent(), Some(dir.as_path()));
    assert_eq!(dest.file_name().unwrap(), "550e8400-e29b-41d4-a716-446655440000.cloze.json");
    assert!(cache_path("../etc", "cloze").is_err());
    assert!(cache_path(id, "exe").is_err());
  }
}
