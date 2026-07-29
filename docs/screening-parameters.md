# Morning screen — parameters

**Generated from `src/core/screens.js` — do not edit by hand.**
Regenerate with `node scripts/gen-screens-doc.js`.

The design and the reasoning are in [screening.md](screening.md). This is
the exact configuration the morning run executes.

## Universe

| Index | `symbolset` | Approx |
|---|---|---|
| S&P 500 | `SYML:SP;SPX` | 503 |
| Nasdaq Composite | `SYML:NASDAQ;IXIC` | 3381 |
| Russell 2000 | `SYML:TVC;RUT` | 1977 |

Deduplicated union is about **4,505** symbols. Index membership is a top-level
`symbols.symbolset`, not a filter — `indexes` rejects every operation with HTTP
400 and `index_id` silently matches nothing.

## Applied to every screen

| Field | Op | Value |
|---|---|---|
| `type` | = | "stock" |
| `close` | > | 10 |
| `average_volume_10d_calc` | > | 1M |

A name that cannot be traded at size is excluded at stage 1 rather than found
and then vetoed — `trade_cost` would eat the edge before it exists.

## Momentum pullback — `momentum_pullback`

**Direction:** continuation  
**Horizon:** BOTH — 12m continuation, sub-21d reversal. The only screen where the evidence pulls the same way on both legs.  
**Bet:** A name in a documented uptrend, temporarily paused rather than broken.  
**Evidence:** A. Time-series momentum replicated on 58/58 futures (Sharpe 1.28). Short-term reversal is the documented effect under 21 days. PORTFOLIO result — see edge_breadth.

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 2000M |
| `Perf.Y` | > | 0 |
| `Perf.6M` | > | 0 |
| `RSI` | in | 35 … 55 |
| `Perf.1M` | in | -15 … 5 |

**Client-side refine:** 2–25% below the 52-week high

## 52-week high proximity — `near_52w_high`

**Direction:** continuation  
**Horizon:** CONTINUATION  
**Bet:** Price near its 52-week high, which is cross-sectionally documented.  
**Evidence:** A, but CROSS-SECTIONAL — measured on 1000+ ranked stocks. edge_breadth gives what one position retains of that.

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 2000M |
| `Perf.6M` | > | 0 |
| `RSI` | in | 45 … 70 |

**Client-side refine:** within 5% of the 52-week high

## Volatility contraction — `volatility_contraction`

**Direction:** continuation  
**Horizon:** CONTINUATION — the weak side of the sign change.  
**Bet:** A coiled market about to expand. Stage 1 narrows; only a 0%-noise detector justifies a trade.  
**Evidence:** B. VCP and pennants are the only structural detectors with a 0% random-walk rate. The contraction/expansion principle itself has NO lift over noise (76.4% real vs 80.2% random) — stage 2 must reject anything resting on multi-bar NR alone.

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 1000M |
| `Volatility.D` | < | 3 |
| `Perf.6M` | > | 0 |

**Client-side refine:** within 20% of the 52-week high

## Structural reversal — `structural_reversal`

**Direction:** reversal  
**Horizon:** REVERSAL — the side the evidence favours under 21 days.  
**Bet:** An extended name where a reversal STRUCTURE has formed — not merely a low RSI.  
**Evidence:** B. Stage 2 accepts only a Wyckoff spring/upthrust (0% on noise), a confirmed double bottom with its Bulkowski base rate, or 2+ indicators diverging in agreement (13.5% on noise). A lone divergence is 99% and worth nothing.

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 1000M |
| `RSI` | in | 15 … 35 |
| `Perf.Y` | > | -25 |

**Client-side refine:** () => true

## Relative strength leadership — `rs_leadership`

**Direction:** continuation  
**Horizon:** CONTINUATION  
**Bet:** Outperforming its market over a quarter and a year at once.  
**Evidence:** B. Stage 2 runs relative_strength vs SPY. The high_warning case — price at a new high while the RS line is not — DEMOTES rather than promotes.

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 2000M |
| `Perf.3M` | > | 5 |
| `Perf.Y` | > | 10 |
| `RSI` | in | 40 … 75 |

**Client-side refine:** within 15% of the 52-week high

## Veto — runs last, on the survivors

| Threshold | Value | Why |
|---|---|---|
| `min_days_to_earnings` | 5 | A scheduled event inside the hold dominates the setup |
| `max_off_high_pct` | 40 | Below this it is a downtrend, not a pullback |
| `min_dollar_volume` | $10M | Costs would exceed the edge |

The veto is the only screen that reliably improves results. The other five find
candidates; this removes the ones that cannot work.

## Ranking

Slots: **continuation 15**, **reversal 5** — scaled proportionally when fewer than 20 are requested.

Ranked by **confluence within direction**, tie-broken by 12-month performance.
Not a weighted composite: weighting the screens would invent coefficients nobody
measured. And not global confluence either — the overlap was measured, and
`structural_reversal` shares 0% with every other screen by construction (RSI
15–35 against their 40–75), so a global ranking made it structurally incapable
of scoring above 1 and deleted the reversal side outright.

The continuation screens overlap heavily — `near_52w_high` × `rs_leadership`
**42%** — so their agreement is *not* independent confirmation. The pairwise
matrix ships in every report.

## Columns returned by stage 1

```
name, close, change, volume, average_volume_10d_calc, market_cap_basic, Perf.W, Perf.1M, Perf.3M, Perf.6M, Perf.Y, Perf.YTD, RSI, ATR, Volatility.D, price_52_week_high, price_52_week_low, earnings_release_next_date, sector
```

