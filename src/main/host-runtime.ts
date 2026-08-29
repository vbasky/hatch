import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import type { HatchCustomAgentInput, HatchSettings } from "../shared/contracts";
import { createAgentCatalogController } from "./agent-catalog-controller";
import { resolveAdapterLauncher } from "./agent-catalog";
import { HatchAgentRuntime, commandExists } from "./agent-runtime";
import {
  resolveHatchRuntimePaths,
  type HatchRuntimePaths,
  type HostBundleLayout,
} from "./app-paths";
import { seedExtensionWorkspace } from "./extension-seeder";
import { createBackgroundTaskScheduler } from "./background-task-scheduler";
import { createExtensionDatabase } from "./extension-database";
import { createNotifier, type Notifier } from "./notifier";
import { createPreferencesService } from "./preferences";
import { createBackgroundTaskSource, createServerActionRegistry } from "./server-action-registry";
import { initDefaultTelemetry, type TelemetryClient } from "./telemetry";
import { expandProcessPathForGuiLaunch } from "./shell-path";
import { createUpdateChecker } from "./update-checker";
import { createLayoutModuleRegistry, createWidgetModuleRegistry } from "./widget-module-registry";
import { createHostHandlers, type HostEmit, type HostHandlers } from "./host-handlers";

export type HostRuntime = {
  paths: HatchRuntimePaths;
  handlers: HostHandlers;
  telemetry: TelemetryClient;
  close: () => void;
};

export type CreateHostRuntimeOptions = {
  sourceRoot: string;
  isPackaged: boolean;
  homeDir?: string;
  resourcesPath?: string;
  hostBundle?: HostBundleLayout;
  productName?: string;
  version: string;
  emit: HostEmit;
  nodeCommand?: string;
  env?: NodeJS.ProcessEnv;
};

function productionProduct(productName: string | undefined): boolean {
  return productName === "Hatch";
}

export async function createHostRuntime(options: CreateHostRuntimeOptions): Promise<HostRuntime> {
  expandProcessPathForGuiLaunch();
  const env = options.env ?? process.env;
  const telemetry = initDefaultTelemetry({
    app: "hatch",
    version: options.version,
    platform: process.platform,
    arch: process.arch,
    env,
  });
  telemetry.track("app_start");

  const paths = resolveHatchRuntimePaths(options.sourceRoot, {
    isPackaged: options.isPackaged,
    env,
    homeDir: options.isPackaged ? options.homeDir : undefined,
    resourcesPath: options.isPackaged ? options.resourcesPath : undefined,
    hostBundle: options.hostBundle ?? (options.isPackaged ? "tauri" : "electron"),
  });

  try {
    await seedExtensionWorkspace({
      extensionsDir: paths.extensionsDir,
      templateDir: paths.bundledExtensionTemplateDir,
    });
  } catch (error) {
    console.error("[hatch] extension workspace seeding failed; continuing startup", error);
  }

  const allowOpenAtLogin = paths.isPackaged && productionProduct(options.productName);
  const preferences = createPreferencesService({
    userDataDir: paths.appDataRoot,
    app: {
      setLoginItemSettings: ({ openAtLogin }) => {
        options.emit("hatch:set-open-at-login", { openAtLogin });
      },
    },
    defaultOpenAtLogin: allowOpenAtLogin,
    allowOpenAtLogin,
  });
  const persistedPreferences = await preferences.apply();

  const adapterLauncher = resolveAdapterLauncher({
    nodeCommand: options.nodeCommand ?? process.execPath,
  });

  let agentRuntime: HatchAgentRuntime;
  const agentCatalog = createAgentCatalogController({
    agentsJsonPath: join(paths.appDataRoot, "agents.json"),
    resolveAdapterPath: (adapter) => join(paths.adaptersDir, adapter, "index.mjs"),
    adapterLauncher,
    commandExists,
    getActiveAgentName: () => agentRuntime.currentAgent,
    onOverridesChange: (overrides) => agentRuntime.setRegistryOverrides(overrides),
  });
  await agentCatalog.load();

  agentRuntime = new HatchAgentRuntime(paths.appDataRoot, {
    agentName: persistedPreferences.agentName,
    registryOverrides: Object.keys(agentCatalog.overrides).length > 0 ? agentCatalog.overrides : undefined,
    telemetry,
    paths: {
      extensionsDir: paths.extensionsDir,
      agentStateDir: paths.agentStateDir,
      snapshotDir: paths.devExtensionSnapshotDir,
      isPackaged: paths.isPackaged,
    },
  });
  const database = createExtensionDatabase(paths.databasePath);
  const notify: Notifier = createNotifier({
    isSupported: () => true,
    show: ({ title, body }) => options.emit("hatch:native-notify", { title, body }),
  });

  async function buildSettings(): Promise<HatchSettings> {
    const current = await preferences.get();
    return {
      openAtLogin: current.openAtLogin,
      agentName: agentRuntime.currentAgent,
      agentSwitchDisabledReason: agentRuntime.agentSwitchDisabledReason,
      agents: agentCatalog.options(),
    };
  }

  const settingsController = {
    get: buildSettings,
    async setOpenAtLogin(openAtLogin: boolean) {
      await preferences.setOpenAtLogin(openAtLogin);
      return buildSettings();
    },
    async setAgent(agentName: string) {
      await agentRuntime.setAgent(agentName);
      await preferences.setAgent(agentName);
      return buildSettings();
    },
    async addAgent(input: HatchCustomAgentInput) {
      await agentCatalog.addAgent(input);
      return buildSettings();
    },
    async updateAgent(name: string, input: { label?: string; command: string }) {
      await agentCatalog.updateAgent(name, input);
      return buildSettings();
    },
    async removeAgent(name: string) {
      await agentCatalog.removeAgent(name);
      return buildSettings();
    },
  };

  const serverActions = createServerActionRegistry({
    rootDir: paths.appDataRoot,
    actionRoots: [paths.extensionsDir],
    cacheDir: paths.serverActionCacheDir,
    db: database,
    notify,
  });
  const widgetRegistryOptions = {
    rootDir: paths.appDataRoot,
    extensionsDir: paths.extensionsDir,
    mode: (paths.isPackaged ? "compiled" : "vite") as "compiled" | "vite",
    widgetCacheDir: paths.widgetCacheDir,
  };
  const widgetModules = createWidgetModuleRegistry(widgetRegistryOptions);
  const layoutModules = createLayoutModuleRegistry(widgetRegistryOptions);

  const updateChecker = createUpdateChecker({
    currentVersion: options.version,
    openExternal: (url) => {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    },
    simulateUpdate: !options.isPackaged,
  });

  const handlers = createHostHandlers({
    rootDir: paths.appDataRoot,
    agentRuntime,
    serverActions,
    widgetModules,
    settings: settingsController,
    appController: {
      quit: () => {
        options.emit("hatch:app-quit", {});
      },
      getUpdateStatus: () => updateChecker.getStatus(),
      openReleasePage: () => updateChecker.openReleasePage(),
    },
    recipesDir: paths.recipesDir,
    database,
    layoutModules,
    appVersion: options.version,
  });

  const backgroundTasks = createBackgroundTaskScheduler({
    source: createBackgroundTaskSource({
      rootDir: paths.appDataRoot,
      actionRoots: [paths.extensionsDir],
      cacheDir: paths.serverActionCacheDir,
    }),
    context: { rootDir: paths.appDataRoot, db: database, notify },
    watchDir: paths.extensionsDir,
    onTaskRun: (extensionId) => {
      options.emit("hatch:background:update", { extensionId });
    },
  });
  void backgroundTasks.start();

  return {
    paths,
    handlers: {
      invoke(channel, args, emit) {
        if (channel === "hatch:internal:popover-open") {
          telemetry.pageview("/popover");
          telemetry.track("popover_open");
          return Promise.resolve({ ok: true });
        }
        return handlers.invoke(channel, args, emit);
      },
    },
    telemetry,
    close() {
      backgroundTasks.stop();
      database.close();
      void telemetry.close(1_000);
    },
  };
}

export function hostProductName(env: NodeJS.ProcessEnv = process.env): string {
  return env.HATCH_PRODUCT_NAME?.trim() || basename(env.HATCH_EXE_NAME ?? "") || "Hatch";
}
