import type { RefreshableHatchWidget } from "@hatch/contracts";
import { GitCommitsView } from "./components";
import { refreshView } from "./store";

export const gitCommitsWidget: RefreshableHatchWidget = {
  id: "git-commits",
  title: "GIT · 1Y",
  refreshView,
  render: () => <GitCommitsView />,
};
