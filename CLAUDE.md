# TradingView MCP — Claude Instructions

**Read [docs/START-HERE.md](docs/START-HERE.md) first.** It is the entry point for this project. This file is the always-loaded index; the docs carry the detail.

180 MCP tools driving a live TradingView Desktop chart over CDP (port 9222), plus the Tactical Alpha API and a separate WRDS server.

## The three layers — don't confuse them

| Layer | Tools | Job |
|---|---|---|
| **TradingView MCP** (here) | everything except `ta_*` | Charts, levels, entries, drawings, Pine. **Trading.** |
| **Tactical Alpha** (VPS) | `ta_*`, `walls_*` | Portfolio, earnings, regime, walls, watchlists. **Investing.** TA is the master system. |
| **WRDS** (`wrds-mcp` server) | `wrds_*` | Historical research. **Not live** — CRSP ends 2024. |

`ta_investing_brief` and `morning_brief` are different views, not duplicates.

## Documentation

| File | For |
|---|---|
| [docs/START-HERE.md](docs/START-HERE.md) | Entry point — layers, first moves, guardrails |
| [docs/tools-reference.md](docs/tools-reference.md) | All 180 tools (generated — `node scripts/gen-tools-doc.js`) |
| [docs/strategies.md](docs/strategies.md) | **THE strategy catalogue** — 18 strategies by execution tier (intraday / weekly 2–10d / monthly 11d+), each with its screener, entry, exit, TradingView indicators, skills, tools, risk rules and evidence tier. Generated from [strategies.json](strategies.json) — `node scripts/gen-strategies-doc.js` |
| [docs/data-sources.md](docs/data-sources.md) | TA endpoints, WRDS datasets, **freshness rules** |
| [docs/routines.md](docs/routines.md) | Daily and weekly workflows |
| [docs/screening.md](docs/screening.md) | Morning screen — design and reasoning. TV scanner as coarse filter, our detectors as verdict |
| [docs/screening-parameters.md](docs/screening-parameters.md) | The exact screen parameters (generated — `node scripts/gen-screens-doc.js`) |
| [docs/plugins.md](docs/plugins.md) | FSI plugin skills and how to feed them data |
| [docs/architecture.md](docs/architecture.md) | How the layers connect |
| [docs/playbook.md](docs/playbook.md) | Strategies and patterns from the reference books |
| [docs/research-evidence.md](docs/research-evidence.md) | What the academic evidence supports, what didn't replicate, and what to build next |
| [docs/sunday-review-schema.md](docs/sunday-review-schema.md) | Fixed output contract for the weekly review — TA imports this |
| [docs/swing-evidence-review.md](docs/swing-evidence-review.md) | **Read first.** The owner's own evidence review — tiers A/B/C, and the horizon problem |
| [docs/literature.md](docs/literature.md) | 25 papers, paper by paper — including the ones that contradict our own modules |
| [docs/book-notes-shannon.md](docs/book-notes-shannon.md) | Shannon, *Multiple Timeframes*, read in full — what was built, what is still unbuilt, and the claims that need a noise floor |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Known breakages and causes |
| `skills/` | Step-by-step procedures, invoked by name |

## Decision tree

| The user asks | Do |
|---|---|
| Anything is broken | `tv_doctor` — every failing check carries its fix |
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "Analyse this chart" | `chart-analysis` skill |
| "Which timeframe?" / swing vs day | `timeframe_plan` then `mtf_analyze` — context grants permission, structure finds the setup |
| "What do I DO right now?" | `stage_plan` — Shannon's gate: Stage 2 or 4 on the longer timeframe or NO setup, then ANTICIPATE / PARTICIPATE / EXIT / AVOID. Forward-tested NEGATIVE — a description of alignment, not an edge |
| "Is it beating the market?" | `relative_strength` — the only tool that answers "compared to what" |
| "Mark my entry/stop/targets" | `draw_trade_plan` — one call, returns R:R |
| "What should I look at today?" | `morning_brief`, or `catalyst-aware-brief` for event risk |
| "Any new swing candidates?" | `node scripts/morning-screen.js` — index members to a drawn, watchlisted top 20, split into **Months** (rebalances monthly, hysteresis band) and **Weeks** (daily). Runs weekdays 05:30 PT. Any `KEEP*` section is preserved. `--force-months` overrides the clock |
| "How far can it run before it halts?" | `luld_band` — 5% Tier 1, 10% Tier 2, doubled at the open and into the close |
| "Move this setup to another timeframe" | `timeframe_scale` — lookbacks scale LINEARLY, stops and targets as the SQUARE ROOT. Scaling a stop linearly is the common error |
| "Why did I exit?" / journal review | `exit_mix` — splits PLANNED from DISCRETIONARY exits. A backtest can only model a planned exit, so a discretionary majority means the backtest tests a different strategy |
| "Which trades actually make money?" | `journal_slice` — by direction, share size, share price, holding time. A profitable book can contain net-negative halves; buckets under `min_n` are flagged, never ranked |
| "Is this series trending or mean-reverting?" | `scaling_exponent` — measures the exponent the sqrt-of-time law assumes to be 0.5. Cross-checks `stopping_premium` |
| Weekly portfolio review / "validate TA's suggestions" | `sunday-review` skill — full assessment of every TA exit/entry in a fixed schema, drawn on the charts. Scheduled Sundays 08:00 |
| "Add the walls" | `walls-overlay` skill (needs the **TA-Trading** layout) |
| "Do I own this? Does it report soon?" | `ta_trading_context` — call **before** acting on a setup |
| "What's the regime?" | `ta_regime` — also carries position sizing |
| "How shorted is it?" / "squeeze setup?" | `short_interest` — FINRA, twice a month. Quote the `driver`, never bare days-to-cover, and check `shorts_position`: squeeze fuel needs shorts who are LOSING |
| "Write a Pine script" | `pine-develop` skill |
| "What's the trend?" / "key levels?" | `market-structure` skill — `structure_analyze`, `levels_find`. Quote each level's evidence |
| "Supply/demand zones?" / "order blocks?" / "SMC" | `supply-demand-setup` skill — `zones_find`. A zone is where price DEPARTED from, not where it reversed |
| "Where does this move project to?" | `fib_targets` — extensions find exits; `fib_levels` finds entries. They get confused constantly |
| "Any patterns?" / "analyse this chart" | `chart-patterns` skill — a *forming* pattern is not a signal |
| "Which symbols qualify?" / a rule with numbers | `strategy-scan` skill — criteria as data, not prose |
| "What strategies do we have?" / "how do I play X?" | [docs/strategies.md](docs/strategies.md), or `strategy_list` — grouped by execution tier with the screener, entry/exit, indicators, skills and tools per strategy. Filter with `execution` and `evidence_tier` |
| "Did that breakout hold?" | `breakout_check` — 5 measurements; reclaimed next bar = failed |
| "Will this level hold?" | `level_pressure` — describes whether attempts are strengthening. Its predictive claim FAILED out of sample (+39.1 in-sample → +4.6 on a fresh universe). Ignore touch count entirely |
| "Backtest this" / "does it work?" | `backtest-strategy` skill — **always report buy-and-hold** |
| "How much should I risk?" / "what's my expectancy?" | `risk-sizing` skill — expectancy AND risk of ruin. A win rate means nothing without its payoff |
| "How many shares?" | `position_size_constrained` (or `position_size` for a drawn plan) — risk budget, concentration cap and liquidity, **minimum wins**. A tighter stop buys MORE shares, so a good entry is when the cap binds |
| "Where does my trailing stop go?" | `pivot_trail` — a new higher high promotes the stop to the last higher low. One-directional ratchet; it refuses to loosen. Check `stopping_premium` first, a trail is a bet on persistence |
| "Does this still work after costs?" | `trade_cost` then `costs_vs_edge` — an edge smaller than its costs is a losing strategy |
| "How much risk am I carrying?" | `portfolio_heat` + `position_correlation` — six 1% positions are not 6% if they move together |
| "Count the waves" / "Elliott" | `elliott_survey` — returns EVERY rule-valid count, never one. Disagreement across sensitivities is the finding |
| "What is this candle saying?" | `candle_read` — every candle is momentum, reaction or indecision. `patterns_detect` for named patterns |
| "Any divergence?" / "RSI divergence" | `divergence_survey` — agreement across indicators is the only thing that makes one worth reading |
| "Is this an impulse or a pullback?" | `legs_classify` — three measurements per leg, and it flags a stale last leg. Also returns TIME corrections, the digestion a depth rule scores as "no pullback" |
| "Is it trending?" / "how strong is the move?" | `momentum_read` — 12m/6m/3m/1m at once. The best-replicated effect here; horizons disagreeing IS the answer |
| "Is it coiled?" / "narrow range?" / "squeeze?" | `volatility_state` — 2BNR/3BNR/4BNR/8BNR, the multi-bar coils NR4 and NR7 cannot see. A volatility STATE, never a direction: every pattern in it fires on 100% of random walks |
| "Is this a proper base?" / "VCP?" | `vcp_check` — every clause a number, and a near miss names the clause that failed |
| "Is that really converging?" | `pivots_kernel` — pivots read from real bar highs/lows, plus the converging/diverging verdict |
| "Is this backtest real?" | `deflated_sharpe` — the best of 200 no-edge strategies scores 2.19 annualised. Below 0.95 is not a discovery |
| "Did this ever work?" | `wrds_backtest_signal` |
| "Clean up the chart" | `draw_clear` — removes only MCP drawings by default |
| "Old drawings won't clear" | `node scripts/clear-orphans.js` — TradingView entity IDs are SESSION-scoped, so anything drawn before the app last restarted is invisible to `draw_clear`. Finds them by label text. Dry run by default; `--apply` to delete |

## Rules

Each of these exists because it has already gone wrong here.

**Verify — don't trust a success flag.** Eight tools in this codebase were found reporting `success: true` while doing nothing, because their tests asserted things that could not fail. If a tool claims success but the chart didn't change, believe the chart.

**A backtest without a benchmark flatters itself.** Net profit cannot tell a good strategy from a rising market. Always report buy-and-hold over the same bars, and report return *and* drawdown — a strategy often earns its keep by avoiding a drawdown while returning less. Lead with expectancy, not win rate.

**A result without a trial count flatters itself just as badly.** Search 200 strategies with no edge and the best scores an annualised Sharpe of **2.19** with a probabilistic Sharpe of 0.985 — measured, in `tests/validation.test.js`. Deflated for the search it is 0.267. Any scan or backtest that reports a winner must report how many candidates it beat; `deflated_sharpe` does the arithmetic. Below 0.95 is not a discovery. See [docs/research-evidence.md](docs/research-evidence.md).

**A forecast without a persistence baseline flatters itself too.** "Tomorrow equals today" scores ~99% accuracy on daily bars. Published LSTM stock predictors reporting 97% were reproducing exactly that. `momentum_read` returns the baseline beside every reading.

**Every well-evidenced edge here is a PORTFOLIO result. One chart is not a portfolio.** Momentum's Sharpe 1.28 came from 58 futures; the 52-week high effect from 1000+ ranked stocks; PEAD from decile portfolios — and PEAD *dissolves* at the firm level (16% of good-news quarters drift negative). `IR = IC × √BR`: momentum applied to **one** position retains **13%** of its published information ratio and would take ~136 years to prove. Run `edge_breadth` before quoting any study's Sharpe at a single symbol.

**Tools, strategies and workflows are different things.** Tools are capabilities (`src/tools/`), strategies are testable rules (`rules.json`, Pine), workflows are procedures (`skills/`). A tool must not encode a strategy; a strategy must not live in a skill's prose. See [docs/START-HERE.md](docs/START-HERE.md).

**Every detector carries its noise floor, and five of them are humbling.** Measured over 200 random walks: supply/demand **zones 99.5%**, a single **divergence 99%** (7 per walk) but **two or more agreeing only 13.5%**, rule-valid **Elliott counts 70.5%**, **breakouts of a prior high 32.5%** (17.5% passing 3+ checks), Wyckoff **classifyPhase 100%** — it never abstains, so a phase is descriptive, not evidence. Against that: **springs/upthrusts 0%**, **VCP 0%**, **pennants 0%**. Quote the agreement count, never a lone divergence; quote confluence, never a lone zone. `node scripts/detector-noise.js` re-measures.

**Crabel's contraction/expansion principle is arithmetic, not an edge.** A narrow range IS followed by a wider one — 76.4% of the time on real data. But a random walk does it **80.2%** of the time, against a 50% base in both. Real data shows LESS lift than noise. `src/core/crabel.js` implements the daily-bar-reachable half (2BNR/3BNR/4BNR/8BNR, hooks, 3DHR) as a **volatility state with its floor attached**; every one of them fires on 100% of random walks. Opening Range Breakout needs the first thirty seconds of trade and is deliberately absent. See [docs/research-evidence.md](docs/research-evidence.md).

**Position size has THREE constraints and the smallest wins.** Risk budget, concentration cap (15–20% of equity in one name), and liquidity (% of ADV). Under fixed risk a TIGHTER stop buys MORE shares, so the concentration cap binds precisely when the entry looks best — Shannon's own worked example turns a 1% risk budget on $100,000 into a $66,650 position, 65% of capital in one idea. `position_size_constrained` returns the minimum and names which bound; without `adv` the liquidity constraint reports NOT CHECKED, because unknown is not satisfied. Reporting a constraint is not applying it.

**Touch count is not level strength — and the clause that looked like it was, did not replicate.** Measured over 20 symbols: the break hazard rises 4.5–21.2 points across real arms where a random walk rises **40.3**, so more tests just means more exposure. The *pressure* clause — interim retreat extremes moving toward the level — scored **+39.1 points (z = 3.96)** on the sample it was found in, and then **+4.6 (z = 0.73) on a fresh universe with MORE levels (251 vs 103)**, plus +3.4 on an earlier window of the original names. It holds in 1 of 3 arms: the one it came from. `level_pressure` is a DESCRIPTION of whether attempts are strengthening, not a forecast; `level_test_history` carries every arm. Both the noise floor and the trial count were attached to the original claim and **neither caught it — only the holdout did.**

**A gate that filters is not a gate that pays.** `stage_plan` implements Shannon's universe restriction and is built from his moving-average clauses (position, slope, **stacking** — a separate clause) so they can DISAGREE and it can abstain: 54% of random walks, against `classifyPhase`'s 0%. But **forward-tested it makes outcomes WORSE**. Triple-barrier over 90 symbols, no lookahead, against a direction-matched baseline on the same bars: long **33.5% vs 36.4%** (198 independent events), short **21.2% vs 28.9%** (103). Four configurations, none favouring the gate. That is coherent — Stage 2 requires price above three rising stacked averages, which describes a move that already happened, and below ~21 days the effect is REVERSAL. Use it to describe alignment and restrict the universe; never as evidence the trade is better. "Not enough bars" reports as `INSUFFICIENT_DATA`, never as a considered abstention.

**Corrections come in two kinds and a depth rule sees one.** A PRICE correction retraces; a TIME correction digests horizontally at low volatility. `legs_classify` returns both, because a pullback detector measuring depth scores a time correction as "no pullback" and skips a live setup — and a broken trendline predicts exactly that kind. Measured: fires on 88% of random walks and 91.7% of real symbols, so it is descriptive. Whether it resolves with the primary trend is **NOT SETTLED** — +8.3 points on daily (n=18) against -2.8 at 60-minute (n=14), opposite signs on samples too small to beat a 52.8% null. Untested, not refuted.

**A noise floor and a trial count are not enough. Two claims here passed both and died on a holdout.** `level_pressure`'s pressure clause scored +39.1 points at z = 3.96 with its random-walk null attached and its family size corrected — and collapsed to +4.6 on a fresh universe with a *larger* sample. `stage_plan`'s gate abstained on 54% of random walks and still made forward outcomes worse. So: any single-sample finding in this repo is PROVISIONAL until it has an out-of-sample arm — a different universe, a disjoint period, or both. `scripts/level-test-inversion.js` and `scripts/stage-forward-test.js` are the templates.

**Pin the timeframe, or the measurement is of something else.** Three measurement scripts called `setSymbol` but never `setTimeframe`, inherited the chart's 60-minute resolution, and recorded their results as "daily bars". Nothing in the output revealed it. `scripts/_real_bars.js` now requires an explicit timeframe, verifies the resolution actually took, and restores both symbol and resolution afterwards. Use it for any real-data measurement.

**A strategy lives in strategies.json, not in prose.** 18 strategies are catalogued as DATA — criteria, screener, entry, exit, indicators, skills, tools, risk rules and an evidence tier each — so `strategy_check` and `strategy_scan` can evaluate them. Before this existed `strategy_list` returned `count: 0` while four pieces of machinery waited for input. `rules.json` still wins a name clash; it holds the owner's own criteria and a shared catalogue must not override them. **Six entries are tiered REJECTED and kept deliberately** — candlesticks, standalone zones, single divergences, the stage gate as an edge, level touch count, Crabel contraction — each with the measurement that killed it, so nobody rediscovers one and believes it is new. They carry no criteria and `strategy_check` refuses them with the reason.

**The owner's WEEKLY bucket is the reversal zone, and most setups in it are continuation bets.** Execution tiers are intraday, weekly (2–10 days), monthly (11+ days). Below ~21 trading days the documented effect is REVERSAL; 11–63 days is the contested gap where neither effect is documented. So a breakout, flag, triangle or VCP placed in the weekly tier is fighting its own horizon — `docs/strategies.md` says so on every tier heading, and `horizon_prior` says which side a given setup is on.

**Never invent a price.** Levels come from `drawn_levels`, `drawn_labels`, `price_action`, or TA. If nothing supports one, write `n/a`.

**A 200 is not freshness.** TA stamps `age_hours` from the source file's mtime. Walls past ~30h on a trading day mean TA's scan didn't run. Say the age out loud. FINRA short interest is the opposite case: it settles **twice a month** on an ~8-business-day lag, so 1–3 weeks old is the resolution of the measurement, not a delay — calling it stale there is the error.

**A ratio moves when its denominator moves, and days-to-cover is the worst offender here.** Measured over 40 symbols and 1,000 period changes: **93% of days-to-cover moves of 20% or more (426 of 458) were driven by average VOLUME, not by the short position** — 100% of them on ten of those names. Worst case KSS: days-to-cover +351.5% on a +1.59% change in short interest. `short_interest` decomposes every period and names the `driver`; quote that, never the bare ratio. Shannon's own Figure 15.1 falls into this trap. `node scripts/short-interest-driver.js` re-measures. The same failure shape has now appeared three times in this repo — the hysteresis percentile bug, FINRA's clamped days-to-cover, and this — so treat any single reported ratio as suspect until you have seen both its inputs.

**Today's daily bar is not a day.** Extended-hours trade accumulates into it from 04:00 ET, so pre-open every symbol already has a "daily" bar holding a fraction of its eventual volume — SPY measured 6.7M against ~45M. Its `close` is a real quote; its **high, low and volume are not**. `completeSeries` drops it and the unattended scripts use that; `data_get_ohlcv` reports `bar_state` rather than trimming, because interactive callers often want the live bar. The scanner's server-side fields **cannot** be repaired — `scannerTrust()` says which are unsafe, and `relative_volume_10d_calc` is the worst of them, which is why the high-volume premium factor is suppressed pre-open.

**A monthly factor on a daily screen is a different strategy.** MAD, the trend factor and the volume premium are monthly cross-sectional sorts; MAD's ~9% survives costs *at that cadence*. Reranking daily is 252 round trips a year — 50.4% drag at 20bps, 5.6x the whole effect. Months rebalances monthly with a hysteresis band (~0.96%); Weeks rebalances daily. `cadence.js` owns both clocks.

**A stop does not get its price in a halt.** `gap_risk` covers the overnight jump; `luld_band` covers the intraday one. Tier 1 (S&P 500 / Russell 1000) is **5%** above $3, Tier 2 is 10% — retail sources quote the Tier 2 number for large caps and are wrong by half. Bands **double** 09:30–09:45 and 15:35–16:00 ET, and that closing window is where stop-driven exits cluster.

**Two quantities scale differently between timeframes.** Lookbacks scale LINEARLY with the timeframe ratio — 65 bars of 30-minute and 195 of 10-minute both span 5 sessions (Shannon 2008, fig. 10.4). Stops, targets and ranges scale as the SQUARE ROOT — a 1.5pt stop on 5-minute is 5.2 on hourly (Grimes 2013). `timeframe_scale` does both; scaling a stop linearly makes it several times too wide and quietly changes the strategy. A day is **390 session minutes**, not 1440, or every translation is out by 3.7x.

**The sqrt law is the random-walk law, so measuring it is a test.** `scaling_exponent` fits log(stdev) against log(horizon): 0.5 means independent, above means moves compound, below means they offset. That makes the reversal/continuation boundary a property of the series rather than a 1993 citation. It agrees with `stopping_premium` where both have a verdict — PNC 0.619 persistent by both, CYTK 0.369 mean-reverting by both. Drift does NOT move it, and must not: drift is not persistence.

**The higher timeframe is context, not a verdict.** Grimes ran a triple-MA trend indicator over 973,087 observations WITH a random control; across ~903k equity observations it was INVERTED (−157.9 excess when reading up, +166.9 when reading down) and next-bar direction sat at ~50% everywhere. `mtf_analyze` no longer states Elder's rule as settled, and a ranging context now withholds a directional LEAN rather than forbidding the trade — a ranging HTF is where sharp LTF trends appear.

**A backtest can only model an exit that was specifiable before entry.** `target`/`stop`/`time` are exactly the modellable set, which is why recording only those teaches nothing — they cannot separate an exit the plan called for from one decided while the position was live. `exit_mix` splits them using the fifteen-key exit taxonomy and counts the ones driven by the INDEX, which no single-symbol backtest can see. If discretionary exits are the majority, every benchmark, trial count and deflated Sharpe in the test describes a different strategy that merely shares an entry signal.

**A noise floor you cannot measure is not a noise floor.** The 1-2-3 (`src/core/ignition.js`) fires on 5.9% of real charts and 22.5% of random walks — *below* its own null. The cause was the ATR gate: ATR counts overnight gaps, bar range does not, so every constructed null shifts the gate rather than the pattern, and estimates span 5.9–39.6% on the same data. It is implemented, tested, and deliberately **not registered as a tool**. One relative finding survives because both arms shared a generator: the top-third clause is load-bearing (22.5% vs 63%).

**Live account, live chart.** `draw_clear scope:"all"` deletes the user's own drawings — always ask. It is also rarely what you want: `clear-orphans` recovers drawings lost to a session restart WITHOUT touching anything hand-drawn, and on 2026-07-28 removed 545 stale shapes across 45 symbols while preserving 7 of the user's own. If you add or change a drawing label, append its format to `MCP_TEXT_SIGNATURES` — a label with no signature leaks an orphan that can never be cleaned up. `alert_create` makes a real alert that can fire; check the price is on the correct side of spot. `alert_delete` needs explicit ids. Scans drive the chart and must restore it.

**Swing trading sits on top of a sign change.** Below ~21 trading days the documented effect is REVERSAL; above ~63 it is CONTINUATION, and momentum's skip-month exists because the boundary falls inside the swing window. Nearly every structural detector here — flags, triangles, wedges, VCP, breakouts — is a CONTINUATION bet placed at the horizon where continuation is weakest. Run `horizon_prior` before hunting a setup and say which side of the boundary it is on. See [docs/swing-evidence-review.md](docs/swing-evidence-review.md).

**Turnover decides whether a swing strategy can exist.** A 5-day hold is ~50 round trips a year; at 20bps each that is ~10% annually before any edge. `turnover_cost` does the arithmetic, and computes the hysteresis exit that halved turnover while raising net returns.

**A stop-loss is a bet on persistence, not free insurance.** Kaminski & Lo prove the stopping premium is ALWAYS NEGATIVE under a random walk — a stop in a no-persistence market lowers expected return without benefit. It turns positive under momentum, proportional to persistence. Run `stopping_premium` before claiming a stop helps; it may still be right as a solvency constraint, but say which reason applies.

**Candlesticks failed two independent academic tests.** Marshall/Young/Rose (2006, DJIA, random-OHLC bootstrap) and Marshall/Young/Cahan (2008, Tokyo 1975-2004) both found no value — in any sub-period, bull or bear. Report a candle as a description of what the bar did, never as a signal.

**Not trade advice.** These tools render the user's own criteria and TA's own output. R:R and position size are arithmetic on numbers they supplied.

## Context management

- `data_get_ohlcv` — always `summary: true` unless individual bars are needed
- Pine graphics tools — always pass `study_filter`; never `verbose` unless asked
- `pine_get_source` can return 200KB+ — avoid unless editing
- `chart_get_state` once at the start; reuse entity IDs
- Prefer `capture_screenshot` over pulling large datasets for visual context

## Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs are session-specific — don't cache across sessions
- `chart_manage_indicator` needs **full names**: "Relative Strength Index", not "RSI"
- Pine indicators must be **visible** for the pine graphics tools to read them
- Screenshots land in `screenshots/`
- On Git Bash, prefix commands passing `/api/...` paths with `MSYS_NO_PATHCONV=1`
