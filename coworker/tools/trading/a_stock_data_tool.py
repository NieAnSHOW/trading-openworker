"""A-share research data tool backed by the a-stock-data adapter."""

from __future__ import annotations

import json
from typing import Any

from coworker.tools.trading._loaders.a_stock_data import AStockDataClient
from coworker.tools.trading._compat import BaseTool


class AStockDataTool(BaseTool):
    """Fetch A-share reports, news, basics, and announcements."""

    name = "get_a_stock_data"
    repeatable = True
    description = (
        "Fetch A-share non-OHLC data through the a-stock-data adapter. "
        "Use get_market_data for price bars; use this for research reports, "
                "stock news, basic stock data, announcements, or 7x24 global finance news.  Eastmoney backend (IP rate-limited — batch symbols, avoid concurrent calls with other Eastmoney tools)."    )
    parameters = {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "A-share symbol such as 600519.SH, SH600519, or 600519.",
            },
            "category": {
                "type": "string",
                "enum": ["reports", "news", "basic", "announcements", "global_news"],
                "description": "Data category to fetch.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum records for list categories.",
                "default": 20,
            },
        },
        "required": ["category"],
    }

    def execute(self, **kwargs: Any) -> str:
        category = kwargs["category"]
        code = kwargs.get("code", "")
        limit = int(kwargs.get("limit") or 20)
        client = AStockDataClient()

        if category == "reports":
            payload = client.research_reports(code, max_pages=max(1, min(5, (limit + 99) // 100)))[:limit]
        elif category == "news":
            payload = client.stock_news(code, page_size=limit)[:limit]
        elif category == "basic":
            payload = client.basic_data(code)
        elif category == "announcements":
            payload = client.announcements(code, page_size=limit)[:limit]
        elif category == "global_news":
            payload = client.global_news(page_size=limit)[:limit]
        else:
            raise ValueError(f"unsupported a-stock-data category: {category!r}")

        return json.dumps(
            {"status": "ok", "source": "a_stock_data", "category": category, "data": payload},
            ensure_ascii=False,
            indent=2,
            allow_nan=False,
        )
