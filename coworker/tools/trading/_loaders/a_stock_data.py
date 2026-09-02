"""a-stock-data adapter for A-share market data and research endpoints.

Upstream project: https://github.com/simonlin1212/a-stock-data

The upstream package is distributed as a self-contained Skill document rather
than an importable Python library. This module ports the public, no-auth
endpoints Vibe Trading needs while keeping the existing loader contract intact.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.request
import uuid
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import pandas as pd
import requests

from coworker.tools.trading._loaders._http import resolve_min_interval, throttled_get
from coworker.tools.trading._loaders.base import cached_loader_fetch, validate_date_range
from coworker.tools.trading._loaders.registry import register

logger = logging.getLogger(__name__)

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
REPORT_API = "https://reportapi.eastmoney.com/report/list"
EASTMONEY_STOCK_INFO_API = "https://push2.eastmoney.com/api/qt/stock/get"
EASTMONEY_SEARCH_API = "https://search-api-web.eastmoney.com/search/jsonp"
EASTMONEY_FAST_NEWS_API = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList"
CNINFO_ORGID_API = "http://www.cninfo.com.cn/new/data/szse_stock.json"
CNINFO_ANNOUNCEMENT_API = "https://www.cninfo.com.cn/new/hisAnnouncement/query"


def _normalise_code(code: str) -> str:
    """Normalize common A-share forms to a pure six-digit ticker."""
    upper = code.strip().upper()
    if "." in upper:
        upper = upper.split(".")[0]
    if upper.startswith(("SH", "SZ", "BJ")):
        upper = upper[2:]
    if not (len(upper) == 6 and upper.isdigit()):
        raise ValueError(f"Unsupported A-share code: {code!r}")
    return upper


def _is_a_share(code: str) -> bool:
    try:
        _normalise_code(code)
        return True
    except ValueError:
        return False


def _tencent_symbol(code: str) -> str:
    symbol = _normalise_code(code)
    if symbol.startswith(("6", "9")):
        return f"sh{symbol}"
    if symbol.startswith(("8", "4")):
        return f"bj{symbol}"
    return f"sz{symbol}"


def _eastmoney_market_code(code: str) -> int:
    symbol = _normalise_code(code)
    return 1 if symbol.startswith(("6", "9")) else 0


def _strip_html(value: str) -> str:
    return re.sub(r"<[^>]+>", "", value or "").strip()


def _extract_jsonp(text: str) -> dict[str, Any]:
    start = text.index("(") + 1
    end = text.rindex(")")
    return json.loads(text[start:end])


def em_get(
    url: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 15,
) -> requests.Response:
    """Eastmoney GET via the shared per-host throttle and session pool.

    All Eastmoney traffic across the project routes through the same
    HostThrottle (host_key="eastmoney") so concurrent tool calls serialize
    instead of tripping Eastmoney's IP-level rate limiter.
    """
    merged = {"User-Agent": UA}
    if headers:
        merged.update(headers)
    return throttled_get(
        url,
        host_key="eastmoney",
        min_interval=resolve_min_interval("VIBE_TRADING_EASTMONEY_MIN_INTERVAL", 1.0),
        params=params,
        headers=merged,
        timeout=timeout,
    )


def tencent_quote(codes: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch Tencent real-time quote fields used by the basic-data layer."""
    prefixed = [_tencent_symbol(code) for code in codes]
    url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = resp.read().decode("gbk")

    result: dict[str, dict[str, Any]] = {}
    for line in data.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        code = key[2:]
        result[code] = {
            "name": vals[1],
            "price": _to_float(vals[3]),
            "last_close": _to_float(vals[4]),
            "open": _to_float(vals[5]),
            "change_amt": _to_float(vals[31]),
            "change_pct": _to_float(vals[32]),
            "high": _to_float(vals[33]),
            "low": _to_float(vals[34]),
            "amount_wan": _to_float(vals[37]),
            "turnover_pct": _to_float(vals[38]),
            "pe_ttm": _to_float(vals[39]),
            "amplitude_pct": _to_float(vals[43]),
            "mcap_yi": _to_float(vals[44]),
            "float_mcap_yi": _to_float(vals[45]),
            "pb": _to_float(vals[46]),
            "limit_up": _to_float(vals[47]),
            "limit_down": _to_float(vals[48]),
            "vol_ratio": _to_float(vals[49]),
            "pe_static": _to_float(vals[52]),
        }
    return result


def _to_float(value: Any) -> float | None:
    if value in (None, "", "-"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _cninfo_ts_to_date(ts: Any) -> str:
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
    return str(ts)[:10] if ts else ""


class AStockDataClient:
    """Client for a-stock-data's no-auth research, news, basic, and announcement APIs."""

    def __init__(
        self,
        *,
        em_get: Callable[..., Any] = em_get,
        http_get: Callable[..., Any] = requests.get,
        http_post: Callable[..., Any] = requests.post,
        quote_fetcher: Callable[[list[str]], dict[str, dict[str, Any]]] = tencent_quote,
    ) -> None:
        self._em_get = em_get
        self._http_get = http_get
        self._http_post = http_post
        self._quote_fetcher = quote_fetcher
        self._cninfo_orgid_map: dict[str, str] = {}

    def research_reports(self, code: str, max_pages: int = 5) -> list[dict[str, Any]]:
        """Fetch Eastmoney research reports for a stock."""
        symbol = _normalise_code(code)
        records: list[dict[str, Any]] = []
        for page in range(1, max_pages + 1):
            params = {
                "industryCode": "*",
                "pageSize": "100",
                "industry": "*",
                "rating": "*",
                "ratingChange": "*",
                "beginTime": "2000-01-01",
                "endTime": "2030-01-01",
                "pageNo": str(page),
                "fields": "",
                "qType": "0",
                "orgCode": "",
                "code": symbol,
                "rcode": "",
                "p": str(page),
                "pageNum": str(page),
                "pageNumber": str(page),
            }
            response = self._em_get(
                REPORT_API,
                params=params,
                headers={"Referer": "https://data.eastmoney.com/"},
                timeout=30,
            )
            payload = response.json()
            rows = payload.get("data") or []
            if not rows:
                break
            records.extend(self._normalise_report(row) for row in rows)
            if page >= (payload.get("TotalPage", 1) or 1):
                break
        return records

    def stock_news(self, code: str, page_size: int = 20) -> list[dict[str, Any]]:
        """Fetch Eastmoney stock news from the JSONP search endpoint."""
        symbol = _normalise_code(code)
        inner_params = json.dumps(
            {
                "uid": "",
                "keyword": symbol,
                "type": ["cmsArticleWebOld"],
                "client": "web",
                "clientType": "web",
                "clientVersion": "curr",
                "param": {
                    "cmsArticleWebOld": {
                        "searchScope": "default",
                        "sort": "default",
                        "pageIndex": 1,
                        "pageSize": page_size,
                        "preTag": "",
                        "postTag": "",
                    }
                },
            },
            separators=(",", ":"),
            ensure_ascii=False,
        )
        response = self._em_get(
            EASTMONEY_SEARCH_API,
            params={"cb": "jQuery_news", "param": inner_params},
            headers={"User-Agent": UA, "Referer": "https://so.eastmoney.com/"},
            timeout=15,
        )
        payload = _extract_jsonp(response.text)
        articles = payload.get("result", {}).get("cmsArticleWebOld", []) or []
        return [
            {
                "title": _strip_html(article.get("title", "")),
                "content": _strip_html(article.get("content", ""))[:200],
                "time": article.get("date", ""),
                "source": article.get("mediaName", ""),
                "url": article.get("url", ""),
                "provider": "eastmoney_search",
            }
            for article in articles
        ]

    def global_news(self, page_size: int = 50) -> list[dict[str, Any]]:
        """Fetch Eastmoney 7x24 global finance news."""
        response = self._em_get(
            EASTMONEY_FAST_NEWS_API,
            params={
                "client": "web",
                "biz": "web_724",
                "fastColumn": "102",
                "sortEnd": "",
                "pageSize": str(page_size),
                "req_trace": str(uuid.uuid4()),
            },
            headers={"User-Agent": UA, "Referer": "https://kuaixun.eastmoney.com/"},
            timeout=10,
        )
        payload = response.json()
        return [
            {
                "title": item.get("title", ""),
                "summary": (item.get("summary", "") or "")[:200],
                "time": item.get("showTime", ""),
                "source": "eastmoney_global_news",
            }
            for item in payload.get("data", {}).get("fastNewsList", []) or []
        ]

    def basic_data(self, code: str) -> dict[str, Any]:
        """Fetch basic stock fields from Tencent quote plus Eastmoney push2."""
        symbol = _normalise_code(code)
        quote = self._quote_fetcher([symbol]).get(symbol, {})
        try:
            response = self._em_get(
                EASTMONEY_STOCK_INFO_API,
                params={
                    "fltt": "2",
                    "invt": "2",
                    "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43",
                    "secid": f"{_eastmoney_market_code(symbol)}.{symbol}",
                },
                headers={"User-Agent": UA},
                timeout=10,
            )
            data = response.json().get("data", {}) or {}
        except Exception as exc:
            logger.warning("eastmoney basic data failed for %s; using Tencent quote only: %s", symbol, exc)
            data = {}
        return {
            "code": data.get("f57", symbol),
            "name": data.get("f58") or quote.get("name", ""),
            "industry": data.get("f127", ""),
            "total_shares": data.get("f84", 0),
            "float_shares": data.get("f85", 0),
            "mcap": data.get("f116", 0),
            "float_mcap": data.get("f117", 0),
            "list_date": str(data.get("f189", "")),
            "price": data.get("f43") or quote.get("price"),
            "quote": quote,
            "source": "tencent_quote+eastmoney_push2" if data else "tencent_quote",
        }

    def announcements(self, code: str, page_size: int = 30) -> list[dict[str, Any]]:
        """Fetch CNInfo announcements for a stock."""
        symbol = _normalise_code(code)
        org_id = self._cninfo_orgid(symbol)
        response = self._http_post(
            CNINFO_ANNOUNCEMENT_API,
            data={
                "stock": f"{symbol},{org_id}",
                "tabName": "fulltext",
                "pageSize": str(page_size),
                "pageNum": "1",
                "column": "",
                "category": "",
                "plate": "",
                "seDate": "",
                "searchkey": "",
                "secid": "",
                "sortName": "",
                "sortType": "",
                "isHLtitle": "true",
            },
            headers={
                "User-Agent": UA,
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": "https://www.cninfo.com.cn/new/disclosure",
                "Origin": "https://www.cninfo.com.cn",
            },
            timeout=15,
        )
        payload = response.json()
        return [
            {
                "title": item.get("announcementTitle", ""),
                "type": item.get("announcementTypeName", ""),
                "date": _cninfo_ts_to_date(item.get("announcementTime")),
                "url": (
                    "https://www.cninfo.com.cn/new/disclosure/detail"
                    f"?annoId={item.get('announcementId', '')}"
                ),
                "source": "cninfo",
            }
            for item in payload.get("announcements", []) or []
        ]

    def _cninfo_orgid(self, symbol: str) -> str:
        if not self._cninfo_orgid_map:
            try:
                response = self._http_get(CNINFO_ORGID_API, headers={"User-Agent": UA}, timeout=15)
                self._cninfo_orgid_map = {
                    item["code"]: item["orgId"]
                    for item in response.json().get("stockList", [])
                    if item.get("code") and item.get("orgId")
                }
            except Exception as exc:
                logger.warning("cninfo orgId mapping failed; using fallback: %s", exc)
        if symbol in self._cninfo_orgid_map:
            return self._cninfo_orgid_map[symbol]
        if symbol.startswith("6"):
            return f"gssh0{symbol}"
        if symbol.startswith(("8", "4")):
            return f"gsbj0{symbol}"
        return f"gssz0{symbol}"

    @staticmethod
    def _normalise_report(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "title": row.get("title", ""),
            "publish_date": str(row.get("publishDate", ""))[:10],
            "org": row.get("orgSName", ""),
            "info_code": row.get("infoCode", ""),
            "rating": row.get("emRatingName", ""),
            "eps_this_year": row.get("predictThisYearEps"),
            "eps_next_year": row.get("predictNextYearEps"),
            "eps_next_two_year": row.get("predictNextTwoYearEps"),
            "industry": row.get("indvInduName", ""),
            "source": "eastmoney_reportapi",
        }


@register
class DataLoader:
    """a-stock-data A-share OHLCV loader backed by Tencent's no-auth K-line API."""

    name = "a_stock_data"
    markets = {"a_share"}
    requires_auth = False

    def __init__(
        self,
        quotes_factory: Callable[[], Any] | None = None,
        kline_fetcher: Callable[..., Any] | None = None,
    ) -> None:
        # quotes_factory is kept for tests/back-compat with the first adapter
        # shape; production uses Tencent HTTP so mootdx stays optional.
        self._quotes_factory = quotes_factory
        self._kline_fetcher = kline_fetcher
        self._client = None

    def is_available(self) -> bool:
        return True

    def _get_client(self):
        if self._client is None:
            if self._quotes_factory is not None:
                self._client = self._quotes_factory()
            else:
                from mootdx.quotes import Quotes
                self._client = Quotes.factory(market="std")
        return self._client

    def fetch(
        self,
        codes: List[str],
        start_date: str,
        end_date: str,
        *,
        interval: str = "1D",
        fields: Optional[List[str]] = None,
    ) -> Dict[str, pd.DataFrame]:
        validate_date_range(start_date, end_date)
        if interval != "1D":
            raise ValueError("a_stock_data currently supports only 1D OHLCV via mootdx")

        result: Dict[str, pd.DataFrame] = {}
        for code in codes:
            if not _is_a_share(code):
                continue
            try:
                df = cached_loader_fetch(
                    source=self.name,
                    symbol=code,
                    timeframe=interval,
                    start_date=start_date,
                    end_date=end_date,
                    fields=None,
                    fetch=lambda code=code: self._fetch_one(code, start_date, end_date),
                )
                if df is not None and not df.empty:
                    result[code] = df
            except Exception as exc:
                logger.warning("a_stock_data failed for %s: %s", code, exc)
        return result

    def _fetch_one(self, code: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        symbol = _normalise_code(code)
        if self._quotes_factory is not None:
            client = self._get_client()
            df = client.get_k_data(code=symbol, start_date=start_date, end_date=end_date)
            return self._normalize_daily(df)
        fetcher = self._kline_fetcher or self._fetch_tencent_kline
        return fetcher(symbol, start_date, end_date)

    @staticmethod
    def _fetch_tencent_kline(symbol: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        tencent_code = _tencent_symbol(symbol)
        url = (
            "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
            f"?param={tencent_code},day,{start_date},{end_date},500,qfq"
        )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Referer": "https://web.ifzq.gtimg.cn/",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode("utf-8"))

        stock_data = payload.get("data", {})
        if not stock_data:
            return None
        stock_key = next(iter(stock_data), None)
        if not stock_key:
            return None
        rows = stock_data[stock_key].get("qfqday") or stock_data[stock_key].get("day") or []
        if not rows:
            return None
        frame = pd.DataFrame(
            [
                {
                    "trade_date": row[0],
                    "open": row[1],
                    "close": row[2],
                    "high": row[3],
                    "low": row[4],
                    "volume": row[5],
                }
                for row in rows
                if len(row) >= 6
            ]
        )
        if frame.empty:
            return None
        frame["trade_date"] = pd.to_datetime(frame["trade_date"])
        frame = frame.set_index("trade_date").sort_index()
        for col in ("open", "high", "low", "close", "volume"):
            frame[col] = pd.to_numeric(frame[col], errors="coerce")
        frame = frame[["open", "high", "low", "close", "volume"]].dropna(
            subset=["open", "high", "low", "close"]
        )
        return frame if not frame.empty else None

    @staticmethod
    def _normalize_daily(df: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
        if df is None or df.empty:
            return None
        out = df.rename(columns={"vol": "volume"}).copy()
        if "date" in out.columns:
            out["trade_date"] = pd.to_datetime(out["date"])
            out = out.set_index("trade_date")
        else:
            out.index = pd.to_datetime(out.index)
            out.index.name = "trade_date"
        for col in ("open", "high", "low", "close", "volume"):
            out[col] = pd.to_numeric(out[col], errors="coerce")
        out = out[["open", "high", "low", "close", "volume"]].dropna(
            subset=["open", "high", "low", "close"]
        )
        return out.sort_index() if not out.empty else None
