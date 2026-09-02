/**
 * 投研工具 (Research) — the unified entry for the quant research pages.
 * One first-level nav row; the page shows tabs (Alpha Zoo / Reports) that
 * switch the embedded views. Each tab keeps its own internal view state.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { AlphaZooView } from "./AlphaZooView";
import { ReportsListView, type ReportsSubView } from "./ReportsView";
import { RunDetailView } from "./RunDetailView";
import { RunCompareView } from "./RunCompareView";

type ResearchTab = "alphazoo" | "reports";

export function ResearchView() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ResearchTab>("alphazoo");
  // Reports drill-down state lives here (not inside ReportsListView) so that
  // switching tabs and coming back keeps your place.
  const [reportsView, setReportsView] = useState<ReportsSubView>({ kind: "list" });

  const openDetail = (runId: string) => setReportsView({ kind: "detail", runId });
  const openCompare = () => setReportsView({ kind: "compare" });
  const backToList = () => setReportsView({ kind: "list" });

  const tabs: { id: ResearchTab; label: string }[] = [
    { id: "alphazoo", label: t("research.tabAlphaZoo") },
    { id: "reports", label: t("research.tabReports") },
  ];

  return (
    <div className="w-full h-full flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-4 pt-3 md:px-6 border-b border-line shrink-0">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            data-testid={`research-tab-${id}`}
            className={cn(
              "px-3.5 py-2 text-sm rounded-t-lg border border-b-0 transition-colors -mb-px",
              tab === id
                ? "bg-panel border-line text-ink font-medium"
                : "bg-transparent border-transparent text-muted hover:text-ink hover:bg-chromeHover",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden bg-canvas">
        {tab === "alphazoo" ? (
          <AlphaZooView />
        ) : reportsView.kind === "detail" ? (
          <RunDetailView runId={reportsView.runId} onBack={backToList} />
        ) : reportsView.kind === "compare" ? (
          <RunCompareView />
        ) : (
          <ReportsListView onOpenDetail={openDetail} onOpenCompare={openCompare} />
        )}
      </div>
    </div>
  );
}
