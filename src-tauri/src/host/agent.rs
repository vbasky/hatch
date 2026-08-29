use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::acp::{split_command, AcpClient};
use super::session::ChangeSession;
use super::settings::HostSettings;

const DEFAULT_TIMEOUT_MS: u64 = 300_000;

pub struct AgentRuntime {
  settings: HostSettings,
  extensions_dir: PathBuf,
  root: PathBuf,
  packaged: bool,
  adapter_dir: Option<PathBuf>,
  snapshot_dir: PathBuf,
  forced_command: Option<Vec<String>>,
  running: AtomicBool,
  active_turn: Mutex<Option<Value>>,
  session: Mutex<Option<LiveSession>>,
  change: Mutex<Option<ChangeSession>>,
}

struct LiveSession {
  client: AcpClient,
  session_id: String,
}

impl AgentRuntime {
  pub fn new(
    settings: HostSettings,
    extensions_dir: PathBuf,
    root: PathBuf,
    packaged: bool,
    adapter_dir: Option<PathBuf>,
    snapshot_dir: PathBuf,
    forced_command: Option<Vec<String>>,
  ) -> Self {
    Self {
      settings,
      extensions_dir,
      root,
      packaged,
      adapter_dir,
      snapshot_dir,
      forced_command,
      running: AtomicBool::new(false),
      active_turn: Mutex::new(None),
      session: Mutex::new(None),
      change: Mutex::new(None),
    }
  }

  pub fn active_turn(&self) -> Value {
    self.active_turn.lock().ok().and_then(|guard| guard.clone()).unwrap_or(Value::Null)
  }

  pub fn send(&self, prompt: &str, on_status: &dyn Fn(&str, Value)) -> Result<Value, String> {
    if self.running.swap(true, Ordering::SeqCst) {
      return Ok(json!({
        "assistantText": "An agent turn is already running. Wait for it to finish before asking again."
      }));
    }
    let title = prompt.trim();
    let started_at = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_millis() as u64)
      .unwrap_or(0);
    *self.active_turn.lock().map_err(|error| error.to_string())? = Some(json!({
      "title": title,
      "startedAt": started_at
    }));
    let result = self.run_send(prompt, on_status);
    self.running.store(false, Ordering::SeqCst);
    *self.active_turn.lock().map_err(|error| error.to_string())? = None;
    result
  }

  pub fn save(&self, message: Option<&str>) -> Result<Value, String> {
    let mut slot = self.change.lock().map_err(|error| error.to_string())?;
    let Some(session) = slot.as_mut() else {
      return Ok(json!({ "ok": false, "reason": "No active agent change session" }));
    };
    let result = session.save(message)?;
    if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
      *slot = None;
    }
    Ok(result)
  }

  pub fn rollback(&self) -> Result<Value, String> {
    let mut slot = self.change.lock().map_err(|error| error.to_string())?;
    let Some(session) = slot.as_mut() else {
      return Ok(json!({ "ok": false, "reason": "No active agent change session" }));
    };
    let result = session.rollback()?;
    if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
      *slot = None;
    }
    Ok(result)
  }

  pub fn status(&self) -> Result<Value, String> {
    if self.running.load(Ordering::SeqCst) {
      return Ok(Value::Null);
    }
    let slot = self.change.lock().map_err(|error| error.to_string())?;
    let Some(session) = slot.as_ref() else {
      return Ok(Value::Null);
    };
    if !session.can_apply() {
      return Ok(Value::Null);
    }
    let dirty = session.has_changes()?;
    if !dirty {
      return Ok(Value::Null);
    }
    let changes = session.describe_changes()?;
    Ok(session.snapshot("Review the generated changes, then Save or Rollback.", Some(true), Some(changes)))
  }

  fn run_send(&self, prompt: &str, on_status: &dyn Fn(&str, Value)) -> Result<Value, String> {
    let change = ChangeSession::begin(
      self.packaged,
      &self.root,
      &self.extensions_dir,
      &self.snapshot_dir,
    )?;
    if !change.started_clean() {
      return Ok(json!({
        "assistantText": "I cannot start an editing session because the git working tree is already dirty. Commit or stash those changes first so Save and Rollback can stay safe.",
        "session": change.snapshot("Working tree was dirty before the agent started.", Some(true), None)
      }));
    }

    let timeout = agent_timeout();
    let command = self.resolve_launch_command()?;
    let cwd = self.extensions_dir.clone();
    std::fs::create_dir_all(&cwd).map_err(|error| error.to_string())?;
    let mut session = self.session.lock().map_err(|error| error.to_string())?;
    if session.as_ref().is_none() {
      let mut client = AcpClient::spawn(&command, &cwd)?;
      client.initialize()?;
      let session_id = client.new_session()?;
      *session = Some(LiveSession { client, session_id });
    }
    let live = session.as_mut().ok_or("ACP session missing")?;
    let mut last_status = String::new();
    let text = match live.client.prompt(&live.session_id.clone(), &wrap_prompt(prompt), timeout, &mut |chunk| {
      last_status.push_str(chunk);
      if let Some(status) = latest_status_line(&last_status) {
        on_status("hatch:agent:status", json!({ "text": status, "eventType": "text_delta" }));
      }
    }) {
      Ok(text) => text,
      Err(error) => {
        *session = None;
        drop(session);
        return self.finish_turn(change, error, true);
      }
    };
    drop(session);
    let assistant = text.trim();
    let message = if assistant.is_empty() {
      "Agent finished without a text response."
    } else {
      assistant
    };
    self.finish_turn(change, message.to_string(), false)
  }

  fn finish_turn(&self, mut change: ChangeSession, assistant: String, failed: bool) -> Result<Value, String> {
    let dirty = change.has_changes().unwrap_or(false);
    let changes = change.describe_changes().unwrap_or_default();
    if !dirty {
      let _ = change.save(None);
      *self.change.lock().map_err(|error| error.to_string())? = None;
      return Ok(json!({
        "assistantText": assistant,
        "session": change.snapshot("Review the generated repo changes, then Save or Rollback.", Some(false), Some(changes))
      }));
    }
    let snapshot = change.snapshot(
      if failed {
        "Agent failed. Review any partial repo changes, then Save or Rollback."
      } else {
        "Review the generated repo changes, then Save or Rollback."
      },
      Some(true),
      Some(changes),
    );
    *self.change.lock().map_err(|error| error.to_string())? = Some(change);
    Ok(json!({
      "assistantText": assistant,
      "session": snapshot
    }))
  }

  fn resolve_launch_command(&self) -> Result<Vec<String>, String> {
    if let Some(command) = &self.forced_command {
      if !command.is_empty() {
        return Ok(command.clone());
      }
    }
    if let Ok(command) = std::env::var("HATCH_ACP_COMMAND") {
      let argv = split_command(command.trim());
      if !argv.is_empty() {
        return Ok(argv);
      }
    }
    let settings = self.settings.get()?;
    let configured = settings
      .get("agentName")
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|name| !name.is_empty())
      .map(str::to_string)
      .or_else(|| std::env::var("HATCH_AGENT").ok().map(|name| name.trim().to_string()).filter(|name| !name.is_empty()));
    let agents = settings.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
    let name = configured.or_else(|| {
      agents
        .iter()
        .find(|agent| agent.get("available").and_then(Value::as_bool).unwrap_or(true))
        .and_then(|agent| agent.get("name").and_then(Value::as_str).map(str::to_string))
    });
    let Some(name) = name else {
      return Err("No ACP agent is configured. Add one in Settings.".into());
    };
    if let Some(custom) = agents.iter().find(|agent| {
      agent.get("name").and_then(Value::as_str) == Some(name.as_str()) && agent.get("custom").and_then(Value::as_bool).unwrap_or(false)
    }) {
      if let Some(command) = custom.get("command").and_then(Value::as_str) {
        let argv = split_command(command);
        if !argv.is_empty() {
          return Ok(argv);
        }
      }
    }
    self.builtin_command(&name)
  }

  fn builtin_command(&self, name: &str) -> Result<Vec<String>, String> {
    if name == "grok" {
      return Ok(grok_stdio_command());
    }
    let adapter = match name {
      "claude" | "codex" => name,
      other => return Ok(split_command(other)),
    };
    if let Some(adapter_dir) = &self.adapter_dir {
      let entry = adapter_dir.join(adapter).join("index.mjs");
      if entry.is_file() {
        return Ok(vec![resolve_node(), entry.to_string_lossy().into_owned()]);
      }
    }
    let fallback = self.root.join("out/adapters").join(adapter).join("index.mjs");
    if fallback.is_file() {
      return Ok(vec![resolve_node(), fallback.to_string_lossy().into_owned()]);
    }
    Ok(vec![adapter.to_string()])
  }
}

pub fn grok_stdio_command() -> Vec<String> {
  vec![
    resolve_cli("grok"),
    "agent".into(),
    "--always-approve".into(),
    "stdio".into(),
  ]
}

pub fn resolve_node() -> String {
  resolve_cli("node")
}

pub fn resolve_cli(name: &str) -> String {
  if command_exists(name) {
    return name.into();
  }
  let home = std::env::var("HOME").unwrap_or_default();
  let candidates = [
    format!("/opt/homebrew/bin/{name}"),
    format!("/usr/local/bin/{name}"),
    format!("{home}/.local/bin/{name}"),
    format!("{home}/.grok/bin/{name}"),
  ];
  for candidate in candidates {
    if Path::new(&candidate).is_file() {
      return candidate;
    }
  }
  name.into()
}

fn command_exists(command: &str) -> bool {
  std::process::Command::new("sh")
    .args(["-c", "command -v \"$1\"", "sh", command])
    .status()
    .map(|status| status.success())
    .unwrap_or(false)
}

fn agent_timeout() -> Duration {
  let ms = std::env::var("HATCH_AGENT_TIMEOUT_MS")
    .ok()
    .and_then(|value| value.parse::<u64>().ok())
    .filter(|value| *value > 0)
    .unwrap_or(DEFAULT_TIMEOUT_MS);
  Duration::from_millis(ms)
}

fn latest_status_line(text: &str) -> Option<String> {
  text
    .lines()
    .rev()
    .map(str::trim)
    .find(|line| !line.is_empty())
    .map(str::to_string)
}

fn wrap_prompt(prompt: &str) -> String {
  let mode = if Path::new("extensions-dev").exists() {
    "dev mode"
  } else {
    "the Hatch extension workspace"
  };
  format!(
    "{prompt}

You are editing the hatch repository in {mode}.
Prefer small, focused changes in your current extension workspace.
Build self-contained extensions under <extension-id>/ inside your current extension workspace so they can be shared as a directory behind the stable window.hatch bridge.
For recipe-backed widgets, read the matching self-contained spec from recipes/ before editing.
Do not modify files outside your current extension workspace unless the user explicitly asks.
Renderer widgets should call privileged work with window.hatch.capabilities.invoke(extensionId, action, input).
Extension server actions live in server.ts files and export an actions object.
Do not add new preload methods or one-off IPC method names for each widget.
Put privileged filesystem, shell, network, credential, and token work behind an extension-owned server action that is invoked through a stable generic capability bridge.
Do not write test files, and do not write README or other documentation files for extensions.
When a widget or server action surfaces live or system data - local files, command output, credentials, or an API response - inspect that actual source directly (read the real file, run the real command, call the real endpoint) to confirm its true current shape before writing any parsing or rendering code; never guess or pattern-complete a field name or response shape from memory or documentation.
Treat live-source verification as a targeted, read-only check against a specific known source already named by the recipe or server code - a known credential file, known command, or known endpoint - not permission to run broad or recursive searches outside the extension workspace.
If inspecting a source that can contain secrets, print only non-secret metadata or explicitly redacted placeholders; never echo raw tokens, credential blobs, cookies, auth headers, or secret-bearing payloads to stdout, the agent transcript, logs, or the widget UI.
Before reporting the work done, verify the finished widget against that same live data yourself: run the server action (or an equivalent one-off check) against the real source and confirm the exact value you expect actually renders - reasoning about the return shape on paper is not enough."
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::host::settings::HostSettings;

  #[test]
  fn send_collects_text_from_a_fake_acp_agent() {
    let dir = std::env::temp_dir().join(format!("hatch-agent-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("extensions")).unwrap();
    let script = dir.join("fake-acp.mjs");
    std::fs::write(
      &script,
      r#"
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  if (msg.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: false } });
  else if (msg.method === "session/new") reply({ sessionId: "s1" });
  else if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "built it" } } } }) + "\n");
    reply({ stopReason: "end_turn" });
  }
});
"#,
    )
    .unwrap();
    let settings = HostSettings::open(dir.join("preferences.json"), dir.join("agents.json"));
    let runtime = AgentRuntime::new(
      settings,
      dir.join("extensions"),
      dir.clone(),
      false,
      None,
      dir.join("snaps"),
      Some(vec!["node".into(), script.to_string_lossy().into_owned()]),
    );
    let result = runtime.send("hello", &|_, _| {}).unwrap();
    assert_eq!(result["assistantText"], "built it");
    assert_eq!(result["session"]["dirty"], false);
    assert!(runtime.active_turn().is_null());
  }

  #[test]
  fn keep_and_undo_snapshot_changes_from_an_agent_turn() {
    let dir = std::env::temp_dir().join(format!("hatch-agent-change-{}", std::process::id()));
    let workspace = dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("keep.txt"), "before\n").unwrap();
    let script = dir.join("fake-acp.mjs");
    std::fs::write(
      &script,
      r#"
import fs from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  if (msg.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: false } });
  else if (msg.method === "session/new") reply({ sessionId: "s1" });
  else if (msg.method === "session/prompt") {
    fs.writeFileSync("keep.txt", "after\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "edited" } } } }) + "\n");
    reply({ stopReason: "end_turn" });
  }
});
"#,
    )
    .unwrap();
    let settings = HostSettings::open(dir.join("preferences.json"), dir.join("agents.json"));
    let runtime = AgentRuntime::new(
      settings,
      workspace.clone(),
      dir.clone(),
      true,
      None,
      dir.join("snaps"),
      Some(vec!["node".into(), script.to_string_lossy().into_owned()]),
    );
    let result = runtime.send("edit", &|_, _| {}).unwrap();
    assert_eq!(result["session"]["dirty"], true);
    assert_eq!(std::fs::read_to_string(workspace.join("keep.txt")).unwrap(), "after\n");
    let undone = runtime.rollback().unwrap();
    assert_eq!(undone["ok"], true);
    assert_eq!(std::fs::read_to_string(workspace.join("keep.txt")).unwrap(), "before\n");
  }

  #[test]
  fn grok_uses_the_native_cli_stdio_entry_not_node() {
    let argv = grok_stdio_command();
    assert_eq!(argv[1], "agent");
    assert_eq!(argv[2], "--always-approve");
    assert_eq!(argv[3], "stdio");
    assert!(!argv.iter().any(|part| part.contains("node") || part.ends_with(".mjs")));
  }
}
