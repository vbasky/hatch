import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("packaged runtime verification", () => {
  it("recursively rejects esbuild nested in unpacked dependencies", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "hatch-packaged-esbuild-"));
    const nestedEsbuildPath = join(
      tempDirectory,
      "Hatch Dev.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "acpx",
      "node_modules",
      "esbuild",
    );
    await mkdir(nestedEsbuildPath, { recursive: true });

    try {
      const verificationScript = resolve(
        import.meta.dirname,
        "../scripts/e2e-packaged-mac-app.mjs",
      );
      const invocation = [
        `import(${JSON.stringify(verificationScript)})`,
        `.then(({ assertNoPackagedEsbuild }) => assertNoPackagedEsbuild(${JSON.stringify(join(tempDirectory, "Hatch Dev.app"))}))`,
      ].join("");
      await expect(execFileAsync(process.execPath, ["--input-type=module", "--eval", invocation]))
        .rejects.toMatchObject({
          stderr: expect.stringContaining(nestedEsbuildPath),
        });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("distribution config", () => {
  it("adds mac packaging scripts and keeps TypeScript available at runtime for extension compilation", () => {
    expect(packageJson.scripts?.["package:mac"]).toContain("tauri build --bundles app");
    expect(packageJson.scripts?.["dist:mac"]).toContain("scripts/create-dmg.mjs");
    expect(packageJson.dependencies?.typescript).toBe("6.0.3");
    expect(packageJson.devDependencies?.["@tauri-apps/cli"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("does not copy a Node sidecar or symlink checkout node_modules into the app bundle", async () => {
    const copyScript = await readFile(resolve(import.meta.dirname, "../scripts/copy-tauri-app.mjs"), "utf8");
    expect(copyScript).not.toContain("symlinkSync");
    expect(copyScript).not.toContain("node_modules");
    expect(copyScript).not.toContain("Contents/MacOS/node");
    expect(copyScript).not.toContain("src-tauri/binaries");
  });

  it("runs Vite and Tauri from local node_modules instead of pnpm", async () => {
    const build = await readFile(resolve(import.meta.dirname, "../scripts/build.mjs"), "utf8");
    const launcher = await readFile(resolve(import.meta.dirname, "../scripts/dev.mjs"), "utf8");
    const config = await readFile(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8");

    expect(build).not.toMatch(/["']pnpm["']/);
    expect(build).toContain("node_modules/vite/bin/vite.js");
    expect(launcher).not.toMatch(/["']pnpm["']/);
    expect(launcher).toContain("node_modules/@tauri-apps/cli/tauri.js");
    expect(config).not.toContain("pnpm exec vite");
    expect(config).toContain("node_modules/vite/bin/vite.js");
  });

  it("uses a Qt/KDE Linux shell instead of GTK WebKit", async () => {
    const cargo = await readFile(resolve(import.meta.dirname, "../src-tauri/Cargo.toml"), "utf8");
    const pkgbuild = await readFile(resolve(import.meta.dirname, "../aur/PKGBUILD"), "utf8");
    const lib = await readFile(resolve(import.meta.dirname, "../src-tauri/src/lib.rs"), "utf8");
    const desktop = await readFile(resolve(import.meta.dirname, "../assets/linux/hatch.desktop"), "utf8");

    expect(cargo).toContain("[target.'cfg(target_os = \"macos\")'.dependencies]");
    expect(cargo).toMatch(/tauri = \{ version = "2"/);
    expect(lib).toContain("mod kde");
    expect(lib).toContain("kde::run()");
    expect(pkgbuild).toContain("qt6-webengine");
    expect(pkgbuild).toContain("qt6-base");
    expect(pkgbuild).toContain("layer-shell-qt");
    expect(pkgbuild).toContain("kwindowsystem");
    expect(pkgbuild).not.toContain("webkit2gtk");
    expect(pkgbuild).not.toContain("libappindicator-gtk3");
    expect(pkgbuild).toContain("cargo build --release");
    expect(desktop).toContain("Exec=hatch");
    expect(desktop).toContain("Icon=hatch");
  });

  it("packages Hatch under com.hatch.app", async () => {
    const config = await readFile(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8");
    const devConfig = await readFile(resolve(import.meta.dirname, "../src-tauri/tauri.dev.conf.json"), "utf8");
    expect(config).toContain('"identifier": "com.hatch.app"');
    expect(config).toContain('"productName": "Hatch"');
    expect(devConfig).toContain('"identifier": "com.hatch.app"');
    expect(devConfig).toContain('"productName": "Hatch"');
    expect(config).toContain("hatch-app-icon.icns");
    expect(devConfig).toContain("hatch-app-icon.icns");
    expect(packageJson.name).toBe("hatch");
    expect(packageJson.scripts?.["package:mac"]).toContain("Hatch.app");
  });

  it("configures hardened runtime entitlements and ad-hoc local signing", async () => {
    const config = await readFile(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8");
    const prepare = await readFile(resolve(import.meta.dirname, "../scripts/prepare-tauri-resources.mjs"), "utf8");
    const entitlements = await readFile(resolve(import.meta.dirname, "../assets/entitlements.mac.plist"), "utf8");
    const localSigner = await readFile(
      resolve(import.meta.dirname, "../scripts/adhoc-sign-mac-app.mjs"),
      "utf8",
    );

    expect(config).toContain("resources/**/*");
    expect(prepare).toContain("extensions-template");
    expect(prepare).toContain("hatch-env.d.ts");
    expect(prepare).toContain("hello-world");
    expect(prepare).toContain("assets/tray");
    expect(config).toContain('"hardenedRuntime": true');
    expect(config).toContain("entitlements");
    expect(config).toContain("hatch-app-icon.icns");
    expect(config).toContain("../assets/info.mac.plist");
    const infoPlist = await readFile(resolve(import.meta.dirname, "../assets/info.mac.plist"), "utf8");
    expect(infoPlist).toContain("LSUIElement");
    expect(infoPlist).toContain("NSAllowsLocalNetworking");

    expect(localSigner).toContain('spawnSync("file", ["-b", candidate]');
    expect(localSigner).toContain('right.split("/").length - left.split("/").length');
    expect(localSigner).toContain('run("codesign", ["--force", "--sign", "-", candidate])');
    expect(localSigner.indexOf('run("codesign", ["--force", "--sign", "-", candidate])'))
      .toBeLessThan(localSigner.indexOf('run("codesign", ["--force", "--deep", "--sign", "-", appPath])'));

    const entitlementKeys = [...entitlements.matchAll(/<key>(com\.apple\.security\.[^<]+)<\/key>/g)]
      .map((match) => match[1]);
    expect(entitlementKeys).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlements).not.toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    await expect(stat(resolve(import.meta.dirname, "../assets/app-icon.svg")).then((file) => file.isFile())).resolves.toBe(true);
    await expect(stat(resolve(import.meta.dirname, "../assets/app-icon.icns")).then((file) => file.isFile())).resolves.toBe(true);
    await expect(stat(resolve(import.meta.dirname, "../assets/hatch-app-icon.svg")).then((file) => file.isFile())).resolves.toBe(true);
    await expect(stat(resolve(import.meta.dirname, "../assets/hatch-app-icon.icns")).then((file) => file.isFile())).resolves.toBe(true);
    const defaultAppIcon = await readFile(resolve(import.meta.dirname, "../assets/app-icon.icns"));
    const hatchIcon = await readFile(resolve(import.meta.dirname, "../assets/hatch-app-icon.icns"));
    expect(hatchIcon.equals(defaultAppIcon)).toBe(false);
    const hatchSvg = await readFile(resolve(import.meta.dirname, "../assets/hatch-app-icon.svg"), "utf8");
    expect(hatchSvg).not.toMatch(/#6AE3B6/i);
    expect(hatchSvg).not.toMatch(/mint/i);
    expect(hatchSvg).toMatch(/<rect[^>]*fill="#F4F4F4"/);
    expect(hatchSvg).toMatch(/<(?:ellipse|path)[^>]*fill="#0B0B0C"/);
  });

  it("signs, notarizes, and verifies the publication-ready DMG before publishing it", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
    const packagedRuntimeE2e = await readFile(
      resolve(import.meta.dirname, "../scripts/e2e-packaged-mac-app.mjs"),
      "utf8",
    );

    expect(workflow).toContain("name: Release");
    expect(workflow).toContain("on:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("- 'v*'");
    expect(workflow).not.toContain("googleapis/release-please-action@v4");
    expect(workflow).toContain("TEAM_ID: YOUR_TEAM_ID");
    expect(workflow).toContain("BUNDLE_ID: com.hatch.app");
    for (const secret of [
      "MAC_DEVELOPER_ID_CERT_P12",
      "MAC_DEVELOPER_ID_CERT_PASSWORD",
      "APP_STORE_CONNECT_KEY_ID",
      "APP_STORE_CONNECT_ISSUER_ID",
      "APP_STORE_CONNECT_API_KEY",
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
      expect(workflow).toContain(`Missing ${secret}`);
    }
    expect(workflow).toContain("CSC_LINK: ${{ steps.developer_id_cert.outputs.csc_link }}");
    expect(workflow).toContain("CSC_KEY_PASSWORD: ${{ secrets.MAC_DEVELOPER_ID_CERT_PASSWORD }}");
    expect(workflow).toContain("APPLE_API_KEY: ${{ steps.asc-key.outputs.key_path }}");
    expect(workflow).toContain("pnpm exec tauri build --bundles app");
    expect(workflow).not.toContain("codesign --force --deep --sign -");
    expect(workflow).toContain("xcrun notarytool submit \"$DMG_PATH\"");
    expect(workflow).toContain("--wait");
    expect(workflow).toContain('xcrun stapler staple "$DMG_PATH"');
    expect(workflow).toContain("Verify publication-ready signed and notarized DMG");
    expect(workflow).toContain('codesign --verify --deep --strict --verbose=4 "$APP_PATH"');
    expect(workflow).toContain('TeamIdentifier=$TEAM_ID');
    expect(workflow).toContain('Identifier=$BUNDLE_ID');
    expect(workflow).toContain("Authority=Developer ID Application: YOUR_NAME ($TEAM_ID)");
    expect(workflow).toContain("flags=.*runtime");
    expect(workflow).toContain("^Timestamp=.+$");
    expect(workflow).toContain("verify_code_object");
    expect(workflow).toContain('codesign -d --arch "$architecture" --verbose=4 "$code_object"');
    expect(workflow).toContain('verify_code_object "$candidate" arm64');
    expect(workflow).toContain('verify_code_object "$candidate" x86_64');
    expect(workflow).toContain('verify_code_object "$candidate" "$expected_architecture"');
    expect(workflow).toContain("verify_entitlements");
    expect(workflow).toContain('python3 scripts/verify-macos-entitlements.py');
    expect(workflow).toContain('--arch "$architecture" --entitlements - --xml');
    expect(workflow).toContain("--require-jit");
    expect(workflow).toContain('Contents/MacOS/*|Contents/Frameworks/*.app/Contents/MacOS/*)');
    expect(workflow).toContain('verify_entitlements "$candidate" arm64 "$require_jit"');
    expect(workflow).toContain('verify_entitlements "$candidate" x86_64 "$require_jit"');
    expect(workflow).toContain("verify_macho_architectures");
    expect(workflow).toContain('if [ "$architectures" = "arm64 x86_64" ]');
    expect(workflow).not.toContain("node_modules/@esbuild/");
    expect(workflow).not.toContain("node_modules/esbuild/");
    expect(workflow).toContain("node_modules/@tailwindcss/oxide-darwin-arm64/tailwindcss-oxide.darwin-arm64.node");
    expect(workflow).toContain("node_modules/lightningcss-darwin-arm64/lightningcss.darwin-arm64.node");
    expect(workflow).toContain('if [ ! -f "$counterpart" ]');
    expect(workflow).toContain("Missing paired $counterpart_architecture native prebuilt");
    expect(workflow).toContain("file -b \"$candidate\"");
    expect(workflow).toContain('spctl --assess --type execute --verbose=4 "$APP_PATH"');
    expect(workflow).toContain("source=Notarized Developer ID");
    expect(workflow).toContain('xcrun stapler validate "$APP_PATH"');
    expect(workflow).toContain('xcrun stapler validate "$DMG_PATH"');
    expect(workflow).toContain('node scripts/e2e-packaged-mac-app.mjs "$APP_PATH"');
    expect(packagedRuntimeE2e).toContain("assertNoPackagedEsbuild");
    expect(packagedRuntimeE2e).toContain("assertNoPackagedEsbuild");
    expect(packagedRuntimeE2e).toContain("window.hatch.agent.send");
    expect(packagedRuntimeE2e).toContain("agent:prompt:done");
    expect(workflow).toContain("CFBundleShortVersionString");
    expect(workflow).toContain('lipo "$APP_EXECUTABLE" -verify_arch arm64 x86_64');
    expect(workflow).toContain('ARCHITECTURES" != "arm64 x86_64"');

    expect(workflow).toContain('node scripts/e2e-packaged-mac-app.mjs "$APP_PATH"');

    const verifyIndex = workflow.indexOf("Verify publication-ready signed and notarized DMG");
    const runtimeE2eIndex = workflow.indexOf('node scripts/e2e-packaged-mac-app.mjs "$APP_PATH"');
    const checksumIndex = workflow.indexOf("Compute SHA256");
    const uploadIndex = workflow.indexOf("Upload DMG to release");
    const caskIndex = workflow.indexOf("Update Homebrew Cask");
    const aurIndex = workflow.indexOf("Update AUR package");
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(runtimeE2eIndex).toBeGreaterThan(verifyIndex);
    expect(checksumIndex).toBeGreaterThan(runtimeE2eIndex);
    expect(uploadIndex).toBeGreaterThan(checksumIndex);
    expect(caskIndex).toBeGreaterThan(uploadIndex);
    expect(aurIndex).toBeGreaterThan(caskIndex);
    expect(workflow).toContain("softprops/action-gh-release@v2");
    expect(packagedRuntimeE2e).toContain('join(testAppDataRoot, "preferences.json")');
    expect(packagedRuntimeE2e).toContain("openAtLogin: false");
    expect(packagedRuntimeE2e.indexOf("openAtLogin: false")).toBeLessThan(packagedRuntimeE2e.indexOf("spawn(executablePath"));

    expect(workflow).toContain("HOMEBREW_TAP_TOKEN");
    expect(workflow).toContain("Casks/hatch.rb");
    expect(workflow).toContain("git diff --cached --quiet");
    expect(workflow).toContain("xattr");
    expect(workflow).toContain('"~/.hatch"');
    expect(workflow).toContain('uninstall quit: "com.hatch.app"');
    expect(workflow).toContain("uninstall_preflight do");
    expect(workflow).toContain('system("/usr/bin/pgrep", "-x", "hatch"');
    expect(workflow).toContain('nohup", args: ["/bin/sh", "-c"');
    expect(workflow).toContain('while [ -e "#{appdir}/Hatch.app" ]; do');
    expect(workflow).toContain('/usr/bin/open -a "#{appdir}/Hatch.app"');
    expect(workflow).not.toContain("hatch.relaunch");
    expect(workflow).not.toContain("/tmp/com.vbasky.hatch");
    // The release workflow is release.yml (tag-triggered).
    await expect(stat(resolve(import.meta.dirname, "../.github/workflows/release.yml"))).resolves.toBeDefined();
  });

  it("builds and uploads Linux bundles before the macOS job", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("  linux:");
    expect(workflow).toContain("needs: [linux]");
    expect(workflow).toContain("qt6-base-dev");
    expect(workflow).toContain("qt6-webengine-dev");
    expect(workflow).toContain("liblayershellqtinterface-dev");
    expect(workflow).not.toContain("libwebkit2gtk-4.1-dev");
    expect(workflow).not.toContain("libayatana-appindicator3-dev");
    expect(workflow).toContain("cargo build --release --manifest-path src-tauri/Cargo.toml");
    expect(workflow).toContain("softprops/action-gh-release@v2");
    expect(workflow).toContain("src-tauri/target/release/hatch");

    // The linux job must run before the macos job.
    const linuxJobIndex = workflow.indexOf("  linux:");
    const macosJobIndex = workflow.indexOf("  macos:");
    expect(linuxJobIndex).toBeGreaterThan(-1);
    expect(macosJobIndex).toBeGreaterThan(linuxJobIndex);
  });

  it("generates a syntactically valid Homebrew relaunch shell script", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
    const caskTemplateMatch = workflow.match(/cat > "\$RUNNER_TEMP\/homebrew-tap\/Casks\/hatch\.rb" << CASK_EOF\n(?<template>[\s\S]*?)\n\s+CASK_EOF/);

    expect(caskTemplateMatch?.groups?.template).toBeDefined();

    const caskTemplate = (caskTemplateMatch?.groups?.template ?? "").replace(/^\s{10}/gm, "");
    const { stdout: generatedCask } = await execFileAsync("/bin/bash", [
      "-c",
      `cat << CASK_EOF\n${caskTemplate}\nCASK_EOF`,
    ], {
      env: {
        ...process.env,
        SHA256: "abc123",
        TAG_NAME: "v1.2.3",
        VERSION: "1.2.3",
      },
    });
    const scriptMatch = generatedCask.match(/<<~RELAUNCH_SCRIPT\], must_succeed: false\n(?<script>[\s\S]*?)\n\s*RELAUNCH_SCRIPT/);

    expect(scriptMatch?.groups?.script).toBeDefined();

    const script = (scriptMatch?.groups?.script ?? "")
      .replace(/^\s{14}/gm, "")
      .replaceAll("#{appdir}", "/Applications");

    await expect(execFileAsync("/bin/sh", ["-n", "-c", script])).resolves.toBeDefined();
  });
});
