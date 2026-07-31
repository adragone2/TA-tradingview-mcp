/**
 * The volatility contraction pattern, as a measurable rule.
 *
 * Minervini's VCP is the one setup in the practitioner literature that is
 * fully mechanical: successive pullbacks each shallower than the last, volume
 * drying up through the contractions, and expansion on the breakout. Every
 * clause is a number, so it can be measured against constructed truth and
 * against random walks like anything else here.
 *
 * That is the reason it is implemented and, say, "institutional accumulation"
 * is not. The claim attached to VCP — championship track records — is not
 * evidence this repo can verify. The SHAPE is checkable, and checking it is
 * the whole contribution.
 *
 * ── What the shape asserts ──
 *
 * A base forms after an advance. Price pulls back, recovers, pulls back less
 * deeply, recovers, pulls back less again. The canonical illustration is
 * roughly 18% -> 12% -> 6%, each contraction about half the last. Volume
 * declines through the sequence because sellers are being exhausted, and the
 * pivot is the high of the final, tightest contraction.
 *
 * ── What it does not assert ──
 *
 * Nothing about what happens next. A VCP is a setup, and this module reports
 * it as one. See NR7 in patterns.js for what measured base rates look like on
 * a volatility contraction: a 46% failure rate on the up breakout.
 *
 * All pure.
 */

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * How often this fires on data with no pattern in it.
 *
 * Measured over 200 random walks of 200 bars with synthetic volume: **zero**
 * detections. That is the most selective result of anything in this repo, and
 * by a wide margin — our structural detector puts a pattern on 68% of random
 * walks, and the Lo/Mamaysky/Wang definitions match 43% of five-pivot windows.
 *
 * The reason is that VCP is a conjunction of six independent numeric clauses,
 * where most chart patterns are one or two. Requiring monotonic tightening AND
 * a prior advance AND volume dry-up AND a tight final contraction is simply a
 * much harder thing for noise to satisfy by accident.
 *
 * Worth stating the flip side: selectivity is not accuracy. A rule that never
 * fires on noise can still be useless if what it fires on does not go
 * anywhere. This number says the detections are rare, not that they are right.
 */
export const VCP_NOISE_BASELINE = {
  walks: 200,
  bars_each: 200,
  detections: 0,
  rate_pct: 0,
  for_comparison: {
    structural_patterns_any: '64.5% of random walks contain at least one (patterns.js NOISE_BASELINE, unified 200-walk harness)',
    lmw_definitions: '37.9% of five-pivot windows match at least one (lmw_patterns.js LMW_NOISE_PROFILE)',
  },
  caveat: 'Selectivity is not accuracy. Firing rarely on noise says detections are rare, not that they resolve well.',
};

export const VCP_DEFAULTS = {
  min_contractions: 3,          // Minervini's own examples run 2-6; 3 is the usual minimum
  max_contractions: 6,
  tightening_ratio: 0.85,       // each pullback must be at most this fraction of the prior
  min_first_pullback_pct: 5,    // below this there is no base, just noise
  max_first_pullback_pct: 50,   // beyond this it is a decline, not a consolidation
  max_final_pullback_pct: 12,   // the last contraction must actually be tight
  min_prior_advance_pct: 20,    // a base needs something to consolidate
  prior_advance_bars: 60,
  require_volume_dryup: true,
  volume_dryup_ratio: 0.9,      // final contraction's volume vs the first's
  swing_lookback: 3,
};

/**
 * Find alternating swing highs and lows with a simple fractal rule.
 *
 * Deliberately NOT the kernel detector: VCP is defined on visible pullbacks,
 * and smoothing would merge the tight late contractions that are the whole
 * point of the pattern.
 */
function swings(bars, lookback) {
  const out = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const w = bars.slice(i - lookback, i + lookback + 1);
    if (bars[i].high === Math.max(...w.map((b) => b.high))) out.push({ index: i, kind: 'high', price: bars[i].high });
    else if (bars[i].low === Math.min(...w.map((b) => b.low))) out.push({ index: i, kind: 'low', price: bars[i].low });
  }
  // Alternate, keeping the more extreme of any run.
  const alt = [];
  for (const s of out) {
    const last = alt[alt.length - 1];
    if (!last || last.kind !== s.kind) { alt.push(s); continue; }
    const better = s.kind === 'high' ? s.price > last.price : s.price < last.price;
    if (better) alt[alt.length - 1] = s;
  }
  return alt;
}

function avgVolume(bars, from, to) {
  const seg = bars.slice(Math.max(0, from), Math.min(bars.length, to + 1));
  const vols = seg.map((b) => b.volume).filter((v) => Number.isFinite(v) && v > 0);
  return vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
}

/**
 * Detect a VCP ending at the most recent bars.
 *
 * Returns a single result with `qualifies` plus every individual check, so a
 * near-miss is legible rather than a bare false. Which clause failed is the
 * useful output — "three contractions but the last was 15% deep" is actionable
 * where "no VCP" is not.
 */
export function detectVCP(bars, options = {}) {
  const o = { ...VCP_DEFAULTS, ...options };
  if (!Array.isArray(bars) || bars.length < 40) {
    return { qualifies: false, reason: 'insufficient_bars', note: `Need at least 40 bars, have ${bars?.length ?? 0}.` };
  }

  const sw = swings(bars, o.swing_lookback);
  if (sw.length < 4) {
    return { qualifies: false, reason: 'too_few_swings', swings_found: sw.length,
      note: 'A VCP needs at least two high-low-high sequences to have two contractions to compare.' };
  }

  // Contractions: each high followed by a low. Depth is measured from the high.
  const contractions = [];
  for (let i = 0; i < sw.length - 1; i++) {
    if (sw[i].kind !== 'high' || sw[i + 1].kind !== 'low') continue;
    const high = sw[i], low = sw[i + 1];
    contractions.push({
      high_index: high.index, low_index: low.index,
      high: round(high.price, 4), low: round(low.price, 4),
      depth_pct: round(((high.price - low.price) / high.price) * 100),
      bars: low.index - high.index,
      avg_volume: avgVolume(bars, high.index, low.index),
    });
  }

  if (contractions.length < 2) {
    return { qualifies: false, reason: 'too_few_contractions', contractions,
      note: 'Fewer than two pullbacks — nothing to compare for tightening.' };
  }

  // Take the longest trailing run that tightens monotonically.
  let run = [contractions[contractions.length - 1]];
  for (let i = contractions.length - 2; i >= 0; i--) {
    const nextDepth = run[0].depth_pct;
    const thisDepth = contractions[i].depth_pct;
    if (nextDepth <= thisDepth * o.tightening_ratio) run.unshift(contractions[i]);
    else break;
  }
  if (run.length > o.max_contractions) run = run.slice(-o.max_contractions);

  const first = run[0], last = run[run.length - 1];
  const priorStart = Math.max(0, first.high_index - o.prior_advance_bars);
  const priorLow = Math.min(...bars.slice(priorStart, first.high_index + 1).map((b) => b.low));
  const priorAdvance = ((first.high - priorLow) / priorLow) * 100;

  const volFirst = first.avg_volume, volLast = last.avg_volume;
  const volRatio = volFirst && volLast ? volLast / volFirst : null;

  const checks = {
    enough_contractions: {
      pass: run.length >= o.min_contractions,
      value: run.length, required: `>= ${o.min_contractions}`,
    },
    each_tighter_than_last: {
      pass: run.every((c, i) => i === 0 || c.depth_pct <= run[i - 1].depth_pct * o.tightening_ratio),
      value: run.map((c) => `${c.depth_pct}%`).join(' -> '),
      required: `each <= ${o.tightening_ratio}x the prior`,
    },
    first_pullback_in_range: {
      pass: first.depth_pct >= o.min_first_pullback_pct && first.depth_pct <= o.max_first_pullback_pct,
      value: `${first.depth_pct}%`, required: `${o.min_first_pullback_pct}-${o.max_first_pullback_pct}%`,
    },
    final_contraction_tight: {
      pass: last.depth_pct <= o.max_final_pullback_pct,
      value: `${last.depth_pct}%`, required: `<= ${o.max_final_pullback_pct}%`,
    },
    prior_advance: {
      pass: priorAdvance >= o.min_prior_advance_pct,
      value: `${round(priorAdvance)}%`, required: `>= ${o.min_prior_advance_pct}%`,
      note: 'A base consolidates a prior move. Without one this is a bottoming attempt, which is a different thing.',
    },
    volume_dryup: o.require_volume_dryup
      ? {
          pass: volRatio != null && volRatio <= o.volume_dryup_ratio,
          value: volRatio == null ? 'no volume data' : `${round(volRatio, 3)}x`,
          required: `<= ${o.volume_dryup_ratio}x the first contraction`,
          ...(volRatio == null ? { note: 'Volume was not available on these bars, so this clause could not be tested — it is NOT a pass.' } : {}),
        }
      : { pass: true, value: 'not required', required: 'disabled' },
  };

  const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([k]) => k);
  const pivot = last.high;
  const lastBar = bars[bars.length - 1];

  return {
    qualifies: failed.length === 0,
    contractions: run,
    contraction_count: run.length,
    depths_pct: run.map((c) => c.depth_pct),
    checks,
    ...(failed.length ? { failed_checks: failed } : {}),
    pivot: round(pivot, 4),
    pivot_distance_pct: round(((pivot - lastBar.close) / lastBar.close) * 100),
    prior_advance_pct: round(priorAdvance),
    volume_ratio_last_vs_first: volRatio == null ? null : round(volRatio, 3),
    bars_since_last_low: bars.length - 1 - last.low_index,
    definition: 'Successive pullbacks each at most '
      + `${o.tightening_ratio}x the depth of the prior, on declining volume, after an advance. The pivot is the high of the `
      + 'final contraction.',
    what_it_is_not: 'A VCP is a SETUP, not a direction. Nothing here forecasts the breakout. For what a measured volatility '
      + 'contraction actually does, see NARROW_RANGE_STATS in patterns.js: Bulkowski\'s NR7 up-breakout fails to move 5% '
      + '46% of the time in a bull market.',
    provenance: 'Minervini\'s VCP, implemented from the published description. The track record attached to it is a claim '
      + 'this repo cannot verify; the shape is what has been made checkable.',
  };
}
