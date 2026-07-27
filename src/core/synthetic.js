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
    legs([80, 100, 90, 100, 90, 100, 70], per),

  triple_bottom: ({ per = 9 } = {}) =>
    legs([120, 100, 110, 100, 110, 100, 130], per),

  head_and_shoulders: ({ per = 9 } = {}) =>
    legs([70, 95, 85, 110, 85, 95, 65], per),

  inverse_head_and_shoulders: ({ per = 9 } = {}) =>
    legs([130, 105, 115, 90, 115, 105, 135], per),

  ascending_triangle: ({ per = 7 } = {}) =>
    legs([70, 100, 82, 100, 88, 100, 94, 100, 115], per),

  descending_triangle: ({ per = 7 } = {}) =>
    legs([130, 100, 118, 100, 112, 100, 106, 100, 85], per),

  symmetrical_triangle: ({ per = 7 } = {}) =>
    legs([70, 112, 88, 108, 92, 104, 96, 100, 120], per),

  rectangle: ({ per = 8 } = {}) =>
    legs([70, 100, 90, 100, 90, 100, 90, 100, 120], per),

  rising_wedge: ({ per = 7 } = {}) =>
    legs([70, 100, 86, 104, 94, 108, 100, 110, 80], per),

  falling_wedge: ({ per = 7 } = {}) =>
    legs([130, 100, 114, 96, 106, 92, 100, 90, 120], per),

  broadening_formation: ({ per = 7 } = {}) =>
    legs([100, 106, 94, 112, 88, 118, 82, 124], per),

  bull_flag: ({ per = 6 } = {}) =>
    [...legs([70, 120], per * 3), ...legs([120, 112], per), ...legs([112, 150], per * 2)],

  bear_flag: ({ per = 6 } = {}) =>
    [...legs([150, 100], per * 3), ...legs([100, 108], per), ...legs([108, 70], per * 2)],
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
