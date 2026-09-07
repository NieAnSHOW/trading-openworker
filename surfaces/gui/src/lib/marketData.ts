// Market dashboard data layer (行情 page) — ported from Vibe-Trading-Desktop
// `src/lib/stockSdk.ts`, trimmed to what DashboardView consumes: major A-share
// indexes + the full-market snapshot (breadth / emotion / trend / limit ladder /
// board heat / rankings). Index quotes, the all-share batch and the limit pools
// come straight from the `stock-sdk` browser package (JSONP/fetch, no backend);
// concept + industry heat come from our server (10jqka hot list, see
// coworker/dashboard.py) because the client SDK has no board-heat API.

import { StockSDK } from "stock-sdk";
import { getDashboardBoardHeat, getDashboardDailyBars, type DashboardBoardHeatItem } from "../api";

const sdk = new StockSDK();
const SOURCE = "stock-sdk";

// ── DTOs ─────────────────────────────────────────────────────

export interface DashboardIndex {
  code: string;
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  changeAmt: number | null;
  source: string;
  stale: boolean;
  error?: string;
}

export interface DashboardDistributionBucket {
  label: string;
  count: number;
  tone: "up" | "down" | "flat";
}

export interface DashboardMarketBreadth {
  total: number;
  up: number;
  flat: number;
  down: number;
  upPct: number;
  strongUp: number;
  strongDown: number;
  avgChangePct: number;
  distribution: DashboardDistributionBucket[];
}

export interface DashboardEmotionDimension {
  key: "breadth" | "strength" | "highLow" | "limit" | "quality";
  value: number;
}

export interface DashboardMarketEmotion {
  score: number;
  label: "hot" | "warm" | "neutral" | "cool" | "cold";
  dimensions: DashboardEmotionDimension[];
}

export interface DashboardMarketTrend {
  strongUp: number;
  strongDown: number;
  nearHigh: number;
  nearLow: number;
  highLowRatio: number;
}

export interface DashboardLimitTier {
  boards: number;
  count: number;
}

export interface DashboardLimitLadder {
  limitUp: number;
  limitDown: number;
  broken: number;
  tiers: DashboardLimitTier[];
}

export interface DashboardConceptHeat {
  code: string;
  name: string;
  changePct: number | null;
  riseCount: number | null;
  fallCount: number | null;
  leadingStock: string | null;
  leadingStockChangePct: number | null;
}

export interface DashboardStockRankRow {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  amount: number | null;
  turnoverRate: number | null;
}

export type DashboardSnapshotAreaKey =
  | "market"
  | "concepts"
  | "limit"
  | "industries";

export interface DashboardSnapshotArea {
  source: string;
  asOf: string | null;
  stale: boolean;
  available: boolean;
  error?: string;
}

export interface DashboardMarketSnapshot {
  breadth: DashboardMarketBreadth | null;
  emotion: DashboardMarketEmotion | null;
  trend: DashboardMarketTrend | null;
  limit: DashboardLimitLadder | null;
  concepts: DashboardConceptHeat[] | null;
  industries: DashboardConceptHeat[] | null;
  topGainers: DashboardStockRankRow[] | null;
  topLosers: DashboardStockRankRow[] | null;
  turnoverLeaders: DashboardStockRankRow[] | null;
  activeLeaders: DashboardStockRankRow[] | null;
  areas: Record<DashboardSnapshotAreaKey, DashboardSnapshotArea>;
  source: string;
  asOf: string;
  stale: boolean;
  errors?: Partial<Record<"market" | "concepts" | "limit" | "industries", string>>;
}

export interface DashboardDataResult<T> {
  data: T;
  asOf: string;
  stale: boolean;
  error?: string;
}

type SnapshotQuote = {
  code: unknown;
  name: unknown;
  price: unknown;
  changePercent: unknown;
  high52w: unknown;
  low52w: unknown;
  amount: unknown;
  turnoverRate: unknown;
};

type SnapshotLimitItem = {
  continuousBoardCount: unknown;
};

// ── Helpers ──────────────────────────────────────────────────

const now = () => new Date().toISOString();

const MARKET_SNAPSHOT_TTL_MS = 60_000;

let marketSnapshotCache: {
  expiresAt: number;
  result: DashboardDataResult<DashboardMarketSnapshot>;
} | null = null;
let latestMarketSnapshot: DashboardDataResult<DashboardMarketSnapshot> | null = null;
let marketSnapshotRequest: Promise<DashboardDataResult<DashboardMarketSnapshot>> | null = null;

const codeOf = (value: unknown) =>
  String(value ?? "").replace(/^(sh|sz)/i, "").replace(/\.(SH|SZ)$/i, "");

const fin = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const msgOf = (error: unknown) =>
  error instanceof Error ? error.message : "stock-sdk request failed";

const staleResult = <T>(fallback: T, error: unknown): DashboardDataResult<T> => ({
  data: fallback,
  asOf: now(),
  stale: true,
  error: msgOf(error),
});

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const successfulSnapshotArea = (asOf: string): DashboardSnapshotArea => ({
  source: SOURCE,
  asOf,
  stale: false,
  available: true,
});

const failedSnapshotArea = (
  previous: DashboardSnapshotArea | undefined,
  error: string,
): DashboardSnapshotArea => ({
  source: previous?.source ?? SOURCE,
  asOf: previous?.asOf ?? null,
  stale: true,
  available: previous?.available ?? false,
  error,
});

function buildBreadth(rows: SnapshotQuote[]): DashboardMarketBreadth {
  const changes = rows
    .map((row) => fin(row.changePercent))
    .filter((value): value is number => value != null);
  const distribution = [
    { label: "<=-7%", count: 0, tone: "down" as const },
    { label: "-7~-3%", count: 0, tone: "down" as const },
    { label: "-3~0%", count: 0, tone: "down" as const },
    { label: "0%", count: 0, tone: "flat" as const },
    { label: "0~3%", count: 0, tone: "up" as const },
    { label: "3~7%", count: 0, tone: "up" as const },
    { label: ">=7%", count: 0, tone: "up" as const },
  ];

  for (const change of changes) {
    if (change <= -7) distribution[0].count += 1;
    else if (change <= -3) distribution[1].count += 1;
    else if (change < 0) distribution[2].count += 1;
    else if (change === 0) distribution[3].count += 1;
    else if (change < 3) distribution[4].count += 1;
    else if (change < 7) distribution[5].count += 1;
    else distribution[6].count += 1;
  }

  const total = changes.length;
  const up = changes.filter((change) => change > 0).length;
  const flat = changes.filter((change) => change === 0).length;
  const down = changes.filter((change) => change < 0).length;
  return {
    total,
    up,
    flat,
    down,
    upPct: total > 0 ? (up / total) * 100 : 0,
    strongUp: changes.filter((change) => change >= 3).length,
    strongDown: changes.filter((change) => change <= -3).length,
    avgChangePct:
      total > 0 ? changes.reduce((sum, change) => sum + change, 0) / total : 0,
    distribution,
  };
}

function buildTrend(
  rows: SnapshotQuote[],
  breadth: DashboardMarketBreadth,
): DashboardMarketTrend {
  let nearHigh = 0;
  let nearLow = 0;
  for (const row of rows) {
    const price = fin(row.price);
    const high = fin(row.high52w);
    const low = fin(row.low52w);
    if (price != null && high != null && high > 0 && price >= high * 0.98) nearHigh += 1;
    if (price != null && low != null && low > 0 && price <= low * 1.02) nearLow += 1;
  }
  const highLowTotal = nearHigh + nearLow;
  return {
    strongUp: breadth.strongUp,
    strongDown: breadth.strongDown,
    nearHigh,
    nearLow,
    highLowRatio: highLowTotal > 0 ? (nearHigh / highLowTotal) * 100 : 50,
  };
}

function buildLimit(
  upRows: SnapshotLimitItem[],
  downRows: SnapshotLimitItem[],
  brokenRows: SnapshotLimitItem[],
): DashboardLimitLadder {
  const tierCounts = new Map<number, number>();
  for (const row of upRows) {
    const boards = fin(row.continuousBoardCount);
    if (boards != null && boards > 0)
      tierCounts.set(boards, (tierCounts.get(boards) ?? 0) + 1);
  }
  return {
    limitUp: upRows.length,
    limitDown: downRows.length,
    broken: brokenRows.length,
    tiers: [...tierCounts.entries()]
      .map(([boards, count]) => ({ boards, count }))
      .sort((a, b) => b.boards - a.boards),
  };
}
function buildApiBoardHeat(rows: DashboardBoardHeatItem[]): DashboardConceptHeat[] {
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    changePct: fin(row.change_pct),
    riseCount: fin(row.rise_count),
    fallCount: fin(row.fall_count),
    leadingStock: row.leading_stock,
    leadingStockChangePct: fin(row.leading_stock_change_pct),
  }));
}

const RANK_SIZE = 10;

function buildStockRanks(rows: SnapshotQuote[]): {
  topGainers: DashboardStockRankRow[];
  topLosers: DashboardStockRankRow[];
  turnoverLeaders: DashboardStockRankRow[];
  activeLeaders: DashboardStockRankRow[];
} {
  const mapped: DashboardStockRankRow[] = rows.map((row) => ({
    code: codeOf(row.code),
    name: String(row.name ?? row.code ?? ""),
    price: fin(row.price),
    changePct: fin(row.changePercent),
    amount: fin(row.amount),
    turnoverRate: fin(row.turnoverRate),
  }));
  const byChangeDesc = [...mapped].sort(
    (a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity),
  );
  const byChangeAsc = [...mapped].sort(
    (a, b) => (a.changePct ?? Infinity) - (b.changePct ?? Infinity),
  );
  const byAmountDesc = [...mapped].sort(
    (a, b) => (b.amount ?? -Infinity) - (a.amount ?? -Infinity),
  );
  const byTurnoverDesc = [...mapped].sort(
    (a, b) => (b.turnoverRate ?? -Infinity) - (a.turnoverRate ?? -Infinity),
  );
  return {
    topGainers: byChangeDesc.slice(0, RANK_SIZE),
    topLosers: byChangeAsc.slice(0, RANK_SIZE),
    turnoverLeaders: byAmountDesc.slice(0, RANK_SIZE),
    activeLeaders: byTurnoverDesc.slice(0, RANK_SIZE),
  };
}

function buildEmotion(
  breadth: DashboardMarketBreadth,
  trend: DashboardMarketTrend,
  limit: DashboardLimitLadder,
): DashboardMarketEmotion {
  const breadthScore = breadth.total > 0 ? breadth.upPct : 50;
  const strengthScore =
    breadth.total > 0
      ? clampPercent(50 + ((breadth.strongUp - breadth.strongDown) / breadth.total) * 300)
      : 50;
  const highLowScore = trend.highLowRatio;
  const limitDenominator = limit.limitUp + limit.limitDown;
  const limitScore =
    limitDenominator > 0 ? (limit.limitUp / limitDenominator) * 100 : 50;
  const qualityDenominator = limit.limitUp + limit.broken;
  const qualityScore =
    qualityDenominator > 0 ? (limit.limitUp / qualityDenominator) * 100 : 50;
  const score = Math.round(
    (breadthScore + strengthScore + highLowScore + limitScore + qualityScore) / 5,
  );
  const label =
    score >= 70 ? "hot" : score >= 55 ? "warm" : score >= 45 ? "neutral" : score >= 30 ? "cool" : "cold";
  return {
    score,
    label,
    dimensions: [
      { key: "breadth", value: Math.round(breadthScore) },
      { key: "strength", value: Math.round(strengthScore) },
      { key: "highLow", value: Math.round(highLowScore) },
      { key: "limit", value: Math.round(limitScore) },
      { key: "quality", value: Math.round(qualityScore) },
    ],
  };
}

function rejectionMessage(result: PromiseSettledResult<unknown>): string | null {
  return result.status === "rejected" ? msgOf(result.reason) : null;
}

// ── Major A-share indexes for the dashboard header ───────────

const INDEX_CODES = [
  "sh000001", // 上证指数
  "sz399001", // 深证成指
  "sz399006", // 创业板指
  "sh000016", // 上证 50
  "sh000300", // 沪深 300
  "sh000905", // 中证 500
  "sh000688", // 科创 50
  "sz399852", // 中证 1000
];

// ── Public API ───────────────────────────────────────────────

export async function fetchDashboardIndexes(): Promise<
  DashboardDataResult<DashboardIndex[]>
> {
  try {
    const rows = await sdk.quotes.cn(INDEX_CODES);
    const data = rows.map((row) => ({
      code: codeOf(row.code),
      symbol: String(row.code ?? codeOf(row.code)),
      name: String(row.name ?? row.code),
      price: fin(row.price),
      changePct: fin(row.changePercent),
      changeAmt: fin(row.change),
      source: SOURCE,
      stale: false,
    }));
    return { data, asOf: now(), stale: false };
  } catch (error) {
    return staleResult([], error);
  }
}

export async function fetchDashboardMarketSnapshot(): Promise<
  DashboardDataResult<DashboardMarketSnapshot>
> {
  if (marketSnapshotCache && Date.now() < marketSnapshotCache.expiresAt) {
    return marketSnapshotCache.result;
  }
  if (marketSnapshotRequest) return marketSnapshotRequest;

  const request = fetchUncachedDashboardMarketSnapshot();
  marketSnapshotRequest = request;
  try {
    return await request;
  } finally {
    if (marketSnapshotRequest === request) marketSnapshotRequest = null;
  }
}

async function fetchUncachedDashboardMarketSnapshot(): Promise<
  DashboardDataResult<DashboardMarketSnapshot>
> {
  const [marketResult, conceptsResult, industryResult, limitUpResult, limitDownResult, brokenResult] =
    await Promise.allSettled([
      sdk.batch.cn(),
      getDashboardBoardHeat("concept"),
      getDashboardBoardHeat("industry"),
      sdk.marketEvent.ztPool("zt"),
      sdk.marketEvent.ztPool("dt"),
      sdk.marketEvent.ztPool("broken"),
    ]);
  const previous = latestMarketSnapshot?.data;
  const errors: Partial<Record<"market" | "concepts" | "limit" | "industries", string>> = {};
  const asOf = now();

  let breadth = previous?.breadth ?? null;
  let trend = previous?.trend ?? null;
  let topGainers = previous?.topGainers ?? null;
  let topLosers = previous?.topLosers ?? null;
  let turnoverLeaders = previous?.turnoverLeaders ?? null;
  let activeLeaders = previous?.activeLeaders ?? null;
  let marketArea: DashboardSnapshotArea;
  if (marketResult.status === "fulfilled") {
    breadth = buildBreadth(marketResult.value);
    trend = buildTrend(marketResult.value, breadth);
    const ranks = buildStockRanks(marketResult.value);
    topGainers = ranks.topGainers;
    topLosers = ranks.topLosers;
    turnoverLeaders = ranks.turnoverLeaders;
    activeLeaders = ranks.activeLeaders;
    marketArea = successfulSnapshotArea(asOf);
  } else {
    const error = rejectionMessage(marketResult) ?? "market snapshot unavailable";
    errors.market = error;
    marketArea = failedSnapshotArea(previous?.areas.market, error);
  }

  let concepts = previous?.concepts ?? null;
  let conceptsArea: DashboardSnapshotArea;
  if (conceptsResult.status === "fulfilled") {
    concepts = buildApiBoardHeat(conceptsResult.value.data);
    conceptsArea = {
      ...successfulSnapshotArea(conceptsResult.value.as_of),
      source: conceptsResult.value.source,
    };
  } else {
    const error = rejectionMessage(conceptsResult) ?? "concept snapshot unavailable";
    errors.concepts = error;
    conceptsArea = failedSnapshotArea(previous?.areas.concepts, error);
  }

  let industries = previous?.industries ?? null;
  let industriesArea: DashboardSnapshotArea;
  if (industryResult.status === "fulfilled") {
    industries = buildApiBoardHeat(industryResult.value.data);
    industriesArea = {
      ...successfulSnapshotArea(industryResult.value.as_of),
      source: industryResult.value.source,
    };
  } else {
    const error = rejectionMessage(industryResult) ?? "industry snapshot unavailable";
    errors.industries = error;
    industriesArea = failedSnapshotArea(previous?.areas.industries, error);
  }

  let limit = previous?.limit ?? null;
  let limitArea: DashboardSnapshotArea;
  const limitError = [limitUpResult, limitDownResult, brokenResult]
    .map(rejectionMessage)
    .find((message): message is string => message != null);
  if (limitError) {
    errors.limit = limitError;
    limitArea = failedSnapshotArea(previous?.areas.limit, limitError);
  } else if (
    limitUpResult.status === "fulfilled"
    && limitDownResult.status === "fulfilled"
    && brokenResult.status === "fulfilled"
  ) {
    limit = buildLimit(limitUpResult.value, limitDownResult.value, brokenResult.value);
    limitArea = successfulSnapshotArea(asOf);
  } else {
    const error = "limit snapshot unavailable";
    errors.limit = error;
    limitArea = failedSnapshotArea(previous?.areas.limit, error);
  }

  const areas = { market: marketArea, concepts: conceptsArea, industries: industriesArea, limit: limitArea };
  const stale = Object.values(areas).some((area) => area.stale);
  const successfulTimes = Object.values(areas)
    .map((area) => area.asOf)
    .filter((value): value is string => value != null)
    .sort();
  const latestSuccessfulAsOf = successfulTimes[successfulTimes.length - 1] ?? asOf;
  const data: DashboardMarketSnapshot = {
    breadth,
    emotion: breadth && trend && limit ? buildEmotion(breadth, trend, limit) : null,
    trend,
    limit,
    concepts,
    industries,
    topGainers,
    topLosers,
    turnoverLeaders,
    activeLeaders,
    areas,
    source: SOURCE,
    asOf: latestSuccessfulAsOf,
    stale,
    ...(stale ? { errors } : {}),
  };
  const result: DashboardDataResult<DashboardMarketSnapshot> = {
    data,
    asOf: latestSuccessfulAsOf,
    stale,
    ...(stale
      ? { error: errors.market ?? errors.concepts ?? errors.industries ?? errors.limit }
      : {}),
  };

  latestMarketSnapshot = result;
  if (!stale) {
    marketSnapshotCache = {
      expiresAt: Date.now() + MARKET_SNAPSHOT_TTL_MS,
      result,
    };
  }

  return result;
}

// -- Watchlist (自选股) ----------------------------------------

export interface WatchlistQuote {
  code: string;
  name: string | null;
  price: number | null;
  changePct: number | null;
  changeAmt: number | null;
  stale: boolean;
}

export interface PriceBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchWatchlistQuotes(
  codes: string[],
): Promise<DashboardDataResult<Record<string, WatchlistQuote>>> {
  try {
    const rows = await sdk.quotes.cnSimple(codes);
    const data: Record<string, WatchlistQuote> = {};
    for (const row of rows) {
      const code = codeOf(row.code);
      data[code] = {
        code,
        name: String(row.name ?? code),
        price: fin(row.price),
        changePct: fin(row.changePercent),
        changeAmt: fin(row.change),
        stale: false,
      };
    }
    return { data, asOf: now(), stale: false };
  } catch (error) {
    return staleResult({}, error);
  }
}

export async function fetchWatchlistDailyBars(
  code: string,
): Promise<DashboardDataResult<PriceBar[]>> {
  try {
    // Server-side Tencent fqkline daily bars (coworker/dashboard.py) — the
    // browser JSONP kline.cn source this replaces failed intermittently.
    const res = await getDashboardDailyBars(code);
    return {
      data: res.data.map((row) => ({
        time: String(row.time ?? ""),
        open: fin(row.open) ?? 0,
        high: fin(row.high) ?? 0,
        low: fin(row.low) ?? 0,
        close: fin(row.close) ?? 0,
        volume: fin(row.volume) ?? 0,
      })),
      asOf: res.as_of,
      stale: false,
    };
  } catch (error) {
    return staleResult([], error);
  }
}

export async function fetchWatchlistIntradayBars(
  code: string,
): Promise<DashboardDataResult<PriceBar[]>> {
  try {
    const rows = await sdk.kline.cnMinute(code, { period: "1" });
    const data = rows.map((row) => ({
      time: String(row.time ?? ""),
      open: fin(row.open) ?? 0,
      high: fin(row.high) ?? 0,
      low: fin(row.low) ?? 0,
      close: fin(row.close) ?? 0,
      volume: fin(row.volume) ?? 0,
    }));
    return { data, asOf: now(), stale: false };
  } catch (error) {
    return staleResult([], error);
  }
}
