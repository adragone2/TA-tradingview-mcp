# What the evidence says, and what to build next

> **Read [swing-evidence-review.md](swing-evidence-review.md) first.** That is the repository owner's own evidence review and is authoritative where it and this document differ. This one is complementary: it records my measurements and the papers I read, including several the review does not cover.


Research conducted 2026-07-27. Sources are linked inline; every claim here is traceable to one.

This document exists because the project reached a point where the next improvement is not another tool. It is knowing which of the tools we already have are measuring something real.

**The headline, stated plainly:** the academic support for *chart patterns* is weak and does not replicate. The support for *trend and momentum* is strong and replicates everywhere. Our toolchain currently spends most of its sophistication on the first and treats the second as a supporting cast. That is backwards, and it is fixable.

---

## Part 1 — What is actually established

### 1.1 The pattern literature is weaker than it looks

**[Park & Irwin (2007), *Journal of Economic Surveys*](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1467-6419.2007.00519.x)** surveyed 95 modern studies of technical trading: **56 positive, 20 negative, 19 mixed**. That sounds supportive until you read their caveat — most studies suffer from *data snooping, ex-post selection of trading rules, and poor estimation of risk and transaction costs*. They also note the positive results concentrate **before the early 1990s**.

**[Lo, Mamaysky & Wang (2000), *Journal of Finance*](https://www.cis.upenn.edu/~mkearns/teaching/cis700/lo.pdf)** is the single most cited paper supporting chart patterns, and it is the methodological ancestor of what `patterns.js` does. On US stocks 1962–1996 they found conditional return distributions differed significantly from unconditional ones for **7 of 10 patterns on NYSE/AMEX and all 10 on Nasdaq**.

**[Nekrasov (2010) tried to reproduce it](https://letyourmoneygrow.com/wp-content/uploads/2018/03/report.pdf) on 1995–2010 data and failed.** In his words: *"the results are not anymore reproducible."* Testing DJ30, S&P 100, NASDAQ 100 and DAX, the Kolmogorov–Smirnov p-values were mostly too large to reject the null. **Only RTOP survived** at the optimal bandwidth (BTOP and RTOP at 0.3×h).

Three further findings from that reproduction matter to us directly:

- The original significance was driven by the **tails** of the distribution, not the body. QQ-plots showed good conformance through the middle and divergence only in the first and last quantiles.
- Lo et al's normalisation (subtract mean, divide by SD) **materially changes the KS statistic** — in 18 of 30 cases it *raised* p-values, making rejection less likely.
- Two different kernel-smoothing implementations at the same bandwidth gave *"significantly different results."* Implementation detail alone moves the answer.

### 1.2 Shape does not carry profitability

**[J.P. Morgan's technology research](https://www.jpmorgan.com/technology/technology-blog/searching-for-patterns)** clustered 50,000 bootstrap-sampled 50-day windows from S&P 500 constituents (1990–2020) using K-Means, DBSCAN, hierarchical clustering and autoencoders. Every method converged on the same answer: the data is best described by **simple harmonic oscillations**.

The finding that matters:

> almost no difference in cluster centers — between profitable, unprofitable, and random datasets, despite vastly different returns

Recurring shapes exist. **They are the same shapes whether the outcome was a gain, a loss, or noise.** This is the most direct institutional-grade caution against what a pattern detector does, and it is consistent with our own random-walk measurement.

### 1.3 The multiple-testing problem is fatal if ignored

**[White's Reality Check](https://www.researchgate.net/publication/2551052_A_Reality_Check_For_Data_Snooping)** and **[Hansen's SPA test](https://homepage.ntu.edu.tw/~ckuan/pdf/snoop01.pdf)** test whether the *best* rule out of a searched universe genuinely beats a benchmark, accounting for the search itself. Applied to technical trading rules, the result is stark: the best rule produced **~32% mean net return per annum — and was statistically insignificant once data-snooping was accounted for.**

**[Harvey, Liu & Zhu (2016), *Review of Financial Studies*](https://academic.oup.com/rfs/article/29/1/5/1843824)** make the same argument for factors: given the volume of search, **a t-statistic of 2.0 is not enough; a new factor needs t > 3.0.** They conclude most published findings in the field are likely false.

**This applies to `strategy_scan` and `rules.json` today.** Scanning N symbols against M rule combinations and reporting the winner is exactly the procedure these tests were written to invalidate. We currently apply no correction at all.

### 1.3b A noise floor and a trial count are still not enough

This is the lesson this repo learned the hard way, on its own findings, and it belongs beside White and Harvey rather than below them.

Two claims here passed **every** honesty check the sections above prescribe — a random-walk null, a stated sample size, and a multiple-testing correction — and then died on a holdout:

| Claim | With its floor and correction | On a holdout |
|---|---|---|
| `level_pressure` — interim retreat extremes moving toward a level | **+39.1 points, z = 3.96, n = 103**, null −1.4, Bonferroni-corrected for 3 tests | **+4.6, z = 0.73, n = 251** — a *larger* sample |
| `stage_plan`'s Stage 2 gate | abstains on 54% of random walks, where `classifyPhase` abstains on 0% | long **33.5% vs a 36.4% baseline**; short **21.2% vs 28.9%**; 4 configurations, none favouring it |

The first is the instructive one. Nothing about the procedure was wrong. The null was measured, not assumed. The correction was applied. The z was 3.96. And the result was a property of that sample, which no amount of in-sample rigour can detect.

**The consequence for this repo:** a noise floor answers *"could this be arithmetic?"* and a trial count answers *"did I get here by searching?"* Neither answers *"does this hold on data I did not look at?"* Only a holdout does, and it is now a standing requirement — a different universe, a disjoint period, or both, before any single-sample finding is quoted as more than provisional.

`scripts/level-test-inversion.js` and `scripts/stage-forward-test.js` are the working templates. Both run four arms: a random walk, an in-sample slice, a fresh universe, and an earlier non-overlapping window.

**A second, duller failure mode worth naming.** Three measurement scripts set the symbol but not the *timeframe*, inherited the chart's 60-minute resolution, and recorded their results as "daily bars". Every number was a real measurement of the wrong thing, and nothing in the output revealed it. `scripts/_real_bars.js` now requires an explicit timeframe and verifies the resolution actually took. A result is only as trustworthy as the provenance recorded next to it.

### 1.4 What *does* replicate: trend and momentum

**[Moskowitz, Ooi & Pedersen (2012), *Journal of Financial Economics*](https://www.sciencedirect.com/science/article/pii/S0304405X11002613)** documented time-series momentum across **58 futures and forwards over 25+ years**: a 12-month lookback with a 1-month holding period was positive and significant **for every single instrument examined**. Composite Sharpe **1.28 vs 0.38** for buy-and-hold on the same universe. The effect persists ~12 months, then partially reverses.

This is a completely different quality of evidence from the pattern literature: large cross-section, every instrument, long sample, simple rule, and it survived publication.

### 1.5 Where a specific, testable setup does have numbers

**[Bulkowski's NR7 page](https://www.thepatternsite.com/nr7.html)** — 1,201 stocks, Jan 1990 to Mar 2013:

| Bull market | Failure rate (5%) | Average move | Measure-rule success | Win rate |
|---|---|---|---|---|
| Up breakout | **46%** | +7% | 43% | 57% |
| Down breakout | 47% | −6% | 37% | 45% |

His own note: *"The failure rates may appear high, but that's typical for short-term patterns like the NR7."*

We flagged an NR7 squeeze on AAPL today. **A 46% failure rate is the number that belongs next to it**, and we did not have it.

The **[volatility contraction pattern](https://trendspider.com/learning-center/volatility-contraction-pattern/)** (Minervini) is the same idea with more structure: successive pullbacks tightening — typically ~18%, then ~12%, then ~6% — on declining volume, with expansion on breakout. **[Weinstein's stage analysis](https://traderlion.com/trading-strategies/stage-analysis/)** gates entries on price above a rising 30-week MA with breakout volume 2× average. Both are *mechanically testable*, which is what makes them worth having — not the track records attached to them.

---

## Part 2 — Methods worth adopting, ranked

### Tier 1 — Statistics. Highest value, no ML required.

**1. Multiple-testing correction on every scan and backtest.**
Implement the **[Deflated Sharpe Ratio](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551)** (Bailey & López de Prado), which adjusts the significance threshold for the number of trials, skewness and kurtosis. Track trial count in `strategy_scan` and `backtest_strategy` and report DSR alongside the raw number.

This is the single biggest gap in the project. `docs/START-HERE.md` already says a backtest without a benchmark flatters itself — a backtest without a trial count flatters itself just as badly, and we don't count trials at all.

**1b. An out-of-sample arm on every finding. BUILT, and it has already killed two.**
A different universe, a disjoint period, or both. See 1.3b — two claims here cleared a measured null *and* a Bonferroni correction and did not replicate. This is not a refinement of the trial count; it tests a different thing. Templates: `scripts/level-test-inversion.js`, `scripts/stage-forward-test.js`.

**2. Purged K-fold with embargo, and Combinatorial Purged CV.**
[Purged cross-validation](https://en.wikipedia.org/wiki/Purged_cross-validation) removes training observations whose labels overlap the test window, plus an embargo after it. Standard k-fold assumes independent observations; financial labels are built over overlapping windows and are not. Required before any parameter fitting.

**3. Triple-barrier labelling.**
Label an event by which of three barriers it hits first — profit target, stop, or time limit. This is how a trade actually ends, and it makes labels comparable to how `draw_trade_plan` defines a position. Fixed-horizon returns do not.

### Tier 2 — Fix the pattern detector properly

**4. Kernel-regression extrema — this fixes the exact bug found on CSCO today.**

Lo/Mamaysky/Wang's algorithm, from the paper:

1. Fit a Nadaraya–Watson kernel regression to a rolling window (they used l=35 + d=3 = **38 trading days**)
2. Find extrema where `Sgn(m'(t)) ≠ Sgn(m'(t+1))` on the **smoothed** curve
3. **Then locate the actual max/min in the ORIGINAL price series within [t−1, t+1]**, and use *those* prices for the pattern test

Step 3 is the part we are missing. Today on CSCO our detector reported `converging: true` from its own fitted boundaries while the real pivots **diverged** (13.87 → 14.08). LMW's method never has that failure mode because the pattern test always reads real prices; smoothing only decides *where to look*.

The `d=3` lag is also worth copying: it guarantees conditional returns are computed strictly out-of-sample.

**5. Adopt the formal E1..E5 definitions.**

| Pattern | Definition (5 consecutive alternating extrema) |
|---|---|
| HS | E1 max; E3 > E1, E3 > E5; E1,E5 within **1.5%** of their average; E2,E4 within 1.5% |
| IHS | mirror image |
| Broadening top | E1 max; **E1 < E3 < E5**; E2 > E4 |
| Triangle top | E1 max; **E1 > E3 > E5**; E2 < E4 |
| Rectangle | tops within **0.75%** of average; bottoms within 0.75%; lowest top > highest bottom |
| Double top | E1 max; E1 and the highest subsequent max within 1.5%; **≥ 22 trading days apart** |

Note that **broadening and triangle are exact mirror inequalities** — that *is* the converging/diverging test, formalised. It is the check I hand-rolled today; adopting the definition makes it structural instead of a manual step.

**6. Settle the bandwidth question with our own harness.**
LMW use **0.3 × h\*** (h\* from cross-validation), calling it *"admittedly ad hoc"*. Nekrasov found 0.3×h\* *"tends to detecting of too local extrema"* and preferred h\*. Nobody has resolved this.

**We are unusually well placed to settle it.** `src/core/synthetic.js` already measures detection rate against constructed truth and false-positive rate against random walks. Sweeping the bandwidth through that harness answers the question empirically, for our data, in an afternoon.

### Tier 3 — ML that is defensible

**7. Meta-labelling — the best architectural fit for this project.**
[López de Prado's technique](https://en.wikipedia.org/wiki/Meta-Labeling) separates *side* from *size*: a primary model calls the direction, a secondary model learns whether to act on it. Our pattern detectors are already the primary model. The secondary model would answer "given a bull flag in this regime, at this RS, at this distance from the 30-week MA — take it or skip it?"

[Hudson & Thames' study](https://hudsonthames.org/does-meta-labeling-add-to-signal-efficacy-triple-barrier-method/) on S&P 500 E-minis reports precision 0.48 → 0.54 and accuracy 48% → 55% on trend following out-of-sample. Their critical caveat: **it needs a good primary model**; against a weak one it can only reduce downside.

**8. Conformal prediction** — [distribution-free calibrated intervals](https://arxiv.org/html/2511.13608v1). Doubly useful here: it puts honest confidence bounds on any forecast, *and* a high nonconformity score works as a regime-shift alarm. Caveat: coverage guarantees rest on exchangeability, which time series violate; use the time-series-adapted variants.

**9. HMM regime detection** — [a natural upgrade path](https://www.mdpi.com/1911-8074/13/12/311) for `market_regime`, which currently uses a single efficiency ratio. An HMM infers regime from observable price/volatility and gives transition probabilities. Treat published Sharpe figures for HMM strategies with the Tier-1 scepticism above.

### Tier 4 — What not to build

**10. LLM trading agents.** The **[2026 survey of agentic trading](https://arxiv.org/html/2605.19337v1)** audited 19 empirical studies:

| Criterion | Studies meeting it |
|---|---|
| Time-consistent data splits | **2 / 19** |
| Explicit transaction-cost model | **1 / 19** |
| Universe / survivorship documented | **1 / 19** |
| Any reproducibility artifacts | **4 / 19** |
| Full reproducibility | **0 / 19** |

And: *no quantified alpha over passive strategies or classical ML is cited with sufficient rigor to support outperformance claims.*

One failure mode named in that survey applies to **me specifically** — the **"Oracle Fallacy"**: an agent retrieving past episodes annotated with post-hoc narratives ("this trade failed because of the next day's news") is leaking future information into its own reasoning. If we ever build a trade-memory for this system, entries must be embargoed until their outcome time has actually passed.

**11. Deep learning on chart images.** A [2026 study](https://onlinelibrary.wiley.com/doi/10.1002/for.70099) found a 4-layer CNN with 422k parameters **outperformed models 10–25× larger**, which overfit severely on ~500 training samples. We have far less data than that per symbol. This is not a promising direction at our scale.

**12. Commercial "AI pattern detection" tools.** The 2026 search results for this are dominated by vendor marketing with no published methodology. One [self-published analysis of 370,000 detections](https://medium.com/@haase.rene/do-chart-patterns-still-work-in-2026-what-370-000-detections-reveal-a13f2938e7aa) claims *"perfect patterns consistently underperform"* — an interesting claim, but not peer reviewed and not independently verified. Noted, not adopted.

---

## Part 3 — Concrete plan for this repo

Ordered by evidence strength × how cheaply we can act.

All ten shipped on 2026-07-27. What follows is what each one turned out to be, including where the plan was wrong.

| # | Change | Where | Status |
|---|---|---|---|
| 1 | Trial count + Deflated Sharpe | `validation.js`, `backtest.js`, `strategy.js` | done |
| 2 | Smoothed extrema mapped to real prices | `kernel.js` | done |
| 3 | NR7 base rates on squeeze calls | `patterns.js` | done |
| 4 | Time-series momentum | `momentum.js` | done |
| 5 | Bandwidth sweep | `scripts/bandwidth-sweep.js` | done — **settled** |
| 6 | Formal E1..E5 definitions | `lmw_patterns.js` | done — **and demoted** |
| 7 | VCP as a testable rule | `vcp.js` | done |
| 8 | Purged CV + embargo | `validation.js` | done |
| 9 | Triple-barrier labelling | `labeling.js` | done |
| 10 | Meta-labelling layer | `metalabel.js` | done |

956 unit tests, all passing. Five MCP tools registered (162 total).

### What measurement changed about the plan

**The multiple-testing hole was worse than argued.** Searching 200 random return series and keeping the best yields an **annualised Sharpe of 2.19** with a probabilistic Sharpe of **0.985**. The deflated Sharpe is **0.267**. Uncorrected, mined noise is indistinguishable from a discovery — that measurement is now a test.

**Item 6 was the plan's biggest error.** I proposed adopting the LMW definitions as a second detector. Measured, they match **37.9% of five-pivot windows drawn from pure random walks** (43.4% as first measured; the P2.7 kernel ordering fix removed same-bar pivot pairs that were inflating the rectangle definitions). Live on the same AAPL bars our detector reports 2 patterns and LMW reports 36. They are not a screen and are now shipped with that number attached and explicitly demoted to a second opinion.

The per-pattern breakdown reverses the intuition. The inequality-chain patterns (triangle, broadening) are the *most* selective at ~2%; **rectangle is the most permissive at 13.6%**, with head-and-shoulders around 9%. Their tolerance terms — 0.75% and 1.5% of an average — are easy to satisfy when pivots happen to cluster.

That casts a shadow on the one result that *did* replicate. **Rectangle was the only pattern to survive Nekrasov's reproduction, and rectangle is the definition that fires most often on noise.** A definition that fires often yields a larger conditional sample and more power in a KS test. Significance without an edge would look exactly like this. I cannot prove that is what happened, but the coincidence is not reassuring.

**The bandwidth question is settled for our data.** Nekrasov's claim that LMW's 0.3×h\* over-detects local extrema is **supported**: 56.7 pivots per 200-bar random walk against 51.7 at the cross-validated bandwidth (post-P2.7 figures; the originally quoted 98.9 vs 73.9 included the collision artefacts the ordering fix removed). Default is 1.0×, parameterised.

**VCP is the most selective thing in the repo** — **zero** detections across 200 random walks, against 64.5% of walks containing a structural pattern. The reason is structural: VCP is a conjunction of six numeric clauses where most chart patterns are one or two. Selectivity is not accuracy, and the module says so.

### The strategic point, revised

Items 1–3 added no capability; they made existing output honest, and that was the right order. Item 4 added the one effect the literature actually supports.

But the sharpest result is not any single module — it is that **our own geometric detector is dramatically more selective than the academic definitions it was going to be corrected by.** The plan assumed the literature would raise our standard. Measured, it lowered it. The value taken from LMW is the *pivot method* — smooth to locate, read the real price — not the pattern rules.

---

## Part 4 — Swing strategies, and the problem they all share

Second research pass, 2026-07-27, focused on named swing-trading strategies with published evidence.

### 4.1 The finding that reframes everything above

**Every effect in this document with respectable evidence was measured across many instruments. None of them is evidence about the one chart in front of you.**

- Time-series momentum: **58 futures**, Sharpe 1.28
- 52-week high: top vs bottom 30% of **all CRSP stocks**
- Post-earnings drift: **decile portfolios** of hundreds of firms
- Lo/Mamaysky/Wang patterns: conditional distributions over **350 stocks**

I had been writing this as prose — "the signal transfers, the Sharpe does not." [Grinold's Fundamental Law of Active Management](https://www.sciencedirect.com/science/article/pii/S0927539817300543) states it as arithmetic:

```
IR = IC × √BR
```

Information ratio = information coefficient (actual skill) × square root of breadth (number of **independent** bets). Rearranged, it gives the number nobody wants to see. `src/core/breadth.js` now computes it:

| Positions | Expected IR | % of published | Years to prove it isn't luck |
|---|---|---|---|
| 1 | 0.168 | 13% | ~136 |
| 5 | 0.376 | 29% | ~28 |
| 10 | 0.532 | 42% | ~14 |
| 20 | 0.752 | 59% | ~7 |
| 58 | 1.280 | 100% | ~3 |

*Momentum's published Sharpe of 1.28, translated to smaller books.*

And a hypothetical IR of 1.0 mined across 500 stocks implies a skill coefficient of **0.045**. On one position that is an expected IR of 0.045 — **4.5% of the headline, and 1,921 years before it is distinguishable from luck.**

This is not an argument against single-name trading. It is an argument against quoting a cross-sectional study at a single chart without doing the division.

### 4.2 The 52-week high — we were already computing it

[George & Hwang (2004), *Journal of Finance*](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.2004.00695.x). The ranking variable is:

```
P(t) / max(price over trailing 12 months)
```

That is **`1 − off_high_pct/100`**. Every chart read in this repo already reports "X% off its high" — that number *is* the George-Hwang signal, and I have been quoting it as neutral context.

Their result: buying the top 30% and selling the bottom 30% returned roughly **twice** Jegadeesh-Titman momentum after controlling for size and bid-ask bounce (**1.23% vs 1.07%** per month ex-January). Crucially, **the profits do not reverse in the long run**, where JT momentum's do.

**The direction is counter-intuitive.** Nearness to the 52-week high predicts *continuation*. The instinct that a stock at its high is "extended" and owed a pullback is the opposite of the measured result. Their proposed mechanism is anchoring: traders treat the 52-week high as a reference point and will not bid through it even when news justifies it, so the information prevails gradually.

Implemented as `fiftyTwoWeekHigh` in `momentum.js`. It reports the raw ratio and **deliberately refuses to assign a percentile** — a percentile needs a cross-section, and one chart has none.

### 4.3 PEAD largely dissolves at the firm level

Post-earnings-announcement drift is one of the most durable anomalies in finance, and it matters here because we check earnings on every symbol. But [Katz, McCubbins & McMullin (2018)](https://jkatz.caltech.edu/documents/28622/peads.pdf) disaggregated it and found the monotonic drift pattern **does not persist at the firm level**:

| Decile | Mean drift | SD | Quarters going the WRONG way |
|---|---|---|---|
| Good news | +3.3% | 3.8% | **16.1% drifted negative** |
| Bad news | −1.9% | 4.5% | **28.0% drifted positive** |

They also found the pattern non-monotonic across SUE percentiles — the *most* negative-surprise portfolio had the *least* negative drift.

So "PEAD says buy after a positive surprise" is a portfolio claim. A single stock after a good print is a draw from a wide distribution, not a prediction. With AAPL reporting in 3 days, that is the honest framing.

### 4.4 Evidence quality, ranked

| Strategy | Evidence | Verdict |
|---|---|---|
| Time-series momentum | 58 instruments, 25+ yrs, peer-reviewed | **Strong** — implemented |
| 52-week high proximity | *Journal of Finance*, all CRSP, no long-run reversal | **Strong** — implemented |
| PEAD | Durable in aggregate; **dissolves at firm level** | Portfolio-only |
| Short-term reversal | Jegadeesh/Lehmann; ~2%/month 1934–87 | Real, but **transaction costs erode it**; needs large caps |
| VCP (Minervini) | Mechanical; no independent audit of the track record | Shape testable — implemented |
| Stage analysis (Weinstein) | Mechanical; **no peer-reviewed validation found** | Testable, unvalidated |
| Donchian / Turtle | Book claims (29–57% CAGR) and vendor blogs only | **Weak** — no trial correction, not adopted |
| Connors RSI(2) | Vendor backtests; 34% max drawdown, no stops, fails in downtrends | **Weak** — not adopted |

The bottom two are instructive: both circulate widely with impressive headline returns and neither has anything resembling a deflated Sharpe or an out-of-sample test behind it. They are exactly what `deflated_sharpe` was built to be sceptical of.

---

## What I could not verify

- The Nature paper *"Stock market trend prediction via chart analysis: practical method or myth?"* sits behind an auth redirect; I have its title and framing only.
- Nekrasov's reproduction is a self-published report, not peer reviewed. Its *conclusion* aligns with Park & Irwin's caveats and the JPM result, which is why I weight it — but it is one author.
- Sharpe figures quoted for HMM strategies come from vendor and blog sources, not journals. Treated as unverified.
- Minervini's and Weinstein's published track records are not independently audited in anything I found. Their *rules* are testable; their results are claims.

## Crabel (1990) — the contraction/expansion principle has no lift over noise

Toby Crabel, *Day Trading with Short Term Price Patterns and Opening Range
Breakout*. A practitioner classic, and the source of NR4 and NR7 — both of
which were already implemented here and match his definitions exactly.

**Half the book is unreachable.** Opening Range Breakout, the title concept,
needs the opening range, which he defines as the first **thirty seconds** of
trade. Chapters 1-4, 17 and 26-32 all hang off it. Daily bars cannot see it.

**The half that is reachable does not survive its own control group.** The book
rests on the Contraction/Expansion Principle: a narrow range precedes a range
expansion. It does — and it does so just as strongly with no market present.

| | Random walk | Real data |
|---|---|---|
| P(next range > this range) | 50.1% | 49.7% |
| P(next range > this range \| NR4) | **80.2%** | **76.4%** |
| **lift** | **+30.0 pts** | **+26.7 pts** |

*200 random walks of 300 bars; 12 large caps, 300 daily bars each.
`node scripts/crabel-noise.js`.*

**Real data shows LESS lift than pure noise.** Daily range is mean-reverting by
arithmetic — a narrow day sits below its own average, so the next is usually
wider — and that accounts for the whole effect. The principle is *true as a
description* and *empty as an edge*: a narrow range really is followed by a
wider one about three quarters of the time, and knowing it tells you nothing a
random number generator would not.

Every pattern in the module fires on **100% of random walks**, several times
each — 2BNR 12.8 per walk, 3DHR 13.3, hooks 4.5. They are the least selective
detectors in this repo; supply/demand zones at 99.5% are more discriminating.

**What was still worth taking.** The multi-bar NR family (2BNR/3BNR/4BNR/8BNR)
measures something NR4 and NR7 cannot see: a market coiling across a week with
no single day unusually quiet. It is implemented, as a *volatility state* with
its noise floor attached — never as a signal.

**And the methodology.** Chapter 3 is an explicit CONTROL GROUP: the
unconditional rate of a move of a given size, against which he insists every
other test be read. That is this repo's noise-floor discipline, arrived at
independently by a practitioner in 1990. He could not have found the result
above — his control is an unconditional market rate, not a randomised one — but
he was asking the right question, which is more than most of the literature
does.


## Gap classification — the null was the problem, and both arms have now been run

`src/core/gaps.js` implements the Edwards & Magee four-way gap classification (common/area, breakaway, runaway/measuring, exhaustion) as numbered clauses, with every threshold cited to [Bulkowski's gap page](https://thepatternsite.com/gaps.html) or explicitly marked `ours` where the source gives words and no number. Deliberately **not** registered as an MCP tool (the `ignition.js` precedent); a test asserts nothing in `src/tools/` imports it.

**The null was the whole problem, and it is the same one that killed `ignition.js`.** A random-walk price path has almost no overnight gaps — `barsFromPath` builds bar *i*'s open from `path[i-1]`, so consecutive bars overlap. Measured: **0.24 gaps per 200-bar walk against 9.05** once gaps are injected. Every class then floors near zero, which reads as a perfect classifier and is a fixture artefact. `randomWalkWithGaps` injects gaps by shifting whole bars, calibrated against the one real-data anchor available — ATR ÷ mean bar range **1.070** on real daily bars (the statistic that broke ignition's null) — which the defaults reproduce at 1.068.

**The real arm ran 2026-07-30** (20 large caps, 299 daily bars each, `scripts/gaps-real-arm.js`), and it came out the healthy way — every class fires AT or ABOVE its null, where ignition fired below:

| class | real (per 200 bars) | null | reading |
|---|---|---|---|
| any gap | 10.13 | 9.05 | real is slightly gappier; ATR/range 1.093 vs anchor 1.070 |
| common | 0.80 (55% of symbols) | 0.79 (46.5% of walks) | **zero information, confirmed** — describes noise and real charts identically |
| runaway | 1.54 (90%) | 1.35 (69.5%) | descriptive |
| breakaway | 0.07 (10%) | 0.01 at the measured multiple | **~7× lift — the one selective class** |
| exhaustion | 0.40 (55%) | 0.10 at the measured multiple | 4× lift once the volume parameter is measured |
| unclassified | 6.86 | 6.24 | the classifier declines to guess 68% of real gaps — in both arms |

**The free parameter was wrong by ~2× and measuring it changed a verdict.** The generator guessed gap-day volume at 2.0× average; the real median across 303 gaps is **1.21**. Re-running the null AT the measured value (same seeds as the published table, which reproduces it exactly) turned exhaustion's 4.5–37.0% bracket into a **floor of 9.5% of walks** — the pattern of `level_pressure`'s lesson in reverse: this time the extra arm strengthened the claim. Still missing: closure-rate validation against Bulkowski's own numbers (breakaway ~1% filled within a week, common ~85–90%), any forward test, and a disjoint universe/period — one sample means PROVISIONAL under the repo's holdout rule.

## Bull-flag template matching — the published threshold cannot tell real charts from noise

`src/core/pip.js` implements the Leigh 10×10 weight-template bull flag (via [Fernandes 2022](https://repositorio-aberto.up.pt/bitstream/10216/146608/2/597048.pdf), corroborated by [Cervelló-Royo et al. 2015](https://doi.org/10.1016/j.eswa.2015.03.017); the [2002 original](https://www.sciencedirect.com/science/article/abs/pii/S0957417402000349) is paywalled and unread, recorded as such), plus PIP downsampling. Also unregistered.

The published threshold is **T = 3 at a 20-day window**. Two arms, same scan:

| threshold | real windows % | noise windows % |
|---|---|---|
| T=3 pip | **17.6** | **17.1** |
| T=3 rank | 10.0 | 6.7 |
| T=5 rank | 0.2 | 0.2 |
| T=7 pip | 0.7 | 0.3 |

**At the published threshold the PIP mapping matches real charts and pure noise at the same rate.** Real charts trend; a bull-flag template firing no more on real data than on noise is the template failing to see what it claims to see — the strongest evidence yet that the 62–104% annualised excess returns those studies report did not come from the template. Every 200-bar walk of pure noise contains at least one T = 3 match (12 under rank, 31 under PIP). Selectivity exists only at thresholds the papers never used (T ≥ 5 rank, T ≥ 7 PIP), and even there the real-over-noise lift is at most ~2× on sub-1% rates. The two mappings disagree on purpose — rank reads only ordering (a 4% and a 40% pullback map identically), PIP scales prices — and the disagreement is the output, in the `lmw_patterns.js` second-opinion sense.

## The pivot backbone moved the noise floors — and exposed a sampling error in one of them

P2.3 consolidated three definitions of "what is a swing" (fractal `findSwings`, the drawer's `windowPivots`, kernel extrema) onto one kernel-validated backbone, `src/core/pivots.js`, calibrated so `lookback: 5` finds the same swing COUNT the fractal did (bandwidth = 0.4 × lookback, measured over 40 walks at two series lengths — `scripts/pivot-calibration.js`). Deliberately not cross-validated: CV picks the bandwidth from the data alone, which would make `lookback` a no-op and silently push the pattern stability sweep to 100%.

Changing the pivot source changed the floors, paired on identical seeds:

| detector | before | after | reading |
|---|---|---|---|
| divergence, 2+ agreeing | 13.5% | **19.5%** | the material move — kernel pivots already alternate, so `alternateSwings` no longer collapses 13% of them; more pairs agree by accident. The filter still removes 4 in 5 |
| Elliott rule-valid | 70.5% | **82%** | same mechanism |
| structural patterns | 68% / 0.78 per walk | 75% / 0.85 (83% / 1.02 with the cup added) | see below |
| zones, Wyckoff, breakouts, channels, LMW, VCP, pennants | — | — | unchanged (none consume `findSwings`) |

**The structural-pattern row carries its own lesson about harness size.** The published 68% reproduced to the digit on a pristine pre-change tree — and at 200 walks instead of 40 it is **58%**, so the published figure was ~10 points high from sampling error alone, and the true backbone effect is ~+3 points (58 → 61). Both are recorded in the source constant. Separately, `patterns.NOISE_BASELINE.per_walk` initially could not be reproduced — and P2.8 resolved it: **the table was three harnesses filed as one** (seven rows from `measure()` at 40 walks with a test wrapper's options, three rectangle rows from `detectPatterns` at DEFAULTS over 200 walks, the cup from `detector-noise.js`), each reproducing TO THE DIGIT at its origin commit. The "roughly half" reading was a cross-harness comparison. Re-measured under ONE harness matching `vsNoise()`'s numerator (`detectPatterns` at `lookback: 5`, 200 walks): ten of eleven rows moved — the worst, `inverse_head_and_shoulders`, was **26× too HIGH** (0.13 → 0.005), the UNflattering direction, calling genuine detections indistinguishable from noise — and ten of twenty-one patterns had NO row at all, so `vsNoise` silently returned null for them. All 21 now measured; the discriminating quantity is `walks_with_pattern_pct`, because every per-walk rate is so low that a single detection clears the 2× bar — flagged as follow-up.

Also measured on the way through: raw `findKernelPivots` emitTED index-inverted adjacent pivot pairs (23 per 200 walks of 300 bars — alternation was enforced on `kind`, never on `index`; 9 genuinely inverted, 14 landing on the SAME bar as both a high and a low). P2.7 fixed it at source — the collapse now enforces ordering too, the earlier pivot surviving an inverted pair, mirroring `enforceInvariants` — and the LMW floor fell **43.4% → 37.9%** of five-pivot windows as a direct result: a same-bar high/low pair reads as an impossibly flat top-and-bottom, exactly what the rectangle definitions' 0.75% tolerance rewards (rectangle_top 13.6 → 8.8). `pivots_kernel` at its default bandwidth finds **28% fewer pivots** and its converging/diverging verdict flips on 32 of 200 walks — the old figures were describing collision artefacts. And kernel pivots near the series end are less settled than the fractal's hard confirmation lag: a pivot ON the final bar is wrong 100% of the time and is dropped; 1–2 bars back revise ~50/43%; 7+ bars back 0% (`PIVOT_EDGE_STABILITY`).

## Cup-with-handle — Bulkowski's rank 3 of 39, and a detector that is honestly NOT selective

`src/core/cup.js` implements the cup as eight numbered clauses (each cited to [cup.html](https://thepatternsite.com/cup.html) or marked `ours` where Bulkowski explicitly declines a number — his rim tolerance is *"use your own judgment"*). The floor: **23.5% of 300-bar random walks carry a qualifying cup, and the floor CLIMBS with series length — 7 / 11 / 23.5 / 35% at 150/200/300/400 bars.** The mechanism is a **trial count inside the detector**: a cup needs a rim *pair*, pairs grow quadratically in pivot highs, and the qualification rate tracks the pair count. Detections on noise are clause-for-clause indistinguishable from real ones. The thresholds were fixed before the sweep and deliberately not retuned — tightening after seeing the null is fitting to the null. It belongs beside `breakout` (32.5%), not VCP/pennants/springs (0%); Bulkowski's rank 3/39 was earned by 913 patterns he selected BY EYE, and the gap between an eye and eight numeric clauses IS the 23.5%. `strategies.json`'s `cup_with_handle` entry (tier C) carries the caveat verbatim so `strategy_check` can never quote the rank without the floor.

## The owner's cycle entry, forward-tested — unpaid at the swing horizon, untested at its own

`scripts/cycle-forward-test.js` (2026-08-02), method identical to the stage-gate test so the two are comparable: triple-barrier 2×/1×/20 bars, direction-matched baselines, the stage test's own 90 symbols in-sample, 55 disjoint names as holdout, and a decision rule stated before the data was seen (beat the owner config by ≥2pp at z ≥ 2.5 in-sample — the bar the 27-way multiplicity demands — then survive the holdout at z ≥ 1.5).

**No configuration passed. The owner's defaults stand.** The owner config's entry: 41 independent events, 37.5% against a 36.5% baseline (+1.0pp, z 0.14) — indistinguishable, and consistent with the repo's sub-21-day rule that continuation setups do not pay at the swing horizon. The sweep's best (spike 2.0/pct 25/fade 0.7) managed z 0.70 in-sample on 19 events; its 29.8pp holdout delta sits on ELEVEN events, which is the sample size the rule exists to distrust. The short arm (base breakdown, the owner's ruling) flipped sign across arms (−8.2 in-sample, +14.4 holdout) — no claim either way. **The system's own weeks-to-months horizon is untestable on ~300 served bars** — untested is a data limit here, not a verdict. The heartbeat corollary (longer base → stronger breakout) read UNDECIDED: the longest-base quartile won most (50% vs 40/30/30) on ten events per bucket, ~15pp of noise each. More history decides it, not more thresholds.
