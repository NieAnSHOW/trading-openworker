import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchlistView } from "./WatchlistView";

vi.mock("../api", () => ({
  fetchWatchlist: vi.fn(),
  addWatchlistStock: vi.fn(),
  deleteWatchlistStock: vi.fn(),
}));

vi.mock("../lib/marketData", () => ({
  fetchWatchlistQuotes: vi.fn(),
  fetchWatchlistDailyBars: vi.fn(),
  fetchWatchlistIntradayBars: vi.fn(),
}));

import {
  fetchWatchlist,
  addWatchlistStock,
} from "../api";
import {
  fetchWatchlistQuotes,
  fetchWatchlistDailyBars,
  fetchWatchlistIntradayBars,
} from "../lib/marketData";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WatchlistView", () => {
  it("renders the stock list and auto-selects the first pick", async () => {
    vi.mocked(fetchWatchlist).mockResolvedValue([
      { code: "600519", name: null, market: "a_stock", added_at: "2026-01-01T00:00:00+0000" },
      { code: "000001", name: null, market: "a_stock", added_at: "2026-01-01T00:00:00+0000" },
    ]);
    vi.mocked(fetchWatchlistQuotes).mockResolvedValue({
      data: {
        "600519": { code: "600519", name: "贵州茅台", price: 1700, changePct: 1.2, changeAmt: 20, stale: false },
        "000001": { code: "000001", name: "平安银行", price: 11.5, changePct: -0.4, changeAmt: -0.05, stale: false },
      },
      asOf: "2026-01-01T00:00:00Z",
      stale: false,
    });
    vi.mocked(fetchWatchlistDailyBars).mockResolvedValue({ data: [], asOf: "2026-01-01T00:00:00Z", stale: false });
    vi.mocked(fetchWatchlistIntradayBars).mockResolvedValue({ data: [], asOf: "2026-01-01T00:00:00Z", stale: false });

    render(<WatchlistView />);

    expect(
      await screen.findByTestId("watchlist-card-600519"),
    ).toBeTruthy();
    expect(screen.getByTestId("watchlist-card-000001")).toBeTruthy();
    // Auto-select: the first stock's detail button is aria-pressed.
    expect(
      screen
        .getByTestId("watchlist-card-select-600519")
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows the empty state when the server list is empty", async () => {
    vi.mocked(fetchWatchlist).mockResolvedValue([]);

    render(<WatchlistView />);

    expect(await screen.findByText("No stocks yet — add a code above")).toBeTruthy();
    expect(screen.queryByTestId("watchlist-workspace")).toBeNull();
  });

  it("surfaces malformed-code validation without calling the API", async () => {
    vi.mocked(fetchWatchlist).mockResolvedValue([
      { code: "600519", name: null, market: "a_stock", added_at: "2026-01-01T00:00:00+0000" },
    ]);
    vi.mocked(fetchWatchlistQuotes).mockResolvedValue({
      data: {},
      asOf: "2026-01-01T00:00:00Z",
      stale: false,
    });
    vi.mocked(fetchWatchlistDailyBars).mockResolvedValue({ data: [], asOf: "2026-01-01T00:00:00Z", stale: false });
    vi.mocked(fetchWatchlistIntradayBars).mockResolvedValue({ data: [], asOf: "2026-01-01T00:00:00Z", stale: false });

    render(<WatchlistView />);

    const input = await screen.findByLabelText("6-digit stock code");
    fireEvent.change(input, { target: { value: "12ab" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText("Enter a 6-digit stock code")).toBeTruthy();
    expect(addWatchlistStock).not.toHaveBeenCalled();
  });
});
