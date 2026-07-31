/**
 * Bull-flag template matching, with PIP downsampling.
 *
 * RESEARCH GRADE. Deliberately NOT registered as an MCP tool — see
 * src/core/ignition.js for the precedent. A detector reaches the tool surface
 * once its evidence has survived review.
 *
 * This is a SECOND OPINION in the sense src/core/lmw_patterns.js means it: a
 * different lineage (a machine-learned image template out of the expert-systems
 * literature) reading the same bars as our own geometric flag detector, so that
 * agreement means something and disagreement is visible. It returns evidence
 * and scores. It never returns a trade signal.
 *
 * ── The method, and who it came from ──
 *
 * Leigh, Modani, Purvis & Roberts, "Stock market trading rule discovery using
 * technical charting heuristics", Expert Systems with Applications 23(2), 2002,
 * pp. 155-159, encode a chart pattern as a 10x10 grid of WEIGHTS and score a
 * price window by summing the weights of the cells the price passes through.
 *   https://www.sciencedirect.com/science/article/abs/pii/S0957417402000349
 *
 * That original is paywalled and was NOT read. Everything implemented here is
 * from two reachable secondary sources that reproduce the templates and the
 * arithmetic in full:
 *
 *   Fernandes, A. B. G. (2022), MSc dissertation, Universidade do Porto,
 *   "Stock market trading rule discovery using technical analysis and a
 *   template matching technique for pattern recognition". Figures 2 and 3 carry
 *   both weight matrices cell by cell; pp. 16-19 carry the fit formula.
 *   https://repositorio-aberto.up.pt/bitstream/10216/146608/2/597048.pdf
 *
 *   Cervello-Royo, R., Guijarro, F. & Michniuk, K. (2015), "Stock market
 *   trading rule based on pattern recognition and technical analysis:
 *   Forecasting the DJIA index with intraday data", Expert Systems with
 *   Applications 42(14), pp. 5963-5975, which restates the fitting procedure
 *   and is explicit that the threshold is set a priori by the researcher.
 *   https://doi.org/10.1016/j.eswa.2015.03.017
 *   https://riunet.upv.es/server/api/core/bitstreams/b49c5d1f-00ab-472c-b870-4c0b8cdcb81d/content
 *
 * ── What PIP adds, and what it changes ──
 *
 * Perceptually Important Points come from Chung, Fu, Luk & Ng (2001) and Fu,
 * Chung, Luk & Ng, "Stock time series pattern matching: Template-based vs.
 * rule-based approaches", Engineering Applications of Artificial Intelligence
 * 20(3), 2007, pp. 347-364. The idea: keep the first and last point, then
 * repeatedly add whichever remaining point is furthest from the line joining
 * its two bracketing kept points. The result is a fixed-length skeleton of the
 * salient turns, not a calendar sample.
 *
 * Those two are also paywalled and were NOT read. The algorithm above is from
 * secondary descriptions, which agree on the construction but not on the
 * distance measure — see PIP_DISTANCE_NOTE for why the choice matters and
 * which one is the default.
 *
 * Substituting PIP for the paper's own mapping is OUR change and it is not
 * cosmetic. The paper puts each trading day in its TIME decile; PIP puts each
 * SALIENT TURN in a column regardless of when it happened. So the two mappings
 * answer different questions — "did the shape occur on this schedule" versus
 * "is this the shape" — and `matchBullFlag` computes BOTH and reports them side
 * by side. Where they disagree, that is the finding.
 *
 * The consequence for the threshold is stated at PIP_THRESHOLD_PROVENANCE and
 * matters: a threshold measured under one mapping does not transfer to another.
 *
 * All pure.
 */

const round = (n, dp = 3) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The two published bull-flag templates, row 0 = HIGHEST prices, column 0 =
 * EARLIEST time. Transcribed cell by cell from Fernandes (2022) Figures 2 and 3.
 *
 * Neither is ours and neither may be "tuned": the weights came out of a neural
 * network in the original work (Leigh, Paz & Purvis 2002), so a hand edit
 * produces a template with no provenance at all.
 */
export const PIP_TEMPLATES = Object.freeze({
  /**
   * Wang & Chan (2007). Rows 10-7 rising through columns 0-4 (the pole),
   * a horizontal band at rows 3-5 across columns 5-8 (the flag), and the
   * breakout in column 9. This is the classic bull flag and it fits prices
   * alone, which is why it is the default here.
   *
   * Fernandes' caption gives the range as -1.65 to 1.00; the printed grid's
   * most negative cell is -1.6. The grid is transcribed as printed and the
   * discrepancy is recorded rather than silently reconciled.
   */
  wang_chan_2007: Object.freeze({
    name: 'wang_chan_2007',
    weights: Object.freeze([
      Object.freeze([-0.25, -0.4, -0.45, -0.7, -1.5, -1.6, -1.6, -1.6, -1.6, -0.7]),
      Object.freeze([-0.25, -0.4, -0.45, -0.6, -0.75, -1.4, -1.4, -1.4, -0.8, 1.0]),
      Object.freeze([-0.25, -0.4, -0.45, -0.55, -0.5, -0.75, -0.75, -0.5, -0.5, 0.4]),
      Object.freeze([-0.25, -0.4, -0.45, -0.55, -0.25, 0.9, 0.9, 0.9, -0.15, -0.35]),
      Object.freeze([-0.25, -0.5, -0.6, -0.25, 0.9, 1.0, 1.0, 1.0, 1.0, -0.55]),
      Object.freeze([-0.3, -0.6, -0.25, 0.8, 1.0, 0.9, 0.9, 0.9, 0.8, -0.45]),
      Object.freeze([-0.35, 0.1, 0.8, 1.0, 0.65, 0.6, 0.6, 0.4, 0.75, -0.15]),
      Object.freeze([0.1, 0.8, 1.0, 0.5, 0.3, 0.5, 0.5, 0.3, 0.0, 0.1]),
      Object.freeze([0.8, 1.0, 0.5, 0.35, 0.15, 0.0, 0.0, 0.0, 0.3, 0.35]),
      Object.freeze([1.0, 0.8, 0.35, 0.0, 0.0, 0.0, 0.0, 0.1, 0.25, 0.3]),
    ]),
    shape: 'upward trend in columns 1-5, horizontal consolidation in columns 6-9, ascending breakout in column 10',
    fitted_on: 'closing prices only',
    range_printed: [-1.6, 1.0],
    range_in_caption: [-1.65, 1.0],
    source: 'Fernandes (2022) Figure 2, reproducing Wang & Chan (2007). https://repositorio-aberto.up.pt/bitstream/10216/146608/2/597048.pdf',
  }),

  /**
   * Leigh, Purvis & Ragusa (2002). A DIFFERENT shape: a declining consolidation
   * across the first seven columns and a breakout in the last three. Included
   * because it is the template the named paper's family used, and because two
   * templates disagreeing on the same window is worth seeing.
   *
   * Note it was fitted on prices AND VOLUMES in the original. This module is
   * closes-only, so scoring a window against it uses half its inputs — stated
   * here rather than buried.
   */
  leigh_purvis_ragusa_2002: Object.freeze({
    name: 'leigh_purvis_ragusa_2002',
    weights: Object.freeze([
      Object.freeze([0.5, 0.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, 0.0]),
      Object.freeze([1.0, 0.5, 0.0, -0.5, -1.0, -1.0, -1.0, -1.0, -0.5, 0.0]),
      Object.freeze([1.0, 1.0, 0.5, 0.0, -0.5, -0.5, -0.5, -0.5, 0.0, 0.5]),
      Object.freeze([0.5, 1.0, 1.0, 0.5, 0.0, -0.5, -0.5, -0.5, 0.0, 1.0]),
      Object.freeze([0.0, 0.5, 1.0, 1.0, 0.5, 0.0, 0.0, 0.0, 0.5, 1.0]),
      Object.freeze([0.0, 0.0, 0.5, 1.0, 1.0, 0.5, 0.0, 0.0, 1.0, 1.0]),
      Object.freeze([-0.5, 0.0, 0.0, 0.5, 1.0, 1.0, -0.5, 0.5, 1.0, 1.0]),
      Object.freeze([-0.5, -1.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0, 1.0, 0.0]),
      Object.freeze([-1.0, -1.0, -1.0, -0.5, 0.0, 0.5, 1.0, 1.0, 0.0, -2.0]),
      Object.freeze([-1.0, -1.0, -1.0, -1.0, -1.0, 0.0, 0.5, 0.5, -2.0, -2.5]),
    ]),
    shape: 'declining consolidation across columns 1-7, breakout across columns 8-10',
    fitted_on: 'closing prices AND trading volumes in the original; this module scores closes only',
    range_printed: [-2.5, 1.0],
    range_in_caption: [-2.5, 1.0],
    source: 'Fernandes (2022) Figure 3, reproducing Leigh, Purvis & Ragusa (2002). https://repositorio-aberto.up.pt/bitstream/10216/146608/2/597048.pdf',
  }),
});

export const PIP_DEFAULTS = {
  /** Trading days in the fitting window. Wang & Chan sweep p in {20,...,120}. */
  window: 20,
  /** Grid size. Both published templates are 10x10. */
  grid: 10,
  template: 'wang_chan_2007',
  /** 'pip' (ours) or 'rank' (the paper's). Both are always computed. */
  mapping: 'pip',
  /** 'vertical' or 'perpendicular'. See PIP_DISTANCE_NOTE. */
  distance: 'vertical',
  /** How many PIPs the skeleton keeps. null means one per grid column. */
  pip_count: null,
  min_fit: 3.0,
};

export const PIP_DISTANCE_NOTE =
  'Vertical distance is the default because the perpendicular distance mixes units: the x axis is a bar index and '
  + 'the y axis is a price, so a perpendicular measured on raw axes changes with the price level and with the window '
  + 'length. Fu et al. define both; only the vertical one is scale-coherent without first normalising the axes. '
  + '`distance: "perpendicular"` is implemented and normalises both axes to [0,1] before measuring, which is the only '
  + 'way it means anything.';

export const PIP_THRESHOLD_PROVENANCE = Object.freeze({
  default_min_fit: 3.0,
  max_possible_fit: 10.0,
  where_it_comes_from:
    'Fernandes (2022) reports the headline result at a 20-day fitting window with T = 3 (Tables 6 and 9: "when p = 20 '
    + 'and T = 3"), using the Wang & Chan template and the RANK mapping. That is why `window` defaults to 20 and '
    + '`template` to wang_chan_2007 — a threshold and its window have to come from the same result or the threshold '
    + 'has no provenance.',
  the_catch:
    'It does NOT transfer to the PIP mapping. PIP selects salient turns rather than calendar deciles, so the same '
    + 'window produces a different fit and a threshold calibrated on one mapping is a guess on the other. '
    + 'PIP_NOISE_BASELINE therefore reports the floor at several thresholds under BOTH mappings, and the honest way '
    + 'to pick one is to read it off there.',
  who_says_it_is_arbitrary:
    'Cervello-Royo et al. (2015): "The fitting value threshold (minimum total fitting value) should be established by '
    + 'the researcher or the trader a priori. A very demanding threshold will reduce the number of identified flags... '
    + 'while a more permissive one might take as flag pattern some window prices, which hardly should be considered in '
    + 'other case."',
});

export const PIP_REPLICATION = Object.freeze({
  original: 'Leigh, Modani, Purvis & Roberts (2002) found the bull flag recogniser produced positive excess returns '
    + 'over buy-and-hold on the NYSE Composite, 1980-1999.',
  later: 'Wang & Chan (2007) on NASDAQ and the Taiwan Weighted Index, and Fernandes (2022) on BOVESPA and the SSE, '
    + 'report large positive excess profits — 62.84% and 103.83% annualised at p = 20, T = 3.',
  against_it: 'Marshall, Young & Rose-style evidence runs the other way for candlesticks, and Cervello-Royo et al. '
    + '(2015) note that Marshall et al. (2008) "did not find any positive empirical evidence for the US equity market" '
    + 'for the flag over their sample.',
  the_problem_with_all_of_it: 'Every one of those studies swept a grid of windows, thresholds and holding periods and '
    + 'reported the best cells. None of the reachable sources reports a trial count or a deflated Sharpe. CLAUDE.md: '
    + 'the best of 200 no-edge strategies scores an annualised Sharpe of 2.19. Treat the published excess profits as '
    + 'unaudited until they carry a trial count.',
  read_as: 'A high fit means the window matches a published template. It is not evidence of an edge.',
});

/**
 * Perceptually Important Points.
 *
 * Keep the first and last observation, then repeatedly add whichever remaining
 * point is furthest from the straight line joining its two bracketing kept
 * points, until `k` points are held. Chung, Fu, Luk & Ng (2001); Fu et al.
 * (2007).
 *
 * Returns indices into `values`, ascending. Fewer than `k` points in means the
 * indices are returned as-is — padding a short series would invent turns.
 */
export function findPIPs(values, k, { distance = PIP_DEFAULTS.distance } = {}) {
  const v = (values || []).map(num);
  const n = v.length;
  if (n === 0 || v.some((x) => x == null)) return [];
  if (n <= k) return v.map((_, i) => i);
  if (k < 2) return [0];

  // Perpendicular only means anything on normalised axes — see PIP_DISTANCE_NOTE.
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo;
  const ny = (y) => (span > 0 ? (y - lo) / span : 0);
  const nx = (x) => (n > 1 ? x / (n - 1) : 0);

  const kept = [0, n - 1];
  while (kept.length < k) {
    let bestIdx = -1, bestDist = -1;
    for (let s = 0; s < kept.length - 1; s++) {
      const a = kept[s], b = kept[s + 1];
      if (b - a < 2) continue;
      for (let p = a + 1; p < b; p++) {
        let d;
        if (distance === 'perpendicular') {
          const x1 = nx(a), y1 = ny(v[a]), x2 = nx(b), y2 = ny(v[b]);
          const dx = x2 - x1, dy = y2 - y1;
          const denom = Math.hypot(dx, dy);
          d = denom > 0 ? Math.abs(dy * (nx(p) - x1) - dx * (ny(v[p]) - y1)) / denom : 0;
        } else {
          const t = (p - a) / (b - a);
          d = Math.abs(v[p] - (v[a] + (v[b] - v[a]) * t));
        }
        if (d > bestDist) { bestDist = d; bestIdx = p; }
      }
    }
    if (bestIdx < 0) break;
    kept.push(bestIdx);
    kept.sort((x, y) => x - y);
  }
  return kept;
}

/**
 * Which grid row a price falls in. Row 0 is the TOP (the highest price in the
 * window), matching the published figures.
 *
 * A window with NO price range returns null rather than a row. There is no
 * shape in a flat line, and the alternative — returning the middle row — was
 * tried and scored a perfectly flat 20-close window at **3.7**, above the
 * published threshold and above a real bull flag. A degenerate input has to
 * refuse, not average.
 */
export function gridRow(value, min, max, rows) {
  const v = num(value), lo = num(min), hi = num(max);
  if (v == null || lo == null || hi == null) return null;
  if (!(hi > lo)) return null;
  return Math.min(rows - 1, Math.max(0, Math.floor(((hi - v) / (hi - lo)) * rows)));
}

/**
 * OUR mapping: score the PIP RECONSTRUCTION of the window, on the same time
 * axis the template is defined on.
 *
 * PIP gives a piecewise-linear skeleton of the series through its most salient
 * turns. That skeleton is sampled at each column's midpoint and the sample's
 * price is mapped to a row by linear scaling — "the highest price in the window
 * is made to correspond with the top of the grid, and the lowest price with the
 * bottom" (Cervello-Royo et al. 2015). So PIP acts as a denoising step: the fit
 * is computed on the shape's skeleton rather than on every wiggle.
 *
 * ── One thing that was tried first and is wrong ──
 *
 * The obvious reading of "downsample to a fixed grid" is to put the k-th PIP in
 * the k-th COLUMN. That destroys the time axis, and the published template is
 * defined ON the time axis, so the two do not compose. Measured on constructed
 * fixtures it inverted the ranking outright: a textbook pole-flag-breakout
 * scored 2.8 while a FLAT line scored 3.7 and a bull flag breaking out to just
 * under its pole high scored **-5.3**. PIP clusters its points around turns, so
 * a straight pole contributes almost no columns and the whole shape is squashed
 * leftwards. Sampling the reconstruction on the real time axis keeps PIP's
 * denoising and loses none of the template's meaning.
 */
export function fitByPip(closes, template, {
  grid = 10, distance = PIP_DEFAULTS.distance, pip_count = null,
} = {}) {
  const v = (closes || []).map(num);
  if (v.some((x) => x == null)) return { fit: null, reason: 'non_numeric_close', cells: [] };
  if (v.length < grid) return { fit: null, reason: 'too_few_closes', cells: [] };

  const hi = Math.max(...v), lo = Math.min(...v);
  if (!(hi > lo)) {
    return { fit: null, reason: 'flat_window', cells: [], price_range: { high: round(hi, 4), low: round(lo, 4) },
      note: 'A window with no price range has no shape. Scoring it would return the template\'s own row sum, not a match.' };
  }

  const k = pip_count ?? grid;
  const idx = findPIPs(v, k, { distance });
  if (idx.length < 2) return { fit: null, reason: 'pip_underfilled', cells: [], pip_count: idx.length };

  /** Piecewise-linear value of the PIP skeleton at a fractional bar position. */
  const skeleton = (x) => {
    if (x <= idx[0]) return v[idx[0]];
    if (x >= idx[idx.length - 1]) return v[idx[idx.length - 1]];
    for (let s = 0; s < idx.length - 1; s++) {
      const a = idx[s], b = idx[s + 1];
      if (x >= a && x <= b) {
        const t = b === a ? 0 : (x - a) / (b - a);
        return v[a] + (v[b] - v[a]) * t;
      }
    }
    return v[idx[idx.length - 1]];
  };

  const per = v.length / grid;
  const cells = [];
  for (let column = 0; column < grid; column++) {
    const at = (column + 0.5) * per - 0.5;      // midpoint of the column's time slice
    const value = skeleton(at);
    const row = gridRow(value, lo, hi, grid);
    if (row == null) return { fit: null, reason: 'flat_window', cells: [] };
    cells.push({ column, row, at_bar: round(at, 2), value: round(value, 4), weight: template.weights[row][column] });
  }

  return {
    fit: round(cells.reduce((a, c) => a + c.weight, 0)),
    cells,
    price_range: { high: round(hi, 4), low: round(lo, 4) },
    pip_indices: idx,
    pip_count: idx.length,
  };
}

/**
 * THE PAPER'S mapping, from Wang & Chan (2007) as set out in Fernandes (2022)
 * pp. 16-19.
 *
 *   I(t,i) = 1 if (i-1)(p/10) < rank(t) <= i(p/10), where rank is over the
 *            window's values in DESCENDING order, so rank 1 is the highest;
 *   J(t,j) = 10/p if (j-1)(p/10) < t <= j(p/10);
 *   Fit    = sum over t,i,j of w(i,j) * I(t,i) * J(t,j).
 *
 * Each column holds p/10 days each contributing 10/p, so every column
 * contributes at most 1 and the maximum total is 10.
 *
 * Note this is a RANK mapping, not a price mapping: two windows with identical
 * orderings and wildly different price ranges score the same. The Cervello-Royo
 * restatement uses linear price scaling instead. That difference is real and is
 * one more reason the two mappings are both reported.
 */
export function fitByRank(closes, template, { grid = 10 } = {}) {
  const v = (closes || []).map(num);
  const p = v.length;
  if (v.some((x) => x == null)) return { fit: null, reason: 'non_numeric_close', cells: [] };
  if (p < grid) return { fit: null, reason: 'too_few_closes', cells: [] };
  if (Math.max(...v) === Math.min(...v)) {
    // Ranks are still well defined on a flat line — ties break by index, so the
    // mapping walks the template's diagonal and returns a number that describes
    // the template rather than the data. Refuse for the same reason fitByPip does.
    return { fit: null, reason: 'flat_window', cells: [] };
  }

  // Descending rank, 1-based, ties broken by index so the mapping is a bijection.
  const order = v.map((value, index) => ({ value, index }))
    .sort((a, b) => (b.value - a.value) || (a.index - b.index));
  const rank = new Array(p);
  order.forEach((o, r) => { rank[o.index] = r + 1; });

  const per = p / grid;
  const share = grid / p;
  let fit = 0;
  const cells = [];
  for (let t = 0; t < p; t++) {
    const row = Math.min(grid - 1, Math.max(0, Math.ceil(rank[t] / per) - 1));
    const col = Math.min(grid - 1, Math.max(0, Math.ceil((t + 1) / per) - 1));
    const w = template.weights[row][col];
    fit += w * share;
    cells.push({ t, rank: rank[t], row, column: col, close: round(v[t], 4), weight: w, contribution: round(w * share) });
  }
  return { fit: round(fit), cells, days_per_column: round(per) };
}

/**
 * Score the most recent `window` closes against a bull-flag template.
 *
 * Returns evidence and scores. It does NOT return a trade signal, and it does
 * not return an entry, a stop or a target — that would turn a template fit into
 * a plan, which is exactly what the replication record does not support.
 */
export function matchBullFlag(input, options = {}) {
  const o = { ...PIP_DEFAULTS, ...options };
  const tpl = typeof o.template === 'string' ? PIP_TEMPLATES[o.template] : o.template;
  if (!tpl || !Array.isArray(tpl.weights)) {
    return { ok: false, reason: 'unknown_template', known: Object.keys(PIP_TEMPLATES) };
  }

  const closes = Array.isArray(input) && input.length && typeof input[0] === 'object'
    ? input.map((b) => num(b?.close))
    : (input || []).map(num);

  if (closes.length < o.window) {
    return {
      ok: false, reason: 'insufficient_bars',
      note: `Need ${o.window} closes for the fitting window, have ${closes.length}.`,
      threshold: PIP_THRESHOLD_PROVENANCE, replication: PIP_REPLICATION, noise_floor: PIP_NOISE_BASELINE,
    };
  }
  const win = closes.slice(closes.length - o.window);
  if (win.some((c) => c == null)) {
    return { ok: false, reason: 'non_numeric_close', note: 'A null close is not a zero close. Nothing was scored.' };
  }

  const pip = fitByPip(win, tpl, { grid: o.grid, distance: o.distance, pip_count: o.pip_count });
  const rank = fitByRank(win, tpl, { grid: o.grid });
  const chosen = o.mapping === 'rank' ? rank : pip;
  const other = o.mapping === 'rank' ? pip : rank;

  const agree = pip.fit != null && rank.fit != null
    && (pip.fit >= o.min_fit) === (rank.fit >= o.min_fit);

  return {
    ok: chosen.fit != null,
    pattern: 'bull_flag',
    template: tpl.name,
    mapping: o.mapping,
    window: o.window,
    grid: `${o.grid}x${o.grid}`,
    fit: chosen.fit,
    max_fit: o.grid,
    min_fit: o.min_fit,
    meets_threshold: chosen.fit != null && chosen.fit >= o.min_fit,
    by_mapping: { pip: pip.fit, rank: rank.fit },
    mappings_agree: agree,
    ...(agree === false
      ? { disagreement: 'The two mappings land on opposite sides of the threshold. PIP scores the SHAPE, rank scores '
          + 'the SCHEDULE. That is the finding, not a defect — read both before quoting either.' }
      : {}),
    cells: chosen.cells,
    other_mapping_fit: other.fit,
    ...(chosen.reason ? { reason: chosen.reason } : {}),
    price_range: pip.price_range ?? null,
    pip_indices: pip.pip_indices ?? null,
    distance_measure: o.distance,
    distance_note: PIP_DISTANCE_NOTE,
    evidence: chosen.fit == null
      ? 'No fit could be computed.'
      : `Fit ${chosen.fit} of a possible ${o.grid} against the ${tpl.name} template over the last ${o.window} closes `
        + `(${o.mapping} mapping); the other mapping scores ${other.fit}. Threshold ${o.min_fit}.`,
    template_provenance: tpl.source,
    threshold_provenance: PIP_THRESHOLD_PROVENANCE,
    replication: PIP_REPLICATION,
    noise_floor: PIP_NOISE_BASELINE,
    what_this_is_not: 'A fit score is not a signal. It says the window resembles a published template; the studies '
      + 'behind that template swept windows, thresholds and holding periods and none of the reachable ones reports a '
      + 'trial count. No entry, stop or target is returned on purpose.',
  };
}

/**
 * Every window in the series that meets the threshold.
 *
 * Used by the noise harness, and the honest way to read a template matcher:
 * one fit on the last window says nothing about how often the template matches
 * anything at all.
 */
export function scanBullFlag(input, options = {}) {
  const o = { ...PIP_DEFAULTS, ...options };
  const closes = Array.isArray(input) && input.length && typeof input[0] === 'object'
    ? input.map((b) => num(b?.close))
    : (input || []).map(num);

  const hits = [];
  let scored = 0;
  for (let end = o.window; end <= closes.length; end++) {
    const r = matchBullFlag(closes.slice(0, end), o);
    if (!r.ok) continue;
    scored++;
    if (r.meets_threshold) {
      hits.push({ end_index: end - 1, fit: r.fit, by_mapping: r.by_mapping, mappings_agree: r.mappings_agree });
    }
  }
  return {
    hits,
    count: hits.length,
    windows_scored: scored,
    rate_pct: scored ? round((hits.length / scored) * 100, 1) : null,
    options: { window: o.window, mapping: o.mapping, template: typeof o.template === 'string' ? o.template : o.template?.name, min_fit: o.min_fit },
    noise_floor: PIP_NOISE_BASELINE,
  };
}

/**
 * Measured by scripts/detector-noise.js over random walks.
 *
 * This detector reads CLOSES ONLY, so the standard path-based harness null is
 * legitimate here — there is no open, high, low or volume for the fixture to
 * get wrong, which is precisely why gaps.js needed a new generator and this one
 * did not.
 *
 * The numbers below are the share of 200-bar random walks containing at least
 * one window that meets the threshold, and the share of ALL windows that do.
 * Read the second one: a detector that fires on a tenth of every window in pure
 * noise has nothing to say about any particular window.
 */
export const PIP_NOISE_BASELINE = Object.freeze({
  measured: true,
  measured_on: '2026-07-30',
  walks: 200,
  bars_each: 200,
  window: 20,
  generator: 'barsFromPath(randomWalk({ n: 200 })) — closes only, so no fixture risk',

  by_threshold: Object.freeze({
    wang_chan_2007: Object.freeze({
      pip: Object.freeze({
        'T>=3.0': { walks_with_any_pct: 100.0, windows_pct: 17.1, hits_per_walk: 30.88 },
        'T>=4.0': { walks_with_any_pct: 100.0, windows_pct: 8.3, hits_per_walk: 14.97 },
        'T>=5.0': { walks_with_any_pct: 95.5, windows_pct: 3.5, hits_per_walk: 6.40 },
        'T>=6.0': { walks_with_any_pct: 75.0, windows_pct: 1.2, hits_per_walk: 2.18 },
        'T>=7.0': { walks_with_any_pct: 34.0, windows_pct: 0.3, hits_per_walk: 0.56 },
        'T>=8.0': { walks_with_any_pct: 8.5, windows_pct: 0.1, hits_per_walk: 0.12 },
      }),
      rank: Object.freeze({
        'T>=3.0': { walks_with_any_pct: 98.5, windows_pct: 6.7, hits_per_walk: 12.05 },
        'T>=4.0': { walks_with_any_pct: 73.0, windows_pct: 1.9, hits_per_walk: 3.48 },
        'T>=5.0': { walks_with_any_pct: 20.0, windows_pct: 0.2, hits_per_walk: 0.29 },
        'T>=6.0': { walks_with_any_pct: 0.0, windows_pct: 0.0, hits_per_walk: 0.0 },
        'T>=7.0': { walks_with_any_pct: 0.0, windows_pct: 0.0, hits_per_walk: 0.0 },
        'T>=8.0': { walks_with_any_pct: 0.0, windows_pct: 0.0, hits_per_walk: 0.0 },
      }),
    }),
  }),

  headline: 'At the published threshold (T = 3, p = 20, Wang & Chan template) the rank mapping meets it on 6.7% of ALL '
    + 'windows drawn from pure random walks and the PIP mapping on 17.1% — and EVERY walk contains at least one match: '
    + '12 under rank, 31 under PIP. A 200-bar chart of pure noise yields a dozen or more "bull flags" at the published '
    + 'threshold. Whatever the excess returns in those studies came from, it was not scarcity.',

  reading: 'Selectivity arrives around T = 5 for the rank mapping (0.2% of windows, and NO walk contains a match at '
    + 'T = 6) and around T = 7 for PIP (0.3%). A constructed textbook bull flag — pole, shallow flag, breakout above '
    + 'the pole high — scores 6.35 under PIP and 4.13 under rank, so the shape does clear a threshold where noise '
    + 'mostly does not. Whether a fit that high carries any information is a separate question this cannot answer.',

  pip_is_looser_than_rank: 'PIP admits 2-4x more windows at every threshold and keeps scoring where rank has gone to '
    + 'zero (T = 6: 75.0% of walks against 0.0%). Two reasons, both structural. PIP replaces the series with a '
    + 'piecewise-linear skeleton, which removes the wiggles that would otherwise push a column off its best row; and '
    + 'the rank mapping spreads p/10 days across each column so a column\'s contribution is an AVERAGE of several '
    + 'days, while PIP samples one point. Averaging pulls towards the middle and caps the extremes. It is exactly why '
    + 'a threshold calibrated on the paper\'s mapping must not be reused here, and why both are always reported.',

  rank_ignores_magnitude: 'A further difference worth knowing before reading either number: the rank mapping uses only '
    + 'the ORDERING of the closes, so a 4% pullback and a 40% pullback inside the same window map to the same rows. '
    + 'The PIP mapping scales prices linearly, so depth matters. On a constructed flag whose pullback was shallow '
    + 'relative to its pole, rank scored 4.25 and PIP scored -6.3. Neither is wrong; they are answering different '
    + 'questions, and the disagreement is the useful output.',

  caveat: 'Selectivity is not accuracy, and a low false-positive rate at T = 7 says matches are rare, not that they '
    + 'resolve well. No forward test has been run.',

  /**
   * Real-data arm, run 2026-07-30 on the live chart: the same scan over 20
   * large caps (299 daily bars each). The headline is the T = 3 row.
   */
  real_arm: Object.freeze({
    measured_on: '2026-07-30',
    universe: '20 large caps (see GAP_NOISE_BASELINE.real_arm.universe), 299 daily bars each',
    windows_pct: Object.freeze({
      pip: Object.freeze({ 'T>=3.0': { real: 17.6, null: 17.1 }, 'T>=5.0': { real: 4.3, null: 3.5 }, 'T>=7.0': { real: 0.7, null: 0.3 } }),
      rank: Object.freeze({ 'T>=3.0': { real: 10.0, null: 6.7 }, 'T>=5.0': { real: 0.2, null: 0.2 }, 'T>=7.0': { real: 0.0, null: 0.0 } }),
    }),
    verdict: 'At the PUBLISHED threshold the PIP mapping matches 17.6% of real windows against 17.1% of pure noise — '
      + 'ZERO discrimination: T = 3 describes real charts and random walks at the same rate. The rank mapping shows a '
      + 'modest 1.5x lift (10.0 vs 6.7). At the strict thresholds matches are rare everywhere (T = 7 PIP: 0.7 real vs '
      + '0.3 noise, a 2.3x lift on tiny rates; T = 5 rank: identical at 0.2). Real charts trend, so a bull-flag '
      + 'template firing NO MORE on real data than on noise is the template failing to see what it claims to see. '
      + 'This is the strongest argument yet that the published excess returns did not come from the template.',
    reproduce: 'node scripts/gaps-real-arm.js',
  }),

  for_comparison: 'structural patterns 68% of random walks; LMW definitions 43.4% of five-pivot windows; '
    + 'VCP 0%; pennants 0%.',

  reproduce: 'node scripts/detector-noise.js --walks 200',
});
