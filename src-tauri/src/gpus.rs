// Which graphics card the Vulkan whisper-cli runs on (Windows). whisper.cpp takes
// the first card Vulkan reports, on many laptops the integrated one; we list the
// cards ourselves and show whisper only the picked one via GGML_VK_VISIBLE_DEVICES.
// See docs/import.md「选哪块显卡」.
use serde::Serialize;
use std::sync::Mutex;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Gpu {
  pub name: String,
  pub discrete: bool,
  // Position in Vulkan's own list, what GGML_VK_VISIBLE_DEVICES counts.
  #[serde(skip)]
  index: usize,
}

// Card name from Settings; empty = automatic. Set by every start_import.
// ponytail: one value per process, the setting is global anyway.
static CHOICE: Mutex<String> = Mutex::new(String::new());

pub fn set_choice(name: Option<String>) {
  *CHOICE.lock().unwrap_or_else(|e| e.into_inner()) = name.unwrap_or_default();
}

// The named card while it is there, else the first discrete one, else the first integrated.
fn pick(gpus: &[Gpu], choice: &str) -> Option<usize> {
  gpus
    .iter()
    .find(|g| !choice.is_empty() && g.name == choice)
    .or_else(|| gpus.iter().find(|g| g.discrete))
    .or_else(|| gpus.first())
    .map(|g| g.index)
}

// GGML_VK_VISIBLE_DEVICES for this run; None (cards unreadable) leaves whisper to its default.
pub fn visible_device() -> Option<String> {
  let choice = CHOICE.lock().unwrap_or_else(|e| e.into_inner()).clone();
  let gpus = list().inspect_err(|e| log::error!("list gpus: {e}")).ok()?;
  pick(&gpus, &choice).map(|i| i.to_string())
}

#[tauri::command]
pub fn list_gpus() -> Vec<Gpu> {
  list().inspect_err(|e| log::error!("list gpus: {e}")).unwrap_or_default()
}

#[cfg(not(windows))]
fn list() -> Result<Vec<Gpu>, String> {
  Ok(Vec::new())
}

// Asks the system Vulkan loader, the same one whisper-cli uses, so the order matches.
#[cfg(windows)]
fn list() -> Result<Vec<Gpu>, String> {
  use std::ffi::c_void;
  use std::ptr::{null, null_mut};
  type Handle = *mut c_void;
  #[repr(C)]
  struct InstanceInfo {
    s_type: i32,
    p_next: *const c_void,
    flags: u32,
    app: *const c_void,
    layers: u32,
    layer_names: *const c_void,
    exts: u32,
    ext_names: *const c_void,
  }
  type Create = unsafe extern "system" fn(*const InstanceInfo, *const c_void, *mut Handle) -> i32;
  type Destroy = unsafe extern "system" fn(Handle, *const c_void);
  type Enumerate = unsafe extern "system" fn(Handle, *mut u32, *mut Handle) -> i32;
  type Props = unsafe extern "system" fn(Handle, *mut u8);

  let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
  let dll = std::path::Path::new(&root).join(r"System32\vulkan-1.dll");
  unsafe {
    let lib = libloading::Library::new(&dll).map_err(|e| e.to_string())?;
    let create: libloading::Symbol<Create> = lib.get(b"vkCreateInstance\0").map_err(|e| e.to_string())?;
    let destroy: libloading::Symbol<Destroy> = lib.get(b"vkDestroyInstance\0").map_err(|e| e.to_string())?;
    let enumerate: libloading::Symbol<Enumerate> = lib.get(b"vkEnumeratePhysicalDevices\0").map_err(|e| e.to_string())?;
    let props: libloading::Symbol<Props> = lib.get(b"vkGetPhysicalDeviceProperties\0").map_err(|e| e.to_string())?;

    // VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO = 1; no app info, layers or extensions.
    let info = InstanceInfo { s_type: 1, p_next: null(), flags: 0, app: null(), layers: 0, layer_names: null(), exts: 0, ext_names: null() };
    let mut instance: Handle = null_mut();
    let r = create(&info, null(), &mut instance);
    if r != 0 {
      return Err(format!("vkCreateInstance {r}"));
    }
    let mut n = 0u32;
    enumerate(instance, &mut n, null_mut());
    let mut devices: Vec<Handle> = vec![null_mut(); n as usize];
    let r = enumerate(instance, &mut n, devices.as_mut_ptr());
    devices.truncate(n as usize);
    let mut out = Vec::new();
    if r >= 0 {
      for (index, &device) in devices.iter().enumerate() {
        // VkPhysicalDeviceProperties is 824 bytes: deviceType (i32) at 16, deviceName (char[256]) at 20.
        let mut buf = [0u64; 128];
        props(device, buf.as_mut_ptr() as *mut u8);
        let bytes = std::slice::from_raw_parts(buf.as_ptr() as *const u8, 1024);
        let kind = i32::from_ne_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let name = &bytes[20..276];
        let name = String::from_utf8_lossy(&name[..name.iter().position(|&b| b == 0).unwrap_or(256)]).into_owned();
        // 1 = integrated, 2 = discrete; virtual and CPU (lavapipe) ones are left out, as whisper does.
        if kind == 1 || kind == 2 {
          out.push(Gpu { name, discrete: kind == 2, index });
        }
      }
    }
    destroy(instance, null());
    if r < 0 {
      return Err(format!("vkEnumeratePhysicalDevices {r}"));
    }
    Ok(out)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn gpu(name: &str, discrete: bool, index: usize) -> Gpu {
    Gpu { name: name.into(), discrete, index }
  }

  #[test]
  fn picks_named_then_discrete_then_first() {
    let both = [gpu("Intel UHD", false, 0), gpu("NVIDIA RTX", true, 1)];
    assert_eq!(pick(&both, ""), Some(1));
    assert_eq!(pick(&both, "Intel UHD"), Some(0));
    assert_eq!(pick(&both, "Gone card"), Some(1));
    // Indexes stay Vulkan's own even with a skipped CPU device in front.
    assert_eq!(pick(&[gpu("Intel UHD", false, 1)], ""), Some(1));
    assert_eq!(pick(&[], "x"), None);
  }

  // Runs on the Windows CI: listing must not crash, whatever the machine has.
  #[test]
  fn lists_without_crashing() {
    let _ = list();
  }
}
