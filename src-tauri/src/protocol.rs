use std::path::{Path, PathBuf};

const WIDGET_SCHEME: &str = "baby-menu-widget";
const HOST_SCHEME: &str = "baby-menu-host";
pub const COMPILED_WIDGET_HTTP_PREFIX: &str = "/__widgets__";
pub const COMPILED_HOST_HTTP_PREFIX: &str = "/__host__";

const UI_EXPORT_NAMES: &[&str] = &[
  "cn",
  "Badge",
  "Button",
  "Card",
  "CardBody",
  "CardHeader",
  "DataTable",
  "Dialog",
  "DialogBody",
  "DialogContent",
  "DialogDescription",
  "DialogFooter",
  "DialogTitle",
  "DialogTrigger",
  "DropdownMenu",
  "DropdownMenuContent",
  "DropdownMenuItem",
  "DropdownMenuTrigger",
  "Field",
  "Input",
  "Progress",
  "Select",
  "SelectContent",
  "SelectItem",
  "SelectTrigger",
  "SelectValue",
  "Skeleton",
  "Sparkline",
  "StatusDot",
  "Switch",
  "Tabs",
  "TabsContent",
  "TabsList",
  "TabsTrigger",
  "Textarea",
  "Tooltip",
];

pub fn resolve_http_widget_file_path(widget_cache_dir: &Path, request_path: &str) -> Result<PathBuf, String> {
  let path = request_path.split('?').next().unwrap_or(request_path);
  let rest = path
    .strip_prefix(&format!("{COMPILED_WIDGET_HTTP_PREFIX}/"))
    .ok_or_else(|| "Invalid widget module URL".to_string())?;
  if rest.is_empty() {
    return Err("Invalid widget module URL".into());
  }
  resolve_widget_protocol_file_path(widget_cache_dir, &format!("{WIDGET_SCHEME}://{rest}"))
}

pub fn host_http_module_source(request_path: &str) -> Result<String, String> {
  let path = request_path.split('?').next().unwrap_or(request_path);
  let rest = path
    .strip_prefix(&format!("{COMPILED_HOST_HTTP_PREFIX}/"))
    .ok_or_else(|| "Unknown host module URL".to_string())?;
  if rest.is_empty() {
    return Err("Unknown host module URL".into());
  }
  host_protocol_module_source(&format!("{HOST_SCHEME}://{rest}"))
}

pub fn resolve_widget_protocol_file_path(widget_cache_dir: &Path, raw_url: &str) -> Result<PathBuf, String> {
  let url = url::Url::parse(raw_url).map_err(|_| "Invalid widget module URL".to_string())?;
  if url.scheme() != WIDGET_SCHEME {
    return Err("Invalid widget module URL".into());
  }
  let extension_id = url.host_str().ok_or_else(|| "Invalid widget module URL".to_string())?;
  let path_segments: Vec<String> = url
    .path_segments()
    .map(|segments| segments.filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
    .unwrap_or_default();
  if extension_id.is_empty()
    || path_segments.len() < 2
    || path_segments.iter().any(|segment| segment == "." || segment == "..")
  {
    return Err("Invalid widget module URL".into());
  }
  let last = path_segments.last().cloned().unwrap_or_default();
  if !last.ends_with(".mjs") && !last.ends_with(".css") {
    return Err("Invalid widget module URL".into());
  }
  let mut file_path = widget_cache_dir.join(extension_id);
  for segment in path_segments {
    file_path.push(segment);
  }
  let canonical_cache = widget_cache_dir;
  if !file_path.starts_with(canonical_cache) {
    return Err("Invalid widget module URL".into());
  }
  Ok(file_path)
}

pub fn host_protocol_module_source(raw_url: &str) -> Result<String, String> {
  let url = url::Url::parse(raw_url).map_err(|_| "Unknown host module URL".to_string())?;
  if url.scheme() != HOST_SCHEME {
    return Err("Unknown host module URL".into());
  }
  let module_id = format!("{}{}", url.host_str().unwrap_or_default(), url.path());
  match module_id.as_str() {
    "react/index.mjs" => Ok(REACT_SHIM.to_string()),
    "react-jsx-runtime/index.mjs" => Ok(JSX_SHIM.to_string()),
    "ui/index.mjs" => {
      let reexports = UI_EXPORT_NAMES
        .iter()
        .map(|name| format!("export const {name} = ui.{name};"))
        .collect::<Vec<_>>()
        .join("\n");
      Ok(format!("const ui = window.__BABY_MENU_WIDGET_HOST__.ui;\n{reexports}\n"))
    }
    _ => Err("Unknown host module URL".into()),
  }
}

pub fn resolve_ui_file_path(resource_dir: &Path, raw_url: &str) -> Result<PathBuf, String> {
  let url = url::Url::parse(raw_url).map_err(|_| "Invalid UI URL".to_string())?;
  let mut relative = url.path().trim_start_matches('/').to_string();
  if relative.is_empty() {
    relative = "index.html".into();
  }
  if relative.contains("..") {
    return Err("Invalid UI URL".into());
  }
  let file_path = resource_dir.join(relative);
  if !file_path.starts_with(resource_dir) {
    return Err("Invalid UI URL".into());
  }
  Ok(file_path)
}

pub fn content_type_for(path: &Path) -> &'static str {
  match path.extension().and_then(|e| e.to_str()) {
    Some("css") => "text/css; charset=utf-8",
    Some("html") => "text/html; charset=utf-8",
    Some("svg") => "image/svg+xml",
    Some("png") => "image/png",
    Some("woff2") => "font/woff2",
    _ => "text/javascript; charset=utf-8",
  }
}

const REACT_SHIM: &str = r#"const React = window.__BABY_MENU_WIDGET_HOST__.React;
export const Children = React.Children;
export const Component = React.Component;
export const Fragment = React.Fragment;
export const Profiler = React.Profiler;
export const PureComponent = React.PureComponent;
export const StrictMode = React.StrictMode;
export const Suspense = React.Suspense;
export const cache = React.cache;
export const cloneElement = React.cloneElement;
export const createContext = React.createContext;
export const createElement = React.createElement;
export const createRef = React.createRef;
export const forwardRef = React.forwardRef;
export const isValidElement = React.isValidElement;
export const lazy = React.lazy;
export const memo = React.memo;
export const startTransition = React.startTransition;
export const use = React.use;
export const useActionState = React.useActionState;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useDebugValue = React.useDebugValue;
export const useDeferredValue = React.useDeferredValue;
export const useState = React.useState;
export const useEffect = React.useEffect;
export const useEffectEvent = React.useEffectEvent;
export const useId = React.useId;
export const useImperativeHandle = React.useImperativeHandle;
export const useInsertionEffect = React.useInsertionEffect;
export const useRef = React.useRef;
export const useMemo = React.useMemo;
export const useReducer = React.useReducer;
export const useLayoutEffect = React.useLayoutEffect;
export const useOptimistic = React.useOptimistic;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useTransition = React.useTransition;
export const version = React.version;
export default React;
"#;

const JSX_SHIM: &str = r#"const runtime = window.__BABY_MENU_WIDGET_HOST__.jsxRuntime;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const Fragment = runtime.Fragment;
"#;
