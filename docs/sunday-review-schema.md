# Sunday review — report schema v1.0

The contract for `reports/sunday-review-YYYY-MM-DD.json`. **Every ticker carries every key**, with `null` where a measurement was unavailable. A key is never absent, so a consumer can rely on the shape without defensive parsing, and "no value" is distinguishable from "no field".

Bump `schema_version` on any breaking change.

## Top level

```jsonc
{
  "schema_version": "1.0",
  "generated_at": "ISO-8601",
  "timeframe": "1D",
  "benchmark": "AMEX:SPY",
  "drawing_group_pattern": "sunday-<TICKER>",   // how to clear/find the drawings
  "counts":  { "requested", "analysed", "failed", "exits", "entries", "holdings" },
  "ta_validation_summary": { "CONFIRMED", "MIXED", "DISPUTED", "CONTRADICTED", "NO_SIGNAL" },
  "our_bias_summary":      { "BULLISH", "NEUTRAL", "BEARISH" },
  "market_condition": {
    "regime_counts":          { "choppy": 54, "mixed": 4 },
    "choppy_share_pct":       93.1,
    "median_efficiency":      0.15,
    "random_walk_efficiency": 0.183,   // 1/sqrt(window) — what NO signal looks like
    "broad_chop":             true,
    "note":                   "..."    // present only when broad_chop
  },
  "tickers": [ /* see below */ ]
}
```

## Per ticker

```jsonc
{
  "ticker": "AAPL",           // bare, no exchange prefix
  "symbol": "BATS:AAPL",      // what the chart actually returned
  "resolution": "1D",
  "bars": 300,
  "status": "ok" | "failed",
  "error": null,              // populated only when status is "failed"
  "side": "exit" | "entry" | "holding",

  "ta_suggestion": { ... },   // what TA said, unmodified
  "assessment":    { ... },   // OUR analysis — 26 blocks
  "our_view":      { ... },   // our independent call, made BEFORE consulting TA
  "ta_validation": { ... },   // whether the two agree
  "drawings":      { ... }    // what was drawn on the chart
}
```

**A `failed` ticker still carries every key**, with `assessment`, `our_view`, `ta_validation` and `drawings` all `null`. It was not checked — that is not the same as agreeing.

## `assessment` — one block per analysis type

Each maps to a skill in this repo.

| Block | Skill | Key fields |
|---|---|---|
| `market_regime` | chart-analysis | `regime`, `efficiency`, `random_walk_efficiency`, `vs_random_walk`, `tradeable`, `gate_note` |
| `market_structure` | market-structure | `trend`, `last_high/low`, `recent_events`, `last_leg`, `staleness_warning` |
| `multi_timeframe` | chart-analysis | `weekly_trend`, `alignment`, `permitted_direction`, `weekly_bar_partial` |
| `key_levels` | market-structure | `nearest_support/resistance` with `reason`, `all_supports/resistances`, `no_support_below` |
| `supply_demand_zones` | supply-demand-setup | `nearest_demand/supply`, `total_found` |
| `chart_patterns` | chart-patterns | `detected`, `sensitivity_sweep`, `stable_across_sensitivities`, `passes_stability_check`, `pivot_width`, `lmw_second_opinion_count` |
| `candlesticks` | chart-patterns | `recent` with Nison fields, `academic_verdict` |
| `momentum` | chart-analysis | `agreement`, `horizons`, `fifty_two_week_ratio`, `moving_average_distance` |
| `relative_strength` | chart-analysis | `leadership`, `high_warning` |
| `volume_analysis` | chart-analysis | `poc`, `value_area_*`, `price_vs_value_area`, `effort_vs_result` |
| `divergence` | chart-analysis | `agreement`, `count`, `total_found`, `indicators_checked`, `indicators_agreeing`, `agreement_direction` |
| `wyckoff` | chart-analysis | `phase`, `springs_upthrusts`, `interpretive: true` |
| `elliott` | chart-analysis | `valid_counts`, `distinct_recent_counts`, `sensitivities_run`, `agreement` |
| `fibonacci` | chart-analysis | `retraced_pct`, `in_golden_zone`, `targets`, `targets_refused_reason` |
| `liquidity` | supply-demand-setup | `anchored_vwap`, `price_vs_avwap`, `fair_value_gaps` |
| `volatility_contraction` | chart-analysis | `vcp_qualifies`, `contractions`, `pivot`, `failed_checks` |
| `horizon` | chart-analysis | `continuation_at_10d`, `reversal_at_10d`, `volatility_percentile` |
| `risk` | risk-sizing | `atr_14`, `stopping_premium_verdict`, `stop_adds_expected_return`, `stop_guidance` |
| `costs` | risk-sizing | `slippage_mean_pct`, `turnover_drag_10d_20bps_pct` |
| `level_pressure` | market-structure | `on_resistance`, `on_support` with readings. **Descriptive only** — the predictive claim failed out of sample (+39.1 in-sample, +4.6 on a fresh universe). Never write it as "likely to break" |
| `channels` | chart-patterns | `found`, `direction`, `stable`, `windows_agreeing`, `windows_tested`, `best`, `noise_baseline` |
| `trade_plans` | chart-patterns | array of `{pattern, status, family, bilateral, tradeable_now, legs, primary_leg, primary_note, base_rate}` |

Plus scalars: `price`, `as_of`, `range_low/high`, `off_high_pct`, `off_low_pct`.

### `channels`

A channel is a shape the trend-line detector cannot see — it names patterns by
whether boundaries CONVERGE or DIVERGE, and a channel's are parallel.

**Consume `windows_agreeing` and `stable`, not `found`.** Channels appear on
**33.5%** of random walks and 12% of walks yield one "stable" across three or
more window/sensitivity combinations. `found: true` on its own is weak
evidence. `windows_tested` is a count (12 by default), not the list of windows.

### `trade_plans`

Entry, stop and target for every detected pattern, as an array. Each entry:

```jsonc
{
  "pattern": "bullish_rectangle",
  "status": "forming",
  "family": "bilateral",
  "bilateral": true,
  "tradeable_now": false,        // false while FORMING — the levels are what WOULD confirm it
  "primary_leg": "long",         // typed rectangles only; null otherwise
  "primary_note": "Upward break continues the trend the range interrupted...",
  "legs": {
    "long":  { "side": "long",  "entry": 706.39, "stop": 671.87, "target": 741.22,
               "risk": 34.52, "reward": 34.83, "rr": 1.01, "note": "..." },
    "short": { "side": "short", "entry": 675.19, "stop": 709.72, "target": 640.36,
               "risk": 34.52, "reward": 34.83, "rr": 1.01, "note": "..." }
  },
  "base_rate": null              // Bulkowski's measured figures where they exist
}
```

Three rules for a consumer:

- **`tradeable_now: false` means do not treat the levels as live.** A forming
  pattern is a hypothesis; its entry is the price that would confirm it.
- **`bilateral: true` means BOTH legs are real.** Triangles, broadening
  formations and rectangles do not know which way they break. Taking only the
  leg that suits a thesis is how one ends up on the wrong side of a triangle.
- **`primary_leg` names the continuation, not the better trade.** A typed
  rectangle says which break continues the prior trend. Bulkowski measures the
  *upward* break as the better one regardless of approach — 15% break-even
  failure against 24-34% downward — so a `bearish_rectangle`'s primary leg is
  the weaker of its two.

**`rr` is arithmetic on the levels and is not evidence.** Read it beside
`base_rate`: a rising wedge can show R:R 5.46 while failing to move 5% **51%**
of the time.

### `divergence` and `elliott` — read the agreement, not the count

Both blocks gained fields when a key-name mismatch was fixed on 2026-07-28.
Until then `divergence.count` and `elliott.valid_counts` were **0 on every
row** — the script read keys the modules do not return, and a missing key
landing on `.length` or behind `?? 0` produces a plausible zero rather than a
null. The `agreement` prose in the same block said otherwise the whole time.

**`indicators_agreeing` is the field that matters.** A lone divergence appears
on **99%** of random walks, 7 times per walk; two or more indicators agreeing
appears on **13.5%**. Filter on the agreement count, never on `count > 0`.

**`distinct_recent_counts` is the Elliott finding.** Rule-valid counts exist on
**70.5%** of random walks. Disagreement across sensitivities is the reading,
not the count itself.

## `our_view` — the independent call

```jsonc
{
  "bias": "BULLISH" | "NEUTRAL" | "BEARISH",
  "conviction": "HIGH" | "MODERATE" | "LOW",   // forced to LOW in a choppy regime
  "bullish_factors": [ "..." ],
  "bearish_factors": [ "..." ],
  "cautions":        [ "..." ],
  "tradeable": true | false | null
}
```

Computed **before** TA is consulted, so the validation is not circular.

## `ta_validation`

```jsonc
{
  "ta_side":     "exit" | "entry" | "holding",
  "ta_action":   "TRIM",       // TA's own suggestion, echoed beside the verdict
  "ta_urgency":  "MODERATE",
  "ta_conviction": "HIGH",
  "agreement": "CONFIRMED" | "MIXED" | "DISPUTED" | "CONTRADICTED" | "NO_SIGNAL",
  "supports":        [ "..." ],
  "conflicts":       [ "..." ],
  "contradictions":  [ "..." ],   // incompatible claims, not differences of degree
  "catalyst_evidence": [ { "catalyst", "evidence_tier", "note" } ],

  // Present ONLY when TA listed this ticker on more than one side. The ticker
  // is analysed once; the other listings are recorded here rather than
  // producing a second row and a second set of drawings.
  "also_listed_as": [ { "side": "entry", "action": "BUY_ADD", "urgency": null } ]
}
```

**`also_listed_as` is a finding, not bookkeeping.** MRVL came back as both an
exit (`REVIEW`) and an entry (`BUY_ADD`) in the same run — TA wanting both out
of and into a name is worth surfacing.

| Value | Meaning |
|---|---|
| `CONFIRMED` | Support, no conflict |
| `MIXED` | Both |
| `DISPUTED` | Conflict, no support |
| `CONTRADICTED` | TA and a measurement assert **incompatible** things — always read these |
| `NO_SIGNAL` | Nothing fired either way. **Not agreement.** |

`evidence_tier` on each catalyst: `PORTFOLIO_ONLY`, `CROSS_SECTIONAL`, `DIRECTLY_TESTABLE`, `NOT_TECHNICAL`, `DESCRIPTIVE`, `UNCLASSIFIED`.

## `drawings`

```jsonc
{ "group": "sunday-AAPL", "shapes": 8, "items": [ "support 129.48", ... ], "errors": [] }
```

Drawn on that ticker's own chart so the report and the chart can be read against each other. Prior week's group is cleared first. **Only patterns that passed the stability check are drawn** — a pattern present at one sensitivity is a fit, not a shape, and does not belong on a chart.

Pattern **geometry** is drawn, not just the break level: wedges and triangles
via TradingView's own 5-point pattern tool anchored to real pivots, rectangles
as a box, flags and pennants as a pole line plus a pause box, tops and bottoms
as connected peaks plus a neckline. Channel boundaries draw as two parallel
lines. ENTRY/STOP/TARGET lines are drawn **only** for patterns that are
`tradeable_now`.

Remove with `draw_clear group="sunday-<TICKER>"`.

**Drawings from a previous TradingView session cannot be removed that way** —
entity IDs are session-scoped, so `draw_clear` cannot see them. Run
`node scripts/clear-orphans.js` (dry run by default, `--apply` to delete); it
matches them by label text and leaves hand-drawn work alone.

## Notes for a consumer

- Sorting by `ta_validation.agreement == "CONTRADICTED"` gives the rows needing a human.
- `our_view.bias` is independent of TA and can be consumed on its own.
- `assessment.market_regime.tradeable` is a cheap first filter: `false` means the chart is too choppy for anything else in the row to carry weight.
- Nothing here is trade advice. It renders the user's own system and their own chart.

## Calibration note — read before trusting an efficiency figure

A random walk over an n-bar window has expected efficiency **~1/√n**. At the default 30-bar window that is **0.183**. So an efficiency of 0.18 is not a weak signal — it is exactly what *no* signal looks like, and the 0.3 gate means "meaningfully better than random".

On the first full run **54 of 58 tickers were below the gate**. That is why "high conviction into a choppy regime" is recorded as a `conflict` rather than a `contradiction`: a flag that fires on 93% of rows is a market condition, not a per-ticker finding, and promoting it would drown the specific contradictions that do discriminate. The market-wide share is reported once, in `market_condition`.
