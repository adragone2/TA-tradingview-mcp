/**
 * Elliott wave counts — enumerated and rule-checked, never chosen.
 *
 * ── Why this is built the way it is ──
 *
 * Elliott wave is openly subjective. Two analysts produce two different valid
 * counts on the same chart; it has no peer-reviewed support; and counting in
 * hindsight is far easier than counting in real time, which is exactly the bias
 * that makes it look better than it performs. Its own teachers say all of this.
 *
 * A tool that returned "the count" would be picking one reading out of several
 * and presenting a judgement call as a measurement. So this does not do that.
 *
 * What it does instead: enumerate EVERY five-wave count the swing data supports,
 * test each against the five rules — which are objective once a count is
 * proposed — and return all the ones that survive, with the number of them
 * stated. If seven counts are valid, seven is the answer, and that number IS the
 * finding: it is the subjectivity of the method, quantified for this chart.
 *
 * The Fibonacci relationships are reported the same way — as measured ratios
 * next to the bands they are conventionally expected to fall in, so a count that
 * satisfies the rules but fits none of the ratios is visibly weaker than one
 * that fits all four, without either being called correct.
 *
 * ── The five rules ──
 *
 * Rules 1-4 are hard: a count that breaks one is not an Elliott count. Rule 5
 * (a motive wave subdivides into five) is satisfied by construction here, since
 * a count is only built from five waves in the first place.
 *
 * All pure.
 */
import { findSwings, alternateSwings } from './structure.js';

const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Conventional Fibonacci bands for each wave relationship. Guidelines, not rules. */
export const WAVE_RATIOS = {
  wave2_retrace: { low: 0.5, high: 0.618, of: 'wave 1', label: 'wave 2 retracement' },
  wave4_retrace: { low: 0.236, high: 0.5, of: 'wave 3', label: 'wave 4 retracement' },
  wave3_vs_1: { low: 1.618, high: 2.618, of: 'wave 1', label: 'wave 3 extension' },
  wave5_vs_1: { low: 0.618, high: 1.618, of: 'wave 1', label: 'wave 5 vs wave 1' },
};

/**
 * Check one proposed count against the five rules.
 *
 * `pts` is six alternating swing points: the start of wave 1, then the end of
 * each wave 1 through 5.
 */
export function checkRules(pts, direction) {
  const [p0, p1, p2, p3, p4, p5] = pts.map((p) => p.price);
  const up = direction === 'up';

  const len = (a, b) => Math.abs(b - a);
  const w1 = len(p0, p1), w3 = len(p2, p3), w5 = len(p4, p5);

  const violations = [];

  // Rule 1 — wave 2 never retraces past the start of wave 1.
  if (up ? p2 <= p0 : p2 >= p0) {
    violations.push('wave 2 retraced past the start of wave 1');
  }
  // Rule 2 — wave 3 is never the shortest of 1, 3 and 5.
  if (w3 < w1 && w3 < w5) {
    violations.push('wave 3 is the shortest of waves 1, 3 and 5');
  }
  // Rule 3 — wave 3 always moves beyond the end of wave 1.
  if (up ? p3 <= p1 : p3 >= p1) {
    violations.push('wave 3 did not move beyond the end of wave 1');
  }
  // Rule 4 — wave 4 never enters the price territory of wave 1.
  // (Diagonals are the documented exception and are reported, not silently allowed.)
  if (up ? p4 <= p1 : p4 >= p1) {
    violations.push('wave 4 overlapped the price territory of wave 1');
  }

  // Truncation is not a rule violation but it invalidates the count as a
  // completed impulse: wave 5 failed to exceed wave 3.
  const truncated = up ? p5 <= p3 : p5 >= p3;

  return { valid: violations.length === 0, violations, truncated };
}

/** Measure the four conventional Fibonacci relationships for a count. */
function measureRatios(pts, direction) {
  const [p0, p1, p2, p3, p4, p5] = pts.map((p) => p.price);
  const len = (a, b) => Math.abs(b - a);
  const w1 = len(p0, p1) || null;
  const w3 = len(p2, p3);

  const measured = {
    wave2_retrace: w1 ? len(p1, p2) / w1 : null,
    wave4_retrace: w3 ? len(p3, p4) / w3 : null,
    wave3_vs_1: w1 ? w3 / w1 : null,
    wave5_vs_1: w1 ? len(p4, p5) / w1 : null,
  };

  const out = {};
  let inBand = 0;
  for (const [key, band] of Object.entries(WAVE_RATIOS)) {
    const v = measured[key];
    const fits = v != null && v >= band.low && v <= band.high;
    if (fits) inBand++;
    out[key] = {
      measured: round(v, 3),
      typical: `${band.low}-${band.high} of ${band.of}`,
      fits_typical: fits,
    };
  }
  return { ratios: out, ratios_in_band: inBand, ratios_checked: Object.keys(WAVE_RATIOS).length };
}

/**
 * Alternation: wave 2 and wave 4 tend to differ in character — one deep, the
 * other shallow. An observation, not a rule, so it is reported and never used
 * to reject a count.
 */
function checkAlternation(ratios) {
  const w2 = ratios.wave2_retrace.measured;
  const w4 = ratios.wave4_retrace.measured;
  if (w2 == null || w4 == null) return null;
  const differ = Math.abs(w2 - w4) >= 0.15;
  return {
    wave2_retrace: w2,
    wave4_retrace: w4,
    alternates: differ,
    note: differ
      ? 'Waves 2 and 4 differ in depth, which is what the guideline of alternation expects.'
      : 'Waves 2 and 4 retraced by similar amounts. Alternation expects them to differ; this count does not show it.',
  };
}

/**
 * Enumerate every rule-valid five-wave count in the bars.
 *
 * Counts are built from six CONSECUTIVE alternating swings. Allowing
 * non-consecutive swings would multiply the candidates enormously and is where
 * most of Elliott's flexibility — and most of its unfalsifiability — lives.
 * Sensitivity is instead controlled by `lookback`, and running several is the
 * honest way to see how much the count depends on that choice.
 */
export function findCounts(bars, { lookback = 5, include_truncated = false } = {}) {
  const swings = alternateSwings(findSwings(bars, { lookback }));
  if (swings.length < 6) {
    return {
      counts: [], candidates_examined: 0, lookback,
      note: `Only ${swings.length} alternating swings at lookback ${lookback} — a five-wave count needs six. Lower the lookback for more swings, or the chart simply has no impulse in it.`,
    };
  }

  const last = bars[bars.length - 1];
  const results = [];
  let examined = 0;

  for (let i = 0; i + 5 < swings.length; i++) {
    const pts = swings.slice(i, i + 6);
    // An upward impulse starts at a low and ends at a high, and vice versa.
    const direction = pts[0].kind === 'low' ? 'up' : 'down';
    if (pts[5].kind === pts[0].kind) continue;
    examined++;

    const { valid, violations, truncated } = checkRules(pts, direction);
    if (!valid) continue;
    if (truncated && !include_truncated) continue;

    const { ratios, ratios_in_band, ratios_checked } = measureRatios(pts, direction);

    results.push({
      direction,
      truncated,
      waves: [
        { wave: 1, from: round(pts[0].price), to: round(pts[1].price), from_time: pts[0].time, to_time: pts[1].time },
        { wave: 2, from: round(pts[1].price), to: round(pts[2].price), from_time: pts[1].time, to_time: pts[2].time },
        { wave: 3, from: round(pts[2].price), to: round(pts[3].price), from_time: pts[2].time, to_time: pts[3].time },
        { wave: 4, from: round(pts[3].price), to: round(pts[4].price), from_time: pts[3].time, to_time: pts[4].time },
        { wave: 5, from: round(pts[4].price), to: round(pts[5].price), from_time: pts[4].time, to_time: pts[5].time },
      ],
      start_time: pts[0].time,
      end_time: pts[5].time,
      bars_since_end: Math.max(0, bars.length - 1 - pts[5].index),
      ratios,
      ratios_in_band,
      ratios_checked,
      alternation: checkAlternation(ratios),
      rule_violations: violations,
      // Wave 3 extending into its own five-wave structure is the commonest
      // extension, and shows up here simply as an unusually long wave 3.
      wave3_extended: ratios.wave3_vs_1.measured != null && ratios.wave3_vs_1.measured >= 1.618,
      complete: pts[5].index < bars.length - 1,
      current_price: round(last.close),
    });
  }

  // Most recent first, then by how many Fibonacci bands they satisfy — a
  // ranking of fit, explicitly not a ranking of correctness.
  results.sort((a, b) => (b.end_time - a.end_time) || (b.ratios_in_band - a.ratios_in_band));

  return {
    counts: results,
    valid_count_total: results.length,
    candidates_examined: examined,
    lookback,
    ...(results.length === 0
      ? { note: `No rule-valid five-wave count exists at lookback ${lookback} — ${examined} candidate windows were checked and every one broke a rule. Most charts are not in a clean impulse, and that is a real answer.` }
      : {}),
  };
}

/**
 * Run the enumeration at several sensitivities.
 *
 * This is the point of the module. "Two analysts get different valid counts" is
 * the standard criticism of Elliott wave, and it is usually left as a remark.
 * Here it becomes a number: if three sensitivities produce three different sets
 * of valid counts, the disagreement is measured rather than asserted, and the
 * reader can weigh the method accordingly.
 */
export function surveyCounts(bars, { lookbacks = [3, 5, 8], include_truncated = false } = {}) {
  const runs = lookbacks.map((lb) => {
    const r = findCounts(bars, { lookback: lb, include_truncated });
    return {
      lookback: lb,
      valid_counts: r.valid_count_total || 0,
      candidates_examined: r.candidates_examined,
      most_recent: r.counts[0]
        ? {
            direction: r.counts[0].direction,
            wave1_from: r.counts[0].waves[0].from,
            wave5_to: r.counts[0].waves[4].to,
            ratios_in_band: r.counts[0].ratios_in_band,
          }
        : null,
    };
  });

  const total = runs.reduce((s, r) => s + r.valid_counts, 0);
  const distinct = new Set(
    runs.filter((r) => r.most_recent).map((r) => `${r.most_recent.direction}:${r.most_recent.wave1_from}:${r.most_recent.wave5_to}`),
  ).size;

  return {
    runs,
    total_valid_counts: total,
    distinct_recent_counts: distinct,
    agreement: distinct === 0
      ? 'No sensitivity produced a rule-valid count. The chart is not in a countable impulse.'
      : distinct === 1
        ? 'Every sensitivity that found a count found the SAME most-recent one. That is the strongest agreement this method offers.'
        : `${distinct} different most-recent counts across ${runs.length} sensitivities. This is the subjectivity of Elliott wave made concrete — the count depends on how the swings were detected, and no sensitivity is more correct than another.`,
    method: 'Counts are built from six consecutive alternating swings and tested against the five rules. Sensitivity is varied through the swing lookback; allowing non-consecutive swings would multiply candidates and is where most of the method\'s unfalsifiability lives.',
  };
}

/** The honesty block, attached to every answer this module produces. */
export const ELLIOTT_CAVEAT = {
  subjective: 'Elliott wave is subjective by construction. Two analysts produce two different valid counts on the same chart, and this tool returns every count the rules allow rather than picking one.',
  no_evidence: 'The theory has no peer-reviewed support. It rests on Elliott\'s own observations, and its subjectivity is largely what makes it hard to test.',
  hindsight: 'Counting is far easier after the fact than in real time. The last swing needs bars to its right before it confirms, so the most recent wave is always the least certain — which is exactly the one a trade would depend on.',
  use: 'Best used as a road map that confirms an idea reached another way, not as a signal on its own. Combine it with structure, a level that has actually been tested, and a confirmation at the entry.',
};
