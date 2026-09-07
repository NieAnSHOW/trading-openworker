"""Agent tool: read the user's A-share watchlist (自选股).

The GUI 行情 page's watchlist (coworker/watchlist.py, shared JSON store) is the
single source of truth; this tool hands the same list to the agent so it can
pull quotes/fundamentals for exactly the stocks the user tracks (deeper fusion
with the watchlist surface). Read-only over user-owned data: classify()=READ —
no approval card, matching the other trading tools.
"""

from __future__ import annotations

import json

from coworker.tools.trading._compat import BaseTool
from coworker.watchlist import list_stocks


class WatchlistReadTool(BaseTool):
    name = "watchlist_read"
    description = (
        "Read the user's A-share watchlist (自选股) — the stock codes they track "
        "in the 行情 page. Returns {ok, count, stocks:[{code, name, market, "
        "added_at}]}. Use it to scope analysis to the user's own picks, then "
        "fetch quotes/K-lines for those codes with the other market-data tools."
    )
    parameters = {
        "type": "object",
        "properties": {
            "market": {
                "type": "string",
                "description": (
                    "Optional market filter, e.g. 'a_stock' (default: all markets)"
                ),
            },
        },
        "required": [],
    }

    @classmethod
    def check_available(cls) -> bool:
        return True

    def execute(self, market: str | None = None) -> str:
        try:
            stocks = list_stocks(market)
        except Exception as exc:  # noqa: BLE001 — surfaced as an envelope, never raised
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
        return json.dumps(
            {"ok": True, "count": len(stocks), "stocks": stocks},
            ensure_ascii=False,
        )
