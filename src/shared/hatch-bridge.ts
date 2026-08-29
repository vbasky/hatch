import type {
  AgentRuntimeStatus,
  HatchApi,
  HatchCustomAgentInput,
  BackgroundTaskUpdate,
  PopoverVisibilityState,
  SqlParams,
} from "./contracts";

export type HatchTransport = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (payload: unknown) => void) => () => void;
};

function invoke<T>(transport: HatchTransport, channel: string, ...args: unknown[]): Promise<T> {
  return transport.invoke(channel, ...args) as Promise<T>;
}

export function createHatchApi(transport: HatchTransport): HatchApi {
  return {
    recipes: {
      list: () => invoke(transport, "hatch:recipes:list"),
    },
    git: {
      save: (message?: string) => invoke(transport, "hatch:git:save", message),
      rollback: () => invoke(transport, "hatch:git:rollback"),
      status: () => invoke(transport, "hatch:git:status"),
    },
    agent: {
      send: (prompt: string) => invoke(transport, "hatch:agent:send", prompt),
      onStatus: (listener: (status: AgentRuntimeStatus) => void) =>
        transport.on("hatch:agent:status", (payload) => listener(payload as AgentRuntimeStatus)),
      getActiveTurn: () => invoke(transport, "hatch:agent:active-turn"),
    },
    capabilities: {
      list: () => invoke(transport, "hatch:capabilities:list"),
      invoke: (extensionId: string, action: string, input?: unknown) =>
        invoke(transport, "hatch:capabilities:invoke", extensionId, action, input),
    },
    db: {
      query: (sql: string, params?: SqlParams) => invoke(transport, "hatch:db:query", sql, params),
      get: (sql: string, params?: SqlParams) => invoke(transport, "hatch:db:get", sql, params),
      run: (sql: string, params?: SqlParams) => invoke(transport, "hatch:db:run", sql, params),
      exec: (sql: string) => invoke(transport, "hatch:db:exec", sql),
    },
    widgets: {
      list: () => invoke(transport, "hatch:widgets:list"),
    },
    layout: {
      get: () => invoke(transport, "hatch:layout:get"),
    },
    background: {
      onUpdate: (listener: (event: BackgroundTaskUpdate) => void) =>
        transport.on("hatch:background:update", (payload) => listener(payload as BackgroundTaskUpdate)),
    },
    popover: {
      setContentHeight: (height: number) => invoke(transport, "hatch:popover:set-content-height", height),
      setContentSize: (size: { width: number; height: number }) =>
        invoke(transport, "hatch:popover:set-content-size", size),
      getVisibility: () => invoke(transport, "hatch:popover:get-visibility"),
      onVisibility: (listener: (state: PopoverVisibilityState) => void) =>
        transport.on("hatch:popover:visibility", (payload) => listener(payload as PopoverVisibilityState)),
    },
    settings: {
      get: () => invoke(transport, "hatch:settings:get"),
      setOpenAtLogin: (openAtLogin: boolean) => invoke(transport, "hatch:settings:set-open-at-login", openAtLogin),
      setAgent: (agentName: string) => invoke(transport, "hatch:settings:set-agent", agentName),
      addAgent: (input: HatchCustomAgentInput) => invoke(transport, "hatch:settings:add-agent", input),
      updateAgent: (name: string, input: { label?: string; command: string }) =>
        invoke(transport, "hatch:settings:update-agent", name, input),
      removeAgent: (name: string) => invoke(transport, "hatch:settings:remove-agent", name),
    },
    app: {
      quit: () => invoke(transport, "hatch:app:quit"),
      getUpdateStatus: () => invoke(transport, "hatch:app:get-update-status"),
      openReleasePage: () => invoke(transport, "hatch:app:open-release-page"),
    },
  };
}
