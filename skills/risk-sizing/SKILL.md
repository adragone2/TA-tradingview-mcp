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
position_size          → from a position already drawn on the chart
position_size_atr      → from volatility
```

`position_size_atr` places the stop a multiple of ATR from entry, so the position shrinks automatically when the instrument gets more volatile. Read ATR off the chart first with `data_get_study_values` (add "Average True Range" via `chart_manage_indicator` if it isn't there).

Pass `manual_stop` to compare against a stop chosen from structure. The comparison is the useful part: **a stop closer than 1x ATR is inside the instrument's ordinary bar range and will be hit by noise rather than by being wrong.** That is a reason to widen the stop and take fewer shares, not to skip the check.

The best stop is usually both — beyond a level that actually matters, plus a fraction of ATR of room beyond it.

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
