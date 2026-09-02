// Chart palette read from the CSS custom properties in styles.css (light/dark
// via [data-theme]). Adapted from Vibe-Trading's chart-theme: target tokens are
// already hex, so no HSL conversion; dark is data-theme, not a `.dark` class.

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isChinese(): boolean {
  return (document.documentElement.lang || navigator.language || "").startsWith("zh");
}

export interface ChartTheme {
  gridColor: string;
  textColor: string;
  axisColor: string;
  upColor: string;
  downColor: string;
  maColors: string[];
  bollColor: string;
  volumeUp: string;
  volumeDown: string;
  infoColor: string;
  warningColor: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
}

let _cache: ChartTheme | null = null;
let _cacheKey = "";

function buildTheme(): ChartTheme {
  const cn = isChinese();
  const isDark = document.documentElement.dataset.theme === "dark";

  const successHex = css("--ok") || "#22c55e";
  const dangerHex = css("--danger") || "#ef4444";
  const infoHex = css("--accent") || "#3b82f6";
  const warningHex = css("--warn-ink") || "#f59e0b";
  const gridHex = css("--chart-grid") || (isDark ? "#1e2433" : "#e5e7eb");
  const textHex = css("--chart-text") || "#6b7280";
  const axisHex = css("--chart-axis") || "#374151";

  // Locale-aware candlestick colors: China = red up / green down
  const upHex = cn ? dangerHex : successHex;
  const downHex = cn ? successHex : dangerHex;

  return {
    gridColor: gridHex,
    textColor: textHex,
    axisColor: axisHex,
    upColor: upHex,
    downColor: downHex,
    maColors: [warningHex, "#8b5cf6", infoHex],
    bollColor: "rgba(99,102,241,0.5)",
    volumeUp: upHex + "66",
    volumeDown: downHex + "66",
    infoColor: infoHex,
    warningColor: warningHex,
    tooltipBg: isDark ? "rgba(10,14,22,0.92)" : "rgba(255,255,255,0.96)",
    tooltipBorder: isDark ? "#1e2433" : "#e5e7eb",
    tooltipText: isDark ? "#d1d5db" : "#374151",
  };
}

export function getChartTheme(): ChartTheme {
  const key = `${document.documentElement.dataset.theme || ""}|${document.documentElement.lang || navigator.language}`;
  if (_cache && _cacheKey === key) return _cache;
  _cache = buildTheme();
  _cacheKey = key;
  return _cache;
}
