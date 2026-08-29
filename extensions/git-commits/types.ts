export type GitCommitsFailureKind =
  | "auth_required"
  | "cli_not_found"
  | "cli_launch_failed"
  | "connectivity"
  | "rate_limited"
  | "parse_incompatible"
  | "unavailable";

export type GitCommitsDay = { date: string; count: number };

export type GitCommitsStats = {
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peak: number;
  last7: number;
  repos: number;
  own: number;
  other: number;
};

export type GitCommitsData = {
  login: string;
  from: string;
  to: string;
  total: number;
  days: GitCommitsDay[];
  sparkline: number[];
  stats: GitCommitsStats;
  incomplete: boolean;
  stale: boolean;
};

export type GitCommitsResult =
  | { ok: true; checkedAt: string; data: GitCommitsData }
  | { ok: false; checkedAt: string; kind: GitCommitsFailureKind; message: string };
