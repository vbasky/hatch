import { Badge, Button, Progress, StatusDot } from "@hatch/ui";
import {
  useGrokQuota,
  refreshView,
  type GrokQuotaViewState,
  type QuotaFailureKind,
} from "./store";

const FAILURE_COPY: Record<QuotaFailureKind, string> = {
  auth_required: "sign in with grok login",
  auth_expired: "grok session expired. run grok login",
  auth_scope_ambiguous: "multiple grok accounts in auth file; keep one signed-in principal",
  auth_principal_changed: "grok account changed during refresh",
  auth_source_missing: "grok auth file not found. run grok login",
  auth_source_unreadable: "could not read grok auth file",
  auth_source_malformed: "grok auth file is not valid json",
  auth_source_incompatible: "no supported grok login in auth file",
  credential_rejected: "grok rejected this session. run grok login",
  cli_not_found: "grok cli not found; install it to refresh login",
  cli_launch_failed: "could not launch grok cli to refresh login",
  connectivity: "could not reach grok usage",
  rate_limited: "grok usage rate limited; retry later",
  quota_service: "grok usage service error",
  official_quota_source_unavailable: "grok usage source unavailable",
  team_scope_unsupported: "team grok usage is not available on this surface",
  response_too_large: "grok usage response was too large",
  quota_unreported: "grok did not report usage for this period",
  parse_incompatible: "could not parse grok usage response",
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

function periodLabel(period: string): string {
  if (period === "weekly") return "weekly";
  if (period === "monthly") return "monthly";
  return "credits";
}

function remainingTone(percentRemaining: number): "live" | "warn" | "danger" {
  if (percentRemaining <= 10) return "danger";
  if (percentRemaining <= 25) return "warn";
  return "live";
}

function observabilityProps(state: GrokQuotaViewState) {
  return {
    "data-grok-e2e": state.e2e,
    "data-grok-checked-at": state.checkedAt,
    "data-grok-stale": state.stale ? "true" : "false",
    "data-grok-warning-kind": state.warningKind,
    "data-grok-failure-kind": state.failureKind,
    "data-grok-cache-schema": state.cacheSchema,
    "data-grok-source": state.source,
    "data-grok-source-version": state.sourceVersion,
    "data-grok-operation": state.operation,
    "data-grok-period": state.period,
    "data-grok-percent-used": state.percentUsed,
    "data-grok-percent-remaining": state.percentRemaining,
    "data-grok-percentage-field": state.percentageField,
    "data-grok-reset-at": state.resetAt,
    "data-grok-reset-field": state.resetField,
    "data-grok-products": JSON.stringify(state.products),
    "data-grok-completed-acquisitions": String(state.completedAcquisitions),
  };
}

function Header({
  label,
  pending,
  stale,
  live,
}: {
  label: string;
  pending: boolean;
  stale: boolean;
  live: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
      <span>grok · {label}</span>
      <span className="flex items-center gap-1.5">
        {pending ? (
          <span className="text-ink-muted">updating</span>
        ) : stale ? (
          <span className="flex items-center gap-1.5 text-signal-warn">
            <StatusDot tone="warn" />
            stale
          </span>
        ) : live ? (
          <span className="flex items-center gap-1.5 text-signal-live">
            <StatusDot tone="live" />
            live
          </span>
        ) : null}
      </span>
    </div>
  );
}

function Footer({
  checkedAt,
  pending,
}: {
  checkedAt: string;
  pending: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xxs uppercase tracking-caps text-ink-label">
      <span className="truncate">
        {checkedAt ? `checked ${formatChecked(checkedAt)}` : "checking"}
      </span>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void refreshView()}>
        refresh
      </Button>
    </div>
  );
}

function SuccessBody({ state }: { state: Extract<GrokQuotaViewState, { e2e: "success" }> }) {
  const data = state.result.data;
  const credits = data.windows.find((row) => row.id === "credits");
  const products = data.windows.filter((row) => row.id.startsWith("product:"));
  const remaining = credits?.percentRemaining ?? 0;
  const used = credits?.percentUsed ?? 0;
  const tone = remainingTone(remaining);
  const reset = credits?.resetAt ? formatReset(credits.resetAt) : "";
  return (
    <>
      <Header
        label={periodLabel(data.period.type)}
        pending={state.pending}
        stale={data.stale}
        live={!data.stale}
      />
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-light tracking-value text-ink-strong">
          {formatPercent(remaining)}
          <span className="ml-0.5 text-sm text-ink-soft">% left</span>
        </span>
        <span className="text-sm text-ink-muted">{formatPercent(used)}% used</span>
      </div>
      <Progress value={remaining} tone={tone} />
      <div className="flex justify-between text-xxs uppercase tracking-caps text-ink-label">
        <span>{reset || "no reset reported"}</span>
        {data.credits ? <span>{data.credits.remaining} extra credits</span> : <span />}
      </div>
      {products.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {products.map((product) => (
            <div key={product.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-ink">{product.label.toLowerCase()}</span>
              <span className="shrink-0 text-ink-muted">{formatPercent(product.percentUsed)}%</span>
            </div>
          ))}
        </div>
      ) : null}
      {data.stale && state.result.warning ? (
        <Badge tone="warn">{FAILURE_COPY[state.result.warning.kind]}</Badge>
      ) : null}
      <Footer checkedAt={state.checkedAt} pending={state.pending} />
    </>
  );
}

export function GrokQuotaView() {
  const state = useGrokQuota();
  return (
    <div className="flex flex-col gap-1" {...observabilityProps(state)}>
      {state.e2e === "waiting" ? (
        <>
          <Header label="weekly" pending={state.pending} stale={false} live={false} />
          <span className="text-2xl font-light tracking-value text-ink-soft">—</span>
          <Progress value={0} />
          <Footer checkedAt="" pending={state.pending} />
        </>
      ) : null}
      {state.e2e === "success" ? <SuccessBody state={state} /> : null}
      {state.e2e === "failure" ? (
        <>
          <Header label="weekly" pending={state.pending} stale={false} live={false} />
          <p className="text-sm text-ink">{FAILURE_COPY[state.failureKind]}</p>
          <Footer checkedAt={state.checkedAt} pending={state.pending} />
        </>
      ) : null}
    </div>
  );
}
