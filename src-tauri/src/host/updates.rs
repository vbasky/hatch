use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const DEFAULT_REPO: &str = "vbasky/hatch";
const INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

pub struct UpdateChecker {
  current_version: String,
  simulate: bool,
  cache: Mutex<Option<(Instant, Value)>>,
}

impl UpdateChecker {
  pub fn new(current_version: impl Into<String>, simulate: bool) -> Self {
    Self {
      current_version: current_version.into(),
      simulate,
      cache: Mutex::new(None),
    }
  }

  pub fn status(&self) -> Value {
    if self.simulate {
      return self.simulated();
    }
    if let Ok(cache) = self.cache.lock() {
      if let Some((checked, status)) = cache.as_ref() {
        if checked.elapsed() < INTERVAL {
          return status.clone();
        }
      }
    }
    let status = self.refresh();
    if let Ok(mut cache) = self.cache.lock() {
      *cache = Some((Instant::now(), status.clone()));
    }
    status
  }

  pub fn release_url(&self) -> String {
    self
      .status()
      .get("releaseUrl")
      .and_then(Value::as_str)
      .filter(|url| !url.is_empty())
      .unwrap_or("https://github.com/vbasky/hatch/releases/latest")
      .to_string()
  }

  fn refresh(&self) -> Value {
    let fallback = json!({
      "currentVersion": self.current_version,
      "latestVersion": Value::Null,
      "updateAvailable": false,
      "releaseUrl": Value::Null
    });
    let response = ureq::get(&format!("https://api.github.com/repos/{DEFAULT_REPO}/releases/latest"))
      .set("Accept", "application/vnd.github+json")
      .set("User-Agent", "hatch")
      .call();
    let Ok(response) = response else {
      return fallback;
    };
    let Ok(body) = response.into_string() else {
      return fallback;
    };
    let Ok(payload) = serde_json::from_str::<Value>(&body) else {
      return fallback;
    };
    let Some(tag) = payload.get("tag_name").and_then(Value::as_str) else {
      return fallback;
    };
    let Some(version) = parse_version(tag) else {
      return fallback;
    };
    json!({
      "currentVersion": self.current_version,
      "latestVersion": version,
      "updateAvailable": compare_semver(&version, &self.current_version) > 0,
      "releaseUrl": payload.get("html_url").and_then(Value::as_str)
    })
  }

  fn simulated(&self) -> Value {
    let parts = semver_parts(&self.current_version);
    let latest = format!("{}.{}.{}", parts.0, parts.1, parts.2 + 1);
    json!({
      "currentVersion": self.current_version,
      "latestVersion": latest,
      "updateAvailable": true,
      "releaseUrl": "https://github.com/vbasky/hatch/releases/latest"
    })
  }
}

fn parse_version(tag: &str) -> Option<String> {
  let core = tag.trim().trim_start_matches('v');
  let core = core.split(['-', '+']).next().unwrap_or(core);
  if core.split('.').count() >= 2 {
    Some(core.to_string())
  } else {
    None
  }
}

fn semver_parts(version: &str) -> (u64, u64, u64) {
  let mut parts = version.trim().trim_start_matches('v').split(['-', '+']).next().unwrap_or("").split('.');
  let major = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
  let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
  let patch = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
  (major, minor, patch)
}

fn compare_semver(left: &str, right: &str) -> i32 {
  let a = semver_parts(left);
  let b = semver_parts(right);
  if a.0 != b.0 {
    return if a.0 > b.0 { 1 } else { -1 };
  }
  if a.1 != b.1 {
    return if a.1 > b.1 { 1 } else { -1 };
  }
  if a.2 != b.2 {
    return if a.2 > b.2 { 1 } else { -1 };
  }
  0
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn simulated_status_is_newer_than_current() {
    let checker = UpdateChecker::new("0.1.24", true);
    let status = checker.status();
    assert_eq!(status["updateAvailable"], true);
    assert_eq!(status["latestVersion"], "0.1.25");
  }
}
