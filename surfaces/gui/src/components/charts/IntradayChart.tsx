// Intraday (分时) chart: price line + volume sub-pane, ported from
// Vibe-Trading-Desktop components/charts/IntradayChart.tsx.
import { useEffect, useMemo, useRef } from "react";
import type { PriceBar } from "../../api";
import { getChartTheme } from "../../lib/chart-theme";
import { abbreviateNum } from "../../lib/formatters";
import { echarts, type EChartsInstance } from "../../lib/echarts";
import { useDarkMode } from "../../hooks/useDarkMode";
import { cn } from "../../lib/cn";

interface IntradayChartProps {
  data: PriceBar[];
  height?: number;
  fill?: boolean;
  testId?: string;
}

function timeLabel(value: string): string {
  const match = value.match(/[T\s](\d{2}:\d{2})/);
  return match?.[1] ?? value;
}

export function IntradayChart({
  data,
  height = 300,
  fill = false,
  testId = "intraday-chart",
}: IntradayChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const { dark } = useDarkMode();
  const labels = useMemo(() => data.map((bar) => timeLabel(bar.time)), [data]);

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    const chart = echarts.init(containerRef.current);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [data.length === 0, dark]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || data.length === 0) return;

    const theme = getChartTheme();
    const volume = data.map((bar) => ({
      value: bar.volume,
      itemStyle: {
        color: bar.close >= bar.open ? theme.volumeUp : theme.volumeDown,
      },
    }));

    chart.setOption({
      backgroundColor: "transparent",
      animation: false,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.tooltipText, fontSize: 11 },
      },
      grid: [
        { left: 8, right: 12, top: 18, height: "55%", containLabel: true },
        { left: 8, right: 12, top: "72%", bottom: 24, containLabel: true },
      ],
      xAxis: [
        {
          type: "category",
          data: labels,
          boundaryGap: false,
          axisLine: { lineStyle: { color: theme.axisColor } },
          axisLabel: { color: theme.textColor, fontSize: 10 },
        },
        {
          type: "category",
          gridIndex: 1,
          data: labels,
          boundaryGap: false,
          axisLine: { lineStyle: { color: theme.axisColor } },
          axisLabel: { color: theme.textColor, fontSize: 10 },
        },
      ],
      yAxis: [
        {
          type: "value",
          scale: true,
          splitLine: { lineStyle: { color: theme.gridColor } },
          axisLabel: { color: theme.textColor, fontSize: 10 },
        },
        {
          type: "value",
          gridIndex: 1,
          splitLine: { lineStyle: { color: theme.gridColor } },
          axisLabel: {
            color: theme.textColor,
            fontSize: 10,
            formatter: (value: number) => abbreviateNum(value),
          },
        },
      ],
      dataZoom: [{ type: "inside", xAxisIndex: [0, 1] }],
      series: [
        {
          name: "Price",
          type: "line",
          data: data.map((bar) => bar.close),
          symbol: "none",
          lineStyle: { color: theme.infoColor, width: 1.5 },
          areaStyle: { color: `${theme.infoColor}1f` },
        },
        {
          name: "Vol",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volume,
        },
      ],
    });
  }, [dark, data, labels]);

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      aria-label="Intraday chart"
      className={cn(fill && "h-full min-h-0")}
      style={fill ? undefined : { height }}
    />
  );
}
