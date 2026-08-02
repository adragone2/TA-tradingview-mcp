/**
 * WHAT A TICKER ANALYSIS MUST CONTAIN, as data.
 *
 * The ticker workflow is 29 tool calls described in prose in a skill file. Prose
 * only runs if it is read, followed, and not skipped — and nothing checked. Every
 * gap found in the first live run was found by the OWNER, not by the toolchain:
 * pattern detection was missing entirely, there was no forward entry price, the
 * chart was drawn on top of stale shapes, the level filter was wrong, and the
 * indicator budget was exceeded.
 *
 * The owner's objection is the right one: *"manual step means I need to ask you to
 * perform it, and so if I forget it is equivalent to not having the tool."*
 *
 * So the contract is data, and an analysis is scored against it. A section that did
 * not run appears in `missing` with the reason. Silence is no longer possible —
 * which is the only property that actually fixes this, because a step that is
 * merely documented can still be forgotten.
 *
 * REQUIRED means an analysis without it is incomplete and must say so.
 * ADVISORY means it improves the answer but its absence is not a defect.
 *
 * Pure.
 */

export const SECTIONS = Object.freeze([
  // required: an analysis without these is incomplete and must say so
  { key: 'position_and_calendar', required: true, tool: 'ta_trading_context', why: 'Whether it is already held, and whether it reports soon. Both change the answer, and finding out afterwards wastes the analysis.' },
  { key: 'screens', required: true, tool: 'ticker_playbook', why: 'Which of the 9 screens it passes, clause by clause, and the strategies each implies.' },
  { key: 'market_regime', required: true, tool: 'assess().market_regime', why: 'Efficiency against the random-walk baseline. A choppy reading is the gate saying do not hunt.' },
  { key: 'horizon', required: true, tool: 'horizon_prior', why: 'Below ~21 trading days the documented effect is REVERSAL, and nearly every structural setup here is a CONTINUATION bet.' },
  { key: 'structure', required: true, tool: 'structure_analyze', why: 'Trend, swings, BOS and CHoCH - and the swing extremes the primary levels anchor to.' },
  { key: 'levels', required: true, tool: 'levels_find', why: 'Support and resistance with the evidence behind each.' },
  { key: 'patterns', required: true, tool: 'patterns_detect', why: 'Missing entirely from the first live analysis. "No pattern" is a result and must be reported.' },
  { key: 'momentum', required: true, tool: 'momentum_read', why: '12m/6m/3m/1m at once. Horizons disagreeing IS the answer.' },
  { key: 'trade_plans', required: true, tool: 'assess().trade_plans', why: 'Entry, stop, target and R:R per pattern, with Bulkowski base rates attached. The primary plan source.' },
  { key: 'strategy_check', required: true, tool: 'strategy_check', why: 'Every non-REJECTED strategy the screens named, evaluated criterion by criterion against the bars. A screen says worth looking at; this says whether the rules actually hold.' },
  { key: 'entry_hypothesis', required: true, tool: 'entry_hypothesis', why: 'The forward half, both directions, with the 1x ATR stop check, the chase limit and the catalyst conflict that trade_plans does not carry.' },
  { key: 'drawings', required: true, tool: 'draw_clear(all) + drawFindings', why: 'Cleared FIRST, then geometry, channels and the primary levels. A stale drawing is indistinguishable from a finding.' },

  // advisory: improves the answer, absence is not a defect
  { key: 'legs', required: false, tool: 'legs_classify', why: 'Impulse vs pullback, and time corrections a depth rule cannot see.' },
  { key: 'benchmark', required: false, tool: 'AMEX:SPY bars', why: 'What relative strength compares AGAINST. Without it assess() still returns a relative_strength block, with every field null — the section reads as run and measured nothing.' },
  { key: 'relative_strength', required: false, tool: 'relative_strength', why: 'Strong needs a compared-to-what.' },
  { key: 'multi_timeframe', required: false, tool: 'mtf_analyze', why: 'The higher timeframe is CONTEXT, not a verdict - it inverted over 903k observations.' },
  { key: 'volatility', required: false, tool: 'volatility_state', why: 'Coiled or expanded. A volatility STATE, never a direction.' },
  { key: 'vcp', required: false, tool: 'vcp_check', why: 'A 0% noise floor, so a pass here is worth something.' },
  { key: 'divergence', required: false, tool: 'divergence_survey', why: 'Only agreement across indicators counts; one alone is 99% noise.' },
  { key: 'zones', required: false, tool: 'zones_find', why: 'Supply and demand. A zone alone has a 99.5% noise floor - quote confluence.' },
  { key: 'wyckoff', required: false, tool: 'wyckoff_phase / wyckoff_spring', why: 'classifyPhase never abstains (100% on noise) so a phase is descriptive; springs are 0%.' },
  { key: 'elliott', required: false, tool: 'elliott_survey', why: 'Every rule-valid count, never one. Disagreement across sensitivities is the finding.' },
  { key: 'fibonacci', required: false, tool: 'fib_levels / fib_targets', why: 'Extensions find exits, retracements find entries. They get confused constantly.' },
  { key: 'liquidity', required: false, tool: 'liquidity_pools', why: 'Where stops are likely clustered.' },
  { key: 'gaps', required: false, tool: 'gap_classify', why: 'Common / breakaway / runaway / exhaustion, both noise arms run. common fires AT its null — breakaway is the one selective class.' },
  { key: 'candlesticks', required: false, tool: 'candle_read', why: 'A DESCRIPTION of what the bar did. Failed two independent academic tests as a signal.' },
  { key: 'volume_analysis', required: false, tool: 'volume_profile / effort_vs_result', why: 'Whether the move is being paid for.' },
  { key: 'level_pressure', required: false, tool: 'level_pressure', why: 'Whether attempts are strengthening. Its predictive claim FAILED out of sample - description only.' },
  { key: 'channels', required: false, tool: 'assess().channels', why: 'Boundaries with containment, R2 and stability across 12 windows.' },
  { key: 'costs', required: false, tool: 'trade_cost / costs_vs_edge / turnover_cost', why: 'An edge smaller than its costs is a losing strategy.' },
  { key: 'risk', required: false, tool: 'gap_risk / stops', why: 'How often price GAPPED past a stop. Every backtest here understates it.' },
  { key: 'group', required: false, tool: 'group_context', why: 'Which industry group, who leads it. DESCRIPTION only - two-leader agreement cost 9.3 points.' },
  { key: 'regime', required: false, tool: 'ta_regime', why: 'TA regime and position sizing for today.' },
  { key: 'short_interest', required: false, tool: 'short_interest', why: 'FINRA, twice a month. Quote the driver, never bare days-to-cover - 93% of large moves in that ratio were volume, not the short position.' },
  { key: 'stopping_premium', required: false, tool: 'stopping_premium', why: 'Whether a stop ADDS expected return on this series. Always negative under a random walk.' },
  { key: 'edge_breadth', required: false, tool: 'edge_breadth', why: 'What a published edge is worth at one position. Momentum retains 13% of its IR.' },
  { key: 'stage_plan', required: false, tool: 'stage_plan', why: 'Shannon four-stage alignment. Forward-tested NEGATIVE as a gate - description only.' },
  { key: 'timeframe_plan', required: false, tool: 'timeframe_scale', why: 'Lookbacks scale LINEARLY, stops as the SQUARE ROOT. Scaling a stop linearly is the common error.' },
  { key: 'luld_band', required: false, tool: 'luld_band', why: 'How far it can run before halting. Tier 1 is 5%, not 10%, and bands double into the close.' },
  { key: 'breakout_check', required: false, tool: 'breakout_check', why: 'The five breakout criteria, scored at each PRIMARY level rather than at a level chosen by hand.' },
  { key: 'pivot_trail', required: false, tool: 'pivot_trail', why: 'Where a trailing stop goes. One-directional ratchet; check stopping_premium first.' },
  { key: 'atr_trail', required: false, tool: 'stops.atrTrail', why: 'The chandelier series beside the pivot staircase — TA renders both, and a single stored value is not visually comparable. Same caveat: a trail is a persistence bet.' },
  { key: 'cycle', required: false, tool: 'stage_history', why: 'The owner\'s four-state machine: current state, the last boundaries, occupancy. Entry state fires on 43-52% of random walks and is unpaid at the swing horizon — the floor rides in the section.' },
  { key: 'walls', required: false, tool: 'walls_get', why: 'Options walls from TA. Drawing them needs the TA-Trading layout; the data reads anywhere.' },
  { key: 'level_test_history', required: false, tool: 'level_test_history', why: 'Every test of every level, with all four measurement arms attached.' },
  { key: 'scaling_exponent', required: false, tool: 'scaling_exponent', why: 'Whether the series trends or mean-reverts, as a property of the data rather than a citation.' },
  { key: 'portfolio_heat', required: false, tool: 'portfolio_heat', why: 'Total risk across the book. Six 1% positions are not 6% if they move together.' },
  { key: 'sizing', required: false, tool: 'position_size_constrained', why: 'The minimum of three constraints. Needs an account size to be meaningful.' },
]);

/**
 * Analysis capability this workflow does NOT run.
 *
 * EMPTY, and that is the point. It used to hold thirteen entries, each with a
 * reason that was true and useless — "needs a strategy chosen first", "needs a
 * level chosen first", "needs an account size". Every one of those inputs was
 * already sitting in this function: the strategies come from the screens, the
 * levels from the primaries, the account from rules.json.
 *
 * The owner's ruling: *"we need to have the missing 13 in the workflow."* A
 * declared skip is still a step somebody has to remember, and a step somebody has
 * to remember is a step that eventually does not happen.
 *
 * Kept as an export so a future addition has an obvious home — and so that adding
 * one means writing down why, in front of this comment.
 */
export const NOT_IN_WORKFLOW = Object.freeze([]);

export const REQUIRED_KEYS = Object.freeze(SECTIONS.filter((s) => s.required).map((s) => s.key));

/**
 * Score a run against the contract.
 *
 * `results` maps a section key to `{ ok, error?, skipped?, reason? }`. Anything not
 * present at all is treated as NOT RUN, which is the case that used to be invisible.
 */
export function scoreAnalysis(results = {}) {
  const done = [];
  const missing = [];
  const advisory_missing = [];
  const not_applicable = [];

  for (const s of SECTIONS) {
    const r = results[s.key];
    const ran = r && r.ok && !r.skipped;
    /**
     * NOT APPLICABLE is not NOT RUN, and conflating them breaks the score.
     *
     * `horizon` is required and is measured in TRADING DAYS, so on a 5-minute chart
     * it does not describe the position either way. Counting that as a failure made
     * every intraday analysis report 11/12 INCOMPLETE — and a score that cries wolf
     * on correct behaviour is a score nobody reads, which is the one thing this
     * mechanism cannot afford: it exists so a genuinely skipped step is impossible
     * to miss.
     *
     * Still listed, never silent. A section that does not apply has to say so.
     */
    if (!ran && r?.not_applicable) {
      not_applicable.push({ section: s.key, tool: s.tool, reason: r.reason || 'not applicable here' });
      continue;
    }
    if (ran) { done.push(s.key); continue; }
    const entry = {
      section: s.key,
      tool: s.tool,
      why_it_matters: s.why,
      reason: r?.error ? `failed: ${r.error}` : (r?.reason || (r ? 'skipped' : 'NOT RUN — no result was recorded for this section')),
    };
    if (s.required) missing.push(entry); else advisory_missing.push(entry);
  }

  const requiredTotal = REQUIRED_KEYS.length;
  const requiredNa = not_applicable.filter((n) => REQUIRED_KEYS.includes(n.section)).length;
  const requiredDone = requiredTotal - missing.length - requiredNa;

  return {
    complete: missing.length === 0,
    required_done: requiredDone,
    required_total: requiredTotal,
    sections_run: done,
    // Required sections that do not apply at this timeframe. Excluded from the
    // denominator rather than counted as done — neither a pass nor a failure.
    not_applicable,
    required_applicable: requiredTotal - requiredNa,
    missing,
    advisory_missing,
    not_in_workflow: NOT_IN_WORKFLOW,
    not_in_workflow_note: NOT_IN_WORKFLOW.length
      + ' analysis tool(s) exist that this workflow does NOT run. Listed every time so that '
      + '"never built" and "built but skipped here" cannot be confused. Call the relevant ones by hand.',
    summary: missing.length === 0
      ? `All ${requiredTotal - requiredNa} applicable required sections ran.`
        + (requiredNa ? ` ${requiredNa} do not apply here: ${not_applicable.map((n) => n.section).join(', ')}.` : '')
      : `INCOMPLETE — ${missing.length} of ${requiredTotal} required section(s) did not run: `
        + `${missing.map((m) => m.section).join(', ')}.`,
    ...(missing.length ? {
      instruction: 'Report this list at the top of the analysis. An analysis missing a required '
        + 'section must say so rather than reading as though the section found nothing.',
    } : {}),
  };
}
