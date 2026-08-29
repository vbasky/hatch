import { describe, expect, it, vi } from "vitest";
import { createHatchApi, type HatchTransport } from "../src/shared/hatch-bridge";

function fakeTransport(): HatchTransport & { invoke: ReturnType<typeof vi.fn>; listeners: Map<string, Set<(payload: unknown) => void>> } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    invoke: vi.fn(async () => undefined),
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
  };
}

describe("hatch transport bridge", () => {
  it("maps HatchApi methods onto invoke channels without Electron", async () => {
    const transport = fakeTransport();
    const api = createHatchApi(transport);

    await api.capabilities.list();
    await api.capabilities.invoke("demo", "ping", { ok: true });
    await api.widgets.list();
    await api.db.query("SELECT 1", [1]);
    await api.popover.setContentHeight(333);
    await api.settings.setOpenAtLogin(true);
    await api.app.quit();

    expect(transport.invoke.mock.calls).toEqual([
      ["hatch:capabilities:list"],
      ["hatch:capabilities:invoke", "demo", "ping", { ok: true }],
      ["hatch:widgets:list"],
      ["hatch:db:query", "SELECT 1", [1]],
      ["hatch:popover:set-content-height", 333],
      ["hatch:settings:set-open-at-login", true],
      ["hatch:app:quit"],
    ]);
  });

  it("subscribes to pushed events through the transport", () => {
    const transport = fakeTransport();
    const api = createHatchApi(transport);
    const status = vi.fn();
    const visibility = vi.fn();

    const offStatus = api.agent.onStatus(status);
    const offVisibility = api.popover.onVisibility(visibility);

    for (const listener of transport.listeners.get("hatch:agent:status") ?? []) {
      listener({ text: "I built the widget", eventType: "text_delta" });
    }
    for (const listener of transport.listeners.get("hatch:popover:visibility") ?? []) {
      listener({ visible: false });
    }

    expect(status).toHaveBeenCalledWith({ text: "I built the widget", eventType: "text_delta" });
    expect(visibility).toHaveBeenCalledWith({ visible: false });

    offStatus();
    offVisibility();
    expect(transport.listeners.get("hatch:agent:status")?.size ?? 0).toBe(0);
    expect(transport.listeners.get("hatch:popover:visibility")?.size ?? 0).toBe(0);
  });
});
