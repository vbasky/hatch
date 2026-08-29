import { useSyncExternalStore } from "react";
import type { CommandCodeQuotaResult } from "./types";

export type {
  CommandCodeQuotaData,
  CommandCodeQuotaFailureKind,
  CommandCodeQuotaResult,
} from "./types";

export type CommandCodeQuotaViewState = {
  pending: boolean;
  result: CommandCodeQuotaResult | null;
};

const initial: CommandCodeQuotaViewState = { pending: false, result: null };

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

function fallback(): CommandCodeQuotaResult {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    kind: "connectivity",
    message: "could not reach command code usage",
  };
}

export async function refreshView() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    state = { ...state, pending: true };
    emit();
    let result: CommandCodeQuotaResult;
    try {
      const api = window.hatch;
      if (!api) {
        result = {
          ok: false,
          checkedAt: new Date().toISOString(),
          kind: "quota_service",
          message: "command code usage source unavailable",
        };
      } else {
        const invoked = await api.capabilities.invoke<CommandCodeQuotaResult>(
          "command-code-quota",
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

export function useCommandCodeQuota() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
