// Shared building blocks for the 投研工具 (Research) pages, following the
// AlphaZooView port conventions: tailwind utilities over theme tokens, no
// react-router (view switches are component state), no shadcn primitives.
import type { ReactNode } from "react";

export const panel = "border border-line rounded-lg bg-panel";
export const panelHead = "px-3 py-2 border-b border-line flex items-center justify-between gap-2 min-w-0";
export const panelLabel = "text-[11px] font-semibold uppercase tracking-[0.08em] text-faint";
export const btnGhost =
  "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:bg-chromeHover disabled:opacity-50";

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px] " +
        className
      }
      aria-hidden="true"
    />
  );
}

/** Page header block: fixed-English kicker + title + optional subtitle. */
export function ViewHeader({
  kicker,
  title,
  sub,
  actions,
}: {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-faint">{kicker}</p>
        <h1 className="text-lg font-semibold text-ink leading-tight">{title}</h1>
        {sub != null && <p className="text-sm text-muted mt-0.5">{sub}</p>}
      </div>
      {actions != null && <div className="flex shrink-0 flex-wrap items-center gap-2 pb-0.5">{actions}</div>}
    </header>
  );
}

