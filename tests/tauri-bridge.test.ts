import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tauri bridge", () => {
  it("talks to the packaged host over same-origin HTTP RPC", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/renderer/tauri-bridge.ts"), "utf8");
    expect(source).toContain("rpcUrl()");
    expect(source).toContain("/__rpc");
    expect(source).toContain("invokeHostRpc");
    expect(source).toContain("hatch-host-event");
    expect(source).not.toMatch(/on:\s*\(\)\s*=>\s*\(\)\s*=>\s*undefined/);
  });

  it("forwards packaged host events into the loopback webview", async () => {
    const tauriApp = await readFile(resolve(import.meta.dirname, "../src-tauri/src/tauri_app.rs"), "utf8");
    const kde = await readFile(resolve(import.meta.dirname, "../src-tauri/src/kde/mod.rs"), "utf8");
    expect(tauriApp).toContain("emit_renderer_event");
    expect(tauriApp).toContain("hatch-host-event");
    expect(tauriApp).toContain("window.eval");
    expect(kde).toContain("emit_renderer_event");
    expect(kde).toContain("hatch-host-event");
    expect(kde).toContain("hatch_kde_eval");
  });

  it("installs the packaged HTTP bridge even when Tauri did not inject IPC", async () => {
    const main = await readFile(resolve(import.meta.dirname, "../src/renderer/main.tsx"), "utf8");
    expect(main).toContain("installTauriHatch");
    expect(main).toMatch(/import\.meta\.env\.PROD/);
    expect(main).toContain('from "./tauri-bridge"');
    expect(main).not.toContain('await import("./tauri-bridge")');
  });
});
