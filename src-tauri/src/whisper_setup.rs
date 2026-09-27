// Transcription parts (whisper-cli + two models): where to find them, and
// downloading whatever is missing into our own folder on first use. Nothing is
// bundled in the app; a Mac that already has Homebrew's whisper-cli or the full
// model in ~/.cache/whisper.cpp keeps using those.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri_plugin_http::reqwest;

pub struct Parts {
  pub whisper: PathBuf,
  // The CPU whisper-cli to rerun with when the graphics-card one fails.
  pub fallback: Option<PathBuf>,
  pub model: PathBuf,
  pub vad: PathBuf,
}

pub(crate) struct Asset {
  pub(crate) name: &'static str,
  pub(crate) size: u64,
  pub(crate) sha256: &'static str,
  // Tried in order; a partial file carries over to the next one. From mainland
  // China huggingface.co usually fails, hf-mirror.com usually works.
  pub(crate) urls: &'static [&'static str],
}

// macOS: built by scripts/build-whisper-cli.sh; links only system frameworks.
#[cfg(all(not(windows), not(target_arch = "x86_64")))]
const WHISPER_CLI: Asset = Asset {
  name: "whisper-cli",
  size: 3_055_240,
  sha256: "09d672178dcc7daba8f5b36a2a0bab86a5de9cd8f0bcf699f2fc7f785274a80f",
  // ponytail: GitHub only; add a mirror if users in China report this step failing.
  urls: &["https://github.com/Samuelxiaozhuofeng/video_dictation_local/releases/download/whisper-cli-1.8.4/whisper-cli"],
};
// Intel Mac: same script with ARCH=x86_64 (CPU only, no Metal), its own Release.
#[cfg(all(not(windows), target_arch = "x86_64"))]
const WHISPER_CLI: Asset = Asset {
  name: "whisper-cli",
  size: 2_787_904,
  sha256: "bf75b0892780cec6435d99f08236f11aa736a62a2383bed53c117beea033cc96",
  urls: &["https://github.com/Samuelxiaozhuofeng/video_dictation_local/releases/download/whisper-cli-1.8.4-x86_64/whisper-cli"],
};
#[cfg(not(windows))]
const WHISPER_EXE: &str = "whisper-cli";

// Windows: whisper.cpp's own CPU build, unpacked in place (exe + its DLLs).
#[cfg(windows)]
const WHISPER_CLI: Asset = Asset {
  name: "whisper-bin-x64.zip",
  size: 4_078_768,
  sha256: "74f973345cb52ef5ba3ec9e7e7af8e48cc8c71722d1528603b80588a11f82e3e",
  urls: &["https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip"],
};
#[cfg(windows)]
const WHISPER_EXE: &str = "Release/whisper-cli.exe";
// Settings → "Transcribe on the graphics card": the same whisper.cpp built with
// Vulkan by .github/workflows/whisper-vulkan.yml, unpacked beside the CPU one.
#[cfg(windows)]
const WHISPER_VULKAN: Asset = Asset {
  name: "whisper-vulkan-x64.zip",
  size: 17_988_352,
  sha256: "11b8f84c9202f83cb6510bba2e92c9520b9c79990d6b25db12ca0cd46caebeaa",
  urls: &["https://github.com/Samuelxiaozhuofeng/video_dictation_local/releases/download/whisper-vulkan-1.8.4/whisper-vulkan-x64.zip"],
};
#[cfg(windows)]
const WHISPER_VULKAN_EXE: &str = "vulkan/whisper-cli.exe";
// q5_0 is a third of the full model's size with near-identical output, and the
// DTW preset "large.v3.turbo" still gives word timings with it.
const MODEL: Asset = Asset {
  name: "ggml-large-v3-turbo-q5_0.bin",
  size: 574_041_195,
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  urls: &[
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  ],
};
// The "light" choice in Settings for slow machines: a third of the size, a few
// times faster, less accurate. DTW preset "small" gives its word timings.
const LIGHT_MODEL: Asset = Asset {
  name: "ggml-small-q5_1.bin",
  size: 190_085_487,
  sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  urls: &[
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
  ],
};
const VAD: Asset = Asset {
  name: "ggml-silero-v5.1.2.bin",
  size: 885_098,
  sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
  urls: &[
    "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    "https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
  ],
};

// Which model a local transcription uses (Settings → Transcription).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tier {
  Standard,
  Light,
}

impl Tier {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "standard" => Ok(Self::Standard),
      "light" => Ok(Self::Light),
      _ => Err("bad-model".into()),
    }
  }
  fn asset(self) -> &'static Asset {
    match self {
      Self::Standard => &MODEL,
      Self::Light => &LIGHT_MODEL,
    }
  }
  // Also accepted when found in ~/.cache/whisper.cpp (a hand install).
  fn cached_names(self) -> [&'static str; 2] {
    match self {
      Self::Standard => ["ggml-large-v3-turbo.bin", MODEL.name],
      Self::Light => ["ggml-small.bin", LIGHT_MODEL.name],
    }
  }
  // whisper-cli's DTW alignment-head preset; it must match the model or there
  // are no word timings.
  pub fn dtw(self) -> &'static str {
    match self {
      Self::Standard => "large.v3.turbo",
      Self::Light => "small",
    }
  }
}

const STALL: Duration = Duration::from_secs(30);

// Two imports that both find the parts missing must not write the same file.
static INSTALLING: Mutex<()> = Mutex::new(());

fn home() -> PathBuf {
  crate::paths::home_dir().unwrap_or_default()
}

// ponytail: whisper-cli on Windows reads paths in the ANSI code page, so a user
// folder whose name that code page cannot spell (e.g. a Chinese name on English
// Windows) breaks the model path. Move parts to an ASCII folder if users hit it.
pub fn parts_dir() -> PathBuf {
  if cfg!(windows) {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    local.unwrap_or_else(|| home().join("AppData/Local")).join("com.linguaclip.app/whisper")
  } else {
    home().join("Library/Application Support/com.linguaclip.app/whisper")
  }
}

fn first_file(candidates: Vec<PathBuf>) -> Option<PathBuf> {
  candidates.into_iter().find(|p| p.is_file())
}

fn find_whisper() -> Option<PathBuf> {
  first_file(vec![parts_dir().join(WHISPER_EXE)])
    .or_else(|| crate::import::find_bin("whisper-cli").ok())
}

// Every Intel / AMD / NVIDIA driver installs the Vulkan loader. Without it the
// Vulkan whisper-cli cannot even start (and Windows would pop a "DLL not found"
// box), so such a machine just keeps the CPU one.
#[cfg(windows)]
fn wants_vulkan(gpu: bool) -> bool {
  let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
  gpu && root.join(r"System32\vulkan-1.dll").is_file()
}
#[cfg(not(windows))]
fn wants_vulkan(_gpu: bool) -> bool {
  false
}

#[cfg(windows)]
fn find_vulkan() -> Option<PathBuf> {
  first_file(vec![parts_dir().join(WHISPER_VULKAN_EXE)])
}
#[cfg(not(windows))]
fn find_vulkan() -> Option<PathBuf> {
  None
}

fn find_model(tier: Tier) -> Option<PathBuf> {
  let cache = home().join(".cache/whisper.cpp");
  let [a, b] = tier.cached_names();
  first_file(vec![parts_dir().join(tier.asset().name), cache.join(a), cache.join(b)])
}

fn find_vad() -> Option<PathBuf> {
  first_file(vec![parts_dir().join(VAD.name), home().join(".cache/whisper.cpp").join(VAD.name)])
}

pub fn find(tier: Tier, gpu: bool) -> Option<Parts> {
  let cpu = find_whisper()?;
  let (whisper, fallback) = if wants_vulkan(gpu) { (find_vulkan()?, Some(cpu)) } else { (cpu, None) };
  Some(Parts { whisper, fallback, model: find_model(tier)?, vad: find_vad()? })
}

fn missing(tier: Tier, gpu: bool) -> Vec<&'static Asset> {
  let mut out = Vec::new();
  if find_whisper().is_none() {
    out.push(&WHISPER_CLI);
  }
  #[cfg(windows)]
  if wants_vulkan(gpu) && find_vulkan().is_none() {
    out.push(&WHISPER_VULKAN);
  }
  #[cfg(not(windows))]
  let _ = gpu;
  if find_model(tier).is_none() {
    out.push(tier.asset());
  }
  if find_vad().is_none() {
    out.push(&VAD);
  }
  out
}

// Returns the parts, downloading any that are missing first. `on_pct` gets the
// overall percent across everything still to fetch; it is not called at all
// when nothing is missing.
pub fn ensure(tier: Tier, gpu: bool, mut on_pct: impl FnMut(u32)) -> Result<Parts, String> {
  let _guard = INSTALLING.lock().unwrap_or_else(|e| e.into_inner());
  let todo = missing(tier, gpu);
  if !todo.is_empty() {
    let dir = parts_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("setup:{e}"))?;
    let total: u64 = todo.iter().map(|a| a.size).sum();
    let mut before = 0u64;
    let mut last = None;
    for asset in todo {
      tauri::async_runtime::block_on(fetch(asset, &dir, |got| {
        let pct = ((before + got) * 100 / total.max(1)).min(99) as u32;
        if last != Some(pct) {
          last = Some(pct);
          on_pct(pct);
        }
      }))?;
      before += asset.size;
    }
  }
  find(tier, gpu).ok_or_else(|| "setup:parts still missing after download".into())
}

pub(crate) async fn fetch(asset: &Asset, dir: &Path, mut on_bytes: impl FnMut(u64)) -> Result<(), String> {
  let part = dir.join(format!("{}.part", asset.name));
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .build()
    .map_err(|e| format!("setup:{e}"))?;
  let mut last_err = String::new();
  for url in asset.urls {
    match fetch_from(&client, url, &part, asset.size, &mut on_bytes).await {
      Ok(()) if verified(&part, asset) => {
        last_err.clear();
        break;
      }
      Ok(()) => {
        // A corrupt file would never resume into a good one: drop it and let
        // the next URL start from zero.
        let _ = std::fs::remove_file(&part);
        last_err = format!("{} checksum mismatch", asset.name);
      }
      Err(e) => last_err = e,
    }
  }
  if !last_err.is_empty() {
    return Err(format!("setup:{last_err}"));
  }
  #[cfg(unix)]
  if asset.name == WHISPER_CLI.name {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))
      .map_err(|e| format!("setup:{e}"))?;
  }
  let done = dir.join(asset.name);
  std::fs::rename(&part, &done).map_err(|e| format!("setup:{e}"))?;
  if asset.name.ends_with(".zip") {
    unzip(&done, dir)?;
    let _ = std::fs::remove_file(&done);
  }
  Ok(())
}

// Windows 10+ ships bsdtar, which reads zip files; macOS has ditto.
fn unzip(zip: &Path, dir: &Path) -> Result<(), String> {
  #[cfg(windows)]
  let mut cmd = {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut c = crate::paths::command(root.join(r"System32\tar.exe"));
    c.arg("-xf").arg(zip).arg("-C").arg(dir);
    c
  };
  #[cfg(not(windows))]
  let mut cmd = {
    let mut c = crate::paths::command("/usr/bin/ditto");
    c.args(["-x", "-k"]).arg(zip).arg(dir);
    c
  };
  let out = cmd
    .output()
    .map_err(|e| format!("setup:unzip {e}"))?;
  if !out.status.success() {
    return Err(format!("setup:unzip {}", String::from_utf8_lossy(&out.stderr).trim()));
  }
  Ok(())
}

fn verified(path: &Path, asset: &Asset) -> bool {
  let Ok(mut file) = std::fs::File::open(path) else { return false };
  let mut hasher = Sha256::new();
  let Ok(len) = std::io::copy(&mut file, &mut hasher) else { return false };
  let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
  len == asset.size && digest == asset.sha256
}

// Resumes from whatever `part` already holds. A stalled connection (no answer or
// no bytes for 30s) counts as a failure so the next URL gets its turn.
async fn fetch_from(
  client: &reqwest::Client,
  url: &str,
  part: &Path,
  size: u64,
  on_bytes: &mut impl FnMut(u64),
) -> Result<(), String> {
  let mut have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
  if have > size {
    let _ = std::fs::remove_file(part);
    have = 0;
  }
  if have == size {
    return Ok(());
  }
  let mut req = client.get(url);
  if have > 0 {
    req = req.header("Range", format!("bytes={have}-"));
  }
  let mut res = tokio::time::timeout(STALL, req.send())
    .await
    .map_err(|_| "no response".to_string())?
    .map_err(|e| e.to_string())?;
  let status = res.status().as_u16();
  let append = match status {
    206 => true,
    200 => false,
    _ => return Err(format!("HTTP {status}")),
  };
  if !append {
    have = 0;
  }
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .append(append)
    .truncate(!append)
    .open(part)
    .map_err(|e| e.to_string())?;
  on_bytes(have);
  loop {
    let chunk = tokio::time::timeout(STALL, res.chunk())
      .await
      .map_err(|_| "download stalled".to_string())?
      .map_err(|e| e.to_string())?;
    let Some(chunk) = chunk else { break };
    file.write_all(&chunk).map_err(|e| e.to_string())?;
    have += chunk.len() as u64;
    on_bytes(have);
  }
  if have != size {
    return Err(format!("incomplete: {have}/{size} bytes"));
  }
  Ok(())
}

#[derive(serde::Serialize)]
pub struct ImportTools {
  whisper: bool,
  youtube: bool,
}

// What the add-video dialog needs to know before the user starts: whether the
// first import will download the transcription parts (for the model picked in
// Settings), and whether this Mac has the (hand-installed) YouTube downloader.
#[tauri::command]
pub fn import_tools(model: Option<String>, gpu: Option<bool>) -> ImportTools {
  let tier = model.as_deref().and_then(|m| Tier::parse(m).ok()).unwrap_or(Tier::Standard);
  let gpu = gpu.unwrap_or(false);
  // No YouTube on Windows: Chrome there encrypts cookies so yt-dlp cannot sign in.
  let youtube = !cfg!(windows) && crate::import::find_bin("yt-dlp").is_ok();
  ImportTools { whisper: find(tier, gpu).is_some(), youtube }
}

#[derive(serde::Serialize)]
pub struct TranscribeLocation {
  // Where we download parts to (may not exist yet).
  dir: String,
  // The model file actually in use for this tier, wherever it was found.
  model: Option<String>,
}

// Settings → Transcription: "show in Finder" for the model in use.
#[tauri::command]
pub fn transcribe_location(model: String) -> Result<TranscribeLocation, String> {
  let tier = Tier::parse(&model)?;
  Ok(TranscribeLocation {
    dir: parts_dir().to_string_lossy().into_owned(),
    model: find_model(tier).map(|p| p.to_string_lossy().into_owned()),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  // Real network, real HOME-independent folder: fetches the 1MB VAD model from
  // the first URL that works, resumes a partial file, and checks its sha256.
  // Run with: cargo test --manifest-path src-tauri/Cargo.toml -- --ignored fetch_vad
  #[test]
  #[ignore]
  fn fetch_vad_resumes_and_verifies() {
    let dir = std::env::temp_dir().join(format!("lc-setup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // A partial download left from an earlier attempt: the first 100KB, correct.
    let rt = tokio::runtime::Runtime::new().unwrap();
    let head = rt.block_on(async {
      let res = reqwest::Client::new().get(VAD.urls[0]).header("Range", "bytes=0-99999").send().await.unwrap();
      res.bytes().await.unwrap()
    });
    assert_eq!(head.len(), 100_000);
    std::fs::write(dir.join(format!("{}.part", VAD.name)), &head).unwrap();
    let mut first = None;
    rt.block_on(fetch(&VAD, &dir, |got| {
      first.get_or_insert(got);
    }))
    .unwrap();
    assert_eq!(first, Some(100_000), "should resume, not restart");
    assert_eq!(std::fs::metadata(dir.join(VAD.name)).unwrap().len(), VAD.size);
    assert!(!dir.join(format!("{}.part", VAD.name)).exists());
    std::fs::remove_dir_all(&dir).unwrap();
  }

  // Downloads this OS's whisper-cli (macOS: our Release asset, must be published;
  // Windows: whisper.cpp's zip, unpacked), checks its sha256 and runs it — on
  // macOS with a bare PATH, like a Mac without Homebrew.
  // Run with: cargo test --manifest-path src-tauri/Cargo.toml -- --ignored fetch_whisper
  #[test]
  #[ignore]
  fn fetch_whisper_cli_runs_standalone() {
    let dir = std::env::temp_dir().join(format!("lc-setup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(fetch(&WHISPER_CLI, &dir, |_| {})).unwrap();
    let mut cmd = std::process::Command::new(dir.join(WHISPER_EXE));
    #[cfg(unix)]
    cmd.env_clear().env("PATH", "/usr/bin:/bin");
    let out = cmd.arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage") || String::from_utf8_lossy(&out.stdout).contains("usage"));
    // The Vulkan build only downloads and unpacks here: the CI runner has no
    // Vulkan driver to start it (whisper-vulkan.yml runs it on lavapipe).
    #[cfg(windows)]
    {
      rt.block_on(fetch(&WHISPER_VULKAN, &dir, |_| {})).unwrap();
      assert!(dir.join(WHISPER_VULKAN_EXE).is_file());
    }
    std::fs::remove_dir_all(&dir).unwrap();
  }

  // The whole local chain on this OS, as an import runs it, for both model
  // sizes: parts (found or downloaded), audio out of a video, whisper with word
  // timings. On Windows CI nothing is installed, so this also downloads ~770MB.
  // Run with: cargo test --manifest-path src-tauri/Cargo.toml -- --ignored transcribes_speech
  #[test]
  #[ignore]
  fn transcribes_speech_end_to_end() {
    let dir = std::env::temp_dir().join(format!("lc-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let get = |found: Option<PathBuf>, asset: &Asset, installed: &str| {
      found.unwrap_or_else(|| {
        rt.block_on(fetch(asset, &dir, |_| {})).unwrap();
        dir.join(installed)
      })
    };
    let whisper = get(find_whisper(), &WHISPER_CLI, WHISPER_EXE);
    let vad = get(find_vad(), &VAD, VAD.name);
    let video = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/speech.m4v");
    let wav = dir.join("speech.wav");
    crate::import::extract_wav(&video, &wav).unwrap();
    for tier in [Tier::Standard, Tier::Light] {
      let model = get(find_model(tier), tier.asset(), tier.asset().name);
      let stem = dir.join(format!("speech-{tier:?}"));
      crate::import::transcribe(|_| {}, &whisper, &model, &vad, tier.dtw(), "en", &wav, &stem).unwrap();
      let srt = std::fs::read_to_string(stem.with_extension("srt")).unwrap().to_lowercase();
      assert!(srt.contains("quick brown fox"), "{tier:?}: {srt}");
      let words = crate::import::read_words(&stem.with_extension("json")).unwrap();
      assert!(words.len() >= 10, "{tier:?}: {} words", words.len());
      eprintln!("{tier:?}: {}", words.iter().map(|w| format!("{}@{}", w.w, w.from)).collect::<Vec<_>>().join(" "));
    }
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
