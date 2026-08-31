use std::path::{Path, PathBuf};

/// Apple status-item glyphs are 18pt. 22pt overfills the menu bar next to Saturn-class icons.
pub const TRAY_ICON_POINT_SIZE: f64 = 18.0;

pub fn hatch_tray_icon_path(assets_dir: &Path) -> PathBuf {
  #[cfg(target_os = "macos")]
  {
    let retina = assets_dir.join("tray/hatchTemplate@3x.png");
    if retina.is_file() {
      return retina;
    }
    assets_dir.join("tray/hatchTemplate.png")
  }
  #[cfg(not(target_os = "macos"))]
  {
    // Linux/SNI tray icons are rendered as-is (no template treatment),
    // so use a regular full-color PNG rather than the macOS template.
    assets_dir.join("tray/hatch.png")
  }
}

#[cfg(target_os = "macos")]
pub fn size_tray_icon_to_menu_bar(tray: &tauri::tray::TrayIcon) {
  use objc2::MainThreadMarker;
  use objc2_foundation::NSSize;

  let _ = tray.with_inner_tray_icon(|inner| {
    let Some(item) = inner.ns_status_item() else {
      return;
    };
    let Some(mtm) = MainThreadMarker::new() else {
      return;
    };
    let Some(button) = item.button(mtm) else {
      return;
    };
    let Some(image) = button.image() else {
      return;
    };
    image.setSize(NSSize::new(TRAY_ICON_POINT_SIZE, TRAY_ICON_POINT_SIZE));
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn prefers_three_x_template_when_present() {
    let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets");
    let path = hatch_tray_icon_path(&assets);
    assert!(
      path.ends_with("hatchTemplate@3x.png"),
      "expected @3x tray template, got {path:?}"
    );
  }

  #[test]
  fn menu_bar_point_size_matches_status_item_slot() {
    assert_eq!(TRAY_ICON_POINT_SIZE, 18.0);
  }
}
