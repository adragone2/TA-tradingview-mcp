# The literature, paper by paper

25 papers, read 2026-07-27 from a reading list supplied by the user. Every entry states what was tested and what came back, including where it contradicts something this repo already does.

**The one-line summary:** the evidence splits cleanly. *Rule-mining on price* — moving-average crossovers, candlesticks, filter rules — fails every rigorous test. *Cross-sectional signals* — momentum, 52-week high, MA distance, volume shocks, ML on charts — work robustly and are all portfolio results.

---

## 1. Data snooping — the tests that kill most technical findings

### Sullivan, Timmermann & White (1999), *Journal of Finance* 54(5)
[Data-snooping, technical trading rule performance, and the bootstrap](https://onlinelibrary.wiley.com/doi/abs/10.1111/0022-1082.00163)

Expanded Brock/Lakonishok/LeBaron's 26 rules to a full universe and applied White's Reality Check to 100 years of DJIA data. The best rule **did** survive data-snooping correction in the original sample — but **did not** perform in the subsequent 10-year out-of-sample period. On S&P 500 futures, **no evidence** the best rule outperforms once snooping is accounted for.

### Bajgrowicz & Scaillet (2012), *JFE* 106(3) — read in full
[Technical trading revisited](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1095202)

**7,846 rules, DJIA 1897–2011.** Uses False Discovery Rate rather than Reality Check, which is *more* powerful — FDR selects more surviving rules, because Reality Check "by construction [is] unable to select further rules once they find a rule whose performance is due to luck."

Two findings, both decisive:

- **Persistence:** "an investor would never have been able to select ex ante the future best-performing rules."
- **Costs:** period 3 (1939–62) had 75% of rules positive before costs, but **costs below 25bps prevent the vast majority from breaking even**. Period 4 (1962–86): only 44% positive, most needing **<10bps**. Out-of-sample, **5–35bps suffices to offset any performance**.

They also make a methodological point this repo should absorb: **transaction costs must be endogenous to rule selection, not applied afterwards.** "Trading rules that survive the inclusion of transaction costs are often not among those that perform best before costs."

### Park & Irwin (2007), *Journal of Economic Surveys* 21(4)
95 modern studies: 56 positive, 20 negative, 19 mixed — with data snooping, ex-post rule selection and cost estimation flagged throughout, and positives concentrated before the early 1990s.

---

## 2. Moving averages — the headline results were look-ahead bias

### Zakamulin (2018), *International Review of Finance* 18(2)
[Revisiting the profitability of market timing with moving averages](https://onlinelibrary.wiley.com/doi/abs/10.1111/irfi.12132)

Examines Glabadanidis (2015), which reported "extraordinarily good" MA performance, and demonstrates it was **simulating trading with look-ahead bias**. Corrected, MA performance is "only marginally better than buy-and-hold" and **statistically indistinguishable** from it.

### Zakamulin (2015), working paper
Rolling and expanding-window out-of-sample tests with regime-shift checks: **no statistically significant outperformance in the second half of the sample.** MA rules do tend to outperform in bear states.

**Why this matters here:** it is the same failure mode as Radfar's LSTM finding — an impressive headline that dissolves once the simulation stops seeing the future. Our persistence baseline exists for this reason.

---

## 3. Candlesticks — tested twice, negative twice

### Marshall, Young & Rose (2006), *Journal of Banking & Finance* 30
Bootstrap generating random **open, high, low AND close** — the correct null for a pattern defined by relationships among all four, and an advance on methods that could only randomise closes. Result: candlestick strategies **do not have value** for DJIA stocks.

### Marshall, Young & Cahan (2008), *Review of Quantitative Finance and Accounting* 31
The largest 100 Tokyo Stock Exchange stocks, **1975–2004** — the market that invented the technique. No evidence candlesticks add value **in the whole 30-year period, in any of three 10-year sub-periods, or in bull or bear markets.**

**This contradicts a module we ship.** `patterns.js` carries Bulkowski's candlestick reliability figures. Those measure how often a shape is *followed* by a move; these papers test whether *trading* the shape beats a random-OHLC null, and answer no. Both are now attached to every candlestick detection via `CANDLE_ACADEMIC_EVIDENCE`.

---

## 4. Cross-sectional signals that do work

### George & Hwang (2004), *Journal of Finance* 59(5) — read in full
Ranking by `P(t) / trailing-12-month high`. Roughly **twice** Jegadeesh-Titman momentum after size and bid-ask controls (1.23% vs 1.07%/month ex-January), and **profits do not reverse long-run**. Nearness to the high predicts *continuation*. Implemented as `fiftyTwoWeekHigh`.

### Jegadeesh & Titman (1993), *Journal of Finance* 48(1)
Buy 3–12 month winners, sell losers, hold 3–12 months. Strongest at 12-month formation / 3-month holding: **~1.31%/month**. Across all 16 combinations, 0.9–1.3% — **not sensitive to a single parameter choice**, which is what distinguishes it from a mined rule.

### Avramov, Kaplanski & Subrahmanyam (2021), *Review of Financial Economics* 39(2)
**Moving Average Distance** — short MA / long MA. Annualized value-weighted alphas around **9%**; predictability goes **beyond momentum, 52-week highs and profitability**; and payoffs **survive reasonable institutional trading costs**. Stronger long than short. Implemented as `movingAverageDistance`.

Note the tension with §2: the *level* of MAD predicts the cross-section even though MA *crossover timing rules* do not survive testing. Different question, different answer.

### Han, Zhou & Zhu (2016), *JFE* 122(2)
Combines short, intermediate and long MA signals into a trend factor: **more than double** the Sharpe of short-term reversal, momentum and long-term reversal used separately. In the financial crisis it earned **+0.75%/month while momentum lost −3.88%**.

### Gervais, Kaniel & Mingelgrin (2001), *Journal of Finance* 56(3)
**High-volume return premium.** Stocks with unusually high (low) volume over a day or week tend to appreciate (depreciate) over the following month. Mechanism: volume shocks affect *visibility*, and visibility affects demand.

### Kaniel, Li & Starks
International: the premium is present in **almost all developed and emerging equity markets**, and its magnitude tracks proxies for information dissemination and investor recognition — supporting the visibility explanation.

### Neely, Rapach, Tu & Zhou (2014), *Management Science* 60(7)
Technical indicators forecast the **equity risk premium** with in- and out-of-sample power **matching or exceeding macroeconomic variables**. They are complementary over the cycle: technical indicators detect declines near business-cycle *peaks*, macro variables detect rises near *troughs*.

---

## 5. Short-term reversal, and what it actually is

### Jegadeesh (1990), *Journal of Finance* 45(3)
Significant negative first-order serial correlation in monthly returns; significant positive correlation at longer lags. **~2%/month** for the reversal strategy, 1934–87.

### Lehmann (1990), *QJE*
Same effect at weekly horizon. Frames the question as whether predictability reflects changing expected returns or overreaction.

### Nagel (2012), *RFS* 25(7)
Reinterprets short-term reversal returns as **the return to liquidity provision**, and shows it is **highly predictable with VIX** — expected returns and conditional Sharpe ratios rose enormously during the 2007–09 crisis as liquidity supply withdrew.

**The reframing matters:** short-term reversal is not a free anomaly, it is compensation for supplying liquidity when others will not. That is a business with a capital requirement and a tail risk, not a chart pattern.

---

## 6. Machine learning on charts — the surprise

### Jiang, Kelly & Xiu (2023), *Journal of Finance* 78(6)
CNNs trained on **images of price and volume charts**. Rather than testing predefined patterns, they let the model find them. The patterns found **differ significantly from known trend signals**, give **more accurate predictions**, are robust across specifications, are **context-independent** (short-horizon patterns work at longer scales), and **patterns learned on US stocks transfer to international markets**.

### Murray, Xia & Xiao (2024), *JFE* 153
ML forecasts from historical performance **strongly predict the cross-section**. Predictive power holds in most subperiods and is **strong among the largest 500 stocks** — which answers the usual microcap objection. The forecasting function has important **nonlinearities and interactions**, is **stable through time**, and captures effects **distinct from momentum, reversal and existing technical signals**.

**This cuts against what I concluded yesterday.** I had written off chart-image deep learning on the basis of a small-sample overfitting study. At scale, with proper cross-sectional design, two top-tier journals say it works. The distinction is not "images vs numbers" — it is *cross-sectional ranking across thousands of names* versus *timing one chart*.

---

## 7. Volatility management — an unresolved argument

### Moreira & Muir (2017), *Journal of Finance*
Volatility-scaled factors produce **significantly positive alphas** versus unscaled counterparts. Questions the risk-return tradeoff: reduce exposure when volatility is high.

### Cederburg, O'Doherty, Wang & Yan (2020), *JFE*
The implied strategies are **not implementable in real time**, and reasonable out-of-sample versions earn **lower certainty equivalents and Sharpe ratios than the unmanaged portfolios**. Cause: **structural instability in the underlying spanning regressions.**

### Barroso & Detzel (2021), *JFE* 140(3)
Tests whether limits to arbitrage explain the gains. **Contrary to the hypothesis** — volatility managing improves performance only among stocks with **low and medium** limits to arbitrage.

### DeMiguel, Martín-Utrera & Uppal (2024), *Journal of Finance*
A **conditional multifactor** portfolio outperforms its unconditional counterpart out-of-sample **and net of costs**. Factor risk prices generally **decrease with market volatility**.

**Read together:** single-factor volatility scaling does not survive honest out-of-sample implementation; multifactor conditional versions do, more modestly. Our `sizeByVolatility` is closer to the former, and should not claim the latter's support.

---

## 8. Stop-losses — the most actionable result on the list

### Kaminski & Lo (2014), *Journal of Financial Markets* 18 — read in full
[When do stop-loss rules stop losses?](https://dspace.mit.edu/handle/1721.1/114876)

They define the **stopping premium**: the marginal effect of a stop-loss on expected return.

> "If the portfolio follows a random walk the stopping premium is **always negative**… stop-loss rules simply force the portfolio out of higher-yielding assets on occasion, thereby lowering the overall expected return without adding any benefits. In such cases, **stop-loss rules never stop losses**."

Under momentum, the premium "can be positive and is **directly proportional to the magnitude of return persistence**."

Empirically, on stocks-vs-bonds futures 1993–2011, a **monthly-interval** stop raised return 1.5%, cut volatility 5%, and lifted Sharpe by up to 20% — "a remarkable feat for a buy-high/sell-low strategy." But the premium was positive **over longer sampling frequencies**; stops were **"of no value at short-term sampling frequencies."**

**Why this is the most useful paper here:** the condition is a property of the return process, and we already measure it. `stoppingPremium()` in `stops.js` measures serial correlation at several lags and reports which regime the chart is in — so "should I use a stop" becomes a testable question about *this* chart rather than a slogan.

It does **not** say trade without stops. It measures the effect on expected return, not on ruin. A negative stopping premium is a *price*, and bounding a loss is usually worth paying it. The point is knowing what it costs.

### Lo, Mamaysky & Wang (2000), *Journal of Finance* 55(4)
Covered in [research-evidence.md](research-evidence.md) §1.1 — kernel-regression pattern detection, 7/10 patterns significant on NYSE/AMEX, and **Nekrasov's 2010 reproduction on 1995–2010 data failed**.

---

## What this changes

| Finding | Effect on this repo |
|---|---|
| Candlesticks fail two independent tests | `CANDLE_ACADEMIC_EVIDENCE` now attached to every candlestick detection |
| Stopping premium is negative under a random walk | `stops.js` — measures persistence, reports what a stop costs here |
| MAD alphas ~9%, survive costs | `movingAverageDistance` implemented |
| MA *timing rules* were look-ahead bias | Do not add crossover timing rules; the MAD *level* is the signal |
| Costs must be endogenous to selection | Our scans apply costs after the fact — a known, unfixed gap |
| ML on charts works cross-sectionally | Yesterday's dismissal was too broad; corrected |
| Every working signal is cross-sectional | `edge_breadth` does the division |

### The gap I have not closed

Bajgrowicz & Scaillet's methodological point stands against us: **transaction costs must be endogenous to rule selection.** `strategy_scan` selects rules and `trade_cost` applies costs afterwards. That ordering is exactly what they show produces the wrong winners. Fixing it means costing every candidate *before* ranking — noted, not yet built.
