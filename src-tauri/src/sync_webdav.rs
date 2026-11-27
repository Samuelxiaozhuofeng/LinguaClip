// Zero-CORS WebDAV transport for Desktop + Android sync (docs/sync.md).
// Handles URL safety, path whitelisting, MKCOL/PROPFIND XML parsing,
// atomic PUT .tmp + MOVE (with fallback to direct PUT), and gzipped transfers.
use std::io::{Read, Write};
use std::net::IpAddr;
use std::path::Path;
use std::time::Duration;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use tauri_plugin_http::reqwest::{self, Method, Url};

use crate::cache::{valid_id, valid_kind};
use crate::clips::safe_name;

const UA: &str = "LinguaClip-Sync/1.0";
const MAX_GZ_BYTES: u64 = 32 * 1024 * 1024;
const SYNC_SUBDIRS: [&str; 5] = ["devices", "subs", "caches", "clip-packs", "audio"];
const PROPFIND_BODY: &str = concat!(
  r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:">"#,
  r#"<d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>"#,
);

fn default_root_dir() -> String { "LinguaClip".to_string() }
fn net_err(e: impl std::fmt::Display) -> String { format!("sync:network:{e}") }

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
  pub url: String,
  pub username: String,
  pub password: String,
  #[serde(default = "default_root_dir")]
  pub root_dir: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavTestResult {
  pub ok: bool,
  pub remote_root: String,
  pub existing_devices: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
  pub name: String,
  pub etag: Option<String>,
  pub size: Option<u64>,
}

pub(crate) struct Endpoint {
  origin: String,
  base_segments: Vec<String>,
  root_segments: Vec<String>,
  username: String,
  password: String,
  pub(crate) is_local: bool,
}

impl Endpoint {
  pub(crate) fn from_config(cfg: &WebDavConfig) -> Result<Self, String> {
    let (url, is_local) = validate_url(&cfg.url)?;
    let root_segments = sanitize_root_dir(&cfg.root_dir)?;
    let host = url.host_str().ok_or("sync:insecure_url")?;
    let origin = match url.port() {
      Some(port) => format!("{}://{host}:{port}", url.scheme()),
      None => format!("{}://{host}", url.scheme()),
    };
    let base_segments = url.path().split('/').filter(|s| !s.is_empty()).map(percent_decode).collect();
    Ok(Self {
      origin,
      base_segments,
      root_segments,
      username: cfg.username.clone(),
      password: cfg.password.clone(),
      is_local,
    })
  }

  fn build_url(&self, segments: &[String], trailing_slash: bool) -> String {
    let mut out = self.origin.clone();
    for seg in segments {
      out.push('/');
      out.push_str(&encode_path_segment(seg));
    }
    if trailing_slash || segments.is_empty() {
      out.push('/');
    }
    out
  }

  fn sync_root_segments(&self) -> Vec<String> {
    let mut segs = self.base_segments.clone();
    segs.extend(self.root_segments.iter().cloned());
    segs.push("LinguaClipSync".to_string());
    segs
  }

  pub(crate) fn remote_root_url(&self) -> String { self.build_url(&self.sync_root_segments(), true) }

  fn dir_url(&self, subpath: &str) -> String {
    let mut segs = self.sync_root_segments();
    segs.push(subpath.to_string());
    self.build_url(&segs, true)
  }

  fn decoded_dir_path(&self, subpath: &str) -> String {
    let mut segs = self.sync_root_segments();
    segs.push(subpath.to_string());
    format!("/{}", segs.join("/"))
  }

  pub(crate) fn file_url(&self, rel_path: &str) -> String {
    let mut segs = self.sync_root_segments();
    segs.extend(rel_path.split('/').map(str::to_string));
    self.build_url(&segs, false)
  }

  fn mkcol_urls(&self) -> Vec<String> {
    let (mut urls, mut cur) = (Vec::new(), self.base_segments.clone());
    for seg in self.root_segments.iter().cloned().chain(std::iter::once("LinguaClipSync".to_string())) {
      cur.push(seg);
      urls.push(self.build_url(&cur, true));
    }
    for sub in SYNC_SUBDIRS {
      let mut s = cur.clone();
      s.push(sub.to_string());
      urls.push(self.build_url(&s, true));
    }
    urls
  }

  pub(crate) fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    if self.username.is_empty() && self.password.is_empty() {
      req
    } else {
      req.basic_auth(&self.username, Some(&self.password))
    }
  }
}

fn is_local_or_private_host(host: &str) -> bool {
  let stripped = host.trim_start_matches('[').trim_end_matches(']');
  if let Ok(ip) = stripped.parse::<IpAddr>() {
    return match ip {
      IpAddr::V4(v4) => {
        let [a, b, ..] = v4.octets();
        v4.is_loopback() || v4.is_private() || v4.is_link_local() || (a == 100 && (64..=127).contains(&b))
      }
      IpAddr::V6(v6) => {
        let s0 = v6.segments()[0];
        v6.is_loopback() || (s0 & 0xfe00) == 0xfc00 || (s0 & 0xffc0) == 0xfe80
      }
    };
  }
  let lower = host.to_ascii_lowercase();
  lower == "localhost"
    || (lower.len() > 6 && lower.ends_with(".local") && !lower.starts_with('.'))
    || (lower.len() > 4 && lower.ends_with(".lan") && !lower.starts_with('.'))
    || (lower.len() > 7 && lower.ends_with(".ts.net") && !lower.starts_with('.'))
}

pub(crate) fn validate_url(raw: &str) -> Result<(Url, bool), String> {
  let url = Url::parse(raw.trim()).map_err(|_| "sync:insecure_url".to_string())?;
  let host = url.host_str().filter(|h| !h.is_empty()).ok_or("sync:insecure_url")?;
  if url.query().is_some() || url.fragment().is_some() {
    return Err("sync:insecure_url".into());
  }
  let is_local = is_local_or_private_host(host);
  match url.scheme() {
    "https" => Ok((url, is_local)),
    "http" if is_local => Ok((url, true)),
    _ => Err("sync:insecure_url".into()),
  }
}

pub(crate) fn sanitize_root_dir(raw: &str) -> Result<Vec<String>, String> {
  let trimmed = raw.trim().trim_matches('/');
  if trimmed.is_empty() {
    return Ok(vec![default_root_dir()]);
  }
  let mut segs = Vec::new();
  for seg in trimmed.split('/') {
    let bad = seg.is_empty()
      || seg == "."
      || seg == ".."
      || seg.len() > 128
      || seg.chars().any(|c| c.is_control() || matches!(c, '\\' | '?' | '#' | ':' | '*' | '"' | '<' | '>' | '|'));
    if bad {
      return Err(format!("sync:invalid_path:{raw}"));
    }
    segs.push(seg.to_string());
  }
  Ok(segs)
}

pub(crate) fn valid_sha256_hex(s: &str) -> bool {
  s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn validate_rel_path(rel_path: &str) -> Result<(), String> {
  if rel_path.is_empty() || rel_path.starts_with('/') || rel_path.contains('\\') || rel_path.contains("..") || rel_path.chars().any(|c| c.is_control()) {
    return Err(format!("sync:invalid_path:{rel_path}"));
  }
  let ok = match rel_path.split_once('/') {
    Some(("devices", rest)) => rest.strip_suffix(".json.gz").is_some_and(valid_id),
    Some(("subs", rest)) => rest.strip_suffix(".srt.gz").is_some_and(valid_sha256_hex),
    Some(("caches", rest)) => rest
      .strip_suffix(".json.gz")
      .and_then(|s| s.split_once('.'))
      .is_some_and(|(id, kind)| valid_id(id) && valid_kind(kind) && kind != "words"),
    Some(("clip-packs", rest)) => rest.strip_suffix(".zip").is_some_and(|name| {
      !name.is_empty()
        && name.len() <= 196
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && safe_name(rest).is_ok()
    }),
    Some(("audio", rest)) => rest.strip_suffix(".m4a").is_some_and(|s| {
      let mut count = 0usize;
      s.split("__").all(|p| {
        count += 1;
        count <= 3 && valid_id(p)
      }) && (count == 2 || count == 3)
    }),
    _ => false,
  };
  ok.then_some(()).ok_or_else(|| format!("sync:invalid_path:{rel_path}"))
}

pub(crate) fn build_client(is_local: bool, timeout_secs: u64) -> Result<reqwest::Client, String> {
  let mut b = reqwest::Client::builder()
    .user_agent(UA)
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(timeout_secs));
  if is_local {
    b = b.no_proxy();
  }
  b.build().map_err(net_err)
}

pub(crate) fn build_stream_client(is_local: bool, read_timeout_secs: u64) -> Result<reqwest::Client, String> {
  let mut b = reqwest::Client::builder()
    .user_agent(UA)
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(15))
    .read_timeout(Duration::from_secs(read_timeout_secs));
  if is_local {
    b = b.no_proxy();
  }
  b.build().map_err(net_err)
}

pub(crate) fn build_upload_client(is_local: bool) -> Result<reqwest::Client, String> {
  let mut b = reqwest::Client::builder()
    .user_agent(UA)
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(15));
  if is_local {
    b = b.no_proxy();
  }
  b.build().map_err(net_err)
}

pub(crate) fn map_http_error(status: u16, body: &str) -> String {
  match status {
    401 | 403 => "sync:auth".into(),
    404 => "sync:notfound".into(),
    429 | 503 => "sync:ratelimit".into(),
    _ => {
      // Jianguoyun wraps the real reason in <s:exception>/<s:message>; surface it instead of the XML prologue.
      if let Some(ex) = first_text(body, "exception") {
        let msg: String = first_text(body, "message").unwrap_or_default().chars().take(100).collect();
        return format!("sync:http:{status}:{ex} {msg}").trim_end().to_string();
      }
      let head: String = body.chars().map(|c| if c == '\r' || c == '\n' { ' ' } else { c }).take(120).collect();
      format!("sync:http:{status}:{}", head.trim())
    }
  }
}

/// MOVE refusals that a plain overwrite-PUT can still satisfy. 409/412: Jianguoyun ignores
/// `Overwrite: T` and answers 409 DuplicateName once the target exists (every sync after the first).
fn move_falls_back_to_put(status: u16) -> bool { matches!(status, 400 | 403 | 405 | 409 | 412 | 501) }

fn header_etag(res: &reqwest::Response) -> Option<String> {
  res.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub(crate) fn encode_path_segment(seg: &str) -> String {
  let mut out = String::with_capacity(seg.len());
  for b in seg.bytes() {
    if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
      out.push(b as char);
    } else {
      out.push_str(&format!("%{b:02X}"));
    }
  }
  out
}

pub(crate) fn percent_decode(input: &str) -> String {
  let hex = |b: u8| match b {
    b'0'..=b'9' => Some(b - b'0'),
    b'a'..=b'f' => Some(b - b'a' + 10),
    b'A'..=b'F' => Some(b - b'A' + 10),
    _ => None,
  };
  let bytes = input.as_bytes();
  let (mut out, mut i) = (Vec::with_capacity(bytes.len()), 0);
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
        out.push((hi << 4) | lo);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn unescape_xml(s: &str) -> String {
  s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

fn strip_xml_comments(xml: &str) -> String {
  let (mut out, mut rest) = (String::with_capacity(xml.len()), xml);
  while let Some(start) = rest.find("<!--") {
    out.push_str(&rest[..start]);
    match rest[start + 4..].find("-->") {
      Some(end) => rest = &rest[start + 4 + end + 3..],
      None => return out,
    }
  }
  out.push_str(rest);
  out
}

fn tag_local_eq(tag_name: &str, want: &str) -> bool {
  tag_name.rsplit_once(':').map_or(tag_name, |(_, l)| l).eq_ignore_ascii_case(want)
}

fn next_tag(xml: &str, from: usize) -> Option<(usize, usize, &str)> {
  let lt = from + xml[from..].find('<')?;
  let (b, mut i, mut quote) = (xml.as_bytes(), lt + 1, None);
  while i < b.len() {
    match quote {
      Some(q) if b[i] == q => quote = None,
      Some(_) => {}
      None if b[i] == b'"' || b[i] == b'\'' => quote = Some(b[i]),
      None if b[i] == b'>' => return Some((lt, i, xml[lt + 1..i].trim())),
      _ => {}
    }
    i += 1;
  }
  None
}

fn extract_blocks<'a>(xml: &'a str, local_name: &str) -> Vec<&'a str> {
  let (mut out, mut i) = (Vec::new(), 0);
  while let Some((_, gt, inner)) = next_tag(xml, i) {
    i = gt + 1;
    if inner.is_empty() || inner.starts_with(['?', '!', '/']) || inner.ends_with('/') {
      continue;
    }
    if !tag_local_eq(inner.split_whitespace().next().unwrap_or(""), local_name) {
      continue;
    }
    let (body_start, mut depth, mut j) = (gt + 1, 1usize, gt + 1);
    while let Some((c_lt, c_gt, c_inner)) = next_tag(xml, j) {
      j = c_gt + 1;
      if let Some(end_name) = c_inner.strip_prefix('/') {
        if tag_local_eq(end_name.trim(), local_name) {
          depth -= 1;
          if depth == 0 {
            out.push(&xml[body_start..c_lt]);
            i = c_gt + 1;
            break;
          }
        }
      } else if !c_inner.starts_with(['?', '!']) && !c_inner.ends_with('/') {
        if tag_local_eq(c_inner.split_whitespace().next().unwrap_or(""), local_name) {
          depth += 1;
        }
      }
    }
  }
  out
}

fn has_tag(xml: &str, local_name: &str) -> bool {
  let mut i = 0;
  while let Some((_, gt, inner)) = next_tag(xml, i) {
    i = gt + 1;
    if !inner.is_empty() && !inner.starts_with(['?', '!', '/']) {
      if tag_local_eq(inner.trim_end_matches('/').split_whitespace().next().unwrap_or(""), local_name) {
        return true;
      }
    }
  }
  false
}

fn first_text(xml: &str, local_name: &str) -> Option<String> {
  extract_blocks(xml, local_name).into_iter().find_map(|block| {
    let t = block.trim();
    let raw = t.strip_prefix("<![CDATA[").and_then(|s| s.strip_suffix("]]>")).map(str::to_string).unwrap_or_else(|| unescape_xml(t));
    let val = raw.trim().to_string();
    (!val.is_empty()).then_some(val)
  })
}

pub(crate) fn parse_propfind(xml: &str, expected_dir_path: &str) -> Vec<RemoteEntry> {
  let clean = strip_xml_comments(xml);
  let base = expected_dir_path.trim_end_matches('/');
  let prefix = if base.is_empty() { "/".to_string() } else { format!("{base}/") };
  let mut entries = Vec::new();
  for resp in extract_blocks(&clean, "response") {
    let Some(href_raw) = first_text(resp, "href") else { continue };
    let path_part = if href_raw.starts_with("http://") || href_raw.starts_with("https://") {
      Url::parse(&href_raw).map(|u| u.path().to_string()).unwrap_or(href_raw)
    } else {
      href_raw.split(['?', '#']).next().unwrap_or("").to_string()
    };
    let mut decoded = percent_decode(&path_part);
    if !decoded.starts_with('/') {
      decoded.insert(0, '/');
    }
    let trimmed = decoded.trim_end_matches('/');
    if trimmed == base || extract_blocks(resp, "resourcetype").iter().any(|rt| has_tag(rt, "collection")) {
      continue;
    }
    let Some(rel) = trimmed.strip_prefix(&prefix) else { continue };
    if rel.is_empty() || rel.contains('/') {
      continue;
    }
    let propstats = extract_blocks(resp, "propstat");
    let ok_blocks: Vec<&str> = propstats.iter().copied().filter(|ps| first_text(ps, "status").is_none_or(|st| st.contains(" 200 "))).collect();
    let search = if ok_blocks.is_empty() { vec![resp] } else { ok_blocks };
    let etag = search.iter().find_map(|b| first_text(b, "getetag"));
    let size = search.iter().find_map(|b| first_text(b, "getcontentlength")).and_then(|s| s.parse().ok());
    entries.push(RemoteEntry { name: rel.to_string(), etag, size });
  }
  entries
}

pub(crate) fn gzip_compress(data: &[u8]) -> Result<Vec<u8>, String> {
  let mut enc = GzEncoder::new(Vec::new(), Compression::default());
  enc.write_all(data).map_err(|e| format!("sync:corrupt:gzip:{e}"))?;
  enc.finish().map_err(|e| format!("sync:corrupt:gzip:{e}"))
}

pub(crate) fn gzip_decompress_utf8(data: &[u8], max_out: u64) -> Result<String, String> {
  let mut out = Vec::new();
  (&mut GzDecoder::new(data)).take(max_out + 1).read_to_end(&mut out).map_err(|e| format!("sync:corrupt:gzip:{e}"))?;
  if out.len() as u64 > max_out {
    return Err("sync:corrupt:too_large".into());
  }
  String::from_utf8(out).map_err(|e| format!("sync:corrupt:utf8:{e}"))
}

async fn get_checked(client: &reqwest::Client, ep: &Endpoint, rel_path: &str, max_bytes: u64) -> Result<reqwest::Response, String> {
  let res = ep.auth(client.get(ep.file_url(rel_path))).send().await.map_err(net_err)?;
  let status = res.status().as_u16();
  if !(200..=299).contains(&status) {
    return Err(map_http_error(status, &res.text().await.unwrap_or_default()));
  }
  if res.content_length().is_some_and(|n| n > max_bytes) {
    return Err("sync:corrupt:too_large".into());
  }
  Ok(res)
}

pub(crate) async fn put_bytes_atomic(
  client: &reqwest::Client,
  ep: &Endpoint,
  rel_path: &str,
  bytes: Vec<u8>,
  content_type: &str,
) -> Result<Option<String>, String> {
  let target_url = ep.file_url(rel_path);
  let tmp_url = format!("{target_url}.tmp");
  let put_res = ep.auth(client.put(&tmp_url)).header(reqwest::header::CONTENT_TYPE, content_type).body(bytes.clone()).send().await.map_err(net_err)?;
  let (put_status, put_etag) = (put_res.status().as_u16(), header_etag(&put_res));
  if !(200..=299).contains(&put_status) {
    return Err(map_http_error(put_status, &put_res.text().await.unwrap_or_default()));
  }
  let move_res = ep
    .auth(client.request(Method::from_bytes(b"MOVE").expect("MOVE"), &tmp_url))
    .header("Destination", &target_url)
    .header("Overwrite", "T")
    .send()
    .await
    .map_err(net_err)?;
  let (move_status, move_etag) = (move_res.status().as_u16(), header_etag(&move_res));
  if (200..=299).contains(&move_status) {
    return Ok(move_etag.or(put_etag));
  }
  if move_falls_back_to_put(move_status) {
    let direct = ep.auth(client.put(&target_url)).header(reqwest::header::CONTENT_TYPE, content_type).body(bytes).send().await.map_err(net_err)?;
    let (d_status, d_etag) = (direct.status().as_u16(), header_etag(&direct));
    let _ = ep.auth(client.delete(&tmp_url)).send().await;
    if (200..=299).contains(&d_status) {
      return Ok(d_etag);
    }
    return Err(map_http_error(d_status, &direct.text().await.unwrap_or_default()));
  }
  let body = move_res.text().await.unwrap_or_default();
  let _ = ep.auth(client.delete(&tmp_url)).send().await;
  Err(map_http_error(move_status, &body))
}

pub(crate) async fn ensure_subdir(client: &reqwest::Client, ep: &Endpoint, subpath: &str) -> Result<(), String> {
  let mkcol = Method::from_bytes(b"MKCOL").expect("MKCOL");
  let res = ep.auth(client.request(mkcol, ep.dir_url(subpath))).send().await.map_err(net_err)?;
  let status = res.status().as_u16();
  if matches!(status, 200 | 201 | 204 | 301 | 405) {
    Ok(())
  } else {
    Err(map_http_error(status, &res.text().await.unwrap_or_default()))
  }
}

pub(crate) async fn put_file_atomic(
  client: &reqwest::Client,
  ep: &Endpoint,
  rel_path: &str,
  file_path: &Path,
  content_type: &str,
) -> Result<Option<String>, String> {
  let file_len = tokio::fs::metadata(file_path).await.map_err(|e| format!("sync:io:{e}"))?.len();
  let put_timeout = Duration::from_secs(120u64.saturating_add(file_len / 16_384));
  let op_timeout = Duration::from_secs(60);
  let target_url = ep.file_url(rel_path);
  let tmp_url = format!("{target_url}.tmp");
  let file = tokio::fs::File::open(file_path).await.map_err(|e| format!("sync:io:{e}"))?;
  let put_res = match ep
    .auth(client.put(&tmp_url))
    .timeout(put_timeout)
    .header(reqwest::header::CONTENT_TYPE, content_type)
    .header(reqwest::header::CONTENT_LENGTH, file_len)
    .body(reqwest::Body::from(file))
    .send()
    .await
  {
    Ok(r) => r,
    Err(e) => {
      let _ = ep.auth(client.delete(&tmp_url)).timeout(op_timeout).send().await;
      return Err(net_err(e));
    }
  };
  let (put_status, put_etag) = (put_res.status().as_u16(), header_etag(&put_res));
  if !(200..=299).contains(&put_status) {
    let body = put_res.text().await.unwrap_or_default();
    let _ = ep.auth(client.delete(&tmp_url)).timeout(op_timeout).send().await;
    return Err(map_http_error(put_status, &body));
  }
  let move_res = match ep
    .auth(client.request(Method::from_bytes(b"MOVE").expect("MOVE"), &tmp_url))
    .timeout(op_timeout)
    .header("Destination", &target_url)
    .header("Overwrite", "T")
    .send()
    .await
  {
    Ok(r) => r,
    Err(e) => {
      let _ = ep.auth(client.delete(&tmp_url)).timeout(op_timeout).send().await;
      return Err(net_err(e));
    }
  };
  let (move_status, move_etag) = (move_res.status().as_u16(), header_etag(&move_res));
  if (200..=299).contains(&move_status) {
    return Ok(move_etag.or(put_etag));
  }
  if move_falls_back_to_put(move_status) {
    let file2 = match tokio::fs::File::open(file_path).await {
      Ok(f) => f,
      Err(e) => {
        let _ = ep.auth(client.delete(&tmp_url)).timeout(op_timeout).send().await;
        return Err(format!("sync:io:{e}"));
      }
    };
    let direct = match ep
      .auth(client.put(&target_url))
      .timeout(put_timeout)
      .header(reqwest::header::CONTENT_TYPE, content_type)
      .header(reqwest::header::CONTENT_LENGTH, file_len)
      .body(reqwest::Body::from(file2))
      .send()
      .await
    {
      Ok(r) => r,
      Err(e) => {
        let _ = ep.auth(client.delete(&tmp_url)).timeout(op_timeout).send().await;
        return Err(net_err(e));
      }
    };
    let (d_status, d_etag) = (direct.status().as_u16(), header_etag(&direct));
    let _ = ep.auth(client.delete(&tmp_url)).timeout(op_timeout).send().await;
    if (200..=299).contains(&d_status) {
      return Ok(d_etag);
    }
    return Err(map_http_error(d_status, &direct.text().await.unwrap_or_default()));
  }
  let body = move_res.text().await.unwrap_or_default();
  let _ = ep.auth(client.delete(&tmp_url)).timeout(op_timeout).send().await;
  Err(map_http_error(move_status, &body))
}

pub(crate) async fn download_to_file_limited(
  client: &reqwest::Client,
  ep: &Endpoint,
  rel_path: &str,
  dest: &Path,
  max_bytes: u64,
) -> Result<u64, String> {
  let mut res = get_checked(client, ep, rel_path, max_bytes).await?;
  let mut file = std::fs::File::create(dest).map_err(|e| format!("sync:io:{e}"))?;
  let mut total = 0u64;
  while let Some(chunk) = res.chunk().await.map_err(net_err)? {
    total += chunk.len() as u64;
    if total > max_bytes {
      return Err("sync:corrupt:too_large".into());
    }
    file.write_all(&chunk).map_err(|e| format!("sync:io:{e}"))?;
  }
  file.sync_all().map_err(|e| format!("sync:io:{e}"))?;
  Ok(total)
}

pub(crate) async fn download_to_file_sha256(
  client: &reqwest::Client,
  ep: &Endpoint,
  rel_path: &str,
  dest: &Path,
  max_bytes: u64,
) -> Result<(u64, String), String> {
  use tokio::io::AsyncWriteExt;
  let mut res = get_checked(client, ep, rel_path, max_bytes).await?;
  let mut file = tokio::fs::File::create(dest).await.map_err(|e| format!("sync:io:{e}"))?;
  let mut hasher = Sha256::new();
  let mut total = 0u64;
  while let Some(chunk) = res.chunk().await.map_err(net_err)? {
    total += chunk.len() as u64;
    if total > max_bytes {
      return Err("sync:corrupt:too_large".into());
    }
    hasher.update(&chunk);
    file.write_all(&chunk).await.map_err(|e| format!("sync:io:{e}"))?;
  }
  file.flush().await.map_err(|e| format!("sync:io:{e}"))?;
  file.sync_all().await.map_err(|e| format!("sync:io:{e}"))?;
  let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
  Ok((total, hex))
}

async fn propfind_dir(client: &reqwest::Client, ep: &Endpoint, subpath: &str) -> Result<Vec<RemoteEntry>, String> {
  let res = ep
    .auth(client.request(Method::from_bytes(b"PROPFIND").expect("PROPFIND"), ep.dir_url(subpath)))
    .header("Depth", "1")
    .header(reqwest::header::CONTENT_TYPE, "application/xml; charset=utf-8")
    .body(PROPFIND_BODY)
    .send()
    .await
    .map_err(net_err)?;
  let status = res.status().as_u16();
  let body = res.text().await.map_err(net_err)?;
  if status != 200 && status != 207 {
    return Err(map_http_error(status, &body));
  }
  Ok(parse_propfind(&body, &ep.decoded_dir_path(subpath)))
}

#[tauri::command]
pub async fn sync_webdav_test(config: WebDavConfig) -> Result<WebDavTestResult, String> {
  let ep = Endpoint::from_config(&config)?;
  let client = build_client(ep.is_local, 60)?;
  let mkcol = Method::from_bytes(b"MKCOL").expect("MKCOL");
  for url in ep.mkcol_urls() {
    let res = ep.auth(client.request(mkcol.clone(), &url)).send().await.map_err(net_err)?;
    let status = res.status().as_u16();
    if !matches!(status, 200 | 201 | 204 | 301 | 405) {
      return Err(map_http_error(status, &res.text().await.unwrap_or_default()));
    }
  }
  let entries = propfind_dir(&client, &ep, "devices").await?;
  let existing_devices = entries.iter().filter(|e| e.name.ends_with(".json.gz")).count();
  Ok(WebDavTestResult { ok: true, remote_root: ep.remote_root_url(), existing_devices })
}

#[tauri::command]
pub async fn sync_webdav_list(config: WebDavConfig, subpath: String) -> Result<Vec<RemoteEntry>, String> {
  let ep = Endpoint::from_config(&config)?;
  if !SYNC_SUBDIRS.contains(&subpath.as_str()) {
    return Err(format!("sync:invalid_path:{subpath}"));
  }
  propfind_dir(&build_client(ep.is_local, 60)?, &ep, &subpath).await
}

#[tauri::command]
pub async fn sync_webdav_get_gz(config: WebDavConfig, rel_path: String) -> Result<String, String> {
  let ep = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  if !rel_path.ends_with(".gz") {
    return Err(format!("sync:invalid_path:{rel_path}"));
  }
  let mut res = get_checked(&build_client(ep.is_local, 60)?, &ep, &rel_path, MAX_GZ_BYTES).await?;
  let mut buf = Vec::new();
  while let Some(chunk) = res.chunk().await.map_err(net_err)? {
    if (buf.len() + chunk.len()) as u64 > MAX_GZ_BYTES {
      return Err("sync:corrupt:too_large".into());
    }
    buf.extend_from_slice(&chunk);
  }
  gzip_decompress_utf8(&buf, MAX_GZ_BYTES)
}

#[tauri::command]
pub async fn sync_webdav_put_gz(config: WebDavConfig, rel_path: String, content: String) -> Result<Option<String>, String> {
  let ep = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  if !rel_path.ends_with(".gz") {
    return Err(format!("sync:invalid_path:{rel_path}"));
  }
  if content.len() as u64 > MAX_GZ_BYTES {
    return Err("sync:corrupt:too_large".into());
  }
  let compressed = gzip_compress(content.as_bytes())?;
  put_bytes_atomic(&build_client(ep.is_local, 60)?, &ep, &rel_path, compressed, "application/gzip").await
}

#[tauri::command]
pub async fn sync_webdav_delete(config: WebDavConfig, rel_path: String) -> Result<(), String> {
  let ep = Endpoint::from_config(&config)?;
  validate_rel_path(&rel_path)?;
  let res = ep.auth(build_client(ep.is_local, 60)?.delete(ep.file_url(&rel_path))).send().await.map_err(net_err)?;
  let status = res.status().as_u16();
  if (200..=299).contains(&status) || status == 404 {
    Ok(())
  } else {
    Err(map_http_error(status, &res.text().await.unwrap_or_default()))
  }
}

#[cfg(test)]
#[path = "sync_webdav_tests.rs"]
mod tests;
