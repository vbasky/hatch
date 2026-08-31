use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

const FALLBACK_HOST: &str = "https://a.vbasky.com";
const UMAMI_PATH: &str = "/api/send";

#[derive(Clone)]
pub struct Telemetry {
  inner: Arc<Inner>,
}

struct Inner {
  enabled: bool,
  endpoint: String,
  website_id: String,
  version: String,
}

impl Telemetry {
  pub fn from_env(version: &str) -> Self {
    let opt_out = std::env::var("HATCH_TELEMETRY")
      .unwrap_or_default()
      .trim()
      .to_ascii_lowercase();
    if matches!(opt_out.as_str(), "0" | "false" | "off") {
      return Self::disabled(version);
    }
    let website_id = std::env::var("HATCH_UMAMI_WEBSITE_ID")
      .unwrap_or_default()
      .trim()
      .to_string();
    if website_id.is_empty() {
      return Self::disabled(version);
    }
    let host = std::env::var("HATCH_UMAMI_HOST")
      .ok()
      .map(|value| value.trim().to_string())
      .filter(|value| !value.is_empty())
      .unwrap_or_else(|| FALLBACK_HOST.to_string());
    let Some(endpoint) = normalize_endpoint(&host) else {
      return Self::disabled(version);
    };
    Self {
      inner: Arc::new(Inner {
        enabled: true,
        endpoint,
        website_id,
        version: version.to_string(),
      }),
    }
  }

  fn disabled(version: &str) -> Self {
    Self {
      inner: Arc::new(Inner {
        enabled: false,
        endpoint: String::new(),
        website_id: String::new(),
        version: version.to_string(),
      }),
    }
  }

  pub fn enabled(&self) -> bool {
    self.inner.enabled
  }

  pub fn track(&self, name: &str, fields: Value) {
    if !self.inner.enabled || name.trim().is_empty() {
      return;
    }
    self.send(name, &format!("app://hatch/{}", name.replace('.', "/")), fields);
  }

  pub fn pageview(&self, path: &str, fields: Value) {
    if !self.inner.enabled {
      return;
    }
    let url = if path.starts_with('/') {
      path.to_string()
    } else {
      format!("/{path}")
    };
    self.send("", &url, fields);
  }

  fn send(&self, name: &str, url: &str, fields: Value) {
    let mut data = match fields {
      Value::Object(map) => map,
      _ => Map::new(),
    };
    data.entry("version").or_insert_with(|| json!(self.inner.version));
    data.entry("platform").or_insert_with(|| json!(std::env::consts::OS));
    data.entry("arch").or_insert_with(|| json!(std::env::consts::ARCH));
    let timestamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or(Duration::from_secs(0))
      .as_secs();
    let payload = json!({
      "type": "event",
      "payload": {
        "website": self.inner.website_id,
        "hostname": "app",
        "title": "Hatch",
        "url": url,
        "name": name,
        "data": data,
        "timestamp": timestamp
      }
    });
    let endpoint = self.inner.endpoint.clone();
    let body = payload.to_string();
    std::thread::spawn(move || {
      let _ = ureq::post(&endpoint)
        .set("Content-Type", "application/json")
        .set("User-Agent", "hatch telemetry")
        .timeout(Duration::from_millis(1000))
        .send_string(&body);
    });
  }
}

fn normalize_endpoint(host: &str) -> Option<String> {
  let trimmed = host.trim().trim_end_matches('/');
  if trimmed.is_empty() {
    return None;
  }
  if trimmed.ends_with(UMAMI_PATH) {
    Some(trimmed.to_string())
  } else {
    Some(format!("{trimmed}{UMAMI_PATH}"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn is_disabled_without_a_website_id() {
    let telemetry = Telemetry::disabled("0.1.24");
    assert!(!telemetry.enabled());
  }

  #[test]
  fn appends_umami_send_path() {
    assert_eq!(
      normalize_endpoint("https://a.vbasky.com"),
      Some("https://a.vbasky.com/api/send".into())
    );
  }
}
