use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rquickjs::loader::{BuiltinLoader, BuiltinResolver, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{Context, Ctx, Function, Runtime};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::db::HostDb;

const PRELUDE: &str = include_str!("node_prelude.js");

struct FileLoader;

impl Loader for FileLoader {
  fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<rquickjs::Module<'js, Declared>> {
    let source = std::fs::read_to_string(name).map_err(|_| rquickjs::Error::new_loading(name))?;
    rquickjs::Module::declare(ctx.clone(), name, source)
  }
}

struct AbsoluteResolver;

impl Resolver for AbsoluteResolver {
  fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str) -> rquickjs::Result<String> {
    if name.starts_with("node:") {
      return Err(rquickjs::Error::new_resolving(base, name));
    }
    let candidate = if name.starts_with('/') {
      PathBuf::from(name)
    } else {
      Path::new(base).parent().unwrap_or(Path::new(".")).join(name)
    };
    if candidate.is_file() {
      Ok(candidate.to_string_lossy().into_owned())
    } else {
      Err(rquickjs::Error::new_resolving(base, name))
    }
  }
}
const NODE_MODULES: &[(&str, &str)] = &[
  ("node:path", "export const join = globalThis.__hatchNode.path.join;\nexport const delimiter = globalThis.__hatchNode.path.delimiter;\nexport default globalThis.__hatchNode.path;\n"),
  ("node:os", "export const homedir = globalThis.__hatchNode.os.homedir;\nexport default globalThis.__hatchNode.os;\n"),
  ("node:fs", "export const readFileSync = globalThis.__hatchNode.fs.readFileSync;\nexport const accessSync = globalThis.__hatchNode.fs.accessSync;\nexport const statSync = globalThis.__hatchNode.fs.statSync;\nexport const constants = globalThis.__hatchNode.fs.constants;\nexport default globalThis.__hatchNode.fs;\n"),
  ("node:crypto", "export const createHash = globalThis.__hatchNode.crypto.createHash;\nexport default globalThis.__hatchNode.crypto;\n"),
  ("node:child_process", "export const spawn = globalThis.__hatchNode.child_process.spawn;\nexport const spawnSync = globalThis.__hatchNode.child_process.spawnSync;\nexport default globalThis.__hatchNode.child_process;\n"),
  ("node:https", "export const request = globalThis.__hatchNode.https.request;\nexport default globalThis.__hatchNode.https;\n"),
];

#[derive(Clone)]
pub struct JsHost {
  db: Arc<HostDb>,
  root_dir: PathBuf,
}

pub struct JsEngine {
  host: JsHost,
  runtime: Runtime,
  context: Context,
}

impl JsEngine {
  pub fn new(db: Arc<HostDb>, root_dir: PathBuf) -> Result<Self, String> {
    let host = JsHost { db, root_dir };
    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    let mut resolver = BuiltinResolver::default();
    for (name, _) in NODE_MODULES {
      resolver = resolver.with_module(*name);
    }
    let mut loader = BuiltinLoader::default();
    for (name, source) in NODE_MODULES {
      loader = loader.with_module(*name, *source);
    }
    runtime.set_loader((resolver, AbsoluteResolver), (loader, FileLoader));
    let context = Context::full(&runtime).map_err(|error| error.to_string())?;
    let installed = host.clone();
    context
      .with(|ctx| -> rquickjs::Result<()> {
        let call = installed.clone();
        ctx.globals().set(
          "__hatchCall",
          Function::new(ctx.clone(), move |op: String, payload: String| -> String {
            let body: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            call.dispatch(&op, body).to_string()
          })?,
        )?;
        ctx.eval::<(), _>(PRELUDE)?;
        Ok(())
      })
      .map_err(|error| error.to_string())?;
    Ok(Self { host, runtime, context })
  }

  pub fn invoke(
    &self,
    module_path: &Path,
    action: &str,
    input: &Value,
    root_dir: &Path,
  ) -> Result<Value, String> {
    let path = module_path
      .canonicalize()
      .map_err(|error| error.to_string())?
      .to_string_lossy()
      .into_owned();
    self
      .context
      .with(|ctx| start_action(&ctx, &path, action, input, root_dir))
      .map_err(|error| error.to_string())?;
    await_result(&self.runtime, &self.context)
  }

  pub fn list_actions(&self, module_path: &Path) -> Result<Vec<String>, String> {
    let path = module_path
      .canonicalize()
      .map_err(|error| error.to_string())?
      .to_string_lossy()
      .into_owned();
    self
      .context
      .with(|ctx| start_list(&ctx, &path))
      .map_err(|error| error.to_string())?;
    let value = await_result(&self.runtime, &self.context)?;
    Ok(
      value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect(),
    )
  }

  pub fn run_background(&self, module_path: &Path, root_dir: &Path) -> Result<Value, String> {
    let path = module_path
      .canonicalize()
      .map_err(|error| error.to_string())?
      .to_string_lossy()
      .into_owned();
    self
      .context
      .with(|ctx| start_background(&ctx, &path, root_dir))
      .map_err(|error| error.to_string())?;
    await_result(&self.runtime, &self.context)
  }
}

fn start_action(
  ctx: &Ctx<'_>,
  module_path: &str,
  action: &str,
  input: &Value,
  root_dir: &Path,
) -> rquickjs::Result<()> {
  let globals = ctx.globals();
  globals.set("__hatchModulePath", module_path)?;
  globals.set("__hatchActionName", action)?;
  globals.set("__hatchInputJson", input.to_string())?;
  globals.set("__hatchRootDir", root_dir.to_string_lossy().into_owned())?;
  ctx.eval::<(), _>(
    r#"
      globalThis.__hatchResult = { pending: true };
      (async () => {
        try {
          const mod = await import(__hatchModulePath);
          const fn = mod.actions && mod.actions[__hatchActionName];
          if (typeof fn !== "function") throw new Error("Unknown server action: " + __hatchActionName);
          const input = JSON.parse(__hatchInputJson);
          const context = {
            rootDir: __hatchRootDir,
            db: {
              query(sql, params) { return JSON.parse(globalThis.__hatchCall("dbQuery", JSON.stringify({ sql, params }))); },
              get(sql, params) { return JSON.parse(globalThis.__hatchCall("dbGet", JSON.stringify({ sql, params }))); },
              run(sql, params) { return JSON.parse(globalThis.__hatchCall("dbRun", JSON.stringify({ sql, params }))); },
              exec(sql) { JSON.parse(globalThis.__hatchCall("dbExec", JSON.stringify({ sql }))); },
            },
            notify() {},
          };
          const value = await fn(input, context);
          globalThis.__hatchResult = { ok: true, json: JSON.stringify(value === undefined ? null : value) };
        } catch (error) {
          globalThis.__hatchResult = { ok: false, error: String(error && error.message ? error.message : error) };
        }
      })();
      undefined;
    "#,
  )?;
  Ok(())
}

fn start_background(ctx: &Ctx<'_>, module_path: &str, root_dir: &Path) -> rquickjs::Result<()> {
  ctx.globals().set("__hatchModulePath", module_path)?;
  ctx.globals().set("__hatchRootDir", root_dir.to_string_lossy().into_owned())?;
  ctx.eval::<(), _>(
    r#"
      globalThis.__hatchResult = { pending: true };
      (async () => {
        try {
          const mod = await import(__hatchModulePath);
          if (!mod.background || typeof mod.background.run !== "function") {
            globalThis.__hatchResult = { ok: true, json: JSON.stringify({ ran: false }) };
            return;
          }
          const context = {
            rootDir: __hatchRootDir,
            db: {
              query(sql, params) { return JSON.parse(globalThis.__hatchCall("dbQuery", JSON.stringify({ sql, params }))); },
              get(sql, params) { return JSON.parse(globalThis.__hatchCall("dbGet", JSON.stringify({ sql, params }))); },
              run(sql, params) { return JSON.parse(globalThis.__hatchCall("dbRun", JSON.stringify({ sql, params }))); },
              exec(sql) { JSON.parse(globalThis.__hatchCall("dbExec", JSON.stringify({ sql }))); },
            },
            notify() {},
          };
          await mod.background.run(context);
          globalThis.__hatchResult = { ok: true, json: JSON.stringify({ ran: true, intervalMs: mod.background.intervalMs || 60000 }) };
        } catch (error) {
          globalThis.__hatchResult = { ok: false, error: String(error && error.message ? error.message : error) };
        }
      })();
      undefined;
    "#,
  )?;
  Ok(())
}

fn start_list(ctx: &Ctx<'_>, module_path: &str) -> rquickjs::Result<()> {
  ctx.globals().set("__hatchModulePath", module_path)?;
  ctx.eval::<(), _>(
    r#"
      globalThis.__hatchResult = { pending: true };
      (async () => {
        try {
          const mod = await import(__hatchModulePath);
          globalThis.__hatchResult = { ok: true, json: JSON.stringify(Object.keys(mod.actions || {})) };
        } catch (error) {
          globalThis.__hatchResult = { ok: false, error: String(error && error.message ? error.message : error) };
        }
      })();
      undefined;
    "#,
  )?;
  Ok(())
}

fn await_result(runtime: &Runtime, context: &Context) -> Result<Value, String> {
  let started = Instant::now();
  loop {
    while runtime.execute_pending_job().unwrap_or(false) {}
    let snapshot = context
      .with(|ctx| ctx.eval::<String, _>("JSON.stringify(globalThis.__hatchResult)"))
      .map_err(|error| error.to_string())?;
    let parsed: Value = serde_json::from_str(&snapshot).map_err(|error| error.to_string())?;
    if parsed.get("pending").and_then(Value::as_bool).unwrap_or(false) {
      if started.elapsed() > Duration::from_secs(40) {
        return Err("server action timed out".into());
      }
      std::thread::sleep(Duration::from_millis(5));
      continue;
    }
    if parsed.get("ok").and_then(Value::as_bool).unwrap_or(false) {
      let json = parsed.get("json").and_then(Value::as_str).unwrap_or("null");
      return serde_json::from_str(json).map_err(|error| error.to_string());
    }
    return Err(
      parsed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("server action failed")
        .to_string(),
    );
  }
}

impl JsHost {
  fn dispatch(&self, op: &str, payload: Value) -> Value {
    match op {
      "env" => {
        let map: HashMap<String, String> = std::env::vars().collect();
        json!(map)
      }
      "platform" => json!(std::env::consts::OS),
      "homedir" => json!(dirs_home()),
      "getuid" => json!(getuid()),
      "sha256" => {
        let input = payload.as_str().unwrap_or("");
        let digest = Sha256::digest(input.as_bytes());
        json!(digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
      }
      "kill" => kill_proc(&payload),
      "readFileSync" => read_file(payload.as_str().unwrap_or("")),
      "accessSync" => access(payload.as_str().unwrap_or("")),
      "statSync" => stat(payload.as_str().unwrap_or("")),
      "spawnSync" => spawn_cmd(&payload, true),
      "spawn" => spawn_cmd(&payload, false),
      "httpsRequest" => https_request(&payload),
      "dbQuery" => self.db.query(payload["sql"].as_str().unwrap_or(""), payload.get("params")).unwrap_or(json!([])),
      "dbGet" => self.db.get(payload["sql"].as_str().unwrap_or(""), payload.get("params")).unwrap_or(Value::Null),
      "dbRun" => self.db.run(payload["sql"].as_str().unwrap_or(""), payload.get("params")).unwrap_or(json!({ "changes": 0, "lastInsertRowid": 0 })),
      "dbExec" => {
        let _ = self.db.exec(payload["sql"].as_str().unwrap_or(""));
        Value::Null
      }
      other => json!({ "error": { "code": "ENOSYS", "message": format!("unknown hatch op {other}") } }),
    }
  }
}

fn dirs_home() -> String {
  std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
}

fn getuid() -> u32 {
  #[cfg(unix)]
  {
    unsafe { libc::getuid() }
  }
  #[cfg(not(unix))]
  {
    0
  }
}

fn kill_proc(payload: &Value) -> Value {
  let pid = payload.get("pid").and_then(Value::as_i64).unwrap_or(0) as i32;
  let signal = payload.get("signal").and_then(Value::as_str).unwrap_or("SIGTERM");
  #[cfg(unix)]
  {
    let sig = match signal {
      "SIGKILL" => libc::SIGKILL,
      _ => libc::SIGTERM,
    };
    let result = unsafe { libc::kill(pid, sig) };
    if result == 0 {
      json!({ "ok": true })
    } else {
      let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
      json!({ "error": { "code": if code == libc::ESRCH { "ESRCH" } else if code == libc::EPERM { "EPERM" } else { "EIO" }, "message": "kill failed" } })
    }
  }
  #[cfg(not(unix))]
  {
    let _ = (pid, signal);
    json!({ "ok": true })
  }
}

fn io_error(error: std::io::Error) -> Value {
  let code = error.raw_os_error().map(|code| match code {
    2 => "ENOENT",
    13 => "EACCES",
    _ => "EIO",
  }).unwrap_or("EIO");
  json!({ "error": { "code": code, "message": error.to_string() } })
}

fn read_file(path: &str) -> Value {
  match std::fs::read_to_string(path) {
    Ok(text) => json!({ "text": text }),
    Err(error) => io_error(error),
  }
}

fn access(path: &str) -> Value {
  match std::fs::metadata(path) {
    Ok(_) => Value::Null,
    Err(error) => io_error(error),
  }
}

fn stat(path: &str) -> Value {
  match std::fs::metadata(path) {
    Ok(meta) => json!({ "isFile": meta.is_file() }),
    Err(error) => io_error(error),
  }
}

fn spawn_cmd(payload: &Value, as_sync: bool) -> Value {
  let command = payload.get("command").and_then(Value::as_str).unwrap_or("");
  let args: Vec<String> = payload
    .get("args")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .map(str::to_string)
    .collect();
  let timeout_ms = payload
    .pointer("/options/timeout")
    .and_then(Value::as_u64)
    .unwrap_or(25_000);
  let mut cmd = Command::new(command);
  cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  if payload.pointer("/options/env").is_none() {
    // inherit
  }
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    if payload.pointer("/options/detached").and_then(Value::as_bool).unwrap_or(false) {
      cmd.process_group(0);
    }
  }
  let mut child = match cmd.spawn() {
    Ok(child) => child,
    Err(error) => {
      return json!({
        "error": { "code": if error.kind() == std::io::ErrorKind::NotFound { "ENOENT" } else { "EIO" }, "message": error.to_string() },
        "status": 1
      });
    }
  };
  let pid = child.id();
  let deadline = Instant::now() + Duration::from_millis(timeout_ms);
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() >= deadline => {
        let _ = child.kill();
        let _ = child.wait();
        return json!({ "pid": pid, "status": 1, "stdout": "", "stderr": "timeout", "stdoutBytes": [], "stderrBytes": [], "error": { "code": "ETIMEDOUT", "message": "timeout" } });
      }
      Ok(None) => std::thread::sleep(Duration::from_millis(15)),
      Err(error) => return io_error(error),
    }
  };
  let mut stdout = Vec::new();
  let mut stderr = Vec::new();
  if let Some(mut pipe) = child.stdout.take() {
    let _ = pipe.read_to_end(&mut stdout);
  }
  if let Some(mut pipe) = child.stderr.take() {
    let _ = pipe.read_to_end(&mut stderr);
  }
  let code = status.code().unwrap_or(1);
  if as_sync {
    json!({
      "pid": pid,
      "status": code,
      "stdout": String::from_utf8_lossy(&stdout),
      "stderr": String::from_utf8_lossy(&stderr)
    })
  } else {
    json!({
      "pid": pid,
      "status": code,
      "stdoutBytes": stdout,
      "stderrBytes": stderr
    })
  }
}

fn https_request(payload: &Value) -> Value {
  let hostname = payload.get("hostname").and_then(Value::as_str).unwrap_or("");
  let path = payload.get("path").and_then(Value::as_str).unwrap_or("/");
  let method = payload.get("method").and_then(Value::as_str).unwrap_or("GET");
  let timeout = payload.get("timeout").and_then(Value::as_u64).unwrap_or(15_000);
  let url = format!("https://{hostname}{path}");
  let body: Vec<u8> = payload
    .get("body")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(Value::as_u64)
    .map(|byte| byte as u8)
    .collect();
  let agent = ureq::AgentBuilder::new()
    .timeout(Duration::from_millis(timeout.max(1)))
    .build();
  let mut request = match method {
    "POST" => agent.post(&url),
    "PUT" => agent.put(&url),
    _ => agent.get(&url),
  };
  if let Some(headers) = payload.get("headers").and_then(Value::as_object) {
    for (key, value) in headers {
      if let Some(value) = value.as_str() {
        request = request.set(key, value);
      }
    }
  }
  let response = if method == "GET" {
    request.call()
  } else {
    request.send_bytes(&body)
  };
  match response {
    Ok(response) => {
      let status = response.status();
      let mut headers = serde_json::Map::new();
      for name in response.headers_names() {
        if let Some(value) = response.header(&name) {
          headers.insert(name.to_ascii_lowercase(), json!(value));
        }
      }
      let mut bytes = Vec::new();
      let _ = response.into_reader().take(256 * 1024).read_to_end(&mut bytes);
      json!({ "status": status, "headers": headers, "body": bytes })
    }
    Err(ureq::Error::Status(status, response)) => {
      let mut bytes = Vec::new();
      let _ = response.into_reader().take(256 * 1024).read_to_end(&mut bytes);
      json!({ "status": status, "headers": {}, "body": bytes })
    }
    Err(error) => json!({ "error": { "code": "ECONNRESET", "message": error.to_string() } }),
  }
}


