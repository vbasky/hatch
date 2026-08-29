import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("vite renderer config", () => {
  it("pins the renderer to port 5273", async () => {
    const { default: config } = await import("../vite.config");
    expect(config.server?.port).toBe(5273);
    expect(config.server?.strictPort).toBe(true);
    expect(config.base).toBe("./");
  });

  it("allows renderer imports from the repo-level extensions directory", async () => {
    const { default: config } = await import("../vite.config");
    expect(config.server?.fs?.allow).toContain(rootDir);
  });

  it("writes the production renderer bundle inside the repo-level out directory", async () => {
    const { default: config } = await import("../vite.config");
    expect(resolve(rootDir, "src/renderer", String(config.build?.outDir ?? ""))).toBe(
      resolve(rootDir, "out/renderer"),
    );
  });

  it("does not inject the modulepreload polyfill that wraps runtime widget imports", async () => {
    const { default: config } = await import("../vite.config");
    expect(config.build?.modulePreload).toBe(false);
  });
});
