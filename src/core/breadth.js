/**
 * What a cross-sectional edge is worth when you apply it to ONE stock.
 *
 * ── The problem this makes arithmetic ──
 *
 * Every effect in this repo with respectable evidence behind it was measured
 * ACROSS MANY INSTRUMENTS, not on one chart:
 *
 *   - Moskowitz/Ooi/Pedersen momentum: 58 futures, Sharpe 1.28
 *   - George & Hwang 52-week high: top 30% vs bottom 30% of all CRSP stocks
 *   - Post-earnings drift: decile portfolios of hundreds of firms
 *   - Lo/Mamaysky/Wang patterns: conditional distributions over 350 stocks
 *
 * The toolchain has been saying "the signal transfers, the Sharpe does not" in
 * prose. Grinold's Fundamental Law of Active Management says it in numbers:
 *
 *     IR = IC * sqrt(BR)
 *
 * Information ratio equals the information coefficient (the correlation
 * between your forecast and the outcome — your actual skill) times the square
 * root of breadth (the number of INDEPENDENT bets you make).
 *
 * Rearranged, that is the number nobody wants to see: an edge that produces an
 * information ratio of 1.0 across 500 independent positions carries an IC of
 * 1.0/sqrt(500) = 0.045. Applied to a single position, the expected IR is
 * 0.045 * sqrt(1) = 0.045. **The same edge, one twenty-second of the result.**
 *
 * That is not pessimism, it is division. A cross-sectional study reports what
 * a diversified book earns; a single chart gets one draw from a distribution
 * whose mean is tiny relative to its spread.
 *
 * ── What this module does NOT claim ──
 *
 * It does not say single-name trading is futile. It says the published Sharpe
 * of a cross-sectional anomaly is not the Sharpe of one trade based on it, and
 * it computes how large the gap is so the claim can be argued with.
 *
 * All pure.
 *
 * Source: Grinold (1989), "The Fundamental Law of Active Management";
 * Grinold & Kahn, "Active Portfolio Management".
 */

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Back out the implied skill (IC) from a published information ratio and the
 * breadth the study actually had.
 *
 * `breadth` is the number of INDEPENDENT bets per period, not the number of
 * observations. 500 stocks rebalanced monthly for 20 years is not breadth
 * 120,000 — the stocks are correlated and the periods overlap. When unsure,
 * use the cross-sectional count and treat the answer as an upper bound on
 * skill, which makes it a lower bound on how much the edge shrinks.
 */
export function impliedIC(information_ratio, breadth) {
  if (!(breadth >= 1)) throw new Error('breadth must be at least 1.');
  return information_ratio / Math.sqrt(breadth);
}

/** Forward direction: what IR does this skill produce at this breadth? */
export function informationRatio(ic, breadth) {
  if (!(breadth >= 1)) throw new Error('breadth must be at least 1.');
  return ic * Math.sqrt(breadth);
}

/**
 * Translate a published cross-sectional result into what to expect from
 * applying it to a small number of positions.
 *
 * This is the calculation to run before quoting any anomaly's Sharpe ratio at
 * a single chart.
 */
export function translateEdge({
  published_ir = null,
  published_sharpe = null,
  study_breadth,
  your_positions = 1,
  periods_per_year = 12,
} = {}) {
  const ir = published_ir ?? published_sharpe;
  if (ir == null) throw new Error('Supply published_ir or published_sharpe.');
  if (!(study_breadth >= 1)) throw new Error('study_breadth must be at least 1 — how many independent bets did the study make?');
  if (!(your_positions >= 1)) throw new Error('your_positions must be at least 1.');

  const ic = impliedIC(ir, study_breadth);
  const yourIR = informationRatio(ic, your_positions);
  const shrink = ir === 0 ? null : yourIR / ir;

  // How many years before that IR is distinguishable from zero at 95%?
  // t = IR * sqrt(years); t = 1.96 => years = (1.96/IR)^2
  const years = yourIR > 0 ? (1.96 / yourIR) ** 2 : null;

  return {
    published_ir: round(ir),
    study_breadth,
    implied_information_coefficient: round(ic),
    your_positions,
    your_expected_ir: round(yourIR),
    shrinkage_factor: round(shrink),
    shrinkage_note: shrink == null ? null
      : `Applying this edge to ${your_positions} position(s) instead of ${study_breadth} retains `
        + `${round(shrink * 100, 1)}% of the published information ratio.`,
    years_to_significance: years == null ? null : Math.ceil(years),
    years_note: years == null ? 'No positive expected IR to establish.'
      : `At ${round(yourIR)} IR you would need about ${Math.ceil(years)} years of results before the edge is `
        + 'distinguishable from luck at 95% confidence.',
    interpretation: shrink == null ? 'Cannot compare against a zero IR.'
      : shrink > 0.5 ? 'Your breadth is close enough to the study\'s that the published figure is roughly applicable.'
      : `The published figure is NOT applicable at this breadth. It describes a diversified book of ${study_breadth} `
        + 'independent bets; you are making ' + your_positions + '.',
    the_law: 'IR = IC * sqrt(BR). Grinold (1989). The information coefficient is skill; breadth is how many independent '
      + 'times you get to apply it. Halving breadth costs you 29% of the information ratio, and going from 500 bets to '
      + '1 costs you 96%.',
    caveat: 'Breadth counts INDEPENDENT bets. Correlated positions, overlapping holding periods and a single sector all '
      + 'reduce effective breadth below the position count — usually far below. Treat your_positions as an optimistic '
      + 'input, which makes this an optimistic answer.',
  };
}

/** Published results, with the breadth each one actually had. */
export const PUBLISHED_EDGES = {
  time_series_momentum: {
    source: 'Moskowitz, Ooi & Pedersen (2012), Journal of Financial Economics',
    sharpe: 1.28,
    breadth: 58,
    breadth_basis: '58 futures and forward contracts, diversified across equity indices, currencies, commodities and bonds',
    benchmark_sharpe: 0.38,
  },
  fifty_two_week_high: {
    source: 'George & Hwang (2004), Journal of Finance',
    monthly_return_pct: 0.45,
    monthly_return_ex_january_pct: 1.23,
    breadth: 'top and bottom 30% of all CRSP stocks, typically 1000+ names',
    breadth_numeric: 1000,
    note: 'Returns roughly TWICE those of Jegadeesh-Titman momentum after controlling for size and bid-ask bounce, '
      + 'and unlike JT momentum they do NOT reverse in the long run.',
  },
  post_earnings_drift: {
    source: 'Bernard & Thomas (1989) onward; see the firm-level critique below',
    magnitude: 'Originally ~18% annualized abnormal return; substantially decayed since',
    breadth: 'decile portfolios of hundreds of firms',
    breadth_numeric: 100,
    firm_level_warning: 'Katz, McCubbins & McMullin (2018) disaggregated PEAD to the firm level and found the monotonic '
      + 'drift pattern does NOT persist. Good-news decile: mean +3.3% but SD 3.8%, and 16.1% of quarters drifted '
      + 'NEGATIVE. Bad-news decile: mean -1.9%, SD 4.5%, and 28.0% of quarters drifted POSITIVE. PEAD is an aggregate '
      + 'phenomenon; a single stock after a positive surprise is a draw from a wide distribution, not a prediction.',
  },
};

/**
 * The honest translation of a named published edge to a single position.
 *
 * Convenience wrapper so the caveat is one call away rather than a paragraph
 * someone has to remember to write.
 */
export function singleNameExpectation(edge_key, { your_positions = 1 } = {}) {
  const e = PUBLISHED_EDGES[edge_key];
  if (!e) {
    throw new Error(`Unknown edge "${edge_key}". Known: ${Object.keys(PUBLISHED_EDGES).join(', ')}.`);
  }
  const breadth = e.breadth_numeric ?? e.breadth;
  if (typeof breadth !== 'number') {
    return { edge: edge_key, ...e, note: 'This edge has no numeric breadth recorded; translate it manually with translateEdge.' };
  }
  const ir = e.sharpe ?? null;
  if (ir == null) {
    return {
      edge: edge_key, ...e,
      note: 'No published information ratio recorded for this edge, so the shrinkage cannot be computed. The breadth '
        + `warning still applies: this was measured across roughly ${breadth} names.`,
    };
  }
  return { edge: edge_key, source: e.source, ...translateEdge({ published_ir: ir, study_breadth: breadth, your_positions }) };
}
