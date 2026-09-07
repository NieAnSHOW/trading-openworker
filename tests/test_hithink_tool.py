"""hithink_request tool: key gating, envelope shaping, path guard, registration."""

from __future__ import annotations

import json

import pytest

import coworker.tools.trading.hithink_tool as ht
from coworker.tools.trading.hithink_tool import HithinkRequestTool


class _FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text or json.dumps(payload or {})

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


@pytest.fixture()
def keyed(monkeypatch):
    monkeypatch.setenv("HITHINK_FINANCE_API_KEY", "fuyao-key-123")


def test_key_gating_reads_env_live(monkeypatch):
    monkeypatch.delenv("HITHINK_FINANCE_API_KEY", raising=False)
    assert not HithinkRequestTool.check_available()
    # live-read: saving the key in Settings makes the tool available without restart
    monkeypatch.setenv("HITHINK_FINANCE_API_KEY", "fuyao-key-123")
    assert HithinkRequestTool.check_available()


def test_execute_requires_key(monkeypatch):
    monkeypatch.delenv("HITHINK_FINANCE_API_KEY", raising=False)
    out = json.loads(
        HithinkRequestTool().execute("/api/meta/tickers/search", {"q": "600519"})
    )
    assert out["ok"] is False and "HITHINK_FINANCE_API_KEY" in out["error"]
    assert (
        "fuyao.aicubes.cn/admin" in out["error"]
    )  # guided to issuance, no value echoed


def test_execute_rejects_non_api_paths(keyed):
    out = json.loads(HithinkRequestTool().execute("https://evil.example.com/x"))
    assert out["ok"] is False and "path must start with /api/" in out["error"]


def test_execute_success_envelope(keyed, monkeypatch):
    captured = {}

    def fake_get(url, *, host_key, min_interval, params, headers, timeout):
        captured.update(url=url, params=params, headers=headers)
        return _FakeResp(
            payload={
                "code": 0,
                "message": "ok",
                "request_id": "r1",
                "data": {"price": 1},
            }
        )

    monkeypatch.setattr(ht, "throttled_get", fake_get)
    out = json.loads(
        HithinkRequestTool().execute(
            "/api/quote/snapshot", {"thscode": "600519.SH", "x": None}
        )
    )
    assert out == {"ok": True, "data": {"price": 1}, "request_id": "r1"}
    assert captured["url"] == "https://fuyao.aicubes.cn/api/quote/snapshot"
    assert captured["headers"]["X-api-key"] == "fuyao-key-123"  # key read at call time
    assert captured["params"] == {"thscode": "600519.SH"}  # None params dropped


def test_execute_business_error_shapes_envelope(keyed, monkeypatch):
    monkeypatch.setattr(
        ht,
        "throttled_get",
        lambda *a, **k: _FakeResp(
            payload={
                "code": 2003,
                "message": "Key 无效",
                "request_id": "r2",
                "data": None,
            }
        ),
    )
    out = json.loads(HithinkRequestTool().execute("/api/quote/snapshot"))
    assert out == {"ok": False, "code": 2003, "error": "Key 无效", "request_id": "r2"}


def test_execute_http_and_transport_failures(keyed, monkeypatch):
    monkeypatch.setattr(
        ht,
        "throttled_get",
        lambda *a, **k: _FakeResp(status_code=502, text="bad gateway"),
    )
    out = json.loads(HithinkRequestTool().execute("/api/x"))
    assert out["ok"] is False and out["error"] == "HTTP 502"

    def boom(*a, **k):
        raise ConnectionError("reset")

    monkeypatch.setattr(ht, "throttled_get", boom)
    out = json.loads(HithinkRequestTool().execute("/api/x"))
    assert out["ok"] is False and "reset" in out["error"]


def test_execute_caps_runaway_payload(keyed, monkeypatch):
    big = {"code": 0, "data": {"rows": ["x" * 1000] * 200}}
    monkeypatch.setattr(ht, "throttled_get", lambda *a, **k: _FakeResp(payload=big))
    out = json.loads(HithinkRequestTool().execute("/api/x"))
    assert out["ok"] is False and "too large" in out["error"]


def test_registers_with_read_risk_and_schema(monkeypatch):
    from coworker.risk import RiskClass, classify
    from coworker.tools.registry import ToolRegistry
    from coworker.tools.trading import trading_tools

    monkeypatch.setenv("HITHINK_FINANCE_API_KEY", "fuyao-key-123")
    monkeypatch.setattr("coworker.tools.trading._cache", None)  # rebuild with the key
    reg = ToolRegistry()
    reg.register_all(trading_tools())
    assert "hithink_request" in reg.names()
    fn = reg.get("hithink_request").schema["function"]
    assert fn["parameters"]["required"] == ["path"]
    assert (
        classify("hithink_request", reg.get("hithink_request").metadata)
        is RiskClass.READ
    )
    monkeypatch.setattr(
        "coworker.tools.trading._cache", None
    )  # don't leak the keyed cache
