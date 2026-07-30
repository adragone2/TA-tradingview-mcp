# Shannon, Technical Analysis Using Multiple Timeframes (2008) — reading notes

**Read in full — all 198 scanned pages (99 two-up spreads), pp. i–184, every chapter.**

The book was rendered from the owner's own PDF (`books/`, git-ignored) as two-up
spreads and read sequentially. Book page ≈ PDF page − 10.

Notes below are in two parts: the numbered FINDINGS were written first, while
sampling for new capability; the `sNNN` sections that follow are the sequential
read log, in book order, and are the complete record. Where the two disagree
the sequential log is the later and better reading — the sampling pass got the
timeframe→moving-average mapping wrong, for one (Shannon's is role-based, ours
is duration-based; see s103–s104).

## What was built from it

| Finding | Where it went |
|---|---|
| Lookbacks scale LINEARLY with the timeframe ratio, volatility and stops as the SQUARE ROOT | `timeframe_scale`, `src/core/timeframe.js` |
| Short interest and days-to-cover; squeeze pressure needs LOSING shorts | `short_interest`, `src/core/finra.js` — see [data-sources.md](data-sources.md) |
| Days-to-cover is a ratio whose denominator does the work (his own Figure 15.1) | `decomposeDaysToCover`, and the 93% measurement in `scripts/short-interest-driver.js` |
| The timeframe-justification trap, named by the source | `mtf_analyze`'s `focus_timeframe_warning` |
| Extended-hours data is for exits, not entries — stated four separate times | `src/core/session.js` partial-bar guard |

## All seven follow-ups are now built — and three of Shannon's claims died in the process

Each was implemented with a measurement rather than on his authority. Two of the three that failed did so the same way the Crabel principle did: **real data showed less of the effect than noise.**

| # | Item | Where it went | What the measurement said |
|---|---|---|---|
| 1 | Four-stage ACTION machine (ch 12/13) | `stage_plan`, `src/core/stages.js` | **Gate filters, gate does not pay.** Abstains on 54% of random walks (classifyPhase: 0%). But forward-tested it makes outcomes WORSE: long 33.5% vs 36.4% baseline, short 21.2% vs 28.9%, four configurations, none favouring it |
| 2 | Three sizing constraints (ch 16) | `position_size_constrained`, `position_size` | **Confirmed and load-bearing.** His own example turns a 1% risk budget into 65% of capital. The minimum across constraints now wins and names itself |
| 3 | Touch-count inversion (ch 7) | `level_pressure` (already existed), `level_test_history` | **Both halves failed.** Count claim: real arms rise 4.5-21.2 points vs 40.3 on noise. Pressure clause: +39.1 in-sample, **+4.6 out of sample on MORE data** |
| 4 | Two missing exits (ch 16) | `EXIT_REASONS` in `src/core/exits.js` | Both planned and modellable — omitting them understated the share a backtest can represent |
| 5 | Pivot hard trailing stop (figs 16.4/16.5) | `pivot_trail`, `src/core/stops.js` | Implemented as a one-directional ratchet. Ships with `stopping_premium` beside it, because a trail is a bet on persistence |
| 6 | Journal slices (fig 16.2) | `journal_slice`, `trade-journal` skill | Reproduces his two net-negative buckets inside a profitable book. Underpowered buckets flagged, never ranked |
| 7 | Time corrections (ch 8) | `legs_classify`, `findTimeCorrections` | **Detector descriptive, claim UNTESTED.** Fires on 88% of noise / 91.7% of real. "Resolves with the primary trend" is +8.3 on daily (n=18) and -2.8 at 60-min (n=14) — opposite signs, neither significant |

Re-measure any of it: `scripts/stage-noise.js`, `scripts/stage-forward-test.js`, `scripts/level-test-inversion.js`, `scripts/time-correction-noise.js`. All use `scripts/_real_bars.js`, which requires an explicit timeframe.

**The pattern worth keeping from this exercise.** Of Shannon's claims that could be measured, **one survived**: the sizing constraints, which are arithmetic and were never in doubt. Everything directional failed — and two of them failed *after* passing a noise floor and a trial count, on a holdout.

The `level_pressure` clause is the instructive one. It scored +39.1 points at z = 3.96 with its random-walk null attached (−1.4) and a Bonferroni correction applied. Every honesty check this repo had was satisfied. Then a fresh universe with **more** levels gave +4.6 at z = 0.73. The lesson is not "be more careful with p-values" — it is that a single sample cannot tell you about a different sample, however well you audit it.

**Two process fixes came out of this and both are now standing rules:**

1. **Out-of-sample or provisional.** Any single-sample finding here is provisional until it has a different universe, a disjoint period, or both. `scripts/level-test-inversion.js` and `scripts/stage-forward-test.js` are the templates.
2. **Pin the timeframe.** Three scripts inherited the chart's 60-minute resolution and recorded results as "daily". `scripts/_real_bars.js` now requires an explicit timeframe, verifies it took, and restores symbol *and* resolution.

### What is still genuinely open

- **The 1-2-3 / ignition pattern** stays unregistered (`src/core/ignition.js`) — its noise floor cannot be measured, because the ATR gate shifts with any constructed null.
- **Shannon's own 10/20/50 on a weekly gate is untestable here.** It needs 280 base bars of warm-up and the chart serves ~300. The forward test used 5/10/20, so it does not refute *his* parameters specifically — that needs a longer history than the chart provides (WRDS, or an exported panel).
- **Nothing has tested his method as a whole** — sizing to three constraints, scaling out, the pivot trail, flat into earnings. The gate failing does not mean the method fails; it means the gate is not the part doing the work.
