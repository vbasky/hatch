import { useSyncExternalStore } from "react";
import type { GitCommitsResult } from "./types";

export type {
  GitCommitsData,
  GitCommitsFailureKind,
  GitCommitsResult,
} from "./types";

export type GitCommitsViewState = {
  pending: boolean;
  result: GitCommitsResult | null;
};

const initial: GitCommitsViewState = { pending: false, result: null };

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

function fallback(): GitCommitsResult {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    kind: "connectivity",
    message: "could not reach github",
  };
}

export async function refreshView() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    state = { ...state, pending: true };
    emit();
    let result: GitCommitsResult;
    try {
      const api = window.hatch;
      if (!api) {
        result = {
          ok: false,
          checkedAt: new Date().toISOString(),
          kind: "unavailable",
          message: "github source unavailable",
        };
      } else {
        const invoked = await api.capabilities.invoke<GitCommitsResult>("git-commits", "getCommits");
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

export function useGitCommits() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
