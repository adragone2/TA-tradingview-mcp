---
name: backtest-strategy
description: Backtest a trading strategy three ways — a Pine strategy in the Strategy Tester, trades the user drew on the chart, or trades taken manually in Bar Replay — and always compare the result against buy-and-hold. Use when the user asks whether a strategy or setup works, wants a backtest, win rate, expectancy, or asks "did this ever work?".
---

# Backtest a Strategy

Three methods, one non-negotiable rule.

## The rule: always report the benchmark

**Net profit cannot distinguish a good strategy from a rising market.** A strategy showing a large profit over a decade tells you almost nothing until you know what simply holding the asset returned over the same bars.

`backtest_strategy` computes buy-and-hold automatically. For any other method, call `backtest_benchmark` and report it alongside.

Two things follow from this, and both are easy to get wrong:

- **Report return AND drawdown, never one number.** A strategy that matched the benchmark's return with half its drawdown is materially better, and net profit hides that entirely. Frequently that *is* the edge — the strategy's value was sitting out a crash, not picking better entries.
- **Beating the benchmark on return while tripling the drawdown is not a win.** Say which happened. `compareToBenchmark` deliberately refuses to collapse this into a single verdict.

## The second rule: always report the trial count

A benchmark stops net profit from flattering a rising market. **Nothing was stopping the result from flattering the search** until now.

A Sharpe ratio is a random variable. Search 200 strategies with **no edge at all** and the best of them scores:

```
annualised Sharpe    2.19
probabilistic Sharpe 0.985      ← looks like a discovery
deflated Sharpe      0.267      ← is not one
```

That is measured, in `tests/validation.test.js`, on pure random returns.

`evaluateTrades` now returns a `significance` block. **Read `verdict` first.**

- If you passed `trial_sharpes` (the Sharpe of *every* variant you tested, including the losers) it reports a **deflated Sharpe**. Below **0.95** is not a discovery.
- If you did not, `verdict` says `NOT CORRECTED FOR SEARCH` in those words. Do not quote `probabilistic_sharpe` as if it were the answer — that is the number the best of 200 no-edge strategies scores 0.98 on.

**Count honestly.** Every parameter you tried and discarded is a trial, including the ones you tried before writing the scan. The tool can only correct for the trials you tell it about, and it says so.

Also check `min_track_record_trades`: how many trades you need before a Sharpe this size is distinguishable from the benchmark at all. Fewer than that and there is no result yet, whatever the equity curve looks like.

## Expectancy is the headline, not win rate

**Win rate on its own is nearly meaningless.** A 30% win rate can be excellent and an 80% win rate can bleed money — win rate says nothing about the size of wins relative to losses.

Lead with **expectancy**: what an average trade was worth. Then payoff ratio, then win rate as context.

`expectancy_r` expresses it in units of risk. Check `expectancy_r_basis`:

- `"risk_per_trade supplied"` — measured against the real risk. Trustworthy.
- `"average loss"` — the fallback. Fine, but it means R is relative to how the losses actually came out, not to what was risked. Pass `risk_per_trade` when you know it.

## Method 1 — a Pine strategy in the Strategy Tester

For strategies expressed as code. Build with the [pine-develop](../pine-develop/SKILL.md) skill, then:

```
backtest_strategy
backtest_strategy risk_per_trade=100 max_trades=200
```

Returns computed statistics, the Strategy Tester's own metrics, and the benchmark comparison.

> **Both sets of numbers are shown deliberately.** The statistics are computed from the trades read off the chart; `tester_metrics` is what TradingView reports. **They should agree.** If they disagree, investigate — do not average them or pick the friendlier one. A disagreement usually means trades were truncated or a profit field was misread.

Check `unusable_trades`. Those had no readable profit and were **excluded, not counted as zero** — a zero would quietly drag expectancy toward zero. If the count is high, the statistics cover a biased subset and you should say so rather than reporting them flatly.

Check `truncated` too. Statistics over the first 100 of 400 trades are not statistics over the strategy.

## Method 2 — trades the user drew

For discretionary setups that were never coded. The user draws Long/Short Position tools on historical bars; each is walked forward through the bars that followed to see whether stop or target came first.

```
backtest_drawn
backtest_drawn risk_per_trade=200 count=2000
```

Three fields you must not skip:

| Field | Why it matters |
|---|---|
| `ambiguous_note` | Trades where one bar contained **both** stop and target. Resolved as **losses**, because assuming the target came first is how a backtest talks itself into an edge that was never there. On a lower timeframe some may have been wins — say how many. |
| `open_note` | Trades that never reached stop or target in the loaded bars. **Excluded** from statistics — an unresolved trade is missing data, not a scratch. |
| `planned_rr` vs `r_multiple` | What the user intended versus what happened. |

If `ambiguous` covers a large share of the resolved trades, the result rests mostly on that pessimistic assumption. Report the share; do not present the win rate as settled.

**Entry is assumed filled at the drawing's anchor bar**, and resolution starts at the bar *after* it — never on the entry bar itself, which would let price action preceding the entry decide the outcome.

## Method 3 — Bar Replay, trade by trade

For practising execution. Use the [replay-practice](../replay-practice/SKILL.md) skill to step through bars and record trades, then score them:

```
backtest_evaluate trades=[{entry: 100, exit: 110, direction: "long"}, ...]
backtest_benchmark
```

Supply `profit` directly, or `entry`/`exit`/`direction` and it will be derived. Then report the benchmark next to it.

## Interpreting the result

| Reading | What it means |
|---|---|
| `expectancy` ≤ 0 | The system lost money per trade over this sample. Say so plainly. |
| `profit_factor` < 1 | Gross losses exceeded gross profits. |
| `max_consecutive_losses` | The run the user must be able to sit through. A positive expectancy is worthless if the drawdown is unbearable. |
| `by_direction` | Longs and shorts often differ sharply. A strategy profitable only long, in a rising market, may be the benchmark in disguise. |
| Few trades | 10 trades is an anecdote. Do not present it as evidence. |

## What a backtest cannot tell you

State these when the result looks good — they are the reasons a good backtest still fails live:

- **No slippage, commission or spread** unless the Pine strategy modelled them.
- **Survivorship and selection.** Backtesting one symbol you already know went up is not evidence.
- **Overfitting.** Parameters tuned until the result looked good describe the past, not the future. If the user tuned then re-ran, say the result is now in-sample — and pass the trial count so `deflated_sharpe` can price it.
- **Costs applied after selection are the wrong costs — and `rule_select` fixes this.** Pass every variant with its signal count and it costs them BEFORE ranking, returning an ex-ante break-even cost. Bajgrowicz & Scaillet (7,846 rules, DJIA 1897–2011) showed that *"trading rules that survive the inclusion of transaction costs are often not among those that perform best before costs"* — costs must be endogenous to the selection, not subtracted afterwards. Our tooling ranks first and costs after, so **the winner you are looking at may not be the winner that survives costs.** State this when a scan chose the strategy.
- **Selecting the rule ex ante is the part that fails.** In that same study, even with a more powerful selection method (False Discovery Rate), *"an investor would never have been able to select ex ante the future best-performing rules"*, and out-of-sample **5–35bps of cost offset any performance**.
- **The ambiguous-bar assumption** above.
- One symbol, one timeframe, one period.

For a properly out-of-sample check across many names and years, the WRDS layer (`wrds_backtest_signal`) is the right tool — and note that a previous WRDS run on this project's own criteria found **no edge** (edge/stderr well below 2). That is the normal result, not a malfunction.

## Guardrails

- Report what the tools returned, including warnings. A partial result is not a success.
- Never present a backtest as a prediction. It is a measurement of the past under stated assumptions.
- Nothing here is trade advice. It is arithmetic on the user's own rules and drawings.

## Turnover — run this BEFORE the backtest, not after

```
turnover_cost holding_days=<avg hold> round_trip_bps=<your cost>
```

Cost sensitivity scales with the **inverse of holding period**, and the arithmetic eliminates most swing systems before any signal work begins:

| Hold | Round trips/yr | Drag at 20bps |
|---|---|---|
| 3 days | 84 | **16.8%** |
| **5 days** | **50.4** | **10.08%** |
| 20 days | 12.6 | 2.5% |
| 60 days | 4.2 | 0.8% |

**Very few of the documented effects in this literature are large enough to absorb 10% a year.** If a strategy's holding period implies a drag its edge cannot cover, that is the finding — report it and stop, rather than backtesting a system that cannot exist.

**And check the exit rule.** Exiting the moment the entry condition is negated is the *maximum-turnover* choice available. De Groot, Huij & Zhou showed that waiting until a name crosses to the **opposite half of the ranking** more than halved turnover and costs **while increasing net returns** — 30–50bps per week after costs in large caps. `turnover_cost` computes the saving; measured on a 20/50 band it took 50.4 trades a year down to 20.2, saving 6.05% annually.

This is close to free and almost no discretionary system does it.

`turnover_cost` also measures **signal-to-fill slippage** from the real bars — the systematically adverse close-to-next-open gap. It is separate from spread and commission and must be added to them.

## Costs — a backtest without them flatters itself

`resolveTrade` fills at the exact stop or target price. There is no spread, slippage, commission or borrow in that number, and those are not free.

```
trade_cost preset=ibkr_pro_fixed entry=.. stop=.. shares=.. atr=..
costs_vs_edge expectancy_r=<from backtest_evaluate> cost_in_r=<from trade_cost>
gap_risk stop_distance_pct=..
```

- Report **net** expectancy alongside gross. An edge smaller than its costs is a losing strategy however good the equity curve looked.
- Costs scale with **turnover**. Pass `trades_per_year` — the same per-trade cost hurts a 200-trade strategy a hundred times more than a 2-trade one.
- The IBKR preset's **$1.00 per-order minimum** is the part that matters for small size: a 100-share order pays double the per-share rate, a 50-share order quadruple.
- **`gap_risk` measures what the cost model cannot fix.** A stop is a market order once touched, so a gap fills at the open, not at the stop. Every backtest here understates its worst losses by roughly that much. State the figure; do not pretend it is corrected.
