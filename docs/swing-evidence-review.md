# Swing Trading: An Evidence Review

**Author: the repository owner (Angelo Dragone), 2026-07-27.** Produced as an independent research pass in parallel with my own. Reproduced here in full because it is the authoritative statement of what this project believes about the evidence, and because it identified a structural problem — §1, the horizon problem — that my own two research passes missed entirely.

Where it and my findings differ, this document wins. My complementary material is in [research-evidence.md](research-evidence.md) and [literature.md](literature.md).

---

### Strategies, techniques, and technical analysis at the two-to-twenty-day horizon

## Scope and premise

This review covers systematic trading at holding periods of roughly two to twenty trading days in liquid equities — the window conventionally called "swing trading." It excludes intraday work, where the microstructure literature is a separate discipline, and excludes horizons beyond a quarter, where the standard factor literature already applies.

The review is organised around a single question: which of the strategies, indicators and techniques that populate the swing-trading canon survive rigorous testing, and which do not. The answer is uncomfortable for the canon. A minority of the practitioner toolkit has credible empirical support; a substantial part has been tested and found null; and a further part is specified in a way that cannot be tested at all. But the surviving minority is real, economically motivated, and in several cases survives realistic transaction costs — which is a stronger conclusion than a strict efficient-markets reading would allow.

Two framing observations before the evidence.

First, the field's own summary statistics should induce caution rather than confidence. Park and Irwin's survey in the *Journal of Economic Surveys* found that among 95 modern studies of technical trading, 56 reported positive results, 20 negative and 19 mixed — while noting that most are compromised by data snooping, ex-post rule selection, and inadequate treatment of risk and transaction costs. A 59% positive rate, in a literature with a publication bias toward positive findings and acknowledged methodological defects, is roughly what one would expect from a field with no edge at all. Individual positive studies therefore carry very little weight; replication, cost-survival and mechanism carry nearly all of it.

Second, and more importantly, the swing horizon has a structural problem that most strategy design ignores.

---

## 1. The horizon problem

Below roughly one month, the dominant documented cross-sectional regularity in equities is **reversal**: stocks that fell over the prior days and weeks tend to outperform, and vice versa (Jegadeesh 1990; Lehmann 1990). Above roughly three months and out to twelve, the dominant regularity is **continuation** (Jegadeesh and Titman 1993).

The standard momentum construction skips the most recent month deliberately. That skip is not a technical nicety — it is an explicit acknowledgment that continuation and reversal are separated by a horizon boundary, and that the boundary falls *inside* the window swing traders operate in.

This has a direct consequence for strategy design. Breakout systems, moving-average reclaim systems, and momentum-continuation systems are all placing a continuation bet at the horizon where continuation is weakest, and where the opposing effect is strongest. Mean-reversion systems — oversold bounces, pullback entries, fading extended moves — are placing a reversal bet at the horizon where reversal is actually documented.

This does not mean continuation at swing horizon is impossible; several of the Tier A results below are continuation-flavoured. It means the prior on a continuation setup at ten days should be materially lower than the prior on the same logic at six months, and that most swing systems weight the two families as though the priors were equal. They are not.

---

## 2. What survives: Tier A

These findings replicate across samples and markets, survive realistic transaction costs, and have an economic mechanism rather than only a fitted statistic.

### 2.1 Short-term reversal as compensation for liquidity provision

Nagel (*Review of Financial Studies* 2012) reinterprets short-horizon reversal strategies as a proxy for the return earned by supplying liquidity: the strategy buys what the public is selling and sells what the public is buying, which is what a market maker does. The empirical payoff of this reframing is large. He shows the expected return from liquidity provision is strongly time-varying and highly predictable from the VIX index, with expected returns and conditional Sharpe ratios rising sharply during market turmoil. Reversal portfolios formed from industry indices — which earn essentially nothing unconditionally — become profitable when VIX is high.

The mechanism is intermediary constraint: liquidity suppliers withdraw during stress, and the price of the liquidity they still provide rises accordingly.

This is arguably the single most useful result in the entire swing literature, because it converts a static strategy into a conditional one and supplies the conditioning variable. It says the expected return of a mean-reversion swing strategy is not a constant to be estimated once, but a function of the volatility environment. Backtests that report an unconditional average for a reversal system are averaging over two regimes in which the strategy has very different economics.

**The cost caveat and its resolution.** Reversal profits are notoriously fragile to transaction costs, and several studies have concluded they vanish once costs are applied. De Groot, Huij and Zhou (*Journal of Banking & Finance* 2012) trace that conclusion to excessive trading in small caps. Restricting the universe to large caps materially reduces cost drag; adding a hysteresis rule to portfolio construction — not selling a stock the moment it ceases to be a loser, but waiting until it ranks in the top half on past returns — more than halves turnover and trading costs. Their net figures are 30 to 50 basis points per week after costs in large-cap universes.

That hysteresis trick generalises well beyond reversal strategies, and is one of the few genuinely transferable pieces of portfolio-construction craft in this literature. Most swing systems exit on the negation of the entry condition, which is the maximum-turnover choice available.

### 2.2 Moving Average Distance

Avramov, Kaplanski and Subrahmanyam (*Review of Financial Economics* 2021) show that the normalised distance between a short-run (21-day) and long-run (200-day) moving average predicts the cross-section of equity returns, with value-weighted hedge-portfolio alphas around 9% annualised.

Four properties make this the strongest single "technical" cross-sectional signal in the review. The predictability is incremental to momentum, to the 52-week-high effect, to profitability and to other prominent anomalies. It survives trading costs at institutional levels. It is stronger on the long side than the short side, which matters enormously for anyone who cannot short cheaply. And the effect remained economically meaningful in recent years, in a period when standard momentum did not — indeed, standard momentum's factor return is insignificant in the presence of a moving-average-distance factor.

The proposed mechanism is anchoring: investors anchor on long-run moving averages and adjust insufficiently.

The construction matters. This is a cross-sectional decile sort on a normalised distance, rebalanced monthly. It is not a crossover trigger, and it is not a same-day entry signal. The signal is a *state*, not an *event*.

### 2.3 The trend factor

Han, Zhou and Zhu (*Journal of Financial Economics* 2016) build a factor from normalised moving averages across many lag lengths, but the methodological contribution is how they combine them: monthly cross-sectional regressions of returns on the normalised moving-average signals, with the time series of estimated coefficients used to construct the forecast. Weights are learned from the data each period rather than assigned by hand.

The reported results are strong — roughly 1.63% per month, a t-statistic near 13.6 against 6.04 for momentum, and more than double the Sharpe ratios of short-term reversal, momentum and long-term reversal taken individually. It performed positively during the 2008–09 crisis, when momentum lost heavily. It replicates in the G7. Most tellingly for robustness, results are remarkably insensitive to which specific lags are chosen.

That insensitivity is the finding to internalise. If results barely change when the lag set changes, then the effort practitioners pour into selecting *the* right moving-average lengths is effort spent on the dimension where the signal is least sensitive — and where overfitting is most likely to be mistaken for skill. The information is in the joint configuration of the moving-average structure, not in a magic lookback.

### 2.4 Post-earnings announcement drift

PEAD is the best-documented genuinely swing-horizon effect in equities. First observed by Ball and Brown (1968) and sharpened by Bernard and Thomas (1989, 1990), it describes the tendency of prices to continue drifting in the direction of an earnings surprise for weeks after the announcement — with a substantial portion of the drift occurring over the subsequent 60 to 90 trading days. It has been replicated across dozens of studies and multiple markets.

Three qualifications are essential and are usually omitted from practitioner treatments.

**The magnitude has declined.** The spread between high- and low-surprise portfolios fell from roughly 5% in the 1980s and 1990s to 3% or lower by the late 2010s, and several studies find it has attenuated to the point of insignificance in some specifications (Chordia et al. 2014; Martineau 2019; Richardson et al. 2010). Proposed causes include increased arbitrage activity, improved information environments, and greater sophistication in processing earnings news. Recent work typically restricts attention to a single quarter rather than the multi-quarter windows of the original studies.

**It concentrates where it is hardest to trade.** PEAD is consistently stronger in firms with wider bid-ask spreads, lower prices and volume, lower institutional ownership, less analyst coverage and higher idiosyncratic volatility. It is, in other words, a limits-to-arbitrage phenomenon: the drift persists precisely where the cost of removing it is highest. For large firms the effect appears to be small to non-existent. Ng, Rusticus and Verdi (*Journal of Accounting Research* 2008) find transaction costs substantially reduce but do not eliminate the profits.

**Amplifiers exist but compound the trading problem.** The drift is stronger when revenue surprises confirm the earnings surprise, and stronger for value than for glamour stocks. But every documented amplifier pushes further toward the illiquid end of the universe.

The practical reading: PEAD is real, is genuinely swing-horizon, and is the natural anchor for an event-driven swing programme — but the version that is easy to trade is the version that has largely been arbitraged away, and the version that still pays is the version that costs the most to trade. This tension is the strategy, not a footnote to it.

### 2.5 The high-volume return premium

Gervais, Kaniel and Mingelgrin (*Journal of Finance* 2001) find that stocks experiencing unusually high trading volume over a day or a week tend to appreciate over the following month, and stocks with unusually low volume tend to depreciate. Their proposed mechanism is visibility: a shock to trading activity raises a stock's salience, which raises subsequent demand — Merton's (1987) investor recognition hypothesis. They rule out return autocorrelation, firm announcements, market risk and liquidity as explanations.

It replicates across developed and emerging markets, and the cross-country variation in its magnitude tracks proxies for the importance of visibility, which is unusually good corroboration for a behavioural mechanism.

This is the closest thing in the academic literature to a validation of the practitioner obsession with relative volume. But note carefully what was tested: a cross-sectional sort on abnormal volume, held for roughly a month. That is not the same object as a volume-confirmation filter attached to a same-day breakout entry, and there is no basis for assuming the effect size transfers across that gap.

### 2.6 Technical indicators as macro complements

Neely, Rapach, Tu and Zhou (*Management Science* 2014) compare technical indicators against macroeconomic variables for forecasting the US equity risk premium. Technical indicators show statistically and economically significant in-sample and out-of-sample predictive power, matching or exceeding the macro variables.

The genuinely useful finding is the complementarity: technical indicators better detect the decline in the risk premium near business-cycle peaks, while macro variables better detect the rise near troughs, and combining the two significantly improves forecasts over either alone.

For a swing programme this argues against treating technical and fundamental market-state assessment as competing views to be reconciled. They are differently-timed instruments, and the correct relative weight varies with cycle phase — technical information deserves its highest weight near peaks, which is also when it is psychologically hardest to act on.

---

## 3. Tier B: real but fragile, conditional, or commonly misapplied

### 3.1 Nearness to the 52-week high

George and Hwang (*Journal of Finance* 2004) show that a stock's proximity to its 52-week high explains a large share of standard momentum profits, and propose anchoring-and-adjustment as the mechanism: the 52-week high is highly visible and readily available in financial media, so investors treat it as a reference point and underreact to news that would push price past it.

It replicates internationally — in one twenty-market study, eighteen markets showed positive profits and ten were statistically significant, with monthly returns from 0.60% to 0.94% against 0.45% in the US original. It is not explained by standard risk factors, and institutional investors appear less subject to the bias than retail.

Three qualifications hold it out of Tier A. Liquidity conditioning is severe: Australian evidence finds significantly positive raw returns concentrated in liquid stocks and significantly *negative* returns among illiquid ones, with no surviving dollar profits once short-sale restrictions and costs are imposed. Later work by George, Hwang and Li (2018) shows the strategy is priced by the investment CAPM, which sits awkwardly with a purely behavioural reading. And industry-level work suggests the effect is driven mainly by underreaction to industry rather than firm-specific information, which changes what a correct implementation looks like.

Note also the distinction from breakout trading, which is routinely blurred. This is a *level* signal — a ratio of current price to the 52-week high, sorted cross-sectionally. It is not a signal about the moment a stock crosses a prior high, and evidence for the former is not evidence for the latter.

### 3.2 Volatility scaling and risk-managed momentum

Barroso and Santa-Clara (*JFE* 2015) showed that momentum's risk is highly variable and predictable from its own realised variance, and that scaling exposure by the inverse of trailing six-month realised volatility roughly doubles the Sharpe ratio (0.97 against 0.53) while substantially reducing skewness and kurtosis. Daniel and Moskowitz (*JFE* 2016) improved on this with a dynamic strategy scaling exposure so that conditional volatility is proportional to conditional Sharpe ratio, and demonstrated that the alternative of hedging time-varying market beta is not implementable because it requires forward-looking betas.

Moreira and Muir (2017) extended volatility management to a broad set of equity factors and reported significant alphas in spanning regressions.

Then the correction arrived. Cederburg, O'Doherty, Wang and Yan (*JFE* 2020), using 103 equity strategies, showed that volatility-managed portfolios do not systematically outperform their unmanaged counterparts in direct comparison; that the trading strategies implied by the spanning regressions are not implementable in real time; that reasonable out-of-sample versions earn *lower* certainty-equivalent returns and Sharpe ratios than the originals; and that the failure traces to structural instability in the underlying regressions. Barroso and Detzel showed costs erode the gains for every factor except the market. DeMiguel, Martín-Utrera and Uppal (*Journal of Finance* 2024) recover out-of-sample, net-of-cost gains, but only with a conditional *multifactor* construction, not with naive inverse-volatility scaling.

The distilled lesson, which applies far beyond volatility management: **a spanning-regression alpha is not a real-time gain.** Many results that look like risk-management improvements are artefacts of estimating a scaling constant on the full sample. The crash-mitigation finding for momentum specifically appears more robust than the general volatility-management claim — conditional volatility targeting that reduces exposure only in extreme volatility states has been found to cut drawdowns and turnover simultaneously — but the general-purpose "scale size by inverse volatility" overlay is exactly the form that failed out of sample.

### 3.3 Stop-loss rules

Kaminski and Lo (*Journal of Financial Markets* 2014) provide the analytical framework that most stop-loss debate lacks. Their central results:

Under the random walk hypothesis, simple threshold stop-loss rules **always decrease** expected return. There is no version of a stop that is free.

The "stopping premium" becomes positive only when returns exhibit positive serial correlation, and its magnitude is directly proportional to the degree of persistence. It can also be positive under regime-switching processes that produce periodic flights to quality.

Empirically, stops add value at longer sampling frequencies and not at short ones. In their equity application, certain policies added 50 to 100 basis points per month during stopped-out periods.

The implication for swing trading is sharp and rarely stated: the value of a stop is entirely a function of the return process of the specific thing being stopped. A stop applied to a strategy whose entries contain genuine momentum earns a premium. A stop applied to a strategy whose entries are close to a random walk — which describes most breakout entries once costs and slippage are honestly modelled — is a pure drag on expected return, dressed as prudence. A high whipsaw rate that proves invariant to stop placement is not a tuning problem; it is evidence that the entries lack the persistence that would make any stop pay.

This does not argue against stops for risk-control purposes. It argues against the belief that they are expected-return-neutral, and against tuning stop distance as a route to improving a system whose entries are the actual problem.

---

## 4. Tier C: null, dead, or non-falsifiable

### 4.1 Candlestick patterns

Marshall, Young and Rose (*Journal of Banking & Finance* 2006) conducted what they describe as the first robust study of candlestick charting, using a bootstrap extension that generates random open, high, low and close prices jointly — the correct null for a technique defined on the relationship between those four prices. They found candlestick strategies have no value for Dow Jones Industrial Average stocks. Marshall, Young and Cahan (2008) reached the same conclusion on the Tokyo Stock Exchange. Horton (2009) found no value in stars, crows or doji across S&P 500 names.

Contradicting positive results exist — Taiwan, Thailand, and other smaller markets. They are concentrated in venues with weaker cost treatment, and, critically, they flip on the exit convention: the same patterns are profitable under a Caginalp–Laurent holding rule and unprofitable under a Marshall–Young–Rose rule. When a result depends on the exit convention rather than the pattern, the result is about the exit convention.

**Verdict: null in liquid developed markets under a correct null hypothesis.**

### 4.2 The gap taxonomy

The practitioner scheme classifying gaps as *common*, *breakaway*, *runaway/continuation* and *exhaustion* has essentially no peer-reviewed support. Searching the literature for it returns vendor and educational content almost exclusively.

More fundamentally, it fails on definition before any data is consulted. A gap is classified as "exhaustion" because the move subsequently reversed, and as "runaway" because it subsequently continued. The classification is an ex-post relabelling of the outcome, presented as an ex-ante signal. It is not a weak hypothesis; it is not a hypothesis.

The credible academic content in the vicinity of gap trading is PEAD (section 2.4) and the high-volume return premium (section 2.5) — both of which say something testable about what follows a volume-and-news shock, without pretending the shock can be pre-classified by its own outcome.

**Verdict: non-falsifiable as specified.**

[playbook.md](playbook.md) previously listed gap classification as a capability to build, which contradicted this section for as long as both existed. That row now defers here. If the taxonomy is ever revisited it needs a definition that can be applied AT the gap, using only information available then — which is a different scheme, not this one.

What a gap does still carry is *risk*, and that is measurable: `gap_risk` for the overnight jump past a stop, and `luld_band` for the intraday equivalent, where a halt fills a stop at the resumption auction rather than at its price.

### 4.3 Moving-average market timing as a standalone strategy

Zakamulin (*International Review of Finance* 2018) demonstrated that a widely-cited and widely-downloaded paper reporting extraordinary moving-average timing performance had achieved it through look-ahead bias in the simulation, and that once corrected the strategy's performance is at best marginally better than buy-and-hold and statistically indistinguishable from it. His broader work, using a 155-year dataset, finds no single optimal lookback period in any trading rule and pervasive instability across regimes.

Bajgrowicz and Scaillet (*JFE* 2012) applied false-discovery-rate control — more powerful than the earlier bootstrap reality check because it identifies multiple surviving rules rather than only the single best — to daily DJIA data from 1897 to 2011. Two findings: persistence tests show an investor could never have selected the future best-performing rules ex ante; and even in-sample performance is completely offset by the introduction of low transaction costs. Rules that pass the statistical screen do so by trading too frequently to be viable.

Sullivan, Timmermann and White (*Journal of Finance* 1999) reached compatible conclusions via White's reality check.

Note that this is *not* in tension with the Tier A trend-factor result. Han, Zhou and Zhu do not time the market with a crossover rule; they use moving-average information as a cross-sectional predictor with learned weights. The distinction between "moving averages contain information" (supported) and "moving-average crossover rules generate tradable timing profits" (not supported) is the whole story.

**Verdict: dead as a standalone timing rule; alive as a feature within a learned cross-sectional model.**

### 4.4 Chart patterns via automated recognition

Lo, Mamaysky and Wang (*Journal of Finance* 2000) is the paper most often cited to vindicate charting, and it says less than it is credited with. They built an automated pattern recogniser using nonparametric kernel regression — a genuine methodological advance, since it removes the subjectivity that made charting untestable — and applied it to US stocks from 1962 to 1996. Their finding: conditioning on detected patterns shifts the empirical return distribution relative to the unconditional distribution, so several patterns provide *incremental information* and may have practical value, especially among Nasdaq stocks.

Incremental information is not tradable excess return. Subsequent work applying their algorithm with practitioner-informed filters found risk-adjusted excess returns of 5–7% per year conditional on head-and-shoulders patterns, but explicitly little or no support for the profitability of a standalone trading strategy built on them.

**Verdict: informative but not demonstrated tradable. The gap between those two claims is where most retail charting systems live.**

### 4.5 Anchored VWAP, volume profile, and the wider indicator canon

No peer-reviewed validation of anchored VWAP or volume-profile constructs as predictive signals appears in this literature. VWAP's established role is as an *execution benchmark*, not a forecast.

The broader oscillator family — RSI, stochastics, Williams %R, MACD, Money Flow Index — is in a similar position. These indicators appear constantly in the applied literature as *filters* layered on top of another signal, and rarely as standalone strategies with independent validation surviving data-snooping correction. That is a meaningful asymmetry. It is worth noting that position-within-recent-range, which is what a stochastic oscillator or Williams %R measures, does appear as a feature that machine-learned models rely on (see section 5) — so the underlying quantity is not noise. What lacks support is the specific threshold-and-crossover rules built on top of it.

---

## 5. The machine-learning turn

Two independent results in top-three journals within the last three years converge on the same conclusion, and they reframe the entire debate.

Jiang, Kelly and Xiu (*Journal of Finance* 2023) render OHLC bars, volume bars and a moving-average line as images and train convolutional neural networks to predict forward return direction. Their headline results: the learned patterns differ significantly from commonly analysed trend signals; they yield more accurate return predictions and more profitable strategies than momentum, reversal or moving-average signals; and they are robust across specifications. The most striking finding is context independence — patterns learned on short time scales perform well on longer ones, and patterns learned on US stocks prove effective in international markets. Reported Sharpe ratios reach 2.4 for equal-weighted portfolios. Their interpretability analysis, which approximates the network linearly, surfaces where a stock closes within its recent high–low range as one of the quantities the model relies on.

Murray, Xia and Xiao (*Journal of Financial Economics* 2024) arrive at the same destination independently, using machine learning to forecast returns from historical performance. Their forecasts strongly predict the cross-section; the predictive power holds in most subperiods; the forecasting function contains important nonlinearities and interactions, is remarkably stable through time, and captures effects distinct from momentum, reversal and existing technical signals. Crucially for practical relevance, the effect is strong among the **largest 500 stocks** — where cost drag is lowest and where most of the anomaly literature has decayed.

The joint reading is a genuine update. There *is* exploitable structure in price and volume history at these horizons — the efficient-market null is rejected — but hand-specified rules are not how to extract it. The information charting practitioners believe they see is partly real; the specific geometric vocabulary they use to describe it is not how the information is encoded.

Three caveats keep this from being a free lunch. The headline Sharpe figures are equal-weighted and pre-cost, which tilts toward small caps and high turnover; the large-cap results are the credible ones to target. Both approaches require survivorship-clean cross-sectional panel data with correct point-in-time construction, which is a far higher data bar than running indicators on a price series. And both require validation machinery — purged cross-validation, deflated performance statistics — without which the flexibility that makes these models powerful makes them dangerous.

---

## 6. Costs and turnover: the decisive constraint

The single most reliable predictor of whether a swing strategy survives contact with reality is turnover, and cost modelling is where most retail and semi-professional work fails.

Bajgrowicz and Scaillet's central finding bears repeating in its exact form: rules selected before costs trade too frequently, and their performance is wiped out by the inclusion of those costs. The failure is not statistical — the rules genuinely outperform on gross returns — it is economic.

Three techniques from the literature materially change the cost picture:

**Universe restriction.** De Groot, Huij and Zhou's demonstration that reversal profits survive in large caps but not in small ones is the cleanest example. Cost drag is not uniformly distributed across a universe; a strategy that looks marginal on average is often profitable in its top liquidity tercile and heavily loss-making below.

**Hysteresis in exit rules.** Not exiting when the entry condition is negated, but waiting until the security has crossed to the opposite half of the ranking, more than halved turnover and costs in their study while *increasing* net returns. This is close to free, and almost no discretionary swing system does it.

**Honest slippage between signal and fill.** Zakamulin's work documents systematically adverse price slippage arising from the delay between a close-based signal and the actual execution. For any system generating signals on the close and executing at or after the next open, this delay term is a real, negative, and estimable component of return — not a rounding error to be assumed away.

A corollary worth stating plainly: cost sensitivity scales roughly with the inverse of holding period. At a five-day holding period a strategy trades roughly fifty times a year; a 20-basis-point round-trip cost consumes 10% annually. Very few of the effects surveyed here are large enough to absorb that.

---

## 7. How to test a swing strategy honestly

The methodological failures that dominate this literature are consistent enough to enumerate, and each has a known remedy.

**Labelling.** A swing signal typically specifies an entry, a stop and a target — which is a triple-barrier problem in the sense of López de Prado's framework: the label is determined by which of three barriers (profit target, stop, time expiry) is touched first. Adopting this labelling explicitly, rather than evaluating fixed-horizon returns, aligns the evaluation with what the strategy actually does. Systems that emit entry/stop/target levels but never record which barrier was hit are discarding their own training data on every scan.

**Overlapping labels.** Swing labels overlap in time, which violates the independence assumption underlying standard statistical tests and standard cross-validation. Sample-uniqueness weighting and sequential bootstrap are the established corrections.

**Cross-validation.** Standard k-fold cross-validation leaks information across the fold boundary when labels span multiple bars. Purging (removing training observations whose labels overlap the test set) and embargoing (excluding a buffer after the test set) are required; combinatorial purged cross-validation extends this to generate multiple backtest paths rather than a single one.

**Multiple-testing correction.** This is the field's defining failure. The correct posture is to maintain a global count of trials — every variant, every parameter sweep, every discarded configuration — and deflate performance statistics accordingly. The Probabilistic and Deflated Sharpe Ratios do this directly; false-discovery-rate control, as Bajgrowicz and Scaillet used it, is the alternative and has the advantage of identifying multiple surviving rules rather than only the best. The Probability of Backtest Overfitting functions as a hard rejection gate rather than a metric to be optimised.

**Persistence testing.** Bajgrowicz and Scaillet's most damning result is not that rules fail statistically, but that the *identity* of the winning rule does not persist. A strategy-selection procedure should be tested, not just a strategy: if the rule that was best in period *t* is uninformative about the rule that will be best in period *t+1*, then the whole selection apparatus is noise regardless of how good the in-sample winner looks.

**Look-ahead audit.** Zakamulin's correction of the moving-average timing literature came down to look-ahead bias in the simulation, not to any subtlety of inference. Moreira and Muir's scaling constant, estimated on the full sample, is the same failure in a different costume. Before any statistical work, the question is which quantities the simulation uses that a real-time trader would not have possessed.

A useful ordering principle: provenance and construction audits sit *upstream* of all quantitative validation. Survivorship bias, point-in-time errors and look-ahead contamination live in the input layer, and no downstream statistic — however deflated — can detect them, because they corrupt the data the statistic runs on. Sub-period performance decay is the observable fingerprint, and it is a weak one.

---

## 8. Synthesis: what a defensible swing programme looks like

Pulling the surviving evidence together, a swing programme with a plausible claim to an edge would have the following properties.

**It would be conditional rather than static.** The strongest single result here — Nagel's — says the payoff to mean reversion varies enormously with the volatility environment. The second strongest cross-cutting result — Neely et al. — says technical information's weight relative to macro information varies with cycle phase. A system that applies constant logic across regimes is averaging over states in which it has different economics, and the average is not a description of any of them.

**It would separate state signals from event signals.** Moving-average distance, nearness to the 52-week high, and abnormal-volume rank are cross-sectional *state* variables validated at roughly monthly horizons. Earnings surprises are genuine *events*. Most swing systems collapse these into a single same-day entry score, which discards the horizon at which each was actually tested.

**It would learn its weights rather than assign them.** Han, Zhou and Zhu's insensitivity to lag selection, and Murray et al.'s finding of important nonlinearities and interactions, both point the same direction: the value is in the combination, and hand-assigned weights are where discretionary overfitting enters. Any system whose behaviour is governed by a hand-tuned weight dictionary should be able to demonstrate that those weights beat learned ones.

**It would be restricted to a liquid universe and would model costs first.** Not as a haircut applied to a finished backtest, but as a design constraint that determines universe, turnover and exit logic before any signal work begins.

**It would treat stops as risk control, not as alpha.** Kaminski and Lo establish that the expected-return contribution of a stop is negative unless the underlying process has persistence. Stops belong in a swing programme for drawdown and position-sizing reasons; they do not belong in the return-improvement argument unless the persistence has been demonstrated.

**It would maintain an outcome ledger from day one.** Every emitted signal, its barriers, and its realised resolution. Without this there is no dataset, no calibration, no honest performance record, and no possibility of the persistence testing that separates a strategy from a lucky rule.

**And it would treat dismissal as a successful outcome.** The base rate in this field is that most candidate signals do not work. A research process that rarely kills anything is not finding edges; it is failing to test.

---

## Bibliography

Avramov, D., Kaplanski, G., Subrahmanyam, A. (2021). Moving average distance as a predictor of equity returns. *Review of Financial Economics* 39(2), 127–145.

Bajgrowicz, P., Scaillet, O. (2012). Technical trading revisited: false discoveries, persistence tests, and transaction costs. *Journal of Financial Economics* 106(3), 473–491.

Ball, R., Brown, P. (1968). An empirical evaluation of accounting income numbers. *Journal of Accounting Research* 6(2), 159–178.

Barroso, P., Santa-Clara, P. (2015). Momentum has its moments. *Journal of Financial Economics* 116(1), 111–120.

Bernard, V., Thomas, J. (1989). Post-earnings-announcement drift: delayed price response or risk premium? *Journal of Accounting Research* 27, 1–36.

Bernard, V., Thomas, J. (1990). Evidence that stock prices do not fully reflect the implications of current earnings for future earnings. *Journal of Accounting and Economics* 13(4), 305–340.

Cederburg, S., O'Doherty, M., Wang, F., Yan, X. (2020). On the performance of volatility-managed portfolios. *Journal of Financial Economics* 138(1), 95–117.

Chordia, T., Subrahmanyam, A., Tong, Q. (2014). Have capital market anomalies attenuated in the recent era of high liquidity and trading activity? *Journal of Accounting and Economics* 58(1), 41–58.

Daniel, K., Moskowitz, T. (2016). Momentum crashes. *Journal of Financial Economics* 122(2), 221–247.

de Groot, W., Huij, J., Zhou, W. (2012). Another look at trading costs and short-term reversal profits. *Journal of Banking & Finance* 36(2), 371–382.

DeMiguel, V., Martín-Utrera, A., Uppal, R. (2024). A multifactor perspective on volatility-managed portfolios. *Journal of Finance*.

George, T., Hwang, C.-Y. (2004). The 52-week high and momentum investing. *Journal of Finance* 59(5), 2145–2176.

Gervais, S., Kaniel, R., Mingelgrin, D. (2001). The high-volume return premium. *Journal of Finance* 56(3), 877–919.

Han, Y., Zhou, G., Zhu, Y. (2016). A trend factor: any economic gains from using information over investment horizons? *Journal of Financial Economics* 122(2), 352–375.

Horton, M. (2009). Stars, crows, and doji: the use of candlesticks in stock selection. *Quarterly Review of Economics and Finance* 49(2), 283–294.

Jegadeesh, N. (1990). Evidence of predictable behavior of security returns. *Journal of Finance* 45(3), 881–898.

Jegadeesh, N., Titman, S. (1993). Returns to buying winners and selling losers: implications for stock market efficiency. *Journal of Finance* 48(1), 65–91.

Jiang, J., Kelly, B., Xiu, D. (2023). (Re-)Imag(in)ing price trends. *Journal of Finance* 78(6), 3193–3249.

Kaminski, K., Lo, A. (2014). When do stop-loss rules stop losses? *Journal of Financial Markets* 18, 234–254.

Kaniel, R., Ozoguz, A., Starks, L. (2012). The high volume return premium: cross-country evidence. *Journal of Financial Economics* 103(2), 255–279.

Lehmann, B. (1990). Fads, martingales, and market efficiency. *Quarterly Journal of Economics* 105(1), 1–28.

Lo, A., Mamaysky, H., Wang, J. (2000). Foundations of technical analysis: computational algorithms, statistical inference, and empirical implementation. *Journal of Finance* 55(4), 1705–1765.

López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.

Marshall, B., Young, M., Rose, L. (2006). Candlestick technical trading strategies: can they create value for investors? *Journal of Banking & Finance* 30(8), 2303–2323.

Marshall, B., Young, M., Cahan, R. (2008). Are candlestick technical trading strategies profitable in the Japanese equity market? *Review of Quantitative Finance and Accounting* 31(2), 191–207.

Martineau, C. (2019). Rest in peace post-earnings announcement drift. Working paper.

Merton, R. (1987). A simple model of capital market equilibrium with incomplete information. *Journal of Finance* 42(3), 483–510.

Moreira, A., Muir, T. (2017). Volatility-managed portfolios. *Journal of Finance* 72(4), 1611–1644.

Murray, S., Xia, Y., Xiao, H. (2024). Charting by machines. *Journal of Financial Economics*.

Nagel, S. (2012). Evaporating liquidity. *Review of Financial Studies* 25(7), 2005–2039.

Neely, C., Rapach, D., Tu, J., Zhou, G. (2014). Forecasting the equity risk premium: the role of technical indicators. *Management Science* 60(7), 1772–1791.

Ng, J., Rusticus, T., Verdi, R. (2008). Implications of transaction costs for the post-earnings announcement drift. *Journal of Accounting Research* 46(3), 661–696.

Park, C.-H., Irwin, S. (2007). What do we know about the profitability of technical analysis? *Journal of Economic Surveys* 21(4), 786–826.

Sullivan, R., Timmermann, A., White, H. (1999). Data-snooping, technical trading rule performance, and the bootstrap. *Journal of Finance* 54(5), 1647–1691.

Zakamulin, V. (2018). Revisiting the profitability of market timing with moving averages. *International Review of Finance* 18(2), 317–327.

Zakamulin, V. (2015). A comprehensive look at the empirical performance of moving average trading strategies. Working paper, University of Agder.
