# Development

Working on Hatch itself.
End users should install the Homebrew Cask (see the [README](../README.md#quick-start)).

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

Hatch is a Tauri 2 app, so the same codebase builds for Linux as a system-tray application (tested against KDE/Plasma). The tray interaction differs from macOS: Linux StatusNotifier tray icons cannot report clicks, so the popover is toggled from the tray context menu (Toggle Hatch / Quit) and is positioned at the cursor. The tray icon is a full-color PNG (`assets/tray/hatch.png`) rather than a macOS template image.

Build the Linux bundles:

```sh
# Install Tauri Linux system dependencies first, e.g. on Debian/Ubuntu:
# sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
#   libgtk-3-dev libayatana-appindicator3-dev
pnpm install
node scripts/build.mjs && node scripts/prepare-tauri-resources.mjs
pnpm exec tauri build --bundles deb,rpm
```

Artifacts land in `src-tauri/target/release/bundle/`. On Wayland, positioning the popover at the cursor is limited by the compositor; X11 supports it fully.

Arch Linux ships via the [AUR PKGBUILD](../aur/PKGBUILD), which builds the release from source against the system webkit2gtk/gtk3 (no bundled runtime). The release workflow builds `deb`/`rpm`, uploads them to the GitHub release, and updates the AUR package and Homebrew cask.

> Note: Linux packages are built and published from the `release-please` workflow; there is no separate Linux CI job on pull requests beyond `cargo check` and the JS checks in `ci.yml`.

## Hero video

The README hero animation is committed from `marketing-video/hatch-marketing-square.gif`.
Use the HyperFrames project in `marketing-video/` to revise it:

```sh
pnpm --dir marketing-video check    # validate the composition
pnpm --dir marketing-video render   # render the MP4 before regenerating the 960x960 GIF
```

## Conventions

- TDD is required for bug fixes and new features.
- Tests live in `tests/` at the repo root, not co-located.
