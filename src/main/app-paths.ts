import { isAbsolute, join } from "node:path";
import { EXTENSIONS_DIR_ENV } from "../shared/paths";

export type HatchRuntimePaths = {
  appDataRoot: string;
  sourceRoot: string;
  extensionsDir: string;
  recipesDir: string;
  cacheDir: string;
  widgetCacheDir: string;
  serverActionCacheDir: string;
  agentStateDir: string;
  devExtensionSnapshotDir: string;
  bundledExtensionTemplateDir: string | null;
  trayIconPath: string;
  databasePath: string;
  /** Directory holding the bundled clean-room ACP adapters (out/adapters/<name>/index.js). */
  adaptersDir: string;
  isPackaged: boolean;
};

export type HostBundleLayout = "electron" | "tauri";

type HatchPathEnv = Partial<Pick<NodeJS.ProcessEnv, typeof EXTENSIONS_DIR_ENV | "HATCH_PACKAGED_TEST_HOME">>;

type CreateHatchRuntimePathsOptions = {
  isPackaged: boolean;
  sourceRoot: string;
  env?: HatchPathEnv;
  homeDir?: string;
  resourcesPath?: string;
  /** Packaged adapter location. Electron keeps adapters in asar.unpacked; Tauri uses Resources/adapters. */
  hostBundle?: HostBundleLayout;
};

export function createHatchRuntimePaths(options: CreateHatchRuntimePathsOptions): HatchRuntimePaths {
  if (!options.isPackaged) {
    const cacheDir = join(options.sourceRoot, ".cache", "hatch");
    const extensionsDir = resolveSourceExtensionsDir(options.sourceRoot, options.env);
    return {
      appDataRoot: options.sourceRoot,
      sourceRoot: options.sourceRoot,
      extensionsDir,
      recipesDir: join(extensionsDir, "recipes"),
      cacheDir,
      widgetCacheDir: join(cacheDir, "widgets"),
      serverActionCacheDir: join(cacheDir, "server-actions"),
      agentStateDir: join(cacheDir, "acp-sessions"),
      devExtensionSnapshotDir: join(cacheDir, "dev-extension-snapshots"),
      bundledExtensionTemplateDir: null,
      trayIconPath: join(options.sourceRoot, "assets", "tray", "hatchTemplate.png"),
      databasePath: join(cacheDir, "hatch.db"),
      // Dev/source: adapters are esbuild-bundled into the checkout's out/.
      adaptersDir: join(options.sourceRoot, "out", "adapters"),
      isPackaged: false,
    };
  }

  if (!options.homeDir) throw new Error("homeDir is required for packaged Hatch paths");
  if (!options.resourcesPath) throw new Error("resourcesPath is required for packaged Hatch paths");

  const appDataRoot = join(options.homeDir, ".hatch");
  const cacheDir = join(appDataRoot, "cache");
  const extensionsDir = join(appDataRoot, "extensions");
  return {
    appDataRoot,
    sourceRoot: options.sourceRoot,
    extensionsDir,
    recipesDir: join(extensionsDir, "recipes"),
    cacheDir,
    widgetCacheDir: join(cacheDir, "widgets"),
    serverActionCacheDir: join(cacheDir, "server-actions"),
    agentStateDir: join(cacheDir, "acp-sessions"),
    devExtensionSnapshotDir: join(cacheDir, "snapshots"),
    bundledExtensionTemplateDir: join(options.resourcesPath, "extensions-template"),
    trayIconPath: join(options.resourcesPath, "tray", "hatchTemplate.png"),
    databasePath: join(appDataRoot, "hatch.db"),
    adaptersDir: packagedAdaptersDir(options.resourcesPath, options.hostBundle ?? "electron"),
    isPackaged: true,
  };
}

export type ResolveHatchRuntimePathsContext = {
  isPackaged: boolean;
  env?: HatchPathEnv;
  homeDir?: string;
  resourcesPath?: string;
  hostBundle?: HostBundleLayout;
};

export function resolveHatchRuntimePaths(
  sourceRoot: string,
  context: ResolveHatchRuntimePathsContext,
): HatchRuntimePaths {
  return createHatchRuntimePaths({
    isPackaged: context.isPackaged,
    sourceRoot,
    env: context.env ?? process.env,
    homeDir: context.isPackaged ? resolvePackagedHomeDir(context.homeDir ?? "", context.env ?? process.env) : undefined,
    resourcesPath: context.isPackaged ? context.resourcesPath : undefined,
    hostBundle: context.hostBundle,
  });
}

function packagedAdaptersDir(resourcesPath: string, hostBundle: HostBundleLayout): string {
  if (hostBundle === "tauri") return join(resourcesPath, "adapters");
  // Electron: adapters are asar-unpacked (a standalone Node process cannot read
  // inside app.asar), so they live alongside the asar in app.asar.unpacked.
  return join(resourcesPath, "app.asar.unpacked", "out", "adapters");
}

export function resolvePackagedHomeDir(defaultHomeDir: string, env: HatchPathEnv = process.env): string {
  return env.HATCH_PACKAGED_TEST_HOME?.trim() || defaultHomeDir;
}

function resolveSourceExtensionsDir(
  sourceRoot: string,
  env: HatchPathEnv = process.env,
): string {
  const configured = env[EXTENSIONS_DIR_ENV];
  if (!configured) return join(sourceRoot, "extensions");
  return isAbsolute(configured) ? configured : join(sourceRoot, configured);
}
