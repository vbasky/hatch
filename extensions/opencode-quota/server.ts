import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { HatchServerContext } from "@hatch/contracts";
import type {
  OpenCodeQuotaData,
  OpenCodeQuotaFailureKind,
  OpenCodeQuotaResult,
  OpenCodeWindow,
} from "./types";

const USAGE_HOST = "opencode.ai";
const USAGE_PATH = "/zen/go/v1/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_CAP = 64 * 1024;
const CACHE_TABLE = `CREATE TABLE IF NOT EXISTS opencode_quota_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL,
  stored_at INTEGER NOT NULL
)`;

type Failure = Extract<OpenCodeQuotaResult, { ok: false }>;

const COPY: Record<OpenCodeQuotaFailureKind, string> = {
  auth_required: "connect opencode go in opencode",
  auth_source_missing: "opencode auth file not found",
  auth_source_unreadable: "could not read opencode auth file",
  auth_source_malformed: "opencode auth file is not valid json",
  auth_source_incompatible: "no opencode go key in auth file",
  credential_rejected: "opencode rejected this go key",
  subscription_required: "opencode go subscription required",
  connectivity: "could not reach opencode usage",
  rate_limited: "opencode usage rate limited; retry later",
  quota_service: "opencode usage service error",
  parse_incompatible: "could not parse opencode usage",
};

const STALE_ELIGIBLE = new Set<OpenCodeQuotaFailureKind>([
  "connectivity",
  "rate_limited",
  "quota_service",
]);

let inFlight: Promise<OpenCodeQuotaResult> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function fail(kind: OpenCodeQuotaFailureKind): Failure {
  return { ok: false, checkedAt: nowIso(), kind, message: COPY[kind] };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && (value as Failure).ok === false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function authFileCandidates(): string[] {
  const home = os.homedir();
  const names: string[] = [];
  if (process.env.XDG_DATA_HOME) names.push(path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json"));
  names.push(path.join(home, ".local", "share", "opencode", "auth.json"));
  if (process.env.XDG_CONFIG_HOME) names.push(path.join(process.env.XDG_CONFIG_HOME, "opencode", "auth.json"));
  names.push(path.join(home, ".config", "opencode", "auth.json"));
  return names;
}

function readGoKey(): string | Failure {
  let fileError: Failure | undefined;
  for (const filePath of authFileCandidates()) {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fail("auth_source_malformed");
      }
      const store = asRecord(parsed);
      if (!store) return fail("auth_source_malformed");
      const go = asRecord(store["opencode-go"]);
      const key = typeof go?.key === "string" ? go.key.trim() : "";
      const type = typeof go?.type === "string" ? go.type : "";
      if (key && (!type || type === "api")) return key;
      fileError = fail("auth_source_incompatible");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") fileError = fail("auth_source_unreadable");
      else fileError ??= fail("auth_source_missing");
    }
  }
  const envKey = process.env.OPENCODE_API_KEY;
  if (typeof envKey === "string" && envKey.trim()) return envKey.trim();
  return fileError ?? fail("auth_source_missing");
}

function getUsage(token: string): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: USAGE_HOST,
        path: USAGE_PATH,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "hatch-opencode-quota",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          if (body.length < RESPONSE_CAP) body += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ status: 0, body: "", error: "timeout" });
    });
    req.on("error", (error) => {
      resolve({ status: 0, body: "", error: (error as NodeJS.ErrnoException).code ?? "network_error" });
    });
    req.end();
  });
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function decodeWindow(
  id: OpenCodeWindow["id"],
  label: string,
  raw: unknown,
): OpenCodeWindow | null {
  const record = asRecord(raw);
  if (!record) return null;
  const percentRaw = record.percent;
  if (typeof percentRaw !== "number" || !Number.isFinite(percentRaw)) return null;
  const percentUsed = clampPercent(percentRaw);
  const status = record.status === "rate-limited" ? "rate-limited" : "ok";
  const resetsAt = typeof record.resetsAt === "string" && record.resetsAt ? record.resetsAt : undefined;
  return {
    id,
    label,
    percentUsed,
    percentRemaining: 100 - percentUsed,
    ...(resetsAt ? { resetsAt } : {}),
    status,
  };
}

function parseUsage(body: string, status: number): OpenCodeQuotaData | Failure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail("parse_incompatible");
  }
  const record = asRecord(parsed);
  const error = asRecord(record?.error);
  const errorType = typeof error?.type === "string" ? error.type : "";
  if (status === 401 || errorType === "AuthError") return fail("credential_rejected");
  if (status === 403 || errorType === "EntitlementError") return fail("subscription_required");
  if (status === 429) return fail("rate_limited");
  if (status === 0) return fail("connectivity");
  if (status >= 500) return fail("quota_service");
  if (status !== 200) return fail("quota_service");
  const usage = asRecord(record?.usage);
  if (!usage) return fail("parse_incompatible");
  const monthly = decodeWindow("monthly", "Monthly", usage.monthly);
  if (!monthly) return fail("parse_incompatible");
  const windows: OpenCodeWindow[] = [monthly];
  const weekly = decodeWindow("weekly", "Weekly", usage.weekly);
  const rolling = decodeWindow("rolling", "5 hour", usage.rolling);
  if (rolling) windows.push(rolling);
  if (weekly) windows.push(weekly);
  return { windows, stale: false };
}

function ensureCache(db: HatchServerContext["db"]) {
  db.exec(CACHE_TABLE);
}

function readCache(db: HatchServerContext["db"]): OpenCodeQuotaData | null {
  ensureCache(db);
  const row = db.get<{ snapshot_json: string }>("SELECT snapshot_json FROM opencode_quota_cache WHERE id = 1");
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.snapshot_json) as OpenCodeQuotaData;
    if (!parsed || !Array.isArray(parsed.windows) || parsed.windows.length === 0) return null;
    return parsed;
  } catch {
    db.run("DELETE FROM opencode_quota_cache WHERE id = 1");
    return null;
  }
}

function writeCache(db: HatchServerContext["db"], data: OpenCodeQuotaData) {
  ensureCache(db);
  db.run(
    "INSERT INTO opencode_quota_cache (id, snapshot_json, stored_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, stored_at = excluded.stored_at",
    [JSON.stringify({ ...data, stale: false }), Date.now()],
  );
}

async function acquire(context: HatchServerContext): Promise<OpenCodeQuotaResult> {
  const cached = readCache(context.db);
  const key = readGoKey();
  if (isFailure(key)) return key;
  const response = await getUsage(key);
  if (response.error === "timeout" || (response.status === 0 && !response.body)) {
    if (cached) return { ok: true, checkedAt: nowIso(), data: { ...cached, stale: true } };
    return fail("connectivity");
  }
  const parsed = parseUsage(response.body, response.status);
  if (isFailure(parsed)) {
    if (cached && STALE_ELIGIBLE.has(parsed.kind)) {
      return { ok: true, checkedAt: nowIso(), data: { ...cached, stale: true } };
    }
    return parsed;
  }
  writeCache(context.db, parsed);
  return { ok: true, checkedAt: nowIso(), data: parsed };
}

async function getQuota(_input: unknown, context: HatchServerContext): Promise<OpenCodeQuotaResult> {
  if (inFlight) return inFlight;
  inFlight = acquire(context).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const actions = {
  getQuota,
};
