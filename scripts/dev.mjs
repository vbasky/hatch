#!/usr/bin/env node

import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const ACTIVE_ENV = "HATCH_DEV_ACTIVE";
export const EXTENSIONS_DIR_ENV = "HATCH_EXTENSIONS_DIR";
export const DEV_EXTENSIONS_DIR_ENV = "HATCH_DEV_EXTENSIONS_DIR";

function commandStatus(result) {
  return typeof result.status === "number" ? result.status : 1;
}

function gitRoot(cwd, execFileSyncFn) {
  return String(execFileSyncFn("git", ["rev-parse", "--show-toplevel"], { cwd })).trim();
}

function resolveInsideRoot(rootDir, filePath) {
  return isAbsolute(filePath) ? filePath : join(rootDir, filePath);
}

function resolveDevExtensionsDir(rootDir, env) {
  const configured = env[DEV_EXTENSIONS_DIR_ENV] || env[EXTENSIONS_DIR_ENV];
  return configured ? resolveInsideRoot(rootDir, configured) : join(rootDir, "extensions-dev");
}

function prepareDevExtensions({ rootDir, devExtensionsDir, mkdirSyncFn, copyFileSyncFn, cpSyncFn }) {
  mkdirSyncFn(devExtensionsDir, { recursive: true });
  copyFileSyncFn(join(rootDir, "extensions", "AGENTS.md"), join(devExtensionsDir, "AGENTS.md"));
  copyFileSyncFn(join(rootDir, "extensions", "hatch-env.d.ts"), join(devExtensionsDir, "hatch-env.d.ts"));
  cpSyncFn(join(rootDir, "extensions", "recipes"), join(devExtensionsDir, "recipes"), { recursive: true });
}

export function runDev({
  cwd = process.cwd(),
  env = process.env,
  execFileSync: execFileSyncFn = execFileSync,
  spawnSync: spawnSyncFn = spawnSync,
  mkdirSync: mkdirSyncFn = mkdirSync,
  copyFileSync: copyFileSyncFn = copyFileSync,
  cpSync: cpSyncFn = cpSync,
} = {}) {
  if (env[ACTIVE_ENV] === "1") {
    return commandStatus(spawnSyncFn("pnpm", ["exec", "tauri", "dev"], { cwd, env, stdio: "inherit" }));
  }

  const rootDir = gitRoot(cwd, execFileSyncFn);
  const devExtensionsDir = resolveDevExtensionsDir(rootDir, env);
  prepareDevExtensions({ rootDir, devExtensionsDir, mkdirSyncFn, copyFileSyncFn, cpSyncFn });
  execFileSyncFn("node", ["scripts/build-adapters.mjs"], { cwd: rootDir, stdio: "inherit" });
  execFileSyncFn("node", ["scripts/build-host.mjs"], { cwd: rootDir, stdio: "inherit" });

  return commandStatus(
    spawnSyncFn("pnpm", ["exec", "tauri", "dev"], {
      cwd: rootDir,
      env: {
        ...env,
        [ACTIVE_ENV]: "1",
        [EXTENSIONS_DIR_ENV]: devExtensionsDir,
      },
      stdio: "inherit",
    }),
  );
}

export function resetDevWorkspace({
  cwd = process.cwd(),
  env = process.env,
  execFileSync: execFileSyncFn = execFileSync,
  spawnSync: spawnSyncFn = spawnSync,
  mkdirSync: mkdirSyncFn = mkdirSync,
  copyFileSync: copyFileSyncFn = copyFileSync,
  cpSync: cpSyncFn = cpSync,
  rmSync: rmSyncFn = rmSync,
} = {}) {
  const rootDir = gitRoot(cwd, execFileSyncFn);
  const devExtensionsDir = resolveDevExtensionsDir(rootDir, env);
  rmSyncFn(devExtensionsDir, { recursive: true, force: true });
  rmSyncFn(join(rootDir, ".cache", "hatch", "acp-sessions"), { recursive: true, force: true });

  return runDev({
    cwd: rootDir,
    env,
    execFileSync: execFileSyncFn,
    spawnSync: spawnSyncFn,
    mkdirSync: mkdirSyncFn,
    copyFileSync: copyFileSyncFn,
    cpSync: cpSyncFn,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(process.argv.includes("--reset") ? resetDevWorkspace() : runDev());
}
