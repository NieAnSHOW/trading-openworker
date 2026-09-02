/**
 * RunDetail — one backtest run: metrics, candlestick charts, trades, validation,
 * run card, strategy code. Ported from Vibe-Trading frontend/src/pages/RunDetail.tsx.
 * Differences from upstream: no react-router (runId + onBack are props), theme-token
 * styling, Icon set instead of lucide, no telemetry.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { cn } from "../lib/cn";
import { getRun, getRunCode, type RunCard, type RunData } from "../api";
import { CandlestickChart } from "./charts/CandlestickChart";
import { EquityChart } from "./charts/EquityChart";
import { MetricsCard } from "./research/MetricsCard";
import { LLMUsagePanel } from "./research/LLMUsagePanel";
import { ValidationPanel } from "./charts/ValidationPanel";
import { Skeleton, SkeletonMetrics, SkeletonChart } from "./common/Skeleton";
import { ErrorBoundary } from "./common/ErrorBoundary";
import { ViewHeader, Spinner } from "./research/shared";
import { Icon } from "./Icon";

type Tab = "chart" | "trades" | "runCard" | "code" | "validation";
type ChartPayload = Pick<RunData, "price_series" | "indicator_series" | "trade_markers">;
type ChartCache = Record<string, ChartPayload>;
type ChartLoadProgress = { done: number; total: number };

function downloadCsv(filename: string, csvContent: string) {
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCsvField(value: unknown): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildTradesCsv(trades: Array<Record<string, string>>): string {
  if (trades.length === 0) return "";
  const keys = [...new Set(trades.flatMap(Object.keys))];
  const header = keys.map(escapeCsvField).join(",");
  const rows = trades.map((tr) => keys.map((k) => escapeCsvField(tr[k])).join(","));
  return [header, ...rows].join("\n");
}

function buildMetricsCsv(metrics: Record<string, number>): string {
  const header = "metric,value";
  const rows = Object.entries(metrics).map(([k, v]) => `${escapeCsvField(k)},${escapeCsvField(v)}`);
  return [header, ...rows].join("\n");
}

function cacheFromRun(run: RunData | null, requestedSymbol?: string): ChartCache {
  if (!run?.price_series) return {};
  const cache: ChartCache = {};
  const markerRows = run.trade_markers || [];
  for (const [symbol, bars] of Object.entries(run.price_series)) {
    cache[symbol] = {
      price_series: { [symbol]: bars },
      indicator_series: run.indicator_series?.[symbol] ? { [symbol]: run.indicator_series[symbol] } : {},
      trade_markers: markerRows.filter((marker) => !marker.code || marker.code === symbol),
    };
  }
  if (requestedSymbol && !cache[requestedSymbol]) {
    cache[requestedSymbol] = { price_series: {}, indicator_series: {}, trade_markers: [] };
  }
  return cache;
}

function yieldToBrowser(): Promise<void> {
  // ES2020 lib target — Promise.withResolvers unavailable.
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [run, setRun] = useState<RunData | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>("chart");
  const [loading, setLoading] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [chartPickerSymbol, setChartPickerSymbol] = useState("");
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [chartCache, setChartCache] = useState<ChartCache>({});
  const [chartLoadingSymbols, setChartLoadingSymbols] = useState<Record<string, boolean>>({});
  const [bulkChartLoading, setBulkChartLoading] = useState(false);
  const [bulkChartProgress, setBulkChartProgress] = useState<ChartLoadProgress>({ done: 0, total: 0 });
  const chartCacheRef = useRef<ChartCache>({});
  const cancelBulkChartLoadRef = useRef(false);

  const hasValidation = !!run?.validation;
  const hasRunCard = !!run?.run_card;
  const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"]; hidden?: boolean }[] = [
    { id: "chart", label: t("runDetail.chart"), icon: "barChart" },
    { id: "trades", label: t("runDetail.trades"), icon: "list" },
    { id: "validation", label: t("runDetail.validation"), icon: "shield", hidden: !hasValidation },
    { id: "runCard", label: t("runDetail.runCard"), icon: "fileCheck", hidden: !hasRunCard },
    { id: "code", label: t("runDetail.code"), icon: "code" },
  ];

  useEffect(() => {
    if (!runId) return;
    Promise.all([
      getRun(runId, { chart_payload: "summary" }).catch(() => null),
      getRunCode(runId).catch(() => ({})),
    ]).then(([r, c]) => {
      setRun(r);
      setCode(c || {});
      const firstSymbol = r?.chart_symbols?.[0] || Object.keys(r?.price_series || {})[0] || "";
      setSelectedSymbol(firstSymbol);
      setChartPickerSymbol(firstSymbol);
      setSelectedSymbols(firstSymbol ? [firstSymbol] : []);
      const initialCache = cacheFromRun(r, firstSymbol);
      chartCacheRef.current = initialCache;
      setChartCache(initialCache);
      if (firstSymbol && !initialCache[firstSymbol]?.price_series?.[firstSymbol]?.length) {
        void loadChartSymbol(firstSymbol);
      }
    }).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (loading) {
    return (
      <div className="w-full p-4 md:p-6 space-y-4 overflow-y-auto">
        <Skeleton className="h-6 w-48" />
        <SkeletonMetrics />
        <SkeletonChart height={400} />
      </div>
    );
  }
  if (!run) return (
    <div className="w-full p-4 md:p-6 space-y-2 overflow-y-auto">
      <p className="text-danger font-medium">{t("runDetail.runNotFound")}</p>
      <p className="text-sm text-muted">{t("runDetail.runNotFoundDesc")}</p>
      <button
        onClick={onBack}
        className="text-sm text-accent hover:underline inline-flex items-center gap-1.5"
      >
        <Icon name="arrowLeft" size={14} /> {t("runDetail.goBack")}
      </button>
    </div>
  );

  const ok = run.status === "success";

  async function loadChartSymbol(symbol: string) {
    if (!runId || !symbol) return;
    if (chartCacheRef.current[symbol]?.price_series?.[symbol]?.length) return;
    setChartLoadingSymbols((prev) => ({ ...prev, [symbol]: true }));
    try {
      const nextRun = await getRun(runId, { chart_symbol: symbol });
      const nextCache = cacheFromRun(nextRun, symbol);
      const mergedCache = { ...chartCacheRef.current, ...nextCache };
      chartCacheRef.current = mergedCache;
      setChartCache(mergedCache);
      setRun((prev) => prev ? {
        ...prev,
        chart_symbols: nextRun.chart_symbols?.length ? nextRun.chart_symbols : prev.chart_symbols,
        equity_curve: nextRun.equity_curve?.length ? nextRun.equity_curve : prev.equity_curve,
        trade_log: nextRun.trade_log?.length ? nextRun.trade_log : prev.trade_log,
      } : nextRun);
    } finally {
      setChartLoadingSymbols((prev) => {
        const next = { ...prev };
        delete next[symbol];
        return next;
      });
    }
  }

  async function handleAddChartSymbol(symbol: string) {
    if (!symbol) return;
    setSelectedSymbol(symbol);
    setChartPickerSymbol(symbol);
    setSelectedSymbols((prev) => prev.includes(symbol) ? prev : [...prev, symbol]);
    await loadChartSymbol(symbol);
  }

  async function handleCurrentChartOnly(symbol: string) {
    if (!symbol) return;
    setSelectedSymbol(symbol);
    setChartPickerSymbol(symbol);
    setSelectedSymbols([symbol]);
    await loadChartSymbol(symbol);
  }

  function handleRemoveChartSymbol(symbol: string) {
    const nextSymbols = selectedSymbols.filter((item) => item !== symbol);
    setSelectedSymbols(nextSymbols);
    if (selectedSymbol === symbol) {
      const fallback = nextSymbols[0] || run?.chart_symbols?.[0] || "";
      setSelectedSymbol(fallback);
      setChartPickerSymbol(fallback);
    }
  }

  async function handleLoadAllChartSymbols() {
    const symbols = run?.chart_symbols || [];
    if (symbols.length === 0 || bulkChartLoading) return;
    cancelBulkChartLoadRef.current = false;
    setBulkChartLoading(true);
    setBulkChartProgress({ done: 0, total: symbols.length });
    try {
      for (let index = 0; index < symbols.length; index += 1) {
        if (cancelBulkChartLoadRef.current) break;
        const symbol = symbols[index];
        setSelectedSymbol(symbol);
        setChartPickerSymbol(symbol);
        setSelectedSymbols((prev) => prev.includes(symbol) ? prev : [...prev, symbol]);
        await loadChartSymbol(symbol);
        setBulkChartProgress({ done: index + 1, total: symbols.length });
        await yieldToBrowser();
      }
    } finally {
      setBulkChartLoading(false);
    }
  }

  function handleCancelLoadAllCharts() {
    cancelBulkChartLoadRef.current = true;
  }

  return (
    <div className="w-full p-4 md:p-6 space-y-4 overflow-y-auto flex flex-col min-h-0">
      {/* Header */}
      <ViewHeader
        kicker="Backtest"
        title={
          <span className="flex items-center gap-2.5">
            <button
              onClick={onBack}
              className="p-1 rounded-md hover:bg-chromeHover transition-colors text-muted hover:text-ink"
              title={t("runDetail.goBack")}
            >
              <Icon name="arrowLeft" size={16} />
            </button>
            <Icon name={ok ? "checkCircle" : "xCircle"} size={18} className={ok ? "text-ok" : "text-danger"} />
            <span className="font-mono text-sm font-medium">{runId}</span>
            {run.elapsed_seconds ? <span className="font-mono text-xs text-muted">{run.elapsed_seconds.toFixed(1)}s</span> : null}
          </span>
        }
        sub={run.prompt}
        actions={
          <div className="flex gap-1">
            {run.trade_log && run.trade_log.length > 0 && (
              <button
                onClick={() => downloadCsv(`trades_${runId}.csv`, buildTradesCsv(run.trade_log!))}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:bg-chromeHover"
                title={t("runDetail.downloadTradesCsv")}
              >
                <Icon name="download" size={14} /> {t("runDetail.downloadTradesCsv")}
              </button>
            )}
            {run.metrics && (
              <button
                onClick={() => downloadCsv(`metrics_${runId}.csv`, buildMetricsCsv(run.metrics!))}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:bg-chromeHover"
                title={t("runDetail.downloadMetricsCsv")}
              >
                <Icon name="download" size={14} /> {t("runDetail.downloadMetricsCsv")}
              </button>
            )}
          </div>
        }
      />
      {run.metrics && <MetricsCard metrics={run.metrics as Record<string, number>} />}
      <LLMUsagePanel usage={run.llm_usage ?? null} />

      <div className="flex items-center gap-1">
        {TABS.filter((tb) => !tb.hidden).map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
              tab === id ? "bg-accent text-white" : "text-muted hover:bg-chromeHover",
            )}
          >
            <Icon name={icon} size={14} /> {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        <ErrorBoundary>
          {tab === "chart" && (
            <ChartTab
              run={run}
              chartPickerSymbol={chartPickerSymbol}
              selectedSymbols={selectedSymbols}
              chartCache={chartCache}
              loadingSymbols={chartLoadingSymbols}
              bulkLoading={bulkChartLoading}
              bulkProgress={bulkChartProgress}
              onPickSymbol={setChartPickerSymbol}
              onAddSymbol={handleAddChartSymbol}
              onCurrentOnly={handleCurrentChartOnly}
              onRemoveSymbol={handleRemoveChartSymbol}
              onLoadAll={handleLoadAllChartSymbols}
              onCancelLoadAll={handleCancelLoadAllCharts}
            />
          )}
          {tab === "trades" && <TradesTab run={run} />}
          {tab === "validation" && run.validation && <ValidationPanel data={run.validation} />}
          {tab === "runCard" && run.run_card && <RunCardTab card={run.run_card} />}
          {tab === "code" && <CodeTab code={code} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}

function RunCardTab({ card }: { card: RunCard }) {
  const { t } = useTranslation();
  const backtest = card.backtest || {};
  const reproducibility = card.reproducibility || {};
  const metrics = card.metrics || {};
  const artifacts = card.artifacts || [];
  const warnings = card.warnings || [];
  const dataSources = card.data_sources || [];

  return (
    <div className="p-4 space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <RunCardStat label={t("runDetail.schema")} value={card.schema_version || "unknown"} />
        <RunCardStat label={t("runDetail.generated")} value={formatRunCardValue(card.generated_at)} />
        <RunCardStat label={t("runDetail.dataSources")} value={dataSources.length ? dataSources.join(", ") : "None recorded"} />
        <RunCardStat label={t("runDetail.warnings")} value={String(warnings.length)} tone={warnings.length ? "warning" : "normal"} />
      </div>

      {warnings.length > 0 && (
        <section className="border border-line rounded-lg bg-panel">
          <header className="px-3 py-2 border-b border-line">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-warnInk flex items-center gap-2">
              <Icon name="warning" size={14} />
              {t("runDetail.warnings")}
            </h2>
          </header>
          <div className="p-3">
            <ul className="space-y-1 text-xs text-muted">
              {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
            </ul>
          </div>
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <RunCardPanel title={t("runDetail.backtestSummary")} icon="database">
          <KeyValueTable data={backtest} empty={t("runDetail.noBacktestSummary")} />
        </RunCardPanel>
        <RunCardPanel title={t("runDetail.reproducibility")} icon="fingerprint">
          <KeyValueTable data={reproducibility} empty={t("runDetail.noReproducibilityHashes")} monospaceValues />
        </RunCardPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <RunCardPanel title={t("runDetail.metrics")} icon="barChart">
          <KeyValueTable data={metrics} empty={t("runDetail.noScalarMetrics")} />
        </RunCardPanel>
        <RunCardPanel title={t("runDetail.validationPayload")} icon="shield">
          {card.validation ? (
            <pre className="max-h-80 overflow-auto rounded-md bg-paper p-3 text-xs leading-relaxed">
              {JSON.stringify(card.validation, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-muted">{t("runDetail.noValidationPayload")}</p>
          )}
        </RunCardPanel>
      </div>

      <RunCardPanel title={t("runDetail.artifactChecksums")} icon="fileCheck">
        {artifacts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2 pr-4">{t("runDetail.path")}</th>
                  <th className="py-2 pr-4">{t("runDetail.size")}</th>
                  <th className="py-2">{t("runDetail.sha256")}</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact) => (
                  <tr key={`${artifact.path}-${artifact.sha256}`} className="border-b border-line last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{artifact.path}</td>
                    <td className="py-2 pr-4 font-mono tabular-nums text-muted">{formatBytes(artifact.size_bytes)}</td>
                    <td className="py-2 font-mono text-xs text-muted">{shortHash(artifact.sha256)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">{t("runDetail.noArtifactChecksums")}</p>
        )}
      </RunCardPanel>
    </div>
  );
}

function RunCardStat({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "warning" }) {
  return (
    <div className="border border-line rounded-lg bg-panel p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("font-mono tabular-nums mt-1 truncate text-sm font-medium", tone === "warning" ? "text-warnInk" : "")}>{value}</div>
    </div>
  );
}

function RunCardPanel({ title, icon, children }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; children: ReactNode }) {
  return (
    <section className="border border-line rounded-lg bg-panel">
      <header className="px-3 py-2 border-b border-line">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted shrink-0"><Icon name={icon} size={14} /></span>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h2>
        </div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function KeyValueTable({ data, empty, monospaceValues = false }: { data: Record<string, unknown>; empty: string; monospaceValues?: boolean }) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    return <p className="text-sm text-muted">{empty}</p>;
  }
  return (
    <table className="w-full table-fixed text-sm">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} className="border-b border-line last:border-0">
            <td className="w-36 py-2 pr-4 align-top text-muted">{key}</td>
            <td className={cn("py-2 align-top", monospaceValues ? "break-all font-mono text-xs" : "font-mono tabular-nums break-words text-right")}>{formatRunCardValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatRunCardValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value ?? "");
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function ChartTab({
  run,
  chartPickerSymbol,
  selectedSymbols,
  chartCache,
  loadingSymbols,
  bulkLoading,
  bulkProgress,
  onPickSymbol,
  onAddSymbol,
  onCurrentOnly,
  onRemoveSymbol,
  onLoadAll,
  onCancelLoadAll,
}: {
  run: RunData;
  chartPickerSymbol: string;
  selectedSymbols: string[];
  chartCache: ChartCache;
  loadingSymbols: Record<string, boolean>;
  bulkLoading: boolean;
  bulkProgress: ChartLoadProgress;
  onPickSymbol: (symbol: string) => void;
  onAddSymbol: (symbol: string) => void | Promise<void>;
  onCurrentOnly: (symbol: string) => void | Promise<void>;
  onRemoveSymbol: (symbol: string) => void;
  onLoadAll: () => void | Promise<void>;
  onCancelLoadAll: () => void;
}) {
  const { t } = useTranslation();
  const chartSymbols = run.chart_symbols || Object.keys(run.price_series || {});
  const entries = selectedSymbols
    .map((symbol) => [symbol, chartCache[symbol]?.price_series?.[symbol] || []] as const)
    .filter(([, bars]) => bars.length > 0);
  const hasEquity = run.equity_curve && run.equity_curve.length > 0;
  const progressPercent = bulkProgress.total > 0 ? Math.round((bulkProgress.done / bulkProgress.total) * 100) : 0;

  if (chartSymbols.length === 0 && entries.length === 0 && !hasEquity) {
    return (
      <div className="p-8 text-center text-muted space-y-2">
        <p className="text-sm">{t("runDetail.noChartData")}</p>
        <p className="text-xs">{t("runDetail.noChartDataDesc")}</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {chartSymbols.length > 0 && (
        <div className="border border-line rounded-lg bg-panel">
          <div className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-muted" htmlFor="chart-symbol-select">
              {t("runDetail.symbol")}
            </label>
            <select
              id="chart-symbol-select"
              value={chartPickerSymbol}
              onChange={(event) => onPickSymbol(event.target.value)}
              className="h-8 rounded-md border border-line bg-panel px-2 text-sm text-ink"
            >
              {chartSymbols.map((symbol) => (
                <option key={symbol} value={symbol}>{symbol}</option>
              ))}
            </select>
            <button
              onClick={() => onCurrentOnly(chartPickerSymbol)}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium hover:bg-chromeHover"
              disabled={!chartPickerSymbol || !!loadingSymbols[chartPickerSymbol]}
            >
              {loadingSymbols[chartPickerSymbol] ? <Spinner className="mr-1" /> : null}
              {t("runDetail.showOnly")}
            </button>
            <button
              onClick={() => onAddSymbol(chartPickerSymbol)}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium hover:bg-chromeHover"
              disabled={!chartPickerSymbol || !!loadingSymbols[chartPickerSymbol]}
            >
              {t("runDetail.addSymbol")}
            </button>
            <button
              onClick={() => void onLoadAll()}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium hover:bg-chromeHover"
              disabled={bulkLoading}
            >
              {bulkLoading ? <Spinner className="mr-1" /> : null}
              {t("runDetail.loadAll")}
            </button>
            {bulkLoading && (
              <button
                onClick={onCancelLoadAll}
                className="rounded-md border border-line px-3 py-1.5 text-xs font-medium hover:bg-chromeHover"
              >
                {t("runDetail.cancelLoad")}
              </button>
            )}
          </div>
          {selectedSymbols.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedSymbols.map((symbol) => (
                <button
                  key={symbol}
                  onClick={() => onRemoveSymbol(symbol)}
                  className="rounded-md bg-paper px-2 py-1 text-xs hover:bg-chromeHover"
                >
                  {symbol} x
                </button>
              ))}
            </div>
          )}
          {bulkLoading && (
            <div className="mt-3 space-y-1">
              <div className="flex justify-between text-xs text-muted">
                <span>{t("runDetail.loadingCharts")}</span>
                <span className="font-mono tabular-nums">{bulkProgress.done}/{bulkProgress.total}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-paper">
                <div className="h-full bg-accent transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}
          </div>
        </div>
      )}
      {entries.length === 0 && (
        <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">
          {Object.keys(loadingSymbols).length > 0 ? t("runDetail.loadingSelectedChart") : t("runDetail.pickSymbolToLoad")}
        </div>
      )}
      {entries.map(([sym, bars]) => (
        <div key={sym}>
          <h3 className="text-sm font-medium mb-1">{sym}</h3>
          <CandlestickChart data={bars} markers={chartCache[sym]?.trade_markers?.filter((m) => m.code === sym)} indicators={chartCache[sym]?.indicator_series?.[sym]} height={500} />
        </div>
      ))}
      {hasEquity && (
        <div>
          <h3 className="text-sm font-medium mb-1">{t("runDetail.equityDrawdown")}</h3>
          <EquityChart data={run.equity_curve!} height={280} />
        </div>
      )}
    </div>
  );
}

function TradesTab({ run }: { run: RunData }) {
  const { t } = useTranslation();
  const trades = run.trade_log || [];
  if (trades.length === 0) return <div className="p-8 text-muted text-sm">{t("runDetail.noTrades")}</div>;
  return (
    <div className="p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-2 pr-4">{t("runDetail.time")}</th>
            <th className="py-2 pr-4">{t("runDetail.code2")}</th>
            <th className="py-2 pr-4">{t("runDetail.side")}</th>
            <th className="py-2 pr-4">{t("runDetail.price")}</th>
            <th className="py-2 pr-4">{t("runDetail.qty")}</th>
            <th className="py-2">{t("runDetail.reason")}</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((tr, i) => (
            <tr key={i} className="border-b border-line last:border-0 hover:bg-paper">
              <td className="py-2 pr-4 font-mono text-xs">{tr.time || tr.timestamp}</td>
              <td className="py-2 pr-4">{tr.code}</td>
              <td className={cn("py-2 pr-4 font-medium", tr.side === "BUY" ? "text-ok" : "text-danger")}>{tr.side}</td>
              <td className="py-2 pr-4 font-mono tabular-nums">{tr.price}</td>
              <td className="py-2 pr-4 font-mono tabular-nums">{tr.qty}</td>
              <td className="py-2 text-muted">{tr.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeTab({ code }: { code: Record<string, string> }) {
  const { t } = useTranslation();
  const files = Object.entries(code);
  const [active, setActive] = useState(files[0]?.[0] || "");
  if (files.length === 0) return <div className="p-8 text-muted text-sm">{t("runDetail.noCodeFiles")}</div>;
  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 p-2 border-b border-line">
        {files.map(([name]) => (
          <button key={name} onClick={() => setActive(name)} className={cn("px-3 py-1 rounded text-xs font-mono", active === name ? "bg-accent text-white" : "text-muted hover:bg-chromeHover")}>{name}</button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3 text-[11px] leading-relaxed bg-paper [&_pre]:m-0 [&_pre]:bg-transparent [&_code]:text-[11px]">
        <ReactMarkdown>
          {`\u0060\u0060\u0060python\n${code[active] || ""}\n\u0060\u0060\u0060`}
        </ReactMarkdown>
      </div>
    </div>
  );
}
