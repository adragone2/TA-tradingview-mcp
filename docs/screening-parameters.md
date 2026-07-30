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

# Swing screens

These feed the INTRADAY / WEEKLY / MONTHLY split via the strategy each points at.

## Momentum pullback — `momentum_pullback`

**Direction:** continuation  
**Horizon:** BOTH — 12m continuation, sub-21d reversal. The only screen where the evidence pulls the same way on both legs.  
**Bet:** A name in a documented uptrend, temporarily paused rather than broken.  
**Evidence:** A. Time-series momentum replicated on 58/58 futures (Sharpe 1.28). Short-term reversal is the documented effect under 21 days. PORTFOLIO result — see edge_breadth.  
**Strategies:** `momentum_pullback` (weekly, tier C)  
**Session:** any — nothing it reads is session-sensitive

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
**Strategies:** `near_52w_high` (monthly, tier A)  
**Session:** any — nothing it reads is session-sensitive

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
**Strategies:** `vcp_base_breakout` (monthly, tier B), `REJECTED_crabel_contraction` (weekly, tier REJECTED)  
**Session:** any — nothing it reads is session-sensitive

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
**Strategies:** `wyckoff_spring_reclaim` (weekly, tier B)  
**Session:** any — nothing it reads is session-sensitive

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
**Strategies:** `momentum_12m` (monthly, tier A)  
**Session:** any — nothing it reads is session-sensitive

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 2000M |
| `Perf.3M` | > | 5 |
| `Perf.Y` | > | 10 |
| `RSI` | in | 40 … 75 |

**Client-side refine:** within 15% of the 52-week high

## Breakout at a new high — `breakout`

**Direction:** continuation  
**Horizon:** CONTINUATION — the weak side under 21 days. Run horizon_prior.  
**Bet:** Price pushing through overhead supply, where the sellers who bought the old high are cleared out.  
**Evidence:** C for the breakout itself: breakout_check has a 32.5% random-walk rate (17.5% passing 3+ checks), so a bare breakout is close to a coin flip. The SUPPLY mechanism is better evidenced — it is George and Hwang 52-week-high reasoning, which Livermore arrived at independently in the 1920s.  
**Strategies:** `breakout_continuation` (weekly, tier C)  
**Session:** any — nothing it reads is session-sensitive

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 1000M |
| `Perf.6M` | > | 0 |
| `RSI` | in | 55 … 80 |

**Client-side refine:** within 3% of the 52-week high

## Short-term reversal (liquidity provision) — `short_term_reversal`

**Direction:** reversal  
**Horizon:** REVERSAL — the side the evidence favours under 21 days, and the only screen here on the strong side of the boundary.  
**Bet:** A sharp short-horizon loser whose long-term trend is intact — paid for providing liquidity, not for being cheap.  
**Evidence:** B. Nagel (2012). CONDITIONAL: it "earns essentially nothing unconditionally" and is only active when VIX is elevated. The runner must apply that gate — this screen cannot see VIX.  
**Strategies:** `short_term_reversal` (weekly, tier B)  
**Session:** `settled` only

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 2000M |
| `Perf.1M` | in | -30 … -8 |
| `Perf.Y` | > | 0 |
| `RSI` | in | 10 … 35 |

**Client-side refine:** 5–30% below the 52-week high

## Leading stock in a leading group — `group_leadership`

**Direction:** continuation  
**Horizon:** CONTINUATION  
**Bet:** The largest name in an industry group that is moving as a group.  
**Evidence:** C. Livermore core, unmeasured here. Note what WAS measured and failed: requiring the SECOND leader to confirm cost 9.3 points of win rate (21.6% vs 30.9%, z -2.57) and discarded 58% of signals. So this screen deliberately does NOT require tandem agreement — it only prefers a leader over a laggard.  
**Strategies:** `group_leader_momentum` (monthly, tier C)  
**Session:** any — nothing it reads is session-sensitive

| Field | Op | Value |
|---|---|---|
| `market_cap_basic` | > | 2000M |
| `Perf.6M` | > | 0 |
| `RSI` | in | 45 … 75 |

**Client-side refine:** (r) => !!r.industry

# Intraday screens

Held separately from `SCREENS`. Two of the three intraday strategies need operands
that do not exist before the open — `minutes_since_open`, `vwap`, `rvol` — so the most
a pre-open screen can honestly hand them is a list of names likely to be *in play*.
`parabolic_fade` is the exception: its own criteria are price-only and daily-screenable,
which is why it has a screen that runs at any hour.

## Pre-market gap with volume — `premarket_gap`

**Direction:** either  
**Horizon:** INTRADAY — no academic evidence in this repo either way. Practitioner sources only.  
**Bet:** A name gapping on real pre-market volume, which is where an intraday range break can start.  
**Evidence:** C. Every intraday setup in the catalogue rests on practitioner books. What IS measured and relevant: a gap of 5% or more against a trend is the trend-invalidation threshold Shannon states three separate times, and luld_band gives how far a name can travel before it halts — bands DOUBLE between 09:30 and 09:45.  
**Strategies:** `opening_range_break` (intraday, tier C), `vwap_reclaim` (intraday, tier C)  
**Session:** `premarket` only

> Pre-open ONLY, and deliberately so. It ranks on premarket_change and premarket_volume, which describe the pre-market session. It does NOT rank on relative_volume_10d_calc, which scannerTrust marks unsafe pre-open because a partial day carries a fraction of its eventual volume (SPY measured 6.7M against about 45M). Measured mid-session on 2026-07-30: the premarket fields are still POPULATED (500/500 rows carry premarket_change, 431 carry premarket_volume > 0) and 46 rows still pass refine — they are THIS MORNING'S values, frozen. Present is not fresh, which is exactly why the gate reads the session state and not whether the field is null.

| Field | Op | Value |
|---|---|---|
| `close` | in | 2 … 500 |

**Client-side refine:** (r) => { const g = Number(r.premarket_change ?? r.gap); const v = Number(r.premarket_volum

## Extended from the fast average — `intraday_extension`

**Direction:** reversal  
**Horizon:** INTRADAY — and the sub-21-day REVERSAL side, which is the one direction the horizon evidence actually supports. Nearly every other screen here is a continuation bet placed where continuation is weakest; this one is not.  
**Bet:** A name stretched far enough above its fast moving average that a reversion toward it is the trade.  
**Evidence:** C. Practitioner sources only, like every intraday entry in the catalogue. The clauses are parabolic_fade's OWN criteria from strategies.json rather than anything invented here. What is measured and relevant: luld_band, because a parabolic name is the one most likely to halt, and the bands DOUBLE between 09:30-09:45 and 15:35-16:00; and short_interest, because a crowded short is what turns a fade into a squeeze against you.  
**Strategies:** `parabolic_fade` (intraday, tier C)  
**Session:** any — nothing it reads is session-sensitive

> Runs at ANY hour. Every field it reads is price-only, so none of them is the partial-day volume trap. Pre-open it reads the finished prior session, which is what a pre-open candidate list wants.

| Field | Op | Value |
|---|---|---|
| `RSI` | > | 75 |

**Client-side refine:** (r) => { const c = Number(r.close); const e = Number(r.EMA10); return Number.isFinite(c) &

## Veto — runs last, on the survivors

| Threshold | Value | Why |
|---|---|---|
| `min_days_to_earnings` | 5 | A scheduled event inside the hold dominates the setup |
| `max_off_high_pct` | 40 | Below this it is a downtrend, not a pullback |
| `min_dollar_volume` | $10M | Costs would exceed the edge |

The veto is the only screen that reliably improves results. The other five find
candidates; this removes the ones that cannot work.

## Selection

Each screen's own top **15** enter the detector gate; its top **5**
**survivors** are selected. Per screen, not pooled — so no single strategy family can
take the whole list.

There is **no confluence merge and no slot allocation**. Schema 2.x pooled every screen
into 15 continuation and 5 reversal slots and ran the detectors on whatever the merge had
already chosen, which is the exact inverse of "scanner as coarse filter, our detectors as
verdict". Confluence — how many screens wanted a name — is still recorded, and still only
breaks a tie: the continuation screens overlap heavily (`near_52w_high` × `rs_leadership`
**42%**), so their agreement is *not* independent confirmation.

The **tier** comes from the strategy the screen points at, never from the screen. A screen
pointing at no strategy would gate and select names that then classify as `null` and vanish
from the watchlist in silence, so a contract test asserts every screen above reaches one.

## Columns returned by stage 1

```
name, close, change, volume, average_volume_10d_calc, market_cap_basic, Perf.W, Perf.1M, Perf.3M, Perf.6M, Perf.Y, Perf.YTD, RSI, ATR, Volatility.D, price_52_week_high, price_52_week_low, earnings_release_next_date, sector
```

