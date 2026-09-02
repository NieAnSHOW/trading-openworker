"""Backtest report browsing: list runs and build run detail payloads.

Ported from Vibe-Trading ``src/ui_services.py`` + ``src/api/runs_routes.py``.
Runs are the directory-per-run artifacts the upstream agent backtest flow
writes under ``runs/``: each run dir carries ``state.json`` (status),
``artifacts/{metrics,equity,trades}.csv``, ``run_card.json``, chart OHLCV
artifacts, and request context (``req.json`` / ``planner_output.json`` /
``user_prompt.txt``). The service scans ``<workspace>/runs`` and returns plain
JSON-able dicts; routes in ``server/app.py`` stay thin REST per repo convention.

Upstream had a final chart fallback that re-fetched market data through its
generated ``DataLoader`` stack (``reconstruct_price_series``) when a run stored
no price artifacts. That stack is not vendored here, so runs without
``price_series.csv`` / ``ohlcv_*.csv`` show no candles (equity/metrics still
render) — the documented ceiling of this port.
"""

from __future__ import annotations

import csv
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

# Client-supplied run ids become path segments — keep them tight (repo rule:
# validate before a filename/path is built from user input).
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")

DEFAULT_ANALYSIS_PERIODS = [5, 20]

_EQUITY_PREVIEW_ROWS = 1000
_TRADE_PREVIEW_ROWS = 500
_RUN_LOG_LINES = 200
_SCAN_LIMIT_CEILING = 100


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def _load_json_file(path: Path) -> dict[str, Any] | None:
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except (json.JSONDecodeError, OSError):
        pass
    return None


def _load_csv_records(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            rows = [dict(row) for row in csv.DictReader(handle)]
            return rows[:limit] if limit is not None else rows
    except OSError:
        return []


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _format_run_date(date_str: Any) -> str | None:
    """Normalize supported date strings into ``YYYY-MM-DD`` (keep as-is otherwise)."""
    if not date_str:
        return None
    value = str(date_str).strip()
    if not value:
        return None
    if "-" in value and len(value) == 10:
        return value
    if len(value) == 8 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:8]}"
    if "-" in value and len(value) > 10 and value[4] == "-" and value[7] == "-":
        return value[:10]
    return value


def _normalize_codes(raw_codes: Any) -> list[str]:
    if isinstance(raw_codes, list):
        return [str(code).strip() for code in raw_codes if str(code).strip()]
    if isinstance(raw_codes, str):
        return [code.strip() for code in raw_codes.split(",") if code.strip()]
    return []


def runs_dir(workspace: str | Path) -> Path:
    return Path(workspace) / "runs"


# ---------------------------------------------------------------------------
# Run context (req.json / planner_output.json / user_prompt.txt)
# ---------------------------------------------------------------------------


def load_run_context(run_dir: Path) -> dict[str, Any]:
    """Load normalized request context for a run (prompt, codes, dates).

    Falls back to ``planner_output.json`` when ``req.json`` context is empty
    (session mode stores codes there), matching upstream.
    """
    request_data = _load_json_file(run_dir / "req.json") or {}
    context = dict(request_data.get("context") or {})
    prompt = str(request_data.get("prompt") or "").strip()
    codes = _normalize_codes(context.get("codes"))
    start_date = _format_run_date(context.get("start_date"))
    end_date = _format_run_date(context.get("end_date"))

    if not codes or not start_date or not end_date:
        planner = _load_json_file(run_dir / "planner_output.json") or {}
        contract = planner.get("coding_contract") or {}
        req_ctx = (planner.get("requirements") or {}).get("context") or {}

        if not codes:
            raw = (
                contract.get("target_scope")
                or req_ctx.get("codes")
                or contract.get("codes")
            )
            codes = _normalize_codes(raw) or codes
            if not codes:
                for req in contract.get("data_requirements") or []:
                    scope = req.get("symbol_scope", "") if isinstance(req, dict) else ""
                    if isinstance(scope, str) and scope.strip():
                        codes.extend(c.strip() for c in scope.split(",") if c.strip())
                codes = list(dict.fromkeys(codes))

        if not start_date:
            start_date = _format_run_date(
                contract.get("start_date") or req_ctx.get("start_date")
            )
        if not end_date:
            end_date = _format_run_date(
                contract.get("end_date") or req_ctx.get("end_date")
            )

    if not prompt:
        prompt_file = run_dir / "user_prompt.txt"
        if prompt_file.exists():
            try:
                prompt = prompt_file.read_text(encoding="utf-8").strip()
            except OSError:
                prompt = ""

    return {
        "prompt": prompt,
        "codes": codes,
        "start_date": start_date,
        "end_date": end_date,
        "raw_context": context,
    }


# ---------------------------------------------------------------------------
# Chart payload (price / indicator / markers) — disk artifacts only
# ---------------------------------------------------------------------------


def _normalize_price_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for row in rows:
        timestamp = _format_run_date(row.get("timestamp") or row.get("time"))
        if not timestamp:
            continue
        normalized.append(
            {
                "time": timestamp,
                "timestamp": timestamp,
                "code": str(row.get("code") or "UNKNOWN"),
                "open": float(row.get("open") or 0.0),
                "high": float(row.get("high") or 0.0),
                "low": float(row.get("low") or 0.0),
                "close": float(row.get("close") or 0.0),
                "volume": float(row.get("volume") or 0.0),
            }
        )
    return sorted(normalized, key=lambda item: (item["code"], item["time"]))


def _load_ohlcv_artifacts(run_dir: Path) -> list[dict[str, Any]]:
    """Read per-symbol ``ohlcv_{code}.csv`` files written by the backtest engine."""
    artifacts = run_dir / "artifacts"
    if not artifacts.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for f in sorted(artifacts.glob("ohlcv_*.csv")):
        code = f.stem.removeprefix("ohlcv_")
        for r in _load_csv_records(f):
            ts = r.get("trade_date") or r.get("timestamp") or r.get("time") or r.get("")
            if not ts:
                continue
            rows.append(
                {
                    "time": ts,
                    "timestamp": ts,
                    "code": code,
                    "open": r.get("open", 0),
                    "high": r.get("high", 0),
                    "low": r.get("low", 0),
                    "close": r.get("close", 0),
                    "volume": r.get("volume", 0),
                }
            )
    return _normalize_price_rows(rows)


def load_price_series(run_dir: Path) -> list[dict[str, Any]]:
    """Chart-ready price rows: ``price_series.csv`` > ``ohlcv_*.csv`` > nothing.

    Upstream also re-fetched market data via its generated DataLoader here; that
    path is intentionally not ported (see module docstring).
    """
    artifact_path = run_dir / "artifacts" / "price_series.csv"
    if artifact_path.exists():
        return _normalize_price_rows(_load_csv_records(artifact_path))
    return _load_ohlcv_artifacts(run_dir)


def load_chart_symbols(
    run_dir: Path, context: dict[str, Any] | None = None
) -> list[str]:
    artifacts = run_dir / "artifacts"
    symbols: set[str] = set()

    price_path = artifacts / "price_series.csv"
    if price_path.exists():
        try:
            with price_path.open("r", encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    code = str(row.get("code") or "").strip()
                    if code:
                        symbols.add(code)
        except OSError:
            symbols.clear()

    if not symbols and artifacts.is_dir():
        symbols.update(
            file_path.stem.removeprefix("ohlcv_")
            for file_path in artifacts.glob("ohlcv_*.csv")
            if file_path.stem.removeprefix("ohlcv_")
        )

    if not symbols:
        raw_codes = (context or load_run_context(run_dir)).get("codes") or []
        symbols.update(str(code) for code in raw_codes if code)

    return sorted(symbols)


def _group_price_rows(
    price_rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in price_rows:
        grouped.setdefault(str(row.get("code") or "UNKNOWN"), []).append(row)
    return grouped


def _build_indicator_series(
    price_rows: list[dict[str, Any]],
    periods: list[int] | None = None,
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    grouped = _group_price_rows(price_rows)
    indicator_periods = sorted(set(periods or DEFAULT_ANALYSIS_PERIODS))
    output: dict[str, dict[str, list[dict[str, Any]]]] = {}

    for code, rows in grouped.items():
        ordered_rows = sorted(
            (
                {
                    **row,
                    "time": str(
                        row.get("time") or _format_run_date(row.get("timestamp")) or ""
                    ),
                }
                for row in rows
            ),
            key=lambda item: item["time"],
        )
        closes = [float(row["close"]) for row in ordered_rows]
        code_series: dict[str, list[dict[str, Any]]] = {}
        for period in indicator_periods:
            label = f"ma{period}"
            values: list[dict[str, Any]] = []
            for index, row in enumerate(ordered_rows):
                if index + 1 < period:
                    current = None
                else:
                    window = closes[index - period + 1 : index + 1]
                    current = round(sum(window) / period, 6)
                values.append({"time": row["time"], "value": current})
            code_series[label] = values
        output[code] = code_series

    return output


def _build_trade_markers(
    trades: list[dict[str, Any]],
    symbols: set[str] | None = None,
) -> list[dict[str, Any]]:
    markers: list[dict[str, Any]] = []
    for row in trades:
        code = str(row.get("code") or "")
        if symbols and code not in symbols:
            continue
        side = str(row.get("side") or "").upper()
        timestamp = str(row.get("timestamp") or "")
        markers.append(
            {
                "time": timestamp[:10],
                "timestamp": timestamp,
                "code": row.get("code"),
                "side": side,
                "price": _safe_float(row.get("price")),
                "qty": _safe_float(row.get("qty")),
                "reason": row.get("reason"),
                "text": f"{side} {row.get('code') or ''}".strip(),
            }
        )
    return markers


def _infer_indicator_periods(run_dir: Path) -> list[int]:
    periods: set[int] = set()

    planner = _load_json_file(run_dir / "planner_output.json") or {}
    contract = planner.get("coding_contract") or {}
    input_logic = contract.get("input_logic") or {}
    parameters = input_logic.get("parameters") or {}
    signal_params = parameters.get("signal_params") or {}

    design = _load_json_file(run_dir / "design_spec.json") or {}
    defaults = design.get("defaults_and_tunables") or {}
    assumptions = defaults.get("parameter_assumptions") or {}

    for source in (signal_params, assumptions):
        if not isinstance(source, dict):
            continue
        for key, value in source.items():
            if "ma" in str(key).lower():
                try:
                    periods.add(int(value))
                except (TypeError, ValueError):
                    continue

    if not periods:
        return list(DEFAULT_ANALYSIS_PERIODS)
    return sorted(periods)


def _infer_run_stage(run_dir: Path) -> str:
    state_data = _load_json_file(run_dir / "state.json") or {}
    state_status = str(state_data.get("status") or "").lower()
    if state_status == "success":
        return "done"
    if state_status == "failed":
        return "failed"
    if (run_dir / "artifacts" / "metrics.csv").exists():
        return "backtest"
    if (run_dir / "review_report.json").exists():
        return "review"
    if (run_dir / "code" / "signal_engine.py").exists():
        return "coding"
    if (run_dir / "design_spec.json").exists():
        return "design"
    if (run_dir / "planner_output.json").exists():
        return "planning"
    if (run_dir / "req.json").exists():
        return "queued"
    return "unknown"


def _collect_run_logs(
    run_dir: Path, line_limit: int = _RUN_LOG_LINES
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    log_files = [
        ("stdout", run_dir / "logs" / "runner_stdout.txt"),
        ("stderr", run_dir / "logs" / "runner_stderr.txt"),
        ("compile", run_dir / "logs" / "compile_error.txt"),
    ]
    for source, path in log_files:
        if not path.exists():
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        if line_limit > 0:
            lines = lines[-line_limit:]
        for index, line in enumerate(lines, start=1):
            entries.append({"source": source, "line_number": index, "message": line})
    return entries


def _build_run_analysis(
    run_dir: Path,
    symbols: list[str] | None = None,
    *,
    include_payload: bool = True,
    include_symbol_list: bool = False,
) -> dict[str, Any]:
    """Chart/trade/log payload for the run detail page (upstream parity)."""
    context = load_run_context(run_dir)
    chart_symbols = (
        load_chart_symbols(run_dir, context)
        if include_symbol_list or not include_payload
        else []
    )

    if not include_payload:
        return {
            "run_stage": _infer_run_stage(run_dir),
            "run_context": context,
            "chart_symbols": chart_symbols,
            "price_series": {},
            "indicator_series": {},
            "trade_markers": [],
            "run_logs": _collect_run_logs(run_dir),
        }

    price_rows = load_price_series(run_dir)
    if include_symbol_list and not chart_symbols:
        chart_symbols = sorted(
            {str(row.get("code") or "") for row in price_rows if row.get("code")}
        )
    selected_symbols = {symbol for symbol in (symbols or []) if symbol}
    if selected_symbols:
        price_rows = [
            row for row in price_rows if str(row.get("code") or "") in selected_symbols
        ]
    periods = _infer_indicator_periods(run_dir)
    trades = _load_csv_records(run_dir / "artifacts" / "trades.csv")

    return {
        "run_stage": _infer_run_stage(run_dir),
        "run_context": context,
        "chart_symbols": chart_symbols,
        "price_series": _group_price_rows(price_rows),
        "indicator_series": _build_indicator_series(price_rows, periods)
        if price_rows
        else {},
        "trade_markers": _build_trade_markers(trades, selected_symbols or None),
        "run_logs": _collect_run_logs(run_dir),
    }


# ---------------------------------------------------------------------------
# List / detail payloads
# ---------------------------------------------------------------------------


def _parse_created_at(run_id: str, run_dir: Path) -> str:
    if run_id.startswith("run_"):
        parts = run_id.split("_")
        if len(parts) >= 3:
            d_str, t_str = parts[1], parts[2]
            if len(d_str) == 8 and len(t_str) == 6:
                return f"{d_str[:4]}-{d_str[4:6]}-{d_str[6:8]} {t_str[:2]}:{t_str[2:4]}:{t_str[4:6]}"
    elif "_" in run_id:
        parts = run_id.split("_")
        if len(parts) >= 2:
            d_str, t_str = parts[0], parts[1]
            if len(d_str) == 8 and len(t_str) == 6:
                return f"{d_str[:4]}-{d_str[4:6]}-{d_str[6:8]} {t_str[:2]}:{t_str[2:4]}:{t_str[4:6]}"
    mtime = datetime.fromtimestamp(run_dir.stat().st_mtime)
    return mtime.strftime("%Y-%m-%d %H:%M:%S")


def list_runs(workspace: str | Path, limit: int = 20) -> list[dict[str, Any]]:
    """Recent runs with summary fields (upstream ``GET /runs`` shape)."""
    limit = min(max(1, limit), _SCAN_LIMIT_CEILING)
    base = runs_dir(workspace)
    if not base.is_dir():
        return []

    run_dirs = sorted(
        (d for d in base.iterdir() if d.is_dir()), key=lambda x: x.name, reverse=True
    )

    results: list[dict[str, Any]] = []
    for d in run_dirs[:limit]:
        run_id = d.name
        if not RUN_ID_RE.match(run_id):
            continue

        state_file = _load_json_file(d / "state.json")
        if state_file:
            status_val = str(state_file.get("status") or "unknown").lower()
        elif (d / "artifacts" / "equity.csv").exists() or (
            d / "review_report.json"
        ).exists():
            status_val = "success"
        else:
            status_val = "unknown"

        created_at = _parse_created_at(run_id, d)

        prompt = None
        req_file = d / "req.json"
        planner_file = d / "planner_output.json"
        req_data = _load_json_file(req_file)
        if req_data:
            prompt = req_data.get("prompt")
        if not prompt:
            planner_data = _load_json_file(planner_file)
            if planner_data:
                prompt = planner_data.get("user_goal") or planner_data.get("goal")
        if not prompt:
            prompt_file = d / "user_prompt.txt"
            if prompt_file.exists():
                try:
                    prompt = prompt_file.read_text(encoding="utf-8").strip()
                except OSError:
                    prompt = None

        total_return = None
        sharpe = None
        metrics_rows = _load_csv_records(d / "artifacts" / "metrics.csv", limit=1)
        if metrics_rows:
            row = metrics_rows[0]
            total_return = _safe_float(row.get("total_return"))
            sharpe = _safe_float(row.get("sharpe"))

        run_context = load_run_context(d)
        results.append(
            {
                "run_id": run_id,
                "status": status_val,
                "created_at": created_at,
                "prompt": prompt or "Manual Analysis",
                "total_return": total_return,
                "sharpe": sharpe,
                "codes": run_context.get("codes") or [],
                "start_date": run_context.get("start_date"),
                "end_date": run_context.get("end_date"),
            }
        )

    return results


def get_run(
    workspace: str | Path,
    run_id: str,
    *,
    chart_symbol: str | None = None,
    chart_payload: str = "full",
) -> dict[str, Any]:
    """Run detail payload (upstream ``GET /runs/{run_id}`` shape, as plain dict)."""
    if not RUN_ID_RE.match(run_id):
        raise ValueError("invalid run id")

    run_dir = runs_dir(workspace) / run_id
    if not run_dir.is_dir():
        raise FileNotFoundError(f"Run {run_id} not found")

    response: dict[str, Any] = {
        "status": "unknown",
        "run_id": run_id,
        "elapsed_seconds": 0.0,
        "artifacts": [],
        "run_directory": str(run_dir),
    }

    state_data = _load_json_file(run_dir / "state.json")
    if state_data:
        state_status = str(state_data.get("status") or "").lower()
        if state_status == "success":
            response["status"] = "success"
        elif state_status == "failed":
            response["status"] = "failed"
            response["reason"] = state_data.get("reason", "")
        else:
            response["status"] = state_status or "unknown"

    planner = _load_json_file(run_dir / "planner_output.json")
    if planner is not None:
        response["planner_output"] = planner
    strategy_spec = _load_json_file(run_dir / "design_spec.json")
    if strategy_spec is not None:
        response["strategy_spec"] = strategy_spec

    metrics_rows = _load_csv_records(run_dir / "artifacts" / "metrics.csv", limit=1)
    if metrics_rows:
        parsed: dict[str, float | int] = {}
        for k, v in metrics_rows[0].items():
            if not k or not v:
                continue
            try:
                parsed[k] = (
                    int(float(v))
                    if k in ("trade_count", "max_consecutive_loss")
                    else float(v)
                )
            except (ValueError, TypeError):
                continue
        if "final_value" in parsed:
            response["metrics"] = parsed

    artifacts_dir = run_dir / "artifacts"
    if artifacts_dir.is_dir():
        for file_path in sorted(artifacts_dir.iterdir()):
            if file_path.is_file():
                file_type = file_path.suffix.lstrip(".")
                response["artifacts"].append(
                    {
                        "name": file_path.name,
                        "path": str(file_path),
                        "type": file_type if file_type else "unknown",
                        "size": file_path.stat().st_size,
                        "exists": True,
                    }
                )

    equity_rows = _load_csv_records(run_dir / "artifacts" / "equity.csv")
    if equity_rows:
        response["artifacts_equity_csv"] = equity_rows
    metrics_csv = _load_csv_records(run_dir / "artifacts" / "metrics.csv")
    if metrics_csv:
        response["artifacts_metrics_csv"] = metrics_csv
    trades_csv = _load_csv_records(run_dir / "artifacts" / "trades.csv")
    if trades_csv:
        response["artifacts_trades_csv"] = trades_csv

    run_card = _load_json_file(run_dir / "run_card.json")
    if run_card is not None:
        response["run_card"] = run_card

    llm_usage = _load_json_file(run_dir / "llm_usage.json")
    if llm_usage is not None:
        # Display-only passthrough (provider/model/totals) — fail open, never gated.
        response["llm_usage"] = llm_usage

    validation = _load_json_file(run_dir / "artifacts" / "validation.json")
    if validation is not None:
        response["validation"] = validation

    if equity_rows:
        filtered_equity = []
        for row in equity_rows[:_EQUITY_PREVIEW_ROWS]:
            filtered: dict[str, Any] = {}
            if "timestamp" in row:
                filtered["time"] = row["timestamp"]
            if "equity" in row:
                filtered["equity"] = row["equity"]
            if "drawdown" in row:
                filtered["drawdown"] = row["drawdown"]
            filtered_equity.append(filtered)
        response["equity_curve"] = filtered_equity

    if trades_csv:
        response["trade_log"] = trades_csv[:_TRADE_PREVIEW_ROWS]

    # Chart analysis (upstream include_analysis=True)
    analysis = _build_run_analysis(
        run_dir,
        symbols=[chart_symbol] if chart_symbol else None,
        include_payload=chart_payload != "summary" or bool(chart_symbol),
        include_symbol_list=bool(chart_symbol) or chart_payload != "summary",
    )
    response["chart_symbols"] = analysis.get("chart_symbols") or []
    response["run_stage"] = analysis.get("run_stage")
    response["run_context"] = analysis.get("run_context")
    response["price_series"] = analysis.get("price_series")
    response["indicator_series"] = analysis.get("indicator_series")
    response["trade_markers"] = analysis.get("trade_markers")
    response["run_logs"] = analysis.get("run_logs")

    # Convenience for the detail header (upstream left this empty; the context
    # always carries the prompt, so surface it).
    context = response.get("run_context") or {}
    if context.get("prompt"):
        response["prompt"] = context["prompt"]

    return response


def get_run_code(workspace: str | Path, run_id: str) -> dict[str, str]:
    """Strategy source files for a run (upstream ``GET /runs/{run_id}/code``)."""
    if not RUN_ID_RE.match(run_id):
        raise ValueError("invalid run id")
    code_dir = runs_dir(workspace) / run_id / "code"
    if not code_dir.is_dir():
        raise FileNotFoundError(f"Code directory for run {run_id} not found")
    result: dict[str, str] = {}
    for f in ["signal_engine.py"]:
        p = code_dir / f
        if p.exists():
            result[f] = p.read_text(encoding="utf-8")
    return result
