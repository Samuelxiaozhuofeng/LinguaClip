use std::time::Duration;

// AnkiConnect runs on this Mac, so talk to it directly. The http plugin's
// client follows the macOS system proxy but ignores its bypass list, so with
// Clash on, every AnkiConnect call came back as the proxy's 502.
#[tauri::command]
pub async fn anki_request(url: String, body: String) -> Result<String, String> {
  let url = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return Err("invalid url: only http and https".into());
  }
  let client = reqwest::Client::builder()
    .no_proxy()
    // never let a 3xx carry the request body somewhere else
    .redirect(reqwest::redirect::Policy::none())
    // storeMediaFile carries a whole audio clip as base64
    .timeout(Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())?;
  let res = client
    .post(url)
    .header("Content-Type", "application/json")
    .body(body)
    .send()
    .await
    .map_err(|e| e.to_string())?;
  let status = res.status();
  let text = res.text().await.map_err(|e| e.to_string())?;
  if !status.is_success() {
    let head: String = text.chars().take(120).collect();
    return Err(format!("HTTP {}: {}", status.as_u16(), if head.is_empty() { "(empty body)".into() } else { head }));
  }
  Ok(text)
}

#[cfg(test)]
mod tests {
  use super::*;

  // Needs Anki open with AnkiConnect. Run it the way Finder launches the app,
  // with no proxy env and the macOS system proxy on:
  // env -u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY cargo test -- --ignored anki
  #[tokio::test]
  #[ignore]
  async fn reaches_local_anki_past_system_proxy() {
    let text = anki_request("http://127.0.0.1:8765".into(), r#"{"action":"version","version":6}"#.into())
      .await
      .unwrap();
    assert!(text.contains("\"result\""), "{text}");
  }

  #[tokio::test]
  async fn rejects_non_http_urls() {
    assert!(anki_request("file:///etc/passwd".into(), "{}".into()).await.is_err());
  }
}
