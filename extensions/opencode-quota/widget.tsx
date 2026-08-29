import type { RefreshableHatchWidget } from "@hatch/contracts";
import { OpenCodeQuotaView } from "./components";
import { refreshView } from "./store";

export const opencodeQuotaWidget: RefreshableHatchWidget = {
  id: "opencode-quota",
  title: "OPENCODE · MONTHLY",
  viewRefreshIntervalMs: 300_000,
  refreshView,
  render: () => <OpenCodeQuotaView />,
};
