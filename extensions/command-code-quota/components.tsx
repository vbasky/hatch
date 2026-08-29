import { Button, Progress, StatusDot } from "@hatch/ui";
import {
  refreshView,
  useCommandCodeQuota,
  type CommandCodeQuotaData,
  type CommandCodeQuotaFailureKind,
} from "./store";

const FAILURE_COPY: Record<CommandCodeQuotaFailureKind, string> = {
  auth_required: "run cmd login",
  auth_source_missing: "command code auth file not found",
  auth_source_unreadable: "could not read command code auth file",
  auth_source_malformed: "command code auth file is not valid json",
  auth_source_incompatible: "no command code api key",
  credential_rejected: "command code rejected this key",
  connectivity: "could not reach command code usage",
  rate_limited: "command code rate limited; retry later",
  quota_service: "command code usage service error",
  parse_incompatible: "could not parse command code usage",
};

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatCredits(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function formatReset(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const ms = at - Date.now();
  if (ms <= 0) return "reset due";
  const hours = ms / 3_600_000;
  if (hours < 24) return `resets in ${Math.max(1, Math.round(hours))}h`;
  return `resets in ${Math.max(1, Math.round(hours / 24))}d`;
}

function formatChecked(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function remainingTone(percentRemaining: number): "live" | "warn" | "danger" {
  if (percentRemaining <= 10) return "danger";
  if (percentRemaining <= 25) return "warn";
  return "live";
}

function SuccessBody({ data, pending }: { data: CommandCodeQuotaData; pending: boolean }) {
  const monthly = data.windows.find((row) => row.id === "monthly");
  const others = data.windows.filter((row) => row.id !== "monthly");
  const remaining = monthly?.percentRemaining;
  const used = monthly?.percentUsed;
  const tone = remaining == null ? "live" : remainingTone(remaining);
  const reset = monthly?.resetsAt ? formatReset(monthly.resetsAt) : "";
  return (
    <>
      <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
        <span>command · monthly</span>
        <span className="flex items-center gap-1.5">
          {pending ? (
            <span className="text-ink-muted">updating</span>
          ) : data.stale ? (
            <span className="flex items-center gap-1.5 text-signal-warn">
              <StatusDot tone="warn" />
              stale
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-signal-live">
              <StatusDot tone="live" />
              {data.login ?? "live"}
            </span>
          )}
        </span>
      </div>
      {remaining != null && used != null ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <span className="text-2xl font-light tracking-value text-ink-strong">
              {formatPercent(remaining)}
              <span className="ml-0.5 text-sm text-ink-soft">% left</span>
            </span>
            <span className="text-sm text-ink-muted">{formatPercent(used)}% used</span>
          </div>
          <Progress value={remaining} tone={tone} />
        </>
      ) : data.remainingCredits != null ? (
        <span className="text-2xl font-light tracking-value text-ink-strong">
          {formatCredits(data.remainingCredits)}
          <span className="ml-1 text-sm text-ink-soft">credits left</span>
        </span>
      ) : (
        <span className="text-2xl font-light tracking-value text-ink-soft">—</span>
      )}
      <div className="text-xxs uppercase tracking-caps text-ink-label">
        {reset || (data.remainingCredits != null && remaining != null
          ? `${formatCredits(data.remainingCredits)} credits left`
          : "no reset reported")}
      </div>
      {others.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {others.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-ink">{row.label.toLowerCase()}</span>
              <span className="shrink-0 text-ink-muted">
                {formatPercent(row.percentRemaining)}% left
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function CommandCodeQuotaView() {
  const { pending, result } = useCommandCodeQuota();
  return (
    <div className="flex flex-col gap-1">
      {!result ? (
        <>
          <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
            <span>command · monthly</span>
            <span className="text-ink-muted">{pending ? "updating" : "checking"}</span>
          </div>
          <span className="text-2xl font-light tracking-value text-ink-soft">—</span>
          <Progress value={0} />
        </>
      ) : null}
      {result?.ok ? <SuccessBody data={result.data} pending={pending} /> : null}
      {result && !result.ok ? (
        <>
          <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
            <span>command · monthly</span>
          </div>
          <p className="text-sm text-ink">{FAILURE_COPY[result.kind]}</p>
        </>
      ) : null}
      <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
        <span>{result?.checkedAt ? `checked ${formatChecked(result.checkedAt)}` : "checking"}</span>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void refreshView()}>
          refresh
        </Button>
      </div>
    </div>
  );
}
