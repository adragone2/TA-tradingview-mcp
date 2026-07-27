# What the evidence says, and what to build next

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

| # | Change | Where | Why |
|---|---|---|---|
| 1 | Track trial count; report Deflated Sharpe | `backtest.js`, `strategy.js` | Untested scans are the exact procedure White's RC invalidates |
| 2 | Map smoothed extrema back to real prices | `patterns.js` | Fixes the CSCO converging/diverging bug structurally |
| 3 | Attach NR7 / flag base rates to squeeze calls | `patterns.js` | We flagged an NR7 on AAPL with no 46%-failure caveat |
| 4 | Add a time-series momentum tool (12m/1m) | new `src/core/momentum.js` | The best-replicated effect in the literature; we don't have it |
| 5 | Bandwidth sweep through the synthetic harness | `synthetic.js` | Settles an open question in the literature with tooling we own |
| 6 | Formal E1..E5 definitions as a second opinion | `patterns.js` | Independent of our geometric heuristics |
| 7 | Implement VCP as a testable rule | `rules.json` | Mechanical, and it matched the AAPL squeeze |
| 8 | Purged CV + embargo | wherever fitting happens | Prerequisite for any of Tier 3 |
| 9 | Triple-barrier labelling | `backtest.js` | Makes labels match how trades actually exit |
| 10 | Meta-labelling layer | new | Highest ceiling, but needs 1–3 and 8 first |

**The strategic point.** Items 1–3 do not add capability; they make existing output honest. Item 4 adds the one thing the literature actually supports and we lack. Everything in Tier 3 is downstream of 1–3 and 8 — building a meta-labelling model on top of uncorrected, leakage-prone backtests would produce a confident wrong answer faster.

## What I could not verify

- The Nature paper *"Stock market trend prediction via chart analysis: practical method or myth?"* sits behind an auth redirect; I have its title and framing only.
- Nekrasov's reproduction is a self-published report, not peer reviewed. Its *conclusion* aligns with Park & Irwin's caveats and the JPM result, which is why I weight it — but it is one author.
- Sharpe figures quoted for HMM strategies come from vendor and blog sources, not journals. Treated as unverified.
- Minervini's and Weinstein's published track records are not independently audited in anything I found. Their *rules* are testable; their results are claims.
