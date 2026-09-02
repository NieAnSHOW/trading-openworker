import { memo } from "react";
import { cn } from "../../lib/cn";
import { getMetricLabel, DISPLAY_ORDER, formatMetricVal, metricSentiment } from "../../lib/formatters";

const SENTIMENT = {
  positive: "text-ok",
  neutral: "text-ink",
  negative: "text-danger",
} as const;

interface Props {
  metrics: Record<string, number>;
  compact?: boolean;
}

export const MetricsCard = memo(function MetricsCard({ metrics, compact = false }: Props) {
  const entries = DISPLAY_ORDER
    .filter((k) => metrics[k] != null)
    .map((k) => ({ k, v: metrics[k] }));

  if (entries.length === 0) return null;

  const shown = compact ? entries.slice(0, 6) : entries;

  return (
    <div className={cn(
      "grid gap-1.5 rounded-xl border border-line/60 bg-panel p-3",
      compact ? "grid-cols-3" : "grid-cols-[repeat(auto-fit,minmax(120px,1fr))]"
    )}>
      {shown.map(({ k, v }) => (
        <div key={k} className="text-center py-1">
          <p className="font-mono text-[10px] text-muted uppercase tracking-[0.16em] font-medium">
            {getMetricLabel(k)}
          </p>
          <p className={cn(
            "text-sm font-bold font-mono tabular-nums mt-0.5",
            SENTIMENT[metricSentiment(k, v)]
          )}>
            {formatMetricVal(k, v)}
          </p>
        </div>
      ))}
    </div>
  );
});
