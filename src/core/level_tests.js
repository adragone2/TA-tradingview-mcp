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
  status: 'MEASURED',
  sample: '20 symbols x ~400 daily bars against 200 random walks x 400 bars. 554 real levels reaching test 1.',

  /**
   * THE COUNT CLAIM IS DEAD, and it dies the same way Crabel's did: real data
   * shows LESS of the effect than noise.
   */
  count_claim: {
    claim: 'Shannon ch. 7, figs 7.4/7.5: "The more times a level of support or resistance is tested, the more likely '
      + 'it is for the stock to VIOLATE that level."',
    hazard_by_test: {
      real_data: { 1: 8.1, 2: 24.4, 3: 30.2, 4: 34.1, 5: 22.6 },
      random_walk: { 1: 1.6, 2: 52.6, 3: 53.1, 4: 48.5, 5: 41.9 },
    },
    trend_points_test_1_to_5: { real_data: 14.5, random_walk: 40.3, excess: -25.8 },
    overall_break_rate_pct: { real_data: 58.8, random_walk: 72.1 },
    verdict: 'NO EDGE. The hazard rate does rise with test number on real data (+14.5 points), but it rises FAR more '
      + 'on a random walk (+40.3) — because more tests means more exposure, which is arithmetic. Shannon\'s absorption '
      + 'mechanism is not visible.',
    consequence: 'This does NOT mean findKeyLevels has the sign backwards. It means touch count carries no '
      + 'information about the NEXT test in EITHER direction, so scoring it as strength is unsupported rather than '
      + 'inverted. Do not invert it on this evidence, and do not defend it either.',
  },

  /**
   * ONE CLAUSE SURVIVES, and cleanly. This is the interesting half: Shannon's
   * *mechanism* clause carries information where his *count* claim does not.
   */
  aggression_through_price: {
    clause: 'The interim pullback lows RISING between tests of resistance (his figure: 10.50 -> 9.25 -> 9.50) is '
      + 'buyers "becoming more aggressive through price". Mirrored for support: falling interim rally highs.',
    real_data: { with_clause_break_pct: 73.8, n_with: 145, without_clause_break_pct: 54.3, n_without: 127, lift_points: 19.5 },
    random_walk: { with_clause_break_pct: 83.1, n_with: 1372, without_clause_break_pct: 84.5, n_without: 1109, lift_points: -1.4 },
    /**
     * Two-proportion z on the real-data arm: pooled p = 176/272 = 0.647,
     * SE = 0.0581, z = 3.36, two-tailed p ~ 0.0008. Three clauses were tested
     * (count, price, time), so Bonferroni-corrected the threshold is 0.0167 and
     * this clears it. Still ONE study on ONE universe — it is a finding, not a
     * settled effect.
     */
    z_score: 3.36,
    p_two_tailed: 0.0008,
    tests_in_family: 3,
    bonferroni_threshold: 0.0167,
    verdict: 'SURVIVES. The clause is worth +19.5 points of break rate on real data and NOTHING on noise (-1.4), '
      + 'which is the separation a real mechanism produces. z = 3.36 over 272 levels, clearing a 3-test Bonferroni '
      + 'correction. Read the level\'s PRESSURE, not its touch count. One universe, one measurement — it is a finding, '
      + 'not a settled effect, and it has no out-of-sample arm.',
  },

  aggression_through_time: {
    clause: 'Tests coming CLOSER TOGETHER is aggression "time-wise".',
    real_data: { with_clause_break_pct: 68.6, n_with: 102, without_clause_break_pct: 62.4, n_without: 170, lift_points: 6.2 },
    random_walk: { with_clause_break_pct: 83.8, n_with: 1045, without_clause_break_pct: 83.6, n_without: 1436, lift_points: 0.2 },
    verdict: 'WEAK. Points the right way (+6.2 real against +0.2 on noise) but the gap is small and the sample is '
      + '272 levels. Report it; do not act on it alone.',
  },

  summary: 'Shannon got the mechanism right and the metric wrong. Counting tests measures exposure; measuring where '
    + 'price RETREATED TO between tests measures pressure. The first is arithmetic, the second carried 19.5 points '
    + 'of break rate over a null that carried none.',
  script: 'scripts/level-test-inversion.js',
});
