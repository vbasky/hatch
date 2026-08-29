import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { HatchServerContext } from "@hatch/contracts";

const TABLE = `CREATE TABLE IF NOT EXISTS appearance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  follow_system INTEGER NOT NULL
)`;

type NativeTheme = { themeSource: "system" | "light" | "dark"; shouldUseDarkColors: boolean };

function nativeTheme(): NativeTheme | null {
  try {
    const require = createRequire(import.meta.url);
    const electron = require("electron") as { nativeTheme?: NativeTheme };
    return electron.nativeTheme ?? null;
  } catch {
    return null;
  }
}

function macosPrefersDark(): boolean | null {
  try {
    const ran = spawnSync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (ran.error || ran.status !== 0) return null;
    return ran.stdout.trim().toLowerCase() === "dark";
  } catch {
    return null;
  }
}

function looksDark(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/['"]/g, "");
  return normalized.includes("prefer-dark") || normalized.includes("dark");
}

function gsettingsGet(key: string): string | null {
  try {
    const ran = spawnSync("gsettings", ["get", "org.gnome.desktop.interface", key], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (ran.error || ran.status !== 0) return null;
    const text = (ran.stdout ?? "").trim();
    return text || null;
  } catch {
    return null;
  }
}

function linuxPrefersDark(): boolean | null {
  const colorScheme = gsettingsGet("color-scheme");
  if (colorScheme != null) return looksDark(colorScheme);
  const gtkTheme = gsettingsGet("gtk-theme");
  if (gtkTheme != null) return looksDark(gtkTheme);
  return null;
}

function nativeSystemDark(): boolean | null {
  const theme = nativeTheme();
  if (!theme) return null;
  const previous = theme.themeSource;
  try {
    theme.themeSource = "system";
    return theme.shouldUseDarkColors === true;
  } finally {
    theme.themeSource = previous;
  }
}

function systemPrefersDark(): boolean {
  const fromNative = nativeSystemDark();
  if (fromNative != null) return fromNative;
  if (process.platform === "darwin") return macosPrefersDark() === true;
  if (process.platform === "linux") return linuxPrefersDark() === true;
  return false;
}

function ensureTable(db: HatchServerContext["db"]) {
  db.exec(TABLE);
}

function readFollow(db: HatchServerContext["db"]): boolean {
  ensureTable(db);
  const row = db.get<{ follow_system: number }>(
    "SELECT follow_system FROM appearance_settings WHERE id = 1",
  );
  return row == null ? true : row.follow_system === 1;
}

function writeFollow(db: HatchServerContext["db"], follow: boolean) {
  ensureTable(db);
  db.run(
    "INSERT INTO appearance_settings (id, follow_system) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET follow_system = excluded.follow_system",
    [follow ? 1 : 0],
  );
}

function applyNativeTheme(follow: boolean) {
  const theme = nativeTheme();
  if (!theme) return;
  theme.themeSource = follow ? "system" : "dark";
}

function snapshot(followSystem: boolean) {
  const systemDark = systemPrefersDark();
  applyNativeTheme(followSystem);
  return { ok: true as const, followSystem, systemDark };
}

async function syncTheme(_input: unknown, context: HatchServerContext) {
  return snapshot(readFollow(context.db));
}

async function setFollowSystem(input: unknown, context: HatchServerContext) {
  const follow = Boolean(
    input && typeof input === "object" && "follow" in input && (input as { follow: unknown }).follow,
  );
  writeFollow(context.db, follow);
  return snapshot(follow);
}

export const actions = {
  syncTheme,
  setFollowSystem,
};

export const background = {
  intervalMs: 300_000,
  runOnStart: true,
  run: async (context: HatchServerContext) => {
    applyNativeTheme(readFollow(context.db));
  },
};
