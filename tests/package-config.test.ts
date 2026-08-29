import packageJson from "../package.json";
import { describe, expect, it } from "vitest";

describe("package configuration", () => {
  it("pins dependency versions instead of using latest", () => {
    const dependencyGroups = [packageJson.dependencies, packageJson.devDependencies];
    const versions = dependencyGroups.flatMap((dependencies) => Object.entries(dependencies ?? {}));

    expect(versions).not.toEqual([]);
    expect(versions.filter(([, version]) => version === "latest")).toEqual([]);
  });

  it("declares the Node runtime expected by the sidecar host", () => {
    expect(packageJson.engines?.node).toBe(">=22.12");
  });

  it("does not install Electron after dependency installation", () => {
    expect(packageJson.scripts?.postinstall).toBeUndefined();
    expect(packageJson.devDependencies?.electron).toBeUndefined();
  });

  it("runs only the root test directory so generated dev workspaces are not discovered", () => {
    expect(packageJson.scripts?.test).toBe("vitest run tests");
  });

  it("provides an explicit command to destroy the generated dev extension workspace", () => {
    expect(packageJson.scripts?.["dev:reset"]).toBe("node scripts/dev.mjs --reset");
  });

  it("does not expose a direct start script that bypasses the packaged app path", () => {
    expect(packageJson.scripts).not.toHaveProperty("start");
  });
});
