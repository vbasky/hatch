export type OpenCodeQuotaFailureKind =
  | "auth_required"
  | "auth_source_missing"
  | "auth_source_unreadable"
  | "auth_source_malformed"
  | "auth_source_incompatible"
  | "credential_rejected"
  | "subscription_required"
  | "connectivity"
  | "rate_limited"
  | "quota_service"
  | "parse_incompatible";

export type OpenCodeWindow = {
  id: "monthly" | "weekly" | "rolling";
  label: string;
  percentUsed: number;
  percentRemaining: number;
  resetsAt?: string;
  status: "ok" | "rate-limited";
};

export type OpenCodeQuotaData = {
  windows: OpenCodeWindow[];
  stale: boolean;
};

export type OpenCodeQuotaResult =
  | { ok: true; checkedAt: string; data: OpenCodeQuotaData }
  | { ok: false; checkedAt: string; kind: OpenCodeQuotaFailureKind; message: string };
