import { pathToFileURL } from "node:url";
import type {
  AgentActiveTurn,
  AgentChatResult,
  HatchCustomAgentInput,
  HatchSettings,
  GitActionResult,
  GitSessionSnapshot,
  PopoverVisibilityState,
  RecipeMetadata,
  SqlParams,
  UpdateStatus,
} from "../shared/contracts";
import { getExtensionsDir, getRecipesDir } from "../shared/paths";
import { HatchAgentRuntime, type HatchAgentRuntimeSendOptions } from "./agent-runtime";
import { createExtensionDatabase, type ExtensionDatabase } from "./extension-database";
import { loadRecipes } from "./recipe-loader";
import { createServerActionRegistry, type ServerActionRegistry } from "./server-action-registry";
import {
  createLayoutModuleRegistry,
  createWidgetModuleRegistry,
  type LayoutModuleRegistry,
  type WidgetModuleRegistry,
} from "./widget-module-registry";

export type AgentRuntimeFacade = Pick<
  HatchAgentRuntime,
  "save" | "rollback" | "currentSessionSnapshot" | "currentTurn"
> & {
  send: (prompt: string, options?: HatchAgentRuntimeSendOptions) => Promise<AgentChatResult>;
};

export type PopoverController = {
  setContentHeight: (height: number) => void | Promise<void>;
  setContentSize: (size: { width: number; height: number }) => void | Promise<void>;
  getVisibility: () => PopoverVisibilityState | Promise<PopoverVisibilityState>;
};

export type SettingsController = {
  get: () => Promise<HatchSettings> | HatchSettings;
  setOpenAtLogin: (openAtLogin: boolean) => Promise<HatchSettings> | HatchSettings;
  setAgent: (agentName: string) => Promise<HatchSettings> | HatchSettings;
  addAgent: (input: HatchCustomAgentInput) => Promise<HatchSettings> | HatchSettings;
  updateAgent: (name: string, input: { label?: string; command: string }) => Promise<HatchSettings> | HatchSettings;
  removeAgent: (name: string) => Promise<HatchSettings> | HatchSettings;
};

export type AppController = {
  quit: () => void | Promise<void>;
  getUpdateStatus?: () => UpdateStatus | Promise<UpdateStatus>;
  openReleasePage?: () => void | Promise<void>;
};

export type HostRuntimeOptions = {
  recipesDir?: string;
  database?: ExtensionDatabase;
  layoutModules?: LayoutModuleRegistry;
  appVersion?: string;
};

export type HostEmit = (channel: string, payload: unknown) => void;

export type HostHandlers = {
  invoke: (channel: string, args?: unknown[], emit?: HostEmit) => Promise<unknown>;
};

export type CreateHostHandlersOptions = HostRuntimeOptions & {
  rootDir: string;
  agentRuntime?: AgentRuntimeFacade;
  serverActions?: ServerActionRegistry;
  widgetModules?: WidgetModuleRegistry;
  popover?: PopoverController;
  settings?: SettingsController;
  appController?: AppController;
};

export const HOST_INVOKE_CHANNELS = [
  "hatch:recipes:list",
  "hatch:agent:send",
  "hatch:agent:active-turn",
  "hatch:git:save",
  "hatch:git:rollback",
  "hatch:git:status",
  "hatch:capabilities:list",
  "hatch:capabilities:invoke",
  "hatch:db:query",
  "hatch:db:get",
  "hatch:db:run",
  "hatch:db:exec",
  "hatch:widgets:list",
  "hatch:layout:get",
  "hatch:popover:set-content-height",
  "hatch:popover:set-content-size",
  "hatch:popover:get-visibility",
  "hatch:settings:get",
  "hatch:settings:set-open-at-login",
  "hatch:settings:set-agent",
  "hatch:settings:add-agent",
  "hatch:settings:update-agent",
  "hatch:settings:remove-agent",
  "hatch:app:quit",
  "hatch:app:get-update-status",
  "hatch:app:open-release-page",
] as const;

export type HostInvokeChannel = (typeof HOST_INVOKE_CHANNELS)[number];

const defaultPopover: PopoverController = {
  setContentHeight: () => undefined,
  setContentSize: () => undefined,
  getVisibility: () => ({ visible: false }),
};

const defaultSettings: SettingsController = {
  get: () => ({ openAtLogin: false, agentName: "", agents: [] }),
  setOpenAtLogin: (openAtLogin) => ({ openAtLogin, agentName: "", agents: [] }),
  setAgent: (agentName) => ({ openAtLogin: false, agentName, agents: [] }),
  addAgent: () => ({ openAtLogin: false, agentName: "", agents: [] }),
  updateAgent: () => ({ openAtLogin: false, agentName: "", agents: [] }),
  removeAgent: () => ({ openAtLogin: false, agentName: "", agents: [] }),
};

const defaultAppController: AppController = {
  quit: () => undefined,
};

function emptyUpdateStatus(appVersion: string): UpdateStatus {
  return {
    currentVersion: appVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
  };
}

export function createHostHandlers(options: CreateHostHandlersOptions): HostHandlers {
  const rootDir = options.rootDir;
  const agentRuntime = options.agentRuntime ?? new HatchAgentRuntime(rootDir);
  const serverActions =
    options.serverActions ?? createServerActionRegistry({ rootDir, actionRoots: [getExtensionsDir(rootDir)] });
  const widgetModules = options.widgetModules ?? createWidgetModuleRegistry(rootDir);
  const popover = options.popover ?? defaultPopover;
  const settings = options.settings ?? defaultSettings;
  const appController = options.appController ?? defaultAppController;
  const recipesDir = options.recipesDir ?? getRecipesDir(rootDir);
  const database = options.database ?? createExtensionDatabase(":memory:");
  const layoutModules = options.layoutModules ?? createLayoutModuleRegistry(rootDir);
  const appVersion = options.appVersion ?? "0.0.0";

  return {
    async invoke(channel, args = [], emit = () => undefined) {
      switch (channel) {
        case "hatch:recipes:list":
          return loadRecipes(pathToFileURL(`${recipesDir}/`)) as Promise<RecipeMetadata[]>;
        case "hatch:agent:send":
          return agentRuntime.send(args[0] as string, {
            onStatus: (status) => emit("hatch:agent:status", status),
          });
        case "hatch:agent:active-turn":
          return agentRuntime.currentTurn() as AgentActiveTurn | null;
        case "hatch:git:save":
          return agentRuntime.save(args[0] as string | undefined) as Promise<GitActionResult>;
        case "hatch:git:rollback":
          return agentRuntime.rollback() as Promise<GitActionResult>;
        case "hatch:git:status":
          return agentRuntime.currentSessionSnapshot() as Promise<GitSessionSnapshot | null>;
        case "hatch:capabilities:list":
          return serverActions.list();
        case "hatch:capabilities:invoke":
          return serverActions.invoke(args[0] as string, args[1] as string, args[2]);
        case "hatch:db:query":
          return database.query(args[0] as string, args[1] as SqlParams | undefined);
        case "hatch:db:get":
          return database.get(args[0] as string, args[1] as SqlParams | undefined);
        case "hatch:db:run":
          return database.run(args[0] as string, args[1] as SqlParams | undefined);
        case "hatch:db:exec":
          database.exec(args[0] as string);
          return undefined;
        case "hatch:widgets:list":
          return widgetModules.list();
        case "hatch:layout:get":
          return layoutModules.get();
        case "hatch:popover:set-content-height":
          await popover.setContentHeight(args[0] as number);
          return { ok: true };
        case "hatch:popover:set-content-size":
          await popover.setContentSize(args[0] as { width: number; height: number });
          return { ok: true };
        case "hatch:popover:get-visibility":
          return popover.getVisibility();
        case "hatch:settings:get":
          return settings.get();
        case "hatch:settings:set-open-at-login":
          return settings.setOpenAtLogin(args[0] as boolean);
        case "hatch:settings:set-agent":
          return settings.setAgent(args[0] as string);
        case "hatch:settings:add-agent":
          return settings.addAgent(args[0] as HatchCustomAgentInput);
        case "hatch:settings:update-agent":
          return settings.updateAgent(args[0] as string, args[1] as { label?: string; command: string });
        case "hatch:settings:remove-agent":
          return settings.removeAgent(args[0] as string);
        case "hatch:app:quit":
          await appController.quit();
          return { ok: true };
        case "hatch:app:get-update-status":
          return (await appController.getUpdateStatus?.()) ?? emptyUpdateStatus(appVersion);
        case "hatch:app:open-release-page":
          await appController.openReleasePage?.();
          return { ok: true };
        default:
          throw new Error(`Unknown host channel: ${channel}`);
      }
    },
  };
}
