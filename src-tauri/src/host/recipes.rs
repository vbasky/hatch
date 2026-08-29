use std::fs;
use std::path::Path;

use serde_json::{json, Value};

pub fn list(recipes_dir: &Path) -> Result<Value, String> {
  let mut recipes = Vec::new();
  let entries = match fs::read_dir(recipes_dir) {
    Ok(entries) => entries,
    Err(_) => return Ok(json!([])),
  };
  let mut files: Vec<_> = entries
    .filter_map(|entry| entry.ok())
    .map(|entry| entry.path())
    .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("html"))
    .collect();
  files.sort();
  for path in files {
    let html = fs::read_to_string(&path).unwrap_or_default();
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("recipe.html");
    let id = file_name.trim_end_matches(".html");
    recipes.push(json!({
      "id": id,
      "title": extract_title(&html, id),
      "fileName": file_name,
      "path": path.to_string_lossy(),
    }));
  }
  Ok(Value::Array(recipes))
}

fn extract_title(html: &str, fallback: &str) -> String {
  let from_tag = |tag: &str| {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = html.find(&open)?;
    let after = html[start..].find('>')? + start + 1;
    let end = html[after..].find(&close)? + after;
    Some(strip_tags(&html[after..end]))
  };
  from_tag("title")
    .or_else(|| from_tag("h1"))
    .map(|title| title.split_whitespace().collect::<Vec<_>>().join(" "))
    .filter(|title| !title.is_empty())
    .unwrap_or_else(|| fallback.to_string())
}

fn strip_tags(value: &str) -> String {
  let mut out = String::new();
  let mut skipping = false;
  for ch in value.chars() {
    match ch {
      '<' => skipping = true,
      '>' => skipping = false,
      _ if !skipping => out.push(ch),
      _ => {}
    }
  }
  out.trim().to_string()
}
