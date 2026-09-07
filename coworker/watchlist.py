"""Shared A-share watchlist (自选股) store — the GUI 行情 page and the agent's
``watchlist_read`` tool both read this one file, so additions made in the UI are
immediately visible to the agent and vice versa.

Storage is a single JSON document in the state dir (``watchlist.json``, 0600)
guarded by an RLock: the list is small, writes are rare, and a file keeps the
store importable from both the server routes and tool execution without any
engine/session plumbing. Validates codes at the trust boundary (routes) — the
``^\d{6}$`` A-share shape — and never lets a malformed document widen into a
crash (a corrupt file is treated as an empty list; the next write replaces it).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from typing import Any

from .config import state_dir

_A_STOCK_RE = re.compile(r"^\d{6}$")
_FILENAME = "watchlist.json"
_lock = threading.RLock()


def _path() -> str:
    return os.path.join(state_dir(), _FILENAME)


def _empty() -> dict[str, Any]:
    return {"stocks": []}


def load_watchlist() -> dict[str, Any]:
    """Best-effort read: any parse/shape failure yields an empty store."""
    with _lock:
        try:
            with open(_path(), encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            return _empty()
        if not isinstance(doc, dict) or not isinstance(doc.get("stocks"), list):
            return _empty()
        return doc


def _save(doc: dict[str, Any]) -> None:
    # Atomic write, owner-only perms — mirrors the secrets-store discipline.
    directory = state_dir()
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".watchlist-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, _path())
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def list_stocks(market: str | None = None) -> list[dict[str, Any]]:
    doc = load_watchlist()
    stocks = doc["stocks"]
    if market is None:
        return stocks
    return [s for s in stocks if isinstance(s, dict) and s.get("market") == market]


def add_stock(code: str, market: str = "a_stock") -> dict[str, Any]:
    """Idempotent add. Returns ``{added, exists}`` like the upstream API."""
    code = (code or "").strip()
    if not _A_STOCK_RE.fullmatch(code):
        raise ValueError("stock code must be 6 digits")
    with _lock:
        doc = load_watchlist()
        stocks = doc["stocks"]
        for stock in stocks:
            if (
                isinstance(stock, dict)
                and stock.get("code") == code
                and stock.get("market") == market
            ):
                return {"added": False, "exists": True}
        stocks.append(
            {
                "code": code,
                "name": None,
                "market": market,
                "added_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            }
        )
        _save(doc)
        return {"added": True, "exists": False}


def remove_stock(code: str, market: str = "a_stock") -> dict[str, Any]:
    with _lock:
        doc = load_watchlist()
        before = len(doc["stocks"])
        doc["stocks"] = [
            s
            for s in doc["stocks"]
            if not (
                isinstance(s, dict)
                and s.get("code") == code
                and s.get("market") == market
            )
        ]
        deleted = len(doc["stocks"]) < before
        if deleted:
            _save(doc)
        return {"deleted": deleted}
