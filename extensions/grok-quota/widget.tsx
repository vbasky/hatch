import type { RefreshableHatchWidget } from "@hatch/contracts";
import { GrokQuotaView } from "./components";
import { refreshView } from "./store";

export const grokQuotaWidget: RefreshableHatchWidget = {
  id: "grok-quota",
  title: "GROK · WEEKLY",
  viewRefreshIntervalMs: 300_000,
  refreshView,
  render: () => <GrokQuotaView />,
};
