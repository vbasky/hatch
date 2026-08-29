import type { RefreshableHatchWidget } from "@hatch/contracts";
import { CommandCodeQuotaView } from "./components";
import { refreshView } from "./store";

export const commandCodeQuotaWidget: RefreshableHatchWidget = {
  id: "command-code-quota",
  title: "COMMAND · MONTHLY",
  viewRefreshIntervalMs: 300_000,
  refreshView,
  render: () => <CommandCodeQuotaView />,
};
