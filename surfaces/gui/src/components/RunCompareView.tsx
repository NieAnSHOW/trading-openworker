/**
 * RunCompare — side-by-side backtest comparison: equity overlay + metrics table.
 * Ported from Vibe-Trading frontend/src/pages/Compare.tsx (theme-token styling,
 * Icon set instead of lucide).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { getRun, listRuns, type EquityPoint, type RunListItem } from "../api";
import { getChartTheme } from "../lib/chart-theme";
import { echarts, CHART_GROUP, connectCharts, type TooltipParam } from "../lib/echarts";
import { useDarkMode } from "../hooks/useDarkMode";
import { SkeletonChart, SkeletonMetrics } from "./common/Skeleton";
import { ViewHeader } from "./research/shared";
import { Icon } from "./Icon";

interface MetricDef {
  key: string;
  labelKey: string;
  type: "pct" | "num" | "int" | "days";
  higherIsBetter: boolean;
}

function fmt(v: unknown, type: "pct" | "num" | "int" | "days" = "num"): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (type === "pct") return (n * 100).toFixed(2) + "%";
  if (type === "int") return n.toFixed(0);
  if (type === "days") return n.toFixed(1);
  return n.toFixed(3);
}

function diffClass(a: unknown, b: unknown, higherIsBetter: boolean): string {
  const na = Number(a), nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return "";
  const better = higherIsBetter ? nb > na : nb < na;
  const worse = higherIsBetter ? nb < na : nb > na;
  return better ? "text-emerald-600 dark:text-emerald-400" : worse ? "text-red-600 dark:text-red-400" : "";
}

function diffStr(a: unknown, b: unknown, type: "pct" | "num" | "int" | "days"): string {
  const na = Number(a), nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return "—";
  const d = nb - na;
  return (d > 0 ? "+" : "") + fmt(d, type);
}

function truncatePrompt(prompt: string | undefined, maxLen = 40): string {
  if (!prompt) return "";
  const trimmed = prompt.replace(/\n/g, " ").trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
}

function runLabel(r: RunListItem): string {
  const summary = truncatePrompt(r.prompt);
  if (summary) return summary;
  return r.run_id;
}

const METRICS: MetricDef[] = [
  { key: "total_return",           labelKey: "compare.totalReturn",         type: "pct", higherIsBetter: true },
  { key: "annualized_return",      labelKey: "compare.annualizedReturn",    type: "pct", higherIsBetter: true },
  { key: "sharpe",                 labelKey: "compare.sharpeRatio",         type: "num", higherIsBetter: true },
  { key: "calmar_ratio",           labelKey: "compare.calmarRatio",         type: "num", higherIsBetter: true },
  { key: "sortino_ratio",          labelKey: "compare.sortinoRatio",        type: "num", higherIsBetter: true },
  { key: "max_drawdown",           labelKey: "compare.maxDrawdown",         type: "pct", higherIsBetter: false },
  { key: "volatility",             labelKey: "compare.volatility",           type: "pct", higherIsBetter: false },
  { key: "win_rate",               labelKey: "compare.winRate",             type: "pct", higherIsBetter: true },
  { key: "profit_factor",          labelKey: "compare.profitFactor",        type: "num", higherIsBetter: true },
  { key: "avg_win",                labelKey: "compare.avgWin",              type: "pct", higherIsBetter: true },
  { key: "avg_loss",               labelKey: "compare.avgLoss",             type: "pct", higherIsBetter: false },
  { key: "trade_count",            labelKey: "compare.trades",               type: "int", higherIsBetter: true },
  { key: "max_consecutive_losses", labelKey: "compare.maxConsecLosses",   type: "int", higherIsBetter: false },
  { key: "exposure_time",          labelKey: "compare.exposureTime",        type: "pct", higherIsBetter: true },
  { key: "avg_holding_period",     labelKey: "compare.avgHoldingPeriod",   type: "days", higherIsBetter: false },
];

// Also accept backend aliases
const METRIC_ALIASES: Record<string, string> = {
  annual_return: "annualized_return",
  calmar: "calmar_ratio",
  sortino: "sortino_ratio",
  profit_loss_ratio: "profit_factor",
  max_consec_loss: "max_consecutive_losses",
  max_consecutive_loss: "max_consecutive_losses",
  avg_hold_days: "avg_holding_period",
  avg_holding_days: "avg_holding_period",
};

function resolveMetric(metrics: Record<string, number> | null, key: string): number | undefined {
  if (!metrics) return undefined;
  if (metrics[key] !== undefined) return metrics[key];
  for (const [alias, canonical] of Object.entries(METRIC_ALIASES)) {
    if (canonical === key && metrics[alias] !== undefined) return metrics[alias];
  }
  return undefined;
}

interface EquityChartOverlayProps {
  leftCurve: EquityPoint[];
  rightCurve: EquityPoint[];
  leftLabel: string;
  rightLabel: string;
}

function EquityChartOverlay({ leftCurve, rightCurve, leftLabel, rightLabel }: EquityChartOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { dark } = useDarkMode();

  useEffect(() => {
    if (!ref.current) return;
    if (leftCurve.length === 0 && rightCurve.length === 0) return;

    const t = getChartTheme();
    const chart = echarts.init(ref.current);
    chart.group = CHART_GROUP;
    connectCharts();

    // Merge dates from both curves and sort
    const dateSet = new Set<string>();
    for (const p of leftCurve) dateSet.add(p.time);
    for (const p of rightCurve) dateSet.add(p.time);
    const dates = Array.from(dateSet).sort();

    // Build lookup maps
    const leftMap = new Map(leftCurve.map((p) => [p.time, Number(p.equity)]));
    const rightMap = new Map(rightCurve.map((p) => [p.time, Number(p.equity)]));

    const leftData = dates.map((d) => leftMap.get(d) ?? null);
    const rightData = dates.map((d) => rightMap.get(d) ?? null);

    const PRIMARY_COLOR = getComputedStyle(document.documentElement).getPropertyValue("--chart-compare-a").trim() || "#3b82f6";
    const SECONDARY_COLOR = getComputedStyle(document.documentElement).getPropertyValue("--chart-compare-b").trim() || "#f59e0b";

    chart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        backgroundColor: t.tooltipBg,
        borderColor: t.tooltipBorder,
        textStyle: { color: t.tooltipText, fontSize: 11 },
        formatter: (params: TooltipParam[] | TooltipParam) => {
          const list = Array.isArray(params) ? params : [params];
          if (list.length === 0) return "";
          let html = `<b>${list[0].axisValue}</b>`;
          for (const p of list) {
            if (p.value == null) continue;
            html += `<br/>${p.marker ?? ""} ${p.seriesName}: <b>${Number(p.value).toLocaleString()}</b>`;
          }
          return html;
        },
      },
      legend: {
        data: [leftLabel, rightLabel],
        textStyle: { color: t.textColor, fontSize: 11 },
        right: 8,
        top: 4,
      },
      grid: { left: 8, right: 8, top: 36, bottom: 40, containLabel: true },
      xAxis: {
        type: "category",
        data: dates,
        axisLine: { lineStyle: { color: t.axisColor } },
        axisLabel: { color: t.textColor, fontSize: 10 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: t.gridColor } },
        axisLabel: { color: t.textColor, fontSize: 10 },
      },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 20, bottom: 4 }],
      series: [
        {
          name: leftLabel,
          type: "line",
          data: leftData,
          smooth: false,
          symbol: "none",
          lineStyle: { color: PRIMARY_COLOR, width: 2 },
          connectNulls: true,
        },
        {
          name: rightLabel,
          type: "line",
          data: rightData,
          smooth: false,
          symbol: "none",
          lineStyle: { color: SECONDARY_COLOR, width: 2 },
          connectNulls: true,
        },
      ],
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current!);
    return () => { ro.disconnect(); chart.dispose(); };
  }, [leftCurve, rightCurve, leftLabel, rightLabel, dark]);

  if (leftCurve.length === 0 && rightCurve.length === 0) return null;

  return <div ref={ref} style={{ height: 320 }} />;
}

export function RunCompareView() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [leftData, setLeftData] = useState<Record<string, number> | null>(null);
  const [rightData, setRightData] = useState<Record<string, number> | null>(null);
  const [leftCurve, setLeftCurve] = useState<EquityPoint[]>([]);
  const [rightCurve, setRightCurve] = useState<EquityPoint[]>([]);
  const [leftLoading, setLeftLoading] = useState(false);
  const [rightLoading, setRightLoading] = useState(false);

  useEffect(() => {
    listRuns().then((items) => {
      setRuns(Array.isArray(items) ? items : []);
      if (items.length >= 2) { setLeftId(items[1].run_id); setRightId(items[0].run_id); }
      else if (items.length === 1) { setLeftId(items[0].run_id); }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (leftId) {
      setLeftLoading(true);
      getRun(leftId).then((d) => {
        setLeftData(d.metrics || null);
        setLeftCurve(d.equity_curve || []);
      }).catch(() => { setLeftData(null); setLeftCurve([]); })
        .finally(() => setLeftLoading(false));
    } else {
      setLeftData(null);
      setLeftCurve([]);
    }
  }, [leftId]);

  useEffect(() => {
    if (rightId) {
      setRightLoading(true);
      getRun(rightId).then((d) => {
        setRightData(d.metrics || null);
        setRightCurve(d.equity_curve || []);
      }).catch(() => { setRightData(null); setRightCurve([]); })
        .finally(() => setRightLoading(false));
    } else {
      setRightData(null);
      setRightCurve([]);
    }
  }, [rightId]);

  const leftRun = runs.find((r) => r.run_id === leftId);
  const rightRun = runs.find((r) => r.run_id === rightId);
  const loading = leftLoading || rightLoading;
  const hasData = Boolean(leftData || rightData);
  const selectCls =
    "w-full px-3 py-2 rounded-lg border border-line bg-panel text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/30";

  return (
    <div className="w-full p-4 md:p-6 space-y-6 overflow-y-auto max-w-5xl">
      <ViewHeader kicker="Backtest" title={t("compare.title")} />

      {/* Selectors */}
      <div className="flex gap-4 items-end">
        <div className="flex-1">
          <label className="text-xs text-muted block mb-1">{t("compare.baseline")}</label>
          <select value={leftId} onChange={(e) => setLeftId(e.target.value)} className={selectCls} title={leftRun?.prompt || leftId}>
            <option value="">{t("compare.select")}</option>
            {runs.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)} ({r.status})</option>)}
          </select>
        </div>
        <span className="text-muted mb-2 shrink-0"><Icon name="arrowRight" size={18} /></span>
        <div className="flex-1">
          <label className="text-xs text-muted block mb-1">{t("compare.compare")}</label>
          <select value={rightId} onChange={(e) => setRightId(e.target.value)} className={selectCls} title={rightRun?.prompt || rightId}>
            <option value="">{t("compare.select")}</option>
            {runs.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)} ({r.status})</option>)}
          </select>
        </div>
      </div>

      {/* Loading state — skeletons while a selected run's data is in flight */}
      {loading && !hasData && (
        <div className="space-y-6">
          <div className="border border-line rounded-lg bg-panel">
            <header className="px-3 py-2 border-b border-line">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t("compare.equityDrawdown")}</h2>
            </header>
            <div className="p-3">
              <SkeletonChart height={320} />
            </div>
          </div>
          <div className="border border-line rounded-lg bg-panel">
            <SkeletonMetrics />
          </div>
        </div>
      )}

      {/* Equity curve overlay */}
      {(leftCurve.length > 0 || rightCurve.length > 0) && (
        <div className="border border-line rounded-lg bg-panel">
          <header className="px-3 py-2 border-b border-line">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t("compare.equityDrawdown")}</h2>
          </header>
          <div className="p-3">
            <EquityChartOverlay
              leftCurve={leftCurve}
              rightCurve={rightCurve}
              leftLabel={leftRun ? truncatePrompt(leftRun.prompt, 20) || "Baseline" : "Baseline"}
              rightLabel={rightRun ? truncatePrompt(rightRun.prompt, 20) || "Compare" : "Compare"}
            />
          </div>
        </div>
      )}

      {/* Metrics table */}
      {(leftData || rightData) && (
        <div className="border border-line rounded-lg bg-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="text-left px-4 py-2.5 text-muted font-medium">{t("compare.metric")}</th>
                <th className="text-right px-4 py-2.5 text-muted font-medium">{t("compare.baselineCol")}</th>
                <th className="text-right px-4 py-2.5 text-muted font-medium">{t("compare.compareCol")}</th>
                <th className="text-right px-4 py-2.5 text-muted font-medium">{t("compare.delta")}</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map(({ key, labelKey, type, higherIsBetter }) => {
                const lv = resolveMetric(leftData, key);
                const rv = resolveMetric(rightData, key);
                return (
                  <tr key={key} className="border-b border-line last:border-0 hover:bg-paper">
                    <td className="px-4 py-2.5 font-medium">{t(labelKey)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{fmt(lv, type)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{fmt(rv, type)}</td>
                    <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums font-semibold", diffClass(lv, rv, higherIsBetter))}>{diffStr(lv, rv, type)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!hasData && !loading && (
        <div className="text-center py-16 text-muted">
          <span className="inline-block opacity-20"><Icon name="compare" size={44} /></span>
          <p className="text-sm mt-3">{t("compare.selectTwoRuns")}</p>
        </div>
      )}
    </div>
  );
}
