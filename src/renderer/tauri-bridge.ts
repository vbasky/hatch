import { createHatchApi, type HatchTransport } from "../shared/hatch-bridge";

type HostRpcPayload = { ok?: boolean; result?: unknown; error?: string };

export async function invokeHostRpc(channel: string, args: unknown[]): Promise<unknown> {
  const response = await fetch("/__rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const payload = (await response.json()) as HostRpcPayload;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `host rpc failed: ${channel}`);
  }
  return payload.result;
}

function packagedHttpOrigin(): boolean {
  return window.location.protocol.startsWith("http") && import.meta.env.DEV !== true;
}

type HostEventDetail = { channel?: string; payload?: unknown };

export function createTauriTransport(): HatchTransport {
  if (packagedHttpOrigin()) {
    return {
      invoke: (channel, ...args) => invokeHostRpc(channel, args),
      on: (channel, listener) => {
        const handler = (event: Event) => {
          const detail = (event as CustomEvent<HostEventDetail>).detail;
          if (detail?.channel === channel) listener(detail.payload);
        };
        window.addEventListener("hatch-host-event", handler);
        return () => window.removeEventListener("hatch-host-event", handler);
      },
    };
  }
  return createNativeTauriTransport();
}

function createNativeTauriTransport(): HatchTransport {
  const unlistens = new Map<string, Promise<() => void>>();
  return {
    invoke: async (channel, ...args) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("host_invoke", { channel, args });
    },
    on: (channel, listener) => {
      const pending = import("@tauri-apps/api/event").then(({ listen }) =>
        listen(channel, (event) => {
          listener(event.payload);
        }),
      );
      unlistens.set(channel, pending);
      return () => {
        void pending.then((unlisten) => unlisten());
        unlistens.delete(channel);
      };
    },
  };
}

export function installTauriHatch(): void {
  window.hatch = createHatchApi(createTauriTransport());
}
