"""Vendored Vibe-Trading data tools: registration, risk classification, engine wiring."""

from __future__ import annotations

import json

from coworker.agent import build_engine
from coworker.agents.chat import chat_agent
from coworker.providers import ModelCapabilities, ProviderClient
from coworker.risk import RiskClass, classify
from coworker.tools.registry import ToolRegistry
from coworker.tools.trading import _wrap, trading_tools
from coworker.tools.trading._compat import BaseTool

# a_stock_data needs pandas; iwencai needs its API key — both may be absent.
_EXPECTED_FLOOR = 10  # the stdlib-only tools every environment has


class _StubProvider(ProviderClient):
    def complete(self, **kwargs):  # pragma: no cover
        raise NotImplementedError

    def capabilities(self, model):
        return ModelCapabilities()


def test_trading_tools_register_with_valid_schemas():
    reg = ToolRegistry()
    reg.register_all(trading_tools())
    names = reg.names()
    assert len(names) >= _EXPECTED_FLOOR
    assert not {"read_file", "write_file", "run_shell", "load_skill"} & set(names)
    for name in names:
        fn = reg.get(name).schema["function"]
        assert fn["name"] == name and fn["description"]
        assert fn["parameters"].get("type") == "object"


def test_trading_tools_are_read_risk():
    reg = ToolRegistry()
    reg.register_all(trading_tools())
    for name in reg.names():
        assert classify(name, reg.get(name).metadata) is RiskClass.READ


def test_wrap_executes_through_registry():
    class Stub(BaseTool):
        name = "stub_quote"
        description = "d"
        parameters = {
            "type": "object",
            "properties": {"s": {"type": "string"}},
            "required": ["s"],
        }

        def execute(self, **kwargs):
            return json.dumps({"ok": True, **kwargs})

    reg = ToolRegistry()
    reg.register_all([_wrap(Stub())])
    assert json.loads(reg.execute("stub_quote", {"s": "AAPL"})) == {
        "ok": True,
        "s": "AAPL",
    }


def test_engine_build_includes_trading_tools(tmp_path):
    engine = build_engine(agent=chat_agent(), provider=_StubProvider())
    assert "get_market_data" in engine.registry.names()
