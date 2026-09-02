import i18n from "i18next";

const METRIC_LABELS_EN: Record<string, string> = {
  total_return: "Total Return",
  annual_return: "Annual",
  sharpe: "Sharpe",
  max_drawdown: "Max DD",
  win_rate: "Win Rate",
  trade_count: "Trades",
  final_value: "Final Value",
  calmar: "Calmar",
  sortino: "Sortino",
  profit_loss_ratio: "P/L Ratio",
  max_consecutive_loss: "Max Consec. Loss",
  avg_holding_days: "Avg Hold Days",
  benchmark_return: "Benchmark",
  excess_return: "Excess Return",
  information_ratio: "IR",
  annualized_return: "Annualized",
  calmar_ratio: "Calmar Ratio",
  sortino_ratio: "Sortino Ratio",
  volatility: "Volatility",
  profit_factor: "Profit Factor",
  avg_win: "Avg Win",
  avg_loss: "Avg Loss",
  max_consecutive_losses: "Max Consec. Losses",
  exposure_time: "Exposure",
  avg_holding_period: "Avg Hold Period",
};

const METRIC_LABELS_ZH: Record<string, string> = {
  total_return: "总收益率",
  annual_return: "年化",
  sharpe: "夏普比率",
  max_drawdown: "最大回撤",
  win_rate: "胜率",
  trade_count: "交易次数",
  final_value: "最终净值",
  calmar: "卡尔马",
  sortino: "索提诺",
  profit_loss_ratio: "盈亏比",
  max_consecutive_loss: "最大连续亏损",
  avg_holding_days: "平均持仓天数",
  benchmark_return: "基准收益",
  excess_return: "超额收益",
  information_ratio: "IR",
  annualized_return: "年化收益",
  calmar_ratio: "卡尔马比率",
  sortino_ratio: "索提诺比率",
  volatility: "波动率",
  profit_factor: "盈亏因子",
  avg_win: "平均盈利",
  avg_loss: "平均亏损",
  max_consecutive_losses: "最大连续亏损次数",
  exposure_time: "持仓时间",
  avg_holding_period: "平均持仓周期",
};

// Canonical metric key set (English labels). Localized lookups go through getMetricLabel.
export const METRIC_LABELS = METRIC_LABELS_EN;

export function getMetricLabel(k: string): string {
  const lang = i18n.language;
  if (lang.startsWith("zh")) return METRIC_LABELS_ZH[k] || METRIC_LABELS_EN[k] || k;
  return METRIC_LABELS_EN[k] || k;
}

const PCT_KEYS = ["total_return", "annual_return", "win_rate", "max_drawdown", "benchmark_return", "excess_return", "annualized_return", "volatility", "exposure_time"];
const RATIO_KEYS = ["sharpe", "calmar", "sortino", "profit_loss_ratio", "information_ratio", "calmar_ratio", "sortino_ratio", "profit_factor"];
const INT_KEYS = ["trade_count", "max_consecutive_loss", "max_consecutive_losses"];
const NEUTRAL_KEYS = ["trade_count", "avg_holding_days", "avg_holding_period", "final_value"];

export function formatMetricVal(k: string, v: number): string {
  if (PCT_KEYS.includes(k)) {
    const sign = v > 0 ? "+" : "";
    return `${sign}${(v * 100).toFixed(2)}%`;
  }
  if (RATIO_KEYS.includes(k)) {
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}`;
  }
  if (INT_KEYS.includes(k)) return String(Math.round(v));
  if (k === "final_value") return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (k === "avg_holding_days" || k === "avg_holding_period") return v.toFixed(1);
  return v.toFixed(4);
}

export function metricSentiment(k: string, v: number): "positive" | "neutral" | "negative" {
  if (NEUTRAL_KEYS.includes(k)) return "neutral";
  if (k === "max_drawdown") return v > -0.05 ? "positive" : v > -0.2 ? "neutral" : "negative";
  if (k === "max_consecutive_loss" || k === "max_consecutive_losses") return v <= 3 ? "positive" : v <= 6 ? "neutral" : "negative";
  if (k === "win_rate") return v >= 0.5 ? "positive" : v >= 0.35 ? "neutral" : "negative";
  if (k === "sharpe" || k === "calmar" || k === "sortino" || k === "calmar_ratio" || k === "sortino_ratio") return v >= 1.0 ? "positive" : v >= 0.3 ? "neutral" : "negative";
  if (k === "information_ratio") return v >= 0.5 ? "positive" : v >= 0 ? "neutral" : "negative";
  if (k === "profit_factor") return v >= 1.5 ? "positive" : v >= 1.0 ? "neutral" : "negative";
  return v > 0 ? "positive" : v === 0 ? "neutral" : "negative";
}

export const DISPLAY_ORDER = [
  "total_return", "annualized_return", "sharpe", "max_drawdown", "volatility", "win_rate", "trade_count",
  "calmar_ratio", "sortino_ratio", "profit_factor", "avg_win", "avg_loss",
  "max_consecutive_losses", "exposure_time", "avg_holding_period",
  "annual_return", "calmar", "sortino", "profit_loss_ratio", "max_consecutive_loss", "avg_holding_days",
  "benchmark_return", "excess_return", "information_ratio", "final_value",
];

export function abbreviateNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (abs >= 1e4) return (v / 1e3).toFixed(0) + "K";
  return v.toLocaleString();
}
