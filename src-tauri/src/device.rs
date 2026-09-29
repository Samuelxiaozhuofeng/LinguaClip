// A stable id for this computer (for license activation): a hash of the hardware
// UUID, so a reinstall gives the same id and doesn't take a second seat.
// Never falls back to a random id — that would eat a seat on every reinstall.
use crate::paths;
use sha2::{Digest, Sha256};

#[derive(serde::Serialize)]
pub struct DeviceInfo {
  id: String,
  name: String,
}

#[tauri::command]
pub fn device_info() -> Result<DeviceInfo, String> {
  let uuid = hardware_uuid().ok_or("no hardware id")?;
  let hash = Sha256::digest(format!("linguaclip-device:{uuid}"));
  let id: String = hash.iter().map(|b| format!("{b:02x}")).collect::<String>()[..32].to_string();
  Ok(DeviceInfo { id, name: computer_name() })
}

fn run(program: &str, args: &[&str]) -> Option<String> {
  let out = paths::command(program).args(args).output().ok()?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(windows))]
fn hardware_uuid() -> Option<String> {
  parse_ioreg(&run("/usr/sbin/ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?)
}

#[cfg(windows)]
fn hardware_uuid() -> Option<String> {
  parse_reg(&run("reg", &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])?)
}

#[cfg(not(windows))]
fn computer_name() -> String {
  run("/usr/sbin/scutil", &["--get", "ComputerName"])
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "Mac".into())
}

#[cfg(windows)]
fn computer_name() -> String {
  std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "Windows PC".into())
}

// `"IOPlatformUUID" = "564D1234-…"`
#[allow(dead_code)]
fn parse_ioreg(out: &str) -> Option<String> {
  let line = out.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
  let v = line.rsplit('"').nth(1)?.trim();
  (v.len() >= 8).then(|| v.to_string())
}

// `    MachineGuid    REG_SZ    1b2c…`
#[allow(dead_code)]
fn parse_reg(out: &str) -> Option<String> {
  let line = out.lines().find(|l| l.contains("MachineGuid"))?;
  let v = line.split_whitespace().last()?;
  (v.len() >= 8 && v != "REG_SZ").then(|| v.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_ioreg() {
    let out = "+-o J314sAP  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"ABC\"\n      \"IOPlatformUUID\" = \"564D1234-AAAA-BBBB-CCCC-1234567890AB\"\n    }\n";
    assert_eq!(parse_ioreg(out).as_deref(), Some("564D1234-AAAA-BBBB-CCCC-1234567890AB"));
    assert_eq!(parse_ioreg("nothing here"), None);
  }

  #[test]
  fn reads_reg() {
    let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901\r\n\r\n";
    assert_eq!(parse_reg(out).as_deref(), Some("1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901"));
    assert_eq!(parse_reg("MachineGuid REG_SZ"), None);
  }

  #[test]
  fn same_machine_same_id() {
    let a = device_info().unwrap();
    let b = device_info().unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(a.id.len(), 32);
  }
}
