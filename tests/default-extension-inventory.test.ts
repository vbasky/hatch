import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionsDir = resolve(import.meta.dirname, "../extensions");

// Bundled default inventory seeded from extraResources. User-installed
// extensions remain unrestricted and are discovered at runtime.
const NEUTRAL_BUNDLED_EXTENSION_IDS = [
  "appearance",
  "command-code-quota",
  "git-commits",
  "grok-quota",
  "hello-world",
  "opencode-quota",
] as const;
async function sourceExtensionIds(): Promise<string[]> {
  const entries = await readdir(extensionsDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "recipes") continue;
    const files = await readdir(resolve(extensionsDir, entry.name));
    if (files.some((file) => file === "widget.tsx" || file === "server.ts")) ids.push(entry.name);
  }
  return ids.sort();
}

describe("default extension inventory", () => {
  it("contains only the reviewed provider-neutral bundled extensions", async () => {
    expect(await sourceExtensionIds()).toEqual([...NEUTRAL_BUNDLED_EXTENSION_IDS]);
  });

  it("packages exactly the reviewed provider-neutral extension inventory", async () => {
    const script = await readFile(resolve(import.meta.dirname, "../scripts/prepare-tauri-resources.mjs"), "utf8");
    expect(script).toContain('for (const id of ["hello-world", "appearance", "git-commits", "grok-quota", "opencode-quota", "command-code-quota"])');
    expect(script).toContain('for (const file of ["AGENTS.md", "hatch-env.d.ts", "layout.tsx", "density.ts"])');
    expect(script).toContain("recipes");
  });
});
