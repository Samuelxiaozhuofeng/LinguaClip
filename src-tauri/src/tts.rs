use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use reqwest_websocket::{Message, RequestBuilderExt};
use tauri_plugin_http::reqwest;

use crate::tts_gec;

// Microsoft Edge's "Read aloud" voices: no key, no account. Not a public API —
// it only answers a client that looks like Edge (User-Agent + v2 Sec-MS-GEC from
// tts_gec.rs, a port of edge-tts). When it starts returning 403 again, bump these
// constants to match edge-tts constants.py (and drm.py if the algorithm changed).
// Goes through reqwest so the macOS system proxy applies: from mainland China a
// direct connection is reset most of the time.
const TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION: &str = "2-143.0.3650.75";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const ENDPOINT: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const TIMEOUT: Duration = Duration::from_secs(12);
const MAX_TEXT: usize = 300;

fn xml_escape(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('\'', "&apos;")
    .replace('"', "&quot;")
}

fn valid_voice(v: &str) -> bool {
  !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn hex_id() -> String {
  uuid::Uuid::new_v4().simple().to_string()
}

// A binary frame is: 2-byte big-endian header length, header text, payload.
fn audio_payload(frame: &[u8]) -> Option<&[u8]> {
  if frame.len() < 2 {
    return None;
  }
  let n = u16::from_be_bytes([frame[0], frame[1]]) as usize;
  let head = frame.get(2..2 + n)?;
  if !String::from_utf8_lossy(head).contains("Path:audio") {
    return None;
  }
  Some(&frame[2 + n..])
}

async fn synthesize(text: &str, voice: &str) -> Result<Vec<u8>, String> {
  let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
  let url = format!(
    "{ENDPOINT}?TrustedClientToken={TOKEN}&ConnectionId={}&Sec-MS-GEC={}&Sec-MS-GEC-Version={GEC_VERSION}",
    hex_id(),
    tts_gec::sec_ms_gec_v2(now, TOKEN)
  );
  let client = reqwest::Client::builder()
    .http1_only()
    .user_agent(USER_AGENT)
    .build()
    .map_err(|e| e.to_string())?;
  let res = client
    .get(url)
    .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
    .header("Pragma", "no-cache")
    .header("Cache-Control", "no-cache")
    .header("Cookie", format!("muid={};", hex_id().to_uppercase()))
    .upgrade()
    .send()
    .await
    .map_err(|e| format!("connect: {e}"))?;
  let mut ws = res.into_websocket().await.map_err(|e| format!("handshake: {e}"))?;

  let ts = chrono::Utc::now().format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)").to_string();
  ws.send(Message::Text(format!(
    "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
     {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}\r\n"
  )))
  .await
  .map_err(|e| e.to_string())?;
  ws.send(Message::Text(format!(
    "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}Z\r\nPath:ssml\r\n\r\n\
     <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
     <voice name='{}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>{}</prosody></voice></speak>",
    hex_id(),
    xml_escape(voice),
    xml_escape(text)
  )))
  .await
  .map_err(|e| e.to_string())?;

  let mut mp3 = Vec::new();
  while let Some(msg) = ws.next().await {
    match msg.map_err(|e| e.to_string())? {
      Message::Binary(b) => {
        if let Some(audio) = audio_payload(&b) {
          mp3.extend_from_slice(audio);
        }
      }
      Message::Text(t) if t.contains("Path:turn.end") => break,
      Message::Close { .. } => break,
      _ => {}
    }
  }
  // A misspelt voice is not an error on their side, just silence.
  if mp3.is_empty() {
    return Err("no audio".into());
  }
  Ok(mp3)
}

// Returns raw MP3 bytes (an ArrayBuffer on the JS side).
#[tauri::command]
pub async fn tts(text: String, voice: String) -> Result<tauri::ipc::Response, String> {
  let text = text.trim();
  if text.is_empty() || text.chars().count() > MAX_TEXT {
    return Err("invalid text".into());
  }
  if !valid_voice(&voice) {
    return Err("invalid voice".into());
  }
  let mp3 = tokio::time::timeout(TIMEOUT, synthesize(text, &voice))
    .await
    .map_err(|_| "timeout".to_string())??;
  Ok(tauri::ipc::Response::new(mp3))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn gec_rounds_to_five_minutes() {
    // Same 5-minute window → same signature; next window → different.
    let gec = |t| tts_gec::sec_ms_gec_v2(t, TOKEN);
    let base = 1_790_000_000 - (1_790_000_000 + 11_644_473_600) % 300;
    assert_eq!(gec(base), gec(base + 299));
    assert_ne!(gec(base), gec(base + 300));
    assert_eq!(gec(base).len(), 16 + 1 + 64);
  }

  #[test]
  fn gec_v2_matches_edge_tts() {
    // Computed with edge-tts drm.py generate_sec_ms_gec_v2.
    for (t, want) in [
      (1_760_000_000, "6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D"),
      (1_760_876_543, "30C97C971A706048-D63B76D6447F549B49132493A6985D2BE844849722F4E79E1ACBE1EF476741A7"),
      (1_700_000_000, "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2"),
    ] {
      assert_eq!(tts_gec::sec_ms_gec_v2(t, TOKEN), want, "{t}");
    }
  }

  #[test]
  fn escapes_ssml_and_checks_voice() {
    assert_eq!(xml_escape("a<b>&'\""), "a&lt;b&gt;&amp;&apos;&quot;");
    assert!(valid_voice("en-US-JennyNeural"));
    assert!(!valid_voice("x'/><evil"));
    assert!(!valid_voice(""));
  }

  #[test]
  fn keeps_only_audio_payloads() {
    let head = b"Path:audio\r\nContent-Type:audio/mpeg\r\n";
    let mut frame = (head.len() as u16).to_be_bytes().to_vec();
    frame.extend_from_slice(head);
    frame.extend_from_slice(&[1, 2, 3]);
    assert_eq!(audio_payload(&frame), Some(&[1u8, 2, 3][..]));
    let meta = b"Path:turn.start\r\n";
    let mut other = (meta.len() as u16).to_be_bytes().to_vec();
    other.extend_from_slice(meta);
    assert_eq!(audio_payload(&other), None);
    assert_eq!(audio_payload(&[0]), None);
    assert_eq!(audio_payload(&[0, 50, 1]), None);
  }

  // Hits Microsoft over the network: cargo test -- --ignored live_edge_tts
  #[tokio::test]
  #[ignore]
  async fn live_edge_tts() {
    for (text, voice) in [("was looking for", "en-US-JennyNeural"), ("tengo que ir", "es-ES-ElviraNeural")] {
      let mp3 = synthesize(text, voice).await.expect(voice);
      assert!(mp3.len() > 2000, "{voice}: {} bytes", mp3.len());
      std::fs::write(std::env::temp_dir().join(format!("{voice}.mp3")), &mp3).unwrap();
    }
    assert!(synthesize("hello", "xx-XX-NobodyNeural").await.is_err());
  }
}
