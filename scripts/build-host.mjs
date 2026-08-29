#!/usr/bin/env node
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(rootDir, "out/host");

mkdirSync(outDir, { recursive: true });

await esbuild.build({
  absWorkingDir: rootDir,
  entryPoints: [join(rootDir, "src/main/host-entry.ts")],
  outfile: join(outDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "bundle",
  external: [
    "typescript",
    "tailwindcss",
    "@tailwindcss/postcss",
    "@tailwindcss/oxide",
    "@tailwindcss/node",
    "postcss",
    "lightningcss",
    "fsevents",
  ],
  define: {
    "process.env.HATCH_BUILD_UMAMI_HOST": JSON.stringify(process.env.HATCH_UMAMI_HOST || ""),
    "process.env.HATCH_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.HATCH_UMAMI_WEBSITE_ID || ""),
  },
  banner: {
    js: 'import { createRequire as __hatchCreateRequire } from "node:module"; const require = __hatchCreateRequire(import.meta.url);',
  },
});

cpSync(join(rootDir, "src/ui/theme.css"), join(outDir, "theme.css"));
