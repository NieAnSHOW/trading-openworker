"""/v1/watchlist — the shared A-share watchlist store (自选股).

The GUI 行情 page and the agent's ``watchlist_read`` tool share one JSON
document in the state dir; these tests cover the route contract (validation,
idempotent add/delete) and the store's shared-file semantics. The autouse
``_isolated_state_dir`` fixture points ``state_dir()`` at ``tmp_path``.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from coworker.server import SessionManager, create_app
from coworker.watchlist import add_stock, list_stocks, remove_stock


@pytest.fixture()
def client(tmp_path):
    manager = SessionManager(workspace=tmp_path)
    return TestClient(create_app(manager))


def test_watchlist_add_list_delete_roundtrip(client):
    res = client.post("/v1/watchlist", json={"code": "600519"})
    assert res.status_code == 200
    assert res.json() == {"added": True, "exists": False}

    res = client.get("/v1/watchlist")
    assert res.status_code == 200
    stocks = res.json()["stocks"]
    assert [s["code"] for s in stocks] == ["600519"]
    assert stocks[0]["market"] == "a_stock"
    assert stocks[0]["added_at"]

    res = client.delete("/v1/watchlist/600519")
    assert res.status_code == 200
    assert res.json() == {"deleted": True}
    assert client.get("/v1/watchlist").json()["stocks"] == []


def test_watchlist_add_rejects_malformed_code(client):
    for bad in ("60051", "60051a", "", "6005199"):
        res = client.post("/v1/watchlist", json={"code": bad})
        assert res.status_code == 400, bad
    assert client.get("/v1/watchlist").json()["stocks"] == []


def test_watchlist_add_is_idempotent(client):
    assert client.post("/v1/watchlist", json={"code": "000001"}).json() == {
        "added": True,
        "exists": False,
    }
    assert client.post("/v1/watchlist", json={"code": "000001"}).json() == {
        "added": False,
        "exists": True,
    }
    assert len(client.get("/v1/watchlist").json()["stocks"]) == 1


def test_watchlist_delete_unknown_code_reports_not_deleted(client):
    res = client.delete("/v1/watchlist/999999")
    assert res.status_code == 200
    assert res.json() == {"deleted": False}


def test_store_survives_corrupt_file(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    (state / "watchlist.json").write_text("{not json", encoding="utf-8")
    assert list_stocks() == []
    # The next write replaces the corrupt document instead of compounding it.
    assert add_stock("300750")["added"] is True
    assert [s["code"] for s in list_stocks()] == ["300750"]
    assert remove_stock("300750")["deleted"] is True


def test_watchlist_read_tool_reflects_store_changes():
    from coworker.tools.trading.watchlist_tool import WatchlistReadTool

    tool = WatchlistReadTool()
    empty = json.loads(tool.execute())
    assert empty == {"ok": True, "count": 0, "stocks": []}

    add_stock("600519")
    add_stock("000001")
    payload = json.loads(tool.execute())
    assert payload["ok"] is True
    assert payload["count"] == 2
    assert [s["code"] for s in payload["stocks"]] == ["600519", "000001"]


def test_watchlist_read_registered_in_registry():
    # The tool must be reachable through the real registry expansion, not just
    # as a bare class (guards the _TOOL_MODULES INSERT-not-REPLACE hazard).
    from coworker.tools.trading import trading_tools

    names = {t.__coworker_schema__["function"]["name"] for t in trading_tools()}
    assert "watchlist_read" in names


def test_iwencai_sibling_still_registered_with_key(monkeypatch):
    # Insertion next to env-gated iwencai must not have displaced it; keyed
    # cache must not leak into other tests (same pattern as test_hithink_tool).
    monkeypatch.setenv("VIBE_TRADING_IWENCAI_KEY", "k")
    monkeypatch.setattr("coworker.tools.trading._cache", None)
    from coworker.tools.trading import trading_tools

    names = {t.__coworker_schema__["function"]["name"] for t in trading_tools()}
    assert "iwencai_search" in names
    monkeypatch.setattr("coworker.tools.trading._cache", None)
