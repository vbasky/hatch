export type CommandCodeQuotaFailureKind =
  | "auth_required"
  | "auth_source_missing"
  | "auth_source_unreadable"
  | "auth_source_malformed"
  | "auth_source_incompatible"
  | "credential_rejected"
  | "connectivity"
  | "rate_limited"
  | "quota_service"
  | "parse_incompatible";

export type CommandCodeWindow = {
  id: "monthly" | "weekly" | "five_hour";
  label: string;
  percentUsed: number;
  percentRemaining: number;
  resetsAt?: string;
};

export type CommandCodeQuotaData = {
  login?: string;
  remainingCredits?: number;
  windows: CommandCodeWindow[];
  stale: boolean;
};

export type CommandCodeQuotaResult =
  | { ok: true; checkedAt: string; data: CommandCodeQuotaData }
  | { ok: false; checkedAt: string; kind: CommandCodeQuotaFailureKind; message: string };
