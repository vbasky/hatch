use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const PROTOCOL_VERSION: u16 = 1;

pub struct AcpClient {
  child: Child,
  stdin: ChildStdin,
  stdout: BufReader<ChildStdout>,
  next_id: i64,
  cwd: PathBuf,
}

impl AcpClient {
  pub fn spawn(argv: &[String], cwd: &Path) -> Result<Self, String> {
    if argv.is_empty() {
      return Err("ACP launch command is empty".into());
    }
    let mut command = Command::new(&argv[0]);
    if argv.len() > 1 {
      command.args(&argv[1..]);
    }
    command
      .current_dir(cwd)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::inherit());
    let mut child = command
      .spawn()
      .map_err(|error| format!("failed to launch ACP agent `{}`: {error}", argv[0]))?;
    let stdin = child.stdin.take().ok_or("ACP agent stdin missing")?;
    let stdout = child.stdout.take().ok_or("ACP agent stdout missing")?;
    Ok(Self {
      child,
      stdin,
      stdout: BufReader::new(stdout),
      next_id: 1,
      cwd: cwd.to_path_buf(),
    })
  }

  pub fn initialize(&mut self) -> Result<Value, String> {
    self.request(
      "initialize",
      json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientInfo": { "name": "hatch", "version": "0.1.24" },
        "clientCapabilities": {
          "fs": { "readTextFile": true, "writeTextFile": true },
          "terminal": false
        }
      }),
      Duration::from_secs(30),
      &mut |_| {},
    )
  }

  pub fn new_session(&mut self) -> Result<String, String> {
    let result = self.request(
      "session/new",
      json!({
        "cwd": self.cwd,
        "mcpServers": [],
        "_meta": { "yoloMode": true }
      }),
      Duration::from_secs(60),
      &mut |_| {},
    )?;
    result
      .get("sessionId")
      .and_then(Value::as_str)
      .map(str::to_string)
      .ok_or_else(|| format!("session/new missing sessionId: {result}"))
  }

  pub fn prompt(
    &mut self,
    session_id: &str,
    text: &str,
    timeout: Duration,
    on_text: &mut dyn FnMut(&str),
  ) -> Result<String, String> {
    let mut collected = String::new();
    let mut sink = |chunk: &str| {
      collected.push_str(chunk);
      on_text(chunk);
    };
    let result = self.request(
      "session/prompt",
      json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": text }]
      }),
      timeout,
      &mut sink,
    )?;
    if collected.trim().is_empty() {
      if let Some(message) = result.get("message").and_then(Value::as_str) {
        collected.push_str(message);
      }
    }
    Ok(collected)
  }

  fn request(
    &mut self,
    method: &str,
    params: Value,
    timeout: Duration,
    on_text: &mut dyn FnMut(&str),
  ) -> Result<Value, String> {
    let id = self.next_id;
    self.next_id += 1;
    let message = json!({
      "jsonrpc": "2.0",
      "id": id,
      "method": method,
      "params": params
    });
    writeln!(self.stdin, "{message}").map_err(|error| error.to_string())?;
    self.stdin.flush().map_err(|error| error.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
      if Instant::now() >= deadline {
        return Err(format!("ACP `{method}` timed out"));
      }
      let remaining = deadline.saturating_duration_since(Instant::now());
      if remaining.is_zero() {
        return Err(format!("ACP `{method}` timed out"));
      }
      let mut line = String::new();
      let bytes = self.stdout.read_line(&mut line).map_err(|error| error.to_string())?;
      if bytes == 0 {
        return Err(format!("ACP agent closed stdout during `{method}`"));
      }
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      let parsed: Value = serde_json::from_str(trimmed).map_err(|error| format!("invalid ACP JSON: {error}: {trimmed}"))?;
      if parsed.get("method").and_then(Value::as_str) == Some("session/update") {
        if let Some(text) = extract_agent_text(&parsed) {
          on_text(&text);
        }
        continue;
      }
      if parsed.get("id").is_some() && parsed.get("method").is_some() {
        self.handle_agent_request(&parsed)?;
        continue;
      }
      if parsed.get("id") == Some(&json!(id)) {
        if let Some(error) = parsed.get("error") {
          let message = error.get("message").and_then(Value::as_str).unwrap_or("ACP request failed");
          return Err(message.to_string());
        }
        return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
      }
    }
  }

  fn handle_agent_request(&mut self, message: &Value) -> Result<(), String> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
      "session/request_permission" => approve_permission(&params),
      "fs/read_text_file" => read_text_file(&params),
      "fs/write_text_file" => write_text_file(&params),
      other => {
        return self.respond(
          id,
          None,
          Some(json!({ "code": -32601, "message": format!("Unsupported client method {other}") })),
        );
      }
    };
    match result {
      Ok(value) => self.respond(id, Some(value), None),
      Err(message) => self.respond(id, None, Some(json!({ "code": -32000, "message": message }))),
    }
  }

  fn respond(&mut self, id: Value, result: Option<Value>, error: Option<Value>) -> Result<(), String> {
    let mut payload = json!({ "jsonrpc": "2.0", "id": id });
    if let Some(error) = error {
      payload["error"] = error;
    } else {
      payload["result"] = result.unwrap_or(Value::Null);
    }
    writeln!(self.stdin, "{payload}").map_err(|error| error.to_string())?;
    self.stdin.flush().map_err(|error| error.to_string())
  }
}

impl Drop for AcpClient {
  fn drop(&mut self) {
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

fn extract_agent_text(message: &Value) -> Option<String> {
  let update = message.pointer("/params/update")?;
  let kind = update.get("sessionUpdate").and_then(Value::as_str)?;
  if kind != "agent_message_chunk" {
    return None;
  }
  update.pointer("/content/text")?.as_str().map(str::to_string)
}

fn approve_permission(params: &Value) -> Result<Value, String> {
  let options = params.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
  let chosen = options
    .iter()
    .find(|option| matches!(option.get("kind").and_then(Value::as_str), Some("allow_always" | "allow_once")))
    .or_else(|| options.first());
  let option_id = chosen
    .and_then(|option| option.get("optionId"))
    .cloned()
    .unwrap_or_else(|| json!("allow"));
  Ok(json!({
    "outcome": {
      "outcome": "selected",
      "optionId": option_id
    }
  }))
}

fn read_text_file(params: &Value) -> Result<Value, String> {
  let path = params.get("path").and_then(Value::as_str).ok_or("fs/read_text_file missing path")?;
  let content = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
  Ok(json!({ "content": content }))
}

fn write_text_file(params: &Value) -> Result<Value, String> {
  let path = params.get("path").and_then(Value::as_str).ok_or("fs/write_text_file missing path")?;
  let content = params.get("content").and_then(Value::as_str).unwrap_or("");
  if let Some(parent) = Path::new(path).parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  std::fs::write(path, content).map_err(|error| error.to_string())?;
  Ok(json!({}))
}

pub fn split_command(command: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut current = String::new();
  let mut quote = None::<char>;
  for ch in command.chars() {
    match (quote, ch) {
      (None, '"' | '\'') => quote = Some(ch),
      (Some(mark), ch) if ch == mark => quote = None,
      (None, ch) if ch.is_whitespace() => {
        if !current.is_empty() {
          out.push(std::mem::take(&mut current));
        }
      }
      (_, ch) => current.push(ch),
    }
  }
  if !current.is_empty() {
    out.push(current);
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn splits_quoted_launch_commands() {
    assert_eq!(
      split_command(r#"node "./adapter with space/index.mjs""#),
      vec!["node", "./adapter with space/index.mjs"]
    );
  }

  #[test]
  fn talks_ndjson_acp_to_a_fake_agent() {
    let dir = std::env::temp_dir().join(format!("hatch-acp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
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
  if (msg.method === "initialize") {
    reply({ protocolVersion: 1, agentCapabilities: { loadSession: false } });
  } else if (msg.method === "session/new") {
    reply({ sessionId: "sess-1" });
  } else if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from acp" } }
      }
    }) + "\n");
    reply({ stopReason: "end_turn" });
  }
});
"#,
    )
    .unwrap();
    let mut client = AcpClient::spawn(
      &["node".into(), script.to_string_lossy().into_owned()],
      &dir,
    )
    .unwrap();
    client.initialize().unwrap();
    let session = client.new_session().unwrap();
    let mut chunks = String::new();
    let text = client
      .prompt(&session, "hi", Duration::from_secs(5), &mut |chunk| chunks.push_str(chunk))
      .unwrap();
    assert_eq!(text, "hello from acp");
    assert_eq!(chunks, "hello from acp");
  }
}
