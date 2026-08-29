import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { HatchServerContext } from "@hatch/contracts";
import type { GitCommitsData, GitCommitsFailureKind, GitCommitsResult } from "./types";

const WINDOW_DAYS = 365;
const CONTRIB_QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
      commitContributionsByRepository(maxRepositories: 100) {
        repository {
          nameWithOwner
          owner { login }
        }
        contributions { totalCount }
      }
    }
  }
}`;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const GH_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 2 * 1024 * 1024;
const USER_AGENT = "hatch-git-commits";
const CACHE_TABLE = `CREATE TABLE IF NOT EXISTS git_commits_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL,
  stored_at INTEGER NOT NULL
)`;

type Failure = Extract<GitCommitsResult, { ok: false }>;

const COPY: Record<GitCommitsFailureKind, string> = {
  auth_required: "run gh auth login",
  cli_not_found: "github cli not found",
  cli_launch_failed: "could not launch gh",
  connectivity: "could not reach github",
  rate_limited: "github rate limited; retry later",
  parse_incompatible: "could not parse commit search",
  unavailable: "github source unavailable",
};

let inFlight: Promise<GitCommitsResult> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function fail(kind: GitCommitsFailureKind): Failure {
  return { ok: false, checkedAt: nowIso(), kind, message: COPY[kind] };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ghEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME || os.homedir();
  const extras = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  const pathParts = [...extras, process.env.PATH ?? ""].filter(Boolean);
  return { ...process.env, HOME: home, PATH: pathParts.join(path.delimiter) };
}

function discoverGh(): string | undefined {
  const candidates: string[] = [];
  if (process.env.GH_PATH) candidates.push(process.env.GH_PATH);
  const env = ghEnv();
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "gh"));
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, ".local", "bin", "gh"),
    "/opt/homebrew/bin/gh",
    "/home/linuxbrew/.linuxbrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  );
  return candidates.find(isExecutable);
}

type ProcResult = { status: number; stdout: string; stderr: string; code?: string };

function runGh(executable: string, args: string[]): Promise<ProcResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: ghEnv(),
    });
    const done = (status: number, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(1, "timeout");
    }, GH_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      done(1, (error as NodeJS.ErrnoException).code ?? "spawn_error");
    });
    child.on("close", (status) => done(status ?? 1));
  });
}

function utcDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function dayKey(value: string): string | null {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

type SearchCommit = {
  commit?: { committer?: { date?: unknown }; author?: { date?: unknown } };
  repository?: { full_name?: unknown; owner?: { login?: unknown; type?: unknown } };
};

type SearchResponse = {
  total_count?: unknown;
  incomplete_results?: unknown;
  items?: unknown;
  message?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("unparsed");
  }
}

function httpStatusFromStderr(stderr: string): number | undefined {
  const match = stderr.match(/HTTP\s+(\d{3})/i);
  if (!match) return undefined;
  return Number(match[1]);
}

function classifyFailure(httpStatus: number | undefined, message: string, stderr: string, code?: string): Failure {
  if (code === "timeout") return fail("connectivity");
  if (code === "ENOENT") return fail("cli_not_found");
  const combined = `${message}\n${stderr}`.toLowerCase();
  if (
    combined.includes("gh_token") ||
    combined.includes("gh auth login") ||
    combined.includes("no oauth token") ||
    combined.includes("authentication required") ||
    combined.includes("not logged in")
  ) {
    return fail("auth_required");
  }
  if (
    httpStatus === 401 ||
    combined.includes("bad credentials") ||
    combined.includes("requires authentication") ||
    combined.includes("must authenticate")
  ) {
    return fail("auth_required");
  }
  if (
    httpStatus === 429 ||
    combined.includes("rate limit") ||
    combined.includes("secondary rate")
  ) {
    return fail("rate_limited");
  }
  if (httpStatus === 403) return fail("auth_required");
  if (httpStatus === 404) return fail("unavailable");
  if (httpStatus === 422 || combined.includes("validation failed")) return fail("parse_incompatible");
  if (code && code !== "timeout") return fail("cli_launch_failed");
  if (!httpStatus) return fail("connectivity");
  return fail("connectivity");
}

function jsonOrFailure(ran: ProcResult): unknown | Failure {
  if (ran.code === "timeout") return fail("connectivity");
  if (ran.code === "ENOENT") return fail("cli_not_found");
  const httpStatus = httpStatusFromStderr(ran.stderr);
  let parsed: unknown = null;
  try {
    parsed = parseJson(ran.stdout);
  } catch {
    parsed = null;
  }
  const record = asRecord(parsed);
  const message = typeof record?.message === "string" ? record.message : "";
  const failed = ran.status !== 0 || (httpStatus != null && httpStatus >= 400);
  if (failed) return classifyFailure(httpStatus, message, ran.stderr, ran.code);
  if (parsed == null) return fail("parse_incompatible");
  return parsed;
}

async function ghApi(executable: string, args: string[]): Promise<unknown | Failure> {
  return jsonOrFailure(
    await runGh(executable, ["api", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", ...args]),
  );
}

function githubGet(pathname: string): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: pathname,
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          if (body.length < OUTPUT_CAP) body += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(GH_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ status: 0, body: "", error: "timeout" });
    });
    req.on("error", (error) => {
      resolve({ status: 0, body: "", error: (error as NodeJS.ErrnoException).code ?? "network_error" });
    });
    req.end();
  });
}

function httpsJson(pathname: string): Promise<unknown | Failure> {
  return githubGet(pathname).then((res) => {
    if (res.error === "timeout" || res.status === 0) return fail("connectivity");
    let parsed: unknown = null;
    try {
      parsed = parseJson(res.body);
    } catch {
      return fail("parse_incompatible");
    }
    const record = asRecord(parsed);
    const message = typeof record?.message === "string" ? record.message : "";
    if (res.status >= 400) return classifyFailure(res.status, message, "", undefined);
    return parsed;
  });
}

function readConfiguredLogin(): string | undefined {
  const home = os.homedir();
  const candidates = [
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "gh", "hosts.yml") : "",
    path.join(home, ".config", "gh", "hosts.yml"),
  ].filter(Boolean);
  for (const filePath of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let login: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("oauth_token") || trimmed.startsWith("token:")) continue;
      const match = trimmed.match(/^user:\s*"?([A-Za-z0-9-]+)"?\s*$/);
      if (match) login = match[1];
    }
    if (login) return login;
  }
  return undefined;
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && (value as Failure).ok === false;
}

function emptyDays(from: string, to: string): { date: string; count: number }[] {
  const days: { date: string; count: number }[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push({ date: cursor.toISOString().slice(0, 10), count: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function ensureCache(db: HatchServerContext["db"]) {
  db.exec(CACHE_TABLE);
}

function readCache(db: HatchServerContext["db"]): GitCommitsData | null {
  ensureCache(db);
  const row = db.get<{ snapshot_json: string }>("SELECT snapshot_json FROM git_commits_cache WHERE id = 1");
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.snapshot_json) as GitCommitsData;
    if (!parsed || typeof parsed.total !== "number" || !Array.isArray(parsed.days) || !parsed.stats) return null;
    if (parsed.days.length < 300) return null;
    return parsed;
  } catch {
    db.run("DELETE FROM git_commits_cache WHERE id = 1");
    return null;
  }
}

function writeCache(db: HatchServerContext["db"], data: GitCommitsData) {
  ensureCache(db);
  db.run(
    "INSERT INTO git_commits_cache (id, snapshot_json, stored_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, stored_at = excluded.stored_at",
    [JSON.stringify({ ...data, stale: false }), Date.now()],
  );
}

function staleResult(cached: GitCommitsData): GitCommitsResult {
  return { ok: true, checkedAt: nowIso(), data: { ...cached, stale: true } };
}

function windowRange() {
  return { to: utcDate(0), from: utcDate(1 - WINDOW_DAYS) };
}

function searchQuery(login: string, from: string) {
  return `author:${login} committer-date:>=${from}`;
}

async function ghSearchPage(
  executable: string,
  query: string,
  page: number,
): Promise<SearchResponse | Failure> {
  const parsed = await ghApi(executable, [
    "search/commits",
    "-X",
    "GET",
    "-f",
    `q=${query}`,
    "-F",
    `per_page=${PAGE_SIZE}`,
    "-F",
    `page=${page}`,
  ]);
  if (isFailure(parsed)) return parsed;
  const record = asRecord(parsed) as SearchResponse | null;
  if (typeof record?.total_count !== "number" || !Array.isArray(record.items)) return fail("parse_incompatible");
  return record;
}

async function httpsSearchPage(query: string, page: number): Promise<SearchResponse | Failure> {
  const pathname = `/search/commits?q=${encodeURIComponent(query)}&per_page=${PAGE_SIZE}&page=${page}`;
  const parsed = await httpsJson(pathname);
  if (isFailure(parsed)) return parsed;
  const record = asRecord(parsed) as SearchResponse | null;
  if (typeof record?.total_count !== "number" || !Array.isArray(record.items)) return fail("parse_incompatible");
  return record;
}

async function collectPages(
  load: (page: number) => Promise<SearchResponse | Failure>,
): Promise<{ totalCount: number; incomplete: boolean; items: SearchCommit[] } | Failure> {
  const first = await load(1);
  if (isFailure(first)) return first;
  const items: SearchCommit[] = [...(first.items as SearchCommit[])];
  const totalCount = first.total_count as number;
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(Math.min(totalCount, PAGE_SIZE * MAX_PAGES) / PAGE_SIZE)));
  for (let page = 2; page <= pages; page += 1) {
    const next = await load(page);
    if (isFailure(next)) return next;
    items.push(...(next.items as SearchCommit[]));
    if ((next.items as unknown[]).length < PAGE_SIZE) break;
  }
  return {
    totalCount,
    incomplete: first.incomplete_results === true || totalCount > PAGE_SIZE * MAX_PAGES,
    items,
  };
}

type CalendarRepo = { name: string; owner: string; commits: number };

type CalendarSnapshot = {
  login: string;
  totalCommits: number;
  days: { date: string; count: number }[];
  repos: CalendarRepo[];
};

function weekTotals(days: { date: string; count: number }[]): number[] {
  if (days.length === 0) return [];
  const start = new Date(`${days[0].date}T00:00:00Z`);
  const pad = start.getUTCDay();
  const counts = [...Array.from({ length: pad }, () => 0), ...days.map((day) => day.count)];
  const weeks: number[] = [];
  for (let i = 0; i < counts.length; i += 7) {
    weeks.push(counts.slice(i, i + 7).reduce((sum, count) => sum + count, 0));
  }
  return weeks;
}

function parseCalendar(payload: unknown): CalendarSnapshot | Failure {
  const root = asRecord(payload);
  const errors = root?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const message = errors
      .map((entry) => (typeof asRecord(entry)?.message === "string" ? asRecord(entry)?.message : ""))
      .join("\n");
    const classified = classifyFailure(undefined, message, "", undefined);
    if (classified.kind === "auth_required" || classified.kind === "rate_limited") return classified;
    return fail("parse_incompatible");
  }
  const data = asRecord(root?.data);
  const viewer = asRecord(data?.viewer);
  const login = typeof viewer?.login === "string" ? viewer.login : "";
  if (!login) return fail("parse_incompatible");
  const collection = asRecord(viewer?.contributionsCollection);
  if (!collection) return fail("parse_incompatible");
  const totalCommits = collection.totalCommitContributions;
  if (typeof totalCommits !== "number") return fail("parse_incompatible");
  const calendar = asRecord(collection.contributionCalendar);
  const weeks = Array.isArray(calendar?.weeks) ? calendar.weeks : null;
  if (!weeks) return fail("parse_incompatible");
  const days: { date: string; count: number }[] = [];
  for (const week of weeks) {
    const weekRecord = asRecord(week);
    const contributionDays = Array.isArray(weekRecord?.contributionDays) ? weekRecord.contributionDays : [];
    for (const entry of contributionDays) {
      const day = asRecord(entry);
      if (typeof day?.date !== "string" || typeof day.contributionCount !== "number") return fail("parse_incompatible");
      days.push({ date: day.date, count: day.contributionCount });
    }
  }
  const repos: CalendarRepo[] = [];
  const repoRows = Array.isArray(collection.commitContributionsByRepository)
    ? collection.commitContributionsByRepository
    : [];
  for (const row of repoRows) {
    const record = asRecord(row);
    const repository = asRecord(record?.repository);
    const owner = asRecord(repository?.owner);
    const name = typeof repository?.nameWithOwner === "string" ? repository.nameWithOwner : "";
    const ownerLogin = typeof owner?.login === "string" ? owner.login : "";
    const commits = asRecord(record?.contributions)?.totalCount;
    if (!name || typeof commits !== "number") continue;
    repos.push({ name, owner: ownerLogin, commits });
  }
  return { login, totalCommits, days, repos };
}

async function ghCalendar(executable: string, from: string, to: string): Promise<CalendarSnapshot | Failure> {
  const parsed = await jsonOrFailure(
    await runGh(executable, [
      "api",
      "graphql",
      "-f",
      `query=${CONTRIB_QUERY}`,
      "-f",
      `from=${from}T00:00:00Z`,
      "-f",
      `to=${to}T23:59:59Z`,
    ]),
  );
  if (isFailure(parsed)) return parsed;
  return parseCalendar(parsed);
}

function streaks(days: { count: number }[]): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    if (day.count > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].count <= 0) {
      if (i === days.length - 1) continue;
      break;
    }
    current += 1;
  }
  return { current, longest };
}

function finishSnapshot(
  login: string,
  from: string,
  to: string,
  total: number,
  days: { date: string; count: number }[],
  stats: GitCommitsData["stats"],
  incomplete: boolean,
): GitCommitsData {
  return {
    login,
    from,
    to,
    total,
    days,
    sparkline: weekTotals(days),
    stats,
    incomplete,
    stale: false,
  };
}

function toSnapshotFromCalendar(calendar: CalendarSnapshot, from: string, to: string): GitCommitsData {
  const days = emptyDays(from, to);
  const byDate = new Map(days.map((day) => [day.date, day]));
  for (const day of calendar.days) {
    const bucket = byDate.get(day.date);
    if (bucket) bucket.count = day.count;
  }
  const loginLower = calendar.login.toLowerCase();
  let own = 0;
  let other = 0;
  for (const repo of calendar.repos) {
    if (repo.owner.toLowerCase() === loginLower) own += repo.commits;
    else other += repo.commits;
  }
  const activeDays = days.filter((day) => day.count > 0).length;
  const peak = days.reduce((n, day) => Math.max(n, day.count), 0);
  const last7 = days.slice(-7).reduce((n, day) => n + day.count, 0);
  const { current, longest } = streaks(days);
  return finishSnapshot(
    calendar.login,
    from,
    to,
    calendar.totalCommits,
    days,
    {
      activeDays,
      currentStreak: current,
      longestStreak: longest,
      peak,
      last7,
      repos: calendar.repos.length,
      own,
      other,
    },
    calendar.repos.length >= 100,
  );
}

function toSnapshot(
  login: string,
  from: string,
  to: string,
  totalCount: number,
  incomplete: boolean,
  items: SearchCommit[],
): GitCommitsData {
  const days = emptyDays(from, to);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const repoNames = new Set<string>();
  let own = 0;
  let other = 0;
  const loginLower = login.toLowerCase();
  for (const item of items) {
    const dateValue =
      (typeof item.commit?.committer?.date === "string" && item.commit.committer.date) ||
      (typeof item.commit?.author?.date === "string" && item.commit.author.date) ||
      "";
    const key = dayKey(dateValue);
    const bucket = key ? byDate.get(key) : undefined;
    if (bucket) bucket.count += 1;
    const repo = asRecord(item.repository);
    const fullName = typeof repo?.full_name === "string" ? repo.full_name : "";
    if (fullName) repoNames.add(fullName);
    const owner = asRecord(repo?.owner);
    const ownerLogin = typeof owner?.login === "string" ? owner.login.toLowerCase() : "";
    if (ownerLogin && ownerLogin === loginLower) own += 1;
    else other += 1;
  }
  const activeDays = days.filter((day) => day.count > 0).length;
  const peak = days.reduce((n, day) => Math.max(n, day.count), 0);
  const last7 = days.slice(-7).reduce((n, day) => n + day.count, 0);
  const { current, longest } = streaks(days);
  return finishSnapshot(
    login,
    from,
    to,
    totalCount,
    days,
    {
      activeDays,
      currentStreak: current,
      longestStreak: longest,
      peak,
      last7,
      repos: repoNames.size,
      own,
      other,
    },
    incomplete,
  );
}

async function fetchViaGh(executable: string): Promise<GitCommitsData | Failure> {
  const { from, to } = windowRange();
  const calendar = await ghCalendar(executable, from, to);
  if (!isFailure(calendar)) return toSnapshotFromCalendar(calendar, from, to);
  if (calendar.kind === "rate_limited" || calendar.kind === "auth_required") return calendar;
  const user = await ghApi(executable, ["/user"]);
  if (isFailure(user)) return calendar.kind === "parse_incompatible" ? user : calendar;
  const login = typeof asRecord(user)?.login === "string" ? (asRecord(user)?.login as string) : "";
  if (!login) return fail("parse_incompatible");
  const collected = await collectPages((page) => ghSearchPage(executable, searchQuery(login, from), page));
  if (isFailure(collected)) return collected;
  return toSnapshot(login, from, to, collected.totalCount, collected.incomplete, collected.items);
}

async function fetchViaHttps(login: string): Promise<GitCommitsData | Failure> {
  const { from, to } = windowRange();
  const collected = await collectPages((page) => httpsSearchPage(searchQuery(login, from), page));
  if (isFailure(collected)) return collected;
  return toSnapshot(login, from, to, collected.totalCount, collected.incomplete, collected.items);
}

async function fetchCommits(): Promise<GitCommitsData | Failure> {
  const gh = discoverGh();
  const configuredLogin = readConfiguredLogin();
  if (gh) {
    const viaGh = await fetchViaGh(gh);
    if (!isFailure(viaGh)) return viaGh;
    if (viaGh.kind === "rate_limited") return viaGh;
    if (configuredLogin) {
      const viaHttps = await fetchViaHttps(configuredLogin);
      if (!isFailure(viaHttps)) return viaHttps;
    }
    return viaGh;
  }
  if (configuredLogin) return fetchViaHttps(configuredLogin);
  return fail("cli_not_found");
}

async function acquire(context: HatchServerContext): Promise<GitCommitsResult> {
  const cached = readCache(context.db);
  const fetched = await fetchCommits();
  if (isFailure(fetched)) {
    if (
      cached &&
      (fetched.kind === "connectivity" || fetched.kind === "rate_limited" || fetched.kind === "cli_launch_failed")
    ) {
      return staleResult(cached);
    }
    return fetched;
  }
  writeCache(context.db, fetched);
  return { ok: true, checkedAt: nowIso(), data: fetched };
}

async function getCommits(_input: unknown, context: HatchServerContext): Promise<GitCommitsResult> {
  if (inFlight) return inFlight;
  inFlight = acquire(context).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const actions = {
  getCommits,
};
