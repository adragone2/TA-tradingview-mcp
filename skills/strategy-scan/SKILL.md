---
name: strategy-scan
description: Turn a trading rule into machine-evaluable criteria, check it against a chart, and scan it across symbols. Use when the user describes entry rules with numbers in them, asks which symbols currently qualify, or wants a setup made objective and testable.
---

# Strategy Scan

Turning a rule the user says out loud into something that can be checked the same way twice.

## Why this exists

`rules.json` has always held `bias_criteria` as **prose** — "Price is above the 20 EMA on the 4H". A model reads that and grades it, which breaks three things:

- Two sessions can grade the same chart differently.
- It cannot be scanned across a watchlist deterministically.
- It cannot be backtested at all.

**A rule you cannot test is a preference, not a strategy.** The `strategies` block in `rules.json` holds criteria as data, so the same specification can be checked live, scanned across symbols, and measured historically — instead of three descriptions that quietly drift apart.

`bias_criteria` are not obsolete. They are fine for a narrative brief. They are just not a strategy.

## The format

```json
"strategies": {
  "my-setup": {
    "description": "...",
    "direction": "long",
    "criteria": [
      { "id": "above_200sma", "left": "price", "op": ">", "right": "sma(200)",
        "note": "why this rule exists" }
    ]
  }
}
```

**Operands:** `price`, `open`, `high`, `low`, `close`, `volume`, `prev_day_open/high/low/close`, `high_of_day`, `low_of_day`, `session_volume`, `pct_change_today`, `sma(N)`, `ema(N)`, `rsi(N)`, `atr(N)`, plain numbers — and any of those followed by `* / + -` and a number, e.g. `ema(8) * 0.97` for "within 3% of the 8 EMA".

**Operators:** `>` `>=` `<` `<=` `==` `!=`

Indicators are computed from the bars, not read off the chart, so a scan does not depend on which studies happen to be loaded on each symbol.

## Turning a spoken rule into criteria

When the user describes a setup, write down each condition and ask which are *comparisons* and which are not.

> "Above the 200 SMA, riding the 8 EMA, breaking out of a resistance it's tested three times."

- `price > sma(200)` — a comparison. ✅
- `price > ema(8) * 0.97` — a comparison. ✅
- "breaking out of a resistance tested three times" — **not a comparison.** It needs level detection, not a value.

**Say so rather than approximating it.** That last condition is what usually makes a setup selective; dropping it silently turns a strict setup into a loose filter that matches almost everything in a bull market. Use `levels_find` for it and read the `tests` count on the nearest resistance — see [market-structure](../market-structure/SKILL.md).

Exits, position sizing and partials are trade *management*, not entry criteria. They do not belong in `criteria`.

## Checking and scanning

```
strategy_list                                   → what is defined, and does it validate
strategy_check strategy_name="my-setup"         → against the chart, with actual values
strategy_scan strategy_name="my-setup" symbols=[...] timeframe="D"
```

`strategy_check` shows the number on **each side of every comparison**, so a fail is explicable rather than a verdict. Report those numbers, not just pass/fail.

`strategy_scan` drives the chart through each symbol and restores it afterwards.

### Three verdicts, not two

| Verdict | Meaning |
|---|---|
| `pass` | Every criterion held |
| `fail` | At least one criterion did not hold |
| `unknown` | At least one could **not be evaluated** |

**`unknown` is never a fail.** A 200-period average needs 200 bars; if only 120 loaded, that criterion is unresolved, and reporting it as "did not qualify" would be a lie that makes the scanner look like it is working while finding nothing. Raise `count`, or accept that the symbol was not checked.

When reporting a scan, keep unresolved symbols in their own list and call them **not checked**.

## Sanity-check the specification itself

Before presenting hits, ask whether the criteria are actually selective:

- **Everything passed?** In a bull market, "above the 200 SMA" matches most large caps. If a scan hits on every symbol, the specification is probably missing the condition that made the setup selective — usually the one that was not expressible.
- **Nothing passed?** Check for an `unknown` being misread, a wrong timeframe, or a criterion with a typo'd operand — `strategy_list` reports validation errors.

## Design the EXIT before testing — it decides whether the rule can exist

```
turnover_cost holding_days=<expected hold> entry_rank_pct=20 exit_rank_pct=50
```

Most rules written here exit when the entry condition is negated. **That is the maximum-turnover choice available**, and turnover is the single most reliable predictor of whether a strategy survives contact with reality.

De Groot, Huij & Zhou showed that adding **hysteresis** — waiting until a name crosses to the *opposite half* of the ranking rather than selling the instant it stops qualifying — more than halved turnover and trading costs **while increasing net returns**. Measured on a 20/50 band here: 50.4 trades a year down to 20.2, saving 6.05% annually.

So when writing criteria, write **two** thresholds:

- an **entry** threshold, tight
- an **exit** threshold, deliberately looser

A rule with a single threshold used for both is the naive high-turnover form, and `turnover_cost` says so in those words.

Also check the drag before writing anything: a 5-day hold at 20bps consumes **10.08% annually** before any edge exists. If the intended holding period cannot support the cost, that is the answer — no criteria are worth writing.

## Then test it

A strategy that has never been measured is a hypothesis. Once the criteria are written:

1. Draw the trades it would have taken and run `backtest_drawn`, or code it in Pine and run `backtest_strategy`.
2. **Always report buy-and-hold** — see [backtest-strategy](../backtest-strategy/SKILL.md).
3. **Pass the trial count** so the result gets a deflated Sharpe. Every variant you tried counts.

## A scan is a multiple-testing procedure — report it as one

`strategy_scan` returns a `selection_bias` block. **Read it before reporting hits.**

Checking 100 symbols against a 4-criterion rule is **400 individual tests**, and the names that come back are the extremes of that search. This is exactly the procedure White's Reality Check was written to invalidate: applied to technical trading rules, it turned a best rule earning ~32%/year into a **statistically insignificant** result once the size of the search was counted.

The block reports the test count, the hit rate, and how many hits the same rule shape would produce on **coin flips**. It cannot compute a p-value — the criteria are not independent and their real pass rates are unknown — so treat the coin-flip figure as a floor for intuition, not a significance test.

**What to say:** a hit means *the rule matched*, which you get for free by looking at enough symbols. It is not evidence the rule works. `what_would_be_evidence` in the output says where that comes from.

**The ordering problem, and the tool that fixes it.**

```
rule_select candidates=[{name, returns, signals}, ...] compare_at_bps=<your cost>
```

Bajgrowicz & Scaillet (7,846 rules, DJIA 1897–2011): *"trading rules that survive the inclusion of transaction costs are often not among those that perform best before costs. Transaction costs must be treated as endogenous and not exogenous to the selection process."*

Ranking on gross return systematically favours **high-turnover** rules — precisely the rules costs destroy. `rule_select` applies cost **per signal before** computing each rule's statistic, so turnover enters the ranking instead of being deducted from the winner afterwards.

Demonstrated on a constructed set: gross winner `churner_bigedge`, and at 20bps the winner is `patient_smalledge`. Ranking gross and costing after would have picked the wrong rule.

Three modes:

- **`break_even`** (default) — sweeps cost upward until the FDR approach detects nothing. That level is the **ex-ante break-even cost**, and it removes the need to guess a cost in advance.
- **`select`** — one cost level, reporting FDR+ (100% means the apparent performance is pure data snooping).
- **`persistence`** — re-selects every window and trades forward, testing whether the **selection procedure** works. Their most damning result was not that rules fail but that *"an investor would never have been able to select ex ante the future best-performing rules."*

**FDR needs scale.** Below ~50 candidates it says `underpowered` and points you at `deflated_sharpe`, which is built for the single-best-rule case. Measured: one genuine edge among 21 candidates is undetectable; the same edge among 201 is detected.

## Caveats to state

- **Sessions are grouped by UTC date.** Sound for US equities. **Not** sound for futures or FX whose session crosses midnight UTC, where `prev_day_*` means previous UTC date rather than previous trading session. The tools return `session_basis` saying so.
- **A hit is a snapshot**, true at that moment on that timeframe. It is not a signal and it does not persist.
- **These are the user's own criteria being checked.** Report a hit as "your specification currently matches", never as a recommendation.
- Pre-market values are not available unless extended-hours data is loaded on the chart.

## Operands added since this skill was written

- **Crosses are EVENTS**: `ema(8) crosses_above ema(20)`, `rsi(14) crosses_below 70`. `rsi > 50` is a *state* and fires on every bar of a trend. Using the state where the rule means the event is how a scan quietly stops meaning what it says — if the user says "crosses", write the cross.
- **Slope**: `sma_slope(20)`, `ema_slope(50)`, `rsi_slope(14)`, in percent per bar. A moving average's level says nothing about whether it is rising; "SMA20 sloping, not flat" needs this.
- **Structural values**, supplied by `levels_find` / `zones_find` rather than recomputed: `pullback_pct`, `nearest_level_tests`, `nearest_level_distance_pct`, `in_demand_zone`, `in_supply_zone`, `nearest_zone_distance_pct`. Absent that context they resolve to UNKNOWN, which is correct — a second implementation here would drift from the tools that draw the levels.
