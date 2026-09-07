"""GET /v1/dashboard/daily-bars — the 自选 detail chart's daily K feed.

Ported from Vibe-Trading-Desktop's ``dashboard_routes`` daily-bars endpoint
(Tencent fqkline via ``coworker/dashboard.py``), replacing the flaky
browser-side JSONP ``kline.cn`` fetch. Upstream HTTP is monkeypatched; what's
under test is the route contract (symbol validation → 400, upstream failure →
503) and the fetcher's normalization of Tencent kline rows.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from coworker.server import SessionManager, create_app


@pytest.fixture()
def client(tmp_path):
    manager = SessionManager(workspace=tmp_path)
    return TestClient(create_app(manager))


def _fake_rows():
    return [
        {
            "time": "2026-06-01",
            "open": 21.32,
            "close": 21.5,
            "high": 21.9,
            "low": 21.1,
            "volume": 12345.0,
        }
    ]


def test_daily_bars_route_passes_through_rows(client, monkeypatch):
    import coworker.dashboard as dashboard

    monkeypatch.setattr(dashboard, "fetch_daily_bars", lambda symbol: _fake_rows())

    res = client.get("/v1/dashboard/daily-bars", params={"symbol": "600519"})
    assert res.status_code == 200
    body = res.json()
    assert body["data"] == _fake_rows()
    assert body["source"] == "tencent-kline"
    assert body["stale"] is False
    assert body["as_of"]


def test_daily_bars_rejects_non_a_share_symbol(client):
    res = client.get("/v1/dashboard/daily-bars", params={"symbol": "AAPL"})
    assert res.status_code == 400


def test_daily_bars_upstream_failure_is_503(client, monkeypatch):
    import coworker.dashboard as dashboard

    def boom(symbol):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(dashboard, "fetch_daily_bars", boom)
    res = client.get("/v1/dashboard/daily-bars", params={"symbol": "600519"})
    assert res.status_code == 503
    assert "daily bars" in res.json()["detail"]


def test_fetch_daily_bars_normalizes_tencent_rows(monkeypatch):
    import coworker.dashboard as dashboard

    captured = {}

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {
                "code": 0,
                "data": {
                    "sh600519": {
                        # qfqday rows must win over the raw `day` list.
                        "qfqday": [
                            [
                                "2026-06-01",
                                "21.32",
                                "21.50",
                                "21.90",
                                "21.10",
                                "12345.0",
                            ],
                            ["bad", "row"],  # too short → filtered out
                        ],
                        "day": [["1999-01-01", "1", "1", "1", "1", "1"]],
                    }
                },
            }

    def fake_get(url, params=None, headers=None, timeout=None):
        captured["params"] = params
        return _Resp()

    monkeypatch.setattr(dashboard.httpx, "get", fake_get)
    rows = dashboard.fetch_daily_bars("600519")
    assert rows == _fake_rows()
    # 6xx → sh inference; day window + qfq request shape in the param.
    param = captured["params"]["param"]
    assert param.startswith("sh600519,day,")
    assert param.endswith(",500,qfq")


def test_qualify_a_share_symbol_exchange_inference():
    import coworker.dashboard as dashboard

    assert dashboard.qualify_a_share_symbol("600519") == "600519.SH"
    assert dashboard.qualify_a_share_symbol("000001") == "000001.SZ"
    assert dashboard.qualify_a_share_symbol("sz000001") == "000001.SZ"
    assert dashboard.qualify_a_share_symbol("SH600519") == "600519.SH"
    assert dashboard.qualify_a_share_symbol("510300") == "510300.SH"
    with pytest.raises(ValueError):
        dashboard.qualify_a_share_symbol("12345")
