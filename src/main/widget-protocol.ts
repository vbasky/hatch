import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { UI_EXPORT_NAMES } from "../shared/ui-exports";

export const WIDGET_SCHEME = "hatch-widget";
export const HOST_SCHEME = "hatch-host";

// Same-origin HTTP paths served next to the packaged renderer. WKWebView will
// not load custom-scheme ES modules from an http://127.0.0.1 page, so compiled
// widgets and host shims are addressed here instead of hatch-widget://.
export const COMPILED_WIDGET_HTTP_PREFIX = "/__widgets__";
export const COMPILED_HOST_HTTP_PREFIX = "/__host__";

export function compiledWidgetModuleUrl(extensionId: string, hash: string, relativePath: string): string {
  return `${COMPILED_WIDGET_HTTP_PREFIX}/${encodeURIComponent(extensionId)}/${hash}/${relativePath}`;
}

export function compiledHostModuleUrl(moduleId: "react" | "react-jsx-runtime" | "ui"): string {
  return `${COMPILED_HOST_HTTP_PREFIX}/${moduleId}/index.mjs`;
}

export function resolveCompiledWidgetHttpFilePath(widgetCacheDir: string, requestPath: string): string {
  const pathOnly = stripQuery(requestPath);
  const prefix = `${COMPILED_WIDGET_HTTP_PREFIX}/`;
  if (!pathOnly.startsWith(prefix)) throw new Error("Invalid widget module URL");
  return resolveWidgetProtocolFilePath(widgetCacheDir, `${WIDGET_SCHEME}://${pathOnly.slice(prefix.length)}`);
}

export function hostHttpModuleSource(requestPath: string): string {
  const pathOnly = stripQuery(requestPath);
  const prefix = `${COMPILED_HOST_HTTP_PREFIX}/`;
  if (!pathOnly.startsWith(prefix)) throw new Error("Unknown host module URL");
  return hostProtocolModuleSource(`${HOST_SCHEME}://${pathOnly.slice(prefix.length)}`);
}

function stripQuery(requestPath: string): string {
  return requestPath.split("?")[0] ?? requestPath;
}

export function resolveWidgetProtocolFilePath(widgetCacheDir: string, rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== `${WIDGET_SCHEME}:`) throw new Error("Invalid widget module URL");
  const extensionId = decodeURIComponent(url.hostname);
  const pathSegments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (!extensionId || pathSegments.length < 2 || pathSegments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid widget module URL");
  }
  const lastSegment = pathSegments.at(-1) ?? "";
  if (!lastSegment.endsWith(".mjs") && !lastSegment.endsWith(".css")) throw new Error("Invalid widget module URL");

  const filePath = resolve(join(widgetCacheDir, extensionId, ...pathSegments));
  const relativePath = relative(resolve(widgetCacheDir), filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Invalid widget module URL");
  return filePath;
}

export function hostProtocolModuleSource(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== `${HOST_SCHEME}:`) throw new Error("Unknown host module URL");
  const moduleId = `${url.hostname}${url.pathname}`;

  if (moduleId === "react/index.mjs") {
    return `const React = window.__HATCH_WIDGET_HOST__.React;
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
`;
  }

  if (moduleId === "react-jsx-runtime/index.mjs") {
    return `const runtime = window.__HATCH_WIDGET_HOST__.jsxRuntime;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const Fragment = runtime.Fragment;
`;
  }

  if (moduleId === "ui/index.mjs") {
    // Re-export the design system from the host global, mirroring the React
    // shim. The export list is the contract in shared/ui-exports.ts; Radix, cva,
    // and lucide are bundled inside the host build and never seen by the widget
    // compiler, so widget import constraints stay intact.
    const reexports = UI_EXPORT_NAMES.map((name) => `export const ${name} = ui.${name};`).join("\n");
    return `const ui = window.__HATCH_WIDGET_HOST__.ui;\n${reexports}\n`;
  }

  throw new Error("Unknown host module URL");
}

export function widgetContentType(filePath: string): string {
  return extname(filePath) === ".css"
    ? "text/css; charset=utf-8"
    : "text/javascript; charset=utf-8";
}
