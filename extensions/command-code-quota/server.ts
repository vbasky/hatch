import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { HatchServerContext } from "@hatch/contracts";
import type {
  CommandCodeQuotaData,
  CommandCodeQuotaFailureKind,
  CommandCodeQuotaResult,
  CommandCodeWindow,
} from "./types";

const API_HOST = "api.commandcode.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_CAP = 64 * 1024;
const CACHE_TABLE = `CREATE TABLE IF NOT EXISTS command_code_quota_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL,
  stored_at INTEGER NOT NULL
)`;

type Failure = Extract<CommandCodeQuotaResult, { ok: false }>;

const COPY: Record<CommandCodeQuotaFailureKind, string> = {
  auth_required: "run cmd login",
  auth_source_missing: "command code auth file not found",
  auth_source_unreadable: "could not read command code auth file",
  auth_source_malformed: "command code auth file is not valid json",
  auth_source_incompatible: "no command code api key",
  credential_rejected: "command code rejected this key",
  connectivity: "could not reach command code usage",
  rate_limited: "command code rate limited; retry later",
  quota_service: "command code usage service error",
  parse_incompatible: "could not parse command code usage",
};

const STALE_ELIGIBLE = new Set<CommandCodeQuotaFailureKind>([
  "connectivity",
  "rate_limited",
  "quota_service",
]);

let inFlight: Promise<CommandCodeQuotaResult> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function fail(kind: CommandCodeQuotaFailureKind): Failure {
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function authFileCandidates(): string[] {
  const home = os.homedir();
  const names: string[] = [path.join(home, ".commandcode", "auth.json")];
  if (process.env.XDG_CONFIG_HOME) {
    names.push(path.join(process.env.XDG_CONFIG_HOME, "commandcode", "auth.json"));
  }
  names.push(path.join(home, ".config", "commandcode", "auth.json"));
  if (process.env.XDG_DATA_HOME) {
    names.push(path.join(process.env.XDG_DATA_HOME, "commandcode", "auth.json"));
  }
  names.push(path.join(home, ".local", "share", "commandcode", "auth.json"));
  return names;
}

function readApiKey(): string | Failure {
  const envKey = process.env.COMMAND_CODE_API_KEY || process.env.COMMANDCODE_API_KEY;
  if (typeof envKey === "string" && envKey.trim()) return envKey.trim();
  let lastKind: CommandCodeQuotaFailureKind = "auth_source_missing";
  for (const filePath of authFileCandidates()) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return fail("auth_source_unreadable");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("auth_source_malformed");
    }
    const store = asRecord(parsed);
    const key = stringValue(store?.apiKey);
    if (!key) {
      lastKind = "auth_source_incompatible";
      continue;
    }
    return key;
  }
  return fail(lastKind);
}

function apiGet(pathname: string, token: string): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: API_HOST,
        path: pathname,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "hatch-command-code-quota",
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

function classifyHttp(status: number, body: unknown): Failure | null {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  const code = stringValue(error?.code) ?? "";
  if (status === 401 || code === "UNAUTHORIZED") return fail("credential_rejected");
  if (status === 403) return fail("credential_rejected");
  if (status === 429) return fail("rate_limited");
  if (status === 0) return fail("connectivity");
  if (status >= 500) return fail("quota_service");
  if (status >= 400) return fail("quota_service");
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function resetIso(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function windowFromUsedCap(
  id: CommandCodeWindow["id"],
  label: string,
  raw: unknown,
): CommandCodeWindow | null {
  const record = asRecord(raw);
  if (!record) return null;
  const used = finiteNumber(record.used);
  const cap = finiteNumber(record.cap);
  if (used == null || cap == null || cap <= 0) return null;
  const percentUsed = clampPercent((used / cap) * 100);
  const resetsAt = resetIso(record.resetAt);
  return {
    id,
    label,
    percentUsed,
    percentRemaining: 100 - percentUsed,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function parseWhoamiLogin(body: unknown): string | undefined {
  const record = asRecord(body);
  const user = asRecord(record?.user);
  const org = asRecord(record?.org);
  return stringValue(user?.userName) || stringValue(user?.name) || stringValue(org?.login);
}

async function fetchQuota(token: string): Promise<CommandCodeQuotaData | Failure> {
  const creditsRes = await apiGet("/alpha/billing/credits", token);
  if (creditsRes.error === "timeout" || (creditsRes.status === 0 && !creditsRes.body)) {
    return fail("connectivity");
  }
  const creditsJson = parseJson(creditsRes.body);
  const classified = classifyHttp(creditsRes.status, creditsJson);
  if (classified) return classified;
  if (creditsJson == null) return fail("parse_incompatible");
  const root = asRecord(creditsJson);
  const credits = asRecord(root?.credits);
  if (!credits) return fail("parse_incompatible");

  const monthlyCredits = finiteNumber(credits.monthlyCredits) ?? 0;
  const purchasedCredits = finiteNumber(credits.purchasedCredits) ?? 0;
  const freeCredits = finiteNumber(credits.freeCredits) ?? 0;
  const remainingCredits = monthlyCredits + purchasedCredits + freeCredits;
  const hasCreditPool =
    finiteNumber(credits.monthlyCredits) != null ||
    finiteNumber(credits.purchasedCredits) != null ||
    finiteNumber(credits.freeCredits) != null;

  const limits = asRecord(root?.windowLimits);
  const windows: CommandCodeWindow[] = [];
  const fiveHour = windowFromUsedCap("five_hour", "5 hour", limits?.fiveHour);
  const weekly = windowFromUsedCap("weekly", "Weekly", limits?.weekly);

  const [whoamiRes, summaryRes, subRes] = await Promise.all([
    apiGet("/alpha/whoami", token),
    apiGet("/alpha/usage/summary", token),
    apiGet("/alpha/billing/subscriptions", token),
  ]);
  const whoamiJson = parseJson(whoamiRes.body);
  const summaryJson = parseJson(summaryRes.body);
  const subJson = parseJson(subRes.body);
  const login = parseWhoamiLogin(whoamiJson);
  const summary = asRecord(summaryJson);
  const totalCost = finiteNumber(summary?.totalCost);
  const subData = asRecord(asRecord(subJson)?.data);
  const periodEnd = resetIso(subData?.currentPeriodEnd);

  if (hasCreditPool && totalCost != null && totalCost >= 0) {
    const limit = remainingCredits + totalCost;
    if (limit > 0) {
      const percentUsed = clampPercent((totalCost / limit) * 100);
      windows.push({
        id: "monthly",
        label: "Monthly",
        percentUsed,
        percentRemaining: 100 - percentUsed,
        ...(periodEnd ? { resetsAt: periodEnd } : {}),
      });
    }
  }
  if (fiveHour) windows.push(fiveHour);
  if (weekly) windows.push(weekly);

  if (windows.length === 0 && !hasCreditPool) return fail("parse_incompatible");

  return {
    ...(login ? { login } : {}),
    ...(hasCreditPool ? { remainingCredits } : {}),
    windows,
    stale: false,
  };
}

function ensureCache(db: HatchServerContext["db"]) {
  db.exec(CACHE_TABLE);
}

function readCache(db: HatchServerContext["db"]): CommandCodeQuotaData | null {
  ensureCache(db);
  const row = db.get<{ snapshot_json: string }>(
    "SELECT snapshot_json FROM command_code_quota_cache WHERE id = 1",
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.snapshot_json) as CommandCodeQuotaData;
    if (!parsed || !Array.isArray(parsed.windows)) return null;
    return parsed;
  } catch {
    db.run("DELETE FROM command_code_quota_cache WHERE id = 1");
    return null;
  }
}

function writeCache(db: HatchServerContext["db"], data: CommandCodeQuotaData) {
  ensureCache(db);
  db.run(
    "INSERT INTO command_code_quota_cache (id, snapshot_json, stored_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, stored_at = excluded.stored_at",
    [JSON.stringify({ ...data, stale: false }), Date.now()],
  );
}

async function acquire(context: HatchServerContext): Promise<CommandCodeQuotaResult> {
  const cached = readCache(context.db);
  const key = readApiKey();
  if (isFailure(key)) return key;
  const fetched = await fetchQuota(key);
  if (isFailure(fetched)) {
    if (cached && STALE_ELIGIBLE.has(fetched.kind)) {
      return { ok: true, checkedAt: nowIso(), data: { ...cached, stale: true } };
    }
    return fetched;
  }
  writeCache(context.db, fetched);
  return { ok: true, checkedAt: nowIso(), data: fetched };
}

async function getQuota(_input: unknown, context: HatchServerContext): Promise<CommandCodeQuotaResult> {
  if (inFlight) return inFlight;
  inFlight = acquire(context).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const actions = {
  getQuota,
};
