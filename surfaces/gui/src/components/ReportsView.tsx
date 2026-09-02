/**
 * Reports — backtest run library (list / filter / sort / summary).
 * Ported from Vibe-Trading frontend/src/pages/Reports.tsx. Differences from
 * upstream: no react-router (detail + compare open via view-state callbacks),
 * theme-token styling, Icon set instead of lucide.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { listRuns, type RunListItem } from "../api";
import { formatMetricVal } from "../lib/formatters";
import { Icon } from "./Icon";
import { Spinner, ViewHeader, btnGhost, panel, panelHead, panelLabel } from "./research/shared";

const REPORT_SCAN_LIMIT = 100;

type SortMode = "created_desc" | "created_asc" | "return_desc" | "sharpe_desc";

function isSuccessfulRun(status: string | undefined): boolean {
  return ["success", "done", "completed", "complete"].includes((status || "").toLowerCase());
}

function isBacktestReportRun(run: RunListItem): boolean {
  return Number.isFinite(run.total_return) || Number.isFinite(run.sharpe);
}

function metric(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : Number.NEGATIVE_INFINITY;
}

function averageMetric(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatOptionalMetric(key: string, value: number | undefined): string {
  return Number.isFinite(value) ? formatMetricVal(key, value as number) : "-";
}

function dateMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRuns(left: RunListItem, right: RunListItem, mode: SortMode): number {
  if (mode === "created_asc") return dateMs(left.created_at) - dateMs(right.created_at);
  if (mode === "return_desc") return metric(right.total_return) - metric(left.total_return);
  if (mode === "sharpe_desc") return metric(right.sharpe) - metric(left.sharpe);
  return dateMs(right.created_at) - dateMs(left.created_at);
}

function formatRunDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value || "unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function StatusBadge({ status }: { status: string }) {
  const ok = isSuccessfulRun(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
        ok ? "bg-ok/10 text-ok" : "bg-paper text-muted",
      )}
    >
      <Icon name={ok ? "checkCircle" : "xCircle"} size={12} />
      {status || "unknown"}
    </span>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-3 py-1.5">
      <div className={panelLabel}>{label}</div>
      <div className="font-mono tabular-nums text-sm font-medium">{value}</div>
    </div>
  );
}

function OverviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-mono tabular-nums mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function ReportRow({
  run,
  onOpenDetail,
  onOpenCompare,
}: {
  run: RunListItem;
  onOpenDetail: (runId: string) => void;
  onOpenCompare: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className={panel + " transition hover:border-accent/40 hover:bg-paper"}>
      <header className={panelHead}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <button
            type="button"
            onClick={() => onOpenDetail(run.run_id)}
            className="truncate font-mono text-sm font-medium hover:text-accent"
          >
            {run.run_id}
          </button>
          <span className="text-xs text-muted">{formatRunDate(run.created_at)}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <MetricPill label={t("reports.return")} value={formatOptionalMetric("total_return", run.total_return)} />
          <MetricPill label={t("reports.sharpe")} value={formatOptionalMetric("sharpe", run.sharpe)} />
        </div>
      </header>
      <div className="px-3 py-2.5 space-y-2">
        <p className="line-clamp-2 text-sm text-muted">{run.prompt || t("reports.noPrompt")}</p>
        <div className="flex flex-wrap gap-1.5">
          {(run.codes || []).slice(0, 6).map((code) => (
            <span key={code} className="rounded border border-line px-2 py-0.5 font-mono text-xs text-muted">
              {code}
            </span>
          ))}
          {run.start_date || run.end_date ? (
            <span className="rounded border border-line px-2 py-0.5 text-xs text-muted">
              {run.start_date || "?"} {t("reports.to")} {run.end_date || "?"}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenDetail(run.run_id)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90"
          >
            {t("reports.fullReport")} <Icon name="arrowRight" size={14} />
          </button>
          <button type="button" onClick={onOpenCompare} className={btnGhost}>
            <Icon name="compare" size={14} />
            {t("reports.compare")}
          </button>
        </div>
      </div>
    </article>
  );
}

export type ReportsSubView =
  | { kind: "list" }
  | { kind: "detail"; runId: string }
  | { kind: "compare" };

export function ReportsListView({
  onOpenDetail,
  onOpenCompare,
}: {
  onOpenDetail: (runId: string) => void;
  onOpenCompare: () => void;
}) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("created_desc");
  const [error, setError] = useState<string | null>(null);

  async function loadReports(mode: "initial" | "refresh" = "refresh") {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const list = await listRuns(undefined, REPORT_SCAN_LIMIT);
      setRuns(Array.isArray(list) ? list.filter(isBacktestReportRun) : []);
    } catch (err) {
      setRuns([]);
      setError(err instanceof Error ? err.message : t("reports.loadError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadReports("initial");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusOptions = useMemo(() => {
    const values = Array.from(new Set(runs.map((run) => run.status || "unknown"))).sort();
    return ["all", ...values];
  }, [runs]);

  const reportSummary = useMemo(() => {
    const completed = runs.filter((run) => isSuccessfulRun(run.status));
    const returns = runs
      .map((run) => run.total_return)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const sharpes = runs
      .map((run) => run.sharpe)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    return {
      total: runs.length,
      completed: completed.length,
      averageReturn: averageMetric(returns),
      averageSharpe: averageMetric(sharpes),
    };
  }, [runs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const startMs = startDate ? Date.parse(startDate) : Number.NEGATIVE_INFINITY;
    const endMs = endDate ? Date.parse(`${endDate}T23:59:59`) : Number.POSITIVE_INFINITY;

    return [...runs]
      .filter((run) => {
        if (statusFilter !== "all" && (run.status || "unknown") !== statusFilter) return false;
        const created = Date.parse(run.created_at);
        if (Number.isFinite(created) && (created < startMs || created > endMs)) return false;
        if (!needle) return true;
        const haystack = [
          run.run_id,
          run.status,
          run.prompt,
          ...(run.codes || []),
          run.start_date,
          run.end_date,
        ].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(needle);
      })
      .sort((left, right) => compareRuns(left, right, sortMode));
  }, [runs, query, statusFilter, startDate, endDate, sortMode]);

  function clearFilters() {
    setQuery("");
    setStatusFilter("all");
    setStartDate("");
    setEndDate("");
    setSortMode("created_desc");
  }

  const inputCls =
    "w-full px-3 py-2 rounded-lg border border-line bg-panel text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/30";

  return (
    <div className="w-full p-4 md:p-6 space-y-4 overflow-y-auto flex flex-col min-h-0">
      <ViewHeader
        kicker="Reports"
        title={t("reports.title")}
        sub={t("reports.subtitle")}
        actions={
          <button type="button" onClick={() => void loadReports("refresh")} disabled={refreshing} className={btnGhost}>
            {refreshing ? <Spinner /> : <Icon name="refresh" size={14} />}
            {t("reports.refresh")}
          </button>
        }
      />

      <section aria-labelledby="reports-overview-title" className={panel}>
        <header className={panelHead}>
          <h2 id="reports-overview-title" className={panelLabel}>
            {t("reports.overview")}
          </h2>
        </header>
        <div className="p-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <OverviewMetric label={t("reports.badge")} value={String(reportSummary.total)} />
          <OverviewMetric label={t("reports.success")} value={String(reportSummary.completed)} />
          <OverviewMetric
            label={t("reports.return")}
            value={formatOptionalMetric("total_return", reportSummary.averageReturn)}
          />
          <OverviewMetric
            label={t("reports.sharpe")}
            value={formatOptionalMetric("sharpe", reportSummary.averageSharpe)}
          />
        </div>
      </section>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)]">
        <aside aria-labelledby="reports-filters-title" className={panel + " lg:overflow-auto"}>
          <header className={panelHead}>
            <div className="flex min-w-0 items-baseline gap-3">
              <h2 id="reports-filters-title" className={panelLabel}>
                {t("reports.filters")}
              </h2>
              <p className="font-mono text-xs text-muted">
                {t("reports.count", { shown: filtered.length, total: runs.length })}
              </p>
            </div>
          </header>

          <div className="p-3 space-y-3">
            <label className="relative block">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                <Icon name="search" size={14} />
              </span>
              <span className="sr-only">{t("reports.searchPlaceholder")}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("reports.searchPlaceholder")}
                className={inputCls + " pl-8"}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted">{t("reports.allStatuses")}</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className={inputCls}
              >
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status === "all" ? t("reports.allStatuses") : status}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-xs text-muted">{t("reports.startDate")}</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  aria-label={t("reports.startDate")}
                  className={inputCls}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted">{t("reports.endDate")}</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  aria-label={t("reports.endDate")}
                  className={inputCls}
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-muted">{t("reports.sort")}</span>
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                aria-label={t("reports.sort")}
                className={inputCls}
              >
                <option value="created_desc">{t("reports.sortNewest")}</option>
                <option value="created_asc">{t("reports.sortOldest")}</option>
                <option value="return_desc">{t("reports.sortReturn")}</option>
                <option value="sharpe_desc">{t("reports.sortSharpe")}</option>
              </select>
            </label>
          </div>
        </aside>

        <section
          aria-labelledby="reports-results-title"
          className={panel + " min-h-0 lg:overflow-auto"}
        >
          <header className={panelHead}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-accent shrink-0">
                <Icon name="file" size={14} />
              </span>
              <h2 id="reports-results-title" className={panelLabel}>
                {t("reports.results")}
              </h2>
            </div>
            {refreshing ? <Spinner className="text-muted" /> : null}
          </header>

          <div className="p-3">
          {loading ? (
            <div className="grid gap-2">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="h-28 animate-pulse rounded-md bg-paper" />
              ))}
            </div>
          ) : null}

          {!loading && error ? (
            <div className="rounded-md border border-warnInk/30 bg-warnSoft/40 p-4">
              <div className="flex items-center gap-2 font-medium text-warnInk">
                <Icon name="warning" size={14} />
                {t("reports.unavailable")}
              </div>
              <p className="mt-2 text-sm text-muted">{error}</p>
            </div>
          ) : null}

          {!loading && !error && filtered.length === 0 ? (
            <div className="flex min-h-60 flex-col items-center justify-center rounded-md bg-paper p-4 text-center">
              <span className="text-muted">
                <Icon name="file" size={28} />
              </span>
              <h2 className="mt-3 font-medium">
                {runs.length === 0 ? t("reports.emptyTitle") : t("reports.noMatchesTitle")}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {runs.length === 0 ? t("reports.emptyBody") : t("reports.noMatchesBody")}
              </p>
              {runs.length > 0 ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="mt-3 text-xs font-medium text-accent underline-offset-4 hover:underline"
                >
                  {t("reports.clearFilters")}
                </button>
              ) : null}
            </div>
          ) : null}

          {!loading && !error && filtered.length > 0 ? (
            <div className="space-y-2">
              {filtered.map((run) => (
                <ReportRow key={run.run_id} run={run} onOpenDetail={onOpenDetail} onOpenCompare={onOpenCompare} />
              ))}
            </div>
          ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
