#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const resourcesDir = join(rootDir, "src-tauri/resources");
const binariesDir = join(rootDir, "src-tauri/binaries");
const templateDir = join(resourcesDir, "extensions-template");

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(templateDir, { recursive: true });
mkdirSync(binariesDir, { recursive: true });

const extensionsRoot = join(rootDir, "extensions");
for (const file of ["AGENTS.md", "hatch-env.d.ts", "layout.tsx", "density.ts"]) {
  cpSync(join(extensionsRoot, file), join(templateDir, file));
}
cpSync(join(extensionsRoot, "recipes"), join(templateDir, "recipes"), { recursive: true });
for (const id of ["hello-world", "appearance", "git-commits", "grok-quota", "opencode-quota", "command-code-quota"]) {
  cpSync(join(extensionsRoot, id), join(templateDir, id), { recursive: true });
}

cpSync(join(rootDir, "assets/tray"), join(resourcesDir, "tray"), { recursive: true });
cpSync(join(rootDir, "out/host"), join(resourcesDir, "host"), { recursive: true });
if (existsSync(join(rootDir, "out/adapters"))) {
  cpSync(join(rootDir, "out/adapters"), join(resourcesDir, "adapters"), { recursive: true });
}

cpSync(join(rootDir, "package.json"), join(resourcesDir, "package.json"));
if (existsSync(join(rootDir, "out/renderer"))) {
  cpSync(join(rootDir, "out/renderer"), join(resourcesDir, "renderer"), { recursive: true });
}

// Native host: Node sidecar is no longer packaged.
