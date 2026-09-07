"""Market-dashboard board-heat feed — 10jqka hot-board ranking, cached.

Ported from Vibe-Trading-Desktop ``agent/src/api/dashboard_routes.py``
(``GET /dashboard/board-heat``). The GUI 行情 dashboard renders its concept /
industry heat cards from this feed; everything else on that page (indexes,
breadth, limit ladder, rankings) is fetched client-side by the ``stock-sdk``
browser package and never touches the server.

Fail closed for callers: any upstream/parse problem raises — the route turns
that into a 503 so the GUI marks the area stale and keeps its previous data.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Literal

import httpx

_THS_HOT_LIST_URL = "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate"
_TTL_SECONDS = 300.0
_MIN_INTERVAL = 0.2  # seconds between upstream hits (politeness throttle)

_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_last_hit = 0.0

BoardHeatKind = Literal["concept", "industry"]


def _optional_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None  # NaN check


def fetch_board_heat(kind: BoardHeatKind) -> list[dict[str, Any]]:
    """Blocking: fetch + normalize the 10jqka hot-board ranking for ``kind``.

    5-minute per-kind TTL cache; the throttle + cache-check and the network
    call deliberately do NOT share a lock hold (a slow upstream must not stall
    the other kind).
    """
    global _last_hit
    with _lock:
        hit = _cache.get(kind)
        if hit and time.monotonic() - hit[0] < _TTL_SECONDS:
            return hit[1]
        wait = _MIN_INTERVAL - (time.monotonic() - _last_hit)
        if wait > 0:
            time.sleep(wait)
        _last_hit = time.monotonic()

    resp = httpx.get(
        _THS_HOT_LIST_URL,
        params={"type": kind},
        headers={
            # Upstream (10jqka) 403s the bare python-httpx UA — same reason the
            # Vibe-Trading loader sends a desktop Chrome UA for every quote host.
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Accept": "application/json",
            "Referer": "https://eq.10jqka.com.cn/",
        },
        timeout=10.0,
    )
    resp.raise_for_status()
    payload = resp.json() if isinstance(resp.json(), dict) else {}
    data = payload.get("data")
    rows = data.get("plate_list") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ValueError("10jqka board response did not contain plate_list")

    normalized = [
        {
            "code": str(row["code"]),
            "name": str(row["name"]),
            "change_pct": _optional_float(row.get("rise_and_fall")),
            "rise_count": None,
            "fall_count": None,
            "leading_stock": None,
            "leading_stock_change_pct": None,
        }
        for row in rows
        if isinstance(row, dict) and row.get("code") and row.get("name")
    ]
    with _lock:
        _cache[kind] = (time.monotonic(), normalized)
    return normalized
