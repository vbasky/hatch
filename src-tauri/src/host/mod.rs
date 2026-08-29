mod acp;
mod actions;
mod agent;
mod compile;
mod css;
mod db;
mod js;
mod telemetry;
mod recipes;
mod session;
mod settings;
mod updates;
mod widgets;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use actions::HostActions;
use agent::AgentRuntime;
use db::HostDb;
use settings::HostSettings;
use telemetry::Telemetry;
use updates::UpdateChecker;
use widgets::HostWidgets;

#[derive(Clone)]
pub struct Host {
  inner: Arc<HostInner>,
}

struct HostInner {
  root: PathBuf,
  extensions_dir: PathBuf,
  recipes_dir: PathBuf,
  widget_cache_dir: PathBuf,
  packaged: bool,
  db: Arc<HostDb>,
  settings: HostSettings,
  actions: HostActions,
  agent: AgentRuntime,
  updates: UpdateChecker,
  telemetry: Telemetry,
}

impl Host {
  pub fn start(options: HostOptions) -> Result<Self, String> {
    let extensions_dir = options
      .extensions_dir
      .unwrap_or_else(|| options.root.join("extensions"));
    let recipes_dir = options.recipes_dir.unwrap_or_else(|| extensions_dir.join("recipes"));
    let widget_cache_dir = options.widget_cache_dir.clone();
    std::fs::create_dir_all(&widget_cache_dir).ok();
    if let Some(parent) = options.database_path.parent() {
      std::fs::create_dir_all(parent).ok();
    }
    if let Some(template) = &options.template_dir {
      let _ = seed_extensions(&extensions_dir, template);
    }
    let db = Arc::new(HostDb::open(&options.database_path)?);
    let actions = HostActions::new(
      extensions_dir.clone(),
      widget_cache_dir.join("server-actions"),
      options.root.clone(),
      db.clone(),
    );
    let settings = HostSettings::open(options.root.join("preferences.json"), options.root.join("agents.json"));
    let adapter_dir = options.adapter_dir.or_else(|| {
      if options.packaged {
        options
          .template_dir
          .as_ref()
          .and_then(|path| path.parent())
          .map(|path| path.join("adapters"))
      } else {
        Some(options.root.join("out/adapters"))
      }
    });
    let snapshot_dir = options.root.join(".cache/hatch/dev-extension-snapshots");
    let agent = AgentRuntime::new(
      settings.clone(),
      extensions_dir.clone(),
      options.root.clone(),
      options.packaged,
      adapter_dir,
      snapshot_dir,
      None,
    );
    let host = Self {
      inner: Arc::new(HostInner {
        db,
        settings,
        actions,
        agent,
        updates: UpdateChecker::new(env!("CARGO_PKG_VERSION"), !options.packaged),
        telemetry: Telemetry::from_env(env!("CARGO_PKG_VERSION")),
        root: options.root,
        extensions_dir,
        recipes_dir,
        widget_cache_dir,
        packaged: options.packaged,
      }),
    };
    host.inner.telemetry.track("app_start", json!({}));
    host.spawn_background();
    Ok(host)
  }

  pub fn invoke(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
    self.invoke_emit(channel, args, &|_, _| {})
  }

  pub fn invoke_emit(&self, channel: &str, args: &[Value], emit: &dyn Fn(&str, Value)) -> Result<Value, String> {
    match channel {
      "hatch:widgets:list" => HostWidgets::list(
        &self.inner.extensions_dir,
        &self.inner.widget_cache_dir,
        self.inner.packaged,
      ),
      "hatch:layout:get" => HostWidgets::layout(
        &self.inner.extensions_dir,
        &self.inner.widget_cache_dir,
        self.inner.packaged,
      ),
      "hatch:recipes:list" => recipes::list(&self.inner.recipes_dir),
      "hatch:db:query" => self.inner.db.query(arg_str(args, 0)?, args.get(1)),
      "hatch:db:get" => self.inner.db.get(arg_str(args, 0)?, args.get(1)),
      "hatch:db:run" => self.inner.db.run(arg_str(args, 0)?, args.get(1)),
      "hatch:db:exec" => {
        self.inner.db.exec(arg_str(args, 0)?)?;
        Ok(Value::Null)
      }
      "hatch:settings:get" => self.inner.settings.get(),
      "hatch:settings:set-open-at-login" => self
        .inner
        .settings
        .set_open_at_login(args.first().and_then(Value::as_bool).unwrap_or(false)),
      "hatch:settings:set-agent" => {
        let result = self.inner.settings.set_agent(arg_str(args, 0)?);
        if result.is_ok() {
          self.inner.telemetry.track("agent_switch", json!({ "agent": arg_str(args, 0)? }));
        }
        result
      }
      "hatch:settings:add-agent" => self.inner.settings.add_agent(args.first().cloned().unwrap_or(Value::Null)),
      "hatch:settings:update-agent" => self
        .inner
        .settings
        .update_agent(arg_str(args, 0)?, args.get(1).cloned().unwrap_or(Value::Null)),
      "hatch:settings:remove-agent" => self.inner.settings.remove_agent(arg_str(args, 0)?),
      "hatch:capabilities:list" => self.inner.actions.list(),
      "hatch:capabilities:invoke" => self.inner.actions.invoke(
        arg_str(args, 0)?,
        arg_str(args, 1)?,
        args.get(2).unwrap_or(&Value::Null),
      ),
      "hatch:agent:send" => {
        let result = self.inner.agent.send(arg_str(args, 0)?, emit);
        match &result {
          Ok(_) => self.inner.telemetry.track("agent_turn", json!({ "status": "success" })),
          Err(_) => self.inner.telemetry.track("agent_turn", json!({ "status": "error" })),
        }
        result
      }
      "hatch:agent:active-turn" => Ok(self.inner.agent.active_turn()),
      "hatch:git:save" => self.inner.agent.save(args.first().and_then(Value::as_str)),
      "hatch:git:rollback" => self.inner.agent.rollback(),
      "hatch:git:status" => self.inner.agent.status(),
      "hatch:app:get-update-status" => Ok(self.inner.updates.status()),
      "hatch:app:open-release-page" => Ok(json!({ "ok": true, "url": self.inner.updates.release_url() })),
      "hatch:internal:popover-open" => {
        self.inner.telemetry.pageview("/popover", json!({}));
        self.inner.telemetry.track("popover_open", json!({}));
        Ok(json!({ "ok": true }))
      }
      other => Err(format!("Unknown host channel: {other}")),
    }
  }

  pub fn widget_cache_dir(&self) -> &Path {
    &self.inner.widget_cache_dir
  }

  fn spawn_background(&self) {
    let host = self.clone();
    std::thread::Builder::new()
      .name("hatch-background".into())
      .spawn(move || {
        host.inner.actions.tick_background();
        loop {
          std::thread::sleep(std::time::Duration::from_secs(60));
          host.inner.actions.tick_background();
        }
      })
      .ok();
  }
}

pub struct HostOptions {
  pub root: PathBuf,
  pub packaged: bool,
  pub extensions_dir: Option<PathBuf>,
  pub recipes_dir: Option<PathBuf>,
  pub widget_cache_dir: PathBuf,
  pub database_path: PathBuf,
  pub template_dir: Option<PathBuf>,
  pub adapter_dir: Option<PathBuf>,
}

fn seed_extensions(extensions_dir: &Path, template_dir: &Path) -> Result<(), String> {
  if !template_dir.is_dir() {
    return Ok(());
  }
  copy_dir(template_dir, extensions_dir)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
  fs::create_dir_all(to).map_err(|e| e.to_string())?;
  for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    let source = entry.path();
    let dest = to.join(entry.file_name());
    if source.is_dir() {
      copy_dir(&source, &dest)?;
    } else {
      fs::copy(&source, &dest).map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

fn arg_str(args: &[Value], index: usize) -> Result<&str, String> {
  args
    .get(index)
    .and_then(Value::as_str)
    .ok_or_else(|| format!("missing string argument {index}"))
}

pub fn native_host_enabled() -> bool {
  !matches!(std::env::var("HATCH_USE_NODE_SIDECAR").as_deref(), Ok("1"))
}


