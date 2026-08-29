use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const NON_EXTENSION_DIRS: &[&str] = &["recipes"];
const LAYOUT_FILES: &[&str] = &["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];

#[derive(Debug, PartialEq, Eq)]
enum Entry {
  Dir,
  File(Vec<u8>),
  Link(String),
}

pub enum ChangeSession {
  Snapshot(SnapshotSession),
  Git(GitSession),
}

impl ChangeSession {
  pub fn begin(packaged: bool, root: &Path, extensions_dir: &Path, snapshot_root: &Path) -> Result<Self, String> {
    let use_git = !packaged
      && same_path(extensions_dir, &root.join("extensions"))
      && is_git_repo(root);
    if use_git {
      Ok(Self::Git(GitSession::begin(root, extensions_dir)?))
    } else {
      Ok(Self::Snapshot(SnapshotSession::begin(extensions_dir, snapshot_root)?))
    }
  }

  pub fn started_clean(&self) -> bool {
    match self {
      Self::Snapshot(_) => true,
      Self::Git(session) => session.started_clean,
    }
  }

  pub fn has_changes(&self) -> Result<bool, String> {
    match self {
      Self::Snapshot(session) => session.has_changes(),
      Self::Git(session) => session.has_changes(),
    }
  }

  pub fn describe_changes(&self) -> Result<Vec<Value>, String> {
    match self {
      Self::Snapshot(session) => session.describe_changes(),
      Self::Git(session) => session.describe_changes(),
    }
  }

  pub fn snapshot(&self, message: &str, dirty: Option<bool>, changes: Option<Vec<Value>>) -> Value {
    match self {
      Self::Snapshot(session) => session.snapshot(message, dirty, changes),
      Self::Git(session) => session.snapshot(message, dirty, changes),
    }
  }

  pub fn save(&mut self, message: Option<&str>) -> Result<Value, String> {
    match self {
      Self::Snapshot(session) => session.save(),
      Self::Git(session) => session.save(message.unwrap_or("Save hatch agent changes")),
    }
  }

  pub fn rollback(&mut self) -> Result<Value, String> {
    match self {
      Self::Snapshot(session) => session.rollback(),
      Self::Git(session) => session.rollback(),
    }
  }

  pub fn can_apply(&self) -> bool {
    match self {
      Self::Snapshot(session) => !session.completed,
      Self::Git(session) => session.started_clean && !session.completed,
    }
  }
}

pub struct SnapshotSession {
  workspace: PathBuf,
  snapshot: PathBuf,
  completed: bool,
}

impl SnapshotSession {
  pub fn begin(workspace: &Path, snapshot_root: &Path) -> Result<Self, String> {
    std::fs::create_dir_all(workspace).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(snapshot_root).map_err(|error| error.to_string())?;
    let id = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_nanos())
      .unwrap_or(0);
    let snapshot = snapshot_root.join(format!("snap-{}-{}", std::process::id(), id));
    let source = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    copy_tree(&source, &snapshot)?;
    mark_ignored(&source, &snapshot)?;
    Ok(Self {
      workspace: workspace.to_path_buf(),
      snapshot,
      completed: false,
    })
  }

  fn has_changes(&self) -> Result<bool, String> {
    Ok(read_tree(&self.snapshot)? != read_tree(&self.workspace)?)
  }

  fn describe_changes(&self) -> Result<Vec<Value>, String> {
    classify_snapshot(&self.snapshot, &self.workspace)
  }

  fn snapshot(&self, message: &str, dirty: Option<bool>, changes: Option<Vec<Value>>) -> Value {
    let mut value = json!({
      "startedClean": true,
      "canSave": !self.completed,
      "canRollback": !self.completed,
      "head": Value::Null,
      "message": message,
    });
    if let Some(dirty) = dirty {
      value["dirty"] = json!(dirty);
    }
    if let Some(changes) = changes {
      value["changes"] = Value::Array(changes);
    }
    value
  }

  fn save(&mut self) -> Result<Value, String> {
    if self.completed {
      return Ok(json!({ "ok": false, "reason": "Cannot save: session is already completed" }));
    }
    self.completed = true;
    let _ = std::fs::remove_dir_all(&self.snapshot);
    Ok(json!({ "ok": true }))
  }

  fn rollback(&mut self) -> Result<Value, String> {
    if self.completed {
      return Ok(json!({ "ok": false, "reason": "Cannot rollback: session is already completed" }));
    }
    restore_tree(&self.snapshot, &self.workspace)?;
    let _ = std::fs::remove_dir_all(&self.snapshot);
    self.completed = true;
    Ok(json!({ "ok": true }))
  }
}

pub struct GitSession {
  root: PathBuf,
  extensions_rel: String,
  head: Option<String>,
  started_clean: bool,
  completed: bool,
}

impl GitSession {
  pub fn begin(root: &Path, extensions_dir: &Path) -> Result<Self, String> {
    let started_clean = git_text(root, &["status", "--porcelain"])?.is_empty();
    let head = if started_clean {
      Some(git_text(root, &["rev-parse", "HEAD"])?)
    } else {
      None
    };
    Ok(Self {
      extensions_rel: pathdiff(root, extensions_dir),
      root: root.to_path_buf(),
      head,
      started_clean,
      completed: false,
    })
  }

  fn has_changes(&self) -> Result<bool, String> {
    Ok(!git_text(&self.root, &["status", "--porcelain"])?.is_empty())
  }

  fn describe_changes(&self) -> Result<Vec<Value>, String> {
    let mut ids = BTreeSet::new();
    let mut layout = false;
    for path in self.changed_paths()? {
      let Some(rel) = workspace_relative(&self.extensions_rel, &path) else {
        continue;
      };
      if is_layout(&rel) {
        layout = true;
        continue;
      }
      if let Some(id) = extension_id(&rel) {
        ids.insert(id);
      }
    }
    let mut changes = Vec::new();
    for id in ids {
      let kind = self.classify_path(&join_rel(&self.extensions_rel, &id))?;
      changes.push(json!({ "type": "extension", "extensionId": id, "kind": kind }));
    }
    if layout {
      let layout_path = LAYOUT_FILES
        .iter()
        .map(|name| join_rel(&self.extensions_rel, name))
        .find(|path| self.root.join(path).is_file())
        .unwrap_or_else(|| join_rel(&self.extensions_rel, "layout.tsx"));
      let kind = self.classify_path(&layout_path)?;
      changes.push(json!({ "type": "layout", "kind": kind }));
    }
    Ok(changes)
  }

  fn changed_paths(&self) -> Result<Vec<String>, String> {
    let stdout = git_text(&self.root, &["status", "--porcelain", "-uall"])?;
    let mut paths = Vec::new();
    for line in stdout.lines() {
      if line.len() < 4 {
        continue;
      }
      let rest = &line[3..];
      if let Some((left, right)) = rest.split_once(" -> ") {
        let _ = left;
        paths.push(right.trim().to_string());
      } else {
        paths.push(rest.trim().to_string());
      }
    }
    Ok(paths)
  }

  fn classify_path(&self, repo_rel: &str) -> Result<&'static str, String> {
    let in_head = !git_text(&self.root, &["ls-tree", self.head.as_deref().unwrap_or("HEAD"), "--", repo_rel])?.is_empty();
    let on_disk = self.root.join(repo_rel).exists();
    Ok(if in_head && !on_disk {
      "removed"
    } else if !in_head && on_disk {
      "created"
    } else {
      "updated"
    })
  }

  fn snapshot(&self, message: &str, dirty: Option<bool>, changes: Option<Vec<Value>>) -> Value {
    let mut value = json!({
      "startedClean": self.started_clean,
      "canSave": self.started_clean && !self.completed,
      "canRollback": self.started_clean && !self.completed,
      "head": self.head,
      "message": message,
    });
    if let Some(dirty) = dirty {
      value["dirty"] = json!(dirty);
    }
    if let Some(changes) = changes {
      value["changes"] = Value::Array(changes);
    }
    value
  }

  fn ensure_safe(&self, action: &str) -> Result<Option<Value>, String> {
    if !self.started_clean || self.head.is_none() {
      return Ok(Some(json!({ "ok": false, "reason": format!("Cannot {action}: session did not start from a clean working tree") })));
    }
    if self.completed {
      return Ok(Some(json!({ "ok": false, "reason": format!("Cannot {action}: session is already completed") })));
    }
    let current = git_text(&self.root, &["rev-parse", "HEAD"])?;
    if Some(&current) != self.head.as_ref() {
      return Ok(Some(json!({ "ok": false, "reason": format!("Cannot {action}: HEAD changed since the session started") })));
    }
    Ok(None)
  }

  fn save(&mut self, message: &str) -> Result<Value, String> {
    if let Some(block) = self.ensure_safe("save")? {
      return Ok(block);
    }
    if git_text(&self.root, &["status", "--porcelain"])?.is_empty() {
      return Ok(json!({ "ok": false, "reason": "No changes to save" }));
    }
    git_run(&self.root, &["add", "--all"])?;
    git_run(&self.root, &["commit", "-m", message])?;
    self.completed = true;
    let commit = git_text(&self.root, &["rev-parse", "HEAD"])?;
    Ok(json!({ "ok": true, "commit": commit }))
  }

  fn rollback(&mut self) -> Result<Value, String> {
    if let Some(block) = self.ensure_safe("rollback")? {
      return Ok(block);
    }
    let head = self.head.clone().unwrap_or_else(|| "HEAD".into());
    git_run(&self.root, &["reset", "--hard", &head])?;
    git_run(&self.root, &["clean", "-fd"])?;
    self.completed = true;
    Ok(json!({ "ok": true }))
  }
}

fn is_git_repo(dir: &Path) -> bool {
  git_text(dir, &["rev-parse", "--is-inside-work-tree"])
    .ok()
    .is_some_and(|value| value == "true")
}

fn git_text(cwd: &Path, args: &[&str]) -> Result<String, String> {
  let output = Command::new("git")
    .args(args)
    .current_dir(cwd)
    .output()
    .map_err(|error| error.to_string())?;
  if !output.status.success() {
    return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
  }
  Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_run(cwd: &Path, args: &[&str]) -> Result<(), String> {
  git_text(cwd, args).map(|_| ())
}

fn same_path(left: &Path, right: &Path) -> bool {
  std::fs::canonicalize(left).ok() == std::fs::canonicalize(right).ok()
}

fn pathdiff(root: &Path, child: &Path) -> String {
  child
    .strip_prefix(root)
    .map(|path| path.to_string_lossy().replace('\\', "/"))
    .unwrap_or_default()
}

fn workspace_relative(prefix: &str, repo_relative: &str) -> Option<String> {
  if prefix.is_empty() {
    return Some(repo_relative.to_string());
  }
  if repo_relative == prefix {
    return Some(String::new());
  }
  repo_relative
    .strip_prefix(&format!("{prefix}/"))
    .map(str::to_string)
}

fn extension_id(workspace_relative: &str) -> Option<String> {
  let mut parts = workspace_relative.split(['/', '\\']).filter(|part| !part.is_empty());
  let id = parts.next()?;
  if parts.next().is_none() {
    return None;
  }
  if NON_EXTENSION_DIRS.contains(&id) || id.starts_with('.') {
    return None;
  }
  Some(id.to_string())
}

fn is_layout(workspace_relative: &str) -> bool {
  LAYOUT_FILES.iter().any(|name| workspace_relative == *name)
}

fn join_rel(prefix: &str, rest: &str) -> String {
  if prefix.is_empty() {
    rest.to_string()
  } else {
    format!("{prefix}/{rest}")
  }
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
  std::fs::create_dir_all(to).map_err(|error| error.to_string())?;
  for entry in std::fs::read_dir(from).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    let name = entry.file_name();
    if name == ".git" {
      continue;
    }
    let source = entry.path();
    let dest = to.join(&name);
    let meta = std::fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if meta.file_type().is_dir() {
      copy_tree(&source, &dest)?;
    } else if meta.file_type().is_symlink() {
      let target = std::fs::read_link(&source).map_err(|error| error.to_string())?;
      #[cfg(unix)]
      std::os::unix::fs::symlink(&target, &dest).map_err(|error| error.to_string())?;
      #[cfg(not(unix))]
      std::fs::copy(&source, &dest).map_err(|error| error.to_string())?;
    } else {
      std::fs::copy(&source, &dest).map_err(|error| error.to_string())?;
    }
  }
  Ok(())
}

fn mark_ignored(source: &Path, snapshot: &Path) -> Result<(), String> {
  for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    let source_path = entry.path();
    let dest = snapshot.join(entry.file_name());
    if entry.file_name() == ".git" {
      if source_path.is_dir() {
        std::fs::create_dir_all(&dest).map_err(|error| error.to_string())?;
      } else {
        std::fs::write(&dest, []).map_err(|error| error.to_string())?;
      }
      continue;
    }
    if source_path.is_dir() {
      std::fs::create_dir_all(&dest).ok();
      mark_ignored(&source_path, &dest)?;
    }
  }
  Ok(())
}

fn read_tree(dir: &Path) -> Result<BTreeMap<String, Entry>, String> {
  let mut files = BTreeMap::new();
  walk_tree(dir, dir, &mut files)?;
  Ok(files)
}

fn walk_tree(root: &Path, current: &Path, files: &mut BTreeMap<String, Entry>) -> Result<(), String> {
  let entries = match std::fs::read_dir(current) {
    Ok(entries) => entries,
    Err(_) => return Ok(()),
  };
  for entry in entries {
    let entry = entry.map_err(|error| error.to_string())?;
    if entry.file_name() == ".git" {
      continue;
    }
    let path = entry.path();
    let rel = path
      .strip_prefix(root)
      .unwrap_or(&path)
      .to_string_lossy()
      .replace('\\', "/");
    let meta = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if meta.file_type().is_dir() {
      files.insert(rel, Entry::Dir);
      walk_tree(root, &path, files)?;
    } else if meta.file_type().is_symlink() {
      files.insert(rel, Entry::Link(std::fs::read_link(&path).map_err(|error| error.to_string())?.to_string_lossy().into_owned()));
    } else {
      files.insert(rel, Entry::File(std::fs::read(&path).map_err(|error| error.to_string())?));
    }
  }
  Ok(())
}

fn restore_tree(snapshot: &Path, workspace: &Path) -> Result<(), String> {
  let before = read_tree(snapshot)?;
  let after = read_tree(workspace)?;
  remove_created_git(snapshot, workspace, workspace)?;
  for rel in after.keys() {
    if !before.contains_key(rel) {
      let _ = std::fs::remove_dir_all(workspace.join(rel));
      let _ = std::fs::remove_file(workspace.join(rel));
    }
  }
  for (rel, entry) in &before {
    let target = workspace.join(rel);
    match entry {
      Entry::Dir => {
        std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
      }
      Entry::File(bytes) => {
        if let Some(parent) = target.parent() {
          std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, bytes).map_err(|error| error.to_string())?;
      }
      Entry::Link(link) => {
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_dir_all(&target);
        if let Some(parent) = target.parent() {
          std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(link, &target).map_err(|error| error.to_string())?;
        #[cfg(not(unix))]
        std::fs::write(&target, link).map_err(|error| error.to_string())?;
      }
    }
  }
  Ok(())
}

fn remove_created_git(snapshot: &Path, workspace: &Path, current: &Path) -> Result<(), String> {
  let entries = match std::fs::read_dir(current) {
    Ok(entries) => entries,
    Err(_) => return Ok(()),
  };
  for entry in entries {
    let entry = entry.map_err(|error| error.to_string())?;
    let path = entry.path();
    if entry.file_name() == ".git" {
      let rel = path.strip_prefix(workspace).unwrap_or(&path);
      if !snapshot.join(rel).exists() {
        let _ = std::fs::remove_dir_all(&path);
        let _ = std::fs::remove_file(&path);
      }
      continue;
    }
    if path.is_dir() {
      remove_created_git(snapshot, workspace, &path)?;
    }
  }
  Ok(())
}

fn classify_snapshot(before: &Path, after: &Path) -> Result<Vec<Value>, String> {
  let before_ids = extension_dirs(before)?;
  let after_ids = extension_dirs(after)?;
  let mut ids = BTreeSet::new();
  ids.extend(before_ids.iter().cloned());
  ids.extend(after_ids.iter().cloned());
  let mut changes = Vec::new();
  for id in ids {
    let in_before = before_ids.contains(&id);
    let in_after = after_ids.contains(&id);
    if in_after && !in_before {
      changes.push(json!({ "type": "extension", "extensionId": id, "kind": "created" }));
    } else if in_before && !in_after {
      changes.push(json!({ "type": "extension", "extensionId": id, "kind": "removed" }));
    } else if read_tree(&before.join(&id))? != read_tree(&after.join(&id))? {
      changes.push(json!({ "type": "extension", "extensionId": id, "kind": "updated" }));
    }
  }
  for name in LAYOUT_FILES {
    let before_file = before.join(name);
    let after_file = after.join(name);
    let before_exists = before_file.is_file();
    let after_exists = after_file.is_file();
    if !before_exists && after_exists {
      changes.push(json!({ "type": "layout", "kind": "created" }));
      break;
    }
    if before_exists && !after_exists {
      changes.push(json!({ "type": "layout", "kind": "removed" }));
      break;
    }
    if before_exists && after_exists && std::fs::read(&before_file).ok() != std::fs::read(&after_file).ok() {
      changes.push(json!({ "type": "layout", "kind": "updated" }));
      break;
    }
  }
  Ok(changes)
}

fn extension_dirs(dir: &Path) -> Result<BTreeSet<String>, String> {
  let mut ids = BTreeSet::new();
  let entries = match std::fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(_) => return Ok(ids),
  };
  for entry in entries {
    let entry = entry.map_err(|error| error.to_string())?;
    if !entry.path().is_dir() {
      continue;
    }
    let name = entry.file_name().to_string_lossy().into_owned();
    if NON_EXTENSION_DIRS.contains(&name.as_str()) || name.starts_with('.') {
      continue;
    }
    ids.insert(name);
  }
  Ok(ids)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn snapshot_rollback_restores_pre_turn_files() {
    let dir = std::env::temp_dir().join(format!("hatch-session-{}", std::process::id()));
    let workspace = dir.join("extensions");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("existing.txt"), "before\n").unwrap();
    let mut session = SnapshotSession::begin(&workspace, &dir.join("snaps")).unwrap();
    std::fs::write(workspace.join("existing.txt"), "after\n").unwrap();
    std::fs::create_dir_all(workspace.join("demo")).unwrap();
    std::fs::write(workspace.join("demo/widget.tsx"), "export const widget = true;\n").unwrap();
    assert!(session.has_changes().unwrap());
    let changes = session.describe_changes().unwrap();
    assert!(changes.iter().any(|change| change["extensionId"] == "demo" && change["kind"] == "created"));
    let result = session.rollback().unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(std::fs::read_to_string(workspace.join("existing.txt")).unwrap(), "before\n");
    assert!(!workspace.join("demo").exists());
  }

  #[test]
  fn git_session_commits_and_rolls_back() {
    let dir = std::env::temp_dir().join(format!("hatch-git-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("extensions")).unwrap();
    std::fs::write(dir.join("README.md"), "start\n").unwrap();
    git_run(&dir, &["init", "-b", "main"]).unwrap();
    git_run(&dir, &["config", "user.email", "tests@example.com"]).unwrap();
    git_run(&dir, &["config", "user.name", "Hatch"]).unwrap();
    git_run(&dir, &["add", "--all"]).unwrap();
    git_run(&dir, &["commit", "-m", "initial"]).unwrap();
    let mut session = GitSession::begin(&dir, &dir.join("extensions")).unwrap();
    assert!(session.started_clean);
    std::fs::write(dir.join("README.md"), "changed\n").unwrap();
    let rolled = session.rollback().unwrap();
    assert_eq!(rolled["ok"], true);
    assert_eq!(std::fs::read_to_string(dir.join("README.md")).unwrap(), "start\n");
    let mut session = GitSession::begin(&dir, &dir.join("extensions")).unwrap();
    std::fs::write(dir.join("README.md"), "changed\n").unwrap();
    let saved = session.save("keep it").unwrap();
    assert_eq!(saved["ok"], true);
    assert_eq!(git_text(&dir, &["log", "-1", "--pretty=%s"]).unwrap(), "keep it");
  }
}
