/**
 * Alpha Zoo — browse / detail / bench / compare views over the vendored Vibe-Trading
 * factor engine (coworker/factors + /v1/alphazoo REST).
 *
 * Ported from Vibe-Trading frontend/src/pages/AlphaZoo.tsx. Differences from upstream:
 * no react-router (OpenWorker switches surfaces via state), poll-based job status
 * instead of SSE streams, theme-token styling, no chart dependency (stacked CSS bars).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import {
  createAlphaBench,
  createAlphaCompare,
  getAlpha,
  getAlphaBenchStatus,
  getAlphaCompareStatus,
  listAlphas,
  type AlphaBenchProgress,
  type AlphaBenchResult,
  type AlphaBenchTopRow,
  type AlphaCategory,
  type AlphaCompareResult,
  type AlphaDetail,
  type AlphaSummary,
} from "../api";

type ZooView =
  | { kind: "browse" }
  | { kind: "detail"; alphaId: string }
  | { kind: "bench"; prefill?: BenchPrefill }
  | { kind: "compare"; ids?: string[] };

interface BenchPrefill {
  zoo?: string;
  universe?: string;
  period?: string;
}

const ZOO_CARDS = [
  { id: "qlib158", title: "Qlib 158", approxCount: 154 },
  { id: "alpha101", title: "Kakushadze 101", approxCount: 101 },
  { id: "gtja191", title: "GTJA 191", approxCount: 191 },
  { id: "academic", title: "Academic", approxCount: 6 },
];

const UNIVERSE_OPTIONS = [
  { value: "csi300", label: "CSI 300 (China A)" },
  { value: "sp500", label: "S&P 500 (US)" },
  { value: "btc-usdt", label: "BTC-USDT (Crypto)" },
];

const SORT_OPTIONS = [
  { value: "ir", key: "ir" },
  { value: "ic_mean", key: "icMean" },
  { value: "ic_positive_ratio", key: "icPositiveRatio" },
  { value: "ic_count", key: "icCount" },
];

const PAGE_SIZE = 50;

function fmtNum(v: unknown, digits = 3): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function metaString(meta: Record<string, unknown>, key: string): string {
  const v = meta[key];
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function Spinner({ className = "" }: { className?: string }) {
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

function CategoryBadge({ category }: { category: AlphaCategory }) {
  const { t } = useTranslation();
  const tone =
    category === "alive"
      ? "bg-tealInk/10 text-tealInk"
      : category === "reversed"
        ? "bg-warnInk/10 text-warnInk"
        : "bg-red-500/10 text-red-600 dark:text-red-400";
  const label =
    category === "alive"
      ? t("alphaZoo.alive")
      : category === "reversed"
        ? t("alphaZoo.reversed")
        : t("alphaZoo.dead");
  return (
    <span className={"inline-block px-2 py-0.5 rounded-full text-[10px] font-medium " + tone}>
      {label}
    </span>
  );
}

function ViewHeader({ title, sub }: { title: ReactNode; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-faint">Alpha Zoo</p>
      <h1 className="text-lg font-semibold text-ink leading-tight">{title}</h1>
      {sub && <p className="text-sm text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

function BackLink({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-sm text-muted hover:text-ink inline-flex items-center gap-1"
    >
      <Icon name="arrowLeft" size={14} /> {label}
    </button>
  );
}

const panel = "border border-line rounded-lg bg-panel";
const input =
  "w-full px-3 py-2 rounded-lg border border-line bg-panel text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50";
const btnPrimary =
  "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:bg-chromeHover disabled:opacity-50";

export function AlphaZooView() {
  const [view, setView] = useState<ZooView>({ kind: "browse" });
  const back = useCallback(() => setView({ kind: "browse" }), []);
  if (view.kind === "detail") {
    return (
      <DetailView
        alphaId={view.alphaId}
        onBack={back}
        onOpenBench={(p) => setView({ kind: "bench", prefill: p })}
      />
    );
  }
  if (view.kind === "bench") {
    return <BenchView prefill={view.prefill} onBack={back} />;
  }
  if (view.kind === "compare") {
    return (
      <CompareView
        ids={view.ids}
        onBack={back}
        onOpenDetail={(id) => setView({ kind: "detail", alphaId: id })}
      />
    );
  }
  return (
    <BrowseView
      onOpenDetail={(id) => setView({ kind: "detail", alphaId: id })}
      onOpenBench={() => setView({ kind: "bench" })}
      onOpenCompare={(ids) => setView({ kind: "compare", ids })}
    />
  );
}

/* ---------- Browse ---------- */

function BrowseView({
  onOpenDetail,
  onOpenBench,
  onOpenCompare,
}: {
  onOpenDetail: (id: string) => void;
  onOpenBench: () => void;
  onOpenCompare: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [alphas, setAlphas] = useState<AlphaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zooFilter, setZooFilter] = useState("");
  const [themeFilter, setThemeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Dynamic multi-select membership — Set is the right structure here (toggle in place).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    listAlphas({ zoo: zooFilter || undefined, theme: themeFilter || undefined, limit: 1000 })
      .then((res) => {
        if (!alive) return;
        setAlphas(res.alphas ?? []);
      })
      .catch(() => {
        if (alive) setLoadError(t("alphaZoo.noAlphasMatch"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [zooFilter, themeFilter, t]);

  const themeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of alphas) for (const th of a.theme || []) set.add(th);
    return Array.from(set).sort();
  }, [alphas]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return alphas;
    return alphas.filter(
      (a) => a.id.toLowerCase().includes(q) || (a.nickname || "").toLowerCase().includes(q),
    );
  }, [alphas, search]);

  const visible = filtered.slice(0, visibleCount);
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="w-full p-4 md:p-6 space-y-4 overflow-y-auto" data-testid="alpha-zoo-workspace">
      <ViewHeader
        title={
          loading
            ? t("alphaZoo.prebuiltAlphaLoading")
            : t("alphaZoo.prebuiltAlpha", { count: alphas.length })
        }
        sub={t("alphaZoo.browseDesc")}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {ZOO_CARDS.map((z) => {
          const active = zooFilter === z.id;
          return (
            <button
              key={z.id}
              type="button"
              onClick={() => setZooFilter(active ? "" : z.id)}
              className={
                "text-left border rounded-lg p-3 space-y-2 transition bg-panel hover:border-accent/50 " +
                (active ? "border-accent ring-1 ring-accent/30" : "border-line")
              }
            >
              <div className="flex items-center justify-between">
                <Icon name="book" size={16} className="text-accent" />
                <span className="text-xs font-mono text-faint">{z.approxCount}</span>
              </div>
              <h3 className="font-semibold text-sm leading-tight text-ink">{z.title}</h3>
            </button>
          );
        })}
      </div>

      {loadError && <p className="text-xs text-red-600 dark:text-red-400">{loadError}</p>}

      <div className="grid lg:grid-cols-[15rem_1fr] gap-4">
        <aside className={panel + " p-3 space-y-3 self-start"}>
          <div>
            <label htmlFor="alpha-search" className="text-xs text-muted block mb-1">
              {t("alphaZoo.search")}
            </label>
            <div className="relative">
              <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <input
                id="alpha-search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
                placeholder={t("alphaZoo.searchPlaceholder")}
                className={input + " pl-8"}
              />
            </div>
          </div>
          <div>
            <label htmlFor="alpha-zoo-filter" className="text-xs text-muted block mb-1">
              {t("alphaZoo.zoo")}
            </label>
            <select id="alpha-zoo-filter" value={zooFilter} onChange={(e) => setZooFilter(e.target.value)} className={input}>
              <option value="">{t("alphaZoo.allZoos")}</option>
              {ZOO_CARDS.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="alpha-theme-filter" className="text-xs text-muted block mb-1">
              {t("alphaZoo.theme")}
            </label>
            <select id="alpha-theme-filter" value={themeFilter} onChange={(e) => setThemeFilter(e.target.value)} className={input}>
              <option value="">{t("alphaZoo.allThemes")}</option>
              {themeOptions.map((tname) => (
                <option key={tname} value={tname}>
                  {t("alphaZoo.themes." + tname, { defaultValue: tname })}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2 pt-1">
            <button
              type="button"
              className={btnGhost + " w-full justify-center"}
              disabled={selected.size < 2}
              title={t("alphaZoo.compareTooltip")}
              onClick={() => onOpenCompare([...selected])}
            >
              {t("alphaZoo.compare")}
              {selected.size >= 2 ? ` (${selected.size})` : ""}
            </button>
            <button type="button" className={btnPrimary + " w-full justify-center"} onClick={onOpenBench}>
              {t("alphaZoo.runBenchmark")}
            </button>
          </div>
        </aside>

        <section className={panel + " min-w-0 overflow-auto"} data-testid="alpha-zoo-catalogue">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="w-10 px-3 py-2.5" />
                <th className="text-left px-4 py-2.5 text-muted font-medium">{t("alphaZoo.id")}</th>
                <th className="text-left px-4 py-2.5 text-muted font-medium">{t("alphaZoo.zoo")}</th>
                <th className="text-left px-4 py-2.5 text-muted font-medium">{t("alphaZoo.theme")}</th>
                <th className="text-left px-4 py-2.5 text-muted font-medium hidden md:table-cell">
                  {t("alphaZoo.universe")}
                </th>
                <th className="text-right px-4 py-2.5 text-muted font-medium">{t("alphaZoo.decayDays")}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted">
                    <Spinner /> {t("alphaZoo.loadingAlphas")}
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted">
                    {t("alphaZoo.noAlphasMatch")}
                  </td>
                </tr>
              ) : (
                visible.map((a) => (
                  <tr
                    key={`${a.zoo}:${a.id}`}
                    className={
                      "border-b border-line last:border-0 hover:bg-chromeHover/40 " +
                      (selected.has(a.id) ? "bg-accent/5" : "")
                    }
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() => toggleSelected(a.id)}
                        aria-label={`Select ${a.id} for compare`}
                        className="h-4 w-4 accent-[var(--accent)] cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      <button type="button" onClick={() => onOpenDetail(a.id)} className="text-accent hover:underline">
                        {a.id}
                      </button>
                      {a.nickname && <span className="ml-2 text-muted font-sans">{a.nickname}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">{a.zoo}</td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {(a.theme || []).map((th) => t("alphaZoo.themes." + th, { defaultValue: th })).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted hidden md:table-cell">
                      {(a.universe || []).map((u) => t("alphaZoo.universeOption." + u, { defaultValue: u })).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{a.decay_horizon ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {!loading && visible.length < filtered.length && (
            <div className="border-t border-line p-3 flex items-center justify-between text-xs text-muted">
              <span>{t("alphaZoo.showingOf", { visible: visible.length, total: filtered.length })}</span>
              <button type="button" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)} className={btnGhost}>
                {t("alphaZoo.loadMore")}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------- Detail ---------- */

function DetailView({
  alphaId,
  onBack,
  onOpenBench,
}: {
  alphaId: string;
  onBack: () => void;
  onOpenBench: (prefill: BenchPrefill) => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<AlphaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    getAlpha(alphaId)
      .then((res) => {
        if (alive) setDetail(res);
      })
      .catch(() => {
        if (alive) setError(t("alphaZoo.couldNotLoad"));
      });
    return () => {
      alive = false;
    };
  }, [alphaId, t]);

  if (error) {
    return (
      <div className="w-full p-6 space-y-4">
        <BackLink onBack={onBack} label={t("alphaZoo.backToAlphaZoo")} />
        <p className="text-sm text-muted">{error}</p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="w-full p-6 text-muted text-sm">
        <Spinner /> {t("alphaZoo.loadingAlpha", { id: alphaId })}
      </div>
    );
  }

  const a = detail.alpha;
  const meta = a.meta || {};
  const formula = (meta["formula_latex"] as string | undefined) || "";
  const nickname = (meta["nickname"] as string | undefined) || "";
  const firstUniverse = ((meta["universe"] as string[] | undefined) || [])[0] || "";

  return (
    <div className="w-full max-w-5xl p-4 md:p-6 space-y-4 overflow-y-auto">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <BackLink onBack={onBack} label={t("alphaZoo.backToAlphaZoo")} />
        <button
          type="button"
          className={btnPrimary}
          onClick={() => onOpenBench({ zoo: a.zoo, universe: firstUniverse, period: "2020-2025" })}
        >
          {t("alphaZoo.runBenchmark")}
        </button>
      </div>

      <ViewHeader
        title={
          <span className="flex items-center gap-2 flex-wrap">
            <span className="font-mono">{a.id}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent font-medium">{a.zoo}</span>
          </span>
        }
        sub={nickname || undefined}
      />

      <section className={panel}>
        <div className="px-4 py-3 border-b border-line">
          <h2 className="text-sm font-medium text-ink">{t("alphaZoo.formula")}</h2>
        </div>
        <pre className="rounded-b-lg bg-chrome/40 p-4 overflow-x-auto text-xs leading-relaxed text-ink">
          <code>{formula || t("alphaZoo.noFormula")}</code>
        </pre>
      </section>

      <section className={panel}>
        <div className="px-4 py-3 border-b border-line">
          <h2 className="text-sm font-medium text-ink">{t("alphaZoo.metadata")}</h2>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {[
              [
                t("alphaZoo.theme"),
                Array.isArray(meta.theme)
                  ? (meta.theme as string[]).map((x) => t("alphaZoo.themes." + x, { defaultValue: x })).join(", ")
                  : "—",
              ],
              [
                t("alphaZoo.universe"),
                Array.isArray(meta.universe)
                  ? (meta.universe as string[]).map((x) => t("alphaZoo.universeOption." + x, { defaultValue: x })).join(", ")
                  : "—",
              ],
              [t("alphaZoo.frequency"), metaString(meta, "frequency")],
              [t("alphaZoo.decayHorizon"), metaString(meta, "decay_horizon")],
              [t("alphaZoo.minWarmupBars"), metaString(meta, "min_warmup_bars")],
              [t("alphaZoo.requiresSector"), metaString(meta, "requires_sector")],
              [t("alphaZoo.modulePath"), a.module_path || "—"],
              [t("alphaZoo.notes"), metaString(meta, "notes")],
            ].map(([label, value], i, arr) => (
              <tr
                key={label}
                className={"hover:bg-chromeHover/30 " + (i < arr.length - 1 ? "border-b border-line" : "")}
              >
                <td className="px-4 py-2 text-xs text-muted w-1/3">{label}</td>
                <td className="px-4 py-2 text-xs font-mono break-all text-ink">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={panel}>
        <details>
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink hover:bg-chromeHover/30 select-none">
            {t("alphaZoo.viewSource", { lines: (detail.source_code || "").split("\n").length })}
          </summary>
          <pre className="border-t border-line bg-chrome/40 p-4 overflow-x-auto text-xs leading-relaxed text-ink">
            <code>{detail.source_code || t("alphaZoo.noSource")}</code>
          </pre>
        </details>
      </section>
    </div>
  );
}

/* ---------- Shared job polling (replaces upstream SSE) ---------- */

type JobKind = "bench" | "compare";

function useJobPoll(kind: JobKind, jobId: string | null, active: boolean) {
  const [progress, setProgress] = useState<AlphaBenchProgress | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const gen = useRef(0);

  useEffect(() => {
    if (!jobId || !active) return;
    const myGen = ++gen.current;
    setProgress(null);
    setResult(null);
    setJobError(null);
    setDone(false);
    const timer = setInterval(async () => {
      try {
        const job =
          kind === "bench" ? await getAlphaBenchStatus(jobId) : await getAlphaCompareStatus(jobId);
        if (myGen !== gen.current) return;
        setProgress(job.progress ?? null);
        if (job.status === "done") {
          setResult(job.result ?? null);
          setDone(true);
          clearInterval(timer);
        } else if (job.status === "error") {
          setJobError(job.error || "unknown error");
          setDone(true);
          clearInterval(timer);
        }
      } catch {
        /* transient poll errors are retried on the next tick */
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [jobId, active, kind]);

  return { progress, result, jobError, done };
}

function ProgressPanel({ progress }: { progress: AlphaBenchProgress | null }) {
  const { t } = useTranslation();
  const pct =
    progress && progress.n_total > 0
      ? Math.min(100, Math.round((progress.n_done / progress.n_total) * 100))
      : 0;
  return (
    <div className={panel + " p-4 space-y-3"}>
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <Spinner />
          {t("alphaZoo.running")}
        </span>
        {progress && (
          <span className="font-mono">
            {progress.n_done} / {progress.n_total}
          </span>
        )}
      </div>
      <div className="h-2 rounded-full bg-chrome overflow-hidden">
        <div className="h-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      {progress?.current_alpha_id && (
        <p className="text-xs text-muted font-mono truncate">
          {t("alphaZoo.computing", { id: progress.current_alpha_id })}
        </p>
      )}
    </div>
  );
}

/* ---------- Bench ---------- */

function BenchView({ prefill, onBack }: { prefill?: BenchPrefill; onBack: () => void }) {
  const { t } = useTranslation();
  const [zoo, setZoo] = useState(prefill?.zoo || "alpha101");
  const [universe, setUniverse] = useState(prefill?.universe || "csi300");
  const [period, setPeriod] = useState(prefill?.period || "2020-2025");
  const [top, setTop] = useState<number>(20);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const poll = useJobPoll("bench", jobId, true);
  const running = submitting || (!!jobId && !poll.done);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (running) return;
    setSubmitting(true);
    setFormError(null);
    setJobId(null);
    try {
      const res = await createAlphaBench({
        zoo,
        universe,
        period,
        top: Number.isFinite(top) && top > 0 ? top : 20,
      });
      setJobId(res.job_id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to start bench");
    } finally {
      setSubmitting(false);
    }
  };

  const result = (poll.result ?? null) as AlphaBenchResult | null;
  const error = poll.jobError || formError;

  return (
    <div className="w-full max-w-6xl p-4 md:p-6 space-y-4 overflow-y-auto">
      <BackLink onBack={onBack} label={t("alphaZoo.backToAlphaZoo")} />
      <ViewHeader title={t("alphaZoo.scoreZoo")} sub={t("alphaZoo.scoreDesc")} />

      <form
        onSubmit={start}
        className={panel + " p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"}
      >
        <div>
          <label htmlFor="bench-zoo" className="text-xs text-muted block mb-1">
            {t("alphaZoo.zoo")}
          </label>
          <select id="bench-zoo" value={zoo} onChange={(e) => setZoo(e.target.value)} disabled={running} className={input}>
            {ZOO_CARDS.map((z) => (
              <option key={z.id} value={z.id}>
                {z.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bench-universe" className="text-xs text-muted block mb-1">
            {t("alphaZoo.universe")}
          </label>
          <select
            id="bench-universe"
            value={universe}
            onChange={(e) => setUniverse(e.target.value)}
            disabled={running}
            className={input}
          >
            {UNIVERSE_OPTIONS.map((u) => (
              <option key={u.value} value={u.value}>
                {t("alphaZoo.universeOption." + u.value, { defaultValue: u.label })}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bench-period" className="text-xs text-muted block mb-1">
            {t("alphaZoo.period")}
          </label>
          <input
            id="bench-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            disabled={running}
            placeholder="2020-2025"
            className={input}
          />
        </div>
        <div>
          <label htmlFor="bench-top" className="text-xs text-muted block mb-1">
            {t("alphaZoo.top")}
          </label>
          <input
            id="bench-top"
            type="number"
            min={1}
            max={500}
            value={Number.isFinite(top) ? top : ""}
            onChange={(e) => setTop(e.target.value === "" ? 20 : Number(e.target.value))}
            disabled={running}
            className={input}
          />
        </div>
        <button type="submit" disabled={running} className={btnPrimary + " justify-center"}>
          {running ? (
            <>
              <Spinner /> {t("alphaZoo.running")}
            </>
          ) : (
            t("alphaZoo.runBenchmark")
          )}
        </button>
        {error && (
          <p className="sm:col-span-2 lg:col-span-5 text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </form>

      {running && jobId && <ProgressPanel progress={poll.progress} />}
      {result && <ResultPanel result={result} />}
    </div>
  );
}

function ResultPanel({ result }: { result: AlphaBenchResult }) {
  const { t } = useTranslation();
  const themes = Object.keys(result.by_theme || {}).sort();
  const totals = [
    { label: t("alphaZoo.alive"), value: result.alive, tone: "text-tealInk" },
    { label: t("alphaZoo.reversed"), value: result.reversed, tone: "text-warnInk" },
    { label: t("alphaZoo.dead"), value: result.dead, tone: "text-red-600 dark:text-red-400" },
    { label: t("alphaZoo.skipped"), value: result.skipped ?? result.n_skipped ?? 0, tone: "text-muted" },
  ];
  const maxTotal = Math.max(
    1,
    ...themes.map((k) => {
      const b = result.by_theme![k];
      return (b?.alive ?? 0) + (b?.reversed ?? 0) + (b?.dead ?? 0);
    }),
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {totals.map(({ label, value, tone }) => (
          <div key={label} className={panel + " flex items-center gap-3 p-4"}>
            <span className={"h-2.5 w-2.5 rounded-full bg-current " + tone} />
            <div>
              <p className="text-xs text-muted">{label}</p>
              <p className="text-xl font-bold text-ink font-mono">{value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopTable title={t("alphaZoo.topByIr")} rows={result.top5_by_ir || []} />
        <TopTable title={t("alphaZoo.mostReversed")} rows={(result.dead_examples || []).slice(0, 3)} />
      </div>

      {themes.length > 0 && (
        <div className={panel + " p-4"}>
          <h3 className="text-sm font-medium text-ink mb-3">{t("alphaZoo.byTheme")}</h3>
          <div className="space-y-2">
            {themes.map((k) => {
              const b = result.by_theme![k];
              const total = (b?.alive ?? 0) + (b?.reversed ?? 0) + (b?.dead ?? 0);
              return (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <span className="w-28 truncate text-muted">{t("alphaZoo.themes." + k, { defaultValue: k })}</span>
                  <div className="flex-1 h-4 flex rounded overflow-hidden bg-chrome">
                    <div className="bg-tealInk/70" style={{ width: `${((b?.alive ?? 0) / maxTotal) * 100}%` }} />
                    <div className="bg-warnInk/70" style={{ width: `${((b?.reversed ?? 0) / maxTotal) * 100}%` }} />
                    <div className="bg-red-500/60" style={{ width: `${((b?.dead ?? 0) / maxTotal) * 100}%` }} />
                  </div>
                  <span className="w-8 text-right font-mono text-muted">{total}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TopTable({ title, rows }: { title: string; rows: AlphaBenchTopRow[] }) {
  const { t } = useTranslation();
  return (
    <div className={panel}>
      <div className="px-4 py-3 border-b border-line">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted text-center">{t("alphaZoo.noRows")}</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left px-4 py-2 text-xs text-muted font-medium">{t("alphaZoo.id")}</th>
              <th className="text-right px-4 py-2 text-xs text-muted font-medium">{t("alphaZoo.meanIc")}</th>
              <th className="text-right px-4 py-2 text-xs text-muted font-medium">{t("alphaZoo.ir")}</th>
              <th className="text-left px-4 py-2 text-xs text-muted font-medium">{t("alphaZoo.theme")}</th>
              <th className="text-left px-4 py-2 text-xs text-muted font-medium">{t("alphaZoo.category")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-chromeHover/30">
                <td className="px-4 py-2 font-mono text-xs text-ink">{r.id}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{fmtNum(r.ic_mean)}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{fmtNum(r.ir)}</td>
                <td className="px-4 py-2 text-xs text-muted">
                  {(r.theme || []).map((th) => t("alphaZoo.themes." + th, { defaultValue: th })).join(", ") || "—"}
                </td>
                <td className="px-4 py-2">
                  <CategoryBadge category={r.category} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------- Compare ---------- */

function parseAlphaIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function CompareView({
  ids: initialIds,
  onBack,
  onOpenDetail,
}: {
  ids?: string[];
  onBack: () => void;
  onOpenDetail: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [idsText, setIdsText] = useState((initialIds || []).join(", "));
  const [universe, setUniverse] = useState("csi300");
  const [period, setPeriod] = useState("2020-2025");
  const [sort, setSort] = useState("ir");
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const poll = useJobPoll("compare", jobId, true);
  const ids = useMemo(() => parseAlphaIds(idsText), [idsText]);
  const running = submitting || (!!jobId && !poll.done);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (running) return;
    if (ids.length < 2) {
      setFormError(t("alphaZoo.pickAtLeast2"));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setJobId(null);
    try {
      const res = await createAlphaCompare({ alpha_ids: ids, universe, period, sort });
      setJobId(res.job_id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to start comparison");
    } finally {
      setSubmitting(false);
    }
  };

  const result = (poll.result ?? null) as AlphaCompareResult | null;
  const error = poll.jobError || formError;
  const deltaKey = result ? `delta_${result.sort}_vs_best` : "";

  return (
    <div className="w-full max-w-6xl p-4 md:p-6 space-y-4 overflow-y-auto">
      <BackLink onBack={onBack} label={t("alphaZoo.backToAlphaZoo")} />
      <ViewHeader title={t("alphaZoo.compareAlphas")} sub={t("alphaZoo.compareDesc")} />

      <form onSubmit={start} className={panel + " p-4 space-y-3"}>
        <div>
          <label htmlFor="compare-ids" className="text-xs text-muted block mb-1">
            {t("alphaZoo.alphaIds")}
            {ids.length > 0 ? ` (${ids.length})` : ""}
          </label>
          <textarea
            id="compare-ids"
            value={idsText}
            onChange={(e) => setIdsText(e.target.value)}
            disabled={running}
            rows={2}
            placeholder="alpha101_1, alpha101_2, gtja191_5"
            className={input + " font-mono"}
          />
          <p className="text-[11px] text-muted mt-1">{t("alphaZoo.alphaIdsHint")}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="compare-universe" className="text-xs text-muted block mb-1">
              {t("alphaZoo.universe")}
            </label>
            <select
              id="compare-universe"
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
              disabled={running}
              className={input}
            >
              {UNIVERSE_OPTIONS.map((u) => (
                <option key={u.value} value={u.value}>
                  {t("alphaZoo.universeOption." + u.value, { defaultValue: u.label })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="compare-period" className="text-xs text-muted block mb-1">
              {t("alphaZoo.period")}
            </label>
            <input
              id="compare-period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={running}
              placeholder="2020-2025"
              className={input}
            />
          </div>
          <div>
            <label htmlFor="compare-sort" className="text-xs text-muted block mb-1">
              {t("alphaZoo.rankBy")}
            </label>
            <select id="compare-sort" value={sort} onChange={(e) => setSort(e.target.value)} disabled={running} className={input}>
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {t("alphaZoo.sortOption." + s.key, { defaultValue: s.key })}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={running || ids.length < 2} className={btnPrimary}>
            {running ? (
              <>
                <Spinner /> {t("alphaZoo.running")}
              </>
            ) : (
              t("alphaZoo.compare")
            )}
          </button>
          {ids.length < 2 && <span className="text-xs text-muted">{t("alphaZoo.pickAtLeast2")}</span>}
        </div>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </form>

      {running && jobId && <ProgressPanel progress={poll.progress} />}

      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium text-tealInk">
              {t("alphaZoo.winner")}: <span className="font-mono">{result.winner}</span>
            </span>
            <span className="text-muted">
              {t("alphaZoo.comparedRankedBy", {
                count: result.n_compared,
                sort: result.sort,
                universe: result.universe,
                period: result.period,
              })}
            </span>
            {result.n_skipped > 0 && (
              <span className="text-warnInk">{t("alphaZoo.skippedCount", { count: result.n_skipped })}</span>
            )}
          </div>

          <div className={panel + " overflow-x-auto"}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-muted text-xs">
                  <th className="text-right px-3 py-2">#</th>
                  <th className="text-left px-3 py-2">{t("alphaZoo.alpha")}</th>
                  <th className="text-right px-3 py-2 hidden sm:table-cell">{t("alphaZoo.zoo")}</th>
                  <th className="text-right px-3 py-2">{t("alphaZoo.icMean")}</th>
                  <th className="text-right px-3 py-2 hidden md:table-cell">{t("alphaZoo.icStd")}</th>
                  <th className="text-right px-3 py-2">{t("alphaZoo.ir")}</th>
                  <th className="text-right px-3 py-2 hidden md:table-cell">{t("alphaZoo.icPositive")}</th>
                  <th className="text-right px-3 py-2 hidden lg:table-cell">{t("alphaZoo.sampleCount")}</th>
                  <th className="text-right px-3 py-2">Δ {result.sort}</th>
                </tr>
              </thead>
              <tbody>
                {result.ranking.map((r) => (
                  <tr
                    key={`${r.zoo}:${r.id}`}
                    className={
                      "border-b border-line last:border-0 hover:bg-chromeHover/30 " +
                      (r.rank === 1 ? "bg-tealInk/5" : "")
                    }
                  >
                    <td className="px-3 py-2 text-right font-mono">{r.rank}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <button type="button" onClick={() => onOpenDetail(r.id)} className="text-accent hover:underline">
                        {r.id}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted hidden sm:table-cell">{r.zoo}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtNum(r.ic_mean, 4)}</td>
                    <td className="px-3 py-2 text-right font-mono hidden md:table-cell">{fmtNum(r.ic_std, 4)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtNum(r.ir, 3)}</td>
                    <td className="px-3 py-2 text-right font-mono hidden md:table-cell">{fmtNum(r.ic_positive_ratio, 3)}</td>
                    <td className="px-3 py-2 text-right font-mono hidden lg:table-cell">{r.ic_count}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted">
                      {r.rank === 1 ? "—" : fmtNum(Number(r[deltaKey]), 4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.skipped.length > 0 && (
            <p className="text-xs text-muted">
              <span className="font-medium">{t("alphaZoo.skippedPre")}</span>{" "}
              {result.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
