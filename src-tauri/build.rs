fn main() {
  let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
  if target_os == "macos" {
    tauri_build::build();
  }
  if target_os == "linux" {
    build_kde_shell();
  }
}

fn build_kde_shell() {
  println!("cargo:rerun-if-changed=src/kde/shell.cpp");
  println!("cargo:rerun-if-changed=src/kde/shell.h");

  let qt = pkg_config::Config::new()
    .probe("Qt6WebEngineWidgets")
    .expect("Qt6 WebEngine Widgets is required for the KDE/Plasma shell");

  let mut build = cc::Build::new();
  build
    .cpp(true)
    .file("src/kde/shell.cpp")
    .include("src/kde")
    .flag_if_supported("-std=c++17")
    .flag_if_supported("-fPIC");
  for path in &qt.include_paths {
    build.include(path);
  }
  for (key, value) in &qt.defines {
    build.define(key, value.as_deref());
  }
  let layer_include = std::path::Path::new("/usr/include/LayerShellQt/Window");
  if layer_include.exists() {
    build.define("HATCH_HAS_LAYER_SHELL", "1");
    build.include("/usr/include");
    println!("cargo:rustc-link-lib=dylib=LayerShellQtInterface");
  }
  if let Ok(kf) = pkg_config::Config::new().probe("KF6WindowSystem") {
    build.define("HATCH_HAS_KWINDOW_EFFECTS", "1");
    for path in &kf.include_paths {
      build.include(path);
    }
  }
  if let Ok(dbus) = pkg_config::Config::new().probe("Qt6DBus") {
    for path in &dbus.include_paths {
      build.include(path);
    }
  }
  build.compile("hatch_kde_shell");
  println!("cargo:rustc-link-lib=dylib=stdc++");
}
