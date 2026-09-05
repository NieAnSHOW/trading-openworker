"""Cool-Admin account sign-in: the desktop client's browser-authorization flow.

Flow (config.cool_admin_base_url set ⇒ /v1/cloud/* routes switch to this module):
  1. POST /v1/cloud/login opens {base}/auth?port=&state= in the system browser —
     a standalone authorize page served by the Trading-admin frontend.
  2. That page logs the user in with the SAME endpoints the mobile app uses
     (/app/user/login/password|phone) and form-POSTs the JWT pair back to the
     sidecar's loopback POST /auth/cool/callback (form-POST, not a redirect —
     the token never lands in browser history).
  3. The sidecar stores the session in the SecretStore, then pulls the member's
     provider credentials: POST /app/ai/member/credentials with a fresh X25519
     public key. The server Vault-decrypts the api_key and seals it to our key
     (ECDH + HKDF-SHA256 + AES-256-GCM — mirror of ai/service/userMember.ts
     encryptApiKeyForX25519), so the plaintext key never crosses the wire.
  4. Credentials land as a custom provider ("cool", OpenAI-compatible) via
     manager.add_custom_provider + set_provider; each model id becomes
     `cool:<model>` in the picker.

The pending-state table is in-process only (same contract as cloud.py): a login
that outlives the sidecar simply has to be restarted.
"""

from __future__ import annotations

import base64
import os
import secrets
import time
from typing import Any, Optional

import httpx

from .config import Config
from .secrets import SecretStore

COOL_AUTH_PROFILE = "cool:auth"
PROVIDER_NAME = "cool"
PROVIDER_TITLE = "Cool 会员网关"

# One-shot anti-drive-by nonce: only the authorize page that was handed `state`
# can complete the callback (mirrors cloud.py's _pending_logins contract).
_PENDING_TTL = 600
_pending_logins: dict[str, float] = {}

# Server-side seal parameters (ai/service/userMember.ts:123-131) — do not change
# independently: the TS side derives and encrypts with exactly these.
_HKDF_INFO = b"vibe-trading/member-credential/v1"
_HKDF_LEN = 32

_CREDENTIALS_PATH = "/app/ai/member/credentials"
_REFRESH_PATH = "/app/user/login/refreshToken"


def _now() -> float:
    return time.time()


def enabled(config: Config) -> bool:
    """Cool-Admin mode is opt-in via config; empty ⇒ stock OpenWorker cloud."""
    return bool((config.cool_admin_base_url or "").strip())


def _base(config: Config) -> str:
    return (config.cool_admin_base_url or "").strip().rstrip("/")


# --- browser sign-in ---------------------------------------------------------


def begin_login(config: Config) -> dict[str, Any]:
    """Authorize-page URL for the sidecar to open in the system browser. The port
    is the sidecar's own listener (COWORKER_PORT, set by server/run.py)."""
    port = os.environ.get("COWORKER_PORT", "").strip()
    if not port.isdigit():
        raise RuntimeError(
            "COWORKER_PORT is not set — the authorize URL needs the sidecar port"
        )
    state = secrets.token_hex(16)
    _pending_logins[state] = _now()
    url = f"{_base(config)}/auth?port={port}&state={state}"
    return {"authorize_url": url, "state": state}


def consume_state(state: str) -> bool:
    """One-shot: a valid, unexpired state is consumed; everything else fails."""
    created = _pending_logins.pop(state or "", 0)
    return bool(created) and created >= _now() - _PENDING_TTL


# --- local session -----------------------------------------------------------


def store_session(
    secrets: SecretStore,
    *,
    token: str,
    refresh_token: str,
    expire: int,
    refresh_expire: int,
    account: str,
) -> None:
    """Persist the JWT pair (expiries are seconds-from-now, per the login API's
    token() response). 60s leeway mirrors cloud.py's _store_cloud_tokens."""
    now = _now()
    secrets.put(
        COOL_AUTH_PROFILE,
        {
            "type": "cool",
            "access_token": token,
            "refresh_token": refresh_token,
            "expires": now + int(expire or 0) - 60,
            "refresh_expires": now + int(refresh_expire or 0) - 60,
            "account": account,
        },
    )


def status(secrets: SecretStore) -> dict[str, Any]:
    profile = secrets.get(COOL_AUTH_PROFILE) or {}
    return {
        "signed_in": bool(profile.get("access_token")),
        "account": profile.get("account") or "",
        "user_id": "",
    }


def logout(secrets: SecretStore) -> dict[str, Any]:
    """Forget the session. Injected provider credentials stay (they may be the
    user's only key material); "Remove key" in Settings owns that lifecycle."""
    secrets.delete(COOL_AUTH_PROFILE)
    return {"ok": True, "signed_in": False}


def fresh_access_token(secrets: SecretStore, config: Config) -> Optional[str]:
    """Valid session token, silently refreshed near expiry via /refreshToken;
    None when signed out or the refresh fails (GUI shows "sign in again")."""
    profile = secrets.get(COOL_AUTH_PROFILE) or {}
    token = profile.get("access_token")
    if not token:
        return None
    if float(profile.get("expires") or 0) > _now() + 120:
        return str(token)
    refresh_token = str(profile.get("refresh_token") or "")
    if not refresh_token or float(profile.get("refresh_expires") or 0) < _now():
        return None
    try:
        resp = httpx.post(
            _base(config) + _REFRESH_PATH,
            json={"refreshToken": refresh_token},
            timeout=15,
        )
        data = resp.json() if resp.status_code == 200 else {}
        payload = data.get("data") or {}
        new_token = str(payload.get("token") or "")
        if data.get("code") != 1000 or not new_token:
            return None
        store_session(
            secrets,
            token=new_token,
            refresh_token=str(payload.get("refreshToken") or refresh_token),
            expire=int(payload.get("expire") or 86400),
            refresh_expire=int(payload.get("refreshExpire") or 0),
            account=str(profile.get("account") or ""),
        )
        return new_token
    except Exception:
        return None


# --- credential unsealing (mirror of userMember.ts encryptApiKeyForX25519) ---


def _public_key_b64(private_key: Any) -> str:
    from cryptography.hazmat.primitives import serialization

    der = private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return base64.b64encode(der).decode()


def unseal_api_key(private_key: Any, seal: dict[str, Any]) -> str:
    """Open the server's apiKeySeal: ECDH(our private, server ephemeral) →
    HKDF-SHA256(salt, info=_HKDF_INFO) → AES-256-GCM(iv, ciphertext||tag)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    b64 = lambda k: base64.b64decode(str(seal.get(k) or ""))  # noqa: E731
    eph_pub = serialization.load_der_public_key(b64("ephemeralPublicKey"))
    shared = bytearray(private_key.exchange(eph_pub))
    key = bytearray(
        HKDF(
            algorithm=hashes.SHA256(),
            length=_HKDF_LEN,
            salt=b64("salt"),
            info=_HKDF_INFO,
        ).derive(bytes(shared))
    )
    try:
        plain = AESGCM(bytes(key)).decrypt(
            b64("iv"), b64("ciphertext") + b64("tag"), None
        )
        return plain.decode("utf-8")
    finally:
        shared[:] = b"\x00" * len(shared)
        key[:] = b"\x00" * len(key)


def fetch_credentials(secrets: SecretStore, config: Config) -> dict[str, Any]:
    """Pull {api_key, base_url, models} for the signed-in member. The api_key is
    unsealed in memory and returned once — the caller persists it in the
    SecretStore immediately; it must not be logged or echoed."""
    token = fresh_access_token(secrets, config)
    if not token:
        return {"ok": False, "error": "not signed in"}
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    private_key = X25519PrivateKey.generate()
    try:
        resp = httpx.post(
            _base(config) + _CREDENTIALS_PATH,
            json={"clientPublicKey": _public_key_b64(private_key)},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        try:
            data = resp.json()
        except ValueError:
            return {"ok": False, "error": f"HTTP {resp.status_code}"}
        if data.get("code") != 1000:
            return {
                "ok": False,
                "error": str(data.get("message") or f"HTTP {resp.status_code}"),
            }
        cred = data.get("data") or {}
        base_url = str(cred.get("baseURL") or "").strip()
        if not base_url:
            return {"ok": False, "error": "服务器未返回 baseURL"}
        return {
            "ok": True,
            "api_key": unseal_api_key(private_key, cred.get("apiKeySeal") or {}),
            "base_url": base_url,
            "models": [
                str(m).strip() for m in cred.get("models") or [] if str(m).strip()
            ],
        }
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def sync_credentials(
    manager: Any, secrets: SecretStore, config: Config
) -> dict[str, Any]:
    """Landing-step: fetch credentials and inject them as the `cool` custom
    provider + `cool:<model>` picker entries. Idempotent — re-login overwrites."""
    out = fetch_credentials(secrets, config)
    if not out.get("ok"):
        return out
    fields = {"api_key": str(out["api_key"]), "base_url": str(out["base_url"])}
    from .providers.registry import is_custom_provider

    if is_custom_provider(PROVIDER_NAME):
        # register_custom_provider raises on an existing id — a re-login (or the
        # GUI's own re-add) only refreshes the stored fields.
        manager.set_provider(PROVIDER_NAME, fields)
    else:
        manager.add_custom_provider(
            PROVIDER_NAME, PROVIDER_TITLE, "openai", str(out["base_url"])
        )
        manager.set_provider(PROVIDER_NAME, {"api_key": str(out["api_key"])})
    for model in out["models"]:
        manager.add_model(f"{PROVIDER_NAME}:{model}")
    return {"ok": True, "provider": PROVIDER_NAME, "models": len(out["models"])}
