use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::compile::{compile_extension_module, CompileOptions, ModuleKind};
use super::js::JsEngine;

pub struct HostActions {
  extensions_dir: PathBuf,
  cache_dir: PathBuf,
  root_dir: PathBuf,
  db: std::sync::Arc<super::db::HostDb>,
}

impl HostActions {
  pub fn new(
    extensions_dir: PathBuf,
    cache_dir: PathBuf,
    root_dir: PathBuf,
    db: std::sync::Arc<super::db::HostDb>,
  ) -> Self {
    Self {
      extensions_dir,
      cache_dir,
      root_dir,
      db,
    }
  }

  pub fn list(&self) -> Result<Value, String> {
    let mut descriptors = Vec::new();
    for file in discover_server_files(&self.extensions_dir)? {
      let Some(extension_id) = file.parent().and_then(|dir| dir.file_name()).and_then(|name| name.to_str()) else {
        continue;
      };
      match self.action_names(extension_id, &file) {
        Ok(names) => {
          for action in names {
            descriptors.push(json!({
              "id": format!("{extension_id}.{action}"),
              "extensionId": extension_id,
              "action": action,
            }));
          }
        }
        Err(error) => {
          eprintln!("[hatch] failed to list actions for {extension_id}: {error}");
        }
      }
    }
    Ok(Value::Array(descriptors))
  }

  pub fn invoke(&self, extension_id: &str, action: &str, input: &Value) -> Result<Value, String> {
    let entry = self.extensions_dir.join(extension_id).join("server.ts");
    if !entry.is_file() {
      return Err(format!("Unknown server action: {extension_id}.{action}"));
    }
    let compiled = compile_extension_module(CompileOptions {
      kind: ModuleKind::Server,
      extension_id,
      extension_dir: &self.extensions_dir.join(extension_id),
      entry_file: &entry,
      cache_root: &self.cache_dir,
    })?;
    JsEngine::new(self.db.clone(), self.root_dir.clone())?
      .invoke(&compiled.output_path, action, input, &self.root_dir)
  }

  fn action_names(&self, extension_id: &str, entry: &Path) -> Result<Vec<String>, String> {
    let compiled = compile_extension_module(CompileOptions {
      kind: ModuleKind::Server,
      extension_id,
      extension_dir: &entry.parent().unwrap_or(entry).to_path_buf(),
      entry_file: entry,
      cache_root: &self.cache_dir,
    })?;
    JsEngine::new(self.db.clone(), self.root_dir.clone())?.list_actions(&compiled.output_path)
  }

  pub fn tick_background(&self) {
    let Ok(files) = discover_server_files(&self.extensions_dir) else {
      return;
    };
    for file in files {
      let Some(extension_id) = file.parent().and_then(|dir| dir.file_name()).and_then(|name| name.to_str()) else {
        continue;
      };
      let compiled = match compile_extension_module(CompileOptions {
        kind: ModuleKind::Server,
        extension_id,
        extension_dir: &file.parent().unwrap_or(&file).to_path_buf(),
        entry_file: &file,
        cache_root: &self.cache_dir,
      }) {
        Ok(compiled) => compiled,
        Err(error) => {
          eprintln!("[hatch] background compile failed for {extension_id}: {error}");
          continue;
        }
      };
      if let Err(error) = JsEngine::new(self.db.clone(), self.root_dir.clone())
        .and_then(|engine| engine.run_background(&compiled.output_path, &self.root_dir))
      {
        eprintln!("[hatch] background task failed for {extension_id}: {error}");
      }
    }
  }
}

fn discover_server_files(root: &Path) -> Result<Vec<PathBuf>, String> {
  let mut files = Vec::new();
  let entries = match std::fs::read_dir(root) {
    Ok(entries) => entries,
    Err(_) => return Ok(files),
  };
  for entry in entries {
    let entry = entry.map_err(|error| error.to_string())?;
    let path = entry.path();
    if !path.is_dir() {
      continue;
    }
    let server = path.join("server.ts");
    if server.is_file() {
      files.push(server);
    }
  }
  files.sort();
  Ok(files)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::host::db::HostDb;

  #[test]
  fn invokes_compiled_server_action() {
    let dir = std::env::temp_dir().join(format!("hatch-actions-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("demo")).unwrap();
    std::fs::write(
      dir.join("demo/server.ts"),
      r#"
import os from "node:os";
export const actions = {
  ping(_input: unknown, context: { rootDir: string }) {
    return { ok: true, home: os.homedir(), root: context.rootDir };
  },
};
"#,
    )
    .unwrap();
    let db = std::sync::Arc::new(HostDb::open(Path::new(":memory:")).unwrap());
    let actions = HostActions::new(dir.clone(), dir.join("cache"), dir.clone(), db);
    let result = actions.invoke("demo", "ping", &Value::Null).unwrap();
    assert_eq!(result["ok"], true);
    assert!(result["home"].as_str().unwrap().starts_with('/'));
    assert_eq!(result["root"].as_str().unwrap(), dir.to_string_lossy());
  }

  #[test]
  fn grok_quota_action_returns_structured_result() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let extensions = root.join("extensions");
    if !extensions.join("grok-quota/server.ts").is_file() {
      return;
    }
    let cache = std::env::temp_dir().join(format!("hatch-grok-cache-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&cache);
    let db = std::sync::Arc::new(HostDb::open(Path::new(":memory:")).unwrap());
    let actions = HostActions::new(extensions, cache, root, db);
    let result = actions.invoke("grok-quota", "getQuota", &Value::Null).expect("grok-quota invoke");
    assert!(result.get("ok").is_some(), "{result}");
  }
}
