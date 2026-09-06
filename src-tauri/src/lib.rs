mod geometry;
mod host;
mod protocol;
mod tray;
mod ui_server;

#[cfg(target_os = "linux")]
mod kde;
#[cfg(target_os = "macos")]
mod tauri_app;

pub fn run() {
  #[cfg(target_os = "macos")]
  tauri_app::run();
  #[cfg(target_os = "linux")]
  kde::run();
}
