import { useSyncExternalStore } from "react";
import type { OpenCodeQuotaResult } from "./types";

export type { OpenCodeQuotaData, OpenCodeQuotaFailureKind, OpenCodeQuotaResult } from "./types";

export type OpenCodeQuotaViewState = {
  pending: boolean;
  result: OpenCodeQuotaResult | null;
};

const initial: OpenCodeQuotaViewState = { pending: false, result: null };

let state = initial;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
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

function fallback(): OpenCodeQuotaResult {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    kind: "connectivity",
    message: "could not reach opencode usage",
  };
}

export async function refreshView() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    state = { ...state, pending: true };
    emit();
    let result: OpenCodeQuotaResult;
    try {
      const api = window.hatch;
      if (!api) {
        result = {
          ok: false,
          checkedAt: new Date().toISOString(),
          kind: "quota_service",
          message: "opencode usage source unavailable",
        };
      } else {
        const invoked = await api.capabilities.invoke<OpenCodeQuotaResult>(
          "opencode-quota",
          "getQuota",
        );
        result =
          invoked && typeof invoked === "object" && "ok" in invoked ? invoked : fallback();
      }
    } catch {
      result = fallback();
    }
    state = { pending: false, result };
    emit();
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function useOpenCodeQuota() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
