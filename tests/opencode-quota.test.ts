import { EventEmitter } from "node:events";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeQuotaResult } from "../extensions/opencode-quota/types";

const authorizations: string[] = [];
const responses: Array<{ status: number; body: string }> = [];

vi.mock("node:os", () => ({
  default: { homedir: () => "/home/tester" },
}));

vi.mock("node:fs", () => ({
  default: { readFileSync: vi.fn() },
}));

vi.mock("node:https", () => ({
  default: {
    request(
      options: { headers?: { Authorization?: string } },
      callback: (res: EventEmitter & { statusCode?: number }) => void,
    ) {
      authorizations.push(options.headers?.Authorization ?? "");
      const pending = responses.shift() ?? { status: 500, body: "" };
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: () => void;
        destroy: () => void;
        end: () => void;
      };
      req.setTimeout = () => undefined;
      req.destroy = () => undefined;
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode?: number };
        res.statusCode = pending.status;
        callback(res);
        res.emit("data", Buffer.from(pending.body));
        res.emit("end");
      };
      return req;
    },
  },
}));

const AUTH_PATH = "/home/tester/.local/share/opencode/auth.json";
const usage = {
  usage: {
    monthly: { percent: 14, resetsAt: "2026-11-30T12:32:17.000Z", status: "ok" },
    weekly: { percent: 27, resetsAt: "2026-11-23T00:00:00.000Z", status: "ok" },
    rolling: { percent: 0, resetsAt: "2026-11-22T13:06:59.958Z", status: "ok" },
  },
};

function installAuth(store: unknown) {
  vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
    if (String(filePath) === AUTH_PATH) return JSON.stringify(store);
    const error = new Error("missing") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  });
}

function db() {
  return {
    exec() {},
    get() {
      return undefined;
    },
    run() {},
  };
}

async function quota(): Promise<OpenCodeQuotaResult> {
  const { actions } = await import("../extensions/opencode-quota/server");
  return actions.getQuota(undefined, { db: db() } as never);
}

describe("opencode quota keys", () => {
  beforeEach(() => {
    authorizations.length = 0;
    responses.length = 0;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_API_KEY;
    vi.resetModules();
  });

  it("uses the console key when the go key is rejected", async () => {
    installAuth({
      "opencode-go": { type: "api", key: "go-key" },
      opencode: { type: "api", key: "console-key" },
    });
    responses.push(
      { status: 401, body: JSON.stringify({ error: { type: "AuthError", message: "Unauthorized" } }) },
      { status: 200, body: JSON.stringify(usage) },
    );

    const result = await quota();

    expect(authorizations).toEqual(["Bearer go-key", "Bearer console-key"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.windows.map((window) => window.id)).toEqual(["monthly", "rolling", "weekly"]);
      expect(result.data.stale).toBe(false);
    }
  });

  it("reports rejection only after every stored key is rejected", async () => {
    installAuth({
      "opencode-go": { type: "api", key: "go-key" },
      opencode: { type: "api", key: "console-key" },
    });
    const denied = { status: 401, body: JSON.stringify({ error: { type: "AuthError" } }) };
    responses.push(denied, denied);

    const result = await quota();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("credential_rejected");
    expect(authorizations).toEqual(["Bearer go-key", "Bearer console-key"]);
  });
});
