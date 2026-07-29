# Morning screening — design

How to find candidate trades across the whole US market each morning, using
TradingView's own scanner as the coarse filter and this repo's detectors as the
verdict.

Status: **design, not built.** Every number below is measured; no code exists
yet beyond the probes that produced them.

---

## The architecture: two stages, and why

| Stage | Does what | Cost | Universe |
|---|---|---|---|
| **1. TV scanner** | Coarse filter — liquidity, performance, 52-week position, volatility, earnings timing | **one HTTP request, <1s** | 19,672 US symbols |
| **2. Our detectors** | The verdict — regime, structure, patterns, noise floors, trade plans | ~5s per symbol (chart load) | the tens that survive stage 1 |

The split is the whole design. TradingView has **breadth** — 3,771 filterable
fields across every US symbol, computed server-side. This repo has the
**evidence discipline** — noise floors, horizon priors, deflation, trade plans.
Neither does the other's job.

Measured on the flagship screen:

```
whole US universe             19672
liquid + investable            1120     type=stock, close>$10, 10d avg vol>1M, mcap>$2B
  + 12m AND 6m momentum >0      582
  + pullback conditions         166     <- stage 2 runs on these
```

Doing this by loading charts would be 19,672 chart loads. It is one POST.

### The endpoint

`POST https://scanner.tradingview.com/america/scan` — no auth, no chart
required, ~300ms. Body is `{filter, columns, sort, range, markets}`.

Note it does **not** work from inside the chart page: CSP blocks the
cross-origin fetch. It must be called from Node, which is better anyway —
morning screening then has no dependency on TradingView Desktop being open.

Field list: `GET https://scanner.tradingview.com/america/metainfo` (3,771
fields). Fields take timeframe suffixes — `RSI7|30` is RSI(7) on 30-minute
bars, `ATR|1W` weekly ATR — so a screen is not limited to daily.

---

## The trap this design exists to avoid

The obvious momentum-pullback screen is *12-month momentum positive, RSI low*.
Run it and the top of the list is:

| | Perf.Y | Perf.1M | off 52w high |
|---|---|---|---|
| SNDK | +2444% | **‑49.5%** | **‑53.4%** |
| AXTI | +1727% | ‑36.0% | ‑70.1% |
| BE | +378% | ‑43.4% | ‑52.5% |

Those are not pullbacks. They are **collapses that still carry a positive
twelve-month number**, and a low RSI is what a collapse looks like on the way
down. The screen selects the thing it was meant to avoid.

Bounding the retracement fixes it — RSI in a band rather than below a
threshold, and a floor under the one-month move:

| | Perf.Y | Perf.1M | off 52w high |
|---|---|---|---|
| RVMD | +383% | +4.9% | ‑5.5% |
| GSAT | +222% | ‑1.1% | ‑6.7% |
| TVTX | +263% | ‑5.8% | ‑7.0% |

Same idea, opposite population. **Every screen below therefore bounds its
condition on both sides.** A one-sided threshold on a momentum screen selects
the tail, and the tail is where the broken names are.

---

## The six screens

Each is a different bet. The column that matters most is which side of the
~21/63-day sign change it sits on — see
[swing-evidence-review.md](swing-evidence-review.md).

### 1. Momentum pullback — the flagship

The only screen where the evidence pulls the same way on both legs: momentum is
documented as **continuation** at 12 months and **reversal** under 21 days, so
"strong name, temporarily paused" runs with both.

```jsonc
[
  {"left":"type","operation":"equal","right":"stock"},
  {"left":"close","operation":"greater","right":10},
  {"left":"average_volume_10d_calc","operation":"greater","right":1000000},
  {"left":"market_cap_basic","operation":"greater","right":2000000000},
  {"left":"Perf.Y","operation":"greater","right":0},
  {"left":"Perf.6M","operation":"greater","right":0},
  {"left":"RSI","operation":"in_range","right":[35,55]},
  {"left":"Perf.1M","operation":"in_range","right":[-15,5]}
]
```

**166 survivors.** Stage 2 must add: `momentum_read` (do the horizons agree?),
`horizon_prior`, regime efficiency, and structure — is it pulling back **to**
something, or just falling?

> Skip-month note. Jegadeesh-Titman skip the most recent month precisely because
> it is contaminated by short-term reversal. `Perf.Y` includes it. Stage 2
> should compute the skip-month version from bars rather than trusting `Perf.Y`
> alone.

### 2. 52-week high proximity

Cross-sectionally replicated, on 1000+ ranked stocks. Breadth-discounted —
`edge_breadth` says one position retains a fraction of the published IR.

```jsonc
[ …liquidity…,
  {"left":"Perf.6M","operation":"greater","right":0},
  {"left":"RSI","operation":"in_range","right":[45,70]}
]
```
plus, computed from the returned columns: `close / price_52_week_high >= 0.95`.

The scanner has `price_52_week_high` as a **column**, not a usable ratio filter,
so the proximity test happens client-side on the returned rows.

### 3. Volatility contraction

Only the detectors with a **0% noise floor** justify a trade: VCP and pennants.
Stage 1 narrows to compressed names; stage 2 decides.

```jsonc
[ …liquidity…,
  {"left":"Volatility.D","operation":"less","right":3},
  {"left":"Perf.6M","operation":"greater","right":0}
]
```

Stage 2: `vcp_check`, pennant detection, `volatility_state`. **Reject anything
resting only on multi-bar NR** — those fire on 100% of random walks and the
contraction/expansion principle has no lift over noise.

### 4. Structural reversal

The reversal-zone play. Stage 1 finds names extended away from their trend;
stage 2 requires a detector that noise does not produce.

```jsonc
[ …liquidity…,
  {"left":"RSI","operation":"less","right":35},
  {"left":"Perf.Y","operation":"greater","right":-20}
]
```

Stage 2 accepts **only**: a Wyckoff spring/upthrust (0% on noise), a confirmed
double bottom/top with its Bulkowski base rate, or **two or more indicators
diverging in agreement** (13.5% on noise — a lone divergence is 99% and worth
nothing).

### 5. Relative strength leadership

```jsonc
[ …liquidity…, {"left":"Perf.3M","operation":"greater","right":0} ]
```
Stage 2: `relative_strength` vs SPY. The `high_warning` case — price at a new
high while the RS line is not — is a **negative** finding and should demote,
not promote.

### 6. The veto — the only screen that reliably improves results

Screens 1-5 find candidates. This one removes the ones that cannot work, and it
runs **last, on the survivors**.

| Veto | Source |
|---|---|
| Earnings inside N days | `earnings_release_next_date` (stage 1 column) + `ta_trading_context` |
| Costs exceed the edge | `costs_vs_edge`, `turnover_cost` at the intended hold |
| No support below | `levels_find` → `no_support_below` |
| Regime below the gate | efficiency vs its random-walk baseline |

---

## Two things that belong in the runner, not in any screen

### The regime gate

On the last full review **94% of names sat below the 0.3 efficiency gate**,
median 0.142 against a 0.183 random-walk baseline. A screen that ignores regime
returns chop and calls it a watchlist. The gate is a property of the morning,
not of a screen — report the market-wide share once, then apply it.

### The trial count

Six screens across a 1,120-name investable universe is **not** six tests. Every
symbol × every screen is a trial, and the best-looking name each morning is a
selection artefact unless deflated — that is exactly the annualised Sharpe of
**2.19** that 200 no-edge strategies produced in `tests/validation.test.js`.

`rule_select` already implements FDR selection with costs applied **before**
ranking. The morning runner must call it and report how many candidates the
winner beat. A morning list that does not carry its trial count is a list of
the luckiest names, not the best ones.

---

## What TradingView cannot do, which is why stage 2 exists

- Noise floors — every detector's random-walk baseline
- Regime efficiency **against its own random-walk reference**
- Horizon prior — which side of the reversal/continuation boundary
- VCP, pennants, springs, channel stability, divergence **agreement**
- Trade plans with entry/stop/target and measured base rates
- Deflation and FDR across the morning's trials
- Breadth translation — what a portfolio-scale edge is worth on one position

TradingView's `Recommend.*` fields are a rating aggregate with no published
base rate. They are not used.

---

## Open questions

1. **Universe.** `type=stock` + $2B + 1M shares gives 1,120. Wider (small caps)
   finds more but the costs screen will kill most of them.
2. **Stage 2 budget.** 166 survivors × ~5s is ~14 minutes of chart loading. Cap
   stage 1 output at the top N by some ranking, or accept the runtime?
3. **Where results go.** A report like the Sunday review, a TV watchlist
   written back, or both?
4. **Frequency.** Pre-open uses yesterday's close; intraday fields
   (`premarket_volume`, `gap`) need a live session.
