# Sunday review — scheduled task

The prompt below is the one to paste into the **Scheduled** panel's
`New task` dialog.

## Why this file exists

There are two schedulers on this machine and they do not share state:

| | Where | Shows in the Scheduled panel? |
|---|---|---|
| `scheduled-tasks` MCP server | `~/.claude/scheduled-tasks/` | **No** |
| Claude Desktop Scheduled panel | app store, not local | Yes |

A task created through the MCP server is real but invisible in the panel, so
if the panel is where the other jobs live, the task has to be created there —
by hand, through `New task`. Nothing in this repo can write to it.

## Settings

| Field | Value |
|---|---|
| Name | `Sunday review` |
| Schedule | Every **Sunday** at **08:00** |
| Runs on | **Your computer** (it drives TradingView Desktop over CDP on port 9222 — it cannot run in the cloud) |

**Run it once manually after creating it.** Tool approvals granted during a run
are remembered, so pre-approving stops an unattended Sunday run from stalling
on a permission prompt. It also proves the prerequisites before you are relying
on it.

The machine must be awake and the app open at 08:00 Sunday. If it is closed,
the run happens at next launch.

## The prompt

Paste everything below the line.

---

Run the weekly Sunday review for the TradingView MCP project.

WORKING DIRECTORY: E:\git-repos\TA-tradingview-mcp

PREREQUISITES — check these first and stop with a clear message if they fail:
1. TradingView Desktop must be running with CDP on port 9222. Verify with the `tv_doctor` tool. If it is not running, say so and stop — do not attempt to launch it.
2. The TA API must be reachable. Verify with `ta_health`.

STEP 1 — Read the skill:
Read skills/sunday-review/SKILL.md in full. It defines the procedure and the guardrails. Also read docs/sunday-review-schema.md for the output contract.

STEP 2 — Run the script:
    node scripts/sunday-review.js --out-dir reports

This takes 7-12 minutes for ~60 tickers. It drives the live chart through each symbol on the daily timeframe, computes the full assessment, draws the findings on each chart in a group named `sunday-<TICKER>`, and restores the original symbol when done. Let it finish. Do not run it with --no-draw; the drawings are part of the deliverable.

STEP 3 — Read the report:
Load reports/sunday-review-<TODAY>.json. Do NOT dump it into the conversation — it is large. Read it programmatically (node or python) and extract:
  - schema_version, counts (requested/analysed/failed)
  - ta_validation_summary and our_bias_summary
  - market_condition (especially broad_chop and choppy_share_pct)
  - every ticker where ta_validation.agreement is "CONTRADICTED" — with its contradictions array
  - every ticker where ta_validation.agreement is "DISPUTED"
  - the distribution of assessment.market_regime.regime across all tickers
  - any ticker with a live trade plan: assessment.trade_plans entries where tradeable_now is true
  - any ticker with a STABLE channel: assessment.channels where stable is true
  - any ticker with status "failed", and why

STEP 4 — Write the summary:
Produce a concise report for the user, in this order:
  1. Counts: how many analysed, how many failed, and the two summary distributions.
  2. Market condition ONCE, up front, if broad_chop is true — then do not repeat "choppy regime" per name.
  3. Every CONTRADICTION individually, with its numbers. These are cases where TA and a measurement on the bars assert incompatible things — they are the highest-value part of the report.
  4. DISPUTED rows as a table.
  5. Live trade plans (tradeable_now only) as a table: pattern, entry, stop, target, R:R — each with its base_rate failure figure beside it.
  6. Where to find the full report and how to see the drawings (draw_clear group="sunday-<TICKER>" removes them).

READING THE NEWER BLOCKS — these have specific traps:
- `trade_plans`: `tradeable_now: false` means the pattern is FORMING and its levels are a hypothesis, not a live setup. Do not present a forming pattern's entry as actionable.
- `trade_plans`: `bilateral: true` means BOTH legs are real — triangles, broadening formations and rectangles do not know which way they break. Never report only the leg that suits a thesis.
- `trade_plans`: `primary_leg` on a typed rectangle names the CONTINUATION, not the better trade. Bulkowski measures the upward break as better regardless of approach, so a bearish_rectangle's primary leg is the weaker of its two.
- `trade_plans`: R:R is arithmetic on the levels and is NOT evidence. Always quote it beside base_rate — a rising wedge can show R:R 5.46 while failing to move 5% fifty-one percent of the time.
- `channels`: consume `stable` and `windows_agreeing`, NOT `found`. Channels appear on 33.5% of random walks; only 12% of walks produce a stable one. A single-window channel is a fit, not a shape.

RULES — these are not optional:
- TA is the master system for WHAT to own. Never present the chart assessment as overriding it. The output is "our read agrees / disagrees / is silent", and what to do about it is the user's call.
- Never turn a disagreement into a recommendation.
- A ticker with status "failed" was NOT checked. It is unknown, not agreeing. Say so explicitly if any failed.
- "NO_SIGNAL" is not agreement either — it means nothing fired in either direction.
- Nothing in the output is trade advice. It renders the user's own system against their own charts.
- If the script crashes partway, the chart may be left on the wrong symbol. Check chart_get_state and report it.

HOUSEKEEPING:
- If old drawings appear stuck and `draw_clear` reports removed: 0, they are from a previous TradingView session — entity IDs are session-scoped so draw_clear cannot see them. Run `node scripts/clear-orphans.js` to inspect (dry run by default) and `--apply` to remove. It matches our drawings by label text and leaves hand-drawn work alone. Mention it rather than doing it silently.

Keep the summary tight. The full detail is in the JSON; the conversation is for the parts that need a human.