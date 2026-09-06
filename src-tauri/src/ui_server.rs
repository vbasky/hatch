use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::protocol;

pub type RpcHandler = Arc<dyn Fn(String, Vec<Value>) -> tokio::sync::oneshot::Receiver<Result<Value, String>> + Send + Sync>;

pub struct UiServerConfig {
  pub ui_root: PathBuf,
  pub widget_cache_dir: PathBuf,
  pub rpc: RpcHandler,
  pub bind: Option<String>,
}

pub async fn bind_ui_server(config: UiServerConfig) -> Result<(u16, tokio::task::JoinHandle<()>), String> {
  let bind = config.bind.as_deref().unwrap_or("127.0.0.1:0");
  let listener = TcpListener::bind(bind)
    .await
    .map_err(|error| error.to_string())?;
  let port = listener.local_addr().map_err(|error| error.to_string())?.port();
  let handle = tokio::spawn(async move {
    loop {
      let Ok((mut stream, _)) = listener.accept().await else {
        continue;
      };
      let config = UiServerConfig {
        ui_root: config.ui_root.clone(),
        widget_cache_dir: config.widget_cache_dir.clone(),
        rpc: config.rpc.clone(),
        bind: config.bind.clone(),
      };
      tokio::spawn(async move {
        let Ok((method, path, body)) = read_http_message(&mut stream).await else {
          return;
        };
        let (status, content_type, body) = if method == "POST" && path.starts_with("/__rpc") {
          match handle_rpc(&config, &body).await {
            Ok(body) => (200, "application/json; charset=utf-8", body),
            Err(error) => (
              500,
              "application/json; charset=utf-8",
              json!({ "ok": false, "error": error }).to_string().into_bytes(),
            ),
          }
        } else if method == "OPTIONS" {
          (204, "text/plain", Vec::new())
        } else {
          match read_request(&config, &path) {
            Ok((content_type, body)) => (200, content_type, body),
            Err(_) => (404, "text/plain", b"not found".to_vec()),
          }
        };
        let reason = if status == 200 || status == 204 { "OK" } else if status == 404 { "Not Found" } else { "Error" };
        let header = format!(
          "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\naccess-control-allow-origin: *\r\naccess-control-allow-headers: content-type\r\naccess-control-allow-methods: GET,POST,OPTIONS\r\ncache-control: no-store\r\nconnection: close\r\n\r\n",
          body.len()
        );
        let _ = stream.write_all(header.as_bytes()).await;
        let _ = stream.write_all(&body).await;
      });
    }
  });
  Ok((port, handle))
}

async fn read_http_message(stream: &mut tokio::net::TcpStream) -> Result<(String, String, Vec<u8>), ()> {
  let mut buf = Vec::new();
  let mut chunk = vec![0_u8; 8192];
  loop {
    let n = stream.read(&mut chunk).await.map_err(|_| ())?;
    if n == 0 {
      break;
    }
    buf.extend_from_slice(&chunk[..n]);
    let Some(header_end) = find_header_end(&buf) else {
      if buf.len() > 1024 * 1024 {
        return Err(());
      }
      continue;
    };
    let headers = std::str::from_utf8(&buf[..header_end]).map_err(|_| ())?.to_string();
    let content_length = content_length_of(&headers);
    let body_start = header_end + if buf[header_end..].starts_with(b"\r\n\r\n") { 4 } else { 2 };
    while buf.len() < body_start + content_length {
      let n = stream.read(&mut chunk).await.map_err(|_| ())?;
      if n == 0 {
        break;
      }
      buf.extend_from_slice(&chunk[..n]);
    }
    let first = headers.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let body = buf.get(body_start..body_start + content_length).unwrap_or(&[]).to_vec();
    return Ok((method, path, body));
  }
  Err(())
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
  buf.windows(4).position(|window| window == b"\r\n\r\n").or_else(|| buf.windows(2).position(|window| window == b"\n\n"))
}

fn content_length_of(headers: &str) -> usize {
  headers
    .lines()
    .find_map(|line| {
      let (name, value) = line.split_once(':')?;
      if name.eq_ignore_ascii_case("content-length") {
        value.trim().parse().ok()
      } else {
        None
      }
    })
    .unwrap_or(0)
}

async fn handle_rpc(config: &UiServerConfig, body: &[u8]) -> Result<Vec<u8>, String> {
  let parsed: Value = serde_json::from_slice(body).map_err(|error| error.to_string())?;
  let channel = parsed
    .get("channel")
    .and_then(Value::as_str)
    .ok_or_else(|| "missing channel".to_string())?
    .to_string();
  let args = parsed
    .get("args")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
  let rx = (config.rpc)(channel, args);
  let result = rx.await.map_err(|_| "rpc dropped".to_string())?;
  match result {
    Ok(value) => Ok(json!({ "ok": true, "result": value }).to_string().into_bytes()),
    Err(error) => Ok(json!({ "ok": false, "error": error }).to_string().into_bytes()),
  }
}

fn read_request(config: &UiServerConfig, request_path: &str) -> Result<(&'static str, Vec<u8>), ()> {
  if request_path.starts_with(protocol::COMPILED_HOST_HTTP_PREFIX) {
    let source = protocol::host_http_module_source(request_path).map_err(|_| ())?;
    return Ok(("text/javascript; charset=utf-8", source.into_bytes()));
  }
  if request_path.starts_with(protocol::COMPILED_WIDGET_HTTP_PREFIX) {
    let file_path = protocol::resolve_http_widget_file_path(&config.widget_cache_dir, request_path).map_err(|_| ())?;
    let bytes = std::fs::read(&file_path).map_err(|_| ())?;
    return Ok((content_type(&file_path), bytes));
  }
  read_ui_file(&config.ui_root, request_path)
}

fn read_ui_file(root: &Path, request_path: &str) -> Result<(&'static str, Vec<u8>), ()> {
  let mut relative = request_path.split('?').next().unwrap_or("/").trim_start_matches('/');
  if relative.is_empty() {
    relative = "index.html";
  }
  if relative.contains("..") {
    return Err(());
  }
  let file_path = root.join(relative);
  if !file_path.starts_with(root) {
    return Err(());
  }
  let bytes = std::fs::read(&file_path).map_err(|_| ())?;
  Ok((content_type(&file_path), bytes))
}

fn content_type(path: &Path) -> &'static str {
  match path.extension().and_then(|e| e.to_str()) {
    Some("html") => "text/html; charset=utf-8",
    Some("css") => "text/css; charset=utf-8",
    Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
    Some("svg") => "image/svg+xml",
    Some("png") => "image/png",
    Some("woff2") => "font/woff2",
    _ => "application/octet-stream",
  }
}
