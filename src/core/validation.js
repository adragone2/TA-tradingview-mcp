/**
 * Statistical validation: what a backtest result is worth once you account for
 * how hard you looked for it.
 *
 * This module exists because of a single result in the literature. White's
 * Reality Check applied to technical trading rules found the best rule earned
 * roughly 32% per annum and was STATISTICALLY INSIGNIFICANT once the size of
 * the search was accounted for. Harvey, Liu & Zhu make the same argument for
 * factors: given how much searching the field has done, a t-statistic of 2.0
 * is not evidence; 3.0 is the modern bar.
 *
 * `strategy_scan` in this repo does exactly the procedure those tests were
 * written to invalidate — try many rules over many symbols, report the winner
 * — and until now applied no correction and did not even count the trials.
 *
 * The core idea: a Sharpe ratio is a random variable. Run N independent
 * strategies on pure noise and the best of them will have a respectable Sharpe
 * purely by chance. The expected maximum grows with N. So the question is
 * never "is this Sharpe good?" but "is this Sharpe better than the best I
 * should have expected from N tries at nothing?"
 *
 * All pure. No chart access.
 *
 * Sources:
 *   Bailey & Lopez de Prado (2014), "The Deflated Sharpe Ratio"
 *   Lopez de Prado (2018), "Advances in Financial Machine Learning", ch. 7
 */

const EULER_MASCHERONI = 0.5772156649015329;

/** Standard normal CDF, Abramowitz & Stegun 7.1.26 via erf. */
export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26, Horner form. Max error ~1.5e-7. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

/**
 * Inverse standard normal CDF (probit), Acklam's rational approximation.
 * Accurate to ~1.15e-9, which is far tighter than anything downstream needs.
 */
export function normalInv(p) {
  if (!(p > 0 && p < 1)) throw new Error(`normalInv needs 0 < p < 1, got ${p}.`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Mean, sample SD, skewness and NON-excess kurtosis of a return series. */
export function moments(returns) {
  const n = returns.length;
  if (n < 2) throw new Error('Need at least 2 returns to compute moments.');
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const dev = returns.map((r) => r - mean);
  const m2 = dev.reduce((a, d) => a + d * d, 0) / n;
  const m3 = dev.reduce((a, d) => a + d * d * d, 0) / n;
  const m4 = dev.reduce((a, d) => a + d * d * d * d, 0) / n;
  const sd = Math.sqrt(m2);
  return {
    n,
    mean,
    sd: Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / (n - 1)),  // sample SD
    population_sd: sd,
    skewness: sd > 0 ? m3 / Math.pow(sd, 3) : 0,
    kurtosis: sd > 0 ? m4 / Math.pow(sd, 4) : 3,                  // non-excess: 3 is normal
  };
}

/** Sharpe ratio per observation. Annualize by multiplying by sqrt(periods/year). */
export function sharpeRatio(returns, { risk_free = 0 } = {}) {
  const m = moments(returns);
  if (m.sd === 0) return 0;
  return (m.mean - risk_free) / m.sd;
}

/**
 * Probabilistic Sharpe Ratio — the probability that the true Sharpe exceeds a
 * threshold, given the observed Sharpe, sample length, skew and kurtosis.
 *
 * Negative skew and fat tails both REDUCE it, which is the point: a strategy
 * that grinds out small gains and occasionally blows up has a flattering
 * Sharpe and a poor PSR.
 */
export function probabilisticSharpe(returns, { benchmark_sharpe = 0 } = {}) {
  const m = moments(returns);
  const sr = m.sd === 0 ? 0 : m.mean / m.sd;
  const denom = Math.sqrt(1 - m.skewness * sr + ((m.kurtosis - 1) / 4) * sr * sr);
  if (!Number.isFinite(denom) || denom <= 0) {
    return { psr: null, sharpe: sr, note: 'PSR undefined for this return distribution (variance term non-positive).' };
  }
  const z = ((sr - benchmark_sharpe) * Math.sqrt(m.n - 1)) / denom;
  return {
    psr: normalCdf(z),
    sharpe: sr,
    benchmark_sharpe,
    n: m.n,
    skewness: m.skewness,
    kurtosis: m.kurtosis,
  };
}

/**
 * The Sharpe you should EXPECT from the best of N independent trials on
 * strategies with no real edge.
 *
 * This is the number that makes the whole module worth having. With 100 trials
 * and a trial-Sharpe standard deviation of 0.5, the best of them averages
 * around 1.3 — from nothing at all.
 */
export function expectedMaxSharpe(trials, sharpe_variance) {
  if (!(trials >= 1)) throw new Error('trials must be at least 1.');
  if (trials === 1) return 0;
  const sd = Math.sqrt(sharpe_variance);
  const a = normalInv(1 - 1 / trials);
  const b = normalInv(1 - 1 / (trials * Math.E));
  return sd * ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b);
}

/**
 * Deflated Sharpe Ratio: the PSR measured against the expected maximum from
 * the search, rather than against zero.
 *
 * Pass either `trial_sharpes` (every Sharpe you tried — strongly preferred,
 * because their spread IS the variance term) or `trials` plus an explicit
 * `sharpe_variance`.
 *
 * Read the result as: the probability this strategy's true Sharpe is positive
 * ONCE the search is accounted for. Below 0.95 is not a discovery.
 */
export function deflatedSharpe(returns, { trials = null, trial_sharpes = null, sharpe_variance = null } = {}) {
  let n_trials = trials;
  let variance = sharpe_variance;

  if (Array.isArray(trial_sharpes) && trial_sharpes.length > 1) {
    n_trials = trial_sharpes.length;
    const mean = trial_sharpes.reduce((a, b) => a + b, 0) / n_trials;
    variance = trial_sharpes.reduce((a, s) => a + (s - mean) ** 2, 0) / (n_trials - 1);
  }
  if (!n_trials) throw new Error('deflatedSharpe needs either trial_sharpes or trials.');
  if (variance == null) {
    throw new Error('deflatedSharpe needs sharpe_variance when trial_sharpes is not supplied. '
      + 'The spread of the Sharpes you tried is what makes the correction meaningful — guessing it defeats the purpose.');
  }

  const sr0 = expectedMaxSharpe(n_trials, variance);
  const out = probabilisticSharpe(returns, { benchmark_sharpe: sr0 });
  const dsr = out.psr;

  return {
    ...out,
    deflated_sharpe: dsr,
    trials: n_trials,
    expected_max_sharpe_from_search: sr0,
    sharpe_variance: variance,
    verdict: dsr == null ? 'undefined'
      : dsr >= 0.95 ? 'survives the search correction'
      : dsr >= 0.90 ? 'marginal — would not survive a stricter bar'
      : 'does NOT survive: this Sharpe is within what the search alone would produce',
    how_to_read: `Out of ${n_trials} trials, the best result on strategies with NO edge would be expected to reach a Sharpe of `
      + `${Math.round(sr0 * 1000) / 1000}. This strategy scored ${Math.round(out.sharpe * 1000) / 1000}. `
      + 'The deflated Sharpe is the probability its true Sharpe is above zero once that is accounted for.',
    caveat: 'This corrects for the trials you COUNTED. Every rule you tried and discarded before writing the scan '
      + 'counts too, and no tool can see those. The number is an upper bound on your confidence, not a certificate.',
  };
}

/**
 * Minimum track record length: how many observations you need before a Sharpe
 * this size is distinguishable from the benchmark at the given confidence.
 */
export function minTrackRecordLength(returns, { benchmark_sharpe = 0, confidence = 0.95 } = {}) {
  const m = moments(returns);
  const sr = m.sd === 0 ? 0 : m.mean / m.sd;
  if (sr <= benchmark_sharpe) {
    return { required_observations: null, have: m.n, note: 'Sharpe does not exceed the benchmark; no track record length would establish it.' };
  }
  const z = normalInv(confidence);
  const required = 1 + (1 - m.skewness * sr + ((m.kurtosis - 1) / 4) * sr * sr) * ((z / (sr - benchmark_sharpe)) ** 2);
  return {
    required_observations: Math.ceil(required),
    have: m.n,
    sufficient: m.n >= required,
    confidence,
    note: m.n >= required
      ? 'The sample is long enough to distinguish this Sharpe from the benchmark.'
      : `Need ${Math.ceil(required) - m.n} more observations before this Sharpe means anything at ${confidence * 100}% confidence.`,
  };
}

// ── Cross-validation that does not leak ──────────────────────────────────────

/**
 * Purged K-fold splits.
 *
 * Standard k-fold assumes observations are independent. Financial labels are
 * built over overlapping windows — a label at t depends on prices through
 * t+horizon — so a training row adjacent to the test fold contains the test
 * fold's answer. Purging drops training rows whose label window overlaps the
 * test fold; the embargo drops a further stretch immediately after it, because
 * serial correlation leaks in that direction too.
 *
 * `label_spans[i] = [start_index, end_index]` — the bars each observation's
 * label depends on. For a fixed h-bar horizon that is simply [i, i+h].
 */
export function purgedKFold(n, { k = 5, label_spans = null, embargo_pct = 0.01 } = {}) {
  if (!(n > 0)) throw new Error('n must be positive.');
  if (!(k >= 2 && k <= n)) throw new Error(`k must be between 2 and n (${n}), got ${k}.`);
  const spans = label_spans || Array.from({ length: n }, (_, i) => [i, i]);
  if (spans.length !== n) throw new Error(`label_spans has ${spans.length} entries for ${n} observations.`);

  const embargo = Math.floor(n * embargo_pct);
  const foldSize = Math.floor(n / k);
  const folds = [];

  for (let f = 0; f < k; f++) {
    const testStart = f * foldSize;
    const testEnd = f === k - 1 ? n - 1 : (f + 1) * foldSize - 1;
    const test = [];
    for (let i = testStart; i <= testEnd; i++) test.push(i);

    // A training row survives only if its label window touches neither the
    // test fold nor the embargo that follows it.
    const embargoEnd = Math.min(n - 1, testEnd + embargo);
    const train = [];
    for (let i = 0; i < n; i++) {
      if (i >= testStart && i <= testEnd) continue;
      const [s, e] = spans[i];
      const overlapsTest = s <= testEnd && e >= testStart;
      const inEmbargo = i > testEnd && i <= embargoEnd;
      if (!overlapsTest && !inEmbargo) train.push(i);
    }
    folds.push({
      fold: f,
      train,
      test,
      purged: n - train.length - test.length,
      embargo_bars: embargo,
    });
  }

  return {
    folds,
    k,
    n,
    embargo_pct,
    total_purged: folds.reduce((a, f) => a + f.purged, 0),
    note: 'Purged rows are dropped, not reassigned. A large purge count means your label horizon is long relative to the sample — '
      + 'that is a real constraint on what can be learned, not a bug.',
  };
}

/**
 * Combinatorial purged cross-validation: hold out `groups_test` of `k` groups
 * at a time, producing many backtest PATHS instead of one.
 *
 * The point is that a single train/test split gives one estimate with no error
 * bar. CPCV gives a distribution, and the spread across paths is itself the
 * finding — a strategy whose result swings wildly across paths has not been
 * validated by the path that happened to look good.
 */
export function combinatorialPurgedCV(n, { k = 6, groups_test = 2, label_spans = null, embargo_pct = 0.01 } = {}) {
  if (!(groups_test >= 1 && groups_test < k)) throw new Error(`groups_test must be between 1 and k-1, got ${groups_test}.`);
  const spans = label_spans || Array.from({ length: n }, (_, i) => [i, i]);
  const groupSize = Math.floor(n / k);
  const bounds = [];
  for (let g = 0; g < k; g++) {
    bounds.push([g * groupSize, g === k - 1 ? n - 1 : (g + 1) * groupSize - 1]);
  }

  const combos = [];
  const choose = (start, picked) => {
    if (picked.length === groups_test) { combos.push([...picked]); return; }
    for (let g = start; g < k; g++) { picked.push(g); choose(g + 1, picked); picked.pop(); }
  };
  choose(0, []);

  const embargo = Math.floor(n * embargo_pct);
  const splits = combos.map((testGroups) => {
    const test = [];
    for (const g of testGroups) {
      for (let i = bounds[g][0]; i <= bounds[g][1]; i++) test.push(i);
    }
    const testSet = new Set(test);
    const train = [];
    for (let i = 0; i < n; i++) {
      if (testSet.has(i)) continue;
      const [s, e] = spans[i];
      let bad = false;
      for (const g of testGroups) {
        const [ts, te] = bounds[g];
        if (s <= te && e >= ts) { bad = true; break; }
        if (i > te && i <= Math.min(n - 1, te + embargo)) { bad = true; break; }
      }
      if (!bad) train.push(i);
    }
    return { test_groups: testGroups, train, test, purged: n - train.length - test.length };
  });

  // Each group appears in combos of size groups_test; the number of distinct
  // backtest paths that can be assembled is that count divided by the groups
  // consumed per path.
  const paths = (combos.length * groups_test) / k;

  return {
    splits,
    k,
    groups_test,
    n,
    combinations: combos.length,
    backtest_paths: paths,
    note: `${combos.length} train/test combinations yield ${paths} distinct backtest paths. `
      + 'Report the DISTRIBUTION across paths, not the best one — picking the best path is the same mistake as picking the best rule.',
  };
}
