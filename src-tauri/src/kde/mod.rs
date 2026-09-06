use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::geometry::{
  calculate_popover_bounds, responsive_popover_size, Rect, Size, DEFAULT_HEIGHT, DEFAULT_WIDTH,
};
use crate::host::{self, Host};
use crate::ui_server;

struct AppState {
  host: Host,
  latest_tray: Mutex<Option<Rect>>,
  latest_size: Mutex<Size>,
  popover_visible: Mutex<bool>,
  rt: tokio::runtime::Handle,
}

#[repr(C)]
struct HatchKdeCallbacks {
  on_toggle: Option<extern "C" fn(f64, f64, f64, f64, *mut c_void)>,
  on_quit: Option<extern "C" fn(*mut c_void)>,
  on_blur: Option<extern "C" fn(*mut c_void)>,
}

unsafe extern "C" {
  fn hatch_kde_main(
    icon_on_dark: *const c_char,
    icon_on_light: *const c_char,
    ui_url: *const c_char,
    callbacks: HatchKdeCallbacks,
    user: *mut c_void,
  ) -> i32;
  fn hatch_kde_show(x: f64, y: f64, w: f64, h: f64);
  fn hatch_kde_hide();
  fn hatch_kde_set_bounds(x: f64, y: f64, w: f64, h: f64);
  fn hatch_kde_eval(javascript: *const c_char);
  fn hatch_kde_quit();
  fn hatch_kde_open_url(url: *const c_char);
  fn hatch_kde_work_area(x: f64, y: f64, out_x: *mut f64, out_y: *mut f64, out_w: *mut f64, out_h: *mut f64);
  fn hatch_kde_set_autostart(enable: i32, exec_path: *const c_char, icon_name: *const c_char);
}

fn keep_popover_open() -> bool {
  matches!(std::env::var("HATCH_KEEP_POPOVER_OPEN").as_deref(), Ok("1"))
}

fn repo_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn dirs_home() -> PathBuf {
  std::env::var("HOME")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn packaged_state_home() -> PathBuf {
  dirs_home().join(".hatch")
}

fn widget_cache_dir(packaged: bool, host_root: &Path) -> PathBuf {
  if packaged {
    packaged_state_home().join("cache/widgets")
  } else {
    host_root.join(".cache/hatch/widgets")
  }
}

fn has_renderer(root: &Path) -> bool {
  root.join("renderer/index.html").is_file() || root.join("out/renderer/index.html").is_file()
}

fn resolve_linux_resource_root(
  packaged: bool,
  env_dir: Option<&Path>,
  exe_dir: Option<&Path>,
  home: Option<&Path>,
  repo: &Path,
) -> PathBuf {
  let mut candidates = Vec::new();
  if let Some(dir) = env_dir {
    candidates.push(dir.to_path_buf());
  }
  if packaged {
    if let Some(parent) = exe_dir {
      candidates.push(parent.join("../share/hatch"));
    }
    if let Some(home) = home {
      candidates.push(home.join(".local/share/hatch"));
    }
    candidates.push(PathBuf::from("/usr/share/hatch"));
  }
  candidates.push(repo.join("src-tauri/resources"));
  candidates.push(repo.to_path_buf());

  for candidate in &candidates {
    if has_renderer(candidate) {
      return candidate.canonicalize().unwrap_or_else(|_| candidate.clone());
    }
  }
  candidates
    .into_iter()
    .find(|path| path.exists())
    .unwrap_or_else(|| repo.to_path_buf())
}

fn resource_root(packaged: bool) -> PathBuf {
  resolve_linux_resource_root(
    packaged,
    std::env::var_os("HATCH_RESOURCE_DIR").as_deref().map(Path::new),
    std::env::current_exe()
      .ok()
      .as_deref()
      .and_then(Path::parent)
      .map(Path::to_path_buf)
      .as_deref(),
    std::env::var_os("HOME").as_deref().map(Path::new),
    &repo_root(),
  )
}

fn renderer_root(resources: &Path) -> PathBuf {
  let nested = resources.join("renderer");
  if nested.join("index.html").is_file() {
    return nested;
  }
  let checkout = resources.join("out/renderer");
  if checkout.join("index.html").is_file() {
    return checkout;
  }
  nested
}

fn c_string(value: &str) -> CString {
  CString::new(value).unwrap_or_else(|_| CString::new("").expect("empty cstring"))
}

fn emit_renderer_event(channel: &str, payload: Value) {
  let detail = json!({ "channel": channel, "payload": payload });
  let script = format!(
    "try{{window.dispatchEvent(new CustomEvent('hatch-host-event',{{detail:{detail}}}));}}catch(_e){{}}"
  );
  let encoded = c_string(&script);
  unsafe { hatch_kde_eval(encoded.as_ptr()) };
}

fn current_work_area(tray: Rect) -> Rect {
  let mut x = 0.0;
  let mut y = 0.0;
  let mut width = 1440.0;
  let mut height = 900.0;
  unsafe {
    hatch_kde_work_area(tray.x, tray.y, &mut x, &mut y, &mut width, &mut height);
  }
  Rect { x, y, width, height }
}

fn apply_popover_bounds(tray: Rect, size: Size) {
  let bounds = calculate_popover_bounds(tray, current_work_area(tray), size);
  unsafe { hatch_kde_set_bounds(bounds.x, bounds.y, bounds.width, bounds.height) };
}

fn show_popover(state: &AppState, tray: Rect) {
  let size = *state.latest_size.lock().unwrap();
  *state.latest_tray.lock().unwrap() = Some(tray);
  let bounds = calculate_popover_bounds(tray, current_work_area(tray), size);
  unsafe { hatch_kde_show(bounds.x, bounds.y, bounds.width, bounds.height) };
  *state.popover_visible.lock().unwrap() = true;
  emit_renderer_event("hatch:popover:visibility", json!({ "visible": true }));
  let _ = state.host.invoke("hatch:internal:popover-open", &[]);
}

fn hide_popover(state: &AppState) {
  unsafe { hatch_kde_hide() };
  *state.popover_visible.lock().unwrap() = false;
  emit_renderer_event("hatch:popover:visibility", json!({ "visible": false }));
}

fn toggle_popover(state: &AppState, tray: Rect) {
  if *state.popover_visible.lock().unwrap() {
    hide_popover(state);
  } else {
    show_popover(state, tray);
  }
}

fn apply_autostart(open: bool) {
  let exec = std::env::current_exe()
    .ok()
    .and_then(|path| path.into_os_string().into_string().ok())
    .unwrap_or_else(|| "hatch".to_string());
  let exec = c_string(&exec);
  let icon = c_string("hatch");
  unsafe { hatch_kde_set_autostart(if open { 1 } else { 0 }, exec.as_ptr(), icon.as_ptr()) };
}

fn dispatch(state: &AppState, channel: String, args: Vec<Value>) -> Result<Value, String> {
  if channel == "hatch:app:quit" {
    unsafe { hatch_kde_quit() };
    return Ok(json!({ "ok": true }));
  }
  if channel == "hatch:popover:get-visibility" {
    return Ok(json!({ "visible": *state.popover_visible.lock().unwrap() }));
  }
  if channel == "hatch:popover:set-content-size" || channel == "hatch:popover:set-content-height" {
    let mut size = *state.latest_size.lock().unwrap();
    if channel == "hatch:popover:set-content-height" {
      size.height = args.first().and_then(Value::as_f64).unwrap_or(size.height);
    } else if let Some(object) = args.first() {
      size.width = object.get("width").and_then(Value::as_f64).unwrap_or(size.width);
      size.height = object.get("height").and_then(Value::as_f64).unwrap_or(size.height);
    }
    let tray = *state.latest_tray.lock().unwrap();
    let work_area = tray.map(current_work_area);
    size = responsive_popover_size(size, work_area);
    *state.latest_size.lock().unwrap() = size;
    if let Some(tray) = tray {
      apply_popover_bounds(tray, size);
    }
    return Ok(json!({ "ok": true }));
  }

  let host = state.host.clone();
  let result = host.invoke_emit(&channel, &args, &|event_channel, payload| {
    emit_renderer_event(event_channel, payload);
  })?;
  if channel == "hatch:settings:set-open-at-login" {
    if let Some(open) = result.get("openAtLogin").and_then(Value::as_bool) {
      apply_autostart(open);
    }
  }
  if channel == "hatch:app:open-release-page" {
    if let Some(url) = result.get("url").and_then(Value::as_str) {
      let encoded = c_string(url);
      unsafe { hatch_kde_open_url(encoded.as_ptr()) };
    }
  }
  Ok(result)
}

extern "C" fn on_toggle(x: f64, y: f64, w: f64, h: f64, user: *mut c_void) {
  let app = unsafe { &*(user as *const AppState) };
  toggle_popover(
    app,
    Rect {
      x,
      y,
      width: w,
      height: h,
    },
  );
}

extern "C" fn on_quit(_user: *mut c_void) {
  unsafe { hatch_kde_quit() };
}

extern "C" fn on_blur(user: *mut c_void) {
  if keep_popover_open() {
    return;
  }
  let app = unsafe { &*(user as *const AppState) };
  hide_popover(app);
}

pub fn run() {
  let runtime = tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .thread_name("hatch")
    .build()
    .expect("tokio runtime");
  let handle = runtime.handle().clone();
  std::thread::Builder::new()
    .name("hatch-tokio".into())
    .spawn(move || {
      runtime.block_on(std::future::pending::<()>());
    })
    .expect("tokio thread");

  let packaged = !cfg!(debug_assertions);
  let resources = resource_root(packaged);
  let host_root = if packaged {
    packaged_state_home()
  } else {
    repo_root()
  };
  let cache_dir = widget_cache_dir(packaged, &host_root);
  let ui_root = if packaged {
    renderer_root(&resources)
  } else {
    repo_root().join("out/renderer")
  };
  if !ui_root.join("index.html").is_file() {
    eprintln!(
      "hatch: UI not found at {} (install renderer into ~/.local/share/hatch/renderer)",
      ui_root.display()
    );
  }
  let template_dir = if packaged {
    Some(resources.join("extensions-template"))
  } else {
    None
  };
  let adapter_dir = if packaged {
    Some(resources.join("adapters"))
  } else {
    Some(repo_root().join("out/adapters"))
  };
  let native_host = host::Host::start(host::HostOptions {
    root: host_root.clone(),
    packaged,
    extensions_dir: Some(if packaged {
      host_root.join("extensions")
    } else {
      repo_root().join("extensions")
    }),
    recipes_dir: None,
    widget_cache_dir: cache_dir.clone(),
    database_path: host_root.join("hatch.db"),
    template_dir,
    adapter_dir,
  })
  .expect("hatch host failed to start");

  let state = Arc::new(AppState {
    host: native_host,
    latest_tray: Mutex::new(None),
    latest_size: Mutex::new(Size {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    }),
    popover_visible: Mutex::new(false),
    rt: handle.clone(),
  });

  let rpc_state = state.clone();
  let rpc: ui_server::RpcHandler = Arc::new(move |channel, args| {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let rpc_state = rpc_state.clone();
    let handle = rpc_state.rt.clone();
    handle.spawn(async move {
      let result = dispatch(&rpc_state, channel, args);
      let _ = tx.send(result);
    });
    rx
  });

  let (ui_port, _ui_server) = handle
    .block_on(ui_server::bind_ui_server(ui_server::UiServerConfig {
      ui_root,
      widget_cache_dir: cache_dir,
      rpc,
      bind: if cfg!(debug_assertions) {
        Some("127.0.0.1:5280".to_string())
      } else {
        None
      },
    }))
    .expect("hatch ui server failed to bind");

  let ui_url = if cfg!(debug_assertions) {
    "http://127.0.0.1:5273/".to_string()
  } else {
    format!("http://127.0.0.1:{ui_port}/index.html")
  };

  let assets_dir = if resources.join("tray").is_dir() {
    resources.clone()
  } else {
    repo_root().join("assets")
  };
  let icon_dark = c_string(&crate::tray::hatch_tray_icon_on_dark(&assets_dir).to_string_lossy());
  let icon_light = c_string(&crate::tray::hatch_tray_icon_on_light(&assets_dir).to_string_lossy());
  let url = c_string(&ui_url);
  let leaked = Arc::into_raw(state);

  let status = unsafe {
    hatch_kde_main(
      icon_dark.as_ptr(),
      icon_light.as_ptr(),
      url.as_ptr(),
      HatchKdeCallbacks {
        on_toggle: Some(on_toggle),
        on_quit: Some(on_quit),
        on_blur: Some(on_blur),
      },
      leaked as *mut c_void,
    )
  };
  if status != 0 {
    eprintln!("hatch kde shell exited with status {status}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn packaged_install_uses_checkout_renderer_when_share_dirs_are_missing() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let root = resolve_linux_resource_root(true, None, None, None, &repo);
    let ui = renderer_root(&root);
    assert!(
      ui.join("index.html").is_file(),
      "expected a renderer at {}, got root {root:?}",
      ui.display()
    );
  }

  #[test]
  fn prefers_user_share_when_it_contains_the_renderer() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let home = repo.join("src-tauri/target/hatch-resource-test-home");
    let share = home.join(".local/share/hatch/renderer");
    std::fs::create_dir_all(&share).unwrap();
    std::fs::write(share.join("index.html"), "<html></html>").unwrap();
    let root = resolve_linux_resource_root(true, None, None, Some(&home), &repo);
    let index = renderer_root(&root).join("index.html");
    assert!(index.is_file());
    assert_eq!(std::fs::canonicalize(&index).unwrap(), std::fs::canonicalize(share.join("index.html")).unwrap());
    std::fs::remove_dir_all(home).ok();
  }
}
