# Development

Working on Hatch itself.
End users should install a published build: the `.deb`/`.rpm` from the [latest GitHub release](https://github.com/vbasky/hatch/releases) on Linux, or run from source below on macOS (see the [README](../README.md#quick-start)).

## Setup

```sh
git clone https://github.com/vbasky/hatch.git
cd hatch
pnpm install
pnpm dev
```

Requires Node `>=22.12` and `pnpm@11.1.1` (declared in `packageManager`).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Tauri + renderer dev server with a gitignored `extensions-dev/` sandbox |
| `pnpm dev:reset` | Wipe `extensions-dev/` and the agent session cache, then start fresh |
| `pnpm build` | Build main + preload + renderer + bundled adapters into `out/` |
| `pnpm generate:contracts` | Regenerate `extensions/hatch-env.d.ts` from `src/shared/contracts.ts` |
| `pnpm package:mac` | Clean `release/` and create an ad-hoc-signed `Hatch Dev.app` without release credentials |
| `pnpm dist:mac` | Build the local `Hatch Dev.app` and create a universal DMG in `release/` |
| `pnpm test` | Run all Vitest tests |
| `pnpm test:e2e` | Only e2e tests (including `acpx/runtime` plus bundled adapter coverage) |
| `pnpm test:e2e:packaged-mac` | Check that a packaged macOS app starts its renderer and preload bridge |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | `tsc --noEmit` (same as typecheck) |

Single test: `pnpm vitest run tests/<name>.test.ts` or `pnpm vitest run -t "<pattern>"`.

## Dev workflow

- `pnpm dev` iterates in a throwaway sandbox - the agent edits the gitignored `extensions-dev/` copy and your tracked tree stays clean.
- `pnpm dev:reset` when recipe or extension guidance changes; it also clears `.cache/hatch/acp-sessions` so the agent re-reads fresh specs instead of continuing prior conversation state.
- `pnpm generate:contracts` after changing extension-facing types in `src/shared/contracts.ts` or the public name list in `src/shared/extension-contract-names.ts`; CI fails if the committed `extensions/hatch-env.d.ts` is stale.
- Source mode and packaged `Hatch Dev` / test bundles never touch macOS login items. Only the packaged production product named `Hatch` may enable launch-at-login (via the autostart plugin).

## Packaging

- `pnpm package:mac` tests the actual packaged app from `release/mac-universal/Hatch Dev.app`.
- Local packaging uses the `Hatch Dev` product name and `com.vbasky.hatch.dev` bundle id so local builds do not shadow the released `/Applications/Hatch.app` in macOS LaunchServices. It explicitly disables Developer ID discovery and notarization, then applies an ad-hoc signature for local launch only.
- See [CONTRIBUTING.md](../CONTRIBUTING.md#release-notes) for the production release and downloaded-artifact verification procedure.
- The universal package must run on both Intel and Apple Silicon Macs, so packaged runtime native prebuilt dependencies must stay installed for `x64` and `arm64` (`pnpm-workspace.yaml` `supportedArchitectures`).
- `esbuild` is build-time-only and must stay out of packaged bundles. It enters the production dependency graph only through `acpx -> tsx -> esbuild`, but Hatch imports the separately published `acpx/runtime` entry, which does not reference `tsx` or acpx's CLI chunk. The adapters are pre-bundled before packaging, while runtime extension compilation uses the shipped `typescript` dependency. `tests/acpx-runtime-dependencies.test.ts` locks the acpx entry-point boundary, and the packaged runtime E2E verifies a real ACP turn with neither `esbuild` nor `@esbuild` present in the app.
- Keep `pnpm-lock.yaml` in sync with dependency changes so pnpm-deduped packages are included correctly in packaged builds.

## Linux

Hatch on Linux is a Qt 6 / Plasma shell, not Tauri. The tray icon is a StatusNotifierItem (`QSystemTrayIcon` on Plasma), and the popover is a frameless `QWebEngineView` hosting the same React UI. Left-click toggles the popover; the context menu still has Toggle Hatch / Quit. The tray icon is a full-color PNG (`assets/tray/hatch.png`) rather than a macOS template image.

macOS still uses the Tauri 2 / Cocoa host.

Build the Linux binary:

```sh
# Debian/Ubuntu:
# sudo apt install qt6-base-dev qt6-webengine-dev pkg-config g++
# Arch:
# sudo pacman -S qt6-base qt6-webengine layer-shell-qt
pnpm install
node scripts/build.mjs && node scripts/prepare-tauri-resources.mjs
cargo build --release --manifest-path src-tauri/Cargo.toml
```

The binary lands at `src-tauri/target/release/hatch`. Packaged installs load UI, adapters, and the extension template from `/usr/share/hatch`. On Wayland the popover is a layer-shell surface anchored to the panel (regular `setGeometry` is ignored by the compositor); if tray geometry is missing it uses the cursor, then pins above or below the panel.

An [AUR PKGBUILD](../aur/PKGBUILD) is kept in-repo (not published to the AUR) which builds against system Qt 6 WebEngine. The release workflow builds the Linux binary and uploads the deb/rpm to the GitHub release.

> Note: Linux packages are built and published from the `release.yml` workflow; there is no separate Linux CI job on pull requests beyond `cargo check` and the JS checks in `ci.yml`.

## Hero video

The README currently has no hero animation. Recording a fresh hatch demo is still pending; the `marketing-video/` sources are stale baby-menu branding. Use the HyperFrames project in `marketing-video/` to revise it once re-recorded:

```sh
pnpm --dir marketing-video check    # validate the composition
pnpm --dir marketing-video render   # render the MP4 before regenerating the 960x960 GIF
```

## Conventions

- TDD is required for bug fixes and new features.
- Tests live in `tests/` at the repo root, not co-located.
