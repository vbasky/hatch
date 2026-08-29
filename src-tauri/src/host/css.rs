use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const THEME_CSS: &str = include_str!("../../../src/ui/theme.css");

pub fn compile_widget_css(source_dir: &Path) -> Result<String, String> {
  let theme = parse_theme(THEME_CSS);
  let source = read_sources(source_dir)?;
  let classes = extract_classes(&source);
  Ok(emit_css(&theme, &classes))
}

struct Theme {
  colors: BTreeMap<String, String>,
  text: BTreeMap<String, String>,
  tracking: BTreeMap<String, String>,
  radius: BTreeMap<String, String>,
  fonts: BTreeMap<String, String>,
}

fn parse_theme(css: &str) -> Theme {
  let mut theme = Theme {
    colors: BTreeMap::new(),
    text: BTreeMap::new(),
    tracking: BTreeMap::new(),
    radius: BTreeMap::new(),
    fonts: BTreeMap::new(),
  };
  let mut in_theme = false;
  for raw in css.lines() {
    let line = raw.trim().trim_end_matches(';');
    if line.starts_with("@theme") {
      in_theme = true;
      continue;
    }
    if in_theme && line == "}" {
      in_theme = false;
      continue;
    }
    if !in_theme {
      continue;
    }
    if let Some(name) = line.strip_prefix("--") {
      let Some((key, raw_value)) = name.split_once(':') else {
        continue;
      };
      let key = key.trim();
      let value = raw_value.trim();
      if value == "initial" {
        continue;
      }
      if let Some(rest) = key.strip_prefix("color-") {
        theme.colors.insert(rest.to_string(), value.to_string());
      } else if let Some(rest) = key.strip_prefix("text-") {
        theme.text.insert(rest.to_string(), value.to_string());
      } else if let Some(rest) = key.strip_prefix("tracking-") {
        theme.tracking.insert(rest.to_string(), value.to_string());
      } else if let Some(rest) = key.strip_prefix("radius-") {
        theme.radius.insert(rest.to_string(), value.to_string());
      } else if let Some(rest) = key.strip_prefix("font-") {
        theme.fonts.insert(rest.to_string(), value.to_string());
      }
    }
  }
  theme
}

fn parse_light_colors(css: &str) -> BTreeMap<String, String> {
  let mut in_light = false;
  let mut colors = BTreeMap::new();
  for raw in css.lines() {
    let line = raw.trim().trim_end_matches(';');
    if line.contains("data-theme=\"light\"") {
      in_light = true;
      continue;
    }
    if !in_light {
      continue;
    }
    if line == "}" {
      break;
    }
    if let Some(name) = line.strip_prefix("--color-") {
      let Some((key, raw_value)) = name.split_once(':') else {
        continue;
      };
      let value = raw_value.trim();
      if value != "initial" {
        colors.insert(key.trim().to_string(), value.to_string());
      }
    }
  }
  colors
}

fn read_sources(source_dir: &Path) -> Result<String, String> {
  let resolved = std::fs::canonicalize(source_dir).unwrap_or_else(|_| source_dir.to_path_buf());
  let mut out = String::new();
  walk_sources(&resolved, &mut out)?;
  Ok(out)
}

fn walk_sources(dir: &Path, out: &mut String) -> Result<(), String> {
  let entries = match std::fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(_) => return Ok(()),
  };
  for entry in entries {
    let entry = entry.map_err(|error| error.to_string())?;
    let path = entry.path();
    let name = entry.file_name();
    if name == ".git" || name == "node_modules" {
      continue;
    }
    if path.is_dir() {
      walk_sources(&path, out)?;
      continue;
    }
    if path
      .extension()
      .and_then(|ext| ext.to_str())
      .is_some_and(|ext| matches!(ext, "tsx" | "ts" | "jsx" | "js" | "mjs" | "css" | "html"))
    {
      if let Ok(source) = std::fs::read_to_string(&path) {
        out.push_str(&source);
        out.push('\n');
      }
    }
  }
  Ok(())
}

fn extract_classes(source: &str) -> BTreeSet<String> {
  let mut classes = BTreeSet::new();
  let mut current = String::new();
  let mut quote = None::<char>;
  for ch in source.chars() {
    match quote {
      None => {
        if ch == '"' || ch == '\'' || ch == '`' {
          quote = Some(ch);
          current.clear();
        }
      }
      Some(mark) if ch == mark => {
        for token in current.split_whitespace() {
          if looks_like_class(token) {
            classes.insert(token.to_string());
          }
        }
        quote = None;
        current.clear();
      }
      Some(_) => current.push(ch),
    }
  }
  classes
}

fn looks_like_class(token: &str) -> bool {
  token
    .chars()
    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '/' | ':' | '[' | ']' | '.' | '%'))
    && token.chars().any(|ch| ch.is_ascii_alphabetic())
}

fn emit_css(theme: &Theme, classes: &BTreeSet<String>) -> String {
  let mut rules = Vec::new();
  for class in classes {
    if let Some(rule) = utility_rule(theme, class) {
      rules.push(rule);
    }
  }
  let mut css = String::from("@layer theme {\n  :root, :host {\n");
  for (name, value) in &theme.colors {
    css.push_str(&format!("    --color-{name}: {value};\n"));
  }
  css.push_str("  }\n");
  let light_colors = parse_light_colors(THEME_CSS);
  if !light_colors.is_empty() {
    css.push_str("  html[data-theme=\"light\"],\n  html.light {\n");
    for (name, value) in &light_colors {
      css.push_str(&format!("    --color-{name}: {value};\n"));
    }
    css.push_str("  }\n");
  }
  css.push_str("}\n@layer utilities {\n");
  for rule in rules {
    css.push_str(&rule);
  }
  css.push_str("}\n");
  css
}

fn utility_rule(theme: &Theme, class: &str) -> Option<String> {
  let (variants, name) = split_variants(class);
  let body = utility_body(theme, name)?;
  let selector = class_selector(class, &variants);
  Some(format!("  {selector} {{\n    {body}\n  }}\n"))
}

fn split_variants(class: &str) -> (Vec<&str>, &str) {
  let mut parts = class.split(':').collect::<Vec<_>>();
  if parts.len() == 1 {
    return (Vec::new(), class);
  }
  let name = parts.pop().unwrap_or(class);
  (parts, name)
}

fn class_selector(class: &str, variants: &[&str]) -> String {
  let escaped = escape_class(class);
  let mut selector = format!(".{escaped}");
  for variant in variants {
    match *variant {
      "hover" => selector.push_str(":hover"),
      "focus" => selector.push_str(":focus"),
      "active" => selector.push_str(":active"),
      "disabled" => selector.push_str(":disabled"),
      _ => {}
    }
  }
  selector
}

fn escape_class(class: &str) -> String {
  let mut out = String::new();
  for ch in class.chars() {
    if matches!(ch, '/' | ':' | '[' | ']' | '.' | '%') {
      out.push('\\');
    }
    out.push(ch);
  }
  out
}

fn utility_body(theme: &Theme, name: &str) -> Option<String> {
  if let Some(value) = arbitrary(name) {
    return arbitrary_decl(name, value);
  }
  match name {
    "flex" => Some("display: flex".into()),
    "inline-flex" => Some("display: inline-flex".into()),
    "block" => Some("display: block".into()),
    "inline-block" => Some("display: inline-block".into()),
    "inline" => Some("display: inline".into()),
    "hidden" => Some("display: none".into()),
    "grid" => Some("display: grid".into()),
    "contents" => Some("display: contents".into()),
    "flex-col" => Some("flex-direction: column".into()),
    "flex-row" => Some("flex-direction: row".into()),
    "flex-wrap" => Some("flex-wrap: wrap".into()),
    "flex-1" => Some("flex: 1 1 0%".into()),
    "flex-none" => Some("flex: none".into()),
    "shrink-0" => Some("flex-shrink: 0".into()),
    "grow" => Some("flex-grow: 1".into()),
    "items-center" => Some("align-items: center".into()),
    "items-start" => Some("align-items: flex-start".into()),
    "items-end" => Some("align-items: flex-end".into()),
    "items-baseline" => Some("align-items: baseline".into()),
    "justify-between" => Some("justify-content: space-between".into()),
    "justify-center" => Some("justify-content: center".into()),
    "justify-end" => Some("justify-content: flex-end".into()),
    "justify-start" => Some("justify-content: flex-start".into()),
    "relative" => Some("position: relative".into()),
    "absolute" => Some("position: absolute".into()),
    "inset-0" => Some("inset: 0".into()),
    "min-w-0" => Some("min-width: 0".into()),
    "w-full" => Some("width: 100%".into()),
    "h-full" => Some("height: 100%".into()),
    "h-2" => Some("height: 0.5rem".into()),
    "truncate" => Some("overflow: hidden; text-overflow: ellipsis; white-space: nowrap".into()),
    "uppercase" => Some("text-transform: uppercase".into()),
    "lowercase" => Some("text-transform: lowercase".into()),
    "font-light" => Some("font-weight: 300".into()),
    "font-normal" => Some("font-weight: 400".into()),
    "font-medium" => Some("font-weight: 500".into()),
    "font-semibold" => Some("font-weight: 600".into()),
    "overflow-hidden" => Some("overflow: hidden".into()),
    "overflow-auto" => Some("overflow: auto".into()),
    "pointer-events-none" => Some("pointer-events: none".into()),
    "cursor-pointer" => Some("cursor: pointer".into()),
    "whitespace-nowrap" => Some("white-space: nowrap".into()),
    "tabular-nums" => Some("font-variant-numeric: tabular-nums".into()),
    "border" => Some("border-width: 1px".into()),
    "border-0" => Some("border-width: 0".into()),
    other => sized(theme, other),
  }
}

fn sized(theme: &Theme, name: &str) -> Option<String> {
  if let Some(rest) = name.strip_prefix("grid-cols-") {
    return Some(format!("grid-template-columns: repeat({rest}, minmax(0, 1fr))"));
  }
  if let Some(color) = color_decl(theme, "bg-", name, "background-color") {
    return Some(color);
  }
  if let Some(color) = color_decl(theme, "text-", name, "color") {
    return Some(color);
  }
  if let Some(color) = color_decl(theme, "border-", name, "border-color") {
    return Some(color);
  }
  if let Some(token) = name.strip_prefix("text-") {
    if let Some(size) = theme.text.get(token) {
      return Some(format!("font-size: {size}"));
    }
  }
  if let Some(token) = name.strip_prefix("tracking-") {
    if let Some(tracking) = theme.tracking.get(token) {
      return Some(format!("letter-spacing: {tracking}"));
    }
  }
  if let Some(token) = name.strip_prefix("rounded-") {
    if let Some(radius) = theme.radius.get(token) {
      return Some(format!("border-radius: {radius}"));
    }
  }
  if name == "rounded" {
    return theme.radius.get("md").map(|value| format!("border-radius: {value}"));
  }
  if let Some(token) = name.strip_prefix("font-") {
    if let Some(font) = theme.fonts.get(token) {
      return Some(format!("font-family: {font}"));
    }
  }
  space(name)
}

fn color_decl(theme: &Theme, prefix: &str, name: &str, property: &str) -> Option<String> {
  let rest = name.strip_prefix(prefix)?;
  let (token, alpha) = match rest.split_once('/') {
    Some((token, alpha)) => (token, Some(alpha)),
    None => (rest, None),
  };
  theme.colors.get(token)?;
  let value = format!("var(--color-{token})");
  let resolved = match alpha {
    Some(alpha) => format!("color-mix(in srgb, {value} {alpha}%, transparent)"),
    None => value,
  };
  Some(format!("{property}: {resolved}"))
}

fn space(name: &str) -> Option<String> {
  let pairs = [
    ("p-", "padding"),
    ("px-", "padding-inline"),
    ("py-", "padding-block"),
    ("pt-", "padding-top"),
    ("pr-", "padding-right"),
    ("pb-", "padding-bottom"),
    ("pl-", "padding-left"),
    ("m-", "margin"),
    ("mx-", "margin-inline"),
    ("my-", "margin-block"),
    ("mt-", "margin-top"),
    ("mr-", "margin-right"),
    ("mb-", "margin-bottom"),
    ("ml-", "margin-left"),
    ("gap-", "gap"),
    ("gap-x-", "column-gap"),
    ("gap-y-", "row-gap"),
    ("w-", "width"),
    ("h-", "height"),
    ("min-w-", "min-width"),
    ("min-h-", "min-height"),
    ("max-w-", "max-width"),
    ("max-h-", "max-height"),
  ];
  for (prefix, property) in pairs {
    if let Some(rest) = name.strip_prefix(prefix) {
      if let Some(value) = spacing_value(rest) {
        return Some(format!("{property}: {value}"));
      }
    }
  }
  None
}

fn spacing_value(token: &str) -> Option<String> {
  match token {
    "auto" => Some("auto".into()),
    "px" => Some("1px".into()),
    "full" => Some("100%".into()),
    "screen" => Some("100vh".into()),
    "min" => Some("min-content".into()),
    "max" => Some("max-content".into()),
    "fit" => Some("fit-content".into()),
    "0" => Some("0".into()),
    other => {
      let number: f32 = other.parse().ok()?;
      Some(format!("{}rem", number * 0.25))
    }
  }
}

fn arbitrary(name: &str) -> Option<&str> {
  let start = name.find('[')?;
  let end = name.rfind(']')?;
  if end <= start + 1 {
    return None;
  }
  Some(&name[start + 1..end])
}

fn arbitrary_decl(name: &str, value: &str) -> Option<String> {
  let value = value.replace('_', " ");
  if name.starts_with("w-[") {
    return Some(format!("width: {value}"));
  }
  if name.starts_with("h-[") {
    return Some(format!("height: {value}"));
  }
  if name.starts_with("max-w-[") {
    return Some(format!("max-width: {value}"));
  }
  if name.starts_with("min-w-[") {
    return Some(format!("min-width: {value}"));
  }
  if name.starts_with("p-[") {
    return Some(format!("padding: {value}"));
  }
  if name.starts_with("gap-[") {
    return Some(format!("gap: {value}"));
  }
  if name.starts_with("top-[") {
    return Some(format!("top: {value}"));
  }
  if name.starts_with("text-[") {
    return Some(format!("font-size: {value}"));
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn generates_token_utilities_without_preflight_or_off_palette_colors() {
    let dir = std::env::temp_dir().join(format!("hatch-css-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
      dir.join("widget.tsx"),
      r#"<div className="flex gap-2 text-ink-muted bg-surface text-signal-live bg-signal-live/40 bg-red-500 text-blue-300" />"#,
    )
    .unwrap();
    let css = compile_widget_css(&dir).unwrap();
    assert!(css.contains(".flex"), "{css}");
    assert!(css.contains(".text-ink-muted"), "{css}");
    assert!(css.contains(".bg-surface"), "{css}");
    assert!(css.contains("color: var(--color-ink-muted)"), "{css}");
    assert!(css.contains("background-color: var(--color-surface)"), "{css}");
    assert!(css.contains("color-mix(in srgb, var(--color-signal-live) 40%, transparent)"), "{css}");
    assert!(!css.contains("color: rgba(255, 255, 255"), "{css}");
    assert!(css.to_lowercase().contains("#6ae3b6"), "{css}");
    assert!(!css.contains("@layer base"));
    assert!(!css.contains("border: 0 solid"));
    assert!(!css.contains(".bg-red-500"));
    assert!(!css.contains(".text-blue-300"));
    assert!(css.contains("html[data-theme=\"light\"]"), "{css}");
    assert!(css.contains("html.light"), "{css}");
    assert!(css.contains("--color-ink: rgba(9, 9, 11, 0.80)"), "{css}");
    let light_start = css.find("html[data-theme=\"light\"]").expect("light selector");
    let light_block = &css[light_start..];
    assert!(light_block.contains("--color-ink: rgba(9, 9, 11, 0.80)"), "{css}");
    assert!(!light_block.contains("--color-ink: rgba(255, 255, 255"), "{css}");
  }

  #[test]
  fn compiles_through_a_symlinked_source_directory() {
    let dir = std::env::temp_dir().join(format!("hatch-css-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let real = dir.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("layout.tsx"), r#"<div className="flex gap-2 bg-surface" />"#).unwrap();
    let link = dir.join("extensions");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &link).unwrap();
    #[cfg(not(unix))]
    std::fs::create_dir_all(&link).unwrap();
    let css = compile_widget_css(&link).unwrap();
    assert!(css.contains(".flex"), "{css}");
    assert!(css.contains(".bg-surface"), "{css}");
  }
}
