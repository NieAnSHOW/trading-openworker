"""Vibe-Trading market-data tools, vendored and adapted for coworker.

Provenance: /Vibe-Trading-Desktop `src/tools/*_tool.py` + `backtest/loaders` clients +
`src/market_data.py`, with `src.*`/`backtest.*` imports rewritten to this package.
Tool classes keep their upstream shape (`BaseTool`: name/description/parameters JSON
schema/execute) and are wrapped here into plain callables for coworker's ToolRegistry:

- the upstream OpenAI JSON schema rides as `__coworker_schema__` (registry honors it);
- metadata declares category="trading", risk_level="low", no requires_approval — so
  `risk.classify` treats them as READ: freely callable, no approval card. They only
  send ticker/symbol queries to fixed public endpoints (eastmoney/yahoo/SEC EDGAR);
  tighten via user-local risk_overrides.json if ever needed.

Modules whose third-party deps are missing (pandas for a_stock_data today) are skipped
at import, matching upstream's check_available() philosophy.
"""

from __future__ import annotations

import importlib
import logging

import aisuite as ai

from ._compat import BaseTool, tool_classes

logger = logging.getLogger("coworker.tools.trading")

_TOOL_MODULES = (
    "a_stock_data_tool",
    "market_data_tool",
    "dragon_tiger_tool",
    "northbound_tool",
    "fund_flow_tool",
    "margin_trading_tool",
    "lockup_expiry_tool",
    "shareholder_count_tool",
    "stock_news_tool",
    "stock_profile_tool",
    "sector_tool",
    "symbol_search_tool",
    "iwencai_tool",
    "sec_filings_tool",
    "research_reports_tool",
    "alpha_zoo_tool",
    "alpha_bench_tool",
    "alpha_compare_tool",
)

_cache: list | None = None


def _build() -> list:
    tools: list = []
    seen: set[str] = set()
    for mod_name in _TOOL_MODULES:
        try:
            module = importlib.import_module(f".{mod_name}", __package__)
        except ImportError as exc:
            logger.warning("trading tool module skipped (%s): %s", mod_name, exc)
            continue
        for cls in tool_classes(module):
            if cls.name in seen or not cls.check_available():
                continue
            seen.add(cls.name)
            tools.append(_wrap(cls()))
    return tools


def _wrap(inst: BaseTool):
    schema = inst.to_openai_schema()  # full {"type":"function", ...} envelope

    def call(**kwargs):
        return inst.execute(**kwargs)

    call.__name__ = inst.name
    call.__doc__ = inst.description
    call.__coworker_schema__ = schema
    call.__aisuite_tool_metadata__ = ai.ToolMetadata(
        category="trading", risk_level="low"
    )
    return call


def trading_tools() -> list:
    """Adapter: vendored Vibe-Trading data tools as coworker-registerable callables."""
    global _cache
    if _cache is None:
        _cache = _build()
    return list(_cache)
