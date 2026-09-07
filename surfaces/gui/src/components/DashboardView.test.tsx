// DashboardView (行情): renders the index strip + snapshot cards from the
// marketData layer. Fetchers are mocked at the module boundary — the page's
// polling hook runs for real on top of them.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DashboardDataResult,
  DashboardIndex,
  DashboardMarketSnapshot,
} from "../lib/marketData";
import { DashboardView } from "./DashboardView";

vi.mock("../lib/marketData", () => ({
  fetchDashboardIndexes: vi.fn(),
  fetchDashboardMarketSnapshot: vi.fn(),
}));

import { fetchDashboardIndexes, fetchDashboardMarketSnapshot } from "../lib/marketData";

const index: DashboardIndex = {
  code: "000001",
  symbol: "sh000001",
  name: "上证指数",
  price: 3021.44,
  changePct: 1.23,
  changeAmt: 36.7,
  source: "test",
  stale: false,
};

const snapshot: DashboardMarketSnapshot = {
  breadth: {
    total: 2,
    up: 1,
    flat: 0,
    down: 1,
    upPct: 50,
    strongUp: 1,
    strongDown: 1,
    avgChangePct: 0.4,
    distribution: [
      { label: "0%", count: 0, tone: "flat" },
      { label: "0~3%", count: 1, tone: "up" },
      { label: "0%", count: 0, tone: "flat" },
      { label: "-3~0%", count: 1, tone: "down" },
      { label: "3~7%", count: 0, tone: "up" },
      { label: "-7~-3%", count: 0, tone: "down" },
      { label: ">=7%", count: 0, tone: "up" },
    ],
  },
  emotion: null,
  trend: null,
  limit: null,
  concepts: [{ code: "885566", name: "算力租赁", changePct: 3.42, riseCount: null, fallCount: null, leadingStock: null, leadingStockChangePct: null }],
  industries: [],
  topGainers: [
    { code: "600519", name: "贵州茅台", price: 1500, changePct: 2.1, amount: 450000, turnoverRate: 0.6 },
  ],
  topLosers: [],
  turnoverLeaders: [],
  activeLeaders: [],
  areas: {
    market: { source: "test", asOf: "2026-09-07T01:00:00Z", stale: false, available: true },
    concepts: { source: "test", asOf: "2026-09-07T01:00:00Z", stale: false, available: true },
    limit: { source: "test", asOf: "2026-09-07T01:00:00Z", stale: false, available: true },
    industries: { source: "test", asOf: "2026-09-07T01:00:00Z", stale: false, available: true },
  },
  source: "test",
  asOf: "2026-09-07T01:00:00Z",
  stale: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DashboardView", () => {
  it("renders index cards and snapshot sections from fetched data", async () => {
    vi.mocked(fetchDashboardIndexes).mockResolvedValue({
      data: [index],
      asOf: "2026-09-07T01:00:00Z",
      stale: false,
    } as DashboardDataResult<DashboardIndex[]>);
    vi.mocked(fetchDashboardMarketSnapshot).mockResolvedValue({
      data: snapshot,
      asOf: "2026-09-07T01:00:00Z",
      stale: false,
    } as DashboardDataResult<DashboardMarketSnapshot>);

    render(<DashboardView />);

    expect(await screen.findByText("上证指数")).toBeTruthy();
    expect(screen.getByText("+1.23%")).toBeTruthy();
    expect(screen.getByTestId("market-breadth-card")).toBeTruthy();
    expect(screen.getByTestId("market-concepts-card").textContent).toContain("算力租赁");
    expect(screen.getByTestId("top-gainers-card").textContent).toContain("贵州茅台");
  });

  it("shows loading placeholders while data is in flight", async () => {
    // tsconfig lib is ES2020 — no Promise.withResolvers; executor form it is.
    vi.mocked(fetchDashboardIndexes).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchDashboardMarketSnapshot).mockReturnValue(new Promise(() => {}));

    render(<DashboardView />);

    expect((await screen.findAllByText("Loading…")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("market-breadth-card").textContent).not.toContain(
      "Advance ratio",
    );
  });
});
