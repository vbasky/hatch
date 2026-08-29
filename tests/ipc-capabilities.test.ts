import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HatchAgentRuntimeSendOptions } from "../src/main/agent-runtime";
import { createHostHandlers } from "../src/main/host-handlers";
import { createExtensionDatabase } from "../src/main/extension-database";

function fakeAgentRuntime() {
  return {
    send: vi.fn(),
    save: vi.fn(),
    rollback: vi.fn(),
    currentSessionSnapshot: vi.fn(),
    currentTurn: vi.fn(),
  };
}

describe("host capability channels", () => {
  it("lists recipes from the active extension workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hatch-ipc-recipes-"));
    const recipesDir = join(rootDir, "extensions-dev", "recipes");
    await mkdir(recipesDir, { recursive: true });
    await writeFile(
      join(recipesDir, "daily-standup.html"),
      `<html><head><title>Daily Standup</title></head><body><h1>Fallback</h1></body></html>\n`,
    );
    const handlers = createHostHandlers({ rootDir, agentRuntime: fakeAgentRuntime(), recipesDir });

    await expect(handlers.invoke("hatch:recipes:list")).resolves.toEqual([
      {
        id: "daily-standup",
        title: "Daily Standup",
        fileName: "daily-standup.html",
        path: join(recipesDir, "daily-standup.html"),
      },
    ]);
  });

  it("invokes server actions", async () => {
    const serverActions = {
      list: vi.fn(async () => [{ id: "demo.ping", extensionId: "demo", action: "ping" }]),
      invoke: vi.fn(async (extensionId: string, action: string, input: unknown) => ({ extensionId, action, input })),
    };
    const handlers = createHostHandlers({ rootDir: "/repo", agentRuntime: fakeAgentRuntime(), serverActions });

    await expect(handlers.invoke("hatch:capabilities:list")).resolves.toEqual([
      { id: "demo.ping", extensionId: "demo", action: "ping" },
    ]);
    await expect(handlers.invoke("hatch:capabilities:invoke", ["demo", "ping", { ok: true }])).resolves.toEqual({
      extensionId: "demo",
      action: "ping",
      input: { ok: true },
    });
  });

  it("forwards agent runtime status events", async () => {
    const emit = vi.fn();
    const agentRuntime = {
      ...fakeAgentRuntime(),
      send: vi.fn(async (_prompt: string, options?: HatchAgentRuntimeSendOptions) => {
        await options?.onStatus?.({ text: "I built the widget", eventType: "text_delta" });
        return { assistantText: "done" };
      }),
    };
    const handlers = createHostHandlers({ rootDir: "/repo", agentRuntime });
    await handlers.invoke("hatch:agent:send", ["build a widget"], emit);
    expect(emit).toHaveBeenCalledWith("hatch:agent:status", {
      text: "I built the widget",
      eventType: "text_delta",
    });
  });

  it("registers SQL database channels backed by a shared store", async () => {
    const database = createExtensionDatabase(":memory:");
    const handlers = createHostHandlers({ rootDir: "/repo", agentRuntime: fakeAgentRuntime(), database });

    await handlers.invoke("hatch:db:exec", ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)"]);
    await expect(handlers.invoke("hatch:db:run", ["INSERT INTO notes (body) VALUES (?)", ["hi"]])).resolves.toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    await expect(handlers.invoke("hatch:db:query", ["SELECT body FROM notes"])).resolves.toEqual([{ body: "hi" }]);
  });

  it("registers popover, settings, and quit channels", async () => {
    const popover = {
      setContentHeight: vi.fn(),
      setContentSize: vi.fn(),
      getVisibility: vi.fn(() => ({ visible: false })),
    };
    const settings = {
      get: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
      setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => ({ openAtLogin, agentName: "claude", agents: [] })),
      setAgent: vi.fn(async (agentName: string) => ({ openAtLogin: false, agentName, agents: [] })),
      addAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
      updateAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
      removeAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
    };
    const appController = { quit: vi.fn() };
    const handlers = createHostHandlers({
      rootDir: "/repo",
      agentRuntime: fakeAgentRuntime(),
      popover,
      settings,
      appController,
    });

    await expect(handlers.invoke("hatch:popover:set-content-height", [333])).resolves.toEqual({ ok: true });
    await expect(handlers.invoke("hatch:settings:set-open-at-login", [true])).resolves.toEqual({
      openAtLogin: true,
      agentName: "claude",
      agents: [],
    });
    await expect(handlers.invoke("hatch:app:quit")).resolves.toEqual({ ok: true });
    expect(appController.quit).toHaveBeenCalledOnce();
  });
});
