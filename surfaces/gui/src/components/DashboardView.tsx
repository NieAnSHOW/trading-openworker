// Market dashboard (行情) — ported from Vibe-Trading-Desktop `src/pages/Dashboard.tsx`.
// Data comes from src/lib/marketData.ts (client-side stock-sdk + our board-heat
// route); the page polls every 15s while visible and keeps the previous snapshot
// on partial failures (per-area stale markers surface in each card footer).
// Upstream's AnnouncementBar (cool-admin ads via the Tauri shell bridge) has no
// counterpart here and was not ported.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { Icon } from "./Icon";
import {
  fetchDashboardIndexes,
  fetchDashboardMarketSnapshot,
  type DashboardConceptHeat,
  type DashboardIndex,
  type DashboardMarketEmotion,
  type DashboardMarketSnapshot,
  type DashboardSnapshotArea,
  type DashboardStockRankRow,
} from "../lib/marketData";

const POLL_INTERVAL_MS = 15_000;

// ── Data hook (replaces upstream's zustand store — this page is the only consumer) ──

function useMarketDashboard() {
  const [indexes, setIndexes] = useState<DashboardIndex[]>([]);
  const [marketSnapshot, setMarketSnapshot] = useState<DashboardMarketSnapshot | null>(null);
  const [indexesLoading, setIndexesLoading] = useState(false);
  const [marketSnapshotLoading, setMarketSnapshotLoading] = useState(false);
  const [indexesError, setIndexesError] = useState<string | null>(null);
  const [marketSnapshotError, setMarketSnapshotError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;

    const refresh = async () => {
      setIndexesLoading(true);
      setMarketSnapshotLoading(true);
      const [indexesResult, snapshotResult] = await Promise.allSettled([
        fetchDashboardIndexes(),
        fetchDashboardMarketSnapshot(),
      ]);
      if (stopped) return;
      if (indexesResult.status === "fulfilled") {
        setIndexes(indexesResult.value.data);
        setIndexesError(null);
      } else {
        setIndexesError(
          indexesResult.reason instanceof Error
            ? indexesResult.reason.message
            : "indexes failed",
        );
      }
      if (snapshotResult.status === "fulfilled") {
        setMarketSnapshot(snapshotResult.value.data);
        setMarketSnapshotError(snapshotResult.value.error ?? null);
      } else {
        setMarketSnapshotError(
          snapshotResult.reason instanceof Error
            ? snapshotResult.reason.message
            : "market snapshot failed",
        );
      }
      setIndexesLoading(false);
      setMarketSnapshotLoading(false);
    };

    // Skip polls while hidden; refresh immediately on becoming visible again.
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  return {
    indexes,
    marketSnapshot,
    indexesLoading,
    marketSnapshotLoading,
    indexesError,
    marketSnapshotError,
  };
}

// ── Page shell (full-bleed main; the dashboard grids are container-queried) ──

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 min-w-0 flex bg-paper">
      <div className="flex-1 min-w-0 overflow-y-auto hairline-scroll">
        <div className="dashboard-page w-full max-w-none px-7 py-6">{children}</div>
      </div>
    </main>
  );
}

// ── Helpers ──────────────────────────────────────────────────

function changeColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted";
  if (pct > 0) return "text-red-500";
  if (pct < 0) return "text-green-500";
  return "text-muted";
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toFixed(2);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function fmtAmt(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

function fmtBigAmount(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 10000) return `${(v / 10000).toFixed(2)}亿`;
  return `${v.toFixed(0)}万`;
}

function fmtTurnover(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtSnapshotTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function combineSnapshotAreas(
  ...areas: Array<DashboardSnapshotArea | undefined>
): DashboardSnapshotArea | undefined {
  const availableAreas = areas.filter(
    (area): area is DashboardSnapshotArea => area != null,
  );
  if (availableAreas.length === 0) return undefined;

  const asOf =
    availableAreas
      .map((area) => area.asOf)
      .filter((value): value is string => value != null)
      .sort()[0] ?? null;
  return {
    source: [...new Set(availableAreas.map((area) => area.source))].join(" / "),
    asOf,
    stale: availableAreas.some((area) => area.stale),
    available: availableAreas.every((area) => area.available),
    error: availableAreas.map((area) => area.error).find((error) => error != null),
  };
}

// ── Sub-components ───────────────────────────────────────────

/** Horizontal strip of major A-share index cards */
function IndexStrip({ indexes }: { indexes: DashboardIndex[] }) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || indexes.length < 2) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;

    let isVisible = true;
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(([entry]) => {
            isVisible = entry.isIntersecting;
          })
        : null;
    observer?.observe(strip);

    const timer = window.setInterval(() => {
      if (
        pausedRef.current ||
        document.hidden ||
        !isVisible ||
        strip.scrollWidth <= strip.clientWidth + 1
      ) {
        return;
      }
      const firstCard = strip.firstElementChild as HTMLElement | null;
      if (!firstCard) return;
      const gap = Number.parseFloat(getComputedStyle(strip).columnGap || "0");
      const step = firstCard.getBoundingClientRect().width + gap;
      const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - step / 2;
      strip.scrollTo({ left: atEnd ? 0 : strip.scrollLeft + step, behavior: "smooth" });
    }, 4500);

    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, [indexes.length]);

  if (indexes.length === 0) {
    return <p className="text-xs text-muted py-2">{t("dashboard.noIndexes")}</p>;
  }

  return (
    <div
      ref={stripRef}
      className="dashboard-index-strip"
      aria-label={t("dashboard.marketSnapshot")}
      data-autoplay="true"
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
      onFocus={() => {
        pausedRef.current = true;
      }}
      onBlur={() => {
        pausedRef.current = false;
      }}
    >
      {indexes.map((idx) => {
        const color = changeColor(idx.changePct);
        return (
          <div key={idx.code} className="rounded-lg border border-line bg-panel px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted truncate">{idx.name}</span>
              <span className={cn("text-[11px] tabular-nums font-mono", color)}>
                {fmtPct(idx.changePct)}
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-lg font-semibold tabular-nums font-mono leading-none">
                {fmtPrice(idx.price)}
              </span>
              <span className={cn("text-xs tabular-nums font-mono", color)}>
                {fmtAmt(idx.changeAmt)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MarketCard({
  testId,
  title,
  children,
  hasData,
  loading,
  error,
  status,
}: {
  testId: string;
  title: string;
  children: ReactNode;
  hasData: boolean;
  loading: boolean;
  error: string | null;
  status?: DashboardSnapshotArea;
}) {
  const { t } = useTranslation();

  return (
    <section data-testid={testId} className="min-w-0 overflow-hidden rounded-xl2 border border-line bg-panel flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-chrome px-4 py-2.5">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
          {title}
        </h2>
        {error && hasData && (
          <span className="shrink-0 text-[10px] text-muted">{t("dashboard.stale")}</span>
        )}
      </header>
      <div className="px-4 py-3 flex min-h-0 flex-1 flex-col">
        {!hasData && loading && (
          <p className="text-xs text-muted">{t("dashboard.loading")}</p>
        )}
        {!hasData && error && (
          <div className="flex items-center gap-1.5 text-xs text-muted">{error}</div>
        )}
        {hasData && <div className="space-y-2.5">{children}</div>}
        {hasData && error && (
          <p className="mt-2.5 text-[10px] text-muted/70">{error}</p>
        )}
        {hasData && status?.available && (
          <footer className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line/60 pt-2 text-[10px] text-muted/70">
            <span>
              {t("dashboard.source")}: {status.source}
            </span>
            {status.asOf && (
              <time dateTime={status.asOf}>
                {t("dashboard.lastUpdated")}: {fmtSnapshotTime(status.asOf)}
              </time>
            )}
          </footer>
        )}
      </div>
    </section>
  );
}

function MarketMetric({
  label,
  value,
  tone = "text-ink",
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-chrome px-2 py-1.5">
      <p className="truncate text-[10px] text-muted">{label}</p>
      <p className={cn("mt-0.5 truncate font-mono text-sm font-semibold tabular-nums", tone)}>
        {value}
      </p>
    </div>
  );
}

function MarketBreadthCard({
  snapshot,
  loading,
  error,
}: {
  snapshot: DashboardMarketSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const breadth = snapshot?.breadth;
  const marketArea = snapshot?.areas.market;
  const marketError =
    marketArea?.error ?? snapshot?.errors?.market ?? (snapshot ? null : error);
  if (!breadth) {
    return (
      <MarketCard
        testId="market-breadth-card"
        title={t("dashboard.marketBreadth")}
        hasData={false}
        loading={loading}
        error={marketError}
        status={marketArea}
      >
        {null}
      </MarketCard>
    );
  }
  const total = breadth?.total ?? 0;
  const upWidth = total > 0 ? (breadth!.up / total) * 100 : 0;
  const flatWidth = total > 0 ? (breadth!.flat / total) * 100 : 0;
  const downWidth = total > 0 ? (breadth!.down / total) * 100 : 0;
  const maxBucketCount = Math.max(
    ...(breadth?.distribution.map((bucket) => bucket.count) ?? []),
    1,
  );

  return (
    <MarketCard
      testId="market-breadth-card"
      title={t("dashboard.marketBreadth")}
      hasData={breadth != null}
      loading={loading}
      error={marketError}
      status={marketArea}
    >
      <div
        className="grid h-20 grid-cols-7 items-end gap-1"
        aria-label={t("dashboard.marketBreadth")}
      >
        {breadth!.distribution.map((bucket) => {
          const barClass =
            bucket.tone === "up"
              ? "bg-red-500/80"
              : bucket.tone === "down"
                ? "bg-green-500/80"
                : "bg-faint/45";
          return (
            <div
              key={bucket.label}
              className="flex min-w-0 flex-col items-center justify-end gap-1"
            >
              <span className="text-[9px] text-muted tabular-nums">
                {bucket.count || ""}
              </span>
              <div
                className={cn("w-full max-w-3 rounded-sm", barClass)}
                style={{
                  height: `${Math.max(4, (bucket.count / maxBucketCount) * 50)}px`,
                }}
                title={`${bucket.label}: ${bucket.count}`}
              />
              <span className="w-full truncate text-center text-[9px] text-muted">
                {bucket.label}
              </span>
            </div>
          );
        })}
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-chrome"
        aria-label={t("dashboard.upFlatDown")}
      >
        <span className="bg-red-500/80" style={{ width: `${upWidth}%` }} />
        <span className="bg-faint/40" style={{ width: `${flatWidth}%` }} />
        <span className="bg-green-500/80" style={{ width: `${downWidth}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <span className="text-red-500">
          {t("dashboard.up")}{" "}
          <strong className="font-mono tabular-nums">{breadth!.up}</strong>
        </span>
        <span className="text-muted">
          {t("dashboard.flat")}{" "}
          <strong className="font-mono tabular-nums">{breadth!.flat}</strong>
        </span>
        <span className="text-green-500 text-right">
          {t("dashboard.down")}{" "}
          <strong className="font-mono tabular-nums">{breadth!.down}</strong>
        </span>
      </div>
      <p className="text-[10px] text-muted">
        {t("dashboard.totalStocks", { count: breadth.total })}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <MarketMetric
          label={t("dashboard.averageChange")}
          value={fmtPct(breadth!.avgChangePct)}
          tone={changeColor(breadth!.avgChangePct)}
        />
        <MarketMetric
          label={t("dashboard.upRatio")}
          value={`${breadth!.upPct.toFixed(0)}%`}
          tone="text-red-500"
        />
      </div>
    </MarketCard>
  );
}

function EmotionRadar({ emotion }: { emotion: DashboardMarketEmotion }) {
  const { t } = useTranslation();
  const dimensions = emotion.dimensions;
  const size = 220;
  const center = size / 2;
  const radius = 63;
  const points = dimensions.map((dimension, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / dimensions.length;
    const valueRadius = radius * (dimension.value / 100);
    return {
      ...dimension,
      x: center + Math.cos(angle) * valueRadius,
      y: center + Math.sin(angle) * valueRadius,
      labelX: center + Math.cos(angle) * (radius + 25),
      labelY: center + Math.sin(angle) * (radius + 25),
    };
  });
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");
  const gridPolygons = [1, 2 / 3, 1 / 3].map((level) =>
    dimensions
      .map((_, index) => {
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / dimensions.length;
        return `${center + Math.cos(angle) * radius * level},${center + Math.sin(angle) * radius * level}`;
      })
      .join(" "),
  );

  return (
    <div className="flex justify-center">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-48 w-full max-w-[15rem]"
        role="img"
        aria-label={t("dashboard.emotionRadar")}
      >
        {gridPolygons.map((grid, index) => (
          <polygon
            key={grid}
            points={grid}
            fill={index % 2 === 0 ? "var(--canvas)" : "transparent"}
            stroke="var(--line)"
            strokeWidth="1"
          />
        ))}
        {points.map((point) => (
          <line
            key={`${point.key}-axis`}
            x1={center}
            y1={center}
            x2={point.labelX}
            y2={point.labelY}
            stroke="var(--line)"
            strokeWidth="1"
          />
        ))}
        <polygon
          points={polygon}
          fill="var(--accent-soft)"
          stroke="var(--accent)"
          strokeWidth="2"
        />
        {points.map((point) => (
          <circle
            key={point.key}
            cx={point.x}
            cy={point.y}
            r="3"
            fill="var(--accent)"
          />
        ))}
        <circle
          cx={center}
          cy={center}
          r="27"
          fill="var(--panel)"
          stroke="var(--line)"
        />
        <text
          x={center}
          y={center + 6}
          textAnchor="middle"
          className="fill-ink text-[22px] font-semibold"
        >
          {emotion.score}
        </text>
        {points.map((point) => (
          <text
            key={`${point.key}-label`}
            x={point.labelX}
            y={point.labelY + 3}
            textAnchor="middle"
            className="fill-faint text-[10px]"
          >
            {t(`dashboard.emotionDimensions.${point.key}`)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function MarketEmotionCard({
  snapshot,
  loading,
  error,
}: {
  snapshot: DashboardMarketSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const emotion = snapshot?.emotion;
  const emotionArea = combineSnapshotAreas(
    snapshot?.areas.market,
    snapshot?.areas.limit,
  );
  const emotionError = emotionArea?.error ?? (snapshot ? null : error);
  if (!emotion) {
    return (
      <MarketCard
        testId="market-emotion-card"
        title={t("dashboard.emotionRadar")}
        hasData={false}
        loading={loading}
        error={emotionError}
        status={emotionArea}
      >
        {null}
      </MarketCard>
    );
  }
  const emotionTone =
    emotion.score >= 55
      ? "text-red-500"
      : emotion.score < 45
        ? "text-green-500"
        : "text-ink";

  return (
    <MarketCard
      testId="market-emotion-card"
      title={t("dashboard.emotionRadar")}
      hasData
      loading={loading}
      error={emotionError}
      status={emotionArea}
    >
      <EmotionRadar emotion={emotion} />
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">
          {t(`dashboard.emotionLabels.${emotion.label}`)}
        </span>
        <span className={cn("font-mono font-semibold tabular-nums", emotionTone)}>
          {emotion.score} / 100
        </span>
      </div>
    </MarketCard>
  );
}

function MarketTrendCard({
  snapshot,
  loading,
  error,
}: {
  snapshot: DashboardMarketSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const marketArea = snapshot?.areas.market;
  const marketError =
    marketArea?.error ?? snapshot?.errors?.market ?? (snapshot ? null : error);
  const trend = snapshot?.trend;
  if (!trend) {
    return (
      <MarketCard
        testId="market-trend-card"
        title={t("dashboard.trendStrength")}
        hasData={false}
        loading={loading}
        error={marketError}
        status={marketArea}
      >
        {null}
      </MarketCard>
    );
  }

  return (
    <MarketCard
      testId="market-trend-card"
      title={t("dashboard.trendStrength")}
      hasData={trend != null}
      loading={loading}
      error={marketError}
      status={marketArea}
    >
      <div className="grid grid-cols-2 gap-2">
        <MarketMetric label={t("dashboard.strongUp")} value={trend!.strongUp} tone="text-red-500" />
        <MarketMetric label={t("dashboard.strongDown")} value={trend!.strongDown} tone="text-green-500" />
        <MarketMetric label={t("dashboard.nearHigh")} value={trend!.nearHigh} tone="text-red-500" />
        <MarketMetric label={t("dashboard.nearLow")} value={trend!.nearLow} tone="text-green-500" />
      </div>
      <div className="rounded-md border border-line/70 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted">{t("dashboard.highLowRatio")}</span>
          <span
            className={cn(
              "font-mono font-semibold tabular-nums",
              trend!.highLowRatio >= 50 ? "text-red-500" : "text-green-500",
            )}
          >
            {trend!.highLowRatio.toFixed(0)}%
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-chrome">
          <div
            className={cn(
              "h-full rounded-full",
              trend!.highLowRatio >= 50 ? "bg-red-500" : "bg-green-500",
            )}
            style={{ width: `${trend!.highLowRatio}%` }}
          />
        </div>
      </div>
    </MarketCard>
  );
}

function MarketLimitCard({
  snapshot,
  loading,
  error,
}: {
  snapshot: DashboardMarketSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const limit = snapshot?.limit;
  const limitArea = snapshot?.areas.limit;
  const limitError =
    limitArea?.error ?? snapshot?.errors?.limit ?? (snapshot ? null : error);
  if (!limit) {
    return (
      <MarketCard
        testId="market-limit-card"
        title={t("dashboard.limitLadder")}
        hasData={false}
        loading={loading}
        error={limitError}
        status={limitArea}
      >
        {null}
      </MarketCard>
    );
  }
  const maxTierCount = Math.max(
    ...(limit?.tiers.map((tier) => tier.count) ?? []),
    1,
  );

  return (
    <MarketCard
      testId="market-limit-card"
      title={t("dashboard.limitLadder")}
      hasData={limit != null}
      loading={loading}
      error={limitError}
      status={limitArea}
    >
      <div className="grid grid-cols-3 gap-2">
        <MarketMetric label={t("dashboard.limitUp")} value={limit!.limitUp} tone="text-red-500" />
        <MarketMetric label={t("dashboard.limitDown")} value={limit!.limitDown} tone="text-green-500" />
        <MarketMetric label={t("dashboard.brokenBoard")} value={limit!.broken} tone="text-amber-500" />
      </div>
      {limit!.tiers.length > 0 ? (
        <div className="space-y-2">
          {limit!.tiers.slice(0, 6).map((tier) => (
            <div
              key={tier.boards}
              className="grid grid-cols-[3rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs"
            >
              <span className="font-medium text-muted">
                {t("dashboard.boards", { count: tier.boards })}
              </span>
              <div className="h-2 overflow-hidden rounded-full bg-chrome">
                <div
                  className="h-full rounded-full bg-red-500/80"
                  style={{ width: `${(tier.count / maxTierCount) * 100}%` }}
                />
              </div>
              <span className="text-right font-mono tabular-nums text-red-500">
                {tier.count}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">{t("dashboard.noLimitData")}</p>
      )}
    </MarketCard>
  );
}

function BoardHeatCard({
  testId,
  title,
  emptyKey,
  boards,
  area,
  areaError,
  loading,
}: {
  testId: string;
  title: string;
  emptyKey: string;
  boards: DashboardConceptHeat[] | null;
  area?: DashboardSnapshotArea;
  areaError: string | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (boards == null) {
    return (
      <MarketCard
        testId={testId}
        title={title}
        hasData={false}
        loading={loading}
        error={areaError}
        status={area}
      >
        {null}
      </MarketCard>
    );
  }

  return (
    <MarketCard
      testId={testId}
      title={title}
      hasData
      loading={loading}
      error={areaError}
      status={area}
    >
      {boards.length > 0 ? (
        <ul className="space-y-1">
          {boards.slice(0, 8).map((board) => (
            <li
              key={board.code}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line/50 py-1.5 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{board.name}</p>
                <p className="truncate text-[10px] text-muted">
                  {t("dashboard.riseFall", {
                    up: board.riseCount ?? "-",
                    down: board.fallCount ?? "-",
                  })}
                  {board.leadingStock ? ` · ${board.leadingStock}` : ""}
                </p>
              </div>
              <span
                className={cn(
                  "font-mono text-xs font-semibold tabular-nums",
                  changeColor(board.changePct),
                )}
              >
                {fmtPct(board.changePct)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t(emptyKey)}</p>
      )}
    </MarketCard>
  );
}

function StockRankCard({
  testId,
  title,
  rows,
  mode,
  loading,
  error,
  status,
}: {
  testId: string;
  title: string;
  rows: DashboardStockRankRow[] | null;
  mode: "gain" | "loss" | "amount" | "active";
  loading: boolean;
  error: string | null;
  status?: DashboardSnapshotArea;
}) {
  const { t } = useTranslation();
  const hasData = rows != null && rows.length > 0;
  return (
    <MarketCard
      testId={testId}
      title={title}
      hasData={hasData}
      loading={loading}
      error={error}
      status={status}
    >
      {rows && rows.length > 0 ? (
        <ul className="space-y-1">
          {rows.map((row, i) => (
            <li
              key={`${row.code}-${i}`}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-line/50 py-1 last:border-0"
            >
              <span className="text-center text-[11px] tabular-nums text-muted">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{row.name}</p>
                <p className="font-mono text-[10px] text-muted">{row.code}</p>
              </div>
              <div className="text-right">
                {mode === "amount" ? (
                  <>
                    <p className="font-mono text-xs tabular-nums">
                      {fmtBigAmount(row.amount)}
                    </p>
                    <p
                      className={cn(
                        "font-mono text-[10px] tabular-nums",
                        changeColor(row.changePct),
                      )}
                    >
                      {fmtPct(row.changePct)}
                    </p>
                  </>
                ) : mode === "active" ? (
                  <>
                    <p className="font-mono text-xs tabular-nums">
                      {fmtTurnover(row.turnoverRate)}
                    </p>
                    <p
                      className={cn(
                        "font-mono text-[10px] tabular-nums",
                        changeColor(row.changePct),
                      )}
                    >
                      {fmtPct(row.changePct)}
                    </p>
                  </>
                ) : (
                  <>
                    <p
                      className={cn(
                        "font-mono text-xs font-semibold tabular-nums",
                        changeColor(row.changePct),
                      )}
                    >
                      {fmtPct(row.changePct)}
                    </p>
                    <p className="font-mono text-[10px] tabular-nums text-muted">
                      {fmtPrice(row.price)}
                    </p>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t("dashboard.noRankData")}</p>
      )}
    </MarketCard>
  );
}

function MarketSnapshotSection({
  snapshot,
  loading,
  error,
}: {
  snapshot: DashboardMarketSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();

  return (
    <section aria-label={t("dashboard.marketSnapshot")} className="space-y-3">
      <div className="dashboard-snapshot-grid">
        <MarketBreadthCard snapshot={snapshot} loading={loading} error={error} />
        <MarketEmotionCard snapshot={snapshot} loading={loading} error={error} />
        <MarketTrendCard snapshot={snapshot} loading={loading} error={error} />
        <MarketLimitCard snapshot={snapshot} loading={loading} error={error} />
      </div>
      <div className="dashboard-detail-grid">
        <BoardHeatCard
          testId="market-concepts-card"
          title={t("dashboard.conceptHeat")}
          emptyKey="dashboard.noConceptData"
          boards={snapshot?.concepts ?? null}
          area={snapshot?.areas.concepts}
          areaError={
            snapshot?.areas.concepts?.error ??
            snapshot?.errors?.concepts ??
            (snapshot ? null : error)
          }
          loading={loading}
        />
        <BoardHeatCard
          testId="market-industries-card"
          title={t("dashboard.industryHeat")}
          emptyKey="dashboard.noIndustryData"
          boards={snapshot?.industries ?? null}
          area={snapshot?.areas.industries}
          areaError={
            snapshot?.areas.industries?.error ??
            snapshot?.errors?.industries ??
            (snapshot ? null : error)
          }
          loading={loading}
        />
      </div>
    </section>
  );
}

function MarketRankingsSection({
  snapshot,
  loading,
  error,
  scope = "all",
}: {
  snapshot: DashboardMarketSnapshot | null;
  loading: boolean;
  error: string | null;
  scope?: "primary" | "secondary" | "all";
}) {
  const { t } = useTranslation();
  const marketArea = snapshot?.areas.market;
  const marketError =
    marketArea?.error ?? snapshot?.errors?.market ?? (snapshot ? null : error);

  const showPrimary = scope === "primary" || scope === "all";
  const showSecondary = scope === "secondary" || scope === "all";

  return (
    <section
      aria-label={t("dashboard.rankings")}
      className="dashboard-rankings-grid space-y-3"
    >
      {showPrimary && (
        <div className="dashboard-primary-rankings-grid">
          <StockRankCard
            testId="top-gainers-card"
            title={t("dashboard.topGainers")}
            rows={snapshot?.topGainers ?? null}
            mode="gain"
            loading={loading}
            error={marketError}
            status={marketArea}
          />
          <StockRankCard
            testId="top-losers-card"
            title={t("dashboard.topLosers")}
            rows={snapshot?.topLosers ?? null}
            mode="loss"
            loading={loading}
            error={marketError}
            status={marketArea}
          />
        </div>
      )}
      {showSecondary && (
        <div className="dashboard-secondary-rankings-grid">
          <StockRankCard
            testId="turnover-leaders-card"
            title={t("dashboard.turnoverLeaders")}
            rows={snapshot?.turnoverLeaders ?? null}
            mode="amount"
            loading={loading}
            error={marketError}
            status={marketArea}
          />
          <StockRankCard
            testId="active-leaders-card"
            title={t("dashboard.activeLeaders")}
            rows={snapshot?.activeLeaders ?? null}
            mode="active"
            loading={loading}
            error={marketError}
            status={marketArea}
          />
        </div>
      )}
    </section>
  );
}

// ── Main Dashboard Component ─────────────────────────────────

export function DashboardView() {
  const { t } = useTranslation();

  const {
    indexes,
    marketSnapshot,
    indexesLoading,
    marketSnapshotLoading,
    indexesError,
    marketSnapshotError,
  } = useMarketDashboard();

  return (
    <Shell>
      <div className="w-full space-y-3">
        {/* Market Overview */}
        <section aria-labelledby="market-overview" className="space-y-3">
          <div id="market-overview" className="flex items-end justify-between gap-3">
            <h2 className="text-[20px] font-semibold tracking-tight">
              {t("dashboard.title")}
            </h2>
            {indexesLoading && (
              <Icon
                name="refresh"
                size={14}
                className="animate-spin text-faint shrink-0 mb-1"
              />
            )}
          </div>
          <IndexStrip indexes={indexes} />
          {indexesError && indexes.length > 0 && (
            <p className="text-[10px] text-muted/60">{t("dashboard.staleData")}</p>
          )}
        </section>

        <MarketRankingsSection
          snapshot={marketSnapshot}
          loading={marketSnapshotLoading}
          error={marketSnapshotError}
          scope="primary"
        />

        <MarketSnapshotSection
          snapshot={marketSnapshot}
          loading={marketSnapshotLoading}
          error={marketSnapshotError}
        />

        <MarketRankingsSection
          snapshot={marketSnapshot}
          loading={marketSnapshotLoading}
          error={marketSnapshotError}
          scope="secondary"
        />
      </div>
    </Shell>
  );
}
