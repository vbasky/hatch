use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Clone)]
pub struct SidecarClient {
  requests: mpsc::UnboundedSender<(String, Value, oneshot::Sender<Result<Value, String>>)>,
}

struct Pending {
  map: HashMap<String, oneshot::Sender<Result<Value, String>>>,
}

pub async fn spawn_sidecar(
  node: std::path::PathBuf,
  host_js: std::path::PathBuf,
  host_root: std::path::PathBuf,
  resources_path: Option<std::path::PathBuf>,
  version: String,
  product_name: String,
  packaged: bool,
  on_event: impl Fn(String, Value) + Send + Sync + 'static,
) -> Result<(SidecarClient, Child), String> {
  if let Ok(mut log) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open("/tmp/baby-menu-tauri-sidecar.log")
  {
    use std::io::Write;
    let _ = writeln!(
      log,
      "spawn node={node:?} host_js={host_js:?} host_root={host_root:?} packaged={packaged} product={product_name}"
    );
  }
  let mut command = Command::new(&node);
  command
    .arg(&host_js)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .current_dir(&host_root)
    .env("BABY_MENU_HOST_ROOT", &host_root)
    .env("BABY_MENU_VERSION", version)
    .env("BABY_MENU_PRODUCT_NAME", &product_name)
    .kill_on_drop(true);
  if packaged {
    command.env("BABY_MENU_PACKAGED", "1");
    if let Some(resources) = resources_path {
      command.env("BABY_MENU_RESOURCES_PATH", resources);
    }
  }

  let mut child = command.spawn().map_err(|error| error.to_string())?;
  let mut stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
  let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;

  let pending = Arc::new(Mutex::new(Pending { map: HashMap::new() }));
  let (tx, mut rx) = mpsc::unbounded_channel::<(String, Value, oneshot::Sender<Result<Value, String>>)>();
  let ids = Arc::new(AtomicU64::new(1));

  let writer_pending = pending.clone();
  tokio::spawn(async move {
    while let Some((channel, args, reply)) = rx.recv().await {
      let id = ids.fetch_add(1, Ordering::Relaxed).to_string();
      writer_pending.lock().await.map.insert(id.clone(), reply);
      let payload = json!({ "id": id, "type": "request", "channel": channel, "args": args });
      let line = format!("{payload}\n");
      if stdin.write_all(line.as_bytes()).await.is_err() {
        break;
      }
    }
  });

  tokio::spawn(async move {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => continue,
      };
      match parsed.get("type").and_then(Value::as_str) {
        Some("event") => {
          if let (Some(channel), Some(payload)) = (
            parsed.get("channel").and_then(Value::as_str),
            parsed.get("payload").cloned(),
          ) {
            on_event(channel.to_string(), payload);
          }
        }
        Some("response") => {
          if let Some(id) = parsed.get("id").and_then(Value::as_str) {
            if let Some(reply) = pending.lock().await.map.remove(id) {
              let result = if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
              } else {
                Err(
                  parsed
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("sidecar error")
                    .to_string(),
                )
              };
              let _ = reply.send(result);
            }
          }
        }
        _ => {}
      }
    }
  });

  Ok((SidecarClient { requests: tx }, child))
}

impl SidecarClient {
  pub async fn invoke(&self, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let (tx, rx) = oneshot::channel();
    self
      .requests
      .send((channel, Value::Array(args), tx))
      .map_err(|_| "sidecar writer closed".to_string())?;
    rx.await.map_err(|_| "sidecar response dropped".to_string())?
  }
}
