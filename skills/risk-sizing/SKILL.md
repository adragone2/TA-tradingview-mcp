---
name: risk-sizing
description: Size a position and check whether an edge survives its own losing streaks — expectancy, break-even win rate, Kelly, risk of ruin, ATR-based sizing, drawdown recovery. Use when the user asks how much to risk, whether a strategy is worth trading, what their expectancy is, how big a position should be, or about Kelly, win rate, or drawdown.
---

# Risk and Position Sizing

Two questions, in this order. The second is the one people skip.

1. **Is the edge positive?** — expectancy
2. **Does the account survive long enough to collect it?** — risk of ruin

A strategy with a real edge still ruins an account if it is sized so an ordinary losing streak ends it. Answering only the first question is how that happens.

## The rule that makes this worth having

**A win rate is meaningless without its payoff.** 80% wins money or loses money depending entirely on the size of the losses; 30% can be excellent. Never compare a win rate to 50% — compare it to the break-even win rate for that payoff, which `risk_expectancy` returns alongside every answer.

## Is the edge real?

```
risk_expectancy win_rate_pct=45 risk_reward=2 sample_size=150
risk_expectancy win_rate_pct=45 avg_win=380 avg_loss=200 sample_size=150
```

Prefer `avg_win` / `avg_loss` when they are known — a strategy's real average win is rarely its target, and using the target flatters it.

Returns expectancy in R, the break-even win rate, the edge (the gap between them), and Kelly with its fractions.

**Always pass `sample_size`.** It decides how much the answer trusts itself. A win rate from 20 trades has an error bar wide enough to flip the sign of the edge, and the tool says so rather than handing back a confident Kelly figure computed on noise.

If expectancy is negative, stop. Report it and say plainly that no position size fixes a negative edge — sizing only changes how fast it loses.

**If the "edge" is borrowed from a published study, divide it first.**

```
edge_breadth edge=time_series_momentum your_positions=1
```

Every well-evidenced effect in this toolchain was measured across many instruments — momentum on 58 futures, the 52-week high on 1000+ ranked stocks, PEAD on decile portfolios. `IR = IC × √BR`. Momentum's published Sharpe of **1.28 retains 13% of its information ratio on one position**, and would take ~136 years to distinguish from luck.

Quoting a study's Sharpe at a single-name trade is the most common way to over-size. Run the division before it reaches a position size.

Where a backtest already exists, `backtest_evaluate` gives the same arithmetic measured from real trades. Use that; this tool is for the forward question, before there are trades.

## How much to risk

`risk_expectancy` returns full, half and quarter Kelly. **Full Kelly is almost never the answer.**

Kelly maximises long-run growth *given that the win rate and payoff are exact and constant*. They are neither. Overstate the win rate by a few points — trivially easy on a small sample — and full Kelly stops being growth-optimal and becomes ruinous.

Then check what the sizing actually does:

```
risk_of_ruin win_rate_pct=45 risk_reward=2 risk_per_trade_pct=1
risk_of_ruin win_rate_pct=45 risk_reward=2 risk_per_trade_pct=10
```

This is the step that makes the point concretely. A 45%/2:1 edge at 10% per trade hits a 50% drawdown in most runs while still showing a *median* account that grew — the median is not the experience. Report the ruin probability and the worst 5% outcome, never the median alone.

Seeded, so the same inputs always give the same answer.

## Where the stop goes, and how many shares

```
position_size_constrained  → from prices, under ALL THREE constraints
position_size              → from a position already drawn on the chart (same three)
position_size_atr          → from volatility
```

### The risk budget alone is not the answer

**A fixed-risk formula is unsafe on its own, and the reason is counterintuitive: under fixed risk a TIGHTER stop buys MORE shares.** So the better the entry looks, the more likely the position is too big.

Shannon's own worked example (ch. 16): a $50 stock, stop just below support at 49.25, so **$0.75 of risk per share**. Risking 1% of a $100,000 account is $1,000, which buys **1,333 shares** — $66,650, or **65% of the account in one idea**. Every step of that arithmetic is correct and the answer is unusable.

There are three constraints and **the smallest one wins**:

| Constraint | Default | Source |
|---|---|---|
| Risk budget | 1% of equity, never more than 2% | Shannon, and universal |
| **Concentration cap** | **15–20% of equity in one position** | Shannon ch. 16 — the one people omit |
| **Liquidity** | 2% of average daily volume | *This repo's choice* — Shannon raises liquidity but names no number |

`position_size_constrained` returns the minimum, names `binding_constraint`, and reports what the risk budget alone *would* have bought so the difference is visible. His second example binds on liquidity instead: a $2.50 stock with support 15 cents away gives 6,666 shares, which is 2.2% of a 300,000-share ADV.

**Pass `adv`.** Without it the liquidity constraint comes back as `NOT CHECKED` — unknown is not the same as satisfied, and one third of the answer was never tested. Get it from `data_get_ohlcv` or from `short_interest`, which returns FINRA's own ADV.

Two things follow that are easy to miss:

- **Actual risk taken can fall well below the budget.** In the example above the capped 400 shares risk $300, not $1,000. Someone reading only "1% risk" is wrong about the position in both directions.
- **Reporting a constraint is not applying it.** `position_size` used to print `notional_pct_of_account` and then hand back the risk-derived quantity anyway. It no longer does.

### Sizing from volatility instead

`position_size_atr` places the stop a multiple of ATR from entry, so the position shrinks automatically when the instrument gets more volatile. Read ATR off the chart first with `data_get_study_values` (add "Average True Range" via `chart_manage_indicator` if it isn't there). It does **not** apply the concentration or liquidity caps — check the result against `position_size_constrained` before using it.

Pass `manual_stop` to compare against a stop chosen from structure. The comparison is the useful part: **a stop closer than 1x ATR is inside the instrument's ordinary bar range and will be hit by noise rather than by being wrong.** That is a reason to widen the stop and take fewer shares, not to skip the check.

The best stop is usually both — beyond a level that actually matters, plus a fraction of ATR of room beyond it.

## What the stop costs — say which reason you are using it for

```
stopping_premium          → is there enough persistence for a stop to pay?
```

Kaminski & Lo (2014) prove something most trading material never mentions: **under a random walk the stopping premium is *always negative*.** A stop then only "force[s] the portfolio out of higher-yielding assets on occasion, thereby lowering the overall expected return without adding any benefits. In such cases, stop-loss rules never stop losses."

It turns **positive under momentum**, and is *directly proportional to the magnitude of return persistence*.

So a stop is a **bet on persistence**, not free insurance — and persistence is measurable. `stopping_premium` reports autocorrelation at several lags with a significance band and translates it:

| `persistence_verdict` | What it means for the stop |
|---|---|
| `persistent` | The stop can add expected return, not just cap losses |
| `no measurable persistence` | Indistinguishable from a random walk — the stop is a **drag** |
| `mean-reverting` | **Worst case.** Losses tend to recover, so the stop exits at the worst moment |
| `mixed across horizons` | Match the lag to how long the stop will be live |

**Two things to keep straight.**

- This measures the effect on **expected return, not ruin.** A negative stopping premium is a *price*, and bounding a loss is usually worth paying it. Never read this as "trade without a stop" — read it as "know what the stop costs, and say which reason you are using it for."
- Their premium was positive **over longer sampling frequencies**; they found stops *"of no value at short-term sampling frequencies."* A tight intraday stop is the case with the least support.

Live example: AAPL 1D showed no significant autocorrelation at any lag, and an 8% stop backtested at **−0.32 points against buy-and-hold**. That stop was solvency management, not edge — which is fine, said out loud.

## Why the large loss is the thing to avoid

```
drawdown_recovery drawdown_pct=50
```

Down 50% needs +100%. Down 80% needs +400%. The curve accelerates, and that asymmetry is why capping the loss matters more than catching the big win. Worth showing the user the table when they are arguing for a wider stop or a bigger size.

## What is deliberately not built

**Martingale sizing — doubling after a loss — is not implemented and will not be.** It "guarantees" recovery only given infinite capital; with finite capital it converts a survivable string of losses into a terminal one. If asked, explain that rather than building it.

**Averaging down** is not a sizing tool here either. Planned scaling into a position at pre-defined levels is a legitimate strategy and belongs in `rules.json` as a strategy with its levels stated in advance. Adding to a loser because it is losing is the same action without the plan, and the tools should not make the two look alike.

## Reporting

Lead with expectancy and the break-even win rate together — neither means anything alone. Then the ruin probability at the proposed size. Then the share count.

State the sample size the numbers rest on. If it is small or unknown, say the Kelly figures are unusable and recommend 1–2%.

Everything here is arithmetic on numbers the user supplied. It is not advice, and it places no orders.

## Portfolio level — the unit that actually ends accounts

Per-trade sizing is not the whole risk. Six positions risking 1% each is not 1% if they move together.

```
portfolio_heat positions=[...] account_size=..
position_correlation returns={"AAPL":[...], "MSFT":[...]}
position_concentration positions=[...] key="sector"
```

- **`effective_positions`** is the number to lead with: six positions at an average correlation of 0.8 are about 1.4 independent bets, and the per-trade sizing that looked conservative never was.
- Pairs without enough data come back **UNKNOWN, never zero.** Assuming independence is the error this measures.
- Concentration is by **risk**, not notional — two equally sized positions with different stop distances carry different risk.
- Correlations rise in a selloff, which is exactly when the diversification is being relied on. Say so.

And before sizing anything, price the round trip: `trade_cost` then `costs_vs_edge`.
