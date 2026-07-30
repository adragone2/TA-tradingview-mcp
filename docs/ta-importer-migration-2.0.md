# Prompt for TA — migrate the Sunday review importer to schema 2.0

Hand this to whatever agent maintains the Tactical Alpha importer. It is written to
be pasted verbatim.

---

## The prompt

> The TradingView Sunday review report (`reports/sunday-review-YYYY-MM-DD.json`,
> delivered to this VPS every Sunday) has moved from **schema 1.0 to 2.0**. Update
> our importer.
>
> **Why it changed.** The review used to build its own analysis. It now runs the same
> unified workflow the rest of that toolchain uses, so every ticker carries ~23 extra
> context sections and a completeness score. Nothing was deleted or renamed in place —
> three keys moved one level down, under a new `analysis` object.
>
> **Detect the version, do not assume it.** The top-level `schema_version` field is
> `"2.0"`. Support both for one cycle: if `schema_version` starts with `"1."`, use the
> old paths; otherwise use the new ones. Do not date-switch — a re-run of an old
> report would break that.
>
> ### Required changes — three moved keys
>
> | Read this in 1.0 | Read this in 2.0 |
> |---|---|
> | `ticker.assessment` | `ticker.analysis.assessment` |
> | `ticker.our_view` | `ticker.analysis.verdict` |
> | `ticker.drawings` | `ticker.analysis.drawings` |
>
> The objects at those paths are **unchanged** — same fields, same shapes, same
> semantics. `assessment` still has its 28 blocks; `verdict` is still the independent
> call made before consulting TA.
>
> ### Unchanged — do not touch
>
> `ticker`, `symbol`, `status`, `error`, `side`, `ta_suggestion`, `ta_validation`,
> `resolution`, `bars`. Top level: `generated_at`, `timeframe`, `benchmark`,
> `drawing_group_pattern`, `counts`, `ta_validation_summary`, `our_bias_summary`,
> `market_condition`.
>
> ### New — import these, they are the point of the change
>
> **`ticker.analysis.completeness`** — the analysis is now scored against a 45-section
> contract. Fields: `complete` (bool), `required_done`, `required_total`,
> `required_applicable`, `missing[]` (each with `section`, `tool`, `why_it_matters`,
> `reason`), `not_applicable[]`, `summary` (a sentence).
>
> **Treat `missing` as a data-quality signal.** In 1.0 a section that failed to run was
> indistinguishable from one that ran and found nothing, so a partial analysis could be
> displayed as a complete one. If `complete` is false, surface it rather than rendering
> the ticker as fully analysed.
>
> **`not_applicable` is NOT a failure.** It means the section could not apply — a
> non-daily timeframe has no `horizon` prior, because that boundary is measured in
> trading days. Those tickers are correctly and completely analysed. Do not flag them.
> On a Sunday report the list is normally empty: every ticker gets a real `screens`
> evaluation, including ETFs and names outside the index universe.
>
> **`ticker.analysis.context.*`** — the new measurements. The ones most worth surfacing
> on a portfolio view:
>
> | Path | What it is |
> |---|---|
> | `context.portfolio_heat` | Total risk across the whole book. Read `heat_pct`, `within_limit`, `verdict`, `positions_priced` vs `positions_in_book`. **Sized against `equity_basis`, which is TA's own `summary.total_value_usd`** — not any other account figure. |
> | `context.position_and_calendar` | Whether it is held and whether it reports soon |
> | `context.pivot_trail` | Where a trailing stop goes on the current structure |
> | `context.short_interest` | FINRA, twice-monthly. **Quote `driver`, never bare days-to-cover** — 93% of large moves in that ratio were driven by volume, not the short position. |
> | `context.luld_band` | How far it can travel before halting. Tier 1 is 5%, not 10%, and bands double into the close. |
> | `context.stopping_premium` | Whether a stop ADDS expected return on this series |
> | `context.breakout_check` | The breakout criteria scored at each primary level |
> | `context.sizing` | Share count under the three constraints, with the binding one named |
> | `context.strategy_check` | Per-strategy criteria evaluation. **`matched: 0` with a `verdict` string is a real answer** — "passes no screen" — not an error. |
>
> **`ticker.analysis.entry_hypothesis`** — forward entry for both directions, with the
> 1× ATR stop check, the chase limit and any catalyst landing inside the hold. Most
> useful on `side: "entry"` rows.
>
> **`ticker.analysis.primary_levels`** — the swing-anchored primary support and
> resistance actually drawn on the chart, each with `price`, `side`, `anchor`.
>
> **`completeness_summary`** at the top level — `{ complete, incomplete }` counts.
>
> ### New top-level fields — EXCLUDED is not FAILED
>
> The review now covers **every position in TA's book**, not just the actionable list.
> Previously `--holdings` was opt-in and the scheduled job never passed it, so ~35 held
> positions were silently absent. Two new fields report what is deliberately not
> charted:
>
> | Field | What it is |
> |---|---|
> | `counts.excluded` | How many tickers were NOT charted on this layer |
> | `excluded_from_review[]` | One entry per excluded ticker: `{ ticker, side, kind, why }` |
>
> **Do not render an excluded ticker as failed, and do not render it as analysed.**
> They are three distinct states:
>
> - `counts.analysed` — charted and assessed
> - `counts.failed` — attempted and could not be read (too few bars, NAV-priced fund).
>   **Unknown, not agreeing.**
> - `counts.excluded` — not charted here at all, with a stated reason
>
> Today the whole excluded set is `kind: "crypto"` — 25 of 73. TA owns the crypto book
> on the investing layer; this is the equity trading layer. The positions are real and
> tracked on your side, they are simply not chart-analysed. Passing them to TradingView
> is also unsafe: `BTC-USD` silently resolves to the SPREAD `CRYPTOCAP:BTC-BATS:USD`,
> which returns bars that are not the price of Bitcoin.
>
> If you show a coverage figure, the honest denominator is
> `analysed + failed + excluded`, with excluded broken out — not folded into either.
>
> ### Acceptance
>
> 1. On a 2.0 report, every field the UI showed under 1.0 still renders.
> 2. `schema_version: "1.x"` still parses via the old paths.
> 3. No field renders as `None`/`null` across ALL rows — that is the signature of
>    reading a path that no longer exists, and it is how the `ta_action` bug survived
>    for weeks with passing tests.
> 4. A ticker with `completeness.complete === false` is visibly marked as partially
>    analysed.
> 5. `counts.analysed + counts.failed + counts.excluded` equals the number of TA
>    positions the review covered. If your coverage figure does not reconcile, you are
>    dropping one of the three states.

---

## Why this file exists

The owner's condition for accepting a breaking change: *"it is ok as long as you give
me a prompt for TA so it can fix the importer."*

There is precedent for needing it. `ta_validation.ta_action` was documented and never
emitted, so a consumer rendered "TA said: None (None)" on all 50 rows — and its own
tests passed the whole time, because the doc and the code disagreed rather than the
code being internally broken. Acceptance check 3 above exists specifically to catch
that shape of failure.
