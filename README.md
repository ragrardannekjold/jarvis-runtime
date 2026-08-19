# Builderr Trading Agents Round 2 — submission branch

This branch is an isolated contest artifact for the Builderr Trading Agents Round 2 live paper-market challenge.

## Entry

`agent.py` implements the required `decide(market_state, portfolio_state, cash)` contract.

The strategy is a deterministic, no-network, no-API-key momentum/regime controller with explicit risk caps:

- long-only;
- target weight per ticker <= 23%;
- target capital <= 96%;
- beta-adjusted target gross <= 1.30x;
- 2-trading-day rebalance cadence unless concentration drift requires action;
- defensive/cash behavior in weak regimes;
- no brokerage integration and no real-money trading.

## Validation status

Before publication, the candidate passed Python compilation, the Builderr self-check contract shape on the official self-check universe, deterministic scenario tests, and 300 randomized synthetic regime scenarios. Those are compatibility/safety checks only. They are **not** official Builderr admission results, backtest returns, live returns, or a claim that the entry will win a prize.

The official Builderr grader remains authoritative for admission and scoring.

Candidate SHA-256 before publication: `e412413965192a993f56d0bf3373957bfc6ea65c22d61c0a107cafda1e58ff79`.

## Privacy and dependencies

This branch contains no private system configuration, credentials, customer data, military/safety-critical material, personal banking data, or external API key. The agent uses Python standard library only.

## Rights

Submitted for evaluation under the Builderr challenge rules. Code ownership remains with the author. Public readability is not a grant of broader commercial reuse; see `LICENSE.md`.
