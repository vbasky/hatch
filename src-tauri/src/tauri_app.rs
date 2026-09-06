use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::geometry::{
  calculate_popover_bounds, responsive_popover_size, to_logical, Rect, Size, DEFAULT_HEIGHT, DEFAULT_WIDTH,
};
use crate::host;
use crate::protocol;
use crate::tray::hatch_tray_icon_path;
use crate::ui_server;
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;

struct AppState {
  host: host::Host,
  latest_tray: Mutex<Option<Rect>>,
  latest_size: Mutex<Size>,
  popover_visible: Mutex<bool>,
  widget_cache_dir: PathBuf,
  ui_root: PathBuf,
  _ui_server: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

fn keep_popover_open() -> bool {
  matches!(std::env::var("HATCH_KEEP_POPOVER_OPEN").as_deref(), Ok("1"))
}

fn open_on_start() -> bool {
  matches!(std::env::var("HATCH_OPEN_POPOVER_ON_START").as_deref(), Ok("1"))
}

fn repo_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
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

fn dirs_home() -> PathBuf {
  std::env::var("HOME")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn node_and_host(app: &AppHandle, packaged: bool) -> Result<(PathBuf, PathBuf, PathBuf, Option<PathBuf>), String> {
  let host_root = if packaged {
    packaged_state_home()
  } else {
    repo_root()
  };
  if packaged {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let node = exe.parent().ok_or("no exe dir")?.join("node");
    let host_js = resource_dir.join("host/index.js");
    Ok((node, host_js, host_root, Some(resource_dir)))
  } else {
    Ok((
      PathBuf::from("node"),
      repo_root().join("out/host/index.js"),
      host_root,
      None,
    ))
  }
}

fn set_key_window_active(app: &AppHandle, active: bool) {
  #[cfg(target_os = "macos")]
  {
    let _ = app.set_activation_policy(if active {
      tauri::ActivationPolicy::Regular
    } else {
      tauri::ActivationPolicy::Accessory
    });
    if active {
      let _ = app.show();
    }
  }
}

fn scale_at_physical(app: &AppHandle, x: f64, y: f64) -> f64 {
  let Some(window) = app.get_webview_window("popover") else {
    return 1.0;
  };
  if let Ok(Some(monitor)) = window.monitor_from_point(x, y) {
    return monitor.scale_factor();
  }
  window.scale_factor().unwrap_or(1.0)
}

fn tray_rect_logical(app: &AppHandle, rect: tauri::Rect) -> Rect {
  match (rect.position, rect.size) {
    (tauri::Position::Physical(position), tauri::Size::Physical(size)) => {
      let physical = Rect {
        x: position.x as f64,
        y: position.y as f64,
        width: size.width as f64,
        height: size.height as f64,
      };
      to_logical(physical, scale_at_physical(app, physical.x, physical.y))
    }
    (tauri::Position::Logical(position), tauri::Size::Logical(size)) => Rect {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    },
    (tauri::Position::Physical(position), tauri::Size::Logical(size)) => {
      let scale = scale_at_physical(app, position.x as f64, position.y as f64);
      Rect {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width,
        height: size.height,
      }
    }
    (tauri::Position::Logical(position), tauri::Size::Physical(size)) => {
      let scale = scale_at_physical(app, position.x, position.y);
      Rect {
        x: position.x,
        y: position.y,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
      }
    }
  }
}

fn current_work_area(app: &AppHandle, tray: Rect) -> Rect {
  let Some(window) = app.get_webview_window("popover") else {
    return Rect {
      x: 0.0,
      y: 0.0,
      width: 1440.0,
      height: 900.0,
    };
  };
  let scale = window.scale_factor().unwrap_or(1.0);
  if let Ok(Some(monitor)) = window.monitor_from_point(tray.x * scale, tray.y * scale) {
    let area = monitor.work_area();
    return to_logical(
      Rect {
        x: area.position.x as f64,
        y: area.position.y as f64,
        width: area.size.width as f64,
        height: area.size.height as f64,
      },
      monitor.scale_factor(),
    );
  }
  Rect {
    x: 0.0,
    y: 0.0,
    width: 1440.0,
    height: 900.0,
  }
}

fn emit_renderer_event(app: &AppHandle, channel: &str, payload: Value) {
  let _ = app.emit(channel, payload.clone());
  if let Some(window) = app.get_webview_window("popover") {
    let detail = json!({ "channel": channel, "payload": payload });
    let script = format!(
      "try{{window.dispatchEvent(new CustomEvent('hatch-host-event',{{detail:{detail}}}));}}catch(_e){{}}"
    );
    let _ = window.eval(&script);
  }
}

fn apply_popover_bounds(app: &AppHandle, tray: Rect, size: Size) {
  let work_area = current_work_area(app, tray);
  let bounds = calculate_popover_bounds(tray, work_area, size);
  if let Some(window) = app.get_webview_window("popover") {
    let _ = window.set_shadow(false);
    let _ = window.set_position(LogicalPosition::new(bounds.x, bounds.y));
    let _ = window.set_size(LogicalSize::new(bounds.width, bounds.height));
  }
}

async fn toggle_popover(app: &AppHandle, tray: Rect) {
  let Some(window) = app.get_webview_window("popover") else {
    return;
  };
  let visible = window.is_visible().unwrap_or(false);
  if visible {
    let _ = window.hide();
    set_key_window_active(app, false);
    emit_renderer_event(app, "hatch:popover:visibility", json!({ "visible": false }));
    if let Some(state) = app.try_state::<AppState>() {
      *state.popover_visible.lock().unwrap() = false;
    }
    return;
  }
  let size = app
    .try_state::<AppState>()
    .map(|state| *state.latest_size.lock().unwrap())
    .unwrap_or(Size {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    });
  if let Some(state) = app.try_state::<AppState>() {
    *state.latest_tray.lock().unwrap() = Some(tray);
  }
  apply_popover_bounds(app, tray, size);
  set_key_window_active(app, true);
  let _ = window.show();
  let _ = window.set_focus();
  emit_renderer_event(app, "hatch:popover:visibility", json!({ "visible": true }));
  if let Some(state) = app.try_state::<AppState>() {
    *state.popover_visible.lock().unwrap() = true;
    let _ = state.host.invoke("hatch:internal:popover-open", &[]);
  }
}

/// Toggle the popover anchored at the current cursor position.
///
/// On Linux the tray icon exposes no screen rect, so the popover is placed
/// relative to the mouse cursor (clamped to the work area) instead.
#[cfg(not(target_os = "macos"))]
async fn toggle_at_cursor(app: &AppHandle) {
  let Some(window) = app.get_webview_window("popover") else {
    return;
  };
  let cursor = window.cursor_position().ok();
  let tray = cursor
    .map(|position| {
      let scale = window.scale_factor().unwrap_or(1.0);
      Rect {
        x: position.x / scale - 11.0,
        y: position.y / scale - 11.0,
        width: 22.0,
        height: 22.0,
      }
    })
    .unwrap_or(Rect {
      x: 0.0,
      y: 0.0,
      width: 22.0,
      height: 22.0,
    });
  toggle_popover(app, tray).await;
}

fn respond_protocol(body: Vec<u8>, content_type: &str) -> tauri::http::Response<Vec<u8>> {
  tauri::http::Response::builder()
    .header("content-type", content_type)
    .header("access-control-allow-origin", "*")
    .body(body)
    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[tauri::command]
async fn host_invoke(app: AppHandle, channel: String, args: Option<Vec<Value>>) -> Result<Value, String> {
  dispatch_host_invoke(&app, channel, args.unwrap_or_default()).await
}

pub(crate) async fn dispatch_host_invoke(app: &AppHandle, channel: String, args: Vec<Value>) -> Result<Value, String> {
  if channel == "hatch:app:quit" {
    app.exit(0);
    return Ok(json!({ "ok": true }));
  }
  if channel == "hatch:popover:get-visibility" {
    let visible = app
      .get_webview_window("popover")
      .and_then(|window| window.is_visible().ok())
      .unwrap_or(false);
    return Ok(json!({ "visible": visible }));
  }
  if channel == "hatch:popover:set-content-size" || channel == "hatch:popover:set-content-height" {
    let state = app.state::<AppState>();
    let mut size = *state.latest_size.lock().unwrap();
    if channel == "hatch:popover:set-content-height" {
      size.height = args.first().and_then(Value::as_f64).unwrap_or(size.height);
    } else if let Some(object) = args.first() {
      size.width = object.get("width").and_then(Value::as_f64).unwrap_or(size.width);
      size.height = object.get("height").and_then(Value::as_f64).unwrap_or(size.height);
    }
    let tray = *state.latest_tray.lock().unwrap();
    let work_area = tray.map(|tray| current_work_area(&app, tray));
    size = responsive_popover_size(size, work_area);
    *state.latest_size.lock().unwrap() = size;
    if let Some(tray) = tray {
      apply_popover_bounds(&app, tray, size);
    }
    return Ok(json!({ "ok": true }));
  }

  let state = app.state::<AppState>();
  let host = state.host.clone();
  let invoke_channel = channel.clone();
  let invoke_args = args.clone();
  let app_handle = app.clone();
  let result = tokio::task::spawn_blocking(move || {
    host.invoke_emit(&invoke_channel, &invoke_args, &|channel, payload| {
      emit_renderer_event(&app_handle, channel, payload);
    })
  })
  .await
  .map_err(|error| error.to_string())??;
  if channel == "hatch:settings:set-open-at-login" {
    if let Some(open) = result.get("openAtLogin").and_then(Value::as_bool) {
      apply_autostart(&app, open);
    }
  }
  if channel == "hatch:app:open-release-page" {
    if let Some(url) = result.get("url").and_then(Value::as_str) {
      use tauri_plugin_opener::OpenerExt;
      let _ = app.opener().open_url(url, None::<&str>);
    }
  }
  Ok(result)
}

fn apply_autostart(app: &AppHandle, open: bool) {
  use tauri_plugin_autostart::ManagerExt;
  let autostart = app.autolaunch();
  if open {
    let _ = autostart.enable();
  } else {
    let _ = autostart.disable();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_positioner::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))
    .invoke_handler(tauri::generate_handler![host_invoke])
    .register_asynchronous_uri_scheme_protocol("hatch-widget", |ctx, request, responder| {
      let cache = ctx
        .app_handle()
        .try_state::<AppState>()
        .map(|state| state.widget_cache_dir.clone())
        .unwrap_or_else(|| widget_cache_dir(false, &repo_root()));
      let url = request.uri().to_string();
      match protocol::resolve_widget_protocol_file_path(&cache, &url) {
        Ok(path) => match fs::read(&path) {
          Ok(bytes) => responder.respond(respond_protocol(bytes, protocol::content_type_for(&path))),
          Err(_) => responder.respond(tauri::http::Response::builder().status(404).body(Vec::new()).unwrap()),
        },
        Err(_) => responder.respond(tauri::http::Response::builder().status(400).body(Vec::new()).unwrap()),
      }
    })
    .register_asynchronous_uri_scheme_protocol("hatch-host", |_ctx, request, responder| {
      let url = request.uri().to_string();
      match protocol::host_protocol_module_source(&url) {
        Ok(source) => responder.respond(respond_protocol(source.into_bytes(), "text/javascript; charset=utf-8")),
        Err(_) => responder.respond(tauri::http::Response::builder().status(404).body(Vec::new()).unwrap()),
      }
    })
    .register_asynchronous_uri_scheme_protocol("hatch-ui", |ctx, request, responder| {
      let root = ctx
        .app_handle()
        .try_state::<AppState>()
        .map(|state| state.ui_root.clone())
        .unwrap_or_else(|| repo_root().join("out/renderer"));
      let url = request.uri().to_string();
      match protocol::resolve_ui_file_path(&root, &url) {
        Ok(path) => match fs::read(&path) {
          Ok(bytes) => responder.respond(respond_protocol(bytes, protocol::content_type_for(&path))),
          Err(_) => responder.respond(tauri::http::Response::builder().status(404).body(Vec::new()).unwrap()),
        },
        Err(_) => responder.respond(tauri::http::Response::builder().status(400).body(Vec::new()).unwrap()),
      }
    })
    .setup(|app| {
      #[cfg(target_os = "macos")]
      app.set_activation_policy(tauri::ActivationPolicy::Accessory);

      let packaged = !cfg!(debug_assertions);
      let (_node, _host_js, host_root, resources) = node_and_host(app.handle(), packaged)?;
      let cache_dir = widget_cache_dir(packaged, &host_root);
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
        template_dir: resources.as_ref().map(|dir| dir.join("extensions-template")),
        adapter_dir: resources.as_ref().map(|dir| dir.join("adapters")),
      })
      .map_err(|error| Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>)?;

      let ui_root = if packaged {
        app
          .path()
          .resource_dir()
          .unwrap_or_else(|_| repo_root().join("out/renderer"))
      } else {
        repo_root().join("out/renderer")
      };
      app.manage(AppState {
        host: native_host,
        latest_tray: Mutex::new(None),
        latest_size: Mutex::new(Size {
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
        }),
        popover_visible: Mutex::new(false),
        widget_cache_dir: cache_dir.clone(),
        ui_root: ui_root.clone(),
        _ui_server: Mutex::new(None),
      });

      let rpc_handle = app.handle().clone();
      let rpc: ui_server::RpcHandler = Arc::new(move |channel, args| {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let rpc_handle = rpc_handle.clone();
        tauri::async_runtime::spawn(async move {
          let result = dispatch_host_invoke(&rpc_handle, channel, args).await;
          let _ = tx.send(result);
        });
        rx
      });
      let (ui_port, ui_server) = tauri::async_runtime::block_on(ui_server::bind_ui_server(ui_server::UiServerConfig {
        ui_root: ui_root.clone(),
        widget_cache_dir: cache_dir.clone(),
        rpc,
        bind: None,
      }))
      .map_err(|error| Box::new(std::io::Error::other(error)) as Box<dyn std::error::Error>)?;
      *app.state::<AppState>()._ui_server.lock().unwrap() = Some(ui_server);
      let ui_url = format!("http://127.0.0.1:{ui_port}/index.html");

      let url = if cfg!(debug_assertions) {
        WebviewUrl::External("http://127.0.0.1:5273/".parse().expect("dev url"))
      } else {
        WebviewUrl::External(ui_url.parse().expect("ui url"))
      };
      WebviewWindowBuilder::new(app, "popover", url)
        .title("Hatch")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build()?;

      if let Some(window) = app.get_webview_window("popover") {
        let _ = window.set_shadow(false);
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::Focused(false) = event {
            if keep_popover_open() {
              return;
            }
            if let Some(window) = handle.get_webview_window("popover") {
              let _ = window.hide();
            }
            set_key_window_active(&handle, false);
            emit_renderer_event(&handle, "hatch:popover:visibility", json!({ "visible": false }));
          }
        });
      }

      let assets_dir = if packaged {
        app
          .path()
          .resource_dir()
          .ok()
          .unwrap_or_else(|| repo_root().join("assets"))
      } else {
        repo_root().join("assets")
      };
      let icon_path = hatch_tray_icon_path(&assets_dir);
      let icon = Image::from_path(&icon_path).unwrap_or_else(|_| Image::new(&[], 0, 0));
      let tray_handle = app.handle().clone();
      let tray_builder = TrayIconBuilder::new().icon(icon).tooltip("Hatch");
      #[cfg(target_os = "macos")]
      let tray_builder = tray_builder.icon_as_template(true);
      #[cfg(not(target_os = "macos"))]
      let tray_builder = {
        // Linux tray icons cannot report clicks and may not even render
        // without a menu, so expose the popover through a context menu.
        use tauri::menu::{Menu, MenuItem};
        let toggle_item = MenuItem::with_id(app, "toggle", "Toggle Hatch", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "quit", "Quit Hatch", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&toggle_item, &quit_item])?;
        tray_builder
          .menu(&menu)
          .show_menu_on_left_click(true)
          .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
              let handle = app.clone();
              tauri::async_runtime::spawn(async move {
                toggle_at_cursor(&handle).await;
              });
            }
            "quit" => app.exit(0),
            _ => {}
          })
      };
      let tray_icon = tray_builder
        .on_tray_icon_event(move |_tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            rect,
            ..
          } = event
          {
            let tray = tray_rect_logical(&tray_handle, rect);
            let handle = tray_handle.clone();
            tauri::async_runtime::spawn(async move {
              toggle_popover(&handle, tray).await;
            });
          }
        })
        .build(app)?;
      crate::tray::size_tray_icon_to_menu_bar(&tray_icon);
      let _tray_icon = tray_icon;

      if open_on_start() {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          toggle_popover(
            &handle,
            Rect {
              x: 0.0,
              y: 0.0,
              width: 22.0,
              height: 22.0,
            },
          )
          .await;
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("hatch tauri host failed");
}
