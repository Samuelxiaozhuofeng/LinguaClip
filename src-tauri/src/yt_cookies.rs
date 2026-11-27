// Extracts Chrome cookies for yt-dlp on macOS, where Chrome 158+ encrypts
// non-default user-data-dir cookies as v11 ("pepper" PBKDF2 salt) which yt-dlp cannot read.
use std::path::{Path, PathBuf};

pub(crate) struct YtCookies { args: Vec<String>, temp_dir: Option<PathBuf> }

impl YtCookies {
  pub(crate) fn args(&self) -> &[String] { &self.args }
}

impl Drop for YtCookies {
  fn drop(&mut self) {
    if let Some(dir) = self.temp_dir.take() { let _ = std::fs::remove_dir_all(dir); }
  }
}

// Chrome creates the DB on first launch, so "file exists" would wrongly claim a sign-in.
// Cookie names sit in sqlite / WAL bytes unencrypted; LOGIN_INFO appears once signed in.
pub(crate) fn db_shows_login(bytes: &[u8]) -> bool { bytes.windows(10).any(|w| w == b"LOGIN_INFO") }

fn login_present(login_dir: &Path) -> bool {
  let default = login_dir.join("Default");
  ["Cookies", "Cookies-wal"].iter().any(|n| std::fs::read(default.join(n)).is_ok_and(|b| db_shows_login(&b)))
}

pub(crate) fn prepare(login_dir: &Path) -> Result<YtCookies, String> {
  if !login_present(login_dir) {
    return Ok(YtCookies { args: Vec::new(), temp_dir: None });
  }
  #[cfg(not(target_os = "macos"))]
  return Ok(YtCookies {
    args: vec!["--cookies-from-browser".into(), format!("chrome:{}", login_dir.to_string_lossy())],
    temp_dir: None,
  });
  #[cfg(target_os = "macos")]
  mac::prepare_mac(login_dir)
}

#[cfg(target_os = "macos")]
mod mac {
  use super::YtCookies;
  use rusqlite::Connection;
  use sha2::{Digest, Sha256};
  use std::fs::{DirBuilder, OpenOptions};
  use std::io::{Read, Write};
  use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
  use std::path::{Path, PathBuf};
  use std::process::Stdio;
  use std::sync::atomic::{compiler_fence, Ordering};
  use std::sync::{Arc, Mutex, PoisonError};
  use std::time::{Duration, SystemTime};

  const DB_FILES: [&str; 4] = ["Cookies", "Cookies-wal", "Cookies-shm", "Cookies-journal"];
  const YT_DOMAINS: [&str; 6] = ["youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com", "ytimg.com", "google.com"];
  const TEMP_PREFIX: &str = "linguaclip-yt-";
  const CHROME_EPOCH_OFFSET_SECS: i64 = 11_644_473_600;
  const KCC_PBKDF2: u32 = 2;
  const KCC_PRF_HMAC_SHA1: u32 = 1;
  const KCC_DECRYPT: u32 = 1;
  const KCC_ALG_AES128: u32 = 0;
  const KCC_OPTION_PKCS7: u32 = 0x0001;

  #[link(name = "System")]
  extern "C" {
    fn CCKeyDerivationPBKDF(
      alg: u32, pw: *const u8, pw_len: usize, salt: *const u8, salt_len: usize,
      prf: u32, rounds: u32, out: *mut u8, out_len: usize,
    ) -> i32;
    fn CCCrypt(
      op: u32, alg: u32, opts: u32, key: *const u8, key_len: usize, iv: *const u8,
      in_buf: *const u8, in_len: usize, out_buf: *mut u8, out_cap: usize, out_len: *mut usize,
    ) -> i32;
  }

  struct TempGuard(Option<PathBuf>);
  impl Drop for TempGuard {
    fn drop(&mut self) { if let Some(d) = self.0.take() { let _ = std::fs::remove_dir_all(d); } }
  }

  pub(super) enum ExportResult { NotLoggedIn, FallbackBrowser, Netscape(String) }

  fn zeroize(buf: &mut [u8]) {
    for b in buf.iter_mut() { unsafe { std::ptr::write_volatile(b, 0) }; }
    compiler_fence(Ordering::SeqCst);
  }

  fn derive_key(password: &[u8], salt: &[u8]) -> Result<[u8; 16], String> {
    let mut key = [0u8; 16];
    let rc = unsafe {
      CCKeyDerivationPBKDF(KCC_PBKDF2, password.as_ptr(), password.len(), salt.as_ptr(), salt.len(), KCC_PRF_HMAC_SHA1, 1003, key.as_mut_ptr(), key.len())
    };
    if rc != 0 { return Err("could not derive YouTube cookie key".into()); }
    Ok(key)
  }

  fn aes_128_cbc(op: u32, key: &[u8; 16], input: &[u8]) -> Option<Vec<u8>> {
    if op == KCC_DECRYPT && (input.is_empty() || input.len() % 16 != 0) { return None; }
    let iv = [b' '; 16];
    let mut out = vec![0u8; input.len() + 16];
    let mut moved = 0usize;
    let rc = unsafe {
      CCCrypt(op, KCC_ALG_AES128, KCC_OPTION_PKCS7, key.as_ptr(), key.len(), iv.as_ptr(), input.as_ptr(), input.len(), out.as_mut_ptr(), out.len(), &mut moved)
    };
    if rc != 0 || moved > out.len() { zeroize(&mut out); return None; }
    out.truncate(moved);
    Some(out)
  }

  fn load_mac_keys() -> Result<([u8; 16], [u8; 16]), String> {
    let mut cmd = crate::paths::command("/usr/bin/security");
    cmd.args(["find-generic-password", "-w", "-a", "Chrome", "-s", "Chrome Safe Storage"])
      .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("could not read YouTube cookie key: {e}"))?;
    let stdout = child.stdout.take();
    let child = Arc::new(Mutex::new(child));
    crate::import_queue::watch(&child);
    let status = loop {
      if let Err(e) = crate::import_queue::check() {
        crate::import_queue::kill(&child);
        let _ = child.lock().unwrap_or_else(PoisonError::into_inner).wait();
        crate::import_queue::unwatch();
        return Err(e);
      }
      match child.lock().unwrap_or_else(PoisonError::into_inner).try_wait() {
        Ok(Some(s)) => break Ok(s),
        Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        Err(e) => break Err(format!("could not read YouTube cookie key: {e}")),
      }
    };
    crate::import_queue::unwatch();
    if !status?.success() { return Err("could not read YouTube cookie key from Keychain".into()); }
    let mut pw = Vec::new();
    if let Some(mut out) = stdout { let _ = out.read_to_end(&mut pw); }
    while matches!(pw.last(), Some(b'\n' | b'\r')) { pw.pop(); }
    if pw.is_empty() { return Err("empty YouTube cookie key in Keychain".into()); }
    let (k10, k11) = (derive_key(&pw, b"saltysalt"), derive_key(&pw, b"pepper"));
    zeroize(&mut pw);
    Ok((k10?, k11?))
  }

  fn is_youtube_cookie_host(host: &str) -> bool {
    let h = host.trim_start_matches('.').to_ascii_lowercase();
    YT_DOMAINS.iter().any(|d| h == *d || h.strip_suffix(d).is_some_and(|p| p.ends_with('.')))
  }

  fn has_ctrl(s: &str) -> bool { s.bytes().any(|b| b < 0x20 || b == 0x7f) }

  fn chrome_expires_to_posix(expires_utc: i64) -> u64 {
    if expires_utc <= 0 { return 0; }
    let secs = (expires_utc / 1_000_000) - CHROME_EPOCH_OFFSET_SECS;
    if secs <= 0 { 1 } else { secs as u64 }
  }

  struct RawCookie {
    host_key: String, name: String, value: String, encrypted_value: Vec<u8>,
    path: String, expires_utc: i64, is_secure: i64,
  }

  fn read_db_rows(db_path: &Path) -> Result<(i64, Vec<RawCookie>), String> {
    let conn = Connection::open(db_path).map_err(|e| format!("open cookies db: {e}"))?;
    let meta_version: i64 = conn.query_row("SELECT value FROM meta WHERE key = 'version'", [], |r| r.get::<_, String>(0))
      .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let has_is_secure = conn.prepare("PRAGMA table_info(cookies)")
      .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(1)).map(|rows| rows.flatten().any(|c| c == "is_secure")))
      .unwrap_or(false);
    let secure_col = if has_is_secure { "is_secure" } else { "secure" };
    let sql = format!("SELECT host_key, name, value, encrypted_value, path, expires_utc, {secure_col} FROM cookies");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("query cookies db: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("read cookies db: {e}"))?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(|e| format!("step cookies db: {e}"))? {
      if let (Ok(host_key), Ok(name), Ok(value), Ok(encrypted_value), Ok(path), Ok(expires_utc), Ok(is_secure)) =
        (r.get::<_, String>(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5), r.get(6))
      {
        if is_youtube_cookie_host(&host_key) {
          out.push(RawCookie { host_key, name, value, encrypted_value, path, expires_utc, is_secure });
        }
      }
    }
    Ok((meta_version, out))
  }

  fn decrypt_cookie(
    ev: &[u8], host: &str, meta_version: i64, k10: &[u8; 16], k11: &[u8; 16],
    saw_v11: &mut bool, saw_unknown: &mut bool,
  ) -> Option<String> {
    if ev.len() < 3 { *saw_unknown = true; return None; }
    let (prefix, ct) = ev.split_at(3);
    let key = match prefix { b"v10" => k10, b"v11" => { *saw_v11 = true; k11 } _ => { *saw_unknown = true; return None; } };
    let mut pt = aes_128_cbc(KCC_DECRYPT, key, ct)?;
    let decoded = (|| {
      let body = if meta_version >= 24 {
        if pt.len() < 32 || pt[..32] != Sha256::digest(host.as_bytes())[..] { return None; }
        &pt[32..]
      } else { &pt[..] };
      std::str::from_utf8(body).ok().map(str::to_string)
    })();
    zeroize(&mut pt);
    decoded
  }

  pub(super) fn export_db_to_netscape(db_path: &Path, keys: Option<(&[u8; 16], &[u8; 16])>) -> Result<ExportResult, String> {
    let (meta_version, rows) = read_db_rows(db_path)?;
    if !rows.iter().any(|r| r.name == "LOGIN_INFO") { return Ok(ExportResult::NotLoggedIn); }
    let needs_decrypt = rows.iter().any(|r| r.value.is_empty() && !r.encrypted_value.is_empty());
    let mut local_keys = if needs_decrypt {
      Some(match keys { Some((k10, k11)) => (*k10, *k11), None => load_mac_keys()? })
    } else { None };
    let (mut out, mut count, mut saw_v11, mut saw_unknown) = (String::from("# Netscape HTTP Cookie File\n"), 0usize, false, false);
    for row in rows {
      let val = if !row.value.is_empty() || row.encrypted_value.is_empty() { row.value } else {
        let Some((k10, k11)) = local_keys.as_ref() else { continue };
        let Some(s) = decrypt_cookie(&row.encrypted_value, &row.host_key, meta_version, k10, k11, &mut saw_v11, &mut saw_unknown) else { continue };
        s
      };
      if row.host_key.is_empty() || row.host_key.starts_with('#') || row.path.is_empty()
        || has_ctrl(&row.host_key) || has_ctrl(&row.path) || has_ctrl(&row.name) || has_ctrl(&val) { continue; }
      let sub = if row.host_key.starts_with('.') { "TRUE" } else { "FALSE" };
      let sec = if row.is_secure != 0 { "TRUE" } else { "FALSE" };
      out.push_str(&format!("{}\t{sub}\t{}\t{sec}\t{}\t{}\t{val}\n", row.host_key, row.path, chrome_expires_to_posix(row.expires_utc), row.name));
      count += 1;
    }
    if let Some((ref mut k10, ref mut k11)) = local_keys { zeroize(k10); zeroize(k11); }
    if count == 0 {
      return if !saw_v11 && saw_unknown { Ok(ExportResult::FallbackBrowser) } else { Err("could not decrypt YouTube cookies".into()) };
    }
    Ok(ExportResult::Netscape(out))
  }

  pub(super) fn sweep_stale_temp_in(base: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
      let name = entry.file_name();
      if !name.to_string_lossy().starts_with(TEMP_PREFIX) { continue; }
      let stale = entry.metadata().and_then(|m| m.modified()).ok()
        .and_then(|t| now.duration_since(t).ok())
        .is_some_and(|age| age >= max_age);
      if stale { let _ = std::fs::remove_dir_all(entry.path()); }
    }
  }

  pub(super) fn prepare_mac(login_dir: &Path) -> Result<YtCookies, String> {
    sweep_stale_temp_in(&std::env::temp_dir(), Duration::from_secs(3600));
    let dir = std::env::temp_dir().join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
    DirBuilder::new().mode(0o700).create(&dir).map_err(|e| format!("temp cookie dir: {e}"))?;
    let mut guard = TempGuard(Some(dir.clone()));
    for (i, name) in DB_FILES.iter().enumerate() {
      match std::fs::copy(login_dir.join("Default").join(name), dir.join(name)) {
        Ok(_) => {}
        Err(e) if i > 0 && e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("copy cookies db: {e}")),
      }
    }
    let exported = export_db_to_netscape(&dir.join("Cookies"), None);
    for name in DB_FILES { let _ = std::fs::remove_file(dir.join(name)); }
    match exported? {
      ExportResult::NotLoggedIn => Ok(YtCookies { args: Vec::new(), temp_dir: None }),
      ExportResult::FallbackBrowser => Ok(YtCookies {
        args: vec!["--cookies-from-browser".into(), format!("chrome:{}", login_dir.to_string_lossy())],
        temp_dir: None,
      }),
      ExportResult::Netscape(text) => {
        let cookie_path = dir.join("cookies.txt");
        let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&cookie_path)
          .map_err(|e| format!("write temp cookies: {e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("write temp cookies: {e}"))?;
        guard.0 = None;
        Ok(YtCookies { args: vec!["--cookies".into(), cookie_path.to_string_lossy().into_owned()], temp_dir: Some(dir) })
      }
    }
  }

  #[cfg(test)]
  mod tests {
    use super::*;
    const KCC_ENCRYPT: u32 = 0;

    fn enc(key: &[u8; 16], prefix: &[u8; 3], host: &str, val: &str, hash_prefix: bool) -> Vec<u8> {
      let mut pt = if hash_prefix { Sha256::digest(host.as_bytes()).to_vec() } else { Vec::new() };
      pt.extend_from_slice(val.as_bytes());
      [prefix.as_slice(), &aes_128_cbc(KCC_ENCRYPT, key, &pt).unwrap()].concat()
    }

    fn make_db(db: &Path, meta_ver: &str, rows: Vec<(&str, &str, &str, Vec<u8>, &str, i64, i64)>) {
      let conn = Connection::open(db).unwrap();
      conn.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER);").unwrap();
      conn.execute("INSERT INTO meta VALUES('version', ?1)", [meta_ver]).unwrap();
      for (h, n, v, e, p, exp, sec) in rows {
        conn.execute("INSERT INTO cookies VALUES(?1,?2,?3,?4,?5,?6,?7)", rusqlite::params![h, n, v, e, p, exp, sec]).unwrap();
      }
    }

    #[test]
    fn exports_v10_v11_plaintext_and_filters_domains_bad_hash_ctrl_and_freelist() {
      let dir = std::env::temp_dir().join(format!("yt-cookie-unit-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      let (k10, k11) = (derive_key(b"testpw", b"saltysalt").unwrap(), derive_key(b"testpw", b"pepper").unwrap());
      let mut bad = enc(&k11, b"v11", ".youtube.com", "tampered", true);
      bad[4] ^= 0xff;
      let db24 = dir.join("Cookies24");
      make_db(&db24, "24", vec![
        (".youtube.com", "LOGIN_INFO", "", enc(&k11, b"v11", ".youtube.com", "tok11", true), "/", 13_474_776_614_000_000, 1),
        ("youtube.com", "PREF", "", enc(&k10, b"v10", "youtube.com", "tok10", true), "/", 0, 0),
        (".youtube.com", "PLAIN", "ok", vec![], "/x", 1, 1),
        (".youtube.com", "BADHASH", "", bad, "/", 0, 0),
        (".youtube.com", "CTRL", "", enc(&k11, b"v11", ".youtube.com", "a\tb", true), "/", 0, 0),
        (".example.com", "OTHER_SITE", "secret", vec![], "/", 0, 1),
      ]);
      let ExportResult::Netscape(txt) = export_db_to_netscape(&db24, Some((&k10, &k11))).unwrap() else { panic!("expected netscape") };
      assert!(txt.contains(".youtube.com\tTRUE\t/\tTRUE\t1830303014\tLOGIN_INFO\ttok11\n"));
      assert!(txt.contains("youtube.com\tFALSE\t/\tFALSE\t0\tPREF\ttok10\n"));
      assert!(txt.contains(".youtube.com\tTRUE\t/x\tTRUE\t1\tPLAIN\tok\n"));
      assert!(!txt.contains("BADHASH") && !txt.contains("CTRL") && !txt.contains("OTHER_SITE"));
      let db23 = dir.join("Cookies23");
      make_db(&db23, "23", vec![(".youtube.com", "LOGIN_INFO", "", enc(&k11, b"v11", ".youtube.com", "old23", false), "/", 0, 1)]);
      let ExportResult::Netscape(t23) = export_db_to_netscape(&db23, Some((&k10, &k11))).unwrap() else { panic!("expected v23") };
      assert!(t23.contains("\tLOGIN_INFO\told23\n"));
      let db_out = dir.join("CookiesOut");
      make_db(&db_out, "24", vec![(".youtube.com", "PREF", "v", vec![], "/", 0, 0)]);
      assert!(matches!(export_db_to_netscape(&db_out, None).unwrap(), ExportResult::NotLoggedIn));
      let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drop_cleans_up_temp_dir_and_stale_sweep_removes_old_dirs() {
      let dir = std::env::temp_dir().join(format!("yt-cookie-drop-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(dir.join("Default")).unwrap();
      assert!(super::super::prepare(&dir).unwrap().args().is_empty());
      let stale_root = dir.join("tmp");
      let stale = stale_root.join(format!("{TEMP_PREFIX}old"));
      std::fs::create_dir_all(&stale).unwrap();
      sweep_stale_temp_in(&stale_root, Duration::ZERO);
      assert!(!stale.exists());
      let temp = std::env::temp_dir().join(format!("yt-cookie-rm-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&temp).unwrap();
      let c = YtCookies { args: vec!["--cookies".into()], temp_dir: Some(temp.clone()) };
      assert!(temp.exists());
      drop(c);
      assert!(!temp.exists());
      let _ = std::fs::remove_dir_all(&dir);
    }
  }
}
