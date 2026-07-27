---
name: pine-develop
description: Full Pine Script development loop — write code, compile, fix errors, iterate. Use when building a new indicator or strategy in TradingView.
---

# Pine Script Development Loop

You are developing a Pine Script indicator or strategy in TradingView. Follow this loop precisely.

## Step 1: Understand the Goal

If not already clear, ask the user:
- What type? (indicator, strategy, library)
- What does it do? (entry/exit logic, overlay, oscillator, etc.)
- Overlay or separate pane?
- Any specific inputs or visual elements?

## Step 2: Pull Current Source (if modifying)

If modifying an existing script:
```bash
node scripts/pine_pull.js
```
Then read `scripts/current.pine` to understand what's there.

If creating new: start from scratch.

## Step 3: Write the Pine Script

Write the complete script to `scripts/current.pine`. Every script MUST include:
- `//@version=6` header
- Proper `indicator()` or `strategy()` declaration
- All user inputs with `input.*()` functions and groups
- Clear comments for each logical section

For strategies, include:
- `strategy.entry()` and `strategy.exit()` calls
- Position sizing via `strategy()` declaration
- Default commission and slippage settings

## Step 4: Push and Compile

```bash
node scripts/pine_push.js
```

This injects the code into TradingView's Pine Editor, clicks compile, and reports any errors.

## Step 5: Fix Errors

If errors are reported:
1. Read the error messages (line number + description)
2. Edit `scripts/current.pine` locally — fix the specific lines
3. Push again: `node scripts/pine_push.js`
4. Repeat until 0 errors

Common Pine Script errors:
- **"Mismatched input"** — usually indentation (Pine uses 4-space indentation, not braces)
- **"Could not find function or function reference"** — typo in function name or wrong version
- **"Undeclared identifier"** — variable used before declaration
- **"Cannot call X with argument type Y"** — wrong parameter type

## Step 6: Verify on Chart

After clean compilation:
1. `capture_screenshot` — take a screenshot to verify it looks right
2. `data_get_strategy_results` — if it's a strategy, check performance
3. Show the user the results

## Step 7: Iterate

If the user wants changes:
1. Pull fresh: `node scripts/pine_pull.js` (in case TV modified anything)
2. Edit locally
3. Push + compile
4. Screenshot to verify

IMPORTANT: Always compile after every change. Never claim "done" without a clean compile.

## Pine v6: the changes that break code silently

Most v6 changes throw a compiler error and are self-correcting. These do not — they compile and return **different numbers**, which is worse. Check for them before trusting any script carried over from v5.

| Change | What breaks |
|---|---|
| **Integer division is now fractional** | `5/2` returns `2.5`, not `2`. Any index or bar-count arithmetic that relied on truncation is now wrong. Wrap in `int()`. |
| **`timeframe.period` includes the multiplier** | `"1D"` not `"D"`, `"1W"` not `"W"`. Every string comparison against `"D"` silently stops matching. |
| **Strategy `default_qty`/margin defaults to 100** | Was 0 (no margin checking). Shorts can now trigger margin calls that did not exist in v5, so a backtest carried over reports different results for the same logic. |
| **`and` / `or` evaluate lazily** | Short-circuiting means a function call on the right-hand side may never run. If it had a side effect — a `label.new`, an array push — that side effect is now missing. |
| **`for` end boundary re-evaluated each iteration** | A loop whose bound changes inside the body now runs a different number of times. |
| **`strategy.exit()` honours both relative and absolute params** | v5 ignored the relative one when an absolute was present; v6 evaluates both and takes whichever triggers first. Exits fire earlier. |
| **Colour constants changed** | `color.red`, `color.teal`, `color.yellow` all have new hex values, and default label text went black → white. |

Errors you *will* see, and the fix:

- **No implicit int/float → bool.** Wrap in `bool()`.
- **Booleans can no longer be `na`.** An undefined condition is now `false`. `na()`, `nz()`, `fixnan()` reject bool arguments.
- **`when` removed** from every `strategy.*` command. Use an `if`.
- **`transp` removed** from `plot`, `bgcolor`, `fill`, `plotshape`, `plotchar`, `plotarrow`. Use `color.new(col, transp)`.
- **UDT field history**: `myObject.field[10]` is gone. Use `(myObject[10]).field`.
- **No history on literals**: `6[1]` and `true[10]` are errors.
- **`offset` in `plot()` must be simple**, not series.

New and useful: negative array indices (`array.get(a, -1)` for the last element), and `request.*()` runs dynamically without `dynamic_requests = true`.

## Repainting

The single most dangerous line in Pine:

```pine
request.security(sym, tf, expr, lookahead = barmerge.lookahead_on)
```

**With `lookahead_on` and no `[1]` offset, this returns future data on historical bars.** The backtest looks superb and the strategy cannot be traded. If you see `lookahead_on` in a script, check for the offset before anything else.

The safe form pairs them:

```pine
request.security(sym, tf, expr[1], lookahead = barmerge.lookahead_on)
```

Causes, and what to do:

| Cause | Fix |
|---|---|
| Realtime high/low/close move within the bar | Gate on `barstate.isconfirmed`, or reference `close[1]` |
| `request.security` returns unconfirmed values in realtime | The `[1]` + `lookahead_on` pair above |
| Lower-timeframe `request.security` | Use `request.security_lower_tf()` — intrabars are unsorted in realtime and this cannot be reproduced historically |
| `varip` | Cannot replicate on historical bars; backtests using it are unreliable |
| `calc_on_every_tick = true` | Backtest results are not reproducible |

`barstate.isnew` and `timenow` behave differently historically and in realtime — both repaint.

**Not all repainting is bad.** A volume profile that updates as the bar forms is repainting and is fine, provided the user knows. What is never fine is a signal that appears in hindsight where it did not appear live. When reviewing a script, say which kind it is.

> Source: TradingView Pine Script v6 documentation — migration guide and the Concepts › Repainting page, read July 2026.
