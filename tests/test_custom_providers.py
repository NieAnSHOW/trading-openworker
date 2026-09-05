"""Custom (user-defined) providers — Settings ▸ Models ▸ Add provider: registry
registration and routing, credential probes, manager CRUD + prefs round-trip, and
per-model context-window overrides feeding compaction + the fill meter. No network."""

from __future__ import annotations

import pytest

from coworker.providers import (
    AnthropicProvider,
    AssistantTurn,
    ModelCapabilities,
    OpenAIProvider,
    ProviderClient,
    ProviderRouter,
)
from coworker.providers import registry
from coworker.providers.registry import get_descriptor


class FakeResponse:
    def __init__(self, status_code: int = 200):
        self.status_code = status_code


@pytest.fixture(autouse=True)
def _clean_custom_registry():
    yield
    registry._CUSTOM.clear()


# -- registry -------------------------------------------------------------------
def test_register_custom_provider_openai_descriptor_and_routing():
    registry.register_custom_provider("mygw", "My Gateway", "openai")
    d = get_descriptor("mygw")
    assert d is not None and d.title == "My Gateway" and d.protocol == "openai"
    assert d.needs_key and [f.key for f in d.fields] == ["base_url", "api_key"]
    assert d in registry.provider_descriptors()
    assert registry.is_custom_provider("mygw")
    client = registry.build_provider_client(
        "mygw", {"api_key": "k", "base_url": "https://gw/v1"}, None
    )
    assert isinstance(client, OpenAIProvider)
    router = ProviderRouter(None)
    assert router._provider_name("mygw:m1") == "mygw"
    assert router._bare("mygw:m1") == "m1"


def test_register_custom_provider_anthropic_builds_anthropic_client():
    registry.register_custom_provider("agw", "A GW", "anthropic")
    client = registry.build_provider_client(
        "agw", {"api_key": "k", "base_url": "https://a"}, None
    )
    assert isinstance(client, AnthropicProvider)
    assert client._base_url == "https://a"


def test_register_custom_provider_validation_and_builtin_guard():
    for bad in ("Bad", "1x", "", "x" * 40, "a b"):
        with pytest.raises(ValueError):
            registry.register_custom_provider(bad, "t", "openai")
    with pytest.raises(ValueError):
        registry.register_custom_provider("okname", "t", "grpc")
    with pytest.raises(ValueError):
        registry.register_custom_provider("openai", "t", "openai")


def test_custom_provider_missing_key_fails_at_call_time():
    registry.register_custom_provider("kgw", "K", "openai")
    with pytest.raises(RuntimeError):
        registry.build_provider_client("kgw", {"base_url": "https://g"}, None)


# -- credential probes ------------------------------------------------------------
def test_verify_custom_provider_openai_probe(monkeypatch):
    registry.register_custom_provider("vgw", "V", "openai")
    calls: dict = {}

    def fake_get(url, **kw):
        calls["url"] = url
        calls["headers"] = kw.get("headers")
        return FakeResponse(200)

    monkeypatch.setattr("httpx.get", fake_get)
    assert registry.verify_provider_key(
        "vgw", api_key="k", base_url="https://gw/v1/"
    ) == {"ok": True}
    assert calls["url"] == "https://gw/v1/models"
    assert calls["headers"]["Authorization"] == "Bearer k"
    # no base URL → explicit error, nothing further probed
    res = registry.verify_provider_key("vgw", api_key="k", base_url="  ")
    assert res["ok"] is False and "Base URL" in res["error"]
    assert calls["url"] == "https://gw/v1/models"


def test_verify_custom_provider_anthropic_probe(monkeypatch):
    registry.register_custom_provider("agw", "A", "anthropic")
    calls: dict = {}

    def fake_get(url, **kw):
        calls["url"] = url
        calls["headers"] = kw.get("headers")
        return FakeResponse(401)

    monkeypatch.setattr("httpx.get", fake_get)
    res = registry.verify_provider_key("agw", api_key="k", base_url="https://a")
    assert res == {"ok": False, "error": "Invalid API key."}
    assert calls["url"] == "https://a/v1/models"
    assert calls["headers"]["x-api-key"] == "k"


# -- manager CRUD + prefs round-trip -----------------------------------------------
class _Stub(ProviderClient):
    def complete(self, *, model, messages, tools=None, **settings):
        return AssistantTurn(text="hi")

    def capabilities(self, model):
        return ModelCapabilities()


def test_manager_custom_provider_round_trip(tmp_path):
    from coworker.server.manager import SessionManager

    mgr = SessionManager(workspace=tmp_path, provider=_Stub())
    assert mgr.add_custom_provider("mygw", "My GW", "openai", "https://gw/v1")["ok"]

    # registered + listed with the custom flag; base_url prefilled; not configured yet
    row = next(p for p in mgr.get_providers() if p["name"] == "mygw")
    assert row["custom"] is True and row["protocol"] == "openai"
    assert row["values"]["base_url"] == "https://gw/v1"
    assert row["configured"] is False

    # key set through the normal provider path → configured
    assert mgr.set_provider("mygw", {"api_key": "sk-x"})["ok"]
    row = next(p for p in mgr.get_providers() if p["name"] == "mygw")
    assert row["configured"] is True

    # a fresh manager re-registers from prefs and can build the routed client
    mgr2 = SessionManager(workspace=tmp_path, provider=_Stub())
    assert get_descriptor("mygw") is not None
    client = registry.build_provider_client(
        "mygw", mgr2.secrets.get("provider:mygw") or {}, mgr2.secrets
    )
    assert isinstance(client, OpenAIProvider)

    # validation: duplicates, built-in ids, bad protocol, bad URL
    assert mgr.add_custom_provider("mygw", "x", "openai", "https://x")["ok"] is False
    assert mgr.add_custom_provider("openai", "x", "openai", "https://x")["ok"] is False
    assert mgr.add_custom_provider("ok2", "x", "grpc", "https://x")["ok"] is False
    assert mgr.add_custom_provider("ok3", "x", "openai", "ftp://x")["ok"] is False

    # remove → descriptor, stored profile, and prefs entry all go
    assert mgr.remove_custom_provider("mygw")["ok"]
    assert get_descriptor("mygw") is None
    assert not (mgr.secrets.get("provider:mygw") or {})
    assert not any(
        c.get("name") == "mygw" for c in mgr._prefs.get("custom_providers") or []
    )
    assert mgr.remove_custom_provider("openai")["ok"] is False


def test_manager_context_window_overrides(tmp_path):
    from coworker.server.manager import SessionManager

    mgr = SessionManager(workspace=tmp_path, provider=_Stub())
    assert mgr.set_context_window_override("", 100)["ok"] is False
    assert mgr.set_context_window_override("mygw:m1", "lots")["ok"] is False
    assert mgr.set_context_window_override("mygw:m1", 500)["ok"] is False  # below floor
    assert mgr.set_context_window_override("mygw:m1", 200_000)["ok"]
    assert mgr.context_window_overrides() == {"mygw:m1": 200_000}
    # overrides ride compaction settings (engines read live) and the settings payload
    assert mgr.compaction_settings()["context_window_overrides"] == {"mygw:m1": 200_000}
    s = mgr.get_settings()
    assert s["context_window_overrides"] == {"mygw:m1": 200_000}
    assert s["model_context_windows"]["mygw:m1"] == 200_000
    # 0 / None clears
    assert mgr.set_context_window_override("mygw:m1", 0)["ok"]
    assert mgr.context_window_overrides() == {}
    assert "mygw:m1" not in mgr.get_settings()["model_context_windows"]


def test_manager_model_label_overrides(tmp_path):
    from coworker.server.manager import SessionManager

    mgr = SessionManager(workspace=tmp_path, provider=_Stub())
    assert mgr.set_model_label("", "x")["ok"] is False
    assert mgr.set_model_label("deepseek:deepseek-v4-flash", "我的快模型")["ok"]
    assert mgr.model_label_overrides() == {"deepseek:deepseek-v4-flash": "我的快模型"}
    s = mgr.get_settings()
    # merged over the matrix label + exposed separately for the inline editor
    assert s["model_labels"]["deepseek:deepseek-v4-flash"] == "我的快模型"
    assert s["model_label_overrides"] == {"deepseek:deepseek-v4-flash": "我的快模型"}
    # empty label clears back to the matrix name
    assert mgr.set_model_label("deepseek:deepseek-v4-flash", "")["ok"]
    assert mgr.model_label_overrides() == {}
    assert (
        mgr.get_settings()["model_labels"]["deepseek:deepseek-v4-flash"] != "我的快模型"
    )


def test_engine_compaction_uses_context_override(tmp_path):
    from coworker.engine import TurnEngine
    from coworker.permissions import PermissionEngine
    from coworker.tools import ToolRegistry

    engine = TurnEngine(
        provider=_Stub(),
        registry=ToolRegistry(),
        permissions=PermissionEngine(workspace_root=tmp_path),
        model="mygw:m1",
    )
    engine.compaction_settings = lambda: {
        "cap_tokens": 400,
        "threshold_pct": 0.8,
        "context_window_overrides": {"mygw:m1": 77_000},
    }
    # the override wins over the matrix/default for its model, and only for it
    assert engine._compaction_config()["context_window"] == 77_000
    engine.model = "gpt-5.5"
    assert engine._compaction_config()["context_window"] == 400_000
