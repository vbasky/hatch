import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHatchRuntimePaths, resolvePackagedHomeDir } from "../src/main/app-paths";
import { seedExtensionWorkspace } from "../src/main/extension-seeder";

describe("Hatch runtime paths", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps source-mode mutable state in the checkout and honors extension workspace overrides", () => {
    const paths = createHatchRuntimePaths({
      isPackaged: false,
      sourceRoot: "/repo",
      env: { HATCH_EXTENSIONS_DIR: "extensions-dev" },
    });

    expect(paths).toMatchObject({
      appDataRoot: "/repo",
      sourceRoot: "/repo",
      extensionsDir: "/repo/extensions-dev",
      cacheDir: "/repo/.cache/hatch",
      agentStateDir: "/repo/.cache/hatch/acp-sessions",
      devExtensionSnapshotDir: "/repo/.cache/hatch/dev-extension-snapshots",
      bundledExtensionTemplateDir: null,
      trayIconPath: "/repo/assets/tray/hatchTemplate.png",
      isPackaged: false,
    });
  });

  it("lets packaged E2E runs isolate the home directory without changing the normal default", () => {
    expect(resolvePackagedHomeDir("/Users/me", {})).toBe("/Users/me");
    expect(resolvePackagedHomeDir("/Users/me", { HATCH_PACKAGED_TEST_HOME: " /tmp/test-home " }))
      .toBe("/tmp/test-home");
  });

  it("keeps packaged mutable state under a home dot directory and templates under Resources", () => {
    const paths = createHatchRuntimePaths({
      isPackaged: true,
      sourceRoot: "/ignored/source",
      homeDir: "/Users/me",
      resourcesPath: "/Applications/Hatch.app/Contents/Resources",
    });

    expect(paths).toMatchObject({
      appDataRoot: "/Users/me/.hatch",
      sourceRoot: "/ignored/source",
      extensionsDir: "/Users/me/.hatch/extensions",
      cacheDir: "/Users/me/.hatch/cache",
      agentStateDir: "/Users/me/.hatch/cache/acp-sessions",
      devExtensionSnapshotDir: "/Users/me/.hatch/cache/snapshots",
      bundledExtensionTemplateDir: "/Applications/Hatch.app/Contents/Resources/extensions-template",
      trayIconPath: "/Applications/Hatch.app/Contents/Resources/tray/hatchTemplate.png",
      adaptersDir: "/Applications/Hatch.app/Contents/Resources/app.asar.unpacked/out/adapters",
      isPackaged: true,
    });
  });

  it("places packaged adapters next to Resources for a Tauri sidecar bundle", () => {
    const paths = createHatchRuntimePaths({
      isPackaged: true,
      sourceRoot: "/ignored/source",
      homeDir: "/Users/me",
      resourcesPath: "/Applications/Hatch.app/Contents/Resources",
      hostBundle: "tauri",
    });

    expect(paths.adaptersDir).toBe("/Applications/Hatch.app/Contents/Resources/adapters");
  });

  it("refreshes bundled template files while preserving user-created extensions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hatch-seed-"));
    tempDirs.push(rootDir);
    const templateDir = join(rootDir, "Resources", "extensions-template");
    const extensionsDir = join(rootDir, ".hatch", "extensions");
    await mkdir(join(templateDir, "recipes"), { recursive: true });
    await mkdir(join(templateDir, "hello-world"), { recursive: true });
    await writeFile(join(templateDir, "AGENTS.md"), "template rules\n");
    await writeFile(join(templateDir, "recipes", "starter.html"), "<title>Starter</title>\n");
    await writeFile(join(templateDir, "hello-world", "widget.tsx"), "export const helloWorldWidget = {};\n");

    const seeded = await seedExtensionWorkspace({ extensionsDir, templateDir });

    expect(seeded).toBe(true);
    await expect(readFile(join(extensionsDir, "AGENTS.md"), "utf8")).resolves.toBe("template rules\n");

    // The user (via the embedded agent) creates their own extension and edits a
    // managed default file. The template also gains a new recipe and the
    // managed files change between launches.
    await mkdir(join(extensionsDir, "system-usage"), { recursive: true });
    await writeFile(join(extensionsDir, "system-usage", "widget.tsx"), "export const systemUsageWidget = {};\n");
    await writeFile(join(extensionsDir, "AGENTS.md"), "user edited rules\n");
    await writeFile(join(templateDir, "AGENTS.md"), "template rules v2\n");
    await mkdir(join(templateDir, "goodbye-world"), { recursive: true });
    await writeFile(join(templateDir, "recipes", "new.html"), "<title>New</title>\n");
    await writeFile(join(templateDir, "goodbye-world", "widget.tsx"), "export const goodbyeWorldWidget = {};\n");

    const reseeded = await seedExtensionWorkspace({ extensionsDir, templateDir });

    expect(reseeded).toBe(true);
    // Managed default files self-heal back to the bundled template, even if edited.
    await expect(readFile(join(extensionsDir, "AGENTS.md"), "utf8")).resolves.toBe("template rules v2\n");
    // New bundled defaults are added.
    await expect(readFile(join(extensionsDir, "recipes", "new.html"), "utf8")).resolves.toBe("<title>New</title>\n");
    await expect(readFile(join(extensionsDir, "goodbye-world", "widget.tsx"), "utf8")).resolves.toBe(
      "export const goodbyeWorldWidget = {};\n",
    );
    // User-created extensions the template does not ship are left untouched.
    await expect(readFile(join(extensionsDir, "system-usage", "widget.tsx"), "utf8")).resolves.toBe(
      "export const systemUsageWidget = {};\n",
    );
  });
});
