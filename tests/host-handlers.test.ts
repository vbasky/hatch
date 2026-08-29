import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HatchAgentRuntimeSendOptions } from "../src/main/agent-runtime";
import { HOST_INVOKE_CHANNELS, createHostHandlers } from "../src/main/host-handlers";

function fakeAgentRuntime() {
  return {
    send: vi.fn(),
    save: vi.fn(),
    rollback: vi.fn(),
    currentSessionSnapshot: vi.fn(),
    currentTurn: vi.fn(),
  };
}

describe("createHostHandlers", () => {
  it("invokes recipes, capabilities, and widgets without an Electron mock", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hatch-host-handlers-"));
    const recipesDir = join(rootDir, "extensions-dev", "recipes");
    await mkdir(recipesDir, { recursive: true });
    await writeFile(
      join(recipesDir, "daily-standup.html"),
      `<html><head><title>Daily Standup</title></head><body></body></html>\n`,
    );
    const serverActions = {
      list: vi.fn(async () => [{ id: "demo.ping", extensionId: "demo", action: "ping" }]),
      invoke: vi.fn(async (extensionId: string, action: string, input: unknown) => ({ extensionId, action, input })),
    };
    const widgetModules = {
      list: vi.fn(async () => [{ id: "cpu-temp.widget", extensionId: "cpu-temp", moduleUrl: "/@fs/cpu-temp/widget.tsx" }]),
    };
    const handlers = createHostHandlers({
      rootDir,
      agentRuntime: fakeAgentRuntime(),
      serverActions,
      widgetModules,
      recipesDir,
    });

    await expect(handlers.invoke("hatch:recipes:list")).resolves.toEqual([
      {
        id: "daily-standup",
        title: "Daily Standup",
        fileName: "daily-standup.html",
        path: join(recipesDir, "daily-standup.html"),
      },
    ]);
    await expect(handlers.invoke("hatch:capabilities:list")).resolves.toEqual([
      { id: "demo.ping", extensionId: "demo", action: "ping" },
    ]);
    await expect(handlers.invoke("hatch:capabilities:invoke", ["demo", "ping", { ok: true }])).resolves.toEqual({
      extensionId: "demo",
      action: "ping",
      input: { ok: true },
    });
    await expect(handlers.invoke("hatch:widgets:list")).resolves.toEqual([
      { id: "cpu-temp.widget", extensionId: "cpu-temp", moduleUrl: "/@fs/cpu-temp/widget.tsx" },
    ]);
  });

  it("forwards agent status through the emit callback instead of event.sender", async () => {
    const emit = vi.fn();
    const agentRuntime = {
      ...fakeAgentRuntime(),
      send: vi.fn(async (_prompt: string, options?: HatchAgentRuntimeSendOptions) => {
        await options?.onStatus?.({ text: "I built the widget", eventType: "text_delta" });
        return { assistantText: "done" };
      }),
    };
    const handlers = createHostHandlers({ rootDir: "/repo", agentRuntime });

    await expect(handlers.invoke("hatch:agent:send", ["build a widget"], emit)).resolves.toEqual({
      assistantText: "done",
    });
    expect(emit).toHaveBeenCalledWith("hatch:agent:status", {
      text: "I built the widget",
      eventType: "text_delta",
    });
  });

  it("rejects unknown channels", async () => {
    const handlers = createHostHandlers({ rootDir: "/repo", agentRuntime: fakeAgentRuntime() });
    await expect(handlers.invoke("hatch:not-a-channel")).rejects.toThrow(/unknown host channel/i);
  });

  it("exports the invoke channel list the Electron adapter and Tauri shell share", () => {
    expect(HOST_INVOKE_CHANNELS).toContain("hatch:agent:send");
    expect(HOST_INVOKE_CHANNELS).toContain("hatch:app:quit");
    expect(new Set(HOST_INVOKE_CHANNELS).size).toBe(HOST_INVOKE_CHANNELS.length);
  });
});
