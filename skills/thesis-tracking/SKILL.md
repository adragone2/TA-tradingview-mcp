---
name: thesis-tracking
description: Maintain a per-symbol view of bias, levels and reasoning over time, so technical reads accumulate instead of being thrown away each session. Use when the user asks "is my thesis on X still intact", "what did I think about X last week", or wants to record why they are watching a symbol.
---

# Thesis Tracking

`session_save` stores whole briefs by date. That answers "what did I think on Tuesday" but not "how has my view of AVGO evolved". This skill keeps the per-symbol thread.

## Step 1: Establish the current read

For the symbol in question:
1. `chart_set_symbol` then `chart_get_state`
2. `data_get_study_values` — indicator readings
3. `data_get_ohlcv` with `summary: true` — where price is in its range
4. `data_get_pine_lines` / `data_get_pine_labels` with `study_filter` — the levels the user's own indicators mark
5. `quote_get` — current price

## Step 2: Pull the history

Read prior sessions with `session_get` (walk back several dates if needed). Extract every mention of this symbol: bias, key level, what was being watched.

If `equity-research:thesis-tracker` is available, use it as the store — it owns the thesis format. Otherwise keep records under `theses/<SYMBOL>.md` in the repo:

```markdown
# <SYMBOL>

**Thesis:** <one or two sentences — the actual claim being made>
**Opened:** <date>  **Timeframe:** <bias timeframe>
**Invalidation:** <the specific level or condition that kills it>

## Log
- <date> — bias, price, key level, what changed, what you're watching
```

The **invalidation** line matters most. A thesis with no stated way to be wrong cannot be tracked, only rationalised.

## Step 3: Answer "is it still intact"

Compare the current read to the recorded thesis and say plainly which it is:

- **Intact** — the conditions still hold. Name which ones.
- **Weakening** — some conditions broken but not the invalidation level. Name what broke.
- **Invalidated** — the invalidation condition has triggered. Say so directly.

Then check whether the *reasoning* still holds, not just the price. A thesis that was "above the 20 EMA on the 4H with the ribbon up" is not intact just because price is higher — verify each stated condition against the readings.

Do not soften an invalidated thesis. The value of writing an invalidation level down in advance is entirely lost if it gets reinterpreted after the fact.

## Step 4: Append to the log

Add a dated line with the current bias, price, key level, and what changed since the last entry. Append — never rewrite history. Earlier entries being wrong is the useful part of the record.

If the thesis was invalidated, log that and mark it closed rather than deleting it. Closed theses are how the user learns which of their setups actually work.

## Step 5: Cross-check against the brief

When run as part of a morning routine, reconcile with `morning_brief`: if the brief grades a symbol bullish but its recorded thesis was invalidated last week, surface the contradiction. That disagreement is the most useful thing this skill produces.

## Guardrails

- Levels and conditions come from the data and from what the user wrote down. Do not author a thesis on the user's behalf — if none is recorded, ask what their actual claim is.
- Grade against the user's stated criteria, not your own view of the chart.
- "Still intact" is a factual check against recorded conditions, not a recommendation to hold, add, or exit.
