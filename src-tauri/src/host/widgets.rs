use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use super::compile::{compile_extension_module, CompileOptions, ModuleKind};
use super::css;

const STARTER_EXTENSION_ID: &str = "hello-world";
const LAYOUT_EXTENSION_ID: &str = "__layout";

pub struct HostWidgets;

impl HostWidgets {
  pub fn list(extensions_dir: &Path, cache_dir: &Path, packaged: bool) -> Result<Value, String> {
    let mut widgets = Vec::new();
    for file in discover_files(extensions_dir, &["widget.tsx", "widget.jsx", "widget.ts", "widget.js"])? {
      let Some(extension_id) = infer_extension_id(extensions_dir, &file) else {
        continue;
      };
      if extension_id == STARTER_EXTENSION_ID {
        continue;
      }
      let urls = module_urls(
        if packaged { ModuleKind::Widget } else { ModuleKind::Widget },
        &extension_id,
        extensions_dir,
        &file,
        cache_dir,
        packaged,
      )?;
      widgets.push(json!({
        "id": format!("{extension_id}.widget"),
        "extensionId": extension_id,
        "moduleUrl": urls.0,
        "cssUrl": urls.1,
      }));
    }
    widgets.sort_by(|left, right| {
      left
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .cmp(right.get("id").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(Value::Array(widgets))
  }

  pub fn layout(extensions_dir: &Path, cache_dir: &Path, packaged: bool) -> Result<Value, String> {
    let Some(file) = ["layout.tsx", "layout.jsx", "layout.ts", "layout.js"]
      .into_iter()
      .map(|name| extensions_dir.join(name))
      .find(|path| path.is_file())
    else {
      return Ok(Value::Null);
    };
    let urls = module_urls(
      ModuleKind::Layout,
      LAYOUT_EXTENSION_ID,
      extensions_dir,
      &file,
      cache_dir,
      packaged,
    )?;
    Ok(json!({
      "moduleUrl": urls.0,
      "cssUrl": urls.1,
    }))
  }
}

fn module_urls(
  kind: ModuleKind,
  extension_id: &str,
  extensions_dir: &Path,
  file: &Path,
  cache_dir: &Path,
  packaged: bool,
) -> Result<(String, Option<String>), String> {
  if !packaged {
    return Ok((vite_url(file)?, None));
  }
  let extension_dir = if kind == ModuleKind::Layout {
    extensions_dir.to_path_buf()
  } else {
    extensions_dir.join(extension_id)
  };
  let compiled = compile_extension_module(CompileOptions {
    kind,
    extension_id,
    extension_dir: &extension_dir,
    entry_file: file,
    cache_root: cache_dir,
  })?;
  let relative = compiled
    .output_path
    .strip_prefix(&compiled.output_dir)
    .unwrap_or(&compiled.output_path)
    .to_string_lossy()
    .replace('\\', "/");
  let module_url = format!(
    "/__widgets__/{}/{}/{}",
    urlencoding_lite(extension_id),
    compiled.hash,
    relative
  );
  let css_path = compiled.output_dir.join("widget.css");
  let css = css::compile_widget_css(&extension_dir).unwrap_or_default();
  fs::write(&css_path, css).map_err(|error| error.to_string())?;
  let css_url = format!(
    "/__widgets__/{}/{}/widget.css",
    urlencoding_lite(extension_id),
    compiled.hash
  );
  Ok((module_url, Some(css_url)))
}

fn vite_url(file: &Path) -> Result<String, String> {
  let absolute = file.canonicalize().map_err(|e| e.to_string())?;
  let normalized = absolute.to_string_lossy().replace('\\', "/");
  let encoded = normalized
    .split('/')
    .map(|part| {
      if part.is_empty() {
        String::new()
      } else {
        urlencoding_lite(part)
      }
    })
    .collect::<Vec<_>>()
    .join("/");
  let mtime = fs::metadata(file)
    .ok()
    .and_then(|meta| meta.modified().ok())
    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis())
    .unwrap_or(0);
  Ok(format!("/@fs{encoded}?hatchWidgetVersion={mtime}"))
}

fn discover_files(root: &Path, names: &[&str]) -> Result<Vec<PathBuf>, String> {
  let mut files = Vec::new();
  visit(root, names, &mut files)?;
  Ok(files)
}

fn visit(dir: &Path, names: &[&str], files: &mut Vec<PathBuf>) -> Result<(), String> {
  let entries = match fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(_) => return Ok(()),
  };
  for entry in entries {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    if path.is_dir() {
      visit(&path, names, files)?;
    } else if path
      .file_name()
      .and_then(|name| name.to_str())
      .is_some_and(|name| names.contains(&name))
    {
      files.push(path);
    }
  }
  Ok(())
}

fn infer_extension_id(extensions_dir: &Path, file: &Path) -> Option<String> {
  let relative = file.strip_prefix(extensions_dir).ok()?;
  relative.iter().next()?.to_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn packaged_widget_list_includes_compiled_css_url() {
    let dir = std::env::temp_dir().join(format!("hatch-widgets-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let ext = dir.join("extensions/meter");
    std::fs::create_dir_all(&ext).unwrap();
    std::fs::write(ext.join("widget.tsx"), r#"export const widget = { id: "meter", render: () => <div className="flex gap-2 bg-surface" /> };"#).unwrap();
    let cache = dir.join("cache");
    let widgets = HostWidgets::list(&dir.join("extensions"), &cache, true).unwrap();
    let first = widgets.as_array().unwrap().first().unwrap();
    let css_url = first.get("cssUrl").and_then(Value::as_str).unwrap();
    assert!(css_url.contains("/__widgets__/meter/"), "{css_url}");
    assert!(css_url.ends_with("/widget.css"), "{css_url}");
    let hash = css_url.split('/').nth(3).unwrap();
    let css_path = cache.join("meter").join(hash).join("widget.css");
    let css = std::fs::read_to_string(&css_path).unwrap();
    assert!(css.contains(".flex"), "{css}");
    assert!(css.contains(".bg-surface"), "{css}");
    assert!(css.contains("background-color: var(--color-surface)"), "{css}");

    std::fs::write(&css_path, ".text-ink { color: rgba(255, 255, 255, 0.86) }\n").unwrap();
    let _ = HostWidgets::list(&dir.join("extensions"), &cache, true).unwrap();
    let rewritten = std::fs::read_to_string(&css_path).unwrap();
    assert!(rewritten.contains("background-color: var(--color-surface)"), "{rewritten}");
    assert!(!rewritten.contains("color: rgba(255, 255, 255"), "{rewritten}");
  }
}

fn urlencoding_lite(value: &str) -> String {
  let mut out = String::new();
  for byte in value.bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
      _ => out.push_str(&format!("%{byte:02X}")),
    }
  }
  out
}
