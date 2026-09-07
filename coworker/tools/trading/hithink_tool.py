"""同花顺金融数据 (hithink-finance) REST access — the executable arm of the builtin skill.

The builtin `hithink-finance` skill is the router/UX layer: its `references/api/` docs
define the endpoint contract (path, params, fields) and the agent picks `path` from
there. This tool is the zero-install data path: one generic authenticated GET against
https://fuyao.aicubes.cn (contract in the skill's `references/api.md`: envelope
``{code, message, request_id, data}``, success = ``code == 0``, auth header
``X-api-key``). Key-gated like iwencai: without ``HITHINK_FINANCE_API_KEY``
(Settings → 同花顺金融数据) the tool drops from the registry entirely, and the key is
re-read at every call so saving it in Settings reaches live sessions without a restart.
"""

from __future__ import annotations

import json
import os
from typing import Any

from coworker.tools.trading._compat import BaseTool
from coworker.tools.trading._loaders._http import resolve_min_interval, throttled_get

_KEY_ENV = "HITHINK_FINANCE_API_KEY"
_BASE_URL = "https://fuyao.aicubes.cn"
# Endpoint paths come from the skill's references; the strict prefix keeps this a
# hithink client, not a generic credentialed arbitrary-URL fetcher.
_PATH_PREFIX = "/api/"
# Politeness cap for a paid API; matches the sibling loaders' env-override pattern.
_MIN_INTERVAL = resolve_min_interval("VIBE_TRADING_HITHINK_MIN_INTERVAL", 0.2)
# Context guard: the contract routes bulk pulls to files/market dumps; a passthrough
# response that huge would blow the model context, so cap what we hand upstream.
_MAX_CHARS = 60_000


class HithinkRequestTool(BaseTool):
    name = "hithink_request"
    description = (
        "Query the official 同花顺金融数据 (hithink-finance) A-share API: real-time "
        "quotes, K-lines, corporate actions, financials, valuations, indexes and "
        "boards, auction snapshots, limit-up pools, hot lists, dragon-tiger, funds. "
        "`path` is an endpoint path from the hithink-finance skill's references/api "
        "(e.g. /api/meta/tickers/search); `params` holds that endpoint's query "
        "parameters. Returns {ok, data | error, code?, request_id?}; ok=true means "
        "the business envelope code was 0."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": (
                    "Endpoint path starting with /api/, from the hithink-finance "
                    "skill's references/api docs"
                ),
            },
            "params": {
                "type": "object",
                "description": "Query parameters for the endpoint (strings/numbers/booleans)",
                "additionalProperties": True,
            },
        },
        "required": ["path"],
    }
    repeatable = True

    @classmethod
    def check_available(cls) -> bool:
        return bool(os.getenv(_KEY_ENV, "").strip())

    def execute(self, path: str, params: dict[str, Any] | None = None) -> str:
        def _out(payload: dict[str, Any]) -> str:
            return json.dumps(payload, ensure_ascii=False)

        key = os.getenv(_KEY_ENV, "").strip()
        if not key:
            return _out(
                {
                    "ok": False,
                    "error": (
                        "HITHINK_FINANCE_API_KEY not configured — set it in "
                        "Settings → 同花顺金融数据 (key issuance: "
                        "https://fuyao.aicubes.cn/admin/)"
                    ),
                }
            )
        path = (path or "").strip()
        if not path.startswith(_PATH_PREFIX):
            return _out(
                {
                    "ok": False,
                    "error": (
                        f"path must start with {_PATH_PREFIX} — pick an endpoint "
                        "path from the hithink-finance skill's references/api docs"
                    ),
                }
            )
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            resp = throttled_get(
                _BASE_URL + path,
                host_key="fuyao.aicubes.cn",
                min_interval=_MIN_INTERVAL,
                params=clean_params,
                headers={"X-api-key": key},
                timeout=30.0,
            )
        except Exception as exc:  # noqa: BLE001 — surfaced as an envelope, never raised
            return _out({"ok": False, "error": f"request failed: {exc}"})

        if resp.status_code != 200:
            return _out(
                {
                    "ok": False,
                    "error": f"HTTP {resp.status_code}",
                    "body": resp.text[:500],
                }
            )
        try:
            envelope = resp.json()
        except ValueError:
            return _out(
                {"ok": False, "error": "non-JSON response", "body": resp.text[:500]}
            )

        code = envelope.get("code")
        if code != 0:
            return _out(
                {
                    "ok": False,
                    "code": code,
                    "error": envelope.get("message") or "business error",
                    "request_id": envelope.get("request_id"),
                }
            )

        body = _out(
            {
                "ok": True,
                "data": envelope.get("data"),
                "request_id": envelope.get("request_id"),
            }
        )
        if len(body) <= _MAX_CHARS:
            return body
        return _out(
            {
                "ok": False,
                "error": (
                    "response too large for inline return — narrow the params "
                    "(fewer symbols, shorter window, paginated page) or pull the "
                    "data via the skill's market-dumps path"
                ),
                "bytes": len(body),
            }
        )
