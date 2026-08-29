#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("node", [join(rootDir, "scripts/build-host.mjs")]);
run("node", [join(rootDir, "scripts/build-adapters.mjs")]);
run("pnpm", ["exec", "vite", "build"]);
