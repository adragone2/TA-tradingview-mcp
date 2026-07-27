# Playbook — strategies and patterns extracted from the reference books

Distilled from the PDFs in `books/` (the user's own copies; git-ignored, never committed). This file records **what the rules are** and, just as importantly, **which parts this toolchain cannot yet evaluate**.

Nothing here has been backtested. Every setup below is a hypothesis until `backtest_drawn` or `backtest_strategy` says otherwise — see [backtest-strategy](../skills/backtest-strategy/SKILL.md), and always report buy-and-hold.

---

## Part 1 — Setups

### Swing / position (daily chart)

| Setup | Entry conditions | Stop | Target |
|---|---|---|---|
| **RSI 50 cross + SMA20 trend** | SMA20 sloping (not flat); RSI crosses 50 in the trend direction; enter on the close after the cross | Recent swing low (long) / high (short) | 1.5–2R |
| **Breakout** | Close beyond a major S/R level, **confirmed by rising volume** | Just beyond the broken level | 1.5–2R |
| **RSI divergence** | Price lower low, RSI higher low (bullish); needs a reversal candle to confirm | Beyond the divergence extreme | 1.5–2R |
| **Pullback to MA** | Strong trend (SMA20 sloping sharply); price pulls back to the MA and *bounces* | Beyond the MA | 1.5–2R |
| **Swing breakout long** | Above 200 SMA; riding/reclaiming the 8 EMA; breakout above resistance tested 2–3× | Close below the 8 EMA | Sell into extension from the 8 EMA, in quarters |

### Intraday (day-trading setups)

| Setup | Window | Core idea | Stop |
|---|---|---|---|
| **Fallen Angel / Rising Devil** | 09:30–09:40 | Gap reverses into the open, then resumes with the trend off a *pre-identified* support/resistance area | Next S/R break |
| **5-min opening range breakout** | 09:35 | Break of the first 5-minute candle's high/low, near VWAP | Loss of VWAP |
| **Extreme reversal** | 12:00–15:30 | 9/20 crosses the 50 SMA, pullback to it, entry on a new 1-min extreme | Prior wave extreme / 50 SMA |
| **Parabolic reversal** | any | Price extended from the 9 EMA; fade back toward it | Prior candle extreme |
| **ABCD** | any | Trend leg A→B, 40–70% pullback to support (often the 9 EMA), new high D | Consolidation low |
| **Lightning bolt** | 09:40–15:00 | Breaks VWAP, pulls back <½ the move, continues; volume falls on the pullback and rises on the continuation | Beyond VWAP |
| **Mountain pass** | 09:50–15:00 | Double top/bottom at the day's extreme, then a 50 SMA cross | Break of the day's extreme |
| **Break of HOD $ level** | any | HOD sits on a round-dollar level; enter on the break | ≥ $0.51 beyond entry |

### Rules that recur across nearly every intraday setup

These are **risk management**, not entry criteria — they belong in `risk_rules`, not in a strategy's `criteria`:

- Once a partial is taken, move the stop to break-even.
- Take partials at 2R and 4R, and at S/R along the way.
- If any required condition fails, **abort** — a partial setup is not a setup.
- Prefer higher relative volume (RVOL > 100%) and an actual catalyst.

---

## Part 2 — Patterns

`patterns_detect` computes these from the bars. Each returns the measurements behind it, so the claim can be checked.

### Candlestick

| Pattern | Definition as implemented |
|---|---|
| Doji | Body ≤ 10% of range |
| Hammer / Hanging man | Lower wick ≥ 2× body, upper wick ≤ body. **Name depends entirely on prior trend** |
| Shooting star / Inverted hammer | Mirror of the above |
| Bullish / Bearish engulfing | Second body fully contains the first, opposite colours |
| Harami | Small opposite body entirely inside the prior body (≤ 30% of it) |
| Dark cloud / Piercing line | Opens beyond the prior bar, closes back past the midpoint of its body |
| Inside bar | Entire *range* inside the prior bar's range |
| NR4 / NR7 | Narrowest range of the last 4 / 7 bars |
| Gap up / down | No overlap between consecutive bars' ranges |

### Structural (built from swings)

Double top/bottom, triple top/bottom, head-and-shoulders and its inverse. Each reports its **completion level** and the standard measured-move **target** (pattern height projected from the completion level).

### The two rules that matter most

**1. A pattern is not complete until price closes through its completion level.** Everything else is a shape. `patterns_detect` reports `status: "forming"` or `"confirmed"` for exactly this reason — never present a forming pattern as a signal.

**2. Candlestick reversals need a prior trend.** A hammer in a range is a bar with a long wick. The tool reports `prior_trend` and adds a caveat when there isn't one.

Both come straight from the source material, which lists *"see patterns where there aren't any"* as the first human failure mode, alongside *"believe market lore without evidence"*.

---

## Part 3 — What this toolchain cannot evaluate yet

Being explicit about this matters: a strategy silently missing its key condition becomes a much looser strategy that appears to work.

**Since built**, and now available as `strategy_check` operands: `vwap`, `rvol`, `opening_range_high(N)` / `opening_range_low(N)`, `time_et`, `minutes_since_open`. Each returns null — and so UNKNOWN — on a chart whose bars are sessions rather than intraday. Anchored VWAP with standard-deviation bands is a separate tool (`anchored_vwap`), not an operand.

Still missing:

| Missing primitive | Which setups need it |
|---|---|
| **Indicator crosses** | RSI 50 cross, 9/20 × 50 SMA. Note `rsi > 50` is a *state*; a **cross** is an event, and using the state fires on every bar of a trend |
| **MA slope** | "SMA20 sloping, not flat" |
| **Divergence** (price vs indicator swings) | RSI divergence |
| **Pullback depth %** | ABCD's 40–70% retracement |
| **Zone proximity** | "price returning to a demand zone" — `zones_find` computes zones, but zone membership is not an operand |
| **Level-test counts inside criteria** | "resistance tested 2–3 times" — `levels_find` computes it, but it is not an operand |
| **Float, catalyst, market cap** | Screening conditions. These are **TA's** job, not this layer's |

`strategy_check` returns **UNKNOWN** rather than a fail for anything it cannot evaluate — so a strategy referencing a missing primitive will say so instead of quietly passing.

---

## Guardrails

- These are **other people's strategies**, transcribed. They are not validated, not endorsed, and not tuned to this user's account or risk.
- Several were written for US small-cap day trading with a specific broker and platform. Windows, thresholds and instruments may not transfer.
- Source PDFs stay in `books/`, git-ignored. Do not commit them or reproduce them at length.
- Nothing here is trade advice.
