"""Cool-Admin sign-in module: state handoff, session storage, and the sealed
credential unseal — the unseal test re-implements the SERVER side of the seal
(cool-admin-midway ai/service/userMember.ts encryptApiKeyForX25519) so a
divergence between the two implementations fails loudly here."""

from __future__ import annotations

import base64
import os

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from coworker import coolauth
from coworker.config import Config
from coworker.secrets import SecretStore

_HKDF_INFO = b"vibe-trading/member-credential/v1"


def _cfg(**kw) -> Config:
    return Config(cool_admin_base_url="https://admin.example.com", **kw)


def _seal(client_public_b64: str, api_key: str) -> dict:
    """The server's algorithm, verbatim from userMember.ts:94-167. AESGCM.encrypt
    returns ciphertext||tag; the wire format splits them."""
    client_key = serialization.load_der_public_key(base64.b64decode(client_public_b64))
    server = X25519PrivateKey.generate()
    shared = server.exchange(client_key)
    salt = os.urandom(32)
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=_HKDF_INFO).derive(
        shared
    )
    iv = os.urandom(12)
    der = server.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    ct = AESGCM(key).encrypt(iv, api_key.encode(), None)
    return {
        "version": 2,
        "ephemeralPublicKey": base64.b64encode(der).decode(),
        "salt": base64.b64encode(salt).decode(),
        "iv": base64.b64encode(iv).decode(),
        "ciphertext": base64.b64encode(ct[:-16]).decode(),
        "tag": base64.b64encode(ct[-16:]).decode(),
    }


def _session(secrets: SecretStore) -> None:
    coolauth.store_session(
        secrets,
        token="jwt-a",
        refresh_token="r1",
        expire=3600,
        refresh_expire=86400,
        account="13800000000",
    )


def _credentials_response(url: str, json: dict, models=None) -> httpx.Response:
    """Stand-in for POST /app/ai/member/credentials: seals the fake key to the
    clientPublicKey the client submitted (exactly what the server does)."""
    seal = _seal(json["clientPublicKey"], "sk-member-key")
    granted = models if models is not None else ["deepseek-chat", "glm-5.2"]
    return httpx.Response(
        200,
        json={
            "code": 1000,
            "message": "success",
            "data": {
                "version": 2,
                "baseURL": "https://upstream.example.com/v1",
                "models": granted,
                "apiKeySeal": seal,
            },
        },
        request=httpx.Request("POST", url),
    )


def _cool_config_dir(tmp_path) -> None:
    """The /v1/cloud/* routes read cool_admin_base_url from the state-dir
    config.toml — write it so they actually take the coolauth branches."""
    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    (state / "config.toml").write_text(
        'cool_admin_base_url = "https://admin.example.com"\n'
    )


def test_unseal_matches_server_seal():
    client = X25519PrivateKey.generate()
    seal = _seal(coolauth._public_key_b64(client), "sk-test-密钥-key-123")
    assert coolauth.unseal_api_key(client, seal) == "sk-test-密钥-key-123"


def test_unseal_rejects_tampered_ciphertext():
    client = X25519PrivateKey.generate()
    seal = _seal(coolauth._public_key_b64(client), "sk-live")
    raw = bytearray(base64.b64decode(seal["ciphertext"]))
    raw[0] ^= 0xFF
    seal["ciphertext"] = base64.b64encode(bytes(raw)).decode()
    with pytest.raises(Exception):
        coolauth.unseal_api_key(client, seal)


def test_begin_login_state_handoff(monkeypatch):
    monkeypatch.setenv("COWORKER_PORT", "8765")
    out = coolauth.begin_login(_cfg())
    assert (
        out["authorize_url"]
        == f"https://admin.example.com/auth?port=8765&state={out['state']}"
    )
    assert coolauth.consume_state(out["state"])
    assert not coolauth.consume_state(out["state"])  # one-shot
    assert not coolauth.consume_state("never-issued")


def test_begin_login_requires_port(monkeypatch):
    monkeypatch.delenv("COWORKER_PORT", raising=False)
    with pytest.raises(RuntimeError):
        coolauth.begin_login(_cfg())


def test_session_roundtrip(tmp_path):
    secrets = SecretStore(tmp_path / "secrets.json")
    assert coolauth.status(secrets) == {
        "signed_in": False,
        "account": "",
        "user_id": "",
    }
    _session(secrets)
    st = coolauth.status(secrets)
    assert st["signed_in"] and st["account"] == "13800000000"
    assert coolauth.fresh_access_token(secrets, _cfg()) == "jwt-a"
    assert coolauth.logout(secrets) == {"ok": True, "signed_in": False}
    assert coolauth.fresh_access_token(secrets, _cfg()) is None


def test_fetch_credentials_not_signed_in(tmp_path):
    secrets = SecretStore(tmp_path / "secrets.json")
    out = coolauth.fetch_credentials(secrets, _cfg())
    assert out == {"ok": False, "error": "not signed in"}


def test_fetch_credentials_happy_path(tmp_path, monkeypatch):
    secrets = SecretStore(tmp_path / "secrets.json")
    _session(secrets)
    calls: list[str] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        assert headers["Authorization"] == "Bearer jwt-a"
        return _credentials_response(url, json)

    monkeypatch.setattr(coolauth.httpx, "post", fake_post)
    out = coolauth.fetch_credentials(secrets, _cfg())
    assert out["ok"] is True, out
    assert out["api_key"] == "sk-member-key"
    assert out["base_url"] == "https://upstream.example.com/v1"
    assert out["models"] == ["deepseek-chat", "glm-5.2"]
    assert calls == ["https://admin.example.com/app/ai/member/credentials"]


def test_api_url_split_from_frontend_base(tmp_path, monkeypatch):
    """Dev shape: authorize page on the web app, member API on the server.
    The browser handoff must use the frontend base; refresh + credentials
    must hit the API base."""
    monkeypatch.setenv("COWORKER_PORT", "8765")
    cfg = _cfg(cool_admin_api_url="http://127.0.0.1:8001")
    assert coolauth.begin_login(cfg)["authorize_url"].startswith(
        "https://admin.example.com/auth?"
    )
    calls: list[str] = []
    monkeypatch.setattr(
        coolauth.httpx,
        "post",
        lambda url, **kw: (calls.append(url), _credentials_response(url, kw["json"]))[
            1
        ],
    )
    secrets = SecretStore(tmp_path / "secrets.json")
    _session(secrets)
    assert coolauth.fetch_credentials(secrets, cfg)["ok"] is True
    assert calls == ["http://127.0.0.1:8001/app/ai/member/credentials"]


def test_fetch_credentials_server_error(tmp_path, monkeypatch):
    secrets = SecretStore(tmp_path / "secrets.json")
    _session(secrets)

    def fake_post(url, **kw):
        return httpx.Response(
            200,
            json={"code": 1001, "message": "会员已过期"},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(coolauth.httpx, "post", fake_post)
    assert coolauth.fetch_credentials(secrets, _cfg()) == {
        "ok": False,
        "error": "会员已过期",
    }


def test_cool_callback_route_signs_in(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from coworker.server import SessionManager, create_app

    _cool_config_dir(tmp_path)
    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("COWORKER_PORT", "8765")
    monkeypatch.setattr(
        coolauth.httpx, "post", lambda url, **kw: _credentials_response(url, kw["json"])
    )
    manager = SessionManager(workspace=tmp_path)
    with TestClient(create_app(manager)) as client:
        assert client.get("/v1/cloud/status").json()["signed_in"] is False

        state = coolauth.begin_login(_cfg())["state"]
        resp = client.post(
            "/auth/cool/callback",
            data={
                "state": state,
                "token": "jwt-cb",
                "refreshToken": "r-cb",
                "expire": "86400",
                "refreshExpire": "2592000",
                "account": "13800000000",
            },
        )
        assert resp.status_code == 200
        assert "登录成功" in resp.text

        body = client.get("/v1/cloud/status").json()
        assert body["signed_in"] is True and body["account"] == "13800000000"
        assert (
            manager.secrets.get(coolauth.COOL_AUTH_PROFILE)["access_token"] == "jwt-cb"
        )


def test_cool_callback_rejects_bad_state(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from coworker.server import SessionManager, create_app

    _cool_config_dir(tmp_path)
    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "state"))
    manager = SessionManager(workspace=tmp_path)
    with TestClient(create_app(manager)) as client:
        resp = client.post(
            "/auth/cool/callback", data={"state": "forged", "token": "t"}
        )
        assert resp.status_code == 400
        assert client.get("/v1/cloud/status").json()["signed_in"] is False


def test_sync_credentials_injects_provider_and_models(tmp_path, monkeypatch):
    from coworker.server import SessionManager

    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        coolauth.httpx, "post", lambda url, **kw: _credentials_response(url, kw["json"])
    )
    manager = SessionManager(workspace=tmp_path)
    _session(manager.secrets)
    out = coolauth.sync_credentials(manager, manager.secrets, _cfg())
    assert out == {"ok": True, "provider": "trading-server", "models": 2}

    providers = {p["name"]: p for p in manager.get_providers()}
    assert providers["trading-server"]["configured"] is True
    assert providers["trading-server"]["custom"] is False  # built-in descriptor
    settings = manager.get_settings()
    assert "trading-server:deepseek-chat" in settings["models"]
    assert "trading-server:glm-5.2" in settings["models"]
    # The api_key landed in the provider profile (value itself stays out of APIs).
    assert manager.secrets.get("provider:trading-server")["api_key"] == "sk-member-key"


def test_sync_credentials_prunes_revoked_models(tmp_path, monkeypatch):
    """The server's model list is authoritative: models it no longer grants
    must leave the picker, not linger forever (add_model alone never shrinks)."""
    from coworker.server import SessionManager

    state = {"models": ["deepseek-chat", "glm-5.2"]}  # first sync grants two

    def fake_post(url, **kw):
        return _credentials_response(url, kw["json"], models=state["models"])

    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(coolauth.httpx, "post", fake_post)
    manager = SessionManager(workspace=tmp_path)
    _session(manager.secrets)
    coolauth.sync_credentials(manager, manager.secrets, _cfg())

    state["models"] = ["glm-5.2"]  # membership changed: deepseek revoked
    out = coolauth.sync_credentials(manager, manager.secrets, _cfg())
    assert out == {"ok": True, "provider": "trading-server", "models": 1}
    picker = [
        m for m in manager.get_settings()["models"] if m.startswith("trading-server:")
    ]
    assert picker == ["trading-server:glm-5.2"]


def test_trading_server_build_rejects_half_configured_profile():
    from coworker.providers.registry import get_descriptor

    d = get_descriptor("trading-server")
    assert d is not None and d.title == "Trading Server"
    # No endpoint → never fall back to api.openai.com with a member key.
    with pytest.raises(RuntimeError, match="member sign-in"):
        d.build({"api_key": "sk-x"}, None)
    with pytest.raises(RuntimeError, match="member sign-in"):
        d.build({"base_url": "https://gw"}, None)
    client = d.build({"api_key": "sk-x", "base_url": "https://gw/v1"}, None)
    assert client is not None


def test_startup_resyncs_when_signed_in_but_unprovisioned(tmp_path, monkeypatch):
    """The incident guard: sign-in landed but the credential sync failed once
    (e.g. backend briefly down) — the next sidecar start must re-pull and light
    up the provider instead of staying dark until a fresh browser login."""
    import time

    from fastapi.testclient import TestClient

    from coworker.server import SessionManager, create_app

    _cool_config_dir(tmp_path)
    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        coolauth.httpx, "post", lambda url, **kw: _credentials_response(url, kw["json"])
    )
    manager = SessionManager(workspace=tmp_path)
    _session(manager.secrets)  # signed in, provider NOT provisioned yet

    with TestClient(create_app(manager)) as client:
        client.get("/v1/health")  # let the lifespan's background task run
        deadline = time.time() + 5
        configured = False
        while time.time() < deadline:
            configured = any(
                p["name"] == "trading-server" and p["configured"]
                for p in manager.get_providers()
            )
            if configured:
                break
            time.sleep(0.05)
        assert configured, "startup resync did not provision trading-server"
        assert (
            manager.secrets.get("provider:trading-server")["api_key"] == "sk-member-key"
        )


def test_cloud_sync_route_repulls_models(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from coworker.server import SessionManager, create_app

    _cool_config_dir(tmp_path)
    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        coolauth.httpx, "post", lambda url, **kw: _credentials_response(url, kw["json"])
    )
    manager = SessionManager(workspace=tmp_path)
    _session(manager.secrets)
    with TestClient(create_app(manager)) as client:
        body = client.post("/v1/cloud/sync").json()
        assert body == {"ok": True, "provider": "trading-server", "models": 2}
        providers = {p["name"]: p for p in manager.get_providers()}
        assert providers["trading-server"]["configured"] is True


def test_cloud_sync_route_without_config(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from coworker.server import SessionManager, create_app

    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "state"))  # no config.toml
    manager = SessionManager(workspace=tmp_path)
    with TestClient(create_app(manager)) as client:
        assert client.post("/v1/cloud/sync").json() == {
            "ok": False,
            "error": "not configured",
        }
