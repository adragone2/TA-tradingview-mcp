/**
 * Shannon's four stages, and the ACTION each one licenses.
 *
 * The book's operational core (ch. 12 for longs, ch. 13 for shorts) is a small
 * state machine, and it is the most implementable thing in it. Two timeframes:
 *
 *   - the LONGER one nominates the idea and is a GATE. "For a trend trader, the
 *     only stocks which should be of ANY interest are those in an established
 *     Stage 2 Uptrend or a Stage 4 Decline."
 *   - the SHORTER one decides what to do right now.
 *
 * Long side, once the daily is Stage 2:
 *
 *   short-TF Stage 1  ANTICIPATE   stalk it, set an alert, do not buy
 *   short-TF Stage 2  PARTICIPATE  "it is time to buy!"
 *   short-TF Stage 3  EXIT         the higher low broke, or the MAs crossed
 *   short-TF Stage 4  AVOID        "consider it a bear market for the short-term trader"
 *
 * Short side, once the daily is Stage 4, the same wheel rotated by two:
 * Stage 3 ANTICIPATE, Stage 4 PARTICIPATE, Stage 1 EXIT, Stage 2 AVOID.
 *
 * ── Why this is not built on classifyPhase ──
 *
 * `wyckoff.classifyPhase` returns the same four-ish states, and this repo has
 * already measured that it fires on 100% of random walks because it NEVER
 * ABSTAINS. A gate that always opens is not a gate. Shannon's stages are
 * defined by explicit moving-average clauses instead, and those clauses can
 * simply fail to agree — which is what makes "no stage" a possible answer and
 * therefore what makes the gate mean something. His Stage 2 definition (p. 104):
 *
 *   "trading above the rising 10-, 20- and 50-day moving averages, with the
 *    moving averages STACKED above each other 10>20>50."
 *
 * Three separate clauses — position, slope, stacking — and note that stacking is
 * NOT implied by the slopes: all three can be rising while still crossed.
 *
 * Stage 4 is the mirror. Stages 1 and 3 are the transitions between them, and
 * Shannon reads them by what came BEFORE plus a flattening long average, not by
 * a fresh set of clauses.
 *
 * ── What this does not claim ──
 *
 * Nothing here forecasts. The stage is a description of where price sits
 * relative to three averages; the action is Shannon's rule applied to that
 * description. `STAGE_NOISE_BASELINE` carries how often each stage appears on a
 * random walk, which is the number that says how much filtering the gate does.
 *
 * All pure.
 */
const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Shannon's daily triple, and his weekly one (ch. 12). */
export const MA_SETS = Object.freeze({
  daily: [10, 20, 50],
  weekly: [10, 20, 40],
  source: 'Shannon ch. 12. The weekly 40 is ~200 trading days, so it is the 200 DMA equivalent.',
});

/** The four stages, with what each one is and what it licenses. */
export const STAGES = Object.freeze({
  1: { name: 'accumulation', trend: 'basing', tradeable: false,
    note: 'A bottom is a process, not an event. Higher lows appear BEFORE higher highs, so a Stage 1 detector must not require both.' },
  2: { name: 'uptrend', trend: 'up', tradeable: true,
    note: 'Price above three rising, correctly stacked averages. One of only two stages Shannon will trade.' },
  3: { name: 'distribution', trend: 'topping', tradeable: false,
    note: 'Shannon: a top generally takes LESS time to form than a bottom. Do not short in anticipation — wait for the long average to turn.' },
  4: { name: 'decline', trend: 'down', tradeable: true,
    note: 'Price below three declining, correctly stacked averages. The other stage Shannon will trade, and he trades it smaller and faster.' },
});

/** The four actions, in Shannon's own words. */
export const ACTIONS = Object.freeze({
  ANTICIPATE: {
    action: 'ANTICIPATE',
    do: 'Stalk it. Set an alert a couple of pennies INSIDE the trigger level, load the order, do not enter.',
    why: 'Shannon: "no action should be taken to get long until the stock begins to move higher on the shorter timeframes."',
  },
  PARTICIPATE: {
    action: 'PARTICIPATE',
    do: 'Enter on the first new extreme in the trend\'s direction. Initial stop beyond the most recent counter-trend pivot.',
    why: 'Shannon: "Once the stock has broken past the short-term level of resistance and has established a HIGHER HIGH, it is time to buy!"',
  },
  EXIT: {
    action: 'EXIT',
    do: 'Close the remainder. Two triggers: the prior counter-trend pivot is violated (a PRICE correction), or the short average crosses the intermediate one (a TIME correction).',
    why: 'Shannon: "Once the definition of trend is invalidated and you continue to hold the stock, you are no longer a trend trader."',
  },
  AVOID: {
    action: 'AVOID',
    do: 'Stay out entirely. Do not scale in, do not average down, do not fade it.',
    why: 'Shannon: "buying into a short-term decline puts you in an immediate and unnecessary losing position." Directional conflict between timeframes means NO trade, not a smaller one.',
  },
  NO_SETUP: {
    action: 'NO_SETUP',
    do: 'Nothing. The longer timeframe is not in a stage Shannon trades.',
    why: 'Shannon: "the only stocks which should be of ANY interest are those in an established Stage 2 Uptrend or a Stage 4 Decline." Stages 1 and 3 are excluded from the universe, not merely deprioritised.',
  },
});

/**
 * The state machine itself. Long side keyed by short-timeframe stage; the short
 * side is the same wheel rotated by two, which is why it is derived rather than
 * written out twice.
 */
const LONG_MAP = { 1: 'ANTICIPATE', 2: 'PARTICIPATE', 3: 'EXIT', 4: 'AVOID' };
const SHORT_MAP = { 3: 'ANTICIPATE', 4: 'PARTICIPATE', 1: 'EXIT', 2: 'AVOID' };

function sma(bars, period, offset = 0) {
  const end = bars.length - offset;
  if (end < period) return null;
  let sum = 0;
  for (let i = end - period; i < end; i += 1) sum += bars[i].close;
  return sum / period;
}

/**
 * Classify the stage from Shannon's own clauses, and ABSTAIN when they disagree.
 *
 * `slope_lookback` is how many bars back to measure each average's direction.
 * A single-bar slope is noise; five bars is the shortest window in which
 * "rising" means anything on a daily chart.
 */
export function classifyStage(bars, {
  periods = MA_SETS.daily,
  slope_lookback = 5,
  prior_window = 40,
} = {}) {
  const [fast, mid, slow] = periods;
  const need = slow + slope_lookback + 1;
  if (!Array.isArray(bars) || bars.length < need) {
    return {
      available: false,
      stage: null,
      note: `Need at least ${need} bars for a ${slow}-period average with a ${slope_lookback}-bar slope; got ${bars?.length || 0}.`,
    };
  }

  const now = { fast: sma(bars, fast), mid: sma(bars, mid), slow: sma(bars, slow) };
  const then = {
    fast: sma(bars, fast, slope_lookback),
    mid: sma(bars, mid, slope_lookback),
    slow: sma(bars, slow, slope_lookback),
  };
  const price = bars[bars.length - 1].close;

  const slope = (k) => (now[k] - then[k]) / then[k];
  const slopes = { fast: slope('fast'), mid: slope('mid'), slow: slope('slow') };

  // Three independent clause groups. Stacking is separate from slope on purpose:
  // all three averages can rise while still being crossed.
  const clauses = {
    price_above_all: price > now.fast && price > now.mid && price > now.slow,
    price_below_all: price < now.fast && price < now.mid && price < now.slow,
    all_rising: slopes.fast > 0 && slopes.mid > 0 && slopes.slow > 0,
    all_falling: slopes.fast < 0 && slopes.mid < 0 && slopes.slow < 0,
    stacked_up: now.fast > now.mid && now.mid > now.slow,
    stacked_down: now.fast < now.mid && now.mid < now.slow,
  };

  const stage2 = clauses.price_above_all && clauses.all_rising && clauses.stacked_up;
  const stage4 = clauses.price_below_all && clauses.all_falling && clauses.stacked_down;

  // Stages 1 and 3 are transitions, read from what came BEFORE plus a long
  // average that has stopped trending. Shannon's ch. 3 veto is the same idea:
  // "while the longer-term moving average still exhibits a negative slope any
  // rally attempt should not be trusted."
  const priorFrom = bars[Math.max(0, bars.length - 1 - prior_window)].close;
  const priorMovePct = ((price - priorFrom) / Math.abs(priorFrom)) * 100;
  const slowFlat = Math.abs(slopes.slow) < 0.01; // <1% over the slope window

  let stage = null;
  let why = '';
  if (stage2) {
    stage = 2;
    why = `Price ${round(price, 4)} is above all three averages (${round(now.fast, 4)}/${round(now.mid, 4)}/${round(now.slow, 4)}), `
      + `all three are rising, and they are stacked ${fast}>${mid}>${slow}.`;
  } else if (stage4) {
    stage = 4;
    why = `Price ${round(price, 4)} is below all three averages (${round(now.fast, 4)}/${round(now.mid, 4)}/${round(now.slow, 4)}), `
      + `all three are falling, and they are stacked ${fast}<${mid}<${slow}.`;
  } else if (slowFlat && priorMovePct <= -5) {
    stage = 1;
    why = `The ${slow}-period average has flattened (${round(slopes.slow * 100, 2)}% over ${slope_lookback} bars) after a `
      + `${round(priorMovePct, 1)}% decline. That is basing, not an uptrend — Shannon reads a bottom as a process.`;
  } else if (slowFlat && priorMovePct >= 5) {
    stage = 3;
    why = `The ${slow}-period average has flattened (${round(slopes.slow * 100, 2)}% over ${slope_lookback} bars) after a `
      + `${round(priorMovePct, 1)}% advance. That is distribution, and Shannon says a top forms FASTER than a bottom.`;
  }

  const failed = stage === null
    ? Object.entries({
        price_position: clauses.price_above_all ? 'above all' : clauses.price_below_all ? 'below all' : 'mixed',
        slopes: clauses.all_rising ? 'all rising' : clauses.all_falling ? 'all falling' : 'mixed',
        stacking: clauses.stacked_up ? `${fast}>${mid}>${slow}` : clauses.stacked_down ? `${fast}<${mid}<${slow}` : 'crossed',
      }).filter(([, v]) => v === 'mixed' || v === 'crossed').map(([k]) => k)
    : [];

  return {
    available: true,
    stage,
    stage_name: stage ? STAGES[stage].name : null,
    tradeable: stage ? STAGES[stage].tradeable : false,
    ...(stage ? { stage_note: STAGES[stage].note } : {}),
    why: stage
      ? why
      : `NO STAGE. Shannon's clauses do not agree: ${failed.join(' and ')} ${failed.length > 1 ? 'are' : 'is'} inconsistent, `
        + `and the ${slow}-period average is not flat enough (${round(slopes.slow * 100, 2)}% over ${slope_lookback} bars) `
        + 'to call it a transition. Abstaining is the answer, not a fallback — a classifier that always names a stage is not a filter.',
    price: round(price, 6),
    averages: {
      [`ma${fast}`]: round(now.fast, 6),
      [`ma${mid}`]: round(now.mid, 6),
      [`ma${slow}`]: round(now.slow, 6),
    },
    slopes_pct: {
      [`ma${fast}`]: round(slopes.fast * 100, 3),
      [`ma${mid}`]: round(slopes.mid * 100, 3),
      [`ma${slow}`]: round(slopes.slow * 100, 3),
    },
    clauses,
    prior_move_pct: round(priorMovePct, 2),
    slope_lookback,
    periods,
    source: 'Shannon, Technical Analysis Using Multiple Timeframes (2008), ch. 12 (Stage 2) and ch. 13 (Stage 4).',
  };
}

/**
 * The action, from the two stages.
 *
 * The longer timeframe is a GATE, not a tie-breaker: if it is not Stage 2 or
 * Stage 4 the answer is NO_SETUP regardless of what the short timeframe is
 * doing. That is Shannon's universe restriction, and softening it into a
 * preference is what turns his method into "trade whatever looks good".
 */
export function stageAction({ long_stage = null, short_stage = null, side = null } = {}) {
  // Number(null) is 0, not NaN, so an absent stage would otherwise be reported
  // as "Stage 0" — a nonexistent stage described with false precision.
  const toStage = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const L = toStage(long_stage);
  const S = toStage(short_stage);

  if (L !== 2 && L !== 4) {
    return {
      ...ACTIONS.NO_SETUP,
      side: null,
      long_stage: Number.isFinite(L) ? L : null,
      short_stage: Number.isFinite(S) ? S : null,
      gate: 'CLOSED',
      gate_reason: L !== null && STAGES[L]
        ? `The longer timeframe is Stage ${L} (${STAGES[L].name}), which Shannon excludes from the tradeable universe.`
        : 'The longer timeframe has no stage — its clauses do not agree. No gate, no trade.',
    };
  }

  const inferredSide = L === 2 ? 'long' : 'short';
  if (side && side !== inferredSide) {
    return {
      ...ACTIONS.NO_SETUP,
      side: null,
      long_stage: L,
      short_stage: Number.isFinite(S) ? S : null,
      gate: 'CLOSED',
      gate_reason: `Requested side "${side}" contradicts a Stage ${L} longer timeframe, which licenses ${inferredSide} only. `
        + 'Shannon does allow shorting inside an uptrend but calls the risk "much higher", so this refuses rather than obliges.',
    };
  }

  if (!Number.isFinite(S) || !STAGES[S]) {
    return {
      action: 'WAIT',
      side: inferredSide,
      long_stage: L,
      short_stage: null,
      gate: 'OPEN',
      do: 'Nothing yet. The shorter timeframe has no stage, so there is nothing to time against.',
      why: 'The gate is open — the longer timeframe is in a stage Shannon trades — but the shorter timeframe\'s clauses '
        + 'disagree, and he abstains on disagreement: "when there are mixed trend signals across various timeframes, it '
        + 'is best to revert to a more cautious mode until trends begin to align."',
    };
  }

  const key = (inferredSide === 'long' ? LONG_MAP : SHORT_MAP)[S];
  return {
    ...ACTIONS[key],
    side: inferredSide,
    long_stage: L,
    short_stage: S,
    short_stage_name: STAGES[S].name,
    gate: 'OPEN',
    gate_reason: `The longer timeframe is Stage ${L} (${STAGES[L].name}), so ${inferredSide} setups are licensed.`,
  };
}

/**
 * Both halves at once: classify each timeframe, then read the action.
 *
 * `long_bars` and `short_bars` are normalised OHLCV for the two timeframes.
 * Shannon's own pairing for a swing trader is daily + 30-minute + 10-minute;
 * this takes two because the action machine only needs two, and the third is a
 * timing refinement rather than a state.
 */
export function stagePlan({ long_bars, short_bars, periods = MA_SETS.daily, short_periods = null, side = null } = {}) {
  const longStage = classifyStage(long_bars, { periods });
  const shortStage = classifyStage(short_bars, { periods: short_periods || periods });

  /**
   * "Not enough bars" and "the clauses disagree" both produce stage === null,
   * and they are completely different statements. Collapsing them would have a
   * five-bar gate report a considered abstention — found by running this against
   * a live 60-minute chart, where a weekly gate yielded 5 bars.
   */
  const insufficient = [];
  if (!longStage.available) insufficient.push(`gate: ${longStage.note}`);
  if (!shortStage.available) insufficient.push(`trigger: ${shortStage.note}`);

  if (insufficient.length) {
    return {
      available: false,
      action: {
        action: 'INSUFFICIENT_DATA',
        side: null,
        gate: 'UNKNOWN',
        do: 'Nothing, and do not read this as an abstention. There were not enough bars to evaluate the clauses at all.',
        why: insufficient.join(' '),
      },
      long_timeframe: longStage,
      short_timeframe: shortStage,
      insufficient_data: insufficient,
      how_to_fix: 'Load more bars, use a smaller moving-average set, or pick a gate closer to the loaded timeframe. '
        + 'A gate needs the slow average plus the slope window — 56 bars for the 10/20/50 set.',
    };
  }

  const action = stageAction({
    long_stage: longStage.stage,
    short_stage: shortStage.stage,
    side,
  });

  return {
    available: true,
    action,
    long_timeframe: longStage,
    short_timeframe: shortStage,
    how_to_read:
      'The longer timeframe is a GATE and the shorter one is the trigger. Shannon: the long timeframe is "used for '
      + 'IDEA GENERATION, NOT FOR TIMING PURPOSES". The shorter timeframe earns its place by giving a TIGHTER STOP, '
      + 'not by predicting anything — his claim that short timeframes "lead" long ones is an aggregation identity, not '
      + 'a forecast.',
    noise_baseline: STAGE_NOISE_BASELINE,
    forward_test: STAGE_FORWARD_TEST,
  };
}

/**
 * How often does each stage appear on a random walk?
 * `node scripts/stage-noise.js` re-measures.
 *
 * This is the number that says whether the gate filters anything. Wyckoff's
 * `classifyPhase` fires on 100% of random walks because it never abstains; a
 * stage classifier built from clauses that CAN disagree should abstain often,
 * and the tradeable stages should be a minority of readings.
 */
/**
 * Does the gate IMPROVE OUTCOMES, or only filter?
 * `node scripts/stage-forward-test.js` re-measures.
 *
 * The answer is no, and it is a well-powered no. Triple-barrier labelling over
 * 90 symbols, comparing PARTICIPATE bars against EVERY eligible bar in the same
 * direction with the same barriers on the same series, with no lookahead:
 *
 *   LONG   signal 33.5% vs baseline 36.4%   -2.9 points, 198 independent events
 *   SHORT  signal 21.2% vs baseline 28.9%   -7.7 points, 103 independent events
 *
 * Four configurations were run (barrier widths 2x/1x through 4x/2x, holds of 20
 * and 40 bars, universes of 30 and 90 symbols). Every one came out negative for
 * longs, and no configuration showed the gate helping.
 *
 * ── Why this is coherent rather than surprising ──
 *
 * Stage 2 requires price ABOVE three rising, correctly stacked averages. That is
 * a description of a move that has ALREADY happened. This repo has already
 * measured that below ~21 trading days the documented effect is REVERSAL, not
 * continuation — so a 20-bar hold entered on maximum trend agreement is placed
 * exactly where continuation is weakest. `horizon_prior` says the same thing
 * from the literature side, and `mtf_analyze` carries the Grimes result where a
 * triple-MA trend read was INVERTED across ~903k equity observations.
 *
 * The gate is therefore a description of alignment, and alignment is not an edge
 * at this horizon.
 */
export const STAGE_FORWARD_TEST = Object.freeze({
  status: 'MEASURED — WELL POWERED, AND NEGATIVE',
  method: 'Triple-barrier labelling (Lopez de Prado ch. 3). PARTICIPATE bars against every eligible bar in the SAME '
    + 'direction, same barriers, same series. No lookahead: the stage at bar i uses bars 0..i only, and the gate '
    + 'timeframe is aggregated from a fixed origin so truncation cannot shift the grouping.',
  universe: '90 symbols — mega caps, sector ETFs and higher-beta names — at 1D, ~300 bars each.',
  barriers: { profit_mult: 3, stop_mult: 1.5, max_bars: 20, basis: 'multiples of rolling return volatility' },
  long: { signal_win_pct: 33.5, baseline_win_pct: 36.4, lift_points: -2.9, z: -2.18, independent_events: 198, raw_events: 1520 },
  short: { signal_win_pct: 21.2, baseline_win_pct: 28.9, lift_points: -7.7, z: -4.0, independent_events: 103, raw_events: 595 },
  configurations_run: 4,
  configurations_favouring_the_gate: 0,
  verdict: 'THE GATE DOES NOT IMPROVE OUTCOMES. Both sides came out below a direction-matched baseline on adequate '
    + 'independent samples, and no configuration reversed that. Use stage_plan to describe alignment and to impose '
    + 'the universe restriction Shannon states; do NOT treat a PARTICIPATE reading as evidence the trade is better than one '
    + 'taken arbitrarily in the same direction.',
  why_it_is_coherent: 'Stage 2 requires price ABOVE three rising stacked averages, which describes a move that has '
    + 'already happened. Below ~21 trading days the documented effect is REVERSAL — see horizon_prior and the Grimes '
    + 'result in mtf.js, where a triple-MA trend read was INVERTED over ~903k equity observations. A 20-bar hold '
    + 'entered on maximum trend agreement sits where continuation is weakest.',
  caveats: [
    'The z values are computed on RAW overlapping counts and are optimistic. The independent-event counts are the '
      + 'honest sample size; the DIRECTION is what carries here, not the p-value.',
    'Measured with a 5/10/20 triple rather than the 10/20/50 Shannon specifies. On a 5-bar gate his set needs 280 base bars of warm-up '
      + 'and the chart serves ~300, leaving ~20 testable bars per symbol. HIS OWN PARAMETERS ARE UNTESTABLE on this '
      + 'history — that is a limit of the data, not a refutation of his numbers specifically.',
    'This tests the GATE, not his method. He also sizes to three constraints, scales out, trails a pivot stop and '
      + 'holds nothing into earnings. None of that is in these barriers.',
    'A filter can still pay by cutting TRADE COUNT and therefore cost, even with no win-rate gain. turnover_cost '
      + 'prices that separately and this does not measure it.',
  ],
  script: 'scripts/stage-forward-test.js',
});

export const STAGE_NOISE_BASELINE = Object.freeze({
  status: 'MEASURED',
  random_walk: {
    walks: 200, bars: 300,
    abstain_pct: 54.0,
    stage_1_pct: 3.5, stage_2_pct: 13.5, stage_3_pct: 6.5, stage_4_pct: 22.5,
    tradeable_pct: 36.0,
  },
  real_data: {
    symbols: 12, bars: 300,
    abstain_pct: 33.3,
    stage_1_pct: 25.0, stage_2_pct: 16.7, stage_3_pct: 16.7, stage_4_pct: 8.3,
    tradeable_pct: 25.0,
  },
  /**
   * The contrast that justifies not building on classifyPhase: it named a phase
   * on 100% of the same random walks. It never abstains, so it cannot filter.
   */
  wyckoff_classify_phase_named_pct: { random_walk: 100, real_data: 100 },
  verdict:
    'The gate IS selective — Shannon\'s clauses abstain on 54% of random walks, where classifyPhase abstains on none. '
    + 'But it opens on only 25% of real symbols against 36% of random walks, so it finds NO MORE tradeable structure '
    + 'in real data than in noise. Read it as a CONSISTENCY filter — are price and three averages aligned and stacked? '
    + '— and never as evidence that a trend exists or will continue. The real-data arm is 12 symbols, so 25% is 3 of '
    + '12 and far too small to stand alone; the random-walk arm (n=200) is what carries weight.',
  note: 'A stage is a description of price versus three averages. It forecasts nothing. Its job here is to be a gate '
    + 'that can CLOSE, which is the property Shannon\'s universe restriction needs and classifyPhase cannot provide.',
  script: 'scripts/stage-noise.js',
});
