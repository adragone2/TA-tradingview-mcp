/**
 * Gap classification: common (area), breakaway, runaway (measuring), exhaustion.
 *
 * RESEARCH GRADE. Deliberately NOT registered as an MCP tool, for the same
 * reason src/core/ignition.js is not: a detector reaches the tool surface after
 * its evidence survives review, not before. Read IGNITION_NOISE_BASELINE first
 * — it is the cautionary case this module was built against.
 *
 * ── What a gap classification actually is ──
 *
 * The four types are Edwards & Magee's, and they are named for WHERE IN A MOVE
 * the gap sits, not for anything about the gap itself. The gap arithmetic is
 * identical in all four cases; what differs is the context before it and the
 * follow-through after it. That has two consequences this module refuses to
 * hide:
 *
 *   1. Three of the four classes need FORWARD bars to settle. A gap with fewer
 *      than `follow_bars` bars after it is reported as `pending`, never as
 *      `common`. A classifier that peeks forward is a DESCRIPTION of what
 *      already happened — it is not, and cannot be turned into, a signal.
 *   2. The classes are not mutually exclusive. Every class that passes is
 *      reported in `also_matches`; `verdict` applies a stated precedence, so a
 *      reader can see the ambiguity rather than inherit a coin flip.
 *
 * ── Provenance of every threshold ──
 *
 * Bulkowski's gap page carries the base rates and the identification wording:
 *   https://thepatternsite.com/gaps.html
 *   https://thepatternsite.com/GaugingGaps.html
 *
 * Where he gives a number, the number is his and is cited at the clause. Where
 * he says "high volume" or "unusually tall" without one, the number is OURS and
 * is labelled `ours` in GAP_CITATIONS so nobody mistakes it for a finding. Two
 * clauses are entirely ours — the minimum gap size and the straight-line
 * fraction — because a rule with no number cannot be measured against noise.
 *
 * All pure.
 */

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * `Number(null)` is 0, and that has produced a fabricated finding three times in
 * this repo. Anything that is not a finite number becomes null here and stays
 * null all the way to the output, where a null clause reports NOT CHECKED and
 * does NOT pass.
 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const GAP_DEFAULTS = {
  /** ATR window. Measured on bars STRICTLY BEFORE the gap — see atrBefore(). */
  atr_lookback: 20,

  /** OURS. Below this a "gap" is a tick, and every class would fire on dust. */
  min_gap_atr: 0.10,
  min_gap_pct: 0.10,

  /**
   * The CONCEPT is Edwards & Magee's "congestion area"; the bar count is OURS.
   * No source says how many bars make a congestion.
   */
  congestion_lookback: 20,
  /** OURS. How tall the congestion may be, in ATRs, and still be trendless. */
  congestion_max_atr: 4.0,

  volume_lookback: 20,
  /** OURS. Bulkowski says "high volume" and gives no multiple. */
  high_volume_ratio: 1.5,

  /** Window in which the "prior move" is measured, from its extreme. */
  trend_lookback: 40,
  /** OURS. A breakaway "starts a new trend", so the prior move must be small. */
  breakaway_max_prior_move_atr: 2.0,
  /** OURS. A runaway is mid-trend, so something must already have happened. */
  runaway_min_prior_move_atr: 2.0,
  /** OURS. An exhaustion ends an EXTENDED move — twice the runaway bar. */
  exhaustion_min_prior_move_atr: 4.0,

  /** Bulkowski: "a straight-line advance or decline". These two make it a number. */
  run_lookback: 10,
  min_straight_pct: 60,

  /** OURS. Bulkowski's "the gap may be unusually tall" — supporting, not required. */
  tall_gap_atr: 1.0,

  /** Bulkowski quotes every closure rate "within a week" = 5 trading days. */
  follow_bars: 5,
};

/**
 * Where each clause came from. `ours` means the source describes the clause in
 * words and gives no number, so the number is a modelling choice and must be
 * quoted as one.
 */
export const GAP_CITATIONS = Object.freeze({
  gap_definition: {
    source: 'https://thepatternsite.com/gaps.html',
    quote: "Gaps occur when today's high is below yesterday's low (bearish gap), or today's low is above yesterday's high (bullish gap).",
  },
  min_gap_atr: { source: 'ours', why: 'No source sets a minimum. Without one every class fires on rounding.' },
  min_gap_pct: { source: 'ours', why: 'Same, in percent, so a low-priced name is not held to an ATR that is a large share of its price.' },
  common_in_congestion: {
    source: 'https://thepatternsite.com/gaps.html',
    quote: 'Occurs in congestion (trendless markets) and closes quickly, usually in a few days.',
  },
  breakaway_leaves_congestion: {
    source: 'https://thepatternsite.com/gaps.html',
    quote: 'Starts a new trend and the gap often occurs on leaving a consolidation area, usually on high volume on the gap day.',
  },
  runaway_straight_line: {
    source: 'https://thepatternsite.com/gaps.html',
    quote: 'Continuation gaps occur during a straight-line advance or decline. Price makes new highs or lows without closing the gap.',
  },
  runaway_measure_rule: {
    source: 'https://thepatternsite.com/gaps.html',
    quote: 'By price, the middle of the gap appears between 50% and 52% along the very short-term trend.',
  },
  exhaustion_end_of_trend: {
    source: 'https://thepatternsite.com/gaps.html',
    quote: 'Happens at the end of a trend on high volume. The gap is usually not followed by new highs or lows, and the gap may be unusually tall.',
  },
  high_volume_ratio: {
    source: 'ours',
    why: 'Bulkowski says "high volume" without a multiple. https://thepatternsite.com/volbkout.html describes heavy breakout volume as a spike towering over the preceding month, which is a picture, not a threshold.',
  },
  congestion_max_atr: { source: 'ours', why: '"Trendless" needs a height. Four ATRs over 20 bars is a range, not a move.' },
  straight_line_pct: { source: 'ours', why: '"Straight-line" needs a number. This counts same-direction closes over run_lookback.' },
  prior_move_atr_bands: { source: 'ours', why: 'Early / mid / extended needs boundaries. 2 and 4 ATRs of prior move are ours.' },
  tall_gap_atr: { source: 'ours', why: 'Bulkowski hedges with "may be". Reported as SUPPORTING evidence, never required.' },
  follow_bars: {
    source: 'https://thepatternsite.com/gaps.html',
    quote: 'Every closure rate on the page is quoted "within a week", which is 5 trading days.',
  },
});

/**
 * Bulkowski's own base rates, over 1,100+ samples. These are what each class
 * DID, historically — they are attached to a detection so it is read as a
 * description with a frequency, not as a forecast.
 *
 * https://thepatternsite.com/gaps.html
 */
export const GAP_BASE_RATES = Object.freeze({
  source: 'https://thepatternsite.com/gaps.html',
  sample: 'over 1,100 samples',
  closes_within_a_week_pct: Object.freeze({
    common: { up: 85, down: 90 },
    breakaway: { up: 1, down: 1 },
    runaway: { up: 8, down: 15 },
    exhaustion: { up: 60, down: 66 },
  }),
  median_days_to_close: Object.freeze({
    common: { up: '3-4', down: '3-4' },
    breakaway: { up: 89, down: 84 },
    runaway: { up: 45, down: 25 },
    exhaustion: { up: 6, down: 5 },
  }),
  measure_rule: 'By price, the middle of a continuation gap appears between 50% and 52% along the very short-term trend.',
  read_as: 'These are the historical closure frequencies of gaps a human had already classified. They are not this '
    + 'classifier\'s accuracy, and nothing here has been validated against them.',
});

/** True range, or bar range when there is no previous bar. */
function trueRange(bar, prev) {
  const h = num(bar?.high), l = num(bar?.low), pc = num(prev?.close);
  if (h == null || l == null) return null;
  if (pc == null) return h - l;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

/**
 * ATR over the `lookback` bars ENDING AT i-1 — the gap bar is excluded on
 * purpose. True range counts the gap, so including bar i would let a large gap
 * inflate its own denominator and shrink its own `size_atr`. That is the exact
 * shape of the defect that made ignition.js's noise floor unmeasurable.
 */
function atrBefore(bars, i, lookback) {
  const from = Math.max(1, i - lookback);
  if (i - from < 2) return null;
  let sum = 0, n = 0;
  for (let k = from; k < i; k++) {
    const tr = trueRange(bars[k], bars[k - 1]);
    if (tr == null) continue;
    sum += tr; n++;
  }
  return n >= 2 ? sum / n : null;
}

/** Mean volume over the `lookback` bars before i. null if ANY of it is unusable. */
function avgVolumeBefore(bars, i, lookback) {
  const from = Math.max(0, i - lookback);
  const vols = [];
  for (let k = from; k < i; k++) {
    const v = num(bars[k]?.volume);
    if (v == null || v <= 0) continue;
    vols.push(v);
  }
  if (vols.length < Math.max(3, Math.floor(lookback / 2))) return null;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

/** A raw gap between bar i-1 and bar i, or null. */
function rawGap(bars, i) {
  const prev = bars[i - 1], cur = bars[i];
  const ph = num(prev?.high), pl = num(prev?.low);
  const ch = num(cur?.high), cl = num(cur?.low);
  if (ph == null || pl == null || ch == null || cl == null) return null;
  if (cl > ph) return { direction: 'up', gap_low: ph, gap_high: cl };
  if (ch < pl) return { direction: 'down', gap_low: ch, gap_high: pl };
  return null;
}

/** A clause, in the vcp_check shape: pass, the value, and what was required. */
const clause = (pass, value, required, extra = {}) => ({ pass: !!pass, value, required, ...extra });

/** A clause whose input was missing. NOT CHECKED is not a pass — see CLAUDE.md. */
const notChecked = (required, why) => ({
  pass: false, value: 'NOT CHECKED', required,
  note: `${why} Unknown is not satisfied, so this clause does NOT pass.`,
});

/**
 * Classify every gap in `bars`.
 *
 * Returns one entry per gap with every clause of every class scored, so a near
 * miss names the clause that failed rather than reporting a bare "no".
 */
export function classifyGaps(bars, options = {}) {
  const o = { ...GAP_DEFAULTS, ...options };
  const warmup = Math.max(o.atr_lookback, o.congestion_lookback, o.trend_lookback,
    o.volume_lookback, o.run_lookback) + 1;

  if (!Array.isArray(bars) || bars.length < warmup + 2) {
    return {
      gaps: [], count: 0, counts: {}, warmup_bars: warmup,
      reason: 'insufficient_bars',
      note: `Need at least ${warmup + 2} bars for the longest lookback, have ${bars?.length ?? 0}.`,
      citations: GAP_CITATIONS, base_rates: GAP_BASE_RATES, noise_floor: GAP_NOISE_BASELINE,
    };
  }

  const out = [];
  for (let i = warmup; i < bars.length; i++) {
    const g = describeGap(bars, i, o);
    if (g) out.push(g);
  }

  const counts = {};
  for (const g of out) counts[g.verdict] = (counts[g.verdict] || 0) + 1;

  return {
    gaps: out,
    count: out.length,
    counts,
    warmup_bars: warmup,
    bars_scanned: bars.length - warmup,
    options: o,
    precedence: VERDICT_PRECEDENCE,
    citations: GAP_CITATIONS,
    base_rates: GAP_BASE_RATES,
    noise_floor: GAP_NOISE_BASELINE,
    what_this_is_not: 'A classification, not a signal. Three of the four classes are settled by bars AFTER the gap, so '
      + 'this describes what already happened. A gap without enough forward bars is `pending` and stays uncategorised.',
  };
}

/**
 * Precedence when more than one class passes. Ordered by how much evidence each
 * class demands: exhaustion needs an extended move AND a straight-line run AND
 * a failure to extend; common is the residual.
 */
export const VERDICT_PRECEDENCE = Object.freeze(['exhaustion', 'breakaway', 'runaway', 'common']);

/** Score one bar index. Returns null if there is no qualifying gap there. */
export function describeGap(bars, i, options = {}) {
  const o = { ...GAP_DEFAULTS, ...options };
  const raw = rawGap(bars, i);
  if (!raw) return null;

  const cur = bars[i], prev = bars[i - 1];
  const up = raw.direction === 'up';
  const size = raw.gap_high - raw.gap_low;
  const atr = atrBefore(bars, i, o.atr_lookback);
  const refPrice = num(prev.close) ?? num(prev.high);
  const sizeAtr = atr && atr > 0 ? size / atr : null;
  const sizePct = refPrice ? (size / refPrice) * 100 : null;

  // Size gate. Ours, and it is a gate on the GAP, not on the classification.
  if (sizeAtr == null || sizePct == null) return null;
  if (sizeAtr < o.min_gap_atr || sizePct < o.min_gap_pct) return null;

  // ── Congestion before the gap ──
  const cFrom = i - o.congestion_lookback;
  const win = bars.slice(cFrom, i);
  const cHigh = Math.max(...win.map((b) => num(b.high)).filter((v) => v != null));
  const cLow = Math.min(...win.map((b) => num(b.low)).filter((v) => v != null));
  const cHeightAtr = atr && atr > 0 ? (cHigh - cLow) / atr : null;
  const leaves = up ? num(cur.low) > cHigh : num(cur.high) < cLow;

  // ── Prior move, from the trend's extreme inside trend_lookback ──
  const tFrom = Math.max(0, i - o.trend_lookback);
  const tWin = bars.slice(tFrom, i);
  const origin = up
    ? Math.min(...tWin.map((b) => num(b.low)).filter((v) => v != null))
    : Math.max(...tWin.map((b) => num(b.high)).filter((v) => v != null));
  const priorMove = up ? num(prev.close) - origin : origin - num(prev.close);
  const priorMoveAtr = atr && atr > 0 && Number.isFinite(priorMove) ? priorMove / atr : null;

  // ── Straight-line run into the gap ──
  let same = 0, counted = 0;
  for (let k = i - o.run_lookback; k < i; k++) {
    const c = num(bars[k]?.close), pc = num(bars[k - 1]?.close);
    if (c == null || pc == null) continue;
    counted++;
    if (up ? c > pc : c < pc) same++;
  }
  const straightPct = counted ? (same / counted) * 100 : null;

  // ── Volume ──
  const vol = num(cur.volume);
  const avgVol = avgVolumeBefore(bars, i, o.volume_lookback);
  const volRatio = vol != null && vol > 0 && avgVol ? vol / avgVol : null;

  // ── Follow-through. Everything below this line needs bars that may not exist. ──
  const available = bars.length - 1 - i;
  const horizon = Math.min(o.follow_bars, available);
  let filledAt = null, newExtremeAt = null;
  for (let k = i + 1; k <= i + horizon; k++) {
    const h = num(bars[k]?.high), l = num(bars[k]?.low);
    if (h == null || l == null) continue;
    if (filledAt == null && (up ? l <= raw.gap_low : h >= raw.gap_high)) filledAt = k;
    if (newExtremeAt == null && (up ? h > num(cur.high) : l < num(cur.low))) newExtremeAt = k;
  }
  const settled = available >= o.follow_bars;
  const filled = filledAt != null;
  const newExtreme = newExtremeAt != null;

  // ── The four class definitions, every clause a number ──
  const volClause = (label) => (volRatio == null
    ? notChecked(`>= ${o.high_volume_ratio}x the ${o.volume_lookback}-bar average`,
      `Volume was missing or zero on the gap bar or through the ${o.volume_lookback}-bar window, so ${label} could not be tested.`)
    : clause(volRatio >= o.high_volume_ratio, `${round(volRatio, 2)}x`,
      `>= ${o.high_volume_ratio}x the ${o.volume_lookback}-bar average`));

  const forward = (pass, value, required) => (settled
    ? clause(pass, value, required)
    : notChecked(required, `Only ${available} bar(s) exist after the gap; ${o.follow_bars} are needed.`));

  const classes = {
    /**
     * "Occurs in congestion (trendless markets) and closes quickly, usually in
     * a few days." Three ideas, four numbers, and NOT a fourth clause on the
     * prior move.
     *
     * A `prior_move < 2x ATR` clause was tried and removed: measured from the
     * 40-bar extreme it is really "price is near the bottom of its range", so a
     * gap in the upper half of a perfectly flat 3-ATR congestion failed it and
     * `common` became unreachable exactly where area gaps are commonest. The
     * source says trendless, and trendless is what the two clauses below
     * measure — the range's height, and the direction of its closes.
     */
    common: {
      stays_in_congestion: clause(!leaves, leaves ? 'left the range' : 'inside the range',
        `gap does NOT clear the ${o.congestion_lookback}-bar range ${round(cLow, 4)}-${round(cHigh, 4)}`),
      congestion_is_trendless: clause(cHeightAtr != null && cHeightAtr <= o.congestion_max_atr,
        cHeightAtr == null ? 'no ATR' : `${round(cHeightAtr)}x ATR`, `<= ${o.congestion_max_atr}x ATR tall`),
      no_straight_line: clause(straightPct != null && straightPct < o.min_straight_pct,
        straightPct == null ? 'no closes' : `${round(straightPct, 1)}%`,
        `< ${o.min_straight_pct}% of the last ${o.run_lookback} closes in one direction`),
      closes_quickly: forward(filled, filled ? `filled at bar ${filledAt}` : 'still open',
        `filled within ${o.follow_bars} bars`),
    },
    breakaway: {
      leaves_congestion: clause(leaves, leaves ? 'cleared the range' : 'inside the range',
        `gap clears the ${o.congestion_lookback}-bar range ${round(cLow, 4)}-${round(cHigh, 4)}`),
      congestion_was_a_consolidation: clause(cHeightAtr != null && cHeightAtr <= o.congestion_max_atr,
        cHeightAtr == null ? 'no ATR' : `${round(cHeightAtr)}x ATR`, `<= ${o.congestion_max_atr}x ATR tall`),
      high_volume: volClause('the breakaway volume clause'),
      starts_the_move: clause(priorMoveAtr != null && priorMoveAtr < o.breakaway_max_prior_move_atr,
        priorMoveAtr == null ? 'no ATR' : `${round(priorMoveAtr)}x ATR`,
        `< ${o.breakaway_max_prior_move_atr}x ATR of prior move — it must START a trend, not extend one`),
      stays_open: forward(!filled, filled ? `filled at bar ${filledAt}` : 'still open',
        `NOT filled within ${o.follow_bars} bars (Bulkowski: 1% close within a week)`),
    },
    runaway: {
      established_move: clause(priorMoveAtr != null && priorMoveAtr >= o.runaway_min_prior_move_atr,
        priorMoveAtr == null ? 'no ATR' : `${round(priorMoveAtr)}x ATR`,
        `>= ${o.runaway_min_prior_move_atr}x ATR of prior move`),
      straight_line_run: clause(straightPct != null && straightPct >= o.min_straight_pct,
        straightPct == null ? 'no closes' : `${round(straightPct, 1)}%`,
        `>= ${o.min_straight_pct}% of the last ${o.run_lookback} closes in the trend direction`),
      extends_without_closing: forward(newExtreme && !filled,
        `${newExtreme ? 'new extreme' : 'no new extreme'}, ${filled ? 'gap filled' : 'gap open'}`,
        `a new ${up ? 'high' : 'low'} within ${o.follow_bars} bars AND the gap still open`),
    },
    exhaustion: {
      extended_move: clause(priorMoveAtr != null && priorMoveAtr >= o.exhaustion_min_prior_move_atr,
        priorMoveAtr == null ? 'no ATR' : `${round(priorMoveAtr)}x ATR`,
        `>= ${o.exhaustion_min_prior_move_atr}x ATR of prior move`),
      straight_line_run: clause(straightPct != null && straightPct >= o.min_straight_pct,
        straightPct == null ? 'no closes' : `${round(straightPct, 1)}%`,
        `>= ${o.min_straight_pct}% of the last ${o.run_lookback} closes in the trend direction`),
      high_volume: volClause('the exhaustion volume clause'),
      fails_to_extend: forward(!newExtreme, newExtreme ? `new extreme at bar ${newExtremeAt}` : 'no new extreme',
        `NO new ${up ? 'high' : 'low'} within ${o.follow_bars} bars`),
    },
  };

  const passed = Object.entries(classes)
    .filter(([, cs]) => Object.values(cs).every((c) => c.pass))
    .map(([name]) => name);

  const failedByClass = Object.fromEntries(Object.entries(classes)
    .map(([name, cs]) => [name, Object.entries(cs).filter(([, c]) => !c.pass).map(([k]) => k)]));

  let verdict;
  if (!settled) verdict = 'pending';
  else verdict = VERDICT_PRECEDENCE.find((v) => passed.includes(v)) || 'unclassified';

  // The nearest miss: the class that failed the fewest clauses.
  const nearest = Object.entries(failedByClass)
    .filter(([, f]) => f.length > 0)
    .sort((a, b) => a[1].length - b[1].length)[0];

  const supporting = {
    unusually_tall: clause(sizeAtr >= o.tall_gap_atr, `${round(sizeAtr)}x ATR`,
      `>= ${o.tall_gap_atr}x ATR`,
      { note: 'Bulkowski hedges — "the gap MAY be unusually tall". Supporting evidence, never required.' }),
    filled_within_window: settled
      ? clause(filled, filled ? `bar ${filledAt} (${filledAt - i} bars)` : 'not within the window',
        `informational — Bulkowski's closure rates are in base_rates`)
      : notChecked('informational', `Only ${available} bar(s) exist after the gap.`),
  };

  // The measure rule, as a projection. Retrospective statistic pointed forward,
  // which is a different thing from a forecast with a base rate behind it.
  const gapMid = (raw.gap_low + raw.gap_high) / 2;
  const measure = Number.isFinite(origin)
    ? {
        trend_origin: round(origin, 4),
        gap_midpoint: round(gapMid, 4),
        projected_target: round(origin + (gapMid - origin) / 0.51, 4),
        basis: GAP_CITATIONS.runaway_measure_rule.quote,
        caution: 'That 50-52% was measured on gaps ALREADY known to be continuations. Applying it forward assumes the '
          + 'classification is right, and this classifier has no accuracy number.',
      }
    : null;

  const evidence = `Bar ${i}: ${raw.direction} gap of ${round(size, 4)} `
    + `(${round(sizeAtr)}x ATR ${round(atr, 4)}, ${round(sizePct)}% of ${round(refPrice, 4)}) `
    + `from ${round(raw.gap_low, 4)} to ${round(raw.gap_high, 4)}; `
    + `prior move ${priorMoveAtr == null ? 'n/a' : `${round(priorMoveAtr)}x ATR`} from ${round(origin, 4)}; `
    + `${o.congestion_lookback}-bar range ${round(cLow, 4)}-${round(cHigh, 4)} `
    + `(${cHeightAtr == null ? 'n/a' : `${round(cHeightAtr)}x ATR`}), ${leaves ? 'cleared' : 'not cleared'}; `
    + `volume ${volRatio == null ? 'NOT CHECKED' : `${round(volRatio, 2)}x`}; `
    + `${straightPct == null ? 'n/a' : `${round(straightPct, 1)}%`} of the last ${o.run_lookback} closes ${up ? 'up' : 'down'}; `
    + (settled
      ? `over ${o.follow_bars} forward bars ${filled ? `filled at ${filledAt}` : 'unfilled'} and `
        + `${newExtreme ? `made a new ${up ? 'high' : 'low'} at ${newExtremeAt}` : `made NO new ${up ? 'high' : 'low'}`}.`
      : `only ${available} forward bar(s) — follow-through UNSETTLED.`);

  return {
    index: i,
    time: cur.time ?? null,
    direction: raw.direction,
    verdict,
    also_matches: passed.filter((p) => p !== verdict),
    gap_low: round(raw.gap_low, 4),
    gap_high: round(raw.gap_high, 4),
    size: round(size, 4),
    size_atr: round(sizeAtr),
    size_pct: round(sizePct),
    atr: round(atr, 4),
    congestion: {
      from_index: cFrom, to_index: i - 1,
      high: round(cHigh, 4), low: round(cLow, 4),
      height_atr: round(cHeightAtr), cleared: leaves,
    },
    prior_move_atr: round(priorMoveAtr),
    trend_origin: round(origin, 4),
    straight_line_pct: round(straightPct, 1),
    volume: vol,
    avg_volume: avgVol == null ? null : round(avgVol, 2),
    volume_ratio: round(volRatio, 2),
    follow_through: {
      bars_available: available,
      bars_required: o.follow_bars,
      settled,
      filled_at_index: filledAt,
      bars_to_fill: filledAt == null ? null : filledAt - i,
      new_extreme_at_index: newExtremeAt,
    },
    classes,
    passed_classes: passed,
    failed_clauses: failedByClass,
    ...(verdict === 'unclassified' && nearest
      ? { near_miss: { class: nearest[0], failed_clauses: nearest[1] } }
      : {}),
    supporting,
    measure_rule: verdict === 'runaway' || passed.includes('runaway') ? measure : null,
    base_rate: GAP_BASE_RATES.closes_within_a_week_pct[verdict] ?? null,
    evidence,
    ...(verdict === 'pending'
      ? { pending_reason: `Needs ${o.follow_bars} bars after the gap; ${available} exist. `
          + 'Common, breakaway, runaway and exhaustion are all settled by follow-through, so none can be awarded yet.' }
      : {}),
  };
}

/**
 * Measured by scripts/detector-noise.js.
 *
 * ── Why the standard harness null is worthless here ──
 *
 * A random-walk PRICE PATH has almost no overnight gaps. `barsFromPath` builds
 * bar i's open from path[i-1], so consecutive bars overlap and the gap
 * condition (low > prior high) needs the wick jitter to conspire. Measured:
 * **0.24 gaps per 200-bar walk**, against 9.05 once gaps are injected — 38x
 * fewer. Every class then floors at ~0% and the classifier looks perfect.
 *
 * That is not a noise floor, it is a fixture bug, and it is the same shape as
 * the one that left ignition.js unmeasurable: the null moves the GATE rather
 * than the pattern.
 *
 * ── What replaced it, and how it was calibrated ──
 *
 * `randomWalkWithGaps` injects gaps at a stated rate and size. The parameters
 * were not guessed: the quantity a gap-gated rule keys on is the ATR-to-range
 * ratio (ATR counts gaps, bar range does not), and the ignition investigation
 * measured that on REAL daily bars at 1.070 against 1.001 for a gapless path.
 * Sweeping the generator against that anchor put gap_rate 0.06 with
 * gap_median_atr 0.35 at **1.068**, with 7.1% of bars carrying a visible gap.
 * So there is one real-data anchor behind this null, which is one more than
 * ignition.js ever had.
 *
 * ── What is established and what is not ──
 *
 * `common` and `runaway` read no volume and score IDENTICALLY across every
 * volume regime tried. Their floors are established.
 *
 * `breakaway` and `exhaustion` both require high volume, and their rates move
 * with the null's one free volume parameter. Sweeping it gives breakaway a
 * narrow 0.0-4.0% bracket — selective on any reading — and exhaustion a
 * **4.5-37.0%** bracket, which is an eightfold spread. Exhaustion therefore has
 * no single floor and must be quoted as the bracket. Quoting 28.5% because it
 * happens to be the middle of the sweep would be the ignition.js mistake with
 * better manners.
 */
export const GAP_NOISE_BASELINE = Object.freeze({
  measured: true,
  measured_on: '2026-07-30',
  walks: 200,
  bars_each: 200,
  generator: 'randomWalkWithGaps (src/core/synthetic.js)',
  generator_params: Object.freeze({
    gap_rate: 0.06,
    gap_median_atr: 0.35,
    gap_sigma: 0.8,
    volume_mode: 'gap_elevated',
    base_volume: 1_000_000,
    volume_sigma: 0.35,
    gap_volume_multiple: 2.0,
  }),
  calibration: 'gap_rate and gap_median_atr were swept against the ATR-to-mean-range ratio measured on real daily '
    + 'bars (1.070, IGNITION_NOISE_BASELINE.why_not_established). The defaults produce 1.068 and 7.1% of bars '
    + 'gapping. The gapless harness path produces 1.010.',

  /**
   * `pct_of_walks` is the share of walks containing at least one gap of that
   * class; `per_walk` is the mean count. Measured at gap_volume_multiple 2.0.
   */
  by_class: Object.freeze({
    any_gap: { pct_of_walks: 100.0, per_walk: 9.05 },
    common: { pct_of_walks: 46.5, per_walk: 0.79, status: 'ESTABLISHED — no volume clause' },
    breakaway: { pct_of_walks: 3.5, per_walk: 0.04, status: 'BRACKETED 0.0-4.0% across the volume sweep; 0.5% at the MEASURED x1.21 multiple (real_arm)' },
    runaway: { pct_of_walks: 69.5, per_walk: 1.35, status: 'ESTABLISHED — no volume clause' },
    exhaustion: { pct_of_walks: 28.5, per_walk: 0.34, status: 'FLOOR 9.5% of walks (0.10/walk) at the MEASURED volume multiple x1.21 (real_arm); sweep bracket 4.5-37.0% retained for sensitivity' },
    unclassified: { pct_of_walks: 99.5, per_walk: 6.24 },
    pending: { pct_of_walks: 27.5, per_walk: 0.29 },
  }),

  /**
   * The whole answer for the two volume-gated classes, as one table. This is
   * the measurement ignition.js needed and never got.
   */
  volume_sensitivity: Object.freeze({
    swept: 'gap_volume_multiple, the factor applied to a gap bar\'s volume',
    breakaway_pct_of_walks: Object.freeze({ 'x1.0': 0.0, 'x1.5': 1.0, 'x2.0': 3.5, 'x2.5': 3.5, 'x3.0': 4.0 }),
    exhaustion_pct_of_walks: Object.freeze({ 'x1.0': 4.5, 'x1.5': 19.5, 'x2.0': 28.5, 'x2.5': 34.5, 'x3.0': 37.0 }),
    reading: 'Breakaway travels 4 points and stays selective on every reading. Exhaustion travels 32.5 points, an '
      + 'eightfold spread, so it has a bracket and not a number. Both floors also collapse to 0.0% under the '
      + 'harness\'s flat volume, which is a property of that FIXTURE and not of the classifier.',
  }),

  volume_mode_contrast: Object.freeze({
    gap_elevated: { breakaway: 3.5, exhaustion: 28.5, note: 'dispersed volume, gap bars x2.0 — the reported arm' },
    lognormal: { breakaway: 0.0, exhaustion: 4.5, note: 'dispersed volume, gap bars NOT elevated' },
    flat: { breakaway: 0.0, exhaustion: 0.0, note: 'the harness\'s near-constant volume — a fixture artefact' },
    unchanged_across_all_three: { common: 46.5, runaway: 69.5 },
  }),

  naive_null_contrast: Object.freeze({
    generator: 'barsFromPath(randomWalk(...)) — the standard harness path, no gaps injected',
    any_gap: { pct_of_walks: 20.0, per_walk: 0.24 },
    common: { pct_of_walks: 4.0, per_walk: 0.04 },
    breakaway: { pct_of_walks: 0.0, per_walk: 0.0 },
    runaway: { pct_of_walks: 4.0, per_walk: 0.04 },
    exhaustion: { pct_of_walks: 0.0, per_walk: 0.0 },
    why: 'A reconstructed price path produces 38x fewer gaps than a realistic series (0.24 against 9.05 per walk), so '
      + 'every class floors near zero. That number measures the generator, not the detector, and reads as a perfect '
      + 'classifier.',
  }),

  reading: 'Runaway fires on 69.5% of walks and common on 46.5%, so both are DESCRIPTIVE — a noisy series with '
    + 'realistic gaps produces them freely and neither carries information alone. Breakaway at 3.5% (bracket 0.0-4.0%) '
    + 'is the one genuinely selective class, and the selectivity comes from the conjunction: leaving a tight '
    + 'consolidation AND on high volume AND with no prior move AND staying unfilled is hard for noise to satisfy by '
    + 'accident. Exhaustion cannot be read at all until its volume bracket is closed. And note `unclassified` at 6.24 '
    + 'per walk against 9.05 gaps: 69% of gaps in noise match no class, which is the classifier declining to guess.',

  caveat: 'Selectivity is not accuracy. The real-data arm HAS been run (real_arm below): every class fires AT or '
    + 'ABOVE its null on real bars, which is the direction that means the null is honest — ignition.js failed the '
    + 'other way (5.9% real against 22.5% synthetic). Still missing: closure-rate validation against Bulkowski\'s own '
    + 'numbers, and any forward test at all.',

  /**
   * The other half of the measurement — same probes over real daily bars, run
   * 2026-07-30 on the live chart. The one free parameter the sweep could not
   * pin, the gap-day volume multiple, measured at 1.21 against the guessed
   * 2.0; the null re-run AT the measured value (same seeds as the published
   * table, which reproduces exactly) is what turns exhaustion's bracket into
   * a floor. ONE universe, ONE period: PROVISIONAL under the repo's holdout
   * rule until a disjoint arm agrees.
   */
  real_arm: Object.freeze({
    measured_on: '2026-07-30',
    universe: '20 large caps across sectors (AAPL MSFT NVDA AMZN GOOGL META JPM BAC XOM CVX JNJ PFE PG KO WMT HD CAT BA DIS NFLX), 299 daily bars each, partial bar dropped',
    per_200_bars: Object.freeze({
      any_gap: { real: 10.13, null: 9.05 },
      common: { real: 0.80, null: 0.79, pct_of_symbols: 55.0 },
      breakaway: { real: 0.07, null_at_measured: 0.01, pct_of_symbols: 10.0 },
      runaway: { real: 1.54, null: 1.35, pct_of_symbols: 90.0 },
      exhaustion: { real: 0.40, null_at_x2: 0.34, null_at_measured: 0.10, pct_of_symbols: 55.0 },
      unclassified: { real: 6.86, null: 6.24 },
    }),
    gap_day_volume_multiple: Object.freeze({ median: 1.21, n_gaps: 303, generator_guess_was: 2.0 }),
    null_at_measured_multiple: Object.freeze({
      gap_volume_multiple: 1.21,
      seeds: 'identical to the published table (7000+s); the x2.0 arm reproduces it exactly',
      exhaustion: { pct_of_walks: 9.5, per_walk: 0.10 },
      breakaway: { pct_of_walks: 0.5, per_walk: 0.01 },
      common_runaway_any: 'byte-identical to x2.0 — no volume clause, same seeds',
    }),
    atr_over_range: Object.freeze({
      real_mean: 1.093, anchor: 1.070, generator: 1.068,
      note: 'spread 1.054-1.152 across the 20 symbols; the anchor holds approximately and the generator sits at the low edge of the real spread',
    }),
    verdict: 'common is confirmed zero-information: real 0.80/200 bars on 55% of symbols against a null of 0.79 on '
      + '46.5% — the class describes noise and real charts identically. runaway is close behind (1.54 vs 1.35). '
      + 'breakaway keeps a ~7x lift over its measured-multiple null (0.07 vs 0.01) and stays the one selective class. '
      + 'exhaustion fires at 4x its calibrated null (0.40 vs 0.10), so it carries some selectivity once the volume '
      + 'parameter is measured rather than guessed. The classifier declines to guess 68% of real gaps, mirroring the '
      + 'null — a design property, not a defect.',
    still_missing: 'Closure-rate validation against Bulkowski\'s own numbers (breakaway ~1% filled within a week, '
      + 'common ~85-90%) needs longer history; no forward test; one universe, one period.',
  }),

  reproduce: 'node scripts/detector-noise.js --walks 200 (synthetic); node scripts/gaps-real-arm.js (real arm + null at the measured multiple)',
});
