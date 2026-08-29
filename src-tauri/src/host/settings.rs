use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

#[derive(Clone)]
pub struct HostSettings {
  preferences_path: PathBuf,
  agents_path: PathBuf,
}

impl HostSettings {
  pub fn open(preferences_path: PathBuf, agents_path: PathBuf) -> Self {
    Self {
      preferences_path,
      agents_path,
    }
  }

  pub fn get(&self) -> Result<Value, String> {
    let preferences = self.read_preferences();
    let custom_agents = self.read_agents();
    let mut agents = builtin_agents();
    if let Value::Array(custom) = custom_agents {
      agents.extend(custom);
    }
    let agent_name = preferences
      .get("agentName")
      .and_then(Value::as_str)
      .unwrap_or("")
      .to_string();
    Ok(json!({
      "openAtLogin": preferences.get("openAtLogin").and_then(Value::as_bool).unwrap_or(false),
      "agentName": agent_name,
      "agents": agents,
    }))
  }

  pub fn set_open_at_login(&self, open_at_login: bool) -> Result<Value, String> {
    let mut preferences = self.read_preferences();
    preferences["openAtLogin"] = json!(open_at_login);
    self.write_json(&self.preferences_path, &preferences)?;
    self.get()
  }

  pub fn set_agent(&self, agent_name: &str) -> Result<Value, String> {
    let mut preferences = self.read_preferences();
    preferences["agentName"] = json!(agent_name);
    self.write_json(&self.preferences_path, &preferences)?;
    self.get()
  }

  pub fn add_agent(&self, input: Value) -> Result<Value, String> {
    let mut agents = match self.read_agents() {
      Value::Array(items) => items,
      _ => Vec::new(),
    };
    let name = input.get("name").and_then(Value::as_str).unwrap_or("").trim();
    let command = input.get("command").and_then(Value::as_str).unwrap_or("").trim();
    if name.is_empty() || command.is_empty() {
      return Err("name and command are required".into());
    }
    agents.push(json!({
      "name": name,
      "label": input.get("label").and_then(Value::as_str).unwrap_or(name),
      "command": command,
      "available": true,
      "custom": true,
    }));
    self.write_json(&self.agents_path, &Value::Array(agents))?;
    self.get()
  }

  pub fn update_agent(&self, name: &str, input: Value) -> Result<Value, String> {
    let mut agents = match self.read_agents() {
      Value::Array(items) => items,
      _ => Vec::new(),
    };
    for agent in &mut agents {
      if agent.get("name").and_then(Value::as_str) == Some(name) {
        if let Some(label) = input.get("label") {
          agent["label"] = label.clone();
        }
        if let Some(command) = input.get("command") {
          agent["command"] = command.clone();
        }
      }
    }
    self.write_json(&self.agents_path, &Value::Array(agents))?;
    self.get()
  }

  pub fn remove_agent(&self, name: &str) -> Result<Value, String> {
    let agents = match self.read_agents() {
      Value::Array(items) => items
        .into_iter()
        .filter(|agent| agent.get("name").and_then(Value::as_str) != Some(name))
        .collect(),
      _ => Vec::new(),
    };
    self.write_json(&self.agents_path, &Value::Array(agents))?;
    self.get()
  }

  fn read_preferences(&self) -> Value {
    self.read_json(&self.preferences_path).unwrap_or_else(|| json!({ "openAtLogin": false }))
  }

  fn read_agents(&self) -> Value {
    self.read_json(&self.agents_path).unwrap_or_else(|| json!([]))
  }

  fn read_json(&self, path: &PathBuf) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
  }

  fn write_json(&self, path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())
  }
}

fn builtin_agents() -> Vec<Value> {
  vec![
    json!({
      "name": "claude",
      "label": "Claude Code",
      "available": command_available("claude"),
      "installHint": "Install the Claude Code CLI, then restart Hatch."
    }),
    json!({
      "name": "codex",
      "label": "Codex",
      "available": command_available("codex"),
      "installHint": "Install the Codex CLI, then restart Hatch."
    }),
    json!({
      "name": "grok",
      "label": "Grok",
      "available": command_available("grok"),
      "installHint": "Install the Grok CLI, then restart Hatch."
    }),
  ]
}

fn command_available(command: &str) -> bool {
  std::process::Command::new("sh")
    .args(["-c", "command -v \"$1\"", "sh", command])
    .status()
    .map(|status| status.success())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lists_grok_as_a_built_in_native_acp_agent() {
    let grok = builtin_agents()
      .into_iter()
      .find(|agent| agent["name"] == "grok")
      .unwrap();
    assert_eq!(grok["label"], "Grok");
    assert!(grok.get("available").and_then(Value::as_bool).is_some());
  }
}
