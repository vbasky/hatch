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
    hatch_tray_icon_on_dark(assets_dir)
  }
}

/// White glyph for dark panels. Plasma cannot template-tint like macOS.
pub fn hatch_tray_icon_on_dark(assets_dir: &Path) -> PathBuf {
  assets_dir.join("tray/hatch.png")
}

/// Black glyph for light panels.
pub fn hatch_tray_icon_on_light(assets_dir: &Path) -> PathBuf {
  let light = assets_dir.join("tray/hatch-light.png");
  if light.is_file() {
    light
  } else {
    hatch_tray_icon_on_dark(assets_dir)
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

  #[cfg(target_os = "macos")]
  #[test]
  fn prefers_three_x_template_when_present() {
    let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets");
    let path = hatch_tray_icon_path(&assets);
    assert!(
      path.ends_with("hatchTemplate@3x.png"),
      "expected @3x tray template, got {path:?}"
    );
  }

  #[cfg(not(target_os = "macos"))]
  #[test]
  fn uses_scheme_specific_pngs_for_plasma_tray() {
    let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets");
    assert!(
      hatch_tray_icon_on_dark(&assets).ends_with("tray/hatch.png"),
      "dark-panel glyph should be the white hatch.png"
    );
    assert!(
      hatch_tray_icon_on_light(&assets).ends_with("tray/hatch-light.png"),
      "light-panel glyph should be the black hatch-light.png"
    );
  }

  #[test]
  fn menu_bar_point_size_matches_status_item_slot() {
    assert_eq!(TRAY_ICON_POINT_SIZE, 18.0);
  }
}
