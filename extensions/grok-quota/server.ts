import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import type { HatchServerContext } from "@hatch/contracts";
import type {
  GrokQuotaResult,
  GrokQuotaSnapshot,
  GrokQuotaWindow,
  QuotaFailure,
  QuotaFailureKind,
  QuotaSourceTried,
  StoredGrokQuotaSnapshot,
} from "./types";

const OPERATION = "grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig";
const ENDPOINT_HOST = "grok.com";
const ENDPOINT_PATH = "/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const SOURCE = "grok-credits-grpc-web" as const;
const SCHEMA_VERSION = 2 as const;
const SOURCE_VERSION = 1 as const;
const EMPTY_FRAME = Buffer.from([0, 0, 0, 0, 0]);
const RESPONSE_CAP = 64 * 1024;
const REQUEST_DEADLINE_MS = 15_000;
const CLI_TIMEOUT_MS = 20_000;
const CLI_OUTPUT_CAP = 128 * 1024;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OIDC_PREFIX = "https://auth.x.ai::";
const LEGACY_SCOPE = "https://accounts.x.ai/sign-in";
const API_KEY_SCOPE = "xai::api_key";
const CACHE_TABLE = `CREATE TABLE IF NOT EXISTS grok_quota_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_binding TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  stored_at INTEGER NOT NULL
)`;

const PRODUCT_BY_ENUM: Record<number, { slug: string; label: string }> = {
  1: { slug: "api", label: "API" },
  2: { slug: "grok-build", label: "Grok Build" },
  3: { slug: "grok-plugins", label: "Grok Plugins" },
  4: { slug: "chat", label: "Chat" },
  5: { slug: "imagine", label: "Imagine" },
  6: { slug: "voice", label: "Voice" },
};

const FAILURE_COPY: Record<QuotaFailureKind, string> = {
  auth_required: "sign in with grok login",
  auth_expired: "grok session expired. run grok login",
  auth_scope_ambiguous: "multiple grok accounts in auth file; keep one signed-in principal",
  auth_principal_changed: "grok account changed during refresh",
  auth_source_missing: "grok auth file not found. run grok login",
  auth_source_unreadable: "could not read grok auth file",
  auth_source_malformed: "grok auth file is not valid json",
  auth_source_incompatible: "no supported grok login in auth file",
  credential_rejected: "grok rejected this session. run grok login",
  cli_not_found: "grok cli not found; install it to refresh login",
  cli_launch_failed: "could not launch grok cli to refresh login",
  connectivity: "could not reach grok usage",
  rate_limited: "grok usage rate limited; retry later",
  quota_service: "grok usage service error",
  official_quota_source_unavailable: "grok usage source unavailable",
  team_scope_unsupported: "team grok usage is not available on this surface",
  response_too_large: "grok usage response was too large",
  quota_unreported: "grok did not report usage for this period",
  parse_incompatible: "could not parse grok usage response",
};

const STALE_ELIGIBLE = new Set<QuotaFailureKind>([
  "connectivity",
  "rate_limited",
  "quota_service",
  "official_quota_source_unavailable",
  "cli_not_found",
  "cli_launch_failed",
]);

type ScopeClass = "oidc" | "legacy" | "api_key" | "other";

type AuthEntry = {
  scope: string;
  scopeClass: ScopeClass;
  key: string;
  expiresAtMs: number | null;
  expired: boolean;
  binding: string | null;
};

type AuthSelection = {
  entry: AuthEntry;
  immutableJson: boolean;
  authPath: string | undefined;
  store: Record<string, unknown>;
};

type ActionFailure = {
  ok: false;
  failure: QuotaFailure;
};

type GrpcHttp = {
  httpStatus: number;
  headers: Record<string, string>;
  body: Buffer;
};

let inFlight: Promise<GrokQuotaResult> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function fail(kind: QuotaFailureKind, sourcesTried: QuotaSourceTried[], extra?: Partial<QuotaFailure>): ActionFailure {
  return {
    ok: false,
    failure: {
      kind,
      message: FAILURE_COPY[kind],
      sourcesTried,
      ...extra,
    },
  };
}

function isFailure(value: unknown): value is ActionFailure {
  return typeof value === "object" && value !== null && (value as ActionFailure).ok === false && "failure" in value;
}

function asResult(outcome: ActionFailure | { ok: true; data: GrokQuotaSnapshot; warning?: QuotaFailure }): GrokQuotaResult {
  const checkedAt = nowIso();
  if (!outcome.ok) return { ok: false, checkedAt, failure: outcome.failure };
  return { ok: true, checkedAt, data: outcome.data, warning: outcome.warning };
}

function classifyScope(scope: string): ScopeClass {
  if (scope.startsWith(OIDC_PREFIX)) return "oidc";
  if (scope === LEGACY_SCOPE || scope.startsWith(`${LEGACY_SCOPE}`)) return "legacy";
  if (scope === API_KEY_SCOPE || /api[_-]?key/i.test(scope)) return "api_key";
  return "other";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function accountBinding(entry: Record<string, unknown>): string | null {
  const userId = stringField(entry.user_id);
  if (!userId) return null;
  const principalType = stringField(entry.principal_type) ?? "";
  const teamId = stringField(entry.team_id) ?? "";
  return createHash("sha256").update(`${principalType}\0${userId}\0${teamId}`).digest("hex");
}

function expiryMs(entry: Record<string, unknown>): number | null {
  const expires = parseTimeMs(entry.expires_at);
  if (expires != null) return expires;
  const created = parseTimeMs(entry.create_time);
  if (created != null) return created + TOKEN_TTL_MS;
  return null;
}

function readAuthFile(filePath: string): { text: string } | ActionFailure {
  try {
    return { text: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail("auth_source_missing", ["local-auth"]);
    return fail("auth_source_unreadable", ["local-auth"], { diagnostic: code ?? "read_error" });
  }
}

function parseAuthStore(text: string): Record<string, unknown> | ActionFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("auth_source_malformed", ["local-auth"]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("auth_source_malformed", ["local-auth"]);
  }
  return parsed as Record<string, unknown>;
}

function toAuthEntry(scope: string, raw: unknown): AuthEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const key = stringField(record.key);
  if (!key) return null;
  const scopeClass = classifyScope(scope);
  const expiresAtMs = expiryMs(record);
  return {
    scope,
    scopeClass,
    key,
    expiresAtMs,
    expired: expiresAtMs != null ? Date.now() >= expiresAtMs : false,
    binding: accountBinding(record),
  };
}

function pickFromClass(entries: AuthEntry[]): AuthEntry | ActionFailure {
  if (entries.length === 1) return entries[0];
  const unknown = entries.some((entry) => entry.binding == null);
  const bindings = new Set(entries.map((entry) => entry.binding));
  if (unknown || bindings.size > 1) return fail("auth_scope_ambiguous", ["local-auth"]);
  return [...entries].sort((a, b) => (b.expiresAtMs ?? 0) - (a.expiresAtMs ?? 0))[0];
}

function selectAuth(store: Record<string, unknown>): AuthEntry | ActionFailure {
  const entries: AuthEntry[] = [];
  for (const [scope, raw] of Object.entries(store)) {
    const entry = toAuthEntry(scope, raw);
    if (entry && (entry.scopeClass === "oidc" || entry.scopeClass === "legacy")) entries.push(entry);
  }
  if (entries.length === 0) return fail("auth_source_incompatible", ["local-auth"]);
  const currentOidc = entries.filter((entry) => entry.scopeClass === "oidc" && !entry.expired);
  if (currentOidc.length) return pickFromClass(currentOidc);
  const currentLegacy = entries.filter((entry) => entry.scopeClass === "legacy" && !entry.expired);
  if (currentLegacy.length) return pickFromClass(currentLegacy);
  const expiredOidc = entries.filter((entry) => entry.scopeClass === "oidc" && entry.expired);
  if (expiredOidc.length) {
    return [...expiredOidc].sort((a, b) => (b.expiresAtMs ?? 0) - (a.expiresAtMs ?? 0))[0];
  }
  const expiredLegacy = entries.filter((entry) => entry.scopeClass === "legacy" && entry.expired);
  if (expiredLegacy.length) {
    return [...expiredLegacy].sort((a, b) => (b.expiresAtMs ?? 0) - (a.expiresAtMs ?? 0))[0];
  }
  return fail("auth_source_incompatible", ["local-auth"]);
}

function grokAuthCandidates(): string[] {
  const home = os.homedir();
  const names: string[] = [];
  if (process.env.GROK_HOME) names.push(path.join(process.env.GROK_HOME, "auth.json"));
  names.push(path.join(home, ".grok", "auth.json"));
  if (process.env.XDG_CONFIG_HOME) names.push(path.join(process.env.XDG_CONFIG_HOME, "grok", "auth.json"));
  names.push(path.join(home, ".config", "grok", "auth.json"));
  if (process.env.XDG_DATA_HOME) names.push(path.join(process.env.XDG_DATA_HOME, "grok", "auth.json"));
  names.push(path.join(home, ".local", "share", "grok", "auth.json"));
  return names;
}

function resolveAuth(): AuthSelection | ActionFailure {
  const jsonOverride = process.env.GROK_AUTH_JSON;
  if (jsonOverride != null && jsonOverride !== "") {
    const store = parseAuthStore(jsonOverride);
    if (isFailure(store)) return store;
    const selected = selectAuth(store);
    if (isFailure(selected)) return selected;
    return { entry: selected, immutableJson: true, authPath: undefined, store };
  }
  const candidates: string[] = [];
  if (process.env.GROK_AUTH_PATH) candidates.push(process.env.GROK_AUTH_PATH);
  else candidates.push(...grokAuthCandidates());
  let lastMissing = true;
  for (const candidate of candidates) {
    const read = readAuthFile(candidate);
    if (isFailure(read)) {
      if (read.failure.kind !== "auth_source_missing") return read;
      continue;
    }
    lastMissing = false;
    const store = parseAuthStore(read.text);
    if (isFailure(store)) return store;
    const selected = selectAuth(store);
    if (isFailure(selected)) return selected;
    return { entry: selected, immutableJson: false, authPath: candidate, store };
  }
  return fail(lastMissing ? "auth_source_missing" : "auth_source_incompatible", ["local-auth"]);
}

function rereadAuth(selection: AuthSelection): AuthSelection | ActionFailure {
  if (selection.immutableJson || !selection.authPath) {
    return fail("auth_expired", ["local-auth", "grok-cli-refresh"]);
  }
  const read = readAuthFile(selection.authPath);
  if (isFailure(read)) return read;
  const store = parseAuthStore(read.text);
  if (isFailure(store)) return store;
  const selected = selectAuth(store);
  if (isFailure(selected)) return selected;
  return { entry: selected, immutableJson: false, authPath: selection.authPath, store };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function discoverGrokCli(): string | undefined {
  const candidates: string[] = [];
  if (process.env.GROK_CLI_PATH) candidates.push(process.env.GROK_CLI_PATH);
  if (process.env.GROK_HOME) candidates.push(path.join(process.env.GROK_HOME, "bin", "grok"));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "grok"));
  }
  const home = os.homedir();
  candidates.push(path.join(home, ".grok", "bin", "grok"));
  candidates.push(path.join(home, ".local", "bin", "grok"));
  candidates.push("/opt/homebrew/bin/grok");
  candidates.push("/home/linuxbrew/.linuxbrew/bin/grok");
  candidates.push("/usr/local/bin/grok");
  candidates.push("/usr/bin/grok");
  return candidates.find(isExecutable);
}

function groupHasLiveMembers(pgid: number): boolean {
  const uid = process.getuid?.();
  const result = spawnSync("/bin/ps", ["-ax", "-o", "pid=,uid=,stat=,pgid="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) return true;
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const rowUid = Number(parts[1]);
    const stat = parts[2] ?? "";
    const rowPgid = Number(parts[3]);
    if (rowPgid !== pgid) continue;
    if (uid != null && rowUid !== uid) continue;
    if (stat.startsWith("Z")) continue;
    return true;
  }
  return false;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM" && !groupHasLiveMembers(pid)) return;
    throw error;
  }
}

function runGrokModels(executable: string): Promise<ActionFailure | { status: number }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let child;
    try {
      child = spawn(executable, ["models"], {
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      resolve(fail("cli_launch_failed", ["local-auth", "grok-cli-refresh"], { diagnostic: code ?? "spawn_error" }));
      return;
    }
    const finish = (outcome: ActionFailure | { status: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const terminate = async () => {
      if (child.pid == null) return;
      try {
        killProcessGroup(child.pid, "SIGTERM");
      } catch (error) {
        finish(
          fail("cli_launch_failed", ["local-auth", "grok-cli-refresh"], {
            diagnostic: (error as NodeJS.ErrnoException).code ?? "signal_error",
          }),
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (!settled && child.pid != null) {
        try {
          killProcessGroup(child.pid, "SIGKILL");
        } catch (error) {
          finish(
            fail("cli_launch_failed", ["local-auth", "grok-cli-refresh"], {
              diagnostic: (error as NodeJS.ErrnoException).code ?? "signal_error",
            }),
          );
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, CLI_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CLI_OUTPUT_CAP) child.stdout?.destroy();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > CLI_OUTPUT_CAP) child.stderr?.destroy();
    });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(fail("cli_launch_failed", ["local-auth", "grok-cli-refresh"], { diagnostic: code ?? "spawn_error" }));
    });
    child.on("close", (status) => {
      if (timedOut) {
        finish(fail("cli_launch_failed", ["local-auth", "grok-cli-refresh"], { diagnostic: "timeout" }));
        return;
      }
      finish({ status: status ?? 1 });
    });
  });
}

async function officialRefresh(selection: AuthSelection): Promise<AuthSelection | ActionFailure> {
  if (selection.immutableJson) return fail("auth_expired", ["local-auth"]);
  const cli = discoverGrokCli();
  if (!cli) return fail("cli_not_found", ["local-auth", "grok-cli-refresh"]);
  const ran = await runGrokModels(cli);
  if (isFailure(ran)) return ran;
  if (ran.status !== 0) return fail("auth_expired", ["local-auth", "grok-cli-refresh"]);
  const reread = rereadAuth(selection);
  if (isFailure(reread)) return reread;
  if ((reread.entry.binding ?? null) !== (selection.entry.binding ?? null)) {
    return fail("auth_principal_changed", ["local-auth", "grok-cli-refresh"]);
  }
  if (reread.entry.expired) return fail("auth_expired", ["local-auth", "grok-cli-refresh"]);
  return reread;
}

function readVarint(bytes: Uint8Array, offset: { i: number }): bigint | null {
  let value = 0n;
  let shift = 0n;
  while (offset.i < bytes.length) {
    const byte = bytes[offset.i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
    if (shift >= 64n) return null;
  }
  return null;
}

function skip(bytes: Uint8Array, offset: { i: number }, wire: number): boolean {
  if (wire === 0) return readVarint(bytes, offset) != null;
  if (wire === 1) {
    if (offset.i + 8 > bytes.length) return false;
    offset.i += 8;
    return true;
  }
  if (wire === 2) {
    const length = readVarint(bytes, offset);
    if (length == null) return false;
    const size = Number(length);
    if (!Number.isSafeInteger(size) || offset.i + size > bytes.length) return false;
    offset.i += size;
    return true;
  }
  if (wire === 5) {
    if (offset.i + 4 > bytes.length) return false;
    offset.i += 4;
    return true;
  }
  return false;
}

type ProtoField =
  | { field: number; wire: 0; varint: bigint }
  | { field: number; wire: 1; fixed64: bigint }
  | { field: number; wire: 2; bytes: Uint8Array }
  | { field: number; wire: 5; fixed32: number };

function decodeFields(bytes: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = [];
  const offset = { i: 0 };
  while (offset.i < bytes.length) {
    const key = readVarint(bytes, offset);
    if (key == null) return null;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field <= 0) return null;
    if (wire === 0) {
      const varint = readVarint(bytes, offset);
      if (varint == null) return null;
      fields.push({ field, wire: 0, varint });
    } else if (wire === 1) {
      if (offset.i + 8 > bytes.length) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset.i, 8);
      fields.push({ field, wire: 1, fixed64: view.getBigUint64(0, true) });
      offset.i += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (length == null) return null;
      const size = Number(length);
      if (!Number.isSafeInteger(size) || offset.i + size > bytes.length) return null;
      fields.push({ field, wire: 2, bytes: bytes.subarray(offset.i, offset.i + size) });
      offset.i += size;
    } else if (wire === 5) {
      if (offset.i + 4 > bytes.length) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset.i, 4);
      fields.push({ field, wire: 5, fixed32: view.getFloat32(0, true) });
      offset.i += 4;
    } else if (!skip(bytes, offset, wire)) {
      return null;
    }
  }
  return fields;
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function decodeTimestamp(bytes: Uint8Array): string | undefined {
  const fields = decodeFields(bytes);
  if (!fields) return undefined;
  const seconds = fields.find((field) => field.field === 1 && field.wire === 0);
  if (!seconds || seconds.wire !== 0) return undefined;
  const nanosField = fields.find((field) => field.field === 2 && field.wire === 0);
  const secondsNum = Number(seconds.varint);
  const nanos = nanosField && nanosField.wire === 0 ? Number(nanosField.varint) : 0;
  if (!Number.isFinite(secondsNum)) return undefined;
  const ms = secondsNum * 1000 + Math.floor(nanos / 1e6);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function decodeCent(bytes: Uint8Array): number | undefined {
  const fields = decodeFields(bytes);
  if (!fields) return undefined;
  const val = fields.find((field) => field.field === 1 && field.wire === 0);
  if (!val || val.wire !== 0) return 0;
  const num = Number(val.varint);
  return Number.isSafeInteger(num) ? num : undefined;
}

function decodePeriod(bytes: Uint8Array): {
  type: "weekly" | "monthly" | "unspecified";
  startAt?: string;
  endAt?: string;
} | null {
  const fields = decodeFields(bytes);
  if (!fields) return null;
  const typeField = fields.find((field) => field.field === 1 && field.wire === 0);
  const typeNum = typeField && typeField.wire === 0 ? Number(typeField.varint) : 0;
  const type = typeNum === 1 ? "weekly" : typeNum === 2 ? "monthly" : "unspecified";
  const startField = fields.find((field) => field.field === 2 && field.wire === 2);
  const endField = fields.find((field) => field.field === 3 && field.wire === 2);
  return {
    type,
    startAt: startField && startField.wire === 2 ? decodeTimestamp(startField.bytes) : undefined,
    endAt: endField && endField.wire === 2 ? decodeTimestamp(endField.bytes) : undefined,
  };
}

function decodeProduct(bytes: Uint8Array, index: number): GrokQuotaWindow | null {
  const fields = decodeFields(bytes);
  if (!fields) return null;
  const enumField = fields.find((field) => field.field === 1 && field.wire === 0);
  if (!enumField || enumField.wire !== 0) return null;
  const mapped = PRODUCT_BY_ENUM[Number(enumField.varint)];
  if (!mapped) return null;
  const percentField = fields.find((field) => field.field === 2 && field.wire === 5);
  const omitted = !percentField;
  const raw = percentField && percentField.wire === 5 ? percentField.fixed32 : 0;
  if (!Number.isFinite(raw)) return null;
  const percentUsed = clampPercent(raw);
  return {
    id: `product:${mapped.slug}`,
    label: mapped.label,
    percentUsed,
    percentRemaining: 100 - percentUsed,
    provenance: {
      percentageField: `config.productUsage[${index}].usagePercent`,
      ...(omitted ? { omittedProto3Default: true as const } : {}),
    },
  };
}

function decodeConfig(bytes: Uint8Array): GrokQuotaSnapshot | ActionFailure {
  const fields = decodeFields(bytes);
  if (!fields) return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "malformed_protobuf" });
  const percentField = fields.find((field) => field.field === 1 && field.wire === 5);
  const periodField = fields.find((field) => field.field === 8 && field.wire === 2);
  const period = periodField && periodField.wire === 2 ? decodePeriod(periodField.bytes) : undefined;
  const validPeriod = period?.type === "weekly" || period?.type === "monthly";
  let percentUsed: number | undefined;
  let omittedGlobal = false;
  if (percentField && percentField.wire === 5) {
    if (!Number.isFinite(percentField.fixed32)) {
      return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "non_finite_percent" });
    }
    percentUsed = clampPercent(percentField.fixed32);
  } else if (validPeriod) {
    percentUsed = 0;
    omittedGlobal = true;
  }
  if (percentUsed == null) {
    return fail("quota_unreported", ["consumer-quota-api"], { diagnostic: "missing_percent_and_period" });
  }
  const resetAt = period?.endAt;
  const creditsWindow: GrokQuotaWindow = {
    id: "credits",
    label: period?.type === "weekly" ? "Weekly" : period?.type === "monthly" ? "Monthly" : "Credits",
    percentUsed,
    percentRemaining: 100 - percentUsed,
    ...(resetAt ? { resetAt } : {}),
    provenance: {
      percentageField: "config.creditUsagePercent",
      ...(resetAt ? { resetField: "config.currentPeriod.end" as const } : {}),
      ...(omittedGlobal ? { omittedProto3Default: true as const } : {}),
    },
  };
  const productFields = fields.filter((field) => field.field === 7 && field.wire === 2);
  const products: GrokQuotaWindow[] = [];
  productFields.forEach((field, index) => {
    if (field.wire !== 2) return;
    const product = decodeProduct(field.bytes, index);
    if (product) {
      if (resetAt) product.resetAt = resetAt;
      if (resetAt) product.provenance.resetField = "config.currentPeriod.end";
      products.push(product);
    }
  });
  const prepaidField = fields.find((field) => field.field === 12 && field.wire === 2);
  const prepaid = prepaidField && prepaidField.wire === 2 ? decodeCent(prepaidField.bytes) : undefined;
  const snapshot: GrokQuotaSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    sourceVersion: SOURCE_VERSION,
    operation: OPERATION,
    period: {
      type: period?.type ?? "unspecified",
      ...(period?.startAt ? { startAt: period.startAt } : {}),
      ...(period?.endAt ? { endAt: period.endAt } : {}),
      provenance: "config.currentPeriod",
    },
    windows: [creditsWindow, ...products],
    ...(prepaid != null
      ? { credits: { remaining: prepaid, unit: "credits" as const, sourceField: "config.prepaidBalance.val" as const } }
      : {}),
    refreshedAt: nowIso(),
    stale: false,
  };
  return snapshot;
}

function decodeResponsePayload(bytes: Uint8Array): GrokQuotaSnapshot | ActionFailure {
  const fields = decodeFields(bytes);
  if (!fields) return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "malformed_protobuf" });
  const configField = fields.find((field) => field.field === 1 && field.wire === 2);
  if (configField && configField.wire === 2) return decodeConfig(configField.bytes);
  return decodeConfig(bytes);
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseHeaderBlock(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    headers[key] = decodeHeaderValue(line.slice(index + 1).trim());
  }
  return headers;
}

function parseGrpcWeb(body: Buffer): {
  dataFrames: Buffer[];
  trailers: Record<string, string>;
  compressed: boolean;
  truncated: boolean;
} {
  const dataFrames: Buffer[] = [];
  const trailers: Record<string, string> = {};
  let offset = 0;
  let compressed = false;
  while (offset < body.length) {
    if (offset + 5 > body.length) return { dataFrames, trailers, compressed, truncated: true };
    const flags = body[offset];
    const length = body.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > body.length) return { dataFrames, trailers, compressed, truncated: true };
    if (flags & 0x01) compressed = true;
    const payload = body.subarray(start, end);
    if (flags & 0x80) Object.assign(trailers, parseHeaderBlock(payload.toString("utf8")));
    else dataFrames.push(payload);
    offset = end;
  }
  return { dataFrames, trailers, compressed, truncated: false };
}

function looksFramed(body: Buffer): boolean {
  if (body.length < 1) return false;
  const first = body[0];
  return first === 0x00 || first === 0x01 || first === 0x80 || first === 0x81;
}

function extractPayload(body: Buffer): Buffer | ActionFailure {
  if (looksFramed(body)) {
    const parsed = parseGrpcWeb(body);
    if (parsed.truncated) return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "truncated_frame" });
    if (parsed.compressed) return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "compressed_frame" });
    if (parsed.dataFrames.length > 1) {
      return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "multiple_data_frames" });
    }
    if (parsed.dataFrames.length === 1) return parsed.dataFrames[0];
    return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "missing_data_frame" });
  }
  return body;
}

function headerMap(headers: IncomingHttpHeaders): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") mapped[key.toLowerCase()] = value;
    else if (Array.isArray(value) && value[0]) mapped[key.toLowerCase()] = value[0];
  }
  return mapped;
}

function grpcStatusFrom(headers: Record<string, string>, trailers: Record<string, string>): number | undefined {
  const raw = trailers["grpc-status"] ?? headers["grpc-status"];
  if (raw == null || raw === "") return undefined;
  const status = Number(raw);
  return Number.isInteger(status) ? status : undefined;
}

function grpcMessageFrom(headers: Record<string, string>, trailers: Record<string, string>): string {
  return (trailers["grpc-message"] ?? headers["grpc-message"] ?? "").toLowerCase();
}

function isCredentialLikeGrpc7(message: string): boolean {
  return (
    message.includes("bad-credentials") ||
    message.includes("unauthenticated") ||
    (message.includes("oauth2") && message.includes("could not be validated")) ||
    (message.includes("access token") &&
      (message.includes("invalid") || message.includes("expired") || message.includes("could not be validated")))
  );
}

function isTeamScope(status: number, message: string): boolean {
  const normalized = message.trim().replace(/\.$/, "");
  return status === 9 && normalized === "no personal team";
}

function classifyHttpOrGrpc(httpStatus: number, grpcStatus: number | undefined, message: string): ActionFailure | null {
  if (httpStatus === 401 || httpStatus === 403) {
    return fail("credential_rejected", ["local-auth", "consumer-quota-api"], { httpStatus, grpcStatus });
  }
  if (httpStatus === 429 || grpcStatus === 8) {
    return fail("rate_limited", ["consumer-quota-api"], { httpStatus, grpcStatus });
  }
  if (httpStatus === 404 || grpcStatus === 12) {
    return fail("official_quota_source_unavailable", ["consumer-quota-api"], { httpStatus, grpcStatus });
  }
  if ([408, 502, 503, 504].includes(httpStatus) || grpcStatus === 4) {
    return fail("connectivity", ["consumer-quota-api"], { httpStatus, grpcStatus, diagnostic: "retryable_status" });
  }
  if (httpStatus >= 500 || grpcStatus === 14) {
    return fail("quota_service", ["consumer-quota-api"], { httpStatus, grpcStatus });
  }
  if (httpStatus !== 200 && httpStatus !== 0) {
    return fail("quota_service", ["consumer-quota-api"], { httpStatus, grpcStatus });
  }
  if (grpcStatus == null || grpcStatus === 0) return null;
  if (grpcStatus === 16) return fail("credential_rejected", ["local-auth", "consumer-quota-api"], { httpStatus, grpcStatus });
  if (grpcStatus === 7 && isCredentialLikeGrpc7(message)) {
    return fail("credential_rejected", ["local-auth", "consumer-quota-api"], { httpStatus, grpcStatus });
  }
  if (isTeamScope(grpcStatus, message)) {
    return fail("team_scope_unsupported", ["consumer-quota-api"], { httpStatus, grpcStatus });
  }
  if (grpcStatus === 7) return fail("quota_service", ["consumer-quota-api"], { httpStatus, grpcStatus });
  if (grpcStatus === 1) return fail("connectivity", ["consumer-quota-api"], { httpStatus, grpcStatus, diagnostic: "cancelled" });
  if (grpcStatus === 13) return fail("quota_service", ["consumer-quota-api"], { httpStatus, grpcStatus });
  return fail("quota_service", ["consumer-quota-api"], { httpStatus, grpcStatus });
}

function isRetryableFailure(failure: QuotaFailure): boolean {
  if (failure.kind === "connectivity") return true;
  if (failure.httpStatus && [408, 502, 503, 504].includes(failure.httpStatus)) return true;
  if (failure.grpcStatus === 4) return true;
  if (failure.grpcStatus === 1) return true;
  return false;
}

function isRefreshTrigger(failure: QuotaFailure): boolean {
  if (failure.kind !== "credential_rejected") return false;
  if (failure.httpStatus === 403) return false;
  return failure.httpStatus === 401 || failure.grpcStatus === 16 || failure.grpcStatus === 7;
}

function postCredits(bearer: string): Promise<GrpcHttp | ActionFailure> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome: GrpcHttp | ActionFailure) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const req = https.request(
      {
        hostname: ENDPOINT_HOST,
        path: ENDPOINT_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "*/*",
          "Content-Type": "application/grpc-web+proto",
          Origin: "https://grok.com",
          Referer: "https://grok.com/?_s=usage",
          "x-grpc-web": "1",
          "x-user-agent": "connect-es/2.1.1",
          "Content-Length": String(EMPTY_FRAME.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_CAP) {
            tooLarge = true;
            req.destroy();
            done(fail("response_too_large", ["consumer-quota-api"]));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (tooLarge) return;
          done({
            httpStatus: res.statusCode ?? 0,
            headers: headerMap(res.headers),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.setTimeout(REQUEST_DEADLINE_MS, () => {
      req.destroy();
      done(fail("connectivity", ["consumer-quota-api"], { diagnostic: "timeout" }));
    });
    req.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (settled) return;
      done(fail("connectivity", ["consumer-quota-api"], { diagnostic: code ?? "network_error" }));
    });
    req.write(EMPTY_FRAME);
    req.end();
  });
}

function interpretGrpc(response: GrpcHttp): GrokQuotaSnapshot | ActionFailure {
  const framed = looksFramed(response.body) ? parseGrpcWeb(response.body) : { trailers: {}, compressed: false, truncated: false, dataFrames: [] as Buffer[] };
  if ("truncated" in framed && framed.truncated) {
    return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "truncated_frame" });
  }
  const grpcStatus = grpcStatusFrom(response.headers, framed.trailers ?? {});
  const message = grpcMessageFrom(response.headers, framed.trailers ?? {});
  const classified = classifyHttpOrGrpc(response.httpStatus, grpcStatus, message);
  if (classified) return classified;
  const payload = extractPayload(response.body);
  if (isFailure(payload)) return payload;
  if (payload.length === 0) return fail("parse_incompatible", ["consumer-quota-api"], { diagnostic: "empty_payload" });
  return decodeResponsePayload(payload);
}

async function fetchCredits(bearer: string): Promise<GrokQuotaSnapshot | ActionFailure> {
  const once = async () => {
    const response = await postCredits(bearer);
    if (isFailure(response)) return response;
    return interpretGrpc(response);
  };
  const first = await once();
  if (!isFailure(first) || !isRetryableFailure(first.failure)) return first;
  return once();
}

function ensureCache(db: HatchServerContext["db"]) {
  db.exec(CACHE_TABLE);
}

function trustedCache(row: { account_binding: string; snapshot_json: string }, binding: string): StoredGrokQuotaSnapshot | null {
  if (row.account_binding !== binding) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot_json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const snap = parsed as Partial<StoredGrokQuotaSnapshot>;
  if (snap.schemaVersion !== 2) return null;
  if (snap.source !== SOURCE) return null;
  if (snap.sourceVersion !== 1) return null;
  if (snap.operation !== OPERATION) return null;
  if (snap.accountBinding !== binding) return null;
  if (!Array.isArray(snap.windows) || snap.windows.length === 0) return null;
  if (!snap.windows.every((window) => window?.provenance?.percentageField)) return null;
  if (!snap.period?.provenance) return null;
  return snap as StoredGrokQuotaSnapshot;
}

function readTrustedCache(db: HatchServerContext["db"], binding: string | null): StoredGrokQuotaSnapshot | null {
  if (!binding) return null;
  ensureCache(db);
  const row = db.get<{ account_binding: string; snapshot_json: string }>(
    "SELECT account_binding, snapshot_json FROM grok_quota_cache WHERE id = 1",
  );
  if (!row) return null;
  const trusted = trustedCache(row, binding);
  if (!trusted) {
    db.run("DELETE FROM grok_quota_cache WHERE id = 1");
    return null;
  }
  return trusted;
}

function writeCache(db: HatchServerContext["db"], binding: string, snapshot: GrokQuotaSnapshot) {
  ensureCache(db);
  const stored: StoredGrokQuotaSnapshot = { ...snapshot, stale: false, accountBinding: binding };
  db.run(
    "INSERT INTO grok_quota_cache (id, account_binding, snapshot_json, stored_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_binding = excluded.account_binding, snapshot_json = excluded.snapshot_json, stored_at = excluded.stored_at",
    [binding, JSON.stringify(stored), Date.now()],
  );
}

function staleSuccess(cached: StoredGrokQuotaSnapshot, warning: QuotaFailure): { ok: true; data: GrokQuotaSnapshot; warning: QuotaFailure } {
  const { accountBinding: _binding, ...data } = cached;
  return {
    ok: true,
    data: { ...data, stale: true },
    warning: { ...warning, sourcesTried: Array.from(new Set([...warning.sourcesTried, "cache"])) },
  };
}

function publicSnapshot(snapshot: GrokQuotaSnapshot): GrokQuotaSnapshot {
  return snapshot;
}

async function acquire(context: HatchServerContext): Promise<GrokQuotaResult> {
  const resolved = resolveAuth();
  if (isFailure(resolved)) return asResult(resolved);
  let selection = resolved;
  const binding = selection.entry.binding;
  const cached = readTrustedCache(context.db, binding);
  let didRefresh = false;

  const failWithCache = (outcome: ActionFailure): GrokQuotaResult => {
    if (cached && STALE_ELIGIBLE.has(outcome.failure.kind)) return asResult(staleSuccess(cached, outcome.failure));
    return asResult(outcome);
  };

  if (selection.entry.expired) {
    const refreshed = await officialRefresh(selection);
    if (isFailure(refreshed)) return failWithCache(refreshed);
    selection = refreshed;
    didRefresh = true;
  }

  let fetched = await fetchCredits(selection.entry.key);
  if (isFailure(fetched) && isRefreshTrigger(fetched.failure) && !didRefresh) {
    const refreshed = await officialRefresh(selection);
    if (isFailure(refreshed)) return failWithCache(refreshed);
    selection = refreshed;
    didRefresh = true;
    fetched = await fetchCredits(selection.entry.key);
  }

  if (isFailure(fetched)) return failWithCache(fetched);
  fetched.stale = false;
  fetched.refreshedAt = nowIso();
  if (selection.entry.binding) writeCache(context.db, selection.entry.binding, fetched);
  return asResult({ ok: true, data: publicSnapshot(fetched) });
}

async function getQuota(_input: unknown, context: HatchServerContext): Promise<GrokQuotaResult> {
  if (inFlight) return inFlight;
  inFlight = acquire(context).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const actions = {
  getQuota,
};
