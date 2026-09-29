mod anki;
mod bailian;
mod cache;
mod clips;
mod cloud_asr;
mod convert;
#[cfg(test)]
mod cloud_live_tests;
mod decode;
mod device;
mod groq;
mod import;
mod ja_dict;
mod paths;
mod tts;
mod whisper_setup;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      import::start_import,
      import::open_youtube_login,
      import::probe_import_sizes,
      anki::anki_request,
      cache::write_cache,
      tts::tts,
      whisper_setup::import_tools,
      whisper_setup::transcribe_location,
      ja_dict::ja_dict_status,
      ja_dict::install_ja_dict,
      ja_dict::remove_ja_dict,
      convert::convert_tool_status,
      convert::install_convert_tool,
      convert::probe_video,
      clips::cut_clip,
      clips::sweep_clips,
      clips::clips_info,
      device::device_info,
      trash_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// Move a file to the Trash / Recycle Bin (recoverable), with the system's own tool.
#[tauri::command]
fn trash_file(path: String) -> Result<(), String> {
  if !std::path::Path::new(&path).is_file() {
    return Err("not a file".into());
  }
  #[cfg(not(windows))]
  let out = paths::command("/usr/bin/trash").arg(&path).output();
  // The path travels in an env var, never spliced into the script. USB sticks and
  // network shares have no Recycle Bin: there DeleteFile would delete for good,
  // so only a local fixed drive goes ahead (a network path throws, which fails too).
  #[cfg(windows)]
  let out = paths::command("powershell")
    .args([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$d = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:LC_TRASH_PATH)); if ($d.DriveType -ne 'Fixed') { [Console]::Error.Write('no recycle bin on this drive'); exit 3 }; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:LC_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    ])
    .env("LC_TRASH_PATH", &path)
    .output();
  let out = out.map_err(|e| e.to_string())?;
  if out.status.success() {
    Ok(())
  } else {
    Err(String::from_utf8_lossy(&out.stderr).into_owned())
  }
}
