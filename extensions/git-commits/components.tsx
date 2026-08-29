import { Button, Sparkline, StatusDot } from "@hatch/ui";
import { refreshView, useGitCommits, type GitCommitsData, type GitCommitsFailureKind } from "./store";

const FAILURE_COPY: Record<GitCommitsFailureKind, string> = {
  auth_required: "run gh auth login",
  cli_not_found: "github cli not found",
  cli_launch_failed: "could not launch gh",
  connectivity: "could not reach github",
  rate_limited: "github rate limited; retry later",
  parse_incompatible: "could not parse commit search",
  unavailable: "github source unavailable",
};

const CELL = [
  "h-2 w-full min-w-0 rounded-xs bg-pressed",
  "h-2 w-full min-w-0 rounded-xs bg-signal-live/25",
  "h-2 w-full min-w-0 rounded-xs bg-signal-live/45",
  "h-2 w-full min-w-0 rounded-xs bg-signal-live/70",
  "h-2 w-full min-w-0 rounded-xs bg-signal-live",
] as const;

function formatChecked(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function level(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const q = count / max;
  if (q > 0.75) return 4;
  if (q > 0.5) return 3;
  if (q > 0.25) return 2;
  return 1;
}

function weeksFromDays(days: GitCommitsData["days"]) {
  if (days.length === 0) return [];
  const start = new Date(`${days[0].date}T00:00:00Z`);
  const pad = start.getUTCDay();
  const padded = [...Array.from({ length: pad }, () => null), ...days];
  const weeks: Array<Array<{ date: string; count: number } | null>> = [];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7));
  }
  const last = weeks[weeks.length - 1];
  if (last && last.length < 7) {
    weeks[weeks.length - 1] = [...last, ...Array.from({ length: 7 - last.length }, () => null)];
  }
  return weeks;
}

function Heatmap({ data }: { data: GitCommitsData }) {
  const max = data.days.reduce((n, day) => Math.max(n, day.count), 0);
  const weeks = weeksFromDays(data.days);
  return (
    <div className="flex w-full min-w-0 gap-px">
      {weeks.map((week, index) => (
        <div key={index} className="flex min-w-0 flex-1 flex-col gap-px">
          {week.map((day, row) => (
            <span
              key={day?.date ?? `empty-${index}-${row}`}
              className={CELL[day ? level(day.count, max) : 0]}
              title={day ? `${day.date} · ${day.count}` : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="truncate text-ink-muted">{label}</span>
      <span className="shrink-0 text-ink">{value}</span>
    </div>
  );
}

function SuccessBody({ data, pending }: { data: GitCommitsData; pending: boolean }) {
  const stats = data.stats;
  const avg =
    stats.activeDays > 0 ? Math.round((data.total / stats.activeDays) * 10) / 10 : 0;
  const avgLabel = Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
  return (
    <>
      <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
        <span>git · 1y</span>
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
              {data.login}
            </span>
          )}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-light tracking-value text-ink-strong">
          {data.total.toLocaleString()}
          <span className="ml-1 text-sm text-ink-soft">commits</span>
        </span>
        <Sparkline data={data.sparkline} width={148} height={28} area tone="live" />
      </div>
      <Heatmap data={data} />
      {data.total > 0 ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <Stat label="active" value={`${stats.activeDays}d`} />
          <Stat label="streak" value={`${stats.currentStreak} · ${stats.longestStreak}`} />
          <Stat label="week" value={String(stats.last7)} />
          <Stat label="peak" value={String(stats.peak)} />
          <Stat label="repos" value={String(stats.repos)} />
          <Stat label="avg" value={`${avgLabel}/d`} />
          <Stat label="own" value={String(stats.own)} />
          <Stat label="other" value={String(stats.other)} />
        </div>
      ) : (
        <p className="text-sm text-ink-muted">no commits in 1y</p>
      )}
    </>
  );
}

export function GitCommitsView() {
  const { pending, result } = useGitCommits();
  return (
    <div className="flex flex-col gap-1">
      {!result ? (
        <>
          <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
            <span>git · 1y</span>
            <span className="text-ink-muted">{pending ? "updating" : "checking"}</span>
          </div>
          <span className="text-2xl font-light tracking-value text-ink-soft">—</span>
        </>
      ) : null}
      {result?.ok ? <SuccessBody data={result.data} pending={pending} /> : null}
      {result && !result.ok ? (
        <>
          <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
            <span>git · 1y</span>
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
