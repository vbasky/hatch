import { useEffect } from "react";
import { Field, Switch } from "@hatch/ui";
import { hydrateAppearance, setFollowSystem, useAppearance } from "./store";

export function AppearanceSettingsView() {
  const { followSystem, ready } = useAppearance();
  useEffect(() => {
    void hydrateAppearance();
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <Field label="system theme" hint="follow system light and dark">
        <Switch
          checked={followSystem}
          disabled={!ready}
          onCheckedChange={(checked) => void setFollowSystem(Boolean(checked))}
        />
      </Field>
    </div>
  );
}
