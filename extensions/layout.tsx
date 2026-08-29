import { useEffect } from "react";
import type { HatchLayoutProps } from "@hatch/contracts";
import { loadFollowSystem, watchSystemTheme } from "./appearance/theme";
import { applyDensity } from "./density";

const COMMITS_ID = "git-commits";
const HIDDEN = new Set(["appearance"]);

export default function Layout({ widgets, renderWidget }: HatchLayoutProps) {
  useEffect(() => {
    applyDensity();
    void loadFollowSystem();
    const stop = watchSystemTheme();
    return () => stop();
  }, []);

  const visible = widgets.filter((widget) => !HIDDEN.has(widget.id));
  const commits = visible.find((widget) => widget.id === COMMITS_ID);
  const rest = visible.filter((widget) => widget.id !== COMMITS_ID);

  if (!commits) {
    return (
      <div className="flex w-[504px] flex-col gap-1 p-2">
        {rest.map((widget) => (
          <div key={widget.id}>{renderWidget(widget.id)}</div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid w-[840px] grid-cols-2 gap-x-3 gap-y-1 p-2">
      <div className="flex flex-col gap-1">
        {rest.map((widget) => (
          <div key={widget.id}>{renderWidget(widget.id)}</div>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1">{renderWidget(commits.id)}</div>
    </div>
  );
}
