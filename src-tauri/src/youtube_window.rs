// The in-app YouTube window (docs/youtube.md): youtube.com as is, plus one pill in the
// corner of video pages (youtube_pill.js). The window is in no capability, so the page
// can call no command; the pill speaks by navigating to https://linguaclip.invalid/…,
// which on_navigation cancels and hands to `command`. A pick goes to the main window as
// a "youtube-pick" event; the main window creates the record, runs the import and
// answers with youtube_pick_done, which the pill shows. Desktop only; on Android the
// command just says so.
#![cfg_attr(mobile, allow(dead_code, unused_imports, unused_variables))]
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "youtube";
const CMD_HOST: &str = "linguaclip.invalid";
const HOME: &str = "https://www.youtube.com/";
const START: &str = "https://linguaclip.invalid/";
// What the add-video dialog offers (utils/importLangs.ts); anything else is dropped.
const LANGS: &[&str] = &["en", "es", "ja", "zh", "fr", "de", "ko", "no", "auto"];
// The same video clicked again within this long counts once.
const REPICK: Duration = Duration::from_secs(10);

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PillText {
  practice: String,
  lang_hint: String,
  confirm_title: String,
  confirm_body: String,
  install: String,
  not_now: String,
  installing: String,
  failed: String,
  retry: String,
  adding: String,
  added: String,
  not_added: String,
  try_again: String,
  back_home: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct LangOption {
  code: String,
  label: String,
}

#[derive(Serialize)]
struct PillConfig<'a> {
  nonce: &'a str,
  lang: &'a str,
  langs: &'a [LangOption],
  text: &'a PillText,
}

#[derive(Serialize, Clone)]
struct Pick {
  id: String,
  url: String,
  lang: String,
}

struct Session {
  nonce: String,
  // Video id -> when it was handed over and whether the main window saved it: one
  // click, one card. Kept when the window is reopened (only the nonce changes).
  picks: HashMap<String, (Instant, bool)>,
}

#[derive(Debug, PartialEq)]
enum PickState {
  Fresh,
  Pending,
  Saved,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);
static INSTALL_PCT: AtomicU32 = AtomicU32::new(0);

// Async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_youtube_window(app: AppHandle, lang: String, langs: Vec<LangOption>, text: PillText) -> Result<(), String> {
  #[cfg(mobile)]
  return Err("unsupported".into());
  #[cfg(desktop)]
  open_desktop(app, lang, langs, text)
}

#[cfg(desktop)]
fn open_desktop(app: AppHandle, lang: String, langs: Vec<LangOption>, text: PillText) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(LABEL) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    return Ok(());
  }
  if langs.is_empty() {
    return Err("no languages".into());
  }
  let nonce = uuid::Uuid::new_v4().simple().to_string();
  let config = serde_json::to_string(&PillConfig { nonce: &nonce, lang: &lang, langs: &langs, text: &text })
    .map_err(|e| e.to_string())?;
  let script = include_str!("youtube_pill.js").replace("__LC_CONFIG__", &config);
  {
    let mut session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let picks = session.take().map(|s| s.picks).unwrap_or_default();
    *session = Some(Session { nonce, picks });
  }

  let nav_app = app.clone();
  let win_app = app.clone();
  let home = Url::parse(HOME).map_err(|e| e.to_string())?;
  // Tauri lets the window's first origin read the asset protocol (every file the app may
  // play). Start on an address no page can ever have: not youtube.com, and not about:blank
  // either (on a Mac its origin is "null", which any sandboxed iframe also has).
  // on_navigation cancels it; then we go to YouTube.
  let blank = Url::parse(START).map_err(|e| e.to_string())?;
  #[allow(unused_mut)]
  let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(blank))
    .title("YouTube · LinguaClip")
    .inner_size(1200.0, 800.0)
    .min_inner_size(640.0, 480.0)
    .initialization_script(script)
    .on_navigation(move |url| {
      if url.host_str() == Some(CMD_HOST) {
        let app = nav_app.clone();
        let url = url.clone();
        std::thread::spawn(move || command(&app, &url));
        return false;
      }
      !is_local(url)
    })
    .on_new_window(move |url, _features| {
      let app = win_app.clone();
      // Off the callback: it runs inside the webview's own event handler.
      std::thread::spawn(move || {
        if is_google(&url) {
          if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.navigate(url);
          }
        } else if !is_local(&url) && matches!(url.scheme(), "https" | "http") {
          let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
        }
      });
      tauri::webview::NewWindowResponse::Deny
    });
  // Its own cookies and storage, apart from the main window's.
  #[cfg(target_os = "macos")]
  {
    builder = builder.data_store_identifier(*b"linguaclip-ytweb");
  }
  #[cfg(windows)]
  {
    builder = builder.data_directory(crate::whisper_setup::parts_dir().with_file_name("youtube-web"));
  }
  let window = builder.build().map_err(|e| e.to_string())?;
  window.navigate(home).map_err(|e| e.to_string())?;
  crate::yt_update::maybe_update();
  Ok(())
}

// Closing the main window takes this one with it: a pick needs the main window.
pub fn close_with_main(app: &AppHandle) {
  #[cfg(desktop)]
  if let Some(w) = app.get_webview_window(LABEL) {
    let _ = w.close();
  }
}

// Any local origin would be treated as our own page and handed every command.
fn is_local(url: &Url) -> bool {
  match url.scheme() {
    "http" | "https" | "ws" | "wss" => {
      let host = url.host_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
      host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "[::1]"
        || host == "::1"
    }
    "about" | "blob" | "data" | "javascript" => false,
    _ => true, // tauri:, ipc:, asset:, file:, our own schemes, anything unknown
  }
}

fn is_google(url: &Url) -> bool {
  if url.scheme() != "https" {
    return false;
  }
  let host = url.host_str().unwrap_or("").to_ascii_lowercase();
  ["youtube.com", "youtu.be", "google.com"]
    .iter()
    .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn valid_id(id: &str) -> bool {
  id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn param(url: &Url, key: &str) -> Option<String> {
  url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

// One of the pill's commands. Anything not carrying this window's nonce is dropped.
fn command(app: &AppHandle, url: &Url) {
  let nonce = param(url, "n").unwrap_or_default();
  let ok = SESSION.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.nonce == nonce);
  if !ok {
    return;
  }
  match url.path() {
    "/home" => show_main(app),
    path @ ("/pick" | "/install") => {
      let id = param(url, "v").unwrap_or_default();
      let lang = param(url, "lang").unwrap_or_default();
      if !valid_id(&id) || !LANGS.contains(&lang.as_str()) {
        return;
      }
      if INSTALLING.load(Ordering::SeqCst) {
        // A download started earlier (maybe before the window was reopened) is still going.
        tell(app, serde_json::json!({ "kind": "installing", "pct": INSTALL_PCT.load(Ordering::SeqCst), "v": id }));
      } else if path == "/install" || crate::yt_tools::ready() {
        install_then_pick(app, &id, &lang);
      } else {
        let mb = crate::yt_tools::missing_bytes().div_ceil(1_000_000);
        tell(app, serde_json::json!({ "kind": "confirm", "mb": mb, "v": id }));
      }
    }
    _ => {}
  }
}

// Downloads whatever parts are missing (nothing, usually), then hands the video over.
// The pill says "added" only once the main window has saved the card (youtube_pick_done).
fn install_then_pick(app: &AppHandle, id: &str, lang: &str) {
  if INSTALLING.swap(true, Ordering::SeqCst) {
    return;
  }
  INSTALL_PCT.store(0, Ordering::SeqCst);
  let result = if crate::yt_tools::ready() {
    Ok(())
  } else {
    tell(app, serde_json::json!({ "kind": "installing", "pct": 0, "v": id }));
    let mut last = 0;
    crate::yt_tools::ensure(|pct| {
      if pct != last {
        last = pct;
        INSTALL_PCT.store(pct, Ordering::SeqCst);
        tell(app, serde_json::json!({ "kind": "installing", "pct": pct, "v": id }));
      }
    })
  };
  INSTALLING.store(false, Ordering::SeqCst);
  if let Err(e) = result {
    log::error!("youtube tools: {e}");
    tell(app, serde_json::json!({ "kind": "failed", "v": id }));
    return;
  }
  match fresh_pick(id) {
    PickState::Fresh => {}
    PickState::Pending => return tell(app, serde_json::json!({ "kind": "adding", "v": id })),
    PickState::Saved => return tell(app, serde_json::json!({ "kind": "added", "v": id })),
  }
  tell(app, serde_json::json!({ "kind": "adding", "v": id }));
  let pick = Pick { id: id.to_string(), url: format!("https://www.youtube.com/watch?v={id}"), lang: lang.to_string() };
  if app.emit_to("main", "youtube-pick", pick).is_err() {
    pick_done(app, id, false);
  }
}

// The main window's answer to a "youtube-pick": the card is saved (ok) or it is not.
#[tauri::command]
pub fn youtube_pick_done(app: AppHandle, id: String, ok: bool) {
  if valid_id(&id) {
    pick_done(&app, &id, ok);
  }
}

fn pick_done(app: &AppHandle, id: &str, ok: bool) {
  if let Some(s) = SESSION.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
    if ok {
      if let Some(p) = s.picks.get_mut(id) {
        p.1 = true;
      }
    } else {
      // Not saved: the next click must try again, not be taken for a double click.
      s.picks.remove(id);
    }
  }
  tell(app, serde_json::json!({ "kind": if ok { "added" } else { "notAdded" }, "v": id }));
}

fn fresh_pick(id: &str) -> PickState {
  let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
  let Some(s) = guard.as_mut() else { return PickState::Pending };
  let now = Instant::now();
  s.picks.retain(|_, (at, _)| now.duration_since(*at) < REPICK);
  match s.picks.get(id) {
    Some((_, true)) => PickState::Saved,
    Some((_, false)) => PickState::Pending,
    None => {
      s.picks.insert(id.to_string(), (now, false));
      PickState::Fresh
    }
  }
}

fn current_nonce() -> String {
  SESSION.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.nonce.clone()).unwrap_or_default()
}

// Answers the pill: an event only a listener knowing the nonce is waiting for. The nonce
// is read now, not when the work started: the window may have been reopened since.
fn tell(app: &AppHandle, detail: serde_json::Value) {
  let nonce = current_nonce();
  if nonce.is_empty() {
    return;
  }
  if let Some(w) = app.get_webview_window(LABEL) {
    let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('lc-{nonce}', {{ detail: {detail} }}))"));
  }
}

fn show_main(app: &AppHandle) {
  #[cfg(desktop)]
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn local_origins_are_refused() {
    for u in [
      "http://localhost:3000/",
      "http://tauri.localhost/",
      "tauri://localhost/",
      "ipc://localhost/x",
      "asset://localhost/a",
      "file:///etc/passwd",
      "http://127.0.0.1:1430/",
      "http://[::1]/",
      "linguaclip://pick",
    ] {
      assert!(is_local(&Url::parse(u).unwrap()), "{u}");
    }
    for u in ["https://www.youtube.com/watch?v=abc", "https://accounts.google.com/", "about:blank", "blob:https://www.youtube.com/x"] {
      assert!(!is_local(&Url::parse(u).unwrap()), "{u}");
    }
  }

  #[test]
  fn google_hosts_stay_in_the_window() {
    assert!(is_google(&Url::parse("https://m.youtube.com/watch?v=x").unwrap()));
    assert!(is_google(&Url::parse("https://youtu.be/x").unwrap()));
    assert!(is_google(&Url::parse("https://accounts.google.com/").unwrap()));
    assert!(!is_google(&Url::parse("https://notyoutube.com/").unwrap()));
    assert!(!is_google(&Url::parse("http://www.youtube.com/").unwrap()));
  }

  #[test]
  fn one_pick_per_video_and_failed_picks_can_retry() {
    use PickState::*;
    *SESSION.lock().unwrap() = Some(Session { nonce: "n".into(), picks: HashMap::new() });
    assert_eq!(fresh_pick("aaaaaaaaaaa"), Fresh);
    // Clicked again before the main window answered: still "adding", not "added".
    assert_eq!(fresh_pick("aaaaaaaaaaa"), Pending);
    // Another video in between does not let the first one through again.
    assert_eq!(fresh_pick("bbbbbbbbbbb"), Fresh);
    assert_eq!(fresh_pick("aaaaaaaaaaa"), Pending);
    let mark = |id: &str, ok: bool| {
      let mut g = SESSION.lock().unwrap();
      let s = g.as_mut().unwrap();
      if ok { s.picks.get_mut(id).unwrap().1 = true } else { s.picks.remove(id); }
    };
    mark("bbbbbbbbbbb", true);
    assert_eq!(fresh_pick("bbbbbbbbbbb"), Saved);
    // A pick the main window could not save is forgotten.
    mark("aaaaaaaaaaa", false);
    assert_eq!(fresh_pick("aaaaaaaaaaa"), Fresh);
  }

  #[test]
  fn start_address_is_never_a_page_origin() {
    // Tauri's asset protocol answers this window with the start URL's origin.
    let u = Url::parse(START).unwrap();
    assert_eq!(u.host_str(), Some(CMD_HOST));
    assert_eq!(u.scheme(), "https");
  }

  #[test]
  fn video_ids_are_checked() {
    assert!(valid_id("dQw4w9WgXcQ"));
    assert!(valid_id("a-b_c-d_e-f"));
    assert!(!valid_id("short"));
    assert!(!valid_id("dQw4w9WgXc&"));
    assert!(!valid_id("dQw4w9WgXcQQ"));
  }
}
