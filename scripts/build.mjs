#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to spawn ${command} ${args.join(" ")}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("node", [join(rootDir, "scripts/build-host.mjs")]);
run("node", [join(rootDir, "scripts/build-adapters.mjs")]);
run("node", [join(rootDir, "node_modules/vite/bin/vite.js"), "build"]);
