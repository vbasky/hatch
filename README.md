<p align="center">
  <img alt="Hatch" src="assets/hatch-app-icon.svg" width="96" />
</p>
<h1 align="center">hatch</h1>
<p align="center">
  <a href="https://github.com/vbasky/hatch/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/vbasky/hatch/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://img.shields.io/badge/platform-macOS_%7C_Linux-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS_%7C_Linux-blue?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/tauri-2-9feaf9?style=flat-square"><img alt="Tauri" src="https://img.shields.io/badge/tauri-2-9feaf9?style=flat-square" /></a>
  <a href="https://x.com/vbasky"><img alt="X" src="https://img.shields.io/badge/X-@vbasky-black?style=flat-square" /></a>
</p>

<h3 align="center">Adopt a menu and help it hatch.</h3>

Every menu-bar app ships a fixed set of widgets.
Want your CPU usage next to your Claude usage next to your next calendar event?
Good luck waiting for someone to build exactly that.

Hatch flips it.
The popover menu can run your coding agent to edit the menu on the fly.
You ask for a feature in plain English, the agent writes an extension and it hot reloads into the menu in real time.

- **Personal self-evolving software** - jump into the future where every piece of software is personal and self-evolving towards your exact needs.
- **Ask, don't configure** - tweak the menu using natural language, not configuration.
- **Worry-free** - every agent turn can be kept or undone.

## Quick Start

### macOS

Requires macOS 13 Ventura or newer and a supported, already-authenticated agent CLI such as `claude` or `codex` on `PATH`. macOS builds are not published, so run from source:

```sh
git clone https://github.com/vbasky/hatch.git
cd hatch
pnpm install
pnpm dev
```

See [docs/development.md](docs/development.md#setup) for details.

### Linux

Hatch on Linux is a native KDE/Plasma system-tray app (Qt 6 + Qt WebEngine, StatusNotifierItem).

Grab the `.deb` or `.rpm` from the [latest GitHub release](https://github.com/vbasky/hatch/releases), or build from source - see [docs/development.md](docs/development.md#linux).

Requires a supported, already-authenticated agent CLI such as `claude` or `codex` on `PATH`.

Click the tray icon, then ask for a widget in the composer such as:

```text
add a CPU usage widget that shows current load in %
```

Hatch writes changes under `~/.hatch/extensions`, mounts updated widgets or layouts live, and shows a Keep / Undo bar only when files actually changed.
The bar labels the real diff (`Added the cpu extension`, `Updated the layout`) so you can keep or throw away each turn.

Open the popover header to reload the layout, reach Settings (an overlay that preserves your menu state), quit, or install an update.
Reloading the layout remounts the widget canvas and root layout while preserving the agent conversation and Settings state.
Settings lets you toggle launch-at-login, pick the embedded agent, and manage custom ACP agents.

## Install Details

The packaged app stores extensions, the local database, caches, agent sessions, and preferences under `~/.hatch`, so upgrades preserve user-created widgets and extension state. Hatch refreshes its provider-neutral managed defaults from the release on each launch.
If `~/.hatch/extensions` is a symlink, Hatch seeds bundled defaults and compiles widget or layout CSS from the resolved writable target while leaving the symlink itself in place.

When a newer release exists, Hatch shows an update indicator in the popover header.

For agent selection, custom ACP agents, telemetry, and environment flags, see [docs/configuration.md](docs/configuration.md).

## Safety

The embedded agent edits your menu, not your machine:

- Agent changes land only under `~/.hatch/extensions`, never in the app itself.
- Every agent turn runs in a change session with a Keep / Undo bar driven by the real on-disk diff.
- The renderer never touches git, the agent, or the filesystem directly. Everything crosses the `window.hatch` bridge, and credentials stay in extension server actions.

## Privacy

Packaged release builds send anonymous usage telemetry (no user id, device id, prompts, or file contents) to a self-hosted instance. Source and dev builds send nothing. Opt out any time with `HATCH_TELEMETRY=0`. See [docs/configuration.md](docs/configuration.md#telemetry).

## How It Works

```
   ┌─────────────────────┐
   │  system tray popover│   (React renderer, adaptive size)
   │ + Menu / Settings   │
   │ + Reload layout     │
   │ + Update / Quit     │
   └──────────┬──────────┘
              │  send()
              ▼
   ┌───────────────────────┐       ┌──────────────────────┐
   │  HatchAgentRuntime ├──────►│    Change Session    │
   │   wraps acpx/runtime  │       │   git or snapshot    │
   └──────────┬────────────┘       │   by runtime mode    │
              │                    └──────────┬───────────┘
              │ edits files                   │ save / rollback
              ▼                               ▼
   ┌─────────────────────┐       ┌──────────────────────┐
   │ active extensions/  │       │   save snapshot or   │
   │  layout.tsx         │◄──────┤   rollback files     │
   │  <id>/widget.tsx    │       │   safely             │
   │  <id>/server.ts     │       │                      │
   └──────────┬──────────┘       │                      │
              │ hot-reload       └──────────────────────┘
              ▼
   ┌─────────────────────┐
   │     WidgetHost      │
   │ mounts layout/widget│
   └─────────────────────┘
```

- **Three processes, one bridge** - the renderer never touches git, the agent, or the filesystem; everything goes through `window.hatch`. On Linux the popover toggles from a left-click on the Plasma StatusNotifier tray icon; the context menu still has Toggle Hatch / Quit.
- **Recipes are specs, not prompts** - HTML files under `extensions/recipes/` describe a widget's capability and data sources; the agent reads the matching recipe before implementing.
  For live or system data, recipe guidance requires the agent to inspect the real source before parsing it and verify the finished widget against that same data before reporting done.
  The bundled quota recipes cover Claude Code, Codex, Cursor, GitHub Copilot, and Grok.
  Cursor, GitHub Copilot, and Grok quota recipes avoid separate quota helpers such as `quota-axi`; each recipe is authoritative for its provider-owned state, API, and credential-refresh contract.
- **Bundled ACP adapters** - built-in Claude Code and Codex run through clean-room adapters isolated from user-level agent configuration.
- **Diff-derived Keep / Undo** - the change bar reflects the actual git or snapshot diff, not agent wording, and clears itself when nothing changed on disk.
- **Extensions own their capabilities** - widgets, layouts, settings sections, server actions, background tasks, and a shared SQLite store, all behind the stable bridge.

For the full design notes and repository layout, see [docs/architecture.md](docs/architecture.md).

## Docs

- [docs/configuration.md](docs/configuration.md) - agent selection, custom ACP agents, telemetry, environment flags
- [docs/architecture.md](docs/architecture.md) - runtime design notes and repository layout
- [docs/development.md](docs/development.md) - building, testing, and packaging Hatch itself
- [CONTRIBUTING.md](CONTRIBUTING.md) - contributor notes and the release process
- [CHANGELOG.md](CHANGELOG.md) - release history
- [VISION.md](VISION.md) - what the project is and is not

## License

Hatch is released under the MIT License.
See [LICENSE](LICENSE) for details.
