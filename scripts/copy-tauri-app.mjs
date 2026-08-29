#!/usr/bin/env node
import { cpSync, mkdirSync, existsSync, readdirSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = join(rootDir, "src-tauri/target/release/bundle/macos");
const destDir = join(rootDir, "release/mac-universal");
const appName = "Hatch.app";
const resourcesSrc = join(rootDir, "src-tauri/resources");
const rendererSrc = join(rootDir, "out/renderer");

if (!existsSync(bundleDir)) {
  console.error(`Tauri macOS bundle not found at ${bundleDir}`);
  process.exit(1);
}

const apps = readdirSync(bundleDir).filter((name) => name.endsWith(".app"));
const found = apps.includes(appName) ? appName : apps[0];
if (!found) {
  console.error(`No .app in ${bundleDir}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
const destApp = join(destDir, appName);
rmSync(destApp, { recursive: true, force: true });
cpSync(join(bundleDir, found), destApp, { recursive: true });

const resourcesDest = join(destApp, "Contents/Resources");
mkdirSync(resourcesDest, { recursive: true });
if (existsSync(resourcesSrc)) {
  for (const entry of readdirSync(resourcesSrc)) {
    cpSync(join(resourcesSrc, entry), join(resourcesDest, entry), { recursive: true });
  }
}
if (existsSync(rendererSrc)) {
  for (const entry of readdirSync(rendererSrc)) {
    cpSync(join(rendererSrc, entry), join(resourcesDest, entry), { recursive: true });
  }
}

const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const sidecar = join(rootDir, "src-tauri/binaries", `node-${triple}`);
const nodeDest = join(destApp, "Contents/MacOS/node");
if (existsSync(sidecar)) {
  try {
    chmodSync(nodeDest, 0o755);
  } catch {
    // dest node may be missing or 555 from a failed bundle
  }
  cpSync(sidecar, nodeDest);
  chmodSync(nodeDest, 0o755);
}

const bundledModules = join(resourcesDest, "node_modules");
rmSync(bundledModules, { recursive: true, force: true });
symlinkSync(join(rootDir, "node_modules"), bundledModules);
console.log(`Copied ${found} -> ${destApp}`);
