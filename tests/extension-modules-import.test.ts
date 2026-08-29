import { describe, expect, it } from "vitest";
import { toRuntimeModuleHref } from "../src/renderer/extension-modules";

describe("runtime module URLs", () => {
  it("resolves packaged widget paths against the page origin so WKWebView can import them", () => {
    expect(toRuntimeModuleHref("/__widgets__/grok-quota/abc/widget.mjs", "http://127.0.0.1:5337/index.html")).toBe(
      "http://127.0.0.1:5337/__widgets__/grok-quota/abc/widget.mjs",
    );
    expect(toRuntimeModuleHref("http://127.0.0.1:5337/__host__/ui/index.mjs")).toBe(
      "http://127.0.0.1:5337/__host__/ui/index.mjs",
    );
  });
});
