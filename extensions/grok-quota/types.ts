export type QuotaFailureKind =
  | "auth_required"
  | "auth_expired"
  | "auth_scope_ambiguous"
  | "auth_principal_changed"
  | "auth_source_missing"
  | "auth_source_unreadable"
  | "auth_source_malformed"
  | "auth_source_incompatible"
  | "credential_rejected"
  | "cli_not_found"
  | "cli_launch_failed"
  | "connectivity"
  | "rate_limited"
  | "quota_service"
  | "official_quota_source_unavailable"
  | "team_scope_unsupported"
  | "response_too_large"
  | "quota_unreported"
  | "parse_incompatible";

export type QuotaSourceTried =
  | "local-auth"
  | "consumer-quota-api"
  | "grok-cli-refresh"
  | "cache";

export type QuotaFailure = {
  kind: QuotaFailureKind;
  message: string;
  sourcesTried: QuotaSourceTried[];
  httpStatus?: number;
  grpcStatus?: number;
  retryAt?: string;
  diagnostic?: string;
};

export type GrokQuotaWindow = {
  id: "credits" | `product:${string}`;
  label: string;
  percentUsed: number;
  percentRemaining: number;
  resetAt?: string;
  provenance: {
    percentageField: "config.creditUsagePercent" | `config.productUsage[${number}].usagePercent`;
    resetField?: "config.currentPeriod.end";
    omittedProto3Default?: true;
  };
};

export type GrokQuotaSnapshot = {
  schemaVersion: 2;
  source: "grok-credits-grpc-web";
  sourceVersion: 1;
  operation: "grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig";
  period: {
    type: "weekly" | "monthly" | "unspecified";
    startAt?: string;
    endAt?: string;
    provenance: "config.currentPeriod";
  };
  windows: GrokQuotaWindow[];
  credits?: {
    remaining: number;
    unit: "credits";
    sourceField: "config.prepaidBalance.val";
  };
  refreshedAt: string;
  stale: boolean;
};

export type StoredGrokQuotaSnapshot = GrokQuotaSnapshot & {
  accountBinding: string;
};

export type GrokQuotaResult =
  | { ok: true; checkedAt: string; data: GrokQuotaSnapshot; warning?: QuotaFailure }
  | { ok: false; checkedAt: string; failure: QuotaFailure };
