# Routines

The workflows this toolchain exists to run. Each is a sequence you can follow directly; the linked skills carry the detail.

## Morning routine

Before the session. ~2–3 minutes for a 25-symbol watchlist.

1. **`tv_doctor`** — confirm the bridge is up. Everything below assumes it.
2. **`ta_regime`** — what regime, and what does TA say about sizing today (`max_new_position_pct`, `position_multiplier`)? This frames every decision that follows.
3. **`ta_alerts`** — anything critical? Stop breaches appear here, per ticker, with actions.
4. **`morning_brief`** — technical scan across your `rules.json` timeframes. Grade against your own `bias_criteria`, follow the `instruction` field in the response for the output contract.
5. **`ta_trading_context`** on the Tier A and B names — do you already hold them, do they report soon?
6. **`session_save`** — so tomorrow can diff against today.

Use [catalyst-aware-brief](../skills/catalyst-aware-brief/SKILL.md) to fold steps 4–5 together, or [morning-note](../skills/morning-note/SKILL.md) to produce it as written prose.

**KEY LEVEL must come from the data returned.** If nothing supports a level, write `n/a`.

## Sunday routine — the weekly review

Scheduled for Sunday mornings. Run it directly with:

```bash
node scripts/sunday-review.js --out-dir reports
```

7–12 minutes for ~60 tickers. It walks every ticker TA wants action on, on the
daily, computes the full assessment offline, draws the findings on each chart,
and restores the original symbol.

The procedure and the guardrails are in [skills/sunday-review/SKILL.md](../skills/sunday-review/SKILL.md);
the output contract is [sunday-review-schema.md](sunday-review-schema.md).

**Two schedulers exist on this machine and they do not share state.** A task in
`~/.claude/scheduled-tasks/` (the MCP scheduler) does NOT appear in the Claude
Desktop **Scheduled** panel, and vice versa. If the panel is where the other
jobs live, the task has to be created there by hand — see
[skills/sunday-review/scheduled-task-prompt.md](../skills/sunday-review/scheduled-task-prompt.md)
for the paste-ready prompt and settings.

It must run on **this computer** — it drives TradingView Desktop over CDP, so
it cannot run in the cloud, and the machine has to be awake with the app open.

## Working a single name

1. `chart_set_symbol` then `chart_get_state`
2. `ta_trading_context` — position and catalyst risk **before** analysing the setup, not after
3. [walls-overlay](../skills/walls-overlay/SKILL.md) if it's in TA's wall coverage
4. `data_get_study_values`, `data_get_pine_lines`, `data_get_ohlcv` (`summary: true`)
5. `draw_trade_plan` once the levels are decided — one call, returns R:R
6. `capture_screenshot` to confirm it rendered as intended

Cross-check the plan against `rules.risk_rules` and TA's regime sizing. A setup that fails the user's own R:R rule should be called out, not quietly drawn.

## Plotting gamma walls

Needs the **TA-Trading** layout, which carries the Institutional Matrix indicator.

```
layout_switch "TA-Trading"
walls_coverage            → is this symbol covered?
chart_set_symbol "AMD"
walls_apply               → writes TA's walls into the indicator, verified
```

Check `age_hours`. Past ~30h on a trading day, TA's scan didn't run — say so rather than presenting old positioning as live. The indicator renders its own `DATA FRESH` / `DATA STALE (Nh)` verdict; if it disagrees with you, trust it and investigate.

The indicator holds **one symbol's walls at a time**. `walls_apply_many` pre-loads a sweep as the chart passes through each symbol; it does not display them simultaneously.

## Reviewing a trade you already drew

```
draw_list include_points:true
```

Returns every drawing with coordinates and a `created_by_mcp` flag, so a plan drawn by hand can be read back and evaluated. Then `ta_trading_context` for position and event risk.

## Validating a rule (WRDS)

Not a daily routine — do it when you want to know whether a setup has ever worked.

```
wrds_backtest_signal
  tickers:    [...]
  conditions: [{indicator:"ema", period:20, op:"price_above"}, ...]
  horizons:   [5,10,20]      ← swing holds
```

Read the **baseline**, not the signal. And carry the caveats into whatever you report: overlapping windows, survivorship bias on a current watchlist, gross of costs, CRSP ends 2024.

## Housekeeping

- `draw_clear` — removes only what these tools drew; `group` clears one plan
- `node scripts/clear-orphans.js` — when `draw_clear` reports `removed: 0` but the chart is still covered. Entity IDs die with the TradingView session, so anything drawn before the app last restarted is invisible to `draw_clear`; this matches our drawings by label text instead. Dry run by default. Add `--all-mcp` to clear tracked drawings too — **that flag is the one that actually clears the charts** — and `--apply` to delete. Hand-drawn shapes are never touched
- `session_get` — what did we conclude yesterday
- `tv_doctor` — first stop whenever anything behaves oddly

## What this toolchain will not do

- Place, size, or execute an order. `replay_trade` moves only simulated positions inside TradingView's replay.
- Recommend a trade. It renders the user's criteria and TA's output as context.
- Invent a level, a date, or a freshness claim.
