"""Alpha Zoo service: browse the frozen factor registry and run IC benchmarks.

Ported from Vibe-Trading `src/api/alpha_routes.py` — the job model (in-memory store,
uuid ids, 1h TTL pruning, concurrency semaphores) is unchanged; the transport moved
from SSE streams to poll-based job views so the routes in `server/app.py` stay thin
REST per the repo convention.

Heavy compute (pandas panel load + ProcessPool IC math) lives in `coworker.factors`
+ `coworker.tools.trading.alpha_bench_tool`; every entry point here imports those
lazily so the server boots without the optional `trading` extra installed.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("coworker.alphazoo")

# Filter enums — keep in sync with coworker.factors.registry.Theme / Universe.
VALID_ZOOS = {"alpha101", "gtja191", "qlib158", "academic"}
VALID_THEMES = {
    "momentum",
    "reversal",
    "volume",
    "volatility",
    "quality",
    "value",
    "liquidity",
    "microstructure",
    "sentiment",
    "growth",
    "leverage",
}
VALID_UNIVERSES = {"equity_us", "equity_cn", "equity_hk", "crypto", "futures"}
BENCH_UNIVERSES = {"csi300", "sp500", "btc-usdt"}
_UNIVERSE_ALIAS = {"csi300": "equity_cn", "sp500": "equity_us", "btc-usdt": "crypto"}
VALID_SORTS = {"ir", "ic_mean", "ic_positive_ratio", "ic_count"}

# Tighter alpha_id pattern: ``<zoo>_<short>``. Zoo prefix is short (a-z + a-z0-9),
# short id is 1-64 of [a-z0-9_]. Caps avoid pathological lookups.
ALPHA_ID_RE = re.compile(r"^[a-z][a-z0-9]+_[a-z0-9_]{1,64}$")
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_JOB_TTL_SECONDS = 60 * 60
MAX_CONCURRENT_BENCHES = 2
MAX_CONCURRENT_COMPARES = 2

_BENCH_JOBS: dict[str, dict[str, Any]] = {}
_COMPARE_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()
_RUNNING_TASKS: set[asyncio.Task[Any]] = set()

_BENCH_SEMAPHORE: asyncio.Semaphore | None = None
_COMPARE_SEMAPHORE: asyncio.Semaphore | None = None
_SEM_LOCK = threading.Lock()


def _semaphore(which: str) -> asyncio.Semaphore:
    """Process-wide semaphore, built lazily so it binds the running event loop."""
    global _BENCH_SEMAPHORE, _COMPARE_SEMAPHORE
    with _SEM_LOCK:
        if which == "bench":
            if _BENCH_SEMAPHORE is None:
                _BENCH_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_BENCHES)
            return _BENCH_SEMAPHORE
        if _COMPARE_SEMAPHORE is None:
            _COMPARE_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_COMPARES)
        return _COMPARE_SEMAPHORE


class BenchRequest(BaseModel):
    """POST /v1/alphazoo/bench body."""

    zoo: str = Field(..., min_length=1, max_length=64)
    universe: str = Field(..., min_length=1, max_length=64)
    period: str = Field(..., min_length=4, max_length=32)
    top: int = Field(20, ge=1, le=500)

    @field_validator("zoo")
    @classmethod
    def _zoo_known(cls, v: str) -> str:
        if v not in VALID_ZOOS:
            raise ValueError(f"unknown zoo {v!r}; expected one of {sorted(VALID_ZOOS)}")
        return v

    @field_validator("universe")
    @classmethod
    def _universe_known(cls, v: str) -> str:
        if v not in BENCH_UNIVERSES:
            raise ValueError(
                f"unknown universe {v!r}; expected one of {sorted(BENCH_UNIVERSES)}"
            )
        return v


class CompareRequest(BaseModel):
    """POST /v1/alphazoo/compare body — a head-to-head of >= 2 named alphas."""

    alpha_ids: list[str] = Field(..., min_length=2, max_length=50)
    universe: str = Field(..., min_length=1, max_length=64)
    period: str = Field(..., min_length=4, max_length=32)
    sort: str = Field("ir", min_length=1, max_length=32)

    @field_validator("alpha_ids")
    @classmethod
    def _ids_well_formed(cls, v: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for aid in v:
            if not ALPHA_ID_RE.fullmatch(aid or ""):
                raise ValueError(f"invalid alpha_id {aid!r}")
            if aid not in seen:
                seen.add(aid)
                out.append(aid)
        if len(out) < 2:
            raise ValueError("need at least 2 distinct alpha_ids to compare")
        return out

    @field_validator("universe")
    @classmethod
    def _universe_known(cls, v: str) -> str:
        if v not in BENCH_UNIVERSES:
            raise ValueError(
                f"unknown universe {v!r}; expected one of {sorted(BENCH_UNIVERSES)}"
            )
        return v

    @field_validator("sort")
    @classmethod
    def _sort_known(cls, v: str) -> str:
        if v not in VALID_SORTS:
            raise ValueError(
                f"unknown sort {v!r}; expected one of {sorted(VALID_SORTS)}"
            )
        return v


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe_error(exc: BaseException) -> str:
    """Fixed user-facing phrase — never echo exception text (paths/credentials)."""
    logger.exception("alphazoo worker crashed")
    return "internal error; see server logs"


def _prune_old_jobs() -> None:
    cutoff = time.time() - _JOB_TTL_SECONDS
    with _JOBS_LOCK:
        for store in (_BENCH_JOBS, _COMPARE_JOBS):
            stale = [
                jid
                for jid, job in store.items()
                if job.get("status") in ("done", "error")
                and job.get("_finished_at", 0) < cutoff
            ]
            for jid in stale:
                store.pop(jid, None)


def _progress_cb(jobs: dict[str, dict[str, Any]], job_id: str):
    def _cb(n_done: int, n_total: int, alpha_id: str) -> None:
        with _JOBS_LOCK:
            job = jobs.get(job_id)
            if job is None:
                return
            job["progress"] = {
                "n_done": int(n_done),
                "n_total": int(n_total),
                "current_alpha_id": alpha_id,
            }
            if job["status"] == "queued":
                job["status"] = "running"

    return _cb


def _finish_ok(job: dict[str, Any], result: dict[str, Any], slim: bool) -> None:
    if result.get("status") != "ok":
        # runner error strings are curated (universe load failed, ...) — safe to surface
        job["status"] = "error"
        job["error"] = result.get("error", "unknown")
    else:
        job["status"] = "done"
        job["result"] = (
            {k: v for k, v in result.items() if k not in ("rows", "skipped")}
            if slim
            else result
        )
    job["_finished_at"] = time.time()


def _run_bench_blocking(
    job_id: str, zoo: str, universe: str, period: str, top: int
) -> None:
    from coworker.factors.bench_runner import run_bench  # lazy: heavy deps

    with _JOBS_LOCK:
        job = _BENCH_JOBS.get(job_id)
        if job is not None:
            job["status"] = "running"
    try:
        result = run_bench(
            zoo=zoo,
            universe=universe,
            period=period,
            top=top,
            on_progress=_progress_cb(_BENCH_JOBS, job_id),
        )
    except Exception as exc:  # noqa: BLE001 — worker must never crash the loop
        with _JOBS_LOCK:
            job = _BENCH_JOBS.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["error"] = _safe_error(exc)
                job["_finished_at"] = time.time()
        return
    with _JOBS_LOCK:
        job = _BENCH_JOBS.get(job_id)
        if job is not None:
            _finish_ok(job, result, slim=True)


def _run_compare_blocking(
    job_id: str, alpha_ids: list[str], universe: str, period: str, sort: str
) -> None:
    from coworker.factors.compare_runner import compare_alphas  # lazy: heavy deps

    with _JOBS_LOCK:
        job = _COMPARE_JOBS.get(job_id)
        if job is not None:
            job["status"] = "running"
    try:
        result = compare_alphas(
            alpha_ids,
            universe,
            period,
            sort=sort,
            on_progress=_progress_cb(_COMPARE_JOBS, job_id),
        )
    except Exception as exc:  # noqa: BLE001 — worker must never crash the loop
        with _JOBS_LOCK:
            job = _COMPARE_JOBS.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["error"] = _safe_error(exc)
                job["_finished_at"] = time.time()
        return
    with _JOBS_LOCK:
        job = _COMPARE_JOBS.get(job_id)
        if job is not None:
            _finish_ok(job, result, slim=False)


def _finish_ok(job: dict[str, Any], result: dict[str, Any], slim: bool) -> None:
    if result.get("status") != "ok":
        # runner error strings are curated (universe load failed, ...) — safe to surface
        job["status"] = "error"
        job["error"] = result.get("error", "unknown")
    else:
        job["status"] = "done"
        out = (
            result
            if not slim
            else {k: v for k, v in result.items() if k not in ("rows", "skipped")}
        )
        # Upstream wire contract (alpha_routes._result_for_wire): the bench skip count
        # is exposed as ``skipped``; keep ``n_skipped`` too for early clients.
        if "n_skipped" in out:
            out["skipped"] = out["n_skipped"]
        job["result"] = out
    job["_finished_at"] = time.time()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _RUNNING_TASKS.add(task)
    task.add_done_callback(_RUNNING_TASKS.discard)


# ---------------------------------------------------------------------------
# Public service API — the thin surface server/app.py routes call
# ---------------------------------------------------------------------------


def health() -> dict[str, Any]:
    from coworker.factors.registry import get_default_registry

    return {"status": "ok", "registry": get_default_registry().health()}


def list_alphas(
    zoo: str | None = None,
    theme: str | None = None,
    universe: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    if zoo is not None and zoo not in VALID_ZOOS:
        return {"ok": False, "error": f"unknown zoo {zoo!r}"}
    if theme is not None and theme not in VALID_THEMES:
        return {"ok": False, "error": f"unknown theme {theme!r}"}
    if universe is not None:
        universe = _UNIVERSE_ALIAS.get(universe, universe)
        if universe not in VALID_UNIVERSES:
            return {"ok": False, "error": f"unknown universe {universe!r}"}
    from coworker.factors.registry import get_default_registry

    registry = get_default_registry()
    ids = registry.list(zoo=zoo, theme=theme, universe=universe)
    total = len(ids)
    alphas = []
    for aid in ids[:limit]:
        try:
            a = registry.get(aid)
        except KeyError:
            continue
        meta = a.meta or {}
        alphas.append(
            {
                "id": a.id,
                "zoo": a.zoo,
                "theme": meta.get("theme", []),
                "universe": meta.get("universe", []),
                "nickname": meta.get("nickname"),
                "decay_horizon": meta.get("decay_horizon"),
                "min_warmup_bars": meta.get("min_warmup_bars"),
                "requires_sector": bool(meta.get("requires_sector", False)),
            }
        )
    return {
        "status": "ok",
        "alphas": alphas,
        "total": total,
        "returned": len(alphas),
        "truncated": total > len(alphas),
    }


def get_alpha(alpha_id: str) -> dict[str, Any]:
    if not ALPHA_ID_RE.fullmatch(alpha_id or ""):
        return {"ok": False, "error": "invalid alpha_id"}
    from coworker.factors.registry import RegistryError, get_default_registry

    registry = get_default_registry()
    try:
        alpha = registry.get(alpha_id)
    except KeyError:
        return {"ok": False, "error": "alpha_id not found"}
    try:
        source_code = registry.get_source(alpha_id)
    except RegistryError as exc:
        logger.warning("failed to read source for %s: %s", alpha_id, exc)
        source_code = f"# <source unavailable: {exc}>"
    return {
        "status": "ok",
        "alpha": {
            "id": alpha.id,
            "zoo": alpha.zoo,
            "module_path": alpha.module_path,
            "meta": alpha.meta,
        },
        "source_code": source_code,
    }


async def start_bench(body: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = BenchRequest(**(body or {}))
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    from coworker.tools.trading.alpha_bench_tool import _parse_period

    try:
        _parse_period(payload.period)
    except ValueError as exc:
        return {"ok": False, "error": f"invalid period: {exc}"}
    sem = _semaphore("bench")
    if sem.locked():
        return {
            "ok": False,
            "error": "too many running benches; wait for one to finish",
        }
    _prune_old_jobs()
    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _BENCH_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "zoo": payload.zoo,
            "universe": payload.universe,
            "period": payload.period,
            "top": payload.top,
            "created_at": _now_iso(),
            "progress": {"n_done": 0, "n_total": 0, "current_alpha_id": None},
            "result": None,
            "error": None,
        }

    async def _runner() -> None:
        async with sem:
            try:
                await asyncio.to_thread(
                    _run_bench_blocking,
                    job_id,
                    payload.zoo,
                    payload.universe,
                    payload.period,
                    payload.top,
                )
            except Exception:
                logger.exception("bench runner outer task crashed (job=%s)", job_id)
                with _JOBS_LOCK:
                    job = _BENCH_JOBS.get(job_id)
                    if job is not None and job["status"] not in ("done", "error"):
                        job["status"] = "error"
                        job["error"] = "internal error; see server logs"
                        job["_finished_at"] = time.time()

    _spawn(_runner())
    return {"status": "ok", "job_id": job_id}


async def start_compare(body: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = CompareRequest(**(body or {}))
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    from coworker.tools.trading.alpha_bench_tool import _parse_period

    try:
        _parse_period(payload.period)
    except ValueError as exc:
        return {"ok": False, "error": f"invalid period: {exc}"}
    sem = _semaphore("compare")
    if sem.locked():
        return {
            "ok": False,
            "error": "too many running compares; wait for one to finish",
        }
    _prune_old_jobs()
    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _COMPARE_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "alpha_ids": payload.alpha_ids,
            "universe": payload.universe,
            "period": payload.period,
            "sort": payload.sort,
            "created_at": _now_iso(),
            "progress": {"n_done": 0, "n_total": 0, "current_alpha_id": None},
            "result": None,
            "error": None,
        }

    async def _runner() -> None:
        async with sem:
            try:
                await asyncio.to_thread(
                    _run_compare_blocking,
                    job_id,
                    payload.alpha_ids,
                    payload.universe,
                    payload.period,
                    payload.sort,
                )
            except Exception:
                logger.exception("compare runner outer task crashed (job=%s)", job_id)
                with _JOBS_LOCK:
                    job = _COMPARE_JOBS.get(job_id)
                    if job is not None and job["status"] not in ("done", "error"):
                        job["status"] = "error"
                        job["error"] = "internal error; see server logs"
                        job["_finished_at"] = time.time()

    _spawn(_runner())
    return {"status": "ok", "job_id": job_id}


def _job_view(job: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in job.items() if not k.startswith("_")}
    result = job.get("result")
    if job["status"] == "done" and result is not None:
        out["result"] = {k: v for k, v in result.items() if k != "status"}
    return out


def bench_status(job_id: str) -> dict[str, Any]:
    if not JOB_ID_RE.fullmatch(job_id or ""):
        return {"ok": False, "error": "invalid job_id"}
    with _JOBS_LOCK:
        job = _BENCH_JOBS.get(job_id)
        if job is None:
            return {"ok": False, "error": f"job {job_id} not found"}
        return {"status": "ok", "job": _job_view(job)}


def compare_status(job_id: str) -> dict[str, Any]:
    if not JOB_ID_RE.fullmatch(job_id or ""):
        return {"ok": False, "error": "invalid job_id"}
    with _JOBS_LOCK:
        job = _COMPARE_JOBS.get(job_id)
        if job is None:
            return {"ok": False, "error": f"job {job_id} not found"}
        return {"status": "ok", "job": _job_view(job)}
