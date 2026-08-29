import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type HatchPreferences = {
  openAtLogin: boolean;
  /** Persisted embedded-agent choice; absent until the user picks one. */
  agentName?: string;
};

type LoginItemApp = {
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void;
};

export type PreferencesService = {
  get: () => Promise<HatchPreferences>;
  setOpenAtLogin: (openAtLogin: boolean) => Promise<HatchPreferences>;
  setAgent: (agentName: string) => Promise<HatchPreferences>;
  apply: () => Promise<HatchPreferences>;
};

type CreatePreferencesServiceOptions = {
  userDataDir: string;
  app: LoginItemApp;
  defaultOpenAtLogin?: boolean;
  allowOpenAtLogin?: boolean;
};

export function createPreferencesService({
  userDataDir,
  app,
  defaultOpenAtLogin = true,
  allowOpenAtLogin = true,
}: CreatePreferencesServiceOptions): PreferencesService {
  const filePath = join(userDataDir, "preferences.json");

  function normalizePreferences(preferences: HatchPreferences): HatchPreferences {
    const agentName = preferences.agentName?.trim();
    return {
      openAtLogin: allowOpenAtLogin && preferences.openAtLogin,
      ...(agentName ? { agentName } : {}),
    };
  }

  function applyLoginItemSettings(preferences: HatchPreferences): void {
    if (!allowOpenAtLogin) return;
    app.setLoginItemSettings({ openAtLogin: preferences.openAtLogin });
  }

  async function readPreferences(): Promise<HatchPreferences> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<HatchPreferences>;
      return normalizePreferences({ openAtLogin: parsed.openAtLogin ?? defaultOpenAtLogin, agentName: parsed.agentName });
    } catch {
      return normalizePreferences({ openAtLogin: defaultOpenAtLogin });
    }
  }

  async function writePreferences(preferences: HatchPreferences): Promise<HatchPreferences> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(preferences, null, 2)}\n`);
    return preferences;
  }

  return {
    get: readPreferences,
    async setOpenAtLogin(openAtLogin) {
      const current = await readPreferences();
      const preferences = await writePreferences(normalizePreferences({ ...current, openAtLogin }));
      applyLoginItemSettings(preferences);
      return preferences;
    },
    async setAgent(agentName) {
      const current = await readPreferences();
      return writePreferences(normalizePreferences({ ...current, agentName }));
    },
    async apply() {
      const preferences = await readPreferences();
      applyLoginItemSettings(preferences);
      return preferences;
    },
  };
}
