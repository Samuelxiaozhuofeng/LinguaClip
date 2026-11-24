// Groq's hosted Whisper (OpenAI-compatible): one multipart upload per piece,
// words and lines straight back in the answer.
use tauri_plugin_http::reqwest;

use crate::cloud_asr::{form_body, Resp};

const URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL: &str = "whisper-large-v3-turbo";

pub(crate) async fn send(
  client: &reqwest::Client,
  api_key: &str,
  lang: &str,
  audio: (Vec<u8>, &str, &str),
) -> Result<Resp, String> {
  send_to(client, URL, MODEL, api_key, lang, audio).await
}

pub(crate) async fn send_to(
  client: &reqwest::Client,
  url: &str,
  model: &str,
  api_key: &str,
  lang: &str,
  (audio, name, mime): (Vec<u8>, &str, &str),
) -> Result<Resp, String> {
  let boundary = format!("lc{}", uuid::Uuid::new_v4().simple());
  let mut fields = vec![
    ("model", model),
    ("response_format", "verbose_json"),
    ("timestamp_granularities[]", "word"),
    ("timestamp_granularities[]", "segment"),
    ("temperature", "0"),
  ];
  if lang != "auto" {
    fields.push(("language", lang));
  }
  let body = form_body(&boundary, &fields, (&audio, name, mime));

  let res = client
    .post(url)
    .bearer_auth(api_key)
    .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
    .body(body)
    .send()
    .await
    .map_err(|e| format!("cloud:network:{e}"))?;
  let status = res.status().as_u16();
  let text = res.text().await.map_err(|e| format!("cloud:network:{e}"))?;
  if status != 200 {
    return Err(http_error(status, &text));
  }
  serde_json::from_str(&text).map_err(|e| format!("cloud:{e}"))
}

// Raw codes; utils/importJob.ts formatImportError turns them into sentences.
fn http_error(status: u16, body: &str) -> String {
  let msg = serde_json::from_str::<serde_json::Value>(body)
    .ok()
    .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
    .unwrap_or_else(|| body.chars().take(200).collect());
  match status {
    401 => "cloud:key".into(),
    429 => format!("cloud:quota:{msg}"),
    413 => "cloud:toolarge".into(),
    403 => format!("cloud:denied:{msg}"),
    _ => format!("cloud:HTTP {status} {msg}"),
  }
}
