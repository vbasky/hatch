import { describe, expect, it } from "vitest";
import {
  COMPILED_HOST_HTTP_PREFIX,
  COMPILED_WIDGET_HTTP_PREFIX,
  compiledHostModuleUrl,
  compiledWidgetModuleUrl,
  hostHttpModuleSource,
  hostProtocolModuleSource,
  resolveCompiledWidgetHttpFilePath,
  resolveWidgetProtocolFilePath,
} from "../src/main/widget-protocol";
import { UI_EXPORT_NAMES } from "../src/shared/ui-exports";

describe("widget protocol", () => {
  it("resolves widget URLs only inside the compiler cache", () => {
    expect(resolveWidgetProtocolFilePath("/cache/widgets", "hatch-widget://cpu-temp/abc123/widget.mjs")).toBe(
      "/cache/widgets/cpu-temp/abc123/widget.mjs",
    );
  });

  it("rejects path traversal and non-module widget protocol URLs", () => {
    expect(() => resolveWidgetProtocolFilePath("/cache/widgets", "hatch-widget://cpu-temp/../secret.mjs")).toThrow(
      "Invalid widget module URL",
    );
    expect(() => resolveWidgetProtocolFilePath("/cache/widgets", "hatch-widget://cpu-temp/abc123/widget.txt")).toThrow(
      "Invalid widget module URL",
    );
  });

  it("serves compiled per-widget stylesheets through the widget protocol", () => {
    expect(resolveWidgetProtocolFilePath("/cache/widgets", "hatch-widget://cpu-temp/abc123/widget.css")).toBe(
      "/cache/widgets/cpu-temp/abc123/widget.css",
    );
  });

  it("serves host React shim modules from the renderer host object", () => {
    expect(hostProtocolModuleSource("hatch-host://react/index.mjs")).toContain(
      "window.__HATCH_WIDGET_HOST__.React",
    );
    expect(hostProtocolModuleSource("hatch-host://react-jsx-runtime/index.mjs")).toContain(
      "window.__HATCH_WIDGET_HOST__.jsxRuntime",
    );
    expect(() => hostProtocolModuleSource("hatch-host://unknown/index.mjs")).toThrow("Unknown host module URL");
  });

  it("serves the design system shim re-exporting every public name from the host object", () => {
    const source = hostProtocolModuleSource("hatch-host://ui/index.mjs");
    expect(source).toContain("window.__HATCH_WIDGET_HOST__.ui");
    for (const name of UI_EXPORT_NAMES) {
      expect(source).toContain(`export const ${name} = ui.${name};`);
    }
  });

  it("addresses compiled widgets and host shims as same-origin HTTP paths", () => {
    expect(compiledWidgetModuleUrl("cpu-temp", "abc123def4567890", "widget.mjs")).toBe(
      `${COMPILED_WIDGET_HTTP_PREFIX}/cpu-temp/abc123def4567890/widget.mjs`,
    );
    expect(compiledHostModuleUrl("ui")).toBe(`${COMPILED_HOST_HTTP_PREFIX}/ui/index.mjs`);
    expect(resolveCompiledWidgetHttpFilePath("/cache/widgets", "/__widgets__/cpu-temp/abc123/widget.mjs")).toBe(
      "/cache/widgets/cpu-temp/abc123/widget.mjs",
    );
    expect(hostHttpModuleSource("/__host__/react/index.mjs")).toContain("window.__HATCH_WIDGET_HOST__.React");
    expect(hostHttpModuleSource("/__host__/ui/index.mjs")).toContain("window.__HATCH_WIDGET_HOST__.ui");
  });
});
