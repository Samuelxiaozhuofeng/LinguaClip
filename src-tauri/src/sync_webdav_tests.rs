use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::sync_packs::{
  download_clip_pack_in, read_merge_pack_at, rekey_files_in, unpack_merge_pack_in,
  upload_clip_pack_in, write_merge_pack_in,
};

const DEV_A: &str = "550e8400-e29b-41d4-a716-446655440000";
const DEV_B: &str = "550e8400-e29b-41d4-a716-446655440001";
const SHA_A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[derive(Default)]
struct ServerState {
  dirs: HashSet<String>,
  files: HashMap<String, (Vec<u8>, String)>,
  log: Vec<(String, String)>,
  reject_move_405: bool,
  force_status: Option<u16>,
  required_auth: Option<String>,
  extra_propfind_entries: Vec<(String, String, u64)>,
}

struct MockDav {
  base_url: String,
  state: Arc<Mutex<ServerState>>,
  handle: tokio::task::JoinHandle<()>,
}

impl Drop for MockDav {
  fn drop(&mut self) {
    self.handle.abort();
  }
}

fn temp_own(tag: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("lc-sync-{tag}-{}", uuid::Uuid::new_v4()));
  fs::create_dir_all(dir.join("clips")).unwrap();
  fs::create_dir_all(dir.join("tmp")).unwrap();
  fs::create_dir_all(dir.join("media")).unwrap();
  dir
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> Option<(String, String, HashMap<String, String>, Vec<u8>)> {
  let mut buf = Vec::new();
  let mut tmp = [0u8; 4096];
  let header_end = loop {
    let n = stream.read(&mut tmp).await.ok()?;
    if n == 0 {
      return None;
    }
    buf.extend_from_slice(&tmp[..n]);
    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
      break pos;
    }
  };
  let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
  let mut lines = head.split("\r\n");
  let first = lines.next()?;
  let mut parts = first.split_whitespace();
  let method = parts.next()?.to_string();
  let target = parts.next()?.to_string();
  let mut headers = HashMap::new();
  for line in lines {
    if let Some((k, v)) = line.split_once(':') {
      headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
  }
  let content_len = headers
    .get("content-length")
    .and_then(|v| v.parse::<usize>().ok())
    .unwrap_or(0);
  let mut body = buf[header_end + 4..].to_vec();
  while body.len() < content_len {
    let n = stream.read(&mut tmp).await.ok()?;
    if n == 0 {
      break;
    }
    body.extend_from_slice(&tmp[..n]);
  }
  body.truncate(content_len);
  Some((method, target, headers, body))
}

async fn start_mock_dav(prefix: &str) -> MockDav {
  let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
  let addr = listener.local_addr().unwrap();
  let state = Arc::new(Mutex::new(ServerState::default()));
  let st = state.clone();
  let handle = tokio::spawn(async move {
    loop {
      let Ok((mut stream, _)) = listener.accept().await else { break };
      let st = st.clone();
      tokio::spawn(async move {
        let Some((method, target, headers, body)) = read_http_request(&mut stream).await else { return };
        let path = percent_decode(target.split('?').next().unwrap_or(&target));
        let (status, reason, extra_hdrs, resp_body) = {
          let mut g = st.lock().unwrap();
          g.log.push((method.clone(), path.clone()));
          if let Some(code) = g.force_status {
            (code, "Forced", vec![], b"forced error".to_vec())
          } else if let Some(req_auth) = g.required_auth.clone() {
            if headers.get("authorization").map(String::as_str) != Some(req_auth.as_str()) {
              (401, "Unauthorized", vec![], b"bad creds".to_vec())
            } else {
              handle_dav_op(&mut g, &method, &path, &headers, body)
            }
          } else {
            handle_dav_op(&mut g, &method, &path, &headers, body)
          }
        };
        let mut resp = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n", resp_body.len());
        for (k, v) in extra_hdrs {
          resp.push_str(&format!("{k}: {v}\r\n"));
        }
        resp.push_str("\r\n");
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.write_all(&resp_body).await;
      });
    }
  });
  let base_url = format!("http://127.0.0.1:{}{prefix}", addr.port());
  MockDav { base_url, state, handle }
}

fn handle_dav_op(
  g: &mut ServerState,
  method: &str,
  path: &str,
  headers: &HashMap<String, String>,
  body: Vec<u8>,
) -> (u16, &'static str, Vec<(&'static str, String)>, Vec<u8>) {
  match method {
    "MKCOL" => {
      let key = path.trim_end_matches('/').to_string();
      if g.dirs.insert(key) {
        (201, "Created", vec![], vec![])
      } else {
        (405, "Method Not Allowed", vec![], vec![])
      }
    }
    "PROPFIND" => {
      let dir = path.trim_end_matches('/');
      let prefix = format!("{dir}/");
      let mut xml = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:lp1="DAV:"><d:response><d:href>{dir}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>{dir}/nested-dir/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
      );
      for (f_path, (data, etag)) in &g.files {
        if let Some(name) = f_path.strip_prefix(&prefix) {
          if !name.contains('/') {
            let encoded = name.split('/').map(encode_path_segment).collect::<Vec<_>>().join("/");
            xml.push_str(&format!(
              r#"<d:response><d:href>{dir}/{encoded}</d:href><d:propstat><d:prop><lp1:getetag>{etag}</lp1:getetag><lp1:getcontentlength>{}</lp1:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#,
              data.len()
            ));
          }
        }
      }
      for (href, etag, sz) in &g.extra_propfind_entries {
        xml.push_str(&format!(
          r#"<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:getetag>{etag}</d:getetag><d:getcontentlength>{sz}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
        ));
      }
      xml.push_str("</d:multistatus>");
      (207, "Multi-Status", vec![("Content-Type", "application/xml; charset=utf-8".into())], xml.into_bytes())
    }
    "PUT" => {
      let etag = format!("\"len-{}\"", body.len());
      g.files.insert(path.to_string(), (body, etag.clone()));
      (201, "Created", vec![("ETag", etag)], vec![])
    }
    "MOVE" => {
      if g.reject_move_405 {
        return (405, "Method Not Allowed", vec![], b"MOVE disabled".to_vec());
      }
      let Some(dest_raw) = headers.get("destination") else {
        return (400, "Bad Request", vec![], b"missing dest".to_vec());
      };
      let dest_path = Url::parse(dest_raw)
        .map(|u| percent_decode(u.path()))
        .unwrap_or_else(|_| percent_decode(dest_raw));
      if let Some(entry) = g.files.remove(path) {
        let etag = entry.1.clone();
        g.files.insert(dest_path, entry);
        (204, "No Content", vec![("ETag", etag)], vec![])
      } else {
        (404, "Not Found", vec![], vec![])
      }
    }
    "GET" => match g.files.get(path) {
      Some((data, etag)) => (200, "OK", vec![("ETag", etag.clone())], data.clone()),
      None => (404, "Not Found", vec![], b"nope".to_vec()),
    },
    "DELETE" => {
      if g.files.remove(path).is_some() {
        (204, "No Content", vec![], vec![])
      } else {
        (404, "Not Found", vec![], vec![])
      }
    }
    _ => (405, "Method Not Allowed", vec![], vec![]),
  }
}

fn cfg_for(url: &str) -> WebDavConfig {
  WebDavConfig {
    url: url.to_string(),
    username: "alice".into(),
    password: "secret".into(),
    root_dir: "LinguaClip".into(),
  }
}

#[tokio::test]
async fn mkcol_and_propfind_with_dav_prefix_and_percent_encoding() {
  let srv = start_mock_dav("/dav/").await;
  let cfg = cfg_for(&srv.base_url);

  let res = sync_webdav_test(cfg.clone()).await.unwrap();
  assert!(res.ok);
  assert!(res.remote_root.ends_with("/dav/LinguaClip/LinguaClipSync/"));
  assert!(!res.remote_root.contains("/dav/dav/"));
  assert_eq!(res.existing_devices, 0);

  // Calling test again succeeds when MKCOL returns 405 (already exists).
  let res2 = sync_webdav_test(cfg.clone()).await.unwrap();
  assert!(res2.ok);

  // Inject a percent-encoded filename and verify base path stripping + self/subcollection skipping.
  {
    let mut g = srv.state.lock().unwrap();
    g.extra_propfind_entries.push((
      format!("/dav/LinguaClip/LinguaClipSync/devices/{DEV_A}%2Ejson%2Egz"),
      "&quot;e-encoded&quot;".into(),
      1234,
    ));
  }
  let list = sync_webdav_list(cfg.clone(), "devices".into()).await.unwrap();
  assert_eq!(list.len(), 1);
  assert_eq!(list[0].name, format!("{DEV_A}.json.gz"));
  assert_eq!(list[0].etag.as_deref(), Some("\"e-encoded\""));
  assert_eq!(list[0].size, Some(1234));

  let res3 = sync_webdav_test(cfg).await.unwrap();
  assert_eq!(res3.existing_devices, 1);
}

#[tokio::test]
async fn put_gz_atomic_move_and_405_fallback() {
  let srv = start_mock_dav("/dav/").await;
  let cfg = cfg_for(&srv.base_url);
  let rel = format!("devices/{DEV_A}.json.gz");

  // 1) Happy path: PUT .tmp + MOVE
  let etag = sync_webdav_put_gz(cfg.clone(), rel.clone(), r#"{"v":1,"ok":true}"#.into())
    .await
    .unwrap();
  assert!(etag.is_some());
  {
    let g = srv.state.lock().unwrap();
    let methods: Vec<&str> = g.log.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(methods, vec!["PUT", "MOVE"]);
    assert!(g.files.contains_key(&format!("/dav/LinguaClip/LinguaClipSync/{rel}")));
    assert!(!g.files.contains_key(&format!("/dav/LinguaClip/LinguaClipSync/{rel}.tmp")));
  }

  // 2) MOVE returns 405 -> falls back to direct PUT and deletes .tmp
  {
    let mut g = srv.state.lock().unwrap();
    g.log.clear();
    g.reject_move_405 = true;
  }
  let rel2 = format!("devices/{DEV_B}.json.gz");
  let etag2 = sync_webdav_put_gz(cfg.clone(), rel2.clone(), r#"{"v":1,"fallback":true}"#.into())
    .await
    .unwrap();
  assert!(etag2.is_some());
  {
    let g = srv.state.lock().unwrap();
    let methods: Vec<&str> = g.log.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(methods, vec!["PUT", "MOVE", "PUT", "DELETE"]);
    assert!(g.files.contains_key(&format!("/dav/LinguaClip/LinguaClipSync/{rel2}")));
    assert!(!g.files.contains_key(&format!("/dav/LinguaClip/LinguaClipSync/{rel2}.tmp")));
  }
  let got = sync_webdav_get_gz(cfg, rel2).await.unwrap();
  assert_eq!(got, r#"{"v":1,"fallback":true}"#);
}

#[tokio::test]
async fn get_gz_roundtrip_and_corrupt_gzip_rejected() {
  let srv = start_mock_dav("/dav/").await;
  let cfg = cfg_for(&srv.base_url);
  let rel = format!("subs/{SHA_A}.srt.gz");
  let srt = "1\n00:00:01,000 --> 00:00:03,000\nHello 世界\n";
  sync_webdav_put_gz(cfg.clone(), rel.clone(), srt.into()).await.unwrap();
  assert_eq!(sync_webdav_get_gz(cfg.clone(), rel.clone()).await.unwrap(), srt);

  // Truncate the stored gzip payload to trigger CRC / EOF failure.
  {
    let mut g = srv.state.lock().unwrap();
    let key = format!("/dav/LinguaClip/LinguaClipSync/{rel}");
    let (bytes, _) = g.files.get_mut(&key).unwrap();
    bytes.truncate(bytes.len() / 2);
  }
  let err = sync_webdav_get_gz(cfg, rel).await.unwrap_err();
  assert!(err.starts_with("sync:corrupt:"), "got {err}");
}

#[tokio::test]
async fn status_error_normalization_and_delete_404_ok() {
  let srv = start_mock_dav("/dav/").await;
  let cfg = cfg_for(&srv.base_url);
  let rel = format!("devices/{DEV_A}.json.gz");

  assert_eq!(sync_webdav_get_gz(cfg.clone(), rel.clone()).await.unwrap_err(), "sync:notfound");
  assert!(sync_webdav_delete(cfg.clone(), rel.clone()).await.is_ok());

  srv.state.lock().unwrap().force_status = Some(401);
  assert_eq!(sync_webdav_get_gz(cfg.clone(), rel.clone()).await.unwrap_err(), "sync:auth");

  srv.state.lock().unwrap().force_status = Some(403);
  assert_eq!(sync_webdav_get_gz(cfg.clone(), rel.clone()).await.unwrap_err(), "sync:auth");

  srv.state.lock().unwrap().force_status = Some(429);
  assert_eq!(sync_webdav_get_gz(cfg.clone(), rel.clone()).await.unwrap_err(), "sync:ratelimit");

  srv.state.lock().unwrap().force_status = Some(503);
  assert_eq!(sync_webdav_get_gz(cfg.clone(), rel.clone()).await.unwrap_err(), "sync:ratelimit");

  // Redirects must never be followed (prevents Basic Auth credential leakage).
  srv.state.lock().unwrap().force_status = Some(302);
  let redir_err = sync_webdav_get_gz(cfg, rel).await.unwrap_err();
  assert!(redir_err.starts_with("sync:http:302:"), "got {redir_err}");
}

#[test]
fn rejects_path_traversal_and_insecure_public_http_urls() {
  for bad_url in [
    "http://example.com/dav/",
    "http://dav.jianguoyun.com/dav/",
    "http://172.32.0.1/dav/",
    "http://8.8.8.8/dav/",
    "ftp://127.0.0.1/dav/",
    "http://127.0.0.1/dav/?x=1",
  ] {
    assert_eq!(validate_url(bad_url).unwrap_err(), "sync:insecure_url", "{bad_url}");
  }
  for ok_url in [
    "https://dav.jianguoyun.com/dav/",
    "http://127.0.0.1:5005/dav/",
    "http://localhost:8080/dav",
    "http://[::1]:8080/dav/",
    "http://192.168.1.10:5005/dav/",
    "http://10.0.0.5/dav/",
    "http://172.16.0.1/dav/",
    "http://172.31.255.254/dav/",
    "http://nas.local:5005/dav/",
    "http://box.tail123.ts.net/dav/",
  ] {
    assert!(validate_url(ok_url).is_ok(), "{ok_url}");
  }

  for bad_path in [
    "../secret.json.gz",
    "devices/../../etc/passwd",
    "/devices/abc.json.gz",
    "devices/bad_char.json.gz",
    "other/abc.json.gz",
    "subs/not-hex.srt.gz",
    &format!("caches/{DEV_A}.words.json.gz"),
    &format!("caches/{DEV_A}.exe.json.gz"),
    "clip-packs/bad.name.zip",
    "clip-packs/a/b.zip",
  ] {
    assert!(validate_rel_path(bad_path).is_err(), "{bad_path}");
  }
  assert!(validate_rel_path(&format!("devices/{DEV_A}.json.gz")).is_ok());
  assert!(validate_rel_path(&format!("subs/{SHA_A}.srt.gz")).is_ok());
  assert!(validate_rel_path(&format!("caches/{DEV_A}.trans.json.gz")).is_ok());
  assert!(validate_rel_path("clip-packs/dev1_0001.zip").is_ok());
  assert!(sanitize_root_dir("../escape").is_err());
  assert!(sanitize_root_dir("a\\b").is_err());
}

#[tokio::test]
async fn clip_pack_upload_and_download_skips_oversized_and_sets_fresh_mtime() {
  let srv = start_mock_dav("/dav/").await;
  let cfg = cfg_for(&srv.base_url);
  let src_own = temp_own("clip-up");
  let dst_own = temp_own("clip-dn");

  fs::write(src_own.join("clips/small_1.m4a"), b"audio-bytes-1").unwrap();
  fs::write(src_own.join("clips/small_2.jpg"), b"jpg-bytes-2").unwrap();
  // > 1.5 MiB default single-file limit must be skipped
  fs::write(src_own.join("clips/huge.mp4"), vec![b'x'; 1_600_000]).unwrap();

  let rel = "clip-packs/devA-0001.zip".to_string();
  let packed = upload_clip_pack_in(
    src_own.clone(),
    cfg.clone(),
    rel.clone(),
    vec!["small_1.m4a".into(), "huge.mp4".into(), "small_2.jpg".into(), "missing.m4a".into()],
    None,
    None,
  )
  .await
  .unwrap();
  assert_eq!(packed, vec!["small_1.m4a".to_string(), "small_2.jpg".to_string()]);
  assert!(fs::read_dir(src_own.join("tmp")).unwrap().next().is_none());

  let before = SystemTime::now() - Duration::from_secs(2);
  let extracted = download_clip_pack_in(
    dst_own.clone(),
    cfg,
    rel,
    vec!["small_1.m4a".into()],
  )
  .await
  .unwrap();
  assert_eq!(extracted, vec!["small_1.m4a".to_string()]);
  let clip_path = dst_own.join("clips/small_1.m4a");
  assert_eq!(fs::read(&clip_path).unwrap(), b"audio-bytes-1");
  assert!(!dst_own.join("clips/small_2.jpg").exists());
  assert!(!dst_own.join("clips/small_1.m4a.sync.part").exists());
  let mtime = fs::metadata(&clip_path).unwrap().modified().unwrap();
  assert!(mtime >= before, "expected fresh mtime, got {mtime:?} < {before:?}");
  assert!(fs::read_dir(dst_own.join("tmp")).unwrap().next().is_none());

  let _ = fs::remove_dir_all(&src_own);
  let _ = fs::remove_dir_all(&dst_own);
}

#[test]
fn merge_pack_write_read_and_selective_unpack_roundtrip() {
  let src_own = temp_own("mp-src");
  let dst_own = temp_own("mp-dst");
  fs::write(src_own.join("clips/c1.m4a"), b"clip-one").unwrap();
  fs::write(src_own.join("clips/c2.jpg"), b"clip-two").unwrap();

  let snap = r#"{"v":1,"videos":[{"id":"a"}]}"#;
  let subs = vec![(SHA_A.to_string(), "1\n00:00:00,000 --> 00:00:01,000\nHi\n".to_string())];
  let out = write_merge_pack_in(
    &src_own,
    None,
    snap,
    &subs,
    &["c1.m4a".into(), "c2.jpg".into()],
  )
  .unwrap();
  let out_path = PathBuf::from(&out);
  assert!(out_path.is_file());
  assert!(out.contains("tmp/exports/") && out.ends_with(".zip"));

  let meta = read_merge_pack_at(&out_path).unwrap();
  assert_eq!(meta.snapshot_json, snap);
  assert_eq!(meta.subs, subs);
  assert_eq!(meta.clip_names, vec!["c1.m4a".to_string(), "c2.jpg".to_string()]);

  let unpacked = unpack_merge_pack_in(&dst_own, &out_path, vec!["c2.jpg".into()]).unwrap();
  assert_eq!(unpacked, vec!["c2.jpg".to_string()]);
  assert_eq!(fs::read(dst_own.join("clips/c2.jpg")).unwrap(), b"clip-two");
  assert!(!dst_own.join("clips/c1.m4a").exists());

  let _ = fs::remove_dir_all(&src_own);
  let _ = fs::remove_dir_all(&dst_own);
}

#[test]
fn rekey_files_renames_caches_and_media_without_overwriting_existing() {
  let own = temp_own("rekey");
  fs::write(own.join(format!("{DEV_A}.trans.json")), b"from-trans").unwrap();
  fs::write(own.join(format!("{DEV_A}.cloze.json")), b"from-cloze").unwrap();
  fs::write(own.join(format!("{DEV_B}.cloze.json")), b"existing-cloze").unwrap();
  fs::write(own.join("media").join(format!("{DEV_A}.mp3")), b"from-mp3").unwrap();
  fs::write(own.join("media").join(format!("{DEV_A}.m4a")), b"from-m4a").unwrap();
  fs::write(own.join("media").join(format!("{DEV_B}.m4a")), b"existing-m4a").unwrap();
  fs::write(own.join("media").join(format!("{DEV_A}.part")), b"partial").unwrap();

  assert!(rekey_files_in(&own, "../bad", DEV_B, true).is_err());
  let res = rekey_files_in(&own, DEV_A, DEV_B, true).unwrap();
  assert_eq!(res.moved, 2); // trans.json + mp3 (cloze.json & m4a already exist; .part skipped)
  let mp3_src = own.join("media").join(format!("{DEV_A}.mp3")).to_string_lossy().into_owned();
  let mp3_dst = own.join("media").join(format!("{DEV_B}.mp3")).to_string_lossy().into_owned();
  assert!(res.media_paths.contains(&(mp3_src, mp3_dst)));

  assert!(!own.join(format!("{DEV_A}.trans.json")).exists());
  assert_eq!(fs::read(own.join(format!("{DEV_B}.trans.json"))).unwrap(), b"from-trans");
  assert_eq!(fs::read(own.join(format!("{DEV_B}.cloze.json"))).unwrap(), b"existing-cloze");
  assert!(own.join(format!("{DEV_A}.cloze.json")).is_file());
  assert!(!own.join("media").join(format!("{DEV_A}.mp3")).exists());
  assert_eq!(fs::read(own.join("media").join(format!("{DEV_B}.mp3"))).unwrap(), b"from-mp3");
  assert_eq!(fs::read(own.join("media").join(format!("{DEV_B}.m4a"))).unwrap(), b"existing-m4a");
  assert!(own.join("media").join(format!("{DEV_A}.part")).is_file());

  let json_out = crate::sync_packs::write_merge_json_in(&own, None, r#"{"format":"linguaclip-sync-pack"}"#).unwrap();
  assert!(json_out.ends_with(".json"));
  assert_eq!(fs::read_to_string(&json_out).unwrap(), r#"{"format":"linguaclip-sync-pack"}"#);

  assert!(validate_url("http://100.64.1.2:8080/dav").is_ok());
  assert!(validate_url("http://nas.lan/dav").is_ok());
  assert!(validate_url("http://[fd00::1]/dav").is_ok());

  let _ = fs::remove_dir_all(&own);
}
