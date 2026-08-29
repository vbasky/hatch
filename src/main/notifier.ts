import type { HatchNotification } from "../shared/contracts";

export type Notifier = (notification: HatchNotification) => void;

export type NotificationBackend = {
  isSupported: () => boolean;
  show: (notification: { title: string; body?: string }) => void;
};

// Backs `context.notify` for server actions and background tasks. The Electron
// (or later Tauri) backend is injected so this module stays host-agnostic.
export function createNotifier(backend: NotificationBackend): Notifier {
  return ({ title, body }) => {
    if (!title || !backend.isSupported()) return;
    backend.show({ title, body });
  };
}
