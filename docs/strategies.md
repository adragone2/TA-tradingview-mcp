# Strategy catalogue

**Generated** — `node scripts/gen-strategies-doc.js`. Source of truth: [strategies.json](../strategies.json).

Every strategy the toolchain can express, grouped by **execution tier** (when the trade is closed out) and
tagged with an **evidence tier** (how much to believe it). Each row names its screener, entry and exit rules,
TradingView indicators, and the skills, tools and risk rules to invoke.

21 strategies — 14 machine-scannable, 7 tiered REJECTED.

| | |
|---|---|
| By execution | monthly 7 · weekly 11 · intraday 3 |
| By evidence | A 3 · B 4 · C 7 · REJECTED 7 |

## How to read this

| Evidence tier | Means |
|---|---|
| **A** | Replicated in peer-reviewed work across many instruments, and survives costs at its stated cadence. |
| B | One good study, or a measured zero noise floor, but no return evidence at this repo's cadence. |
| C | Practitioner source only. No measurement here either way — treat as a hypothesis. |
| ~~REJECTED~~ | Measured in this repo and found to have no edge over its own null. Listed so it is not rediscovered. |

**REJECTED entries are listed on purpose.** Each has been measured here and found to have no edge over its own
null. Deleting them would mean the next session rediscovers a candlestick reversal or a touch-count level rule
and believes it is new. They carry no criteria, and `strategy_check` refuses them *with the reason*.

Two things this catalogue will not do: it does not rank strategies against each other, and it does not say which
to trade. A tier is a statement about evidence, not about expected return on your account.

## Run any of these

```bash
# what is defined, with tiers
strategy_list
strategy_list execution="monthly" scannable_only=true

# evaluate one against the chart, criterion by criterion
strategy_check strategy_name="momentum_pullback"

# across a watchlist (restores the chart afterwards)
strategy_scan strategy_name="vcp_base_breakout"
```

`rules.json` wins a name clash — it holds your own criteria and a shared catalogue must not override them.

---

## Intraday — same session

Closed out by **the session close**.

> **Horizon evidence.** NONE from the academic literature in this repo. Every intraday effect here comes from practitioner books, and several of these setups need sub-minute bars or the tape, which this toolchain does not have.

### Opening range breakout  ·  C

`opening_range_break` · long

**Evidence.** Practitioner sources only. Crabel's own ORB needs the first thirty seconds of trade and is deliberately NOT implemented here.

**Caveat.** Needs sub-minute data this toolchain does not have. The 5-minute version below is a proxy, not Crabel's rule.

| | |
|---|---|
| **Screener** | `intraday_screens:premarket_gap` |
| **Entry** | Break of the first 5-minute candle's high, above VWAP. |
| **Exit** | Loss of VWAP. Flat by the close. |
| **Exit reason keys** | `stop_hit`, `time_elapsed`, `target_hit` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [chart-analysis](../skills/chart-analysis/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `strategy_check`, `luld_band`, `depth_get`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `max_daily_loss` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `minutes_since_open` | `>=` | `5` |  |
| `minutes_since_open` | `<=` | `30` |  |
| `price` | `>` | `opening_range_high(5)` |  |
| `price` | `>` | `vwap` |  |
| `rvol` | `>` | `1.5` |  |

</details>

### Parabolic reversal (fade to the 9 EMA)  ·  C

`parabolic_fade` · short

**Evidence.** Practitioner source. No measurement.

**Caveat.** A counter-trend short. Shannon's rule is that shorts in an uptrend carry 'much higher' risk, and a squeeze can be violent — check short_interest and shorts_position first, since squeeze fuel needs shorts who are LOSING.

| | |
|---|---|
| **Screener** | `intraday_screens:intraday_extension` |
| **Entry** | Fade back toward the 9 EMA once the extension stalls. |
| **Exit** | Prior candle extreme as the stop. Cover into the 9 EMA. |
| **Exit reason keys** | `stop_hit`, `target_hit`, `too_steep` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [chart-analysis](../skills/chart-analysis/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `short_interest`, `luld_band`, `candle_read`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `max_daily_loss` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `price` | `>` | `ema(9) * 1.05` | extended from the fast average |
| `rsi(14)` | `>` | `75` |  |

</details>

### VWAP reclaim continuation (lightning bolt)  ·  C

`vwap_reclaim` · long

**Evidence.** Practitioner source. No measurement.

**Caveat.** The intraday U-shaped volume curve is partly SELF-REINFORCING because VWAP-targeting execution algorithms trade a percentage of volume per time bucket. That makes VWAP a real reference point and not a forecast.

| | |
|---|---|
| **Screener** | `intraday_screens:premarket_gap` |
| **Entry** | Breaks VWAP, pulls back less than half the move, then continues. Volume falls on the pullback and rises on the continuation. |
| **Exit** | Beyond VWAP. Flat by the close. |
| **Exit reason keys** | `stop_hit`, `time_elapsed`, `tape_seller` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]` |
| **Skills** | [chart-analysis](../skills/chart-analysis/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `anchored_vwap`, `strategy_check`, `depth_get`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `max_daily_loss` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `minutes_since_open` | `>=` | `10` |  |
| `price` | `>` | `vwap` |  |
| `pullback_pct` | `<` | `50` |  |

</details>

---

## Weekly — 2–10 trading days

Closed out by **within two trading weeks**.

> **Horizon evidence.** THE REVERSAL ZONE. Below ~21 trading days the documented effect is REVERSAL, not continuation (see docs/swing-evidence-review.md, docs/strategy-horizons.md). Any CONTINUATION setup placed here is fighting its own horizon — that includes breakouts, flags, triangles and VCP. Run horizon_prior before acting.

### Short-term reversal (liquidity provision)  ·  B

`short_term_reversal` · long

**Evidence.** Nagel (2012): short-term reversal as compensation for providing liquidity. This is the one documented effect that BELONGS in the 2-10 day window rather than fighting it.

**Caveat.** CONDITIONAL. It 'earns essentially nothing unconditionally' — it is only active when VIX is elevated. tier_a_factors keeps it INACTIVE otherwise, and that gate is the strategy.

| | |
|---|---|
| **Screener** | `screens:short_term_reversal (+ morning-screen:tier_a_factors for the VIX gate)` |
| **Entry** | Only when VIX is elevated. Buy the biggest short-horizon losers that are still above their long-term trend. |
| **Exit** | 2 to 10 days, on mean reversion or the time stop — whichever comes first. |
| **Exit reason keys** | `target_hit`, `time_elapsed`, `stop_hit` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [risk-sizing](../skills/risk-sizing/SKILL.md), [backtest-strategy](../skills/backtest-strategy/SKILL.md) |
| **Tools** | `tier_a_factors`, `ta_regime`, `horizon_prior`, `turnover_cost`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `max_portfolio_heat` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `rsi(2)` | `<` | `10` | washed out short term |
| `close` | `>` | `sma(200)` | but not broken long term |

</details>

### Wyckoff spring / upthrust reclaim  ·  B

`wyckoff_spring_reclaim` · long

**Evidence.** Measured: ZERO detections across 200 random walks. The definition is what earns that — price must trade BEYOND the boundary and CLOSE back inside.

**Caveat.** A wick below support with a close still below is a BREAKDOWN, not a spring. wyckoff_spring returns those separately as unconfirmed, never mixed in. Note wyckoff_phase is the opposite: it fires on 100% of random walks because it never abstains, so a PHASE is descriptive and only the spring is selective. No return evidence.

| | |
|---|---|
| **Screener** | `screens:structural_reversal` |
| **Entry** | On the reclaim close, not on the wick. A REVERSAL setup, so it is one of the few structural entries the 2-10 day horizon actually supports. |
| **Exit** | Stop below the spring low. Target the range high. |
| **Exit reason keys** | `stop_hit`, `target_hit`, `level_reached` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]` |
| **Skills** | [market-structure](../skills/market-structure/SKILL.md), [supply-demand-setup](../skills/supply-demand-setup/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `wyckoff_spring`, `effort_vs_result`, `levels_find`, `horizon_prior`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `min_rr` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `low` | reclaim — the close must be back inside |
| `nearest_level_distance_pct` | `<` | `2` |  |

</details>

### Breakout of a tested level  ·  C

`breakout_continuation` · long

**Evidence.** No positive measurement. breakout_check applies 5 measurements and its noise floor is 32.5% on random walks (17.5% passing 3+ checks), so a bare breakout is close to a coin flip.

**Caveat.** A CONTINUATION bet at the horizon where continuation is weakest. Also: the TOUCH COUNT of the level carries nothing — the break hazard rises 4.5-21.2 points across real arms where a random walk rises 40.3. 'Tested three times so it is strong' is unsupported in both directions.

| | |
|---|---|
| **Screener** | `screens:breakout` |
| **Entry** | A CLOSE beyond the level, with volume at least normal for the period. Shannon is explicit that volume CONFIRMS and never triggers — waiting for expansion produces late entries. |
| **Exit** | Reclaimed next bar means it failed. Stop just beyond the broken level; measured move as the first target. |
| **Exit reason keys** | `stop_hit`, `target_hit`, `gap_against_trend` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [chart-patterns](../skills/chart-patterns/SKILL.md), [market-structure](../skills/market-structure/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `breakout_check`, `levels_find`, `level_pressure`, `horizon_prior`, `luld_band`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `min_rr` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(50)` |  |
| `nearest_level_distance_pct` | `<` | `1` |  |
| `close` | `>` | `ema(8)` |  |

</details>

### Momentum pullback to a rising average  ·  C

`momentum_pullback` · long

**Evidence.** The flagship screen in docs/screening.md. Built from the momentum literature but the PULLBACK ENTRY itself has no measurement here.

**Caveat.** The trend is monthly evidence; the entry is a weekly-horizon continuation bet, which is the reversal zone. This is the horizon problem in a single strategy, and the honest reading is that the trend selection is Tier A and the timing is Tier C.

| | |
|---|---|
| **Screener** | `screens:momentum_pullback` |
| **Entry** | Enter on the first new higher high after the pullback, not on the touch. Shannon: the trigger is a new extreme, and a low-volume pullback is the better candidate. |
| **Exit** | Stop below the most recent higher low. Trail with pivot_trail. Two exit triggers: the higher low breaks (PRICE correction) or the short average crosses the intermediate one (TIME correction). |
| **Exit reason keys** | `stop_hit`, `trend_broken`, `ma_crossover`, `target_hit` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [market-structure](../skills/market-structure/SKILL.md), [chart-analysis](../skills/chart-analysis/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md), [trade-journal](../skills/trade-journal/SKILL.md) |
| **Tools** | `structure_analyze`, `legs_classify`, `momentum_read`, `horizon_prior`, `pivot_trail`, `stopping_premium`, `position_size_constrained`, `draw_trade_plan` |
| **Risk rules** | `max_risk_per_trade`, `min_rr`, `concentration_cap` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(200)` |  |
| `sma_slope(50)` | `>` | `0` |  |
| `pullback_pct` | `>` | `3` |  |
| `pullback_pct` | `<` | `15` |  |
| `close` | `>` | `ema(21)` |  |

</details>

### Candlestick reversal patterns  ·  ~~REJECTED~~

`REJECTED_candlestick_reversal` · long · **not scannable**

**Evidence.** FAILED TWO INDEPENDENT ACADEMIC TESTS. Marshall, Young & Rose (2006, DJIA, random-OHLC bootstrap) and Marshall, Young & Cahan (2008, Tokyo 1975-2004) both found no value — in any sub-period, bull or bear.

**Caveat.** Report a candle as a DESCRIPTION of what the bar did, never as a signal. candle_read exists for that and says so.

| | |
|---|---|
| **Screener** | _none — do not screen for this_ |
| **Entry** | Do not trade this as a standalone signal. |
| **Exit** | n/a |
| **TradingView indicators** | — |
| **Skills** | — |
| **Tools** | `candle_read`, `patterns_detect` |
| **Risk rules** | — |

_"Candlestick reversal patterns" is tiered REJECTED: FAILED TWO INDEPENDENT ACADEMIC TESTS. Marshall, Young & Rose (2006, DJIA, random-OHLC bootstrap) and Marshall, Young & Cahan (2008, Tokyo 1975-2004) both found no value — in any sub-period, bull or bear. It is in the catalogue so it is not rediscovered, not so it can be scanned._

### Narrow range then expansion (Crabel)  ·  ~~REJECTED~~

`REJECTED_crabel_contraction` · long · **not scannable**

**Evidence.** A narrow range IS followed by a wider one 76.4% of the time on real data — and 80.2% on a random walk, against a 50% base in both. Real data shows LESS lift than noise.

**Caveat.** volatility_state implements 2BNR/3BNR/4BNR/8BNR as a volatility STATE with the floor attached. Every pattern in it fires on 100% of random walks. Useful for saying 'coiled'; never for saying 'about to break, and upward'.

| | |
|---|---|
| **Screener** | `screens:volatility_contraction` |
| **Entry** | Do not trade the contraction as a directional signal. It is a state. |
| **Exit** | n/a |
| **TradingView indicators** | `[object Object]`, `[object Object]` |
| **Skills** | — |
| **Tools** | `volatility_state`, `legs_classify` |
| **Risk rules** | — |

_"Narrow range then expansion (Crabel)" is tiered REJECTED: A narrow range IS followed by a wider one 76.4% of the time on real data — and 80.2% on a random walk, against a 50% base in both. Real data shows LESS lift than noise. It is in the catalogue so it is not rediscovered, not so it can be scanned._

### Level strength from touch count  ·  ~~REJECTED~~

`REJECTED_level_touch_count` · long · **not scannable**

**Evidence.** Measured null in BOTH directions. The break hazard rises 4.5-21.2 points across real arms where a random walk rises 40.3 — more tests just means more exposure.

**Caveat.** The pressure clause (interim retreat extremes moving toward the level) looked strong in sample at +39.1 points, z = 3.96, and collapsed to +4.6 at z = 0.73 on a FRESH universe with MORE data. level_pressure describes the approach; it does not forecast the break.

| | |
|---|---|
| **Screener** | _none_ |
| **Entry** | Do not weight a level by how many times it has been tested, in either direction. |
| **Exit** | n/a |
| **TradingView indicators** | — |
| **Skills** | — |
| **Tools** | `level_pressure`, `level_test_history` |
| **Risk rules** | — |

_"Level strength from touch count" is tiered REJECTED: Measured null in BOTH directions. The break hazard rises 4.5-21.2 points across real arms where a random walk rises 40.3 — more tests just means more exposure. It is in the catalogue so it is not rediscovered, not so it can be scanned._

### Single-indicator divergence  ·  ~~REJECTED~~

`REJECTED_single_divergence` · long · **not scannable**

**Evidence.** One divergence fires on 99% of random walks (about 7 per walk). TWO OR MORE AGREEING fires on only 13.5%, which is the version worth reading.

**Caveat.** Use divergence_survey, never divergence_find alone, and quote the AGREEMENT COUNT. In a strong trend divergence is normal rather than a warning.

| | |
|---|---|
| **Screener** | _none_ |
| **Entry** | Only with two or more independent indicators agreeing, and then as context. |
| **Exit** | n/a |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | — |
| **Tools** | `divergence_survey` |
| **Risk rules** | — |

_"Single-indicator divergence" is tiered REJECTED: One divergence fires on 99% of random walks (about 7 per walk). TWO OR MORE AGREEING fires on only 13.5%, which is the version worth reading. It is in the catalogue so it is not rediscovered, not so it can be scanned._

### Shannon Stage 2 gate as an entry edge  ·  ~~REJECTED~~

`REJECTED_stage_gate_as_edge` · long · **not scannable**

**Evidence.** FORWARD-TESTED NEGATIVE. Triple-barrier over 90 symbols with no lookahead, against a direction-matched baseline: long 33.5% vs 36.4%, short 21.2% vs 28.9%. Four configurations, none favouring the gate.

**Caveat.** Coherent rather than surprising: Stage 2 requires price above three rising stacked averages, which describes a move that ALREADY happened, and below ~21 days the effect is reversal. stage_plan is still useful to impose the universe restriction and to describe alignment — it abstains on 54% of random walks where wyckoff_phase abstains on none. It is not an edge.

| | |
|---|---|
| **Screener** | _none as an edge_ |
| **Entry** | Do not enter because the gate is open. Use it to EXCLUDE, never to justify. |
| **Exit** | n/a |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [market-structure](../skills/market-structure/SKILL.md) |
| **Tools** | `stage_plan`, `horizon_prior` |
| **Risk rules** | — |

_"Shannon Stage 2 gate as an entry edge" is tiered REJECTED: FORWARD-TESTED NEGATIVE. Triple-barrier over 90 symbols with no lookahead, against a direction-matched baseline: long 33.5% vs 36.4%, short 21.2% vs 28.9%. Four configurations, none favouring the gate. It is in the catalogue so it is not rediscovered, not so it can be scanned._

### Two-leader (Key Price) confirmation as a filter  ·  ~~REJECTED~~

`REJECTED_tandem_confirmation` · long · **not scannable**

**Evidence.** MEASURED NEGATIVE. Livermore ch. 11: "There is danger of being caught in a false movement by depending upon only one stock." Tested over 14 S&P 500 industry groups on daily bars, new 40-bar closing high as the signal, triple-barrier forward labels, no lookahead: SOLO 544 signals / 91 independent / 30.9% win rate; TANDEM (sister stock also at a new high) 228 / 56 / 21.6%. Lift -9.3 points, z -2.57. Requiring confirmation discarded 58% of signals and made the survivors WORSE.

**Caveat.** A bug initially hid the size of this: GOOG and GOOGL were being used as a group's two leaders — one company, 57 of 57 tautological confirmations — which diluted the effect to -5.6 at z -1.64. Deduplicating share classes strengthened it. Coherent with the other failures here: requiring two large names in one group to break out within days selects for moves already extended and already correlated. THIRD confirmation gate measured in this repo, third to fail.

| | |
|---|---|
| **Screener** | _none — do not screen on this_ |
| **Entry** | Do not require the sister stock to agree before entering. It costs most of your signals and does not improve the rest. |
| **Exit** | n/a |
| **TradingView indicators** | — |
| **Skills** | — |
| **Tools** | `group_context`, `group_top_down` |
| **Risk rules** | — |

_"Two-leader (Key Price) confirmation as a filter" is tiered REJECTED: MEASURED NEGATIVE. Livermore ch. 11: "There is danger of being caught in a false movement by depending upon only one stock." Tested over 14 S&P 500 industry groups on daily bars, new 40-bar closing high as the signal, triple-barrier forward labels, no lookahead: SOLO 544 signals / 91 independent / 30.9% win rate; TANDEM (sister stock also at a new high) 228 / 56 / 21.6%. Lift -9.3 points, z -2.57. Requiring confirmation discarded 58% of signals and made the survivors WORSE. It is in the catalogue so it is not rediscovered, not so it can be scanned._

### Supply/demand zone entry (standalone)  ·  ~~REJECTED~~

`REJECTED_zone_entry` · long · **not scannable**

**Evidence.** Measured noise floor 99.5% — zones appear on essentially every random walk. A zone alone distinguishes nothing.

**Caveat.** zones_find is still useful for CONFLUENCE: quote the agreement count, never a lone zone. The 'unfilled orders' explanation is explicitly refused as evidence in the tool output.

| | |
|---|---|
| **Screener** | _none as a standalone_ |
| **Entry** | Only as one input among several. Never on the zone alone. |
| **Exit** | n/a |
| **TradingView indicators** | — |
| **Skills** | [supply-demand-setup](../skills/supply-demand-setup/SKILL.md) |
| **Tools** | `zones_find`, `levels_find` |
| **Risk rules** | — |

_"Supply/demand zone entry (standalone)" is tiered REJECTED: Measured noise floor 99.5% — zones appear on essentially every random walk. A zone alone distinguishes nothing. It is in the catalogue so it is not rediscovered, not so it can be scanned._

---

## Monthly — 11–252 trading days

Closed out by **a month or more, rebalanced monthly**.

> **Horizon evidence.** Partly the CONTESTED GAP. Continuation evidence only begins around ~63 trading days; 11 to 63 days has neither documented effect. Everything Tier A in this repo was measured at monthly cadence or longer, so this is where the evidence lives — but only past ~63 days.

### Time-series momentum, 12-month  ·  **A**

`momentum_12m` · long

**Evidence.** Moskowitz, Ooi & Pedersen (2012): 12-month lookback positive and significant for EVERY one of 58 futures over 25+ years. Composite Sharpe 1.28 vs 0.38 buy-and-hold.

**Caveat.** A PORTFOLIO result on 58 diversified futures. Applied to ONE equity it retains ~13% of its information ratio (IR = IC x sqrt(breadth)) and would take ~136 years to prove. Run edge_breadth before quoting the Sharpe.

| | |
|---|---|
| **Screener** | `morning-screen:tier_a_factors + screens:rs_leadership` |
| **Entry** | Monthly rebalance. Long the top decile of 12-month return, skipping the most recent month (the skip exists because the sub-21-day window is the reversal zone). |
| **Exit** | Monthly rerank. Exit when the name leaves the entry band — use the hysteresis exit, not a hard rank cut. |
| **Exit reason keys** | `time_elapsed`, `trend_broken` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [risk-sizing](../skills/risk-sizing/SKILL.md), [backtest-strategy](../skills/backtest-strategy/SKILL.md) |
| **Tools** | `momentum_read`, `edge_breadth`, `tier_a_factors`, `turnover_cost`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `max_portfolio_heat`, `concentration_cap` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(200)` | long-term trend intact |
| `sma_slope(200)` | `>` | `0` | and rising, not merely above |

The 12-month return itself is not an OPERAND, so these criteria are a proxy gate. momentum_read computes the real thing across 12m/6m/3m/1m and reports whether the horizons AGREE.

</details>

### Moving Average Distance (MAD)  ·  **A**

`moving_average_distance` · long

**Evidence.** Avramov, Kaplanski & Subrahmanyam (2021): ~9% annualised, INCREMENTAL to both momentum and the 52-week high, survives institutional trading costs. Stronger on the long side.

**Caveat.** A monthly cross-sectional STATE, not a crossover trigger. Reranking daily is 252 round trips a year — 50.4% drag at 20bps, 5.6x the whole effect. cadence.js enforces the monthly clock.

| | |
|---|---|
| **Screener** | `morning-screen:tier_a_factors` |
| **Entry** | Monthly. Long the top decile of sma(21)/sma(200) ratio across the universe. It is a RANK, not a threshold. |
| **Exit** | Monthly rerank with a hysteresis band (~0.96% net drag vs 2.4% for a hard monthly cut). |
| **Exit reason keys** | `time_elapsed` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]` |
| **Skills** | [risk-sizing](../skills/risk-sizing/SKILL.md), [backtest-strategy](../skills/backtest-strategy/SKILL.md) |
| **Tools** | `tier_a_factors`, `turnover_cost`, `costs_vs_edge`, `edge_breadth`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `concentration_cap` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `sma(21)` | `>` | `sma(200)` | short average above long — the MAD state |
| `close` | `>` | `sma(21)` |  |

</details>

### 52-week high proximity  ·  **A**

`near_52w_high` · long

**Evidence.** George & Hwang (2004): nearness to the 52-week high predicts returns and DOMINATES raw momentum in a joint test. Measured on 1000+ ranked stocks.

**Caveat.** Cross-sectional. A single name near its high tells you nothing without the ranking.

| | |
|---|---|
| **Screener** | `screens:near_52w_high` |
| **Entry** | Monthly. Long names within a few percent of their 52-week high, ranked by proximity. |
| **Exit** | Monthly rerank, or a close below the 50-day average. |
| **Exit reason keys** | `time_elapsed`, `trend_broken`, `ma_crossover` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]` |
| **Skills** | [risk-sizing](../skills/risk-sizing/SKILL.md), [market-structure](../skills/market-structure/SKILL.md) |
| **Tools** | `momentum_read`, `screens`, `edge_breadth`, `position_size_constrained`, `gap_risk` |
| **Risk rules** | `max_risk_per_trade`, `concentration_cap` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(200)` |  |
| `close` | `>` | `sma(50)` |  |
| `sma_slope(50)` | `>` | `0` |  |

Distance to the 52-week high is not an OPERAND; momentum_read returns fifty_two_week_high directly.

</details>

### High-volume return premium  ·  B

`high_volume_premium` · long

**Evidence.** Gervais, Kaniel & Mingelgrin (2001): unusually high volume predicts higher returns over roughly the following month.

**Caveat.** Measured as a MONTHLY sort, not as same-day breakout confirmation. Also: relative_volume_10d_calc from the TV scanner is the least trustworthy server-side field pre-open, so this factor is SUPPRESSED before the open — see scannerTrust().

| | |
|---|---|
| **Screener** | `morning-screen:tier_a_factors` |
| **Entry** | Monthly. Long names whose volume over the ranking window was unusually high relative to their own history. |
| **Exit** | One month. This effect has a stated decay. |
| **Exit reason keys** | `time_elapsed` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]` |
| **Skills** | [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `tier_a_factors`, `effort_vs_result`, `turnover_cost`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(50)` |  |
| `rvol` | `>` | `1.5` | intraday only — UNKNOWN on daily bars, which is correct |

</details>

### VCP base breakout (Minervini)  ·  B

`vcp_base_breakout` · long

**Evidence.** Measured selectivity: ZERO detections across 200 random walks — one of only three detectors in this repo with a 0% noise floor (with springs/upthrusts and pennants).

**Caveat.** A 0% noise floor proves the detector is SELECTIVE, not that the setup is PROFITABLE. No return evidence at any cadence. And the breakout it sets up is a CONTINUATION bet — place it in monthly, not weekly.

| | |
|---|---|
| **Screener** | `screens:volatility_contraction` |
| **Entry** | Buy the breakout above the base high. vcp_check names WHICH clause failed on a near miss, so a rejection is diagnosable. |
| **Exit** | Stop below the last contraction low. Target by measured base depth; trail with pivot_trail once a higher high confirms. |
| **Exit reason keys** | `stop_hit`, `target_hit`, `trend_broken`, `gap_against_trend` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [market-structure](../skills/market-structure/SKILL.md), [chart-patterns](../skills/chart-patterns/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `vcp_check`, `volatility_state`, `breakout_check`, `pivot_trail`, `position_size_constrained`, `horizon_prior` |
| **Risk rules** | `max_risk_per_trade`, `min_rr`, `concentration_cap` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(50)` |  |
| `sma_slope(50)` | `>` | `0` |  |
| `close` | `>` | `sma(200)` |  |
| `pullback_pct` | `<` | `12` | the final contraction must be tight |

</details>

### Cup with handle breakout (Bulkowski / O'Neil)  ·  C

`cup_with_handle` · long

**Evidence.** Bulkowski ranks the cup with handle 3 of 39 — break-even failure 5%, average rise 54%, 61% meeting the price target, 62% throwback, over 913 perfect trades (thepatternsite.com/cup.html, read 2026-07-30). That is the best rank of any pattern this toolchain can detect. It is HIS measurement on patterns HE selected by eye, not a peer-reviewed study and not a measurement made here.

**Caveat.** OUR DETECTOR IS NOT SELECTIVE, and the rank makes that easy to miss. cup.js CUP_NOISE_BASELINE: a qualifying cup appears on 23.5% of 300-bar random walks — nearly one in four, at the length the workflow loads — against 0% for VCP, pennants and springs, and closer to breakout_check's 32.5%. The floor CLIMBS with series length (7/11/23.5/35% at 150/200/300/400 bars) because the detector reports the best of every rim PAIR and pairs grow quadratically; quote candidates_scored with any detection. It is also a BRACKET, not a point: 8-52% across defensible settings of the two thresholds Bulkowski declined to give (rim tolerance, U/V cut), and even the tightest of those leaves it at 8-13%. Bulkowski selected his 913 samples visually ('I visually inspected the cups', 'Use your own judgment'), so his rank describes a set a human picked and does not transfer to one this code picks. Three further gaps: the 54% average rise is measured to the ULTIMATE HIGH before a 20% reversal gross of costs and is NOT a target; the detector applies depth bounds he does not, so it is stricter than the sample his numbers came from; and the breakout is a CONTINUATION bet, which is why this sits in monthly and not weekly.

| | |
|---|---|
| **Screener** | `screens:near_52w_high` |
| **Entry** | A CLOSE above the right cup lip. Bulkowski's own handle definition is 'the distance from the right cup lip to the breakout', so the lip is both the completion level and the entry. Do not anticipate it: a forming cup is a hypothesis, and 23.5% of 300-bar random walks have one. |
| **Exit** | Stop below the handle low — which by definition sits in the upper half of the cup, so the risk is bounded by construction. Targets: HALF the cup height is Bulkowski's own recommendation and is reached 76% of the time in a bull market; the full height is reached only 50%. Trail with pivot_trail once a higher high confirms, but run stopping_premium first — a trail is a bet on persistence. |
| **Exit reason keys** | `stop_hit`, `target_hit`, `trend_broken`, `gap_against_trend` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [chart-patterns](../skills/chart-patterns/SKILL.md), [market-structure](../skills/market-structure/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `patterns_detect`, `patterns_draw`, `breakout_check`, `horizon_prior`, `levels_find`, `pivot_trail`, `stopping_premium`, `position_size_constrained` |
| **Risk rules** | `max_risk_per_trade`, `min_rr`, `concentration_cap` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(200)` | a cup is a base inside an advance, not a bottoming attempt |
| `close` | `>` | `sma(50)` |  |
| `sma_slope(50)` | `>` | `0` |  |
| `pullback_pct` | `<` | `25` | the handle is a shallow pause off the rim, never half the cup |

The cup GEOMETRY is not expressible as operands — rim tolerance, U-shape and handle position all need the bar series, and patterns_detect computes them via src/core/cup.js. These four criteria gate the CONTEXT the geometry has to sit in, and every one of them is machine-checkable: close, sma(200), sma(50) and sma_slope(50) are OPERANDS, and pullback_pct is supplied by buildStructureContext. The shape itself comes from detectCup, which names the failing clause on a near miss.

</details>

### Leading stock in a leading group (Livermore)  ·  C

`group_leader_momentum` · long

**Evidence.** Livermore's Discovery 1 and 2: trade only the leaders, and group movement is the key to individual stock movement. "If you cannot make money out of the leading active issues, you are not going to make money out of the stock market." No measurement of the LEADER-selection part here either way.

**Caveat.** The group-CONFIRMATION half of his rule was measured and FAILED — see REJECTED_tandem_confirmation. What survives untested is the narrower idea of preferring the largest name in a strong group over a laggard. Source is a biographer's reconstruction, n = 1 trader, 1890s-1930s, and Livermore went bankrupt four times.

| | |
|---|---|
| **Screener** | `screens:group_leadership` |
| **Entry** | Long the largest-cap name in a group whose median member move is positive. Prefer a leader over a laggard: 'don't play in the junkyard with the weaker stocks.' Do NOT require the sister stock to confirm — that filter was measured and hurts. |
| **Exit** | Monthly rerank, or when the name's own trend breaks. His hard rule: never lose more than 10% of the capital committed to a trade, and never average down. |
| **Exit reason keys** | `time_elapsed`, `trend_broken`, `stop_hit`, `gap_against_trend` — log these, `exit_mix` reads them |
| **TradingView indicators** | `[object Object]`, `[object Object]`, `[object Object]` |
| **Skills** | [market-structure](../skills/market-structure/SKILL.md), [risk-sizing](../skills/risk-sizing/SKILL.md) |
| **Tools** | `group_context`, `relative_strength`, `momentum_read`, `position_size_constrained`, `horizon_prior`, `edge_breadth` |
| **Risk rules** | `max_risk_per_trade`, `concentration_cap`, `max_portfolio_heat` |

<details><summary>Machine-evaluable criteria</summary>

| Left | Op | Right | Note |
|---|---|---|---|
| `close` | `>` | `sma(200)` |  |
| `sma_slope(50)` | `>` | `0` | the name itself is trending |
| `close` | `>` | `sma(50)` |  |

Group membership and leadership are not OPERANDS — they come from group_context, which resolves them from the scanner's industry field. The criteria here gate the individual name only.

</details>

---

## What is deliberately absent

- **Opening Range Breakout as Crabel defines it** — needs the first thirty seconds of trade. The 5-minute version
  catalogued above is a proxy, not his rule.
- **The 1-2-3 / ignition pattern** — implemented in `src/core/ignition.js`, tested, and deliberately NOT
  registered as a tool, because its noise floor cannot be measured: the ATR gate shifts with any constructed null.
- **Anything requiring the tape or order flow** — several of Bellafiore's exits are order-flow judgements
  (`tape_seller`, `pattern_dissipated`). They are in the exit taxonomy, counted as unmodellable, and no strategy
  here depends on them.

## The horizon problem, stated once

Read this before trading anything in the **weekly** tier.

Below ~21 trading days the documented effect is **reversal**. Above ~63 it is **continuation**. Nearly every
structural detector in this repo — breakouts, flags, triangles, wedges, VCP — is a *continuation* bet, and the
weekly tier (2–10 days) places it exactly where continuation is weakest. Momentum's skip-month exists because
that boundary falls inside the swing window.

Between 11 and 63 days is the **contested gap**: neither effect is documented there, and it is where the monthly
tier begins. `horizon_prior` reports which side of the boundary a setup sits on. Run it before hunting a setup,
not after.

See [swing-evidence-review.md](swing-evidence-review.md) and [strategy-horizons.md](strategy-horizons.md).

