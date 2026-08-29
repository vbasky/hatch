import { useSyncExternalStore } from "react";
import { loadFollowSystem, setFollowSystem as persistFollowSystem } from "./theme";

type AppearanceState = {
  ready: boolean;
  followSystem: boolean;
};

const initial: AppearanceState = { ready: false, followSystem: true };

let state = initial;
let boot: Promise<void> | null = null;
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

export async function hydrateAppearance() {
  if (boot) return boot;
  boot = (async () => {
    const followSystem = await loadFollowSystem();
    state = { ready: true, followSystem };
    emit();
  })().finally(() => {
    boot = null;
  });
  return boot;
}

export async function setFollowSystem(value: boolean) {
  await persistFollowSystem(value);
  state = { ready: true, followSystem: value };
  emit();
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
