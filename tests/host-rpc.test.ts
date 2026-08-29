import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { HatchAgentRuntimeSendOptions } from "../src/main/agent-runtime";
import { createHostHandlers } from "../src/main/host-handlers";
import {
  decodeHostRpcLine,
  encodeHostRpcMessage,
  runHostRpcStdio,
  type HostRpcRequest,
} from "../src/main/host-rpc";

describe("host JSON-RPC", () => {
  it("encodes and decodes newline-delimited request, response, and event frames", () => {
    const request: HostRpcRequest = { id: "1", type: "request", channel: "hatch:recipes:list", args: [] };
    const encoded = encodeHostRpcMessage(request);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.includes("\n", encoded.length - 1) && encoded.split("\n").length === 2).toBe(true);
    expect(decodeHostRpcLine(encoded.trim())).toEqual(request);
  });

  it("rejects malformed lines", () => {
    expect(() => decodeHostRpcLine("{")).toThrow(/invalid host rpc/i);
    expect(() => decodeHostRpcLine(JSON.stringify({ type: "request" }))).toThrow(/invalid host rpc/i);
  });

  it("answers requests over stdio and pushes events for the same request id's emit", async () => {
    const agentRuntime = {
      send: vi.fn(async (_prompt: string, options?: HatchAgentRuntimeSendOptions) => {
        await options?.onStatus?.({ text: "working", eventType: "text_delta" });
        return { assistantText: "done" };
      }),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
    };
    const handlers = createHostHandlers({ rootDir: "/repo", agentRuntime });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const output: string[] = [];
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => output.push(chunk));

    const running = runHostRpcStdio(handlers, stdin, stdout);
    stdin.write(
      encodeHostRpcMessage({ id: "req-1", type: "request", channel: "hatch:agent:send", args: ["build"] }),
    );
    stdin.end();
    await running;

    const frames = output.join("").trim().split("\n").map((line) => decodeHostRpcLine(line));
    expect(frames).toEqual([
      { type: "event", channel: "hatch:agent:status", payload: { text: "working", eventType: "text_delta" } },
      { id: "req-1", type: "response", ok: true, result: { assistantText: "done" } },
    ]);
  });

  it("returns an error response when the channel is unknown", async () => {
    const handlers = createHostHandlers({
      rootDir: "/repo",
      agentRuntime: {
        send: vi.fn(),
        save: vi.fn(),
        rollback: vi.fn(),
        currentSessionSnapshot: vi.fn(),
        currentTurn: vi.fn(),
      },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const output: string[] = [];
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => output.push(chunk));

    const running = runHostRpcStdio(handlers, stdin, stdout);
    stdin.write(encodeHostRpcMessage({ id: "req-2", type: "request", channel: "hatch:nope", args: [] }));
    stdin.end();
    await running;

    expect(decodeHostRpcLine(output.join("").trim())).toMatchObject({
      id: "req-2",
      type: "response",
      ok: false,
    });
  });
});
