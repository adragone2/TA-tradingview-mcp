# Sunday review — the scheduled task

This is the prompt the weekly run executes. It lives in two places and they
must be kept in step:

- `~/.claude/scheduled-tasks/sunday-review/SKILL.md` — what actually runs
- this file — the version-controlled copy

## Where to see it

It appears in the app under **Routines** (Code tab), as
`Sunday review — Every Sunday at ~8:00 AM`.

It does NOT appear under **Scheduled** (Home tab). Those are two different
views, not two different stores — a task created through the `scheduled-tasks`
MCP server shows up in Routines only. Looking in the wrong one is why this
task seemed missing for a while.

## Settings

| Field | Value |
|---|---|
| Schedule | Every **Sunday** at **08:00** local |
| Runs on | **This computer** — it drives TradingView Desktop over CDP on port 9222 and cannot run in the cloud |

The machine must be awake and the app open at 08:00. If it is closed, the run
happens at next launch.

**Run it once manually after any change.** Tool approvals granted during a run
are remembered, so pre-approving stops an unattended Sunday run stalling on a
permission prompt.

## On launching TradingView

The task launches TradingView itself if CDP is unreachable, but only then.
`tv_launch` defaults to `kill_existing: true` — necessary when TradingView is
running *without* the debugging port, since reattaching it requires a restart,
and destructive if called against a healthy session. The prompt below gates the
launch on `tv_doctor` failing first, and re-checks afterwards because
`tv_launch` returns `success: true` even when CDP never came up.

## The prompt

---

Run the weekly Sunday review for the TradingView MCP project.

WORKING DIRECTORY: E:\git-repos\TA-tradingview-mcp

PREREQUISITES:

1. TradingView Desktop must be running with CDP on port 9222. Check with the `tv_doctor` tool.

   IF IT IS NOT RUNNING, OR CDP IS UNREACHABLE — launch it:
     - Call `tv_launch`. It starts TradingView with remote debugging enabled and waits up to 15 seconds for CDP.
     - `tv_launch` defaults to `kill_existing: true`, which is what you want when TradingView is running WITHOUT CDP — that is the only way to get the debugging port attached. But do NOT call it when tv_doctor already reports a healthy CDP connection: it would kill a working session for no reason and could lose unsaved chart work. Launch only when the check actually failed.
     - `tv_launch` returns `success: true` even when CDP did not come up — read `cdp_ready` and the `warning` field, do not trust the success flag.
     - After launching, wait ~10 seconds, then run `tv_doctor` AGAIN to confirm. A cold start also has to load the workspace and may need a login.
     - Only proceed once tv_doctor passes. If it still fails after one launch attempt, STOP and report exactly which check failed — do not retry in a loop and do not run the script blind.
     - Note in the final summary that you had to launch TradingView, so an unattended failure is visible rather than silent.

2. The TA API must be reachable. Verify with `ta_health`. If it is not, stop and say so — the review has nothing to validate against without it.

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
  1. Counts: how many analysed, how many failed, and the two summary distributions. Mention here if TradingView had to be launched.
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
- If old drawings appear stuck and `draw_clear` reports removed: 0, they are from a previous TradingView session — entity IDs are session-scoped so draw_clear cannot see them. Run `node scripts/clear-orphans.js` to inspect (dry run by default); `--all-mcp --apply` clears the charts. It matches our drawings by label text and leaves hand-drawn work alone. Mention it rather than doing it silently.

Keep the summary tight. The full detail is in the JSON; the conversation is for the parts that need a human.