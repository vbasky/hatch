import { useSyncExternalStore } from "react";
import type {
  GrokQuotaResult,
  GrokQuotaWindow,
  QuotaFailureKind,
} from "./types";

export type { GrokQuotaResult, GrokQuotaWindow, QuotaFailureKind } from "./types";

export type ProductParity = { id: string; percentUsed: number };

type WaitingView = {
  e2e: "waiting";
  pending: boolean;
  checkedAt: string;
  stale: boolean;
  warningKind: "none";
  failureKind: "none";
  cacheSchema: string;
  source: string;
  sourceVersion: string;
  operation: string;
  period: string;
  percentUsed: string;
  percentRemaining: string;
  percentageField: string;
  resetAt: string;
  resetField: string;
  products: ProductParity[];
  completedAcquisitions: number;
  result: null;
};

type SuccessView = {
  e2e: "success";
  pending: boolean;
  checkedAt: string;
  stale: boolean;
  warningKind: QuotaFailureKind | "none";
  failureKind: "none";
  cacheSchema: "2";
  source: "grok-credits-grpc-web";
  sourceVersion: "1";
  operation: "grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig";
  period: "weekly" | "monthly" | "unspecified";
  percentUsed: string;
  percentRemaining: string;
  percentageField: string;
  resetAt: string;
  resetField: string;
  products: ProductParity[];
  completedAcquisitions: number;
  result: Extract<GrokQuotaResult, { ok: true }>;
};

type FailureView = {
  e2e: "failure";
  pending: boolean;
  checkedAt: string;
  stale: boolean;
  warningKind: "none";
  failureKind: QuotaFailureKind;
  cacheSchema: string;
  source: string;
  sourceVersion: string;
  operation: string;
  period: string;
  percentUsed: string;
  percentRemaining: string;
  percentageField: string;
  resetAt: string;
  resetField: string;
  products: ProductParity[];
  completedAcquisitions: number;
  result: Extract<GrokQuotaResult, { ok: false }>;
};

export type GrokQuotaViewState = WaitingView | SuccessView | FailureView;

const EMPTY_PRODUCTS: ProductParity[] = [];

const waitingState = (): WaitingView => ({
  e2e: "waiting",
  pending: false,
  checkedAt: "",
  stale: false,
  warningKind: "none",
  failureKind: "none",
  cacheSchema: "",
  source: "",
  sourceVersion: "",
  operation: "",
  period: "",
  percentUsed: "",
  percentRemaining: "",
  percentageField: "",
  resetAt: "",
  resetField: "",
  products: EMPTY_PRODUCTS,
  completedAcquisitions: 0,
  result: null,
});

let state: GrokQuotaViewState = waitingState();
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function decimalString(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(value);
}

function productParity(windows: GrokQuotaWindow[]): ProductParity[] {
  return windows
    .filter((row) => row.id.startsWith("product:"))
    .map((row) => ({ id: row.id, percentUsed: row.percentUsed }));
}

function successView(
  result: Extract<GrokQuotaResult, { ok: true }>,
  completedAcquisitions: number,
  pending: boolean,
): SuccessView {
  const credits = result.data.windows.find((row) => row.id === "credits");
  const resetAt = credits?.resetAt ?? "";
  return {
    e2e: "success",
    pending,
    checkedAt: result.checkedAt,
    stale: result.data.stale === true,
    warningKind: result.warning?.kind ?? "none",
    failureKind: "none",
    cacheSchema: "2",
    source: "grok-credits-grpc-web",
    sourceVersion: "1",
    operation: "grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig",
    period: result.data.period.type,
    percentUsed: credits ? decimalString(credits.percentUsed) : "",
    percentRemaining: credits ? decimalString(credits.percentRemaining) : "",
    percentageField: credits?.provenance.percentageField ?? "",
    resetAt,
    resetField: resetAt ? "config.currentPeriod.end" : "",
    products: productParity(result.data.windows),
    completedAcquisitions,
    result,
  };
}

function failureView(
  result: Extract<GrokQuotaResult, { ok: false }>,
  completedAcquisitions: number,
  pending: boolean,
): FailureView {
  return {
    e2e: "failure",
    pending,
    checkedAt: result.checkedAt,
    stale: false,
    warningKind: "none",
    failureKind: result.failure.kind,
    cacheSchema: "",
    source: "",
    sourceVersion: "",
    operation: "",
    period: "",
    percentUsed: "",
    percentRemaining: "",
    percentageField: "",
    resetAt: "",
    resetField: "",
    products: EMPTY_PRODUCTS,
    completedAcquisitions,
    result,
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

function fallbackFailure(): Extract<GrokQuotaResult, { ok: false }> {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    failure: {
      kind: "connectivity",
      message: "could not reach grok usage",
      sourcesTried: ["consumer-quota-api"],
    },
  };
}

export async function refreshView() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    state = { ...state, pending: true };
    emit();
    let result: GrokQuotaResult;
    try {
      const api = window.hatch;
      if (!api) {
        result = {
          ok: false,
          checkedAt: new Date().toISOString(),
          failure: {
            kind: "official_quota_source_unavailable",
            message: "grok usage source unavailable",
            sourcesTried: [],
          },
        };
      } else {
        const invoked = await api.capabilities.invoke<GrokQuotaResult>("grok-quota", "getQuota");
        result =
          invoked && typeof invoked === "object" && "ok" in invoked
            ? invoked
            : fallbackFailure();
      }
    } catch {
      result = fallbackFailure();
    }
    const completed = state.completedAcquisitions + 1;
    state = result.ok
      ? successView(result, completed, false)
      : failureView(result, completed, false);
    emit();
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function useGrokQuota() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
