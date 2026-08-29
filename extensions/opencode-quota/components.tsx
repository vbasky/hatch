import { Button, Progress, StatusDot } from "@hatch/ui";
import {
  refreshView,
  useOpenCodeQuota,
  type OpenCodeQuotaData,
  type OpenCodeQuotaFailureKind,
} from "./store";

const FAILURE_COPY: Record<OpenCodeQuotaFailureKind, string> = {
  auth_required: "connect opencode go in opencode",
  auth_source_missing: "opencode auth file not found",
  auth_source_unreadable: "could not read opencode auth file",
  auth_source_malformed: "opencode auth file is not valid json",
  auth_source_incompatible: "no opencode go key in auth file",
  credential_rejected: "opencode rejected this go key",
  subscription_required: "opencode go subscription required",
  connectivity: "could not reach opencode usage",
  rate_limited: "opencode usage rate limited; retry later",
  quota_service: "opencode usage service error",
  parse_incompatible: "could not parse opencode usage",
};

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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

function SuccessBody({ data, pending }: { data: OpenCodeQuotaData; pending: boolean }) {
  const monthly = data.windows.find((row) => row.id === "monthly");
  const others = data.windows.filter((row) => row.id !== "monthly");
  const remaining = monthly?.percentRemaining ?? 0;
  const used = monthly?.percentUsed ?? 0;
  const tone =
    monthly?.status === "rate-limited" ? "danger" : remainingTone(remaining);
  const reset = monthly?.resetsAt ? formatReset(monthly.resetsAt) : "";
  return (
    <>
      <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
        <span>opencode · monthly</span>
        <span className="flex items-center gap-1.5">
          {pending ? (
            <span className="text-ink-muted">updating</span>
          ) : data.stale ? (
            <span className="flex items-center gap-1.5 text-signal-warn">
              <StatusDot tone="warn" />
              stale
            </span>
          ) : monthly?.status === "rate-limited" ? (
            <span className="flex items-center gap-1.5 text-signal-danger">
              <StatusDot tone="danger" />
              limited
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-signal-live">
              <StatusDot tone="live" />
              live
            </span>
          )}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-light tracking-value text-ink-strong">
          {formatPercent(remaining)}
          <span className="ml-0.5 text-sm text-ink-soft">% left</span>
        </span>
        <span className="text-sm text-ink-muted">{formatPercent(used)}% used</span>
      </div>
      <Progress value={remaining} tone={tone} />
      <div className="text-xxs uppercase tracking-caps text-ink-label">
        {reset || "no reset reported"}
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

export function OpenCodeQuotaView() {
  const { pending, result } = useOpenCodeQuota();
  return (
    <div className="flex flex-col gap-1">
      {!result ? (
        <>
          <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
            <span>opencode · monthly</span>
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
            <span>opencode · monthly</span>
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
