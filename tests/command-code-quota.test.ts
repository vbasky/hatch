import { EventEmitter } from "node:events";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandCodeQuotaResult } from "../extensions/command-code-quota/types";

const responses: Array<{ status: number; body: string }> = [];

vi.mock("node:os", () => ({
  default: { homedir: () => "/home/tester" },
}));

vi.mock("node:fs", () => ({
  default: { readFileSync: vi.fn() },
}));

vi.mock("node:https", () => ({
  default: {
    request(_options: unknown, callback: (res: EventEmitter & { statusCode?: number }) => void) {
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

function installAuth() {
  vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
    if (String(filePath) === "/home/tester/.commandcode/auth.json") {
      return JSON.stringify({ apiKey: "stored-key", userName: "vbasky" });
    }
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

async function quota(): Promise<CommandCodeQuotaResult> {
  const { actions } = await import("../extensions/command-code-quota/server");
  return actions.getQuota(undefined, { db: db() } as never);
}

describe("command code quota auth", () => {
  beforeEach(() => {
    responses.length = 0;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.COMMAND_CODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    vi.resetModules();
  });

  it("asks for login when the stored key has expired", async () => {
    installAuth();
    responses.push({
      status: 401,
      body: JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "Your API key has expired. Log in again to get a new key: run `cmd login`",
        },
      }),
    });

    const result = await quota();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("auth_required");
      expect(result.message).toBe("run cmd login");
    }
  });

  it("still reports a rejected key when the server does not say it expired", async () => {
    installAuth();
    responses.push({
      status: 401,
      body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
    });

    const result = await quota();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("credential_rejected");
  });
});
