import type { HatchSettingsSection, HatchWidget } from "@hatch/contracts";
import { AppearanceSettingsView } from "./components";

export const appearanceWidget: HatchWidget = {
  id: "appearance",
  title: "APPEARANCE",
  render: () => null,
};

export const appearanceSettings: HatchSettingsSection = {
  extensionId: "appearance",
  title: "APPEARANCE",
  render: () => <AppearanceSettingsView />,
};
