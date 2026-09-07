// A股自选 (watchlist page) - ported from Vibe-Trading-Desktop pages/Watchlist.tsx.
// The stock list lives in a server-side shared store (coworker/watchlist.py) that
// the agent's `watchlist_read` tool also reads; quotes and bars are fetched
// client-side from the `stock-sdk` package (same data path as the dashboard).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addWatchlistStock,
  deleteWatchlistStock,
  fetchWatchlist,
  type WatchlistStock,
} from "../api";
import {
  fetchWatchlistDailyBars,
  fetchWatchlistIntradayBars,
  fetchWatchlistQuotes,
  type DashboardDataResult,
  type PriceBar,
  type WatchlistQuote,
} from "../lib/marketData";
import { calcMA } from "../lib/indicators";
import { CHART_GROUP, connectCharts, echarts } from "../lib/echarts";
import { getChartTheme } from "../lib/chart-theme";
import { useDarkMode } from "../hooks/useDarkMode";
import { Icon } from "./Icon";

const A_STOCK_RE = /^\d{6}$/;
const QUOTES_POLL_MS = 3_000;

// ── Data hook ────────────────────────────────────────────────

function useWatchlistData() {
  const { t } = useTranslation();
  const [stocks, setStocks] = useState<WatchlistStock[]>([]);
  const [quotes, setQuotes] = useState<Record<string, WatchlistQuote>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStocks(await fetchWatchlist());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshQuotes = useCallback(async (codes: string[]) => {
    if (codes.length === 0) return;
    // Quote refresh failure keeps the previous quotes on screen.
    const result: DashboardDataResult<Record<string, WatchlistQuote>> =
      await fetchWatchlistQuotes(codes);
    if (!result.stale) setQuotes(result.data);
  }, []);

  const add = useCallback(
    async (code: string): Promise<{ added: boolean; exists: boolean }> => {
      const result = await addWatchlistStock(code);
      if (result.added) await refresh();
      return result;
    },
    [refresh],
  );

  const remove = useCallback(
    async (code: string) => {
      await deleteWatchlistStock(code);
      setStocks((prev) => prev.filter((s) => s.code !== code));
    },
    [],
  );

  return { t, stocks, quotes, loading, error, refresh, refreshQuotes, add, remove };
}

// ── Charts ───────────────────────────────────────────────────

function CandleChart({ bars }: { bars: PriceBar[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { dark } = useDarkMode();

  useEffect(() => {
    if (!ref.current || bars.length === 0) return;
    const t = getChartTheme();
    const chart = echarts.init(ref.current);
    chart.group = CHART_GROUP;
    connectCharts();

    const times = bars.map((b) => b.time);
    const closes = bars.map((b) => b.close);
    const candles = bars.map((b) => [b.open, b.close, b.low, b.high]);
    const maSeries = [5, 10, 20].map((period, i) => ({
      name: `MA${period}`,
      type: "line" as const,
      showSymbol: false,
      data: calcMA(closes, period),
      lineStyle: { width: 1, color: t.maColors[i] },
      itemStyle: { color: t.maColors[i] },
    }));

    chart.setOption({
      backgroundColor: "transparent",
      animation: false,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        backgroundColor: t.tooltipBg,
        borderColor: t.tooltipBorder,
        textStyle: { color: t.tooltipText, fontSize: 11 },
      },
      legend: { data: ["MA5", "MA10", "MA20"], textStyle: { color: t.textColor, fontSize: 10 } },
      grid: { left: 8, right: 8, top: 26, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: times,
        boundary: false,
        axisLine: { lineStyle: { color: t.axisColor } },
        axisLabel: { color: t.textColor, fontSize: 10 },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: t.gridColor } },
        axisLabel: { color: t.textColor, fontSize: 10 },
      },
      series: [
        {
          name: "K",
          type: "candlestick",
          data: candles,
          // ChartTheme is locale-aware: China = red up / green down.
          itemStyle: { color: t.upColor, color0: t.downColor, borderColor: t.upColor, borderColor0: t.downColor },
        },
        ...maSeries,
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [bars, dark]);

  return <div ref={ref} style={{ height: 420, width: "100%" }} data-testid="watchlist-daily-chart" />;
}

function IntradayChart({ bars }: { bars: PriceBar[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { dark } = useDarkMode();

  useEffect(() => {
    if (!ref.current || bars.length === 0) return;
    const t = getChartTheme();
    const chart = echarts.init(ref.current);
    chart.group = CHART_GROUP;
    connectCharts();

    chart.setOption({
      backgroundColor: "transparent",
      animation: false,
      tooltip: {
        trigger: "axis",
        backgroundColor: t.tooltipBg,
        borderColor: t.tooltipBorder,
        textStyle: { color: t.tooltipText, fontSize: 11 },
      },
      grid: { left: 8, right: 8, top: 12, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: bars.map((b) => b.time.slice(-5)),
        boundary: false,
        axisLine: { lineStyle: { color: t.axisColor } },
        axisLabel: { color: t.textColor, fontSize: 10 },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: t.gridColor } },
        axisLabel: { color: t.textColor, fontSize: 10 },
      },
      series: [
        {
          name: "price",
          type: "line",
          showSymbol: false,
          data: bars.map((b) => b.close),
          lineStyle: { width: 1.5, color: t.infoColor },
          areaStyle: { opacity: 0.12, color: t.infoColor },
        },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [bars, dark]);

  return <div ref={ref} style={{ height: 240, width: "100%" }} data-testid="watchlist-intraday-chart" />;
}

// ── Page shell (full-bleed main, same variant as the dashboard) ──

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 min-w-0 flex bg-paper">
      <div className="flex-1 min-w-0 overflow-y-auto hairline-scroll">
        <div className="w-full max-w-none px-7 py-6">{children}</div>
      </div>
    </main>
  );
}

// ── Sub-components ───────────────────────────────────────────

function changeColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted";
  if (pct > 0) return "text-red-500";
  if (pct < 0) return "text-green-500";
  return "text-muted";
}

function fmtPrice(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(2);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function pctChipClass(pct: number | null | undefined): string {
  if (pct == null) return "bg-chrome text-muted";
  if (pct > 0) return "bg-red-500/10 text-red-500";
  if (pct < 0) return "bg-green-500/10 text-green-500";
  return "bg-chrome text-muted";
}

function SummaryCard({ label, value, valueClass }: { label: string; value: string | number; valueClass?: string }) {
  return (
    <div className="rounded-xl2 border border-line bg-panel px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold tabular-nums ${valueClass ?? ""}`}>{value}</p>
    </div>
  );
}

function StockCard({
  stock,
  quote,
  isActive,
  confirmingDelete,
  labels,
  onSelectDetail,
  onDelete,
  onCancelDelete,
}: {
  stock: WatchlistStock;
  quote?: WatchlistQuote;
  isActive: boolean;
  confirmingDelete: boolean;
  labels: { delete: string; confirmDelete: string; cancelDelete: string; newsLink: string; stale: string };
  onSelectDetail: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  const name = quote?.name ?? stock.name ?? "—";
  const pct = quote?.changePct ?? null;

  return (
    <article
      data-testid={`watchlist-card-${stock.code}`}
      title={quote?.stale ? labels.stale : undefined}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-line bg-panel p-3 transition-colors hover:bg-chrome ${
        isActive ? "ring-1 ring-inset ring-accent/40" : ""
      }`}
    >
      <button
        type="button"
        onClick={onSelectDetail}
        data-testid={`watchlist-card-select-${stock.code}`}
        aria-pressed={isActive}
        className="min-w-0 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className="min-w-0 truncate">{name}</span>
          <span className="shrink-0 font-mono text-xs text-muted tabular-nums">{stock.code}</span>
        </span>
        <span className="mt-1 flex items-center gap-2 font-mono text-xs tabular-nums">
          <span className={changeColor(pct)}>{fmtPrice(quote?.price)}</span>
          <span className={`inline-block min-w-[3.75rem] rounded px-1.5 py-0.5 text-right font-mono tabular-nums ${pctChipClass(pct)}`}>
            {fmtPct(pct)}
          </span>
        </span>
      </button>
      <div className="flex items-center gap-1">
        {confirmingDelete ? (
          <>
            <button
              type="button"
              onClick={onDelete}
              className="rounded px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10"
              data-testid={`confirm-delete-${stock.code}`}
            >
              {labels.confirmDelete}
            </button>
            <button type="button" onClick={onCancelDelete} className="rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-chrome">
              {labels.cancelDelete}
            </button>
          </>
        ) : (
          <>
            <a
              href={`https://stockpage.10jqka.com.cn/${stock.code}/news`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex rounded-md p-1.5 text-muted transition-colors hover:bg-chrome hover:text-ink"
              title={labels.newsLink}
              aria-label={labels.newsLink}
              data-testid={`news-${stock.code}`}
            >
              <Icon name="arrowRight" size={14} />
            </a>
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex rounded-md p-1.5 text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
              title={labels.delete}
              aria-label={labels.delete}
              data-testid={`delete-${stock.code}`}
            >
              <Icon name="trash" size={14} />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function DetailPanel({
  code,
  name,
  daily,
  intraday,
  dailyLoading,
  intradayLoading,
}: {
  code: string | null;
  name: string | null;
  daily: DashboardDataResult<PriceBar[]> | null;
  intraday: DashboardDataResult<PriceBar[]> | null;
  dailyLoading: boolean;
  intradayLoading: boolean;
}) {
  const { t } = useTranslation();
  const bars = daily?.data ?? [];
  const intradayBars = intraday?.data ?? [];

  if (!code) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-chrome px-4 py-2.5">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
            {t("watchlist.chartTitle")}
          </h2>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <p className="text-xs text-muted">{t("watchlist.selectStockHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-chrome px-4 py-2.5">
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {name || code} <span className="font-mono text-xs font-normal text-muted">({code})</span>
        </h2>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto hairline-scroll p-4" data-testid="watchlist-chart-stack">
        <section data-testid="watchlist-daily-chart-region">
          <h3 className="mb-2 text-sm font-semibold">{t("watchlist.dailyChart")}</h3>
          {dailyLoading && <p className="text-xs text-muted">{t("dashboard.loading")}</p>}
          {!dailyLoading && daily?.stale && (
            <p className="mb-2 text-xs text-red-500">{daily.error}</p>
          )}
          {!dailyLoading && bars.length > 0 && <CandleChart bars={bars} />}
          {!dailyLoading && !daily?.stale && bars.length === 0 && (
            <p className="text-xs text-muted">{t("watchlist.noChartData")}</p>
          )}
        </section>
        <section data-testid="watchlist-intraday-chart-region" className="border-t border-line pt-4">
          <h3 className="mb-2 text-sm font-semibold">{t("watchlist.intraday")}</h3>
          {intradayLoading && <p className="min-h-32 text-center text-xs text-muted">{t("watchlist.intradayLoading")}</p>}
          {!intradayLoading && intraday?.stale && (
            <div className="flex min-h-32 items-center justify-center rounded-md bg-chrome p-3 text-xs text-red-500" role="alert">
              {t("watchlist.intradayError")}
            </div>
          )}
          {!intradayLoading && !intraday?.stale && intradayBars.length > 0 && <IntradayChart bars={intradayBars} />}
          {!intradayLoading && !intraday?.stale && intradayBars.length === 0 && (
            <div className="flex min-h-32 flex-col items-center justify-center rounded-md bg-chrome p-3 text-center">
              <p className="text-xs font-medium">{t("watchlist.intradayUnavailable")}</p>
              <p className="mt-1 text-xs text-muted">{t("watchlist.intradayUnavailableHint")}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────

export function WatchlistView() {
  const { t, stocks, quotes, loading, error, refresh, refreshQuotes, add, remove } =
    useWatchlistData();
  const [inputCode, setInputCode] = useState("");
  const [inputError, setInputError] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [daily, setDaily] = useState<DashboardDataResult<PriceBar[]> | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [intraday, setIntraday] = useState<DashboardDataResult<PriceBar[]> | null>(null);
  const [intradayLoading, setIntradayLoading] = useState(false);

  // Initial load + quote polling (3s, paused while the tab is hidden).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (stocks.length === 0) return;
    const codes = stocks.map((s) => s.code);
    void refreshQuotes(codes);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshQuotes(codes);
    }, QUOTES_POLL_MS);
    return () => window.clearInterval(timer);
  }, [stocks, refreshQuotes]);

  // Auto-select the first stock once the list loads.
  useEffect(() => {
    if (stocks.length === 0) return;
    if (!selectedCode || !stocks.some((s) => s.code === selectedCode)) {
      setSelectedCode(stocks[0].code);
    }
  }, [stocks, selectedCode]);

  // Bars fetch on selection change.
  useEffect(() => {
    if (!selectedCode) return;
    let cancelled = false;
    setDailyLoading(true);
    setIntradayLoading(true);
    void fetchWatchlistDailyBars(selectedCode).then((result) => {
      if (!cancelled) {
        setDaily(result);
        setDailyLoading(false);
      }
    });
    void fetchWatchlistIntradayBars(selectedCode).then((result) => {
      if (!cancelled) {
        setIntraday(result);
        setIntradayLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCode]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const code = inputCode.trim();
    if (!A_STOCK_RE.test(code)) {
      setInputError(t("watchlist.invalidCode"));
      return;
    }
    setInputError("");
    setAdding(true);
    try {
      const result = await add(code);
      if (result.exists) setInputError(t("watchlist.alreadyAdded", { code }));
      else setInputCode("");
    } catch {
      setInputError(t("watchlist.addFailed"));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(code: string) {
    if (confirmDelete !== code) {
      setConfirmDelete(code);
      return;
    }
    setConfirmDelete(null);
    try {
      await remove(code);
    } catch {
      // Row stays; the next refresh reconciles with the server store.
    }
  }

  const addForm = (
    <form onSubmit={handleAdd} className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="text"
          value={inputCode}
          onChange={(e) => {
            setInputCode(e.target.value);
            setInputError("");
          }}
          placeholder={t("watchlist.placeholder")}
          maxLength={6}
          inputMode="numeric"
          className="chan-input w-full"
          aria-label={t("watchlist.placeholder")}
          aria-invalid={!!inputError}
        />
        {inputError && <span className="text-xs text-red-500">{inputError}</span>}
      </div>
      <button type="submit" disabled={adding} className="btn-primary sm shrink-0" data-testid="watchlist-add">
        {adding ? t("watchlist.adding") : t("watchlist.add")}
      </button>
    </form>
  );

  const marketSummary = (() => {
    const changes = stocks
      .map((s) => quotes[s.code]?.changePct)
      .filter((c): c is number => c != null);
    return {
      rising: changes.filter((c) => c > 0).length,
      falling: changes.filter((c) => c < 0).length,
      averageChange:
        changes.length > 0
          ? changes.reduce((sum, c) => sum + c, 0) / changes.length
          : null,
    };
  })();

  const activeSelectedCode =
    selectedCode && stocks.some((s) => s.code === selectedCode) ? selectedCode : null;
  const showSkeleton = loading && stocks.length === 0;

  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-none flex-col gap-3">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("watchlist.title")}</h1>
            <p className="text-sm text-muted">{t("watchlist.description")}</p>
          </div>
          <button
            onClick={() => {
              void refresh();
              if (stocks.length > 0) void refreshQuotes(stocks.map((s) => s.code));
            }}
            className="btn icon-only"
            title={t("watchlist.refresh")}
            aria-label={t("watchlist.refresh")}
          >
            <Icon name="refresh" size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </header>

        <section aria-label={t("watchlist.summaryLabel")} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard label={t("watchlist.total")} value={stocks.length} />
          <SummaryCard label={t("watchlist.rising")} value={marketSummary.rising} valueClass="text-red-500" />
          <SummaryCard label={t("watchlist.falling")} value={marketSummary.falling} valueClass="text-green-500" />
          <SummaryCard
            label={t("watchlist.averageChange")}
            value={fmtPct(marketSummary.averageChange)}
            valueClass={changeColor(marketSummary.averageChange)}
          />
        </section>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-500">
            {error}
          </div>
        )}

        {showSkeleton && (
          <ul role="list" className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="h-[4.5rem] rounded-md border border-line bg-panel p-3" />
            ))}
          </ul>
        )}

        {!loading && stocks.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="w-full max-w-sm" data-testid="watchlist-empty-add">
              {addForm}
            </div>
            <p className="text-base font-medium">{t("watchlist.empty")}</p>
            <p className="max-w-xs text-sm text-muted">{t("watchlist.emptyHint")}</p>
          </div>
        )}

        {stocks.length > 0 && (
          <div data-testid="watchlist-workspace" className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(22rem,0.8fr)_minmax(0,1.4fr)]">
            <aside data-testid="watchlist-list-panel" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl2 border border-line bg-panel lg:order-1">
              <header className="flex items-center justify-between gap-3 border-b border-line bg-chrome px-4 py-2.5">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
                  {t("watchlist.listTitle")}
                </h2>
                <p className="font-mono text-xs text-muted tabular-nums">
                  {t("watchlist.showing", { count: stocks.length })}
                </p>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
                {addForm}
                <ul role="list" className="min-h-0 flex-1 space-y-2 overflow-y-auto hairline-scroll">
                  {stocks.map((stock) => (
                    <li key={stock.code}>
                      <StockCard
                        stock={stock}
                        quote={quotes[stock.code]}
                        isActive={activeSelectedCode === stock.code}
                        confirmingDelete={confirmDelete === stock.code}
                        labels={{
                          delete: t("watchlist.delete"),
                          confirmDelete: t("watchlist.confirmDelete"),
                          cancelDelete: t("watchlist.cancelDelete"),
                          newsLink: t("watchlist.newsLink"),
                          stale: t("watchlist.stale"),
                        }}
                        onSelectDetail={() => setSelectedCode(stock.code)}
                        onDelete={() => void handleDelete(stock.code)}
                        onCancelDelete={() => setConfirmDelete(null)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </aside>

            <section data-testid="watchlist-chart-panel" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl2 border border-line bg-panel lg:order-2">
              <DetailPanel
                code={activeSelectedCode}
                name={activeSelectedCode ? (quotes[activeSelectedCode]?.name ?? null) : null}
                daily={daily}
                intraday={intraday}
                dailyLoading={dailyLoading}
                intradayLoading={intradayLoading}
              />
            </section>
          </div>
        )}
      </div>
    </Shell>
  );
}
