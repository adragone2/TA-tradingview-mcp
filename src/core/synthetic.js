/**
 * Synthetic charts with KNOWN patterns, for measuring the detectors.
 *
 * Every test in this repo so far checks a detector against a fixture the same
 * author wrote to make it pass. That catches regressions and nothing else. It
 * cannot answer the two questions that decide whether pattern detection is
 * worth having at all:
 *
 *   1. When a pattern IS there, how often is it found?      (detection rate)
 *   2. When it is NOT there, how often is one reported?     (false-positive rate)
 *
 * The ground truth here comes from CONSTRUCTION — the bars are built to contain
 * a double top, so a double top is present by definition, and nothing about the
 * detector was consulted in building them. That is as close to an independent
 * check as is available without a second implementation.
 *
 * ── What this can and cannot prove ──
 *
 * It measures the detector against IDEALISED shapes with controllable noise. A
 * high detection rate here does not mean the detector works on real charts,
 * where patterns are ragged and overlapping. A LOW rate, or a high
 * false-positive rate on pure noise, is conclusive in the other direction — it
 * means the detector is broken regardless of how it behaves live.
 *
 * Seeded throughout, so a run is reproducible and a regression is attributable.
 *
 * All pure.
 */

/** Deterministic PRNG — a detector score that moves between runs is not a measurement. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400;

/**
 * Turn a path of closes into OHLC bars.
 *
 * `noise` is a fraction of price added as random wick and body jitter. Zero
 * gives a clean skeleton; realistic charts sit somewhere around 0.01-0.02.
 */
export function barsFromPath(path, { noise = 0, seed = 1, start = 1_700_000_000 } = {}) {
  const r = rng(seed);
  return path.map((c, i) => {
    const jitter = noise * c;
    const o = i === 0 ? c : path[i - 1] + (r() - 0.5) * jitter;
    const wickUp = r() * jitter;
    const wickDn = r() * jitter;
    return {
      time: start + i * DAY,
      open: o,
      close: c,
      high: Math.max(o, c) + wickUp,
      low: Math.min(o, c) - wickDn,
      volume: 1000 + Math.floor(r() * 500),
    };
  });
}

/** Linear interpolation between waypoints, `per` bars a leg. */
export function legs(points, per = 10) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < per; j++) {
      out.push(points[i] + ((points[i + 1] - points[i]) * j) / per);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Generators. Each returns a path whose shape contains the named pattern BY
 * CONSTRUCTION — the waypoints are the pattern.
 */
export const GENERATORS = {
  double_top: ({ per = 10 } = {}) =>
    legs([80, 100, 88, 100, 70], per),

  double_bottom: ({ per = 10 } = {}) =>
    legs([120, 100, 112, 100, 130], per),

  triple_top: ({ per = 9 } = {}) =>
    legs([70, 100, 84, 100, 84, 100, 65], per),

  triple_bottom: ({ per = 9 } = {}) =>
    legs([135, 100, 119, 100, 119, 100, 140], per),

  head_and_shoulders: ({ per = 9 } = {}) =>
    legs([65, 95, 80, 115, 80, 95, 60], per),

  inverse_head_and_shoulders: ({ per = 9 } = {}) =>
    legs([140, 105, 124, 85, 124, 105, 145], per),

  ascending_triangle: ({ per = 7 } = {}) =>
    legs([70, 100, 82, 100, 88, 100, 94, 100, 115], per),

  descending_triangle: ({ per = 7 } = {}) =>
    legs([130, 100, 118, 100, 112, 100, 106, 100, 85], per),

  symmetrical_triangle: ({ per = 7 } = {}) =>
    legs([70, 112, 88, 108, 92, 104, 96, 100, 120], per),

  // Three rectangles, because a rectangle is named for the trend it
  // interrupts. The shape is identical in all three; only the approach differs.
  rectangle: ({ per = 8 } = {}) =>
    legs([98, 100, 90, 100, 90, 100, 90, 100, 120], per),

  bullish_rectangle: ({ per = 8 } = {}) =>
    legs([60, 70, 85, 100, 90, 100, 90, 100, 90, 100, 120], per),

  bearish_rectangle: ({ per = 8 } = {}) =>
    legs([140, 130, 115, 100, 110, 100, 110, 100, 110, 100, 80], per),

  rising_wedge: ({ per = 7 } = {}) =>
    legs([70, 100, 86, 104, 94, 108, 100, 110, 80], per),

  falling_wedge: ({ per = 7 } = {}) =>
    legs([130, 100, 114, 96, 106, 92, 100, 90, 120], per),

  broadening_formation: ({ per = 7 } = {}) =>
    legs([100, 106, 94, 112, 88, 118, 82, 124], per),

  // A flag is a pole plus a SHORT pause, and the pause is the present — the
  // pattern is read while it is still forming, not after it resolves.
  bull_flag: ({ per = 6 } = {}) =>
    [...legs([60, 70], per * 2), ...legs([70, 100], per * 2), ...legs([100, 93], per)],

  bear_flag: ({ per = 6 } = {}) =>
    [...legs([140, 130], per * 2), ...legs([130, 100], per * 2), ...legs([100, 107], per)],


  // A pennant is a pole plus a CONVERGING pause — the shape a flag is not.
  bullish_pennant: ({ per = 6 } = {}) => [
    ...legs([60, 70], per * 2), ...legs([70, 100], per * 2),
    // converging zig-zag: swings shrink toward the apex
    ...legs([100, 93, 99, 95, 98, 96, 97.5], 2),
  ],

  bearish_pennant: ({ per = 6 } = {}) => [
    ...legs([140, 130], per * 2), ...legs([130, 100], per * 2),
    ...legs([100, 107, 101, 105, 102, 104, 102.5], 2),
  ],

  high_tight_flag: ({ per = 6 } = {}) =>
    [...legs([48, 50], per * 2), ...legs([50, 100], per * 3), ...legs([100, 92], per)],
};

/**
 * A chart with NO pattern in it: a random walk.
 *
 * This is the more important generator. Any detector can be made to find
 * patterns; the question is whether it finds them in noise, and a random walk
 * is the honest null hypothesis. Real markets are close to a random walk much
 * of the time, which is exactly why "patterns everywhere" is the failure mode
 * the literature warns about.
 */
export function randomWalk({ n = 200, start = 100, drift = 0, vol = 0.015, seed = 1 } = {}) {
  const r = rng(seed);
  const out = [start];
  for (let i = 1; i < n; i++) {
    const step = (r() - 0.5) * 2 * vol + drift;
    out.push(Math.max(1, out[i - 1] * (1 + step)));
  }
  return out;
}

/**
 * A random walk WITH overnight gaps — and it returns BARS, not a path.
 *
 * Read that again. `randomWalk` and every entry in GENERATORS return a PATH of
 * closes, which a caller turns into bars with `barsFromPath`. This one returns
 * `{ bars, injected_gaps, params }`, because a detector that reads open, high,
 * low or volume cannot be measured against a path and the mistake is invisible:
 * it produces a 0% noise floor, which reads as a perfect detector rather than
 * as a broken fixture. Returning a different shape makes the error a crash.
 *
 * ── Why this generator has to exist ──
 *
 * A reconstructed price path has NO overnight discontinuity. `barsFromPath`
 * builds bar i's open from path[i-1], so bar i always overlaps bar i-1 and the
 * gap condition (low > prior high) is unreachable by construction. Measuring a
 * gap detector against it returns 0.0% for every class — a number about the
 * generator, not the detector. It is the same failure that left ignition.js
 * without a noise floor: the null moved the GATE instead of the pattern.
 *
 * So gaps are INJECTED, and what gets measured is the classifier's selectivity
 * rather than whether gaps exist at all.
 *
 * ── How, and what each parameter assumes ──
 *
 * A gap is applied as a shift to bar i AND EVERY BAR AFTER IT, so the bar
 * shapes built by `barsFromPath` are untouched and the discontinuity sits
 * strictly between bar i-1 and bar i. That matters: true range counts a gap and
 * bar range does not, so a null that rebuilds bars would change the ATR-to-range
 * ratio and shift every ATR-gated clause. Shifting whole bars preserves it.
 *
 *   gap_rate            share of bars that gap.
 *   gap_median_atr      median gap size in units of the mean bar range.
 *   gap_sigma           lognormal spread, so sizes are heavy-tailed like real ones.
 *   volume_mode         'flat'          — the harness's near-constant volume.
 *                       'lognormal'     — dispersed, gap bars NOT elevated.
 *                       'gap_elevated'  — dispersed, gap bars multiplied.
 *
 * ── The defaults are CALIBRATED, not guessed ──
 *
 * ignition.js's floor died on one statistic: ATR counts overnight gaps and bar
 * range does not, so the ATR-to-range ratio is what any gap-gated rule actually
 * keys on. That investigation measured it on real daily bars — **1.070** —
 * against **1.001** for a reconstructed gapless path
 * (IGNITION_NOISE_BASELINE.why_not_established).
 *
 * So the defaults here were swept against that number rather than picked:
 * gap_rate 0.06 with gap_median_atr 0.35 produces **1.068**, and 7.1% of bars
 * carrying a visible gap. Every other combination tried misses it — 0.10/0.50
 * gives 1.126, which would gate very differently. If a better real-data
 * estimate arrives, re-sweep and say so; this is a calibration to one measured
 * statistic, not a claim to have modelled real gaps.
 *
 * `volume_mode` is exposed rather than fixed because the choice MOVES THE
 * ANSWER for any clause that reads volume, and quietly picking one would be the
 * ignition.js mistake again. Measure both and report both.
 *
 * Sign is symmetric, so the injected gaps add no drift. They do add variance;
 * that is intended and stated rather than corrected away.
 */
export function randomWalkWithGaps({
  n = 200, start = 100, drift = 0, vol = 0.015, seed = 1,
  noise = 0.006,
  gap_rate = 0.06,
  gap_median_atr = 0.35,
  gap_sigma = 0.8,
  volume_mode = 'gap_elevated',
  base_volume = 1_000_000,
  volume_sigma = 0.35,
  gap_volume_multiple = 2.0,
} = {}) {
  const path = randomWalk({ n, start, drift, vol, seed });
  const bars = barsFromPath(path, { noise, seed: seed + 1 });

  // Scale gaps to the bars actually produced, so gap_median_atr means the same
  // thing at any volatility.
  const ranges = bars.map((b) => b.high - b.low).filter((r) => Number.isFinite(r) && r > 0);
  const refRange = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 1;

  const r = rng(seed + 977);
  /** Box-Muller, so the lognormal draw is a real lognormal and not a uniform. */
  const normal = () => {
    const u1 = Math.max(1e-12, r());
    const u2 = r();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const injected = [];
  let shift = 0;
  for (let i = 1; i < bars.length; i++) {
    if (r() < gap_rate) {
      /**
       * The shift is solved for the gap it is supposed to PRODUCE, not drawn
       * and hoped over. Consecutive bars from `barsFromPath` overlap by roughly
       * a bar range, so a drawn offset smaller than that overlap leaves no gap
       * at all — and a first cut of this generator, which simply discarded
       * those, achieved 1.6% of bars gapping while reporting `gap_rate: 0.10`.
       * A null whose stated frequency is six times its actual one answers a
       * different question than the one asked of it.
       *
       * Solving instead makes `gap_rate` exact and `gap_median_atr` the median
       * size of the RESULTING gap, which is the quantity a reviewer can
       * re-estimate from real bars.
       */
      const g = gap_median_atr * Math.exp(gap_sigma * normal()) * refRange;
      const up = r() < 0.5;
      // bars[i-1] already carries the running shift; bars[i] does not yet. So
      // the new shift is solved absolutely, NOT added to the old one — adding
      // applies the accumulated shift twice and compounds a 100 into 79,600
      // over 200 bars, which a per-walk price range check caught immediately.
      shift = up
        ? bars[i - 1].high + g - bars[i].low
        : bars[i - 1].low - g - bars[i].high;
      injected.push({ index: i, size: g, size_in_ref_ranges: g / refRange, direction: up ? 'up' : 'down' });
    }
    bars[i] = { ...bars[i], open: bars[i].open + shift, high: bars[i].high + shift, low: bars[i].low + shift, close: bars[i].close + shift };
  }

  // Keep prices positive without touching the gap structure.
  const minLow = Math.min(...bars.map((b) => b.low));
  if (minLow <= 1) {
    const lift = 1 - minLow + start * 0.1;
    for (let i = 0; i < bars.length; i++) {
      bars[i] = { ...bars[i], open: bars[i].open + lift, high: bars[i].high + lift, low: bars[i].low + lift, close: bars[i].close + lift };
    }
  }

  if (volume_mode !== 'flat') {
    const gapAt = new Set(injected.map((g) => g.index));
    const vr = rng(seed + 4231);
    const vnormal = () => {
      const u1 = Math.max(1e-12, vr());
      const u2 = vr();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    for (let i = 0; i < bars.length; i++) {
      const mult = volume_mode === 'gap_elevated' && gapAt.has(i) ? gap_volume_multiple : 1;
      bars[i] = { ...bars[i], volume: Math.round(base_volume * Math.exp(volume_sigma * vnormal()) * mult) };
    }
  }

  return {
    bars,
    injected_gaps: injected,
    params: { n, start, drift, vol, seed, noise, gap_rate, gap_median_atr, gap_sigma, volume_mode, base_volume, volume_sigma, gap_volume_multiple },
    note: 'Returns BARS, not a path. gap_rate and gap_median_atr are stated assumptions about real markets, not '
      + 'measurements from them — re-estimate from real bars before quoting any floor measured with this.',
  };
}

/**
 * Measure a detector against constructed truth.
 *
 * `detect(bars)` must return an array of pattern-name strings.
 *
 * Reports detection rate per pattern and, separately, the false-positive rate
 * on random walks. The second number is the one that matters most: a detector
 * that finds shapes in noise makes every real detection unreadable.
 */
export function measure(detect, {
  patterns = Object.keys(GENERATORS),
  noise_levels = [0, 0.01, 0.02],
  trials = 8,
  walk_trials = 40,
  walk_bars = 200,
} = {}) {
  const perPattern = [];

  for (const name of patterns) {
    const gen = GENERATORS[name];
    if (!gen) continue;
    const byNoise = [];
    for (const noise of noise_levels) {
      let found = 0;
      for (let t = 0; t < trials; t++) {
        const bars = barsFromPath(gen({}), { noise, seed: 1000 + t });
        if (detect(bars).includes(name)) found++;
      }
      byNoise.push({ noise, detected: found, of: trials, rate_pct: Math.round((found / trials) * 100) });
    }
    perPattern.push({
      pattern: name,
      by_noise: byNoise,
      clean_rate_pct: byNoise[0]?.rate_pct ?? null,
    });
  }

  // The null hypothesis: how often does anything fire on a random walk?
  let walksWithAny = 0;
  let totalHits = 0;
  const walksWith = {};      // distinct walks containing the pattern at least once
  const occurrences = {};    // total detections, which is a different number
  for (let t = 0; t < walk_trials; t++) {
    const bars = barsFromPath(randomWalk({ n: walk_bars, seed: 5000 + t }), { noise: 0.005, seed: 9000 + t });
    const hits = detect(bars);
    if (hits.length) walksWithAny++;
    totalHits += hits.length;
    for (const h of new Set(hits)) walksWith[h] = (walksWith[h] || 0) + 1;
    for (const h of hits) occurrences[h] = (occurrences[h] || 0) + 1;
  }

  const falsePositives = Object.keys(occurrences)
    .map((pattern) => ({
      pattern,
      walks_containing: walksWith[pattern] || 0,
      walk_rate_pct: Math.round(((walksWith[pattern] || 0) / walk_trials) * 100),
      total_detections: occurrences[pattern],
      per_walk: Math.round((occurrences[pattern] / walk_trials) * 100) / 100,
    }))
    .sort((a, b) => b.total_detections - a.total_detections);

  return {
    per_pattern: perPattern.sort((a, b) => (a.clean_rate_pct ?? 0) - (b.clean_rate_pct ?? 0)),
    random_walk: {
      trials: walk_trials,
      bars_each: walk_bars,
      walks_with_any_pattern: walksWithAny,
      any_pattern_rate_pct: Math.round((walksWithAny / walk_trials) * 100),
      total_detections: totalHits,
      detections_per_walk: Math.round((totalHits / walk_trials) * 100) / 100,
      by_pattern: falsePositives,
    },
    method: 'Ground truth comes from construction: the bars are built to contain the named shape, and nothing about the detector was consulted in building them. Seeded, so a run is reproducible.',
    caveat: 'These are idealised shapes. A high detection rate does NOT mean the detector works on real charts, where patterns are ragged and overlapping. A low rate, or a high random-walk rate, IS conclusive the other way — it means the detector is broken regardless of live behaviour.',
  };
}
