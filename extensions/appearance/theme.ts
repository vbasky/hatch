const TABLE = `CREATE TABLE IF NOT EXISTS appearance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  follow_system INTEGER NOT NULL
)`;

const STYLE_ID = "appearance-system-theme";

const LIGHT_CSS = `html[data-theme="light"] {
  color-scheme: light;
  --bg-void: #f2f2f3;
  --bg-stage: #f6f6f7;
  --bg-surface: #ffffff;
  --bg-elevated: #ececee;
  --bg-pressed: #e2e2e6;
  --ink-100: rgba(9, 9, 11, 0.92);
  --ink-200: rgba(9, 9, 11, 0.80);
  --ink-300: rgba(9, 9, 11, 0.62);
  --ink-400: rgba(9, 9, 11, 0.48);
  --ink-500: rgba(9, 9, 11, 0.38);
  --ink-600: rgba(9, 9, 11, 0.22);
  --ink-700: rgba(9, 9, 11, 0.12);
  --ink-800: rgba(9, 9, 11, 0.08);
  --ink-900: rgba(9, 9, 11, 0.04);
  --bg: var(--bg-stage);
  --bg-card: var(--bg-surface);
  --bg-input: var(--bg-elevated);
  --ink: var(--ink-200);
  --ink-strong: var(--ink-100);
  --ink-muted: var(--ink-300);
  --ink-soft: var(--ink-400);
  --ink-label: var(--ink-500);
  --ink-faint: var(--ink-600);
  --line: var(--ink-700);
  --line-faint: var(--ink-800);
  --signal-live: #1a9d73;
  --signal-live-glow: 0 0 6px rgba(26, 157, 115, 0.45);
  --signal-pending: #b8860b;
  --signal-pending-glow: 0 0 6px rgba(184, 134, 11, 0.4);
  --signal-error: #d64555;
  --signal-error-glow: 0 0 6px rgba(214, 69, 85, 0.4);
  --signal-live-tint: rgba(26, 157, 115, 0.12);
  --signal-pending-tint: rgba(184, 134, 11, 0.12);
  --signal-error-tint: rgba(214, 69, 85, 0.12);
  --signal: var(--signal-live);
  --signal-glow: var(--signal-live-glow);
  --signal-warn: var(--signal-pending);
  --signal-danger: var(--signal-error);
  --focus-ring: 0 0 0 1px rgba(26, 157, 115, 0.5), 0 0 0 4px rgba(26, 157, 115, 0.16);
  --shadow-pop: 0 24px 80px rgba(0, 0, 0, 0.16), 0 0 0 0.5px rgba(0, 0, 0, 0.08);
  --shadow-inset: inset 0 0.5px 0 rgba(255, 255, 255, 0.8);
  --color-void: #f2f2f3;
  --color-stage: #f6f6f7;
  --color-surface: #ffffff;
  --color-elevated: #ececee;
  --color-pressed: #e2e2e6;
  --color-ink-strong: rgba(9, 9, 11, 0.92);
  --color-ink: rgba(9, 9, 11, 0.80);
  --color-ink-muted: rgba(9, 9, 11, 0.62);
  --color-ink-soft: rgba(9, 9, 11, 0.48);
  --color-ink-label: rgba(9, 9, 11, 0.38);
  --color-ink-faint: rgba(9, 9, 11, 0.22);
  --color-line: rgba(9, 9, 11, 0.12);
  --color-line-faint: rgba(9, 9, 11, 0.08);
  --color-signal-live: #1a9d73;
  --color-signal-warn: #b8860b;
  --color-signal-danger: #d64555;
}
html[data-theme="light"],
html[data-theme="light"] body,
html[data-theme="light"] #root {
  background: transparent;
  color: var(--ink);
}`;

type ThemeSync = { followSystem?: boolean; systemDark?: boolean };

export function followSystemFromStoredValue(value: number | null | undefined): boolean {
  return value == null ? true : value === 1;
}

let followSystem = true;

function systemPrefersLight(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches === true;
}

function ensureLightStylesheet() {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== LIGHT_CSS) style.textContent = LIGHT_CSS;
}

export function applyTheme(follow: boolean, systemDark?: boolean) {
  followSystem = follow;
  ensureLightStylesheet();
  const osLight = systemDark === undefined ? systemPrefersLight() : !systemDark;
  const mode = follow && osLight ? "light" : "dark";
  const roots = [document.documentElement, document.body].filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
  for (const el of roots) {
    el.dataset.theme = mode;
    el.style.colorScheme = mode;
    el.classList.toggle("dark", mode === "dark");
    el.classList.toggle("light", mode === "light");
  }
}

async function readFollowSystem(): Promise<boolean> {
  const api = window.hatch;
  if (!api) return false;
  try {
    await api.db.exec(TABLE);
    const row = await api.db.get<{ follow_system: number }>(
      "SELECT follow_system FROM appearance_settings WHERE id = 1",
    );
    return followSystemFromStoredValue(row?.follow_system);
  } catch {
    return false;
  }
}

export async function loadFollowSystem(): Promise<boolean> {
  const api = window.hatch;
  if (api) {
    try {
      const synced = await api.capabilities.invoke<ThemeSync>("appearance", "syncTheme");
      if (synced && typeof synced.followSystem === "boolean") {
        applyTheme(synced.followSystem, synced.systemDark);
        return synced.followSystem;
      }
    } catch {
      // fall through to local db
    }
  }
  followSystem = await readFollowSystem();
  applyTheme(followSystem);
  return followSystem;
}

export async function setFollowSystem(value: boolean): Promise<void> {
  const api = window.hatch;
  if (api) {
    try {
      const synced = await api.capabilities.invoke<ThemeSync>("appearance", "setFollowSystem", {
        follow: value,
      });
      applyTheme(value, synced?.systemDark);
      return;
    } catch {
      await api.db.exec(TABLE);
      await api.db.run(
        "INSERT INTO appearance_settings (id, follow_system) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET follow_system = excluded.follow_system",
        [value ? 1 : 0],
      );
    }
  }
  applyTheme(value);
}

export function watchSystemTheme(): () => void {
  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  const api = window.hatch;
  const onMedia = () => {
    if (followSystem) applyTheme(true);
  };
  media?.addEventListener("change", onMedia);
  const unsubVisibility = api?.popover.onVisibility((state) => {
    if (state.visible) void loadFollowSystem();
  });
  const unsubBackground = api?.background.onUpdate((event) => {
    if (event.extensionId === "appearance") void loadFollowSystem();
  });
  return () => {
    media?.removeEventListener("change", onMedia);
    unsubVisibility?.();
    unsubBackground?.();
  };
}
