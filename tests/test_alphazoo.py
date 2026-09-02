"""Alpha Zoo service + REST routes: browse contract, validation, job lifecycle shape."""

from __future__ import annotations

import time

import pytest

from fastapi.testclient import TestClient

from coworker.server.app import create_app
from coworker.server.manager import SessionManager


@pytest.fixture()
def client(tmp_path):
    manager = SessionManager(workspace=tmp_path / "ws")
    return TestClient(create_app(manager))


def test_health_reports_registry_counts(client):
    body = client.get("/v1/alphazoo/health").json()
    assert body["status"] == "ok"
    assert body["registry"]["loaded"] >= 400
    assert body["registry"]["failed"] == 0


def test_list_and_detail_contract(client):
    listed = client.get(
        "/v1/alphazoo/alphas", params={"zoo": "qlib158", "limit": 5}
    ).json()
    assert listed["status"] == "ok" and listed["total"] > 100
    assert len(listed["alphas"]) == 5
    row = listed["alphas"][0]
    assert {"id", "zoo", "theme", "universe"} <= set(row)

    detail = client.get(f"/v1/alphazoo/alphas/{row['id']}").json()
    assert detail["alpha"]["id"] == row["id"]
    assert "formula_latex" in detail["alpha"]["meta"]
    assert "def " in detail["source_code"]


def test_list_filters_are_validated(client):
    assert "error" in client.get("/v1/alphazoo/alphas", params={"zoo": "nope"}).json()
    assert "error" in client.get("/v1/alphazoo/alphas", params={"theme": "nope"}).json()
    assert (
        "error" in client.get("/v1/alphazoo/alphas", params={"universe": "nope"}).json()
    )


def test_detail_unknown_id_is_an_error(client):
    assert "error" in client.get("/v1/alphazoo/alphas/qlib158_does_not_exist").json()


def test_bench_request_validation(client):
    bad_period = client.post(
        "/v1/alphazoo/bench",
        json={"zoo": "qlib158", "universe": "sp500", "period": "bogus", "top": 5},
    ).json()
    assert bad_period["ok"] is False and "invalid period" in bad_period["error"]

    bad_zoo = client.post(
        "/v1/alphazoo/bench",
        json={"zoo": "nope", "universe": "sp500", "period": "2020-2025", "top": 5},
    ).json()
    assert bad_zoo["ok"] is False and "unknown zoo" in bad_zoo["error"]

    bad_universe = client.post(
        "/v1/alphazoo/bench",
        json={"zoo": "qlib158", "universe": "lse", "period": "2020-2025", "top": 5},
    ).json()
    assert bad_universe["ok"] is False and "unknown universe" in bad_universe["error"]


def test_bench_job_lifecycle_shape(client, monkeypatch):
    """Kick off → queued/running → done, with the slimmed wire result. The runner is
    stubbed so no network panel is fetched; the job-store mechanics stay real."""
    import coworker.alphazoo as az

    def _fake_run(job_id, zoo, universe, period, top):
        cb = az._progress_cb(az._BENCH_JOBS, job_id)
        with az._JOBS_LOCK:
            az._BENCH_JOBS[job_id]["status"] = "running"
        cb(1, 2, "qlib158_ma5")  # takes _JOBS_LOCK itself — never nested under it
        result = {
            "status": "ok",
            "alive": 1,
            "reversed": 0,
            "dead": 1,
            "n_skipped": 0,
            "top5_by_ir": [
                {
                    "id": "qlib158_ma5",
                    "ic_mean": 0.05,
                    "ir": 0.4,
                    "theme": ["momentum"],
                    "category": "alive",
                }
            ],
            "dead_examples": [],
            "by_theme": {"momentum": {"alive": 1, "reversed": 0, "dead": 1}},
            "rows": ["stripped-from-wire"],
        }
        with az._JOBS_LOCK:
            az._finish_ok(az._BENCH_JOBS[job_id], result, slim=True)
            az._BENCH_JOBS[job_id]["_finished_at"] = time.time()

    monkeypatch.setattr(az, "_run_bench_blocking", _fake_run)
    kicked = client.post(
        "/v1/alphazoo/bench",
        json={"zoo": "qlib158", "universe": "sp500", "period": "2020-2025", "top": 5},
    ).json()
    assert kicked["status"] == "ok"
    job_id = kicked["job_id"]

    deadline = time.time() + 5
    while time.time() < deadline:
        view = client.get(f"/v1/alphazoo/bench/{job_id}").json()
        if view["job"]["status"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert view["status"] == "ok" and view["job"]["status"] == "done"
    assert view["job"]["result"]["alive"] == 1
    assert "rows" not in view["job"]["result"]  # slimmed
    assert view["job"]["result"]["skipped"] == 0  # n_skipped renamed

    assert client.get("/v1/alphazoo/bench/ghost").json()["ok"] is False


def test_compare_validation(client):
    body = client.post(
        "/v1/alphazoo/compare",
        json={
            "alpha_ids": ["qlib158_ma5"],
            "universe": "sp500",
            "period": "2020-2025",
            "sort": "ir",
        },
    ).json()
    assert body["ok"] is False  # needs >= 2 ids
