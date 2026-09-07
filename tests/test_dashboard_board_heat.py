"""GET /v1/dashboard/board-heat — the GUI 行情 page's board-heat feed.

Upstream (10jqka) is monkeypatched; what's under test is the route contract
(kind validation, pass-through, fail-closed 503) and the fetcher's
normalization of raw upstream rows.
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
            "code": "885566",
            "name": "算力租赁",
            "change_pct": 3.42,
            "rise_count": None,
            "fall_count": None,
            "leading_stock": None,
            "leading_stock_change_pct": None,
        }
    ]


def test_board_heat_route_passes_through_normalized_rows(client, monkeypatch):
    import coworker.dashboard as dashboard

    monkeypatch.setattr(dashboard, "fetch_board_heat", lambda kind: _fake_rows())

    res = client.get("/v1/dashboard/board-heat", params={"kind": "concept"})
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "10jqka-hot-list"
    assert body["stale"] is False
    assert body["data"] == _fake_rows()
    assert body["as_of"]


def test_fetch_board_heat_normalizes_upstream(monkeypatch):
    import coworker.dashboard as dashboard

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {
                "data": {
                    "plate_list": [
                        {
                            "code": "885566",
                            "name": "算力租赁",
                            "rise_and_fall": "3.42",
                            "extra_field": "dropped",
                        },
                        {"code": "", "name": "no-code row"},  # filtered out
                    ]
                }
            }

    monkeypatch.setattr(dashboard.httpx, "get", lambda *a, **kw: _Resp())
    monkeypatch.setattr(dashboard, "_cache", {})
    assert dashboard.fetch_board_heat("concept") == _fake_rows()


def test_board_heat_rejects_unknown_kind(client):
    res = client.get("/v1/dashboard/board-heat", params={"kind": "etf"})
    assert res.status_code == 400


def test_board_heat_upstream_failure_is_503(client, monkeypatch):
    import coworker.dashboard as dashboard

    def boom(kind):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(dashboard, "fetch_board_heat", boom)
    res = client.get("/v1/dashboard/board-heat", params={"kind": "industry"})
    assert res.status_code == 503
    assert "industry" in res.json()["detail"]
