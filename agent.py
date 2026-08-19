"""Adaptive short-horizon momentum agent for Builderr Trading Agents Round 2.

Design goals:
- forward-only daily-bar decisions, no network, no external state, no API keys;
- keep total target capital <= 96%, each ticker <= 23%, beta-adjusted gross <= 1.30x;
- faster 2-day re-evaluation suited to a short remaining live window;
- participate only when broad trend/breadth are constructive;
- prefer liquid leaders with 10/20/60-day momentum, trend strength and volatility discipline;
- preserve a defensive sleeve or cash when the regime is weak.

This is a contest/paper-market agent. It never connects to a broker or uses real money.
"""
from __future__ import annotations

from math import sqrt
from statistics import mean, pstdev
from typing import Any

RISK_ASSETS = (
    "QQQ", "SPY", "IWM", "DIA",
    "XLK", "SMH", "XLY", "XLC", "XLI", "XLF", "XLE", "XLV",
    "NVDA", "AVGO", "AMD", "META", "AMZN", "GOOGL", "MSFT", "AAPL",
    "TSLA", "PLTR", "COIN",
)
BREADTH_ASSETS = ("QQQ", "SPY", "IWM", "XLK", "SMH", "XLY", "XLC", "XLI", "XLF", "XLE", "XLV")
DEFENSIVE_ASSETS = ("GLD", "XLP", "XLU", "XLV")
LEVERAGED_MULTIPLE = {
    "TQQQ": 3.0, "SOXL": 3.0, "UPRO": 3.0, "SPXL": 3.0, "TNA": 3.0,
    "FAS": 3.0, "TECL": 3.0, "LABU": 3.0, "CURE": 3.0, "DRN": 3.0,
    "UDOW": 3.0, "NAIL": 3.0,
    "QLD": 2.0, "SSO": 2.0, "DDM": 2.0, "ROM": 2.0, "UWM": 2.0, "AGQ": 2.0,
}

MAX_WEIGHT = 0.23
MAX_TOTAL_WEIGHT = 0.96
MAX_BETA_GROSS = 1.30
REBALANCE_DAYS = 2
MIN_TRADE_PCT = 0.012
DRIFT_LIMIT = 0.275

_last_rebalance_date: str | None = None


def _closes(bars: list[dict[str, Any]] | None) -> list[float]:
    if not bars:
        return []
    out: list[float] = []
    for bar in bars:
        try:
            px = float(bar["close"])
        except (KeyError, TypeError, ValueError):
            return []
        if px <= 0:
            return []
        out.append(px)
    return out


def _sma(values: list[float], n: int) -> float | None:
    if len(values) < n:
        return None
    return mean(values[-n:])


def _momentum(values: list[float], n: int) -> float | None:
    if len(values) <= n:
        return None
    start = values[-(n + 1)]
    return values[-1] / start - 1.0 if start > 0 else None


def _vol(values: list[float], n: int = 20) -> float | None:
    if len(values) <= n:
        return None
    window = values[-(n + 1):]
    rets = [window[i] / window[i - 1] - 1.0 for i in range(1, len(window)) if window[i - 1] > 0]
    if len(rets) != n:
        return None
    return pstdev(rets) * sqrt(252.0)


def _bar_date(market_state: dict[str, list[dict[str, Any]]]) -> str | None:
    bars = market_state.get("SPY") or market_state.get("QQQ") or []
    if not bars:
        return None
    ts = bars[-1].get("ts")
    return str(ts)[:10] if ts is not None else str(len(bars))


def _days_since(date: str | None, market_state: dict[str, list[dict[str, Any]]]) -> int | None:
    if date is None:
        return None
    bars = market_state.get("SPY") or market_state.get("QQQ") or []
    dates = [str(bar.get("ts", i))[:10] for i, bar in enumerate(bars)]
    if date not in dates:
        return None
    return len(dates) - 1 - dates.index(date)


def _positions(portfolio_state: dict[str, Any]) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {}
    for raw in portfolio_state.get("positions", []) or []:
        ticker = str(raw.get("ticker", "")).upper()
        if not ticker:
            continue
        try:
            qty = float(raw.get("quantity", 0.0))
            avg_cost = float(raw.get("avg_cost", 0.0))
        except (TypeError, ValueError):
            continue
        if qty > 0:
            result[ticker] = {"quantity": qty, "avg_cost": avg_cost}
    return result


def _prices(market_state: dict[str, list[dict[str, Any]]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for ticker, bars in market_state.items():
        values = _closes(bars)
        if values:
            out[ticker.upper()] = values[-1]
    return out


def _equity(portfolio_state: dict[str, Any], cash: float, prices: dict[str, float]) -> float:
    try:
        total = float(portfolio_state.get("cash", cash))
    except (TypeError, ValueError):
        total = float(cash or 0.0)
    last_prices = portfolio_state.get("last_prices", {}) or {}
    for ticker, pos in _positions(portfolio_state).items():
        try:
            px = float(last_prices.get(ticker, prices.get(ticker, pos["avg_cost"])))
        except (TypeError, ValueError):
            px = prices.get(ticker, pos["avg_cost"])
        total += pos["quantity"] * max(px, 0.0)
    return max(total, 0.0)


def _scale(weights: dict[str, float]) -> dict[str, float]:
    clean = {t: min(MAX_WEIGHT, max(0.0, float(w))) for t, w in weights.items() if w > 0}
    total = sum(clean.values())
    if total > MAX_TOTAL_WEIGHT and total > 0:
        f = MAX_TOTAL_WEIGHT / total
        clean = {t: w * f for t, w in clean.items()}
    beta = sum(w * LEVERAGED_MULTIPLE.get(t, 1.0) for t, w in clean.items())
    if beta > MAX_BETA_GROSS and beta > 0:
        f = MAX_BETA_GROSS / beta
        clean = {t: w * f for t, w in clean.items()}
    return {t: round(w, 6) for t, w in clean.items() if w >= 0.005}


def _regime(market_state: dict[str, list[dict[str, Any]]]) -> tuple[str, float]:
    spy = _closes(market_state.get("SPY"))
    qqq = _closes(market_state.get("QQQ"))
    if len(spy) < 61 or len(qqq) < 61:
        return "unknown", 0.0
    spy20, spy50 = _sma(spy, 20), _sma(spy, 50)
    qqq20, qqq50 = _sma(qqq, 20), _sma(qqq, 50)
    qqqv = _vol(qqq, 20)
    if None in (spy20, spy50, qqq20, qqq50, qqqv):
        return "unknown", 0.0

    breadth_n = 0
    breadth_ok = 0
    for ticker in BREADTH_ASSETS:
        values = _closes(market_state.get(ticker))
        if len(values) < 21:
            continue
        s20 = _sma(values, 20)
        m10 = _momentum(values, 10)
        if s20 is None or m10 is None:
            continue
        breadth_n += 1
        if values[-1] > s20 and m10 > 0:
            breadth_ok += 1
    breadth = breadth_ok / breadth_n if breadth_n else 0.0

    strong = (
        spy[-1] > spy20 > spy50
        and qqq[-1] > qqq20 > qqq50
        and qqqv < 0.31
        and breadth >= 0.55
    )
    normal = (
        spy[-1] > spy50
        and qqq[-1] > qqq50
        and qqqv < 0.37
        and breadth >= 0.40
    )
    if strong:
        return "strong", breadth
    if normal:
        return "normal", breadth
    return "weak", breadth


def _score_asset(values: list[float]) -> float | None:
    if len(values) < 61:
        return None
    m5 = _momentum(values, 5)
    m10 = _momentum(values, 10)
    m20 = _momentum(values, 20)
    m60 = _momentum(values, 60)
    s20 = _sma(values, 20)
    s50 = _sma(values, 50)
    v20 = _vol(values, 20)
    if None in (m5, m10, m20, m60, s20, s50, v20):
        return None
    if values[-1] <= s20 or values[-1] <= s50 or m20 <= 0:
        return None
    trend_gap = values[-1] / s20 - 1.0
    accel = m5 - (m20 / 4.0)
    return (0.18 * m5) + (0.24 * m10) + (0.30 * m20) + (0.18 * m60) + (0.18 * trend_gap) + (0.08 * accel) - (0.10 * v20)


def target_weights(market_state: dict[str, list[dict[str, Any]]]) -> dict[str, float]:
    regime, breadth = _regime(market_state)
    if regime == "unknown":
        return {}
    if regime == "weak":
        defensive: dict[str, float] = {}
        for ticker, weight in (("GLD", 0.23), ("XLP", 0.20), ("XLU", 0.18), ("XLV", 0.16)):
            values = _closes(market_state.get(ticker))
            if len(values) >= 20:
                s20 = _sma(values, 20)
                if s20 is not None and values[-1] >= s20:
                    defensive[ticker] = weight
        return _scale(defensive)

    ranked: list[tuple[float, str]] = []
    for ticker in RISK_ASSETS:
        score = _score_asset(_closes(market_state.get(ticker)))
        if score is not None and score > 0:
            ranked.append((score, ticker))
    ranked.sort(reverse=True)

    selected: list[str] = []
    broad_count = 0
    broad = {"SPY", "QQQ", "IWM", "DIA"}
    for _, ticker in ranked:
        if ticker in broad:
            if broad_count >= 1:
                continue
            broad_count += 1
        selected.append(ticker)
        if len(selected) >= 4:
            break
    if len(selected) < 3:
        return _scale({"QQQ": 0.22, "SPY": 0.21, "XLK": 0.20})

    overlay = False
    qld = _closes(market_state.get("QLD"))
    qqq = _closes(market_state.get("QQQ"))
    if regime == "strong" and len(qld) >= 21 and len(qqq) >= 61:
        qld20 = _sma(qld, 20)
        qqq10 = _momentum(qqq, 10)
        qqq20 = _momentum(qqq, 20)
        qqqv = _vol(qqq, 20)
        overlay = bool(
            qld20 is not None
            and qld[-1] > qld20
            and qqq10 is not None and qqq20 is not None
            and qqq10 > 0 and qqq20 > 0
            and qqqv is not None and qqqv < 0.27
            and breadth >= 0.60
        )

    weights: dict[str, float] = {}
    if overlay:
        for ticker in selected:
            weights[ticker] = 0.18
        weights["QLD"] = 0.22
    else:
        for ticker in selected:
            weights[ticker] = 0.23
    return _scale(weights)


def _drifted(portfolio_state: dict[str, Any], total_equity: float, prices: dict[str, float]) -> bool:
    if total_equity <= 0:
        return False
    last_prices = portfolio_state.get("last_prices", {}) or {}
    for ticker, pos in _positions(portfolio_state).items():
        try:
            px = float(last_prices.get(ticker, prices.get(ticker, pos["avg_cost"])))
        except (TypeError, ValueError):
            px = prices.get(ticker, pos["avg_cost"])
        if px > 0 and pos["quantity"] * px / total_equity > DRIFT_LIMIT:
            return True
    return False


def _rebalance_orders(targets: dict[str, float], portfolio_state: dict[str, Any], cash: float, prices: dict[str, float]) -> list[dict[str, object]]:
    positions = _positions(portfolio_state)
    total_equity = _equity(portfolio_state, cash, prices)
    if total_equity <= 0:
        return []
    threshold = total_equity * MIN_TRADE_PCT
    orders: list[dict[str, object]] = []
    sell_proceeds = 0.0

    for ticker, pos in positions.items():
        px = prices.get(ticker)
        if not px:
            continue
        current = pos["quantity"] * px
        target = total_equity * targets.get(ticker, 0.0)
        delta = target - current
        if ticker not in targets and current >= threshold:
            qty = int(pos["quantity"])
            if qty > 0:
                orders.append({"ticker": ticker, "side": "sell", "quantity": qty})
                sell_proceeds += qty * px
        elif delta < -threshold:
            qty = min(int(abs(delta) // px), int(pos["quantity"]))
            if qty > 0:
                orders.append({"ticker": ticker, "side": "sell", "quantity": qty})
                sell_proceeds += qty * px

    try:
        cash_now = float(portfolio_state.get("cash", cash))
    except (TypeError, ValueError):
        cash_now = float(cash or 0.0)
    spendable = max(cash_now, 0.0) + sell_proceeds * 0.97

    for ticker, weight in sorted(targets.items(), key=lambda item: item[0]):
        px = prices.get(ticker)
        if not px:
            continue
        current_qty = positions.get(ticker, {}).get("quantity", 0.0)
        current = current_qty * px
        target = total_equity * weight
        delta = target - current
        if delta < threshold:
            continue
        buy_value = min(delta, spendable)
        qty = int(buy_value // px)
        if qty > 0:
            orders.append({"ticker": ticker, "side": "buy", "quantity": qty})
            spendable -= qty * px

    return orders[:45]


def decide(market_state: dict, portfolio_state: dict, cash: float) -> list[dict]:
    global _last_rebalance_date
    if not market_state:
        return []
    current_date = _bar_date(market_state)
    if current_date is None:
        return []
    prices = _prices(market_state)
    total_equity = _equity(portfolio_state, cash, prices)
    days_since = _days_since(_last_rebalance_date, market_state)
    if (
        _last_rebalance_date is not None
        and days_since is not None
        and days_since < REBALANCE_DAYS
        and not _drifted(portfolio_state, total_equity, prices)
    ):
        return []

    targets = target_weights(market_state)
    if not targets:
        return []
    orders = _rebalance_orders(targets, portfolio_state, cash, prices)
    if orders:
        _last_rebalance_date = current_date
    return orders
