/**
 * Does a level get STRONGER or WEAKER each time it is tested?
 *
 * Almost every level-finding tool, including `findKeyLevels` in this repo,
 * scores touch count as *strength*: a level tested four times outranks one
 * tested twice. Shannon says the opposite, and says it twice — once for
 * resistance and once for support:
 *
 *   Figure 7.4: "The more times a level of support or resistance is tested, the
 *                more likely it is for the stock to VIOLATE that level."
 *   Figure 7.5: "The more times support is tested, the more likely it is that
 *                the level will fail to hold the stock up."
 *
 * And unlike most claims of this kind he gives an arithmetic mechanism rather
 * than a metaphor: a seller with 500,000 shares to dispose of is worked through
 * 300,000 on the first test and 125,000 on the second, leaving 75,000 — "the
 * next test may be the one where buyers overwhelm the supply." Absorption, not
 * reinforcement.
 *
 * He also gives two SUPPORTING clauses, both computable, and both about
 * aggression rather than count:
 *
 *   - the interim pullback lows RISING between tests of resistance (10.50 →
 *     9.25 → 9.50 in his figure) is buyers "becoming more aggressive through
 *     price". Mirrored for support: falling interim highs.
 *   - the tests coming CLOSER TOGETHER is aggression "time-wise".
 *
 * ── Why the naive version of this is trivially true ──
 *
 * More touches means more opportunities to break. A level tested ten times has
 * survived nine and been exposed ten; on a random walk P(break | n tests) rises
 * with n for that reason alone, with no absorption anywhere. So the measurement
 * that means anything is the SHAPE of P(break | n) on real data against the
 * same shape on a random walk — and the two supporting clauses measured as
 * conditionals, since those are where a real mechanism would show up.
 *
 * `scripts/level-test-inversion.js` runs both arms. Nothing here is a tool
 * until that measurement says it earns one.
 *
 * All pure.
 */
const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Track one level forward from the swing that formed it, recording every test
 * and whether it eventually broke.
 *
 * A TEST is entry into the band after being clear of it for `gap` bars — the
 * same definition `countTests` uses, so the two agree.
 *
 * A BREAK is a CLOSE beyond the band by `break_margin_pct`, within
 * `resolve_bars` of the test. A wick through with a close back inside is not a
 * break; conflating the two is what makes every level look fragile.
 */
export function trackLevel(bars, {
  from_index,
  price,
  kind,                    // 'resistance' | 'support'
  tolerance_pct = 0.5,
  gap = 3,
  break_margin_pct = 0.3,
  resolve_bars = 5,
  max_tests = 12,
} = {}) {
  const tol = price * (tolerance_pct / 100);
  const bandLow = price - tol;
  const bandHigh = price + tol;
  const isRes = kind === 'resistance';
  const breakLevel = isRes
    ? bandHigh * (1 + break_margin_pct / 100)
    : bandLow * (1 - break_margin_pct / 100);

  const tests = [];
  let inside = false;
  let outsideRun = 0;

  for (let i = from_index + 1; i < bars.length && tests.length < max_tests; i += 1) {
    const b = bars[i];
    const touching = b.low <= bandHigh && b.high >= bandLow;

    if (!touching) {
      if (inside) { outsideRun += 1; if (outsideRun >= gap) inside = false; }
      continue;
    }
    outsideRun = 0;
    if (inside) continue;
    inside = true;

    // Resolve this test: did a close clear the band within resolve_bars?
    let broke = false;
    let breakIndex = null;
    for (let j = i; j < Math.min(bars.length, i + resolve_bars + 1); j += 1) {
      if (isRes ? bars[j].close > breakLevel : bars[j].close < breakLevel) {
        broke = true; breakIndex = j; break;
      }
    }

    // The interim extreme since the previous test — the "aggression through
    // price" clause. For resistance that is the lowest low between tests.
    let interim = null;
    const prev = tests[tests.length - 1];
    if (prev) {
      let ext = isRes ? Infinity : -Infinity;
      for (let j = prev.index + 1; j < i; j += 1) {
        ext = isRes ? Math.min(ext, bars[j].low) : Math.max(ext, bars[j].high);
      }
      if (Number.isFinite(ext)) interim = ext;
    }

    tests.push({
      test_number: tests.length + 1,
      index: i,
      bars_since_previous: prev ? i - prev.index : null,
      interim_extreme: interim === null ? null : round(interim, 6),
      broke,
      break_index: breakIndex,
    });

    if (broke) break;  // the level is gone; later touches are a different level
  }

  // The two supporting clauses, as booleans over the test sequence.
  const interims = tests.map((t) => t.interim_extreme).filter((v) => v !== null);
  const intervals = tests.map((t) => t.bars_since_previous).filter((v) => v !== null);

  const aggressionThroughPrice = interims.length >= 2
    ? (isRes
        // Rising pullback lows between tests of resistance.
        ? interims[interims.length - 1] > interims[0]
        // Falling rally highs between tests of support.
        : interims[interims.length - 1] < interims[0])
    : null;

  const aggressionThroughTime = intervals.length >= 2
    ? intervals[intervals.length - 1] < intervals[0]
    : null;

  return {
    kind,
    price: round(price, 6),
    band: { low: round(bandLow, 6), high: round(bandHigh, 6) },
    tests,
    test_count: tests.length,
    broke: tests.some((t) => t.broke),
    broke_on_test: tests.find((t) => t.broke)?.test_number ?? null,
    aggression_through_price: aggressionThroughPrice,
    aggression_through_time: aggressionThroughTime,
  };
}

/**
 * Run `trackLevel` over every swing in a series and tabulate P(break | test n).
 *
 * Only swings with at least `min_forward_bars` of data after them are used, so
 * a level near the right edge cannot be scored as "held" merely because the
 * series ended.
 */
export function levelTestStudy(bars, {
  lookback = 5,
  tolerance_pct = 0.5,
  gap = 3,
  break_margin_pct = 0.3,
  resolve_bars = 5,
  min_forward_bars = 40,
  max_tests = 12,
} = {}) {
  if (!Array.isArray(bars) || bars.length < min_forward_bars + lookback * 2 + 5) {
    return { available: false, note: `Need more than ${min_forward_bars + lookback * 2 + 5} bars; got ${bars?.length || 0}.` };
  }

  // Local swing detection so this module has no import cycle with structure.js.
  const swings = [];
  for (let i = lookback; i < bars.length - lookback - min_forward_bars; i += 1) {
    let isHigh = true; let isLow = true;
    for (let j = i - lookback; j < i; j += 1) {
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    for (let j = i + 1; j <= i + lookback; j += 1) {
      if (bars[j].high > bars[i].high) isHigh = false;
      if (bars[j].low < bars[i].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: bars[i].high, kind: 'resistance' });
    if (isLow) swings.push({ index: i, price: bars[i].low, kind: 'support' });
  }

  const opts = { tolerance_pct, gap, break_margin_pct, resolve_bars, max_tests };
  const tracked = swings.map((s) => trackLevel(bars, { from_index: s.index, price: s.price, kind: s.kind, ...opts }));
  const withTests = tracked.filter((t) => t.test_count > 0);

  /**
   * P(break at test n | the level reached test n). The conditioning is what
   * makes it a hazard rate rather than a cumulative count — a level that broke
   * on test 2 was never exposed to test 3, so it must not appear in test 3's
   * denominator.
   */
  const byTest = [];
  for (let n = 1; n <= max_tests; n += 1) {
    const reached = withTests.filter((t) => t.test_count >= n);
    if (reached.length < 5) break;      // too few to report a rate
    const broke = reached.filter((t) => t.tests[n - 1].broke).length;
    byTest.push({
      test_number: n,
      levels_reaching: reached.length,
      broke_here: broke,
      break_rate_pct: round((broke / reached.length) * 100, 1),
    });
  }

  // The two clauses as conditionals on the eventual outcome.
  const clause = (key) => {
    const withClause = withTests.filter((t) => t[key] === true);
    const without = withTests.filter((t) => t[key] === false);
    const rate = (set) => (set.length ? round((set.filter((t) => t.broke).length / set.length) * 100, 1) : null);
    return {
      with_clause: { n: withClause.length, break_rate_pct: rate(withClause) },
      without_clause: { n: without.length, break_rate_pct: rate(without) },
      lift_points: withClause.length && without.length
        ? round(rate(withClause) - rate(without), 1)
        : null,
    };
  };

  return {
    available: true,
    levels_tracked: tracked.length,
    levels_with_at_least_one_test: withTests.length,
    overall_break_rate_pct: withTests.length
      ? round((withTests.filter((t) => t.broke).length / withTests.length) * 100, 1)
      : null,
    hazard_by_test_number: byTest,
    /**
     * The trend in the hazard rate is the claim. Rising means each successive
     * test is MORE likely to break the level — Shannon's inversion. Flat means
     * touch count carries no information about the next test.
     */
    hazard_trend: byTest.length >= 3
      ? (() => {
          const first = byTest[0].break_rate_pct;
          const last = byTest[byTest.length - 1].break_rate_pct;
          return {
            from_test_1_pct: first,
            to_test_n_pct: last,
            tests_spanned: byTest.length,
            change_points: round(last - first, 1),
            direction: last > first + 3 ? 'rising' : last < first - 3 ? 'falling' : 'flat',
          };
        })()
      : null,
    aggression_through_price: clause('aggression_through_price'),
    aggression_through_time: clause('aggression_through_time'),
    what_would_settle_it:
      'More touches means more exposure, so P(break | n tests) rises with n on a random walk too. Only the SHAPE '
      + 'against a matched random-walk arm distinguishes absorption from arithmetic. Run scripts/level-test-inversion.js.',
    source: 'Shannon, Technical Analysis Using Multiple Timeframes (2008), ch. 7, Figures 7.4 and 7.5.',
  };
}

/**
 * The measured verdict on Shannon's touch-count inversion.
 * `node scripts/level-test-inversion.js` re-measures.
 */
export const TOUCH_COUNT_FINDING = Object.freeze({
  status: 'MEASURED, WITH AN OUT-OF-SAMPLE ARM THAT KILLED THE HEADLINE',

  /**
   * Read this first. An earlier version of this constant reported the pressure
   * clause as a surviving finding worth +19.5 points at z = 3.36. That was
   * wrong in two ways at once, and both were found by going back and testing it
   * properly rather than by anything failing:
   *
   *   1. It was measured on 60-MINUTE bars and recorded as "daily". The
   *      measurement script set the symbol but never the timeframe, so it
   *      inherited whatever the chart was on. `scripts/_real_bars.js` now
   *      requires an explicit timeframe and echoes back what it actually got.
   *
   *   2. It was IN-SAMPLE ONLY. Given a fresh universe it collapses from +39.1
   *      to +4.6 — on a LARGER sample (251 levels against 103), so this is a
   *      well-powered failure, not a quiet one.
   *
   * The lesson is the one this repo keeps relearning: a single-sample result
   * with a good z-score is a description of that sample. The trial count and
   * the noise floor were both attached, and neither was enough — only a
   * holdout caught it.
   */
  correction_history: 'A prior version claimed the pressure clause survived (+19.5 points, z = 3.36, n = 272). '
    + 'Both the timeframe label and the conclusion were wrong. Retained here because a repo that silently rewrites '
    + 'its own failed claims cannot be audited.',

  timeframes_measured: ['1D', '60'],
  arms: '1) random walk. 2) IN-SAMPLE: 20 large/mid caps, newest half of the window. 3) OOS-UNIVERSE: 20 different '
    + 'symbols — ETFs, biotech, high-beta, consumer. 4) OOS-PERIOD: the same 20 large caps, older non-overlapping half.',

  /** THE COUNT CLAIM: dead in every arm, on both timeframes. */
  count_claim: {
    claim: 'Shannon ch. 7, figs 7.4/7.5: "The more times a level of support or resistance is tested, the more likely '
      + 'it is for the stock to VIOLATE that level."',
    hazard_trend_points: {
      random_walk: 40.3,
      hourly: { in_sample: 21.2, oos_universe: 4.5, oos_period: 19.3 },
      daily: { oos_universe: 18.8, note: 'The other daily arms had too few multi-test levels to produce a trend.' },
    },
    verdict: 'DEAD IN EVERY ARM. The hazard rate does rise with test number, but by 4.5-21.2 points where a random '
      + 'walk rises 40.3. More tests means more exposure; that is arithmetic, and real data shows LESS of it than '
      + 'noise. The absorption mechanism Shannon describes is not visible anywhere.',
    consequence: 'Touch count carries no information about the NEXT test in EITHER direction. That is not licence to '
      + 'invert findKeyLevels — a null result is a null result both ways. Scoring touch count as strength is '
      + 'unsupported, not backwards.',
  },

  /** THE PRESSURE CLAUSE: strong in-sample, gone out of sample. */
  aggression_through_price: {
    clause: 'The interim retreat extremes moving TOWARD the level between tests — rising pullback lows under '
      + 'resistance, falling rally highs above support — as buyers or sellers "becoming more aggressive through price".',
    hourly: {
      in_sample: { lift_points: 39.1, z: 3.96, n: 103 },
      oos_universe: { lift_points: 4.6, z: 0.73, n: 251 },
      oos_period: { lift_points: 3.4, z: 0.31, n: 90 },
    },
    daily: {
      in_sample: { lift_points: 7.1, z: 0.54, n: 29 },
      oos_universe: { lift_points: 2.4, z: 0.31, n: 85 },
      oos_period: { lift_points: 3.7, z: 0.22, n: 33 },
      note: '400 daily bars simply do not produce many levels with three or more tests, so the daily arms are '
        + 'UNDERPOWERED rather than negative. They cannot refute anything on their own.',
    },
    random_walk: { lift_points: -1.4, z: -0.94, n: 2481 },
    verdict: 'DOES NOT SURVIVE. Holds in 1 of 3 real arms — the one it was found in. The out-of-sample universe has '
      + 'MORE levels (251 vs 103) and shows +4.6 at z = 0.73, which is indistinguishable from the -1.4 the null carries. '
      + 'Do not size on this, and do not quote the in-sample number without the holdout beside it.',
    what_it_is_still_good_for: 'Watching where price retreats to between tests is a reasonable way to DESCRIBE '
      + 'whether attempts are getting stronger or weaker. level_pressure remains useful as a description. What died '
      + 'is the claim that it predicts the break.',
  },

  aggression_through_time: {
    clause: 'Tests coming CLOSER TOGETHER as aggression "time-wise".',
    hourly: {
      in_sample: { lift_points: 4.6, z: 0.45 },
      oos_universe: { lift_points: -16.2, z: -2.57 },
      oos_period: { lift_points: 17.2, z: 1.62 },
    },
    random_walk: { lift_points: 0.2, z: 0.13 },
    verdict: 'NOISE. It swings from -16.2 (z = -2.57, nominally SIGNIFICANT in the wrong direction) to +17.2 across '
      + 'arms. A useful illustration: run enough arms and something clears p < 0.05 in both directions by chance. '
      + 'This is what an unstable estimate looks like, and a single arm would have hidden it.',
  },

  summary: 'The count claim is arithmetic and dies against its null. His pressure clause looked like the '
    + 'strongest result in this repo on one sample and did not replicate on a larger one. Both the noise floor AND '
    + 'the trial count were attached to the original, and neither caught it — only the holdout did. Treat every '
    + 'single-sample finding here as provisional until it has one.',
  script: 'scripts/level-test-inversion.js  (use --timeframe to pin the resolution)',
});
