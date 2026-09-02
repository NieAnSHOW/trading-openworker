"""Backtest reports service + REST routes: run listing, detail payload, id validation.

Runs are directory-per-run artifacts (Vibe-Trading upstream layout) scanned from
``<workspace>/runs``; fixtures here build that tree on tmp_path.
"""

from __future__ import annotations

import csv
import json

import pytest

from fastapi.testclient import TestClient

from coworker import reports
from coworker.server.app import create_app
from coworker.server.manager import SessionManager


def _make_run(
    run_dir,
    *,
    status="success",
    metrics=None,
    equity=None,
    trades=None,
    req=None,
    planner=None,
    prompt_text=None,
    ohlcv=None,
    run_card=None,
):
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(
        json.dumps({"status": status}), encoding="utf-8"
    )
    if metrics is not None:
        artifacts = run_dir / "artifacts"
        artifacts.mkdir()
        with (artifacts / "metrics.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(metrics))
            writer.writeheader()
            writer.writerow(metrics)
    if equity is not None:
        artifacts = run_dir / "artifacts"
        artifacts.mkdir(exist_ok=True)
        with (artifacts / "equity.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["timestamp", "equity", "drawdown"])
            writer.writeheader()
            writer.writerows(equity)
    if trades is not None:
        artifacts = run_dir / "artifacts"
        artifacts.mkdir(exist_ok=True)
        with (artifacts / "trades.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f, fieldnames=["timestamp", "code", "side", "price", "qty", "reason"]
            )
            writer.writeheader()
            writer.writerows(trades)
    if ohlcv is not None:
        artifacts = run_dir / "artifacts"
        artifacts.mkdir(exist_ok=True)
        for code, rows in ohlcv.items():
            with (artifacts / f"ohlcv_{code}.csv").open(
                "w", newline="", encoding="utf-8"
            ) as f:
                writer = csv.DictWriter(
                    f,
                    fieldnames=["trade_date", "open", "high", "low", "close", "volume"],
                )
                writer.writeheader()
                writer.writerows(rows)
    if req is not None:
        (run_dir / "req.json").write_text(json.dumps(req), encoding="utf-8")
    if planner is not None:
        (run_dir / "planner_output.json").write_text(
            json.dumps(planner), encoding="utf-8"
        )
    if prompt_text is not None:
        (run_dir / "user_prompt.txt").write_text(prompt_text, encoding="utf-8")
    if run_card is not None:
        (run_dir / "run_card.json").write_text(json.dumps(run_card), encoding="utf-8")
    return run_dir


@pytest.fixture()
def client(tmp_path):
    manager = SessionManager(workspace=tmp_path / "ws")
    return TestClient(create_app(manager)), tmp_path / "ws"


def test_list_runs_summarizes_state_metrics_and_context(tmp_path):
    ws = tmp_path / "ws"
    _make_run(
        reports.runs_dir(ws) / "run_20250102_030405",
        status="success",
        metrics={
            "final_value": 1234567.8,
            "total_return": 0.234,
            "sharpe": 1.51,
            "trade_count": 9,
        },
        req={
            "prompt": "test momentum",
            "context": {
                "codes": ["000001.SZ", "600000.SH"],
                "start_date": "2024-01-01",
                "end_date": "2024-06-30",
            },
        },
    )
    # No state.json — status falls back to artifacts.
    _make_run(
        reports.runs_dir(ws) / "run_20250101_000000",
        equity=[{"timestamp": "2024-01-01", "equity": 100, "drawdown": 0}],
    )

    runs = reports.list_runs(ws, limit=10)
    assert len(runs) == 2
    assert runs[0]["run_id"] == "run_20250102_030405"  # newest first
    assert runs[0]["status"] == "success"
    assert runs[0]["created_at"] == "2025-01-02 03:04:05"
    assert runs[0]["prompt"] == "test momentum"
    assert runs[0]["total_return"] == pytest.approx(0.234)
    assert runs[0]["sharpe"] == pytest.approx(1.51)
    assert runs[0]["codes"] == ["000001.SZ", "600000.SH"]
    assert runs[1]["status"] == "success"  # equity.csv fallback


def test_list_runs_prompt_fallbacks(tmp_path):
    ws = tmp_path / "ws"
    _make_run(
        reports.runs_dir(ws) / "run_20250101_000001",
        planner={"user_goal": "planner goal"},
        prompt_text="file prompt",
    )
    runs = reports.list_runs(ws)
    assert runs[0]["prompt"] == "planner goal"

    _make_run(reports.runs_dir(ws) / "run_20250101_000002", prompt_text="file prompt")
    runs = reports.list_runs(ws)
    assert runs[0]["prompt"] == "file prompt"

    _make_run(reports.runs_dir(ws) / "run_20250101_000003")
    runs = reports.list_runs(ws)
    assert runs[0]["prompt"] == "Manual Analysis"


def test_list_runs_missing_dir_is_empty(tmp_path):
    assert reports.list_runs(tmp_path / "nope") == []


def test_get_run_full_payload(tmp_path):
    ws = tmp_path / "ws"
    _make_run(
        reports.runs_dir(ws) / "run_20250102_030405",
        status="success",
        metrics={
            "final_value": 100000.0,
            "total_return": 0.1,
            "sharpe": 0.9,
            "trade_count": 3,
            "max_consecutive_loss": 2,
        },
        equity=[
            {"timestamp": "2024-01-01", "equity": 100, "drawdown": 0},
            {"timestamp": "2024-01-02", "equity": 110, "drawdown": -0.01},
        ],
        trades=[
            {
                "timestamp": "2024-01-01 09:31:00",
                "code": "000001.SZ",
                "side": "BUY",
                "price": 10.0,
                "qty": 100,
                "reason": "signal",
            }
        ],
        req={
            "prompt": "momentum run",
            "context": {
                "codes": ["000001.SZ"],
                "start_date": "2024-01-01",
                "end_date": "2024-01-31",
            },
        },
        ohlcv={
            "000001.SZ": [
                {
                    "trade_date": "2024-01-01",
                    "open": 10,
                    "high": 11,
                    "low": 9.5,
                    "close": 10.5,
                    "volume": 1000,
                },
                {
                    "trade_date": "2024-01-02",
                    "open": 10.5,
                    "high": 11.5,
                    "low": 10,
                    "close": 11,
                    "volume": 1100,
                },
            ]
        },
        run_card={"schema_version": "1", "backtest": {"period": "2024-01"}},
    )
    detail = reports.get_run(ws, "run_20250102_030405")
    assert detail["status"] == "success"
    assert detail["prompt"] == "momentum run"
    assert detail["metrics"]["trade_count"] == 3
    assert detail["metrics"]["max_consecutive_loss"] == 2
    assert detail["metrics"]["sharpe"] == pytest.approx(0.9)
    assert len(detail["equity_curve"]) == 2
    assert detail["equity_curve"][0] == {
        "time": "2024-01-01",
        "equity": "100",
        "drawdown": "0",
    }
    assert detail["trade_log"][0]["code"] == "000001.SZ"
    assert detail["run_card"]["schema_version"] == "1"
    assert detail["chart_symbols"] == ["000001.SZ"]
    bars = detail["price_series"]["000001.SZ"]
    assert bars[0]["time"] == "2024-01-01" and bars[0]["close"] == 10.5
    # indicator overlays computed from closes
    assert detail["indicator_series"]["000001.SZ"]["ma5"][0]["value"] is None
    markers = detail["trade_markers"]
    assert (
        markers and markers[0]["side"] == "BUY" and markers[0]["time"] == "2024-01-01"
    )
    assert detail["run_stage"] == "done"


def test_get_run_summary_mode_strips_chart_rows(tmp_path):
    ws = tmp_path / "ws"
    _make_run(
        reports.runs_dir(ws) / "run_20250102_030405",
        status="success",
        req={
            "prompt": "p",
            "context": {
                "codes": ["000001.SZ"],
                "start_date": "2024-01-01",
                "end_date": "2024-01-31",
            },
        },
        ohlcv={
            "000001.SZ": [
                {
                    "trade_date": "2024-01-01",
                    "open": 10,
                    "high": 11,
                    "low": 9.5,
                    "close": 10.5,
                    "volume": 1000,
                },
            ]
        },
    )
    detail = reports.get_run(ws, "run_20250102_030405", chart_payload="summary")
    assert detail["price_series"] == {}
    assert detail["indicator_series"] == {}
    assert detail["chart_symbols"] == ["000001.SZ"]


def test_get_run_symbol_filter(tmp_path):
    ws = tmp_path / "ws"
    _make_run(
        reports.runs_dir(ws) / "run_20250102_030405",
        req={
            "prompt": "p",
            "context": {
                "codes": ["A", "B"],
                "start_date": "2024-01-01",
                "end_date": "2024-01-31",
            },
        },
        ohlcv={
            "A": [
                {
                    "trade_date": "2024-01-01",
                    "open": 1,
                    "high": 1,
                    "low": 1,
                    "close": 1,
                    "volume": 1,
                }
            ],
            "B": [
                {
                    "trade_date": "2024-01-01",
                    "open": 2,
                    "high": 2,
                    "low": 2,
                    "close": 2,
                    "volume": 2,
                }
            ],
        },
    )
    detail = reports.get_run(ws, "run_20250102_030405", chart_symbol="A")
    assert list(detail["price_series"]) == ["A"]
    assert detail["chart_symbols"] == ["A", "B"]


def test_run_id_validation_rejects_traversal(tmp_path):
    ws = tmp_path / "ws"
    with pytest.raises(ValueError):
        reports.get_run(ws, "../escape")
    with pytest.raises(ValueError):
        reports.get_run(ws, "a/b")
    with pytest.raises(FileNotFoundError):
        reports.get_run(ws, "run_404_000000")


def test_get_run_code(tmp_path):
    ws = tmp_path / "ws"
    run = reports.runs_dir(ws) / "run_20250102_030405"
    _make_run(run)
    code_dir = run / "code"
    code_dir.mkdir()
    (code_dir / "signal_engine.py").write_text("def signal(): ...\n", encoding="utf-8")
    assert (
        "def signal"
        in reports.get_run_code(ws, "run_20250102_030405")["signal_engine.py"]
    )
    with pytest.raises(FileNotFoundError):
        reports.get_run_code(ws, "run_404_000000")


def test_routes_serve_runs_from_default_workspace(client):
    api, ws = client
    _make_run(
        reports.runs_dir(ws) / "run_20250102_030405",
        status="success",
        metrics={
            "final_value": 100.0,
            "total_return": 0.05,
            "sharpe": 1.0,
            "trade_count": 1,
        },
        req={
            "prompt": "route run",
            "context": {
                "codes": ["A"],
                "start_date": "2024-01-01",
                "end_date": "2024-01-31",
            },
        },
    )
    listed = api.get("/v1/reports/runs").json()
    assert listed[0]["run_id"] == "run_20250102_030405"

    detail = api.get(
        "/v1/reports/runs/run_20250102_030405", params={"chart_payload": "summary"}
    ).json()
    assert detail["status"] == "success" and detail["prompt"] == "route run"

    assert api.get("/v1/reports/runs/run_404_000000").status_code == 404
    # Encoded traversal can't form a route segment: blocked by routing (404)
    # or by the service-level id regex (400).
    assert api.get("/v1/reports/runs/%2E%2E%2Fescape").status_code in (400, 404)
