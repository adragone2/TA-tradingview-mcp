# Strategies by horizon — Weeks and Months

Every signal in this toolchain, sorted by the holding period its **evidence**
supports. Not by how it feels, and not by the timeframe of the chart it is read
on.

This exists because the morning screens were built without a declared horizon,
and the horizon turned out to be the thing that decided whether they were
running with the documented effect or against it.

---

## The zones are evidence, not vocabulary

`src/core/horizon.js`, from Jegadeesh (1990), Lehmann (1990), Jegadeesh &
Titman (1993):

| Zone | Days | Dominant documented effect |
|---|---|---|
| **reversal** | ≤ 21 | losers outperform winners |
| **contested** | 22–62 | neither dominates |
| **continuation** | ≥ 63 | winners outperform losers |

So the two buckets are defined by those zones, not by the words "weeks" and
"months":

- **WEEKS = 2–21 days.** Reversal-dominant. A continuation setup here is
  fighting the evidence.
- **MONTHS = 63+ days.** Continuation-dominant. Momentum and the 52-week high
  work here and essentially nowhere shorter.

### The gap in the middle is real, and it is where the current screens land

22–62 days is **contested** — neither effect dominates. Measured from the live
plans the current screens produce: median target **5.8 ATR** from entry, which
is 6 trading days if a name trends uninterrupted and 33 if it random-walks.
They straddle the reversal zone and the contested one.

That is the worst place to sit. Costs are still material and no documented
effect is pulling for you. Anything landing there should be pushed out to
Months or pulled in to Weeks deliberately, not left in the middle by accident.

---

## WEEKS — 2 to 21 days

The evidence here is thin, conditional, and expensive to trade. That is not a
reason to avoid the bucket; it is a reason to be honest about what goes in it.

| Signal | Evidence | Status |
|---|---|---|
| **Short-term reversal as liquidity provision** — Nagel (2012) | **Tier A**, and the anchor for this bucket. But: reversal portfolios "earn essentially nothing unconditionally" and "become profitable when VIX is high". | **NOT IMPLEMENTED** |
| Springs / upthrusts | 0% on 200 random walks — as selective as VCP. An event, not a state. | implemented, unscreened |
| 2+ indicators diverging in agreement | 13.5% on noise, against 99% for a lone divergence | implemented |
| Confirmed double bottom / top | Bulkowski's base rates, but measured to the *ultimate* high — a weeks-to-months exit | implemented, horizon mismatch |
| `structural_reversal` screen | the only reversal-aligned screen currently running | implemented |

**The cost problem is not incidental.** `turnover_cost`:

```
 2d hold: 126 round trips/yr -> 12.6% @10bps, 25.2% @20bps   SEVERE
 3d:       84                ->  8.4%,        16.8%          SEVERE
 5d:       50                ->  5.0%,        10.1%          SEVERE
10d:       25                ->  2.5%,         5.0%          HEAVY
21d:       12                ->  1.2%,         2.4%          manageable
```

A Weeks strategy at the 2–5 day end must out-earn 8–25% annually before it has
made a penny. At the 10–21 day end that falls to 2–5%, which is survivable. **If
this bucket is going to exist, its centre of gravity should be 10–21 days, not
2–5.**

---

## MONTHS — 63 days and beyond

This is where the well-replicated material lives, and where three Tier A
results are sitting unused.

| Signal | Evidence | Status |
|---|---|---|
| **Moving Average Distance** — Avramov, Kaplanski & Subrahmanyam (2021) | **Tier A. ~9% annualised** on value-weighted hedge portfolios. Incremental to momentum, the 52-week high and profitability. **Survives institutional trading costs.** Stronger on the LONG side. Still meaningful in years when standard momentum was not — momentum is insignificant in its presence. | **NOT IMPLEMENTED** |
| **Trend factor** — Han, Zhou & Zhu (2016) | **Tier A.** ~1.63%/month, t≈13.6 against 6.04 for momentum. Positive through 2008–09 when momentum lost heavily. Replicates in the G7. Insensitive to lag choice. | **NOT IMPLEMENTED** |
| **High-volume return premium** — Gervais, Kaniel & Mingelgrin (2001) | **Tier A.** Unusual volume over a day or week → appreciation over the following **month**. Replicates across developed and emerging markets. | **NOT IMPLEMENTED** |
| Post-earnings announcement drift | Tier A in aggregate, but **dissolves at firm level** — 16.1% of good-news quarters drift negative | TA layer, portfolio-only |
| Time-series momentum (12m) | Tier A, 58/58 futures, Sharpe 1.28 — but a PORTFOLIO result; `edge_breadth` gives what one position retains | implemented, screened |
| Nearness to the 52-week high | **Tier B** — severe liquidity conditioning, negative in illiquid names | implemented, screened |
| `momentum_pullback`, `near_52w_high`, `rs_leadership` | the three continuation screens | implemented |

### Two things to internalise about the unimplemented three

**MAD is a state, not an event.** A cross-sectional decile sort on normalised
21-day vs 200-day distance, rebalanced monthly. It is *not* a crossover trigger
and *not* a same-day entry. Implementing it as "price crossed its MA" would be
a different thing entirely, with none of the evidence.

**The trend factor's robustness is the lesson, not its return.** Results barely
change when the lag set changes — so effort spent hunting *the* right moving
average is spent on the dimension where the signal is least sensitive and
overfitting is most likely to be mistaken for skill.

**And the volume premium was tested as a monthly cross-sectional sort**, not as
a volume filter on a same-day breakout. There is no basis for assuming the
effect size survives that translation.

---

## NEITHER — structures with no horizon evidence

These are shapes, not effects. They carry Bulkowski base rates but no
academic horizon, and they mostly encode a continuation bet at a horizon where
continuation is not documented.

| | Noise floor |
|---|---|
| VCP, pennants | 0% — genuinely selective shapes |
| flags, triangles, wedges, rectangles | structural family 68% of random walks |
| channels | 33.5% found, 12% stable |
| breakout of a prior high | 32.5%, 17.5% passing 3+ checks |
| Crabel contraction/expansion | 100%, and **no lift over noise** (76.4% real vs 80.2% random) |
| supply/demand zones | 99.5% |
| Wyckoff `classifyPhase` | 100% — never abstains, so descriptive only |

The selective ones (VCP, pennants, springs) are worth using as **entry timing
inside a bucket**, not as the reason to be in a trade.

---

## What this implies for the plan

1. **Classification first** — this document. Done.
2. **The Weeks bucket is nearly empty.** Its one Tier A anchor, VIX-conditioned
   short-term reversal, is not implemented. Everything currently in it is either
   a structure with no horizon evidence, or a reversal detector without the
   conditioning that makes it pay.
3. **Three Tier A signals for Months are unimplemented**, and one of them —
   Moving Average Distance — is described in this repo's own review as the
   strongest single technical cross-sectional signal in it, and one that
   survives costs. That is the largest evidence-backed gap in the toolchain.
4. **The watchlist gets four sections**: `Weeks`, `Months`, `KEEP weeks`,
   `KEEP months`. The section machinery already works and is tested; the rewrite
   preserves any section named in `PRESERVE_SECTIONS`.
