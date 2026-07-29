# Morning screening — design

How to find candidate trades across the whole US market each morning, using
TradingView's own scanner as the coarse filter and this repo's detectors as the
verdict.

Status: **built and running.** Scheduled weekdays 07:00 ET.

| | |
|---|---|
| Exact parameters | [screening-parameters.md](screening-parameters.md) — generated from the code |
| Runner | `node scripts/morning-screen.js` |
| Output | `reports/morning-screen-YYYY-MM-DD.json` + the `Swing Opportunities` watchlist |
| Scheduled task | `morning-screen`, weekdays **05:30 PT** (an hour before the 06:30 PT open) |

Three things changed between this design and the implementation, each because
the live data disagreed with the plan — see the git log for the measurements:

1. **Ranking is confluence WITHIN direction**, not global. `structural_reversal`
   overlaps every other screen at 0% by construction, so a global ranking
   deleted the reversal side outright.
2. **The continuation screens overlap up to 42%**, so their agreement is not
   independent confirmation. The pairwise matrix ships in every report.
3. **`/replace/` is a reorder, not a rewrite.** A watchlist rewrite is
   remove-then-append; `/replace/` only imposes order afterwards.

A **KEEP** section in the watchlist is preserved across rewrites — its symbols
stay in the list and their drawings are not cleared.

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

## Decisions — settled, with what was measured

### 1. Universe: S&P 500 + Nasdaq Composite + Russell 2000

Index membership is **not a filter**, which took several attempts to establish.
`indexes` rejects every operation with HTTP 400; `index_id` accepts them and
matches nothing — a silent zero, the most expensive kind of wrong. It is a
top-level `symbols.symbolset`:

```jsonc
{ "symbols": { "symbolset": ["SYML:SP;SPX","SYML:NASDAQ;IXIC","SYML:TVC;RUT"] },
  "filter": [ … ], "columns": [ … ], "markets": ["america"] }
```

| Set | symbolset id | Count |
|---|---|---|
| S&P 500 | `SYML:SP;SPX` | 503 |
| Nasdaq Composite | `SYML:NASDAQ;IXIC` | 3381 |
| Nasdaq 100 | `SYML:NASDAQ;NDX` | 103 |
| Russell 2000 | `SYML:TVC;RUT` | 1977 |
| **union, deduplicated** | | **4505** |

"Nasdaq" is read as the **Composite**. Swapping in `NDX` for the 100 takes the
universe from 4,505 to roughly 2,400.

### 2. Top 20 — ranked by CONFLUENCE, not by a composite

Each screen ranks its own candidates on its own axis. They are then merged and
ranked by **how many screens a name appears in**, tie-broken by 12-month
performance.

This is deliberate. A weighted composite across six screens invents six
coefficients nobody measured, which is curve-fitting with extra steps. Counting
agreement invents nothing, and it is the rule this repo already runs on — the
same reason a lone divergence is discarded at a 99% noise floor and two
agreeing are kept at 13.5%.

A name hitting one screen is not excluded; it ranks below a name hitting three.

### 3. Output: a rewritten watchlist AND a companion report

**Watchlist — the mechanism already exists.** `src/core/watchlist_sync.js` has
carried the full write path for some time:

```
read:  GET  /api/v1/symbols_list/active/
list:  GET  /api/v1/symbols_list/custom/          -> [{id, name, symbols, active}]
write: POST /api/v1/symbols_list/custom/{id}/replace/   body = the full array
find:  GET  /api/v1/symbols_list/search/?text=   -> resolves a bare ticker
```

It runs from inside the chart page so the session cookie applies, resolves bare
tickers to TradingView symbols (`RHM.DE` → `XETR:RHM`), refuses to write when a
symbol would appear twice (TradingView 422s the whole request on a duplicate),
verifies the entry count moved by exactly the expected amount afterwards, and
backs the previous list up.

**The one thing that does not carry over is its safety rule.** `applySync` is
deliberately *additive only*:

```
Refusing to write: rebuilding the watchlist would drop N existing symbols
Refusing to write: rebuilt watchlist is smaller
```

That is right for the TA sync, whose job is to never lose a symbol from a
314-entry list the user curates. It is exactly wrong for a list that is
rewritten from scratch every morning, where shrinking is the point.

So the daily rewrite needs its own path with the guard **inverted**: instead of
*never shrink*, it is *never write to a list you do not own*. Concretely — the
target is resolved by exact name match, the id is confirmed against that name
immediately before the POST, and any other list is untouchable. A rewrite that
cannot find `Swing Opportunities` by name must fail rather than fall back to
the active list, because the active list is the 314-entry one.

Everything else — resolution, duplicate handling, count verification, backup —
is reused rather than rewritten.

**The list itself is yours to create.** Nothing here creates account objects;
it only rewrites the one list you designate. Create `Swing Opportunities` in
TradingView and the runner will find it by name.

*(An earlier draft of this doc said the write path was unproven and that
`TradingViewApi.watchlist()` being unimplemented left REST as an untested
option. That was wrong — `watchlist_sync.js` has been using the REST path in
production. The `watchlist()` and `TV_WATCHLISTS_URL` dead ends are real, but
irrelevant.)*

**Report.** The Sunday review's schema, so TA imports one contract, not two.

> **This forces a refactor.** `assess()` — the 26-block assessment — lives
> inside `scripts/sunday-review.js` and is not exported. Copying it would create
> two versions that drift, which is exactly the failure just fixed in the
> divergence and elliott blocks: the review read keys its modules never returned
> and reported zeros across 50 rows while the prose beside them said otherwise.
> It has to move to `src/core/assessment.js` and be imported by both.

### 4. Pre-open: yes, and the daily bar is clean

**Measured at 21:16 PT on a Tuesday**, after that session had closed, on SPY:

```
bar 2026-07-24   O 738.51  H 743.72  L 737.29  C 738.93
bar 2026-07-27   O 744.91  H 745.53  L 735.87  C 739.09
bar 2026-07-28   O 739.19  H 742.79  L 735.98  C 740.86   <- last bar
```

The series ends on the **prior completed session** — no partial bar. Every
detector sees finished data, which is what a swing screen wants and the reason
pre-open is the right time to run rather than a compromise.

**Scheduled 05:30 PT**, an hour before the 06:30 PT open (08:30 ET, one hour
before 09:30 ET). The run takes 4–6 minutes, so it finishes with roughly fifty
minutes to spare.

> Two corrections worth recording, both caught after the fact.
>
> The first schedule was `0 7 * * 1-5`. Cron is evaluated in LOCAL time, which
> is Pacific here — so it would have fired at 07:00 PT, **thirty minutes after
> the open**, when today's partial bar already exists and every detector would
> be reading an unfinished session.
>
> The measurement above was originally reported as "04:16 ET". Git Bash on
> Windows silently ignores `TZ` and returns UTC, so `TZ=America/New_York date`
> gave UTC. The real time was 21:16 PT / 00:16 ET. The conclusion was unaffected
> — that is still after the close, so the last bar was a completed session — but
> the stated time was four hours out.

**What is not available pre-open**, and none of it matters here: the intraday
operands (`vwap`, `rvol`, `time_et`, `opening_range_*`) are null on a daily
chart at any hour, and `premarket_volume` is thin enough to be noise on most
names.

**The one real caveat.** A company reporting after yesterday's close is not in
yesterday's bar. The veto catches *scheduled* earnings via
`earnings_release_next_date`, but an overnight gap on news is invisible to every
detector, because they all read a bar that closed before it happened. The report
must carry, per name, the **premarket move against the last close** — flagged
past roughly half an ATR, not as a signal but as *"price has already left the
bar this analysis is based on"*.

---

## Run shape

```
07:00 ET   stage 1   one POST, 4505-symbol universe -> ~150 candidates   <1s
           merge     rank by screen-confluence, apply the veto
           top 20
07:05 ET   stage 2   20 x assess()                                       ~4 min
           deflate   rule_select across the morning's trials
07:10 ET   output    rewrite the Swing Watchlist + write the report
```

Twenty names is roughly four minutes of stage 2, against the Sunday review's
7–12 for about fifty. Comfortably inside the pre-open window.

## Settled

- **Drawings: yes**, on all twenty charts, same as the Sunday review. Stale
  drawings are cleared per ticker first — **by text signature, not by entity
  id**, since ids die with the TradingView session and this runs daily. That is
  the `sources: ['review']` path already used by the Sunday run; the morning
  screen reuses it rather than adding a second vocabulary.
- **List name: `Swing Opportunities`**, created by hand in TradingView and
  resolved by exact name. `TA_TradingView_Watchlist` (314) and `Watchlist` (175)
  are never written to.
