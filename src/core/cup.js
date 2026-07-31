/**
 * The cup with handle, as a measurable rule.
 *
 * Bulkowski ranks it **3 of 39** — the best-performing bullish pattern in his
 * universe that this repo can actually detect from daily bars. That ranking is
 * the reason it is here, and it is also the reason to be careful: a pattern with
 * a good published rank attracts detections, and a loose detector will find one
 * on anything.
 *
 * ── READ THIS BEFORE QUOTING THE RANK ──
 *
 * It turned out to be the second thing. Measured: **23.5% of 300-bar random walks
 * carry a qualifying cup**, against 0% for VCP, pennants and springs. This is
 * NOT a selective detector — see CUP_NOISE_BASELINE, which also records the floor
 * climbing with series length (7 / 11 / 23.5 / 35% at 150 / 200 / 300 / 400 bars)
 * because a cup is defined by a rim PAIR and pairs grow quadratically in pivots.
 *
 * His 3/39 describes 913 patterns a human picked BY EYE — "I visually inspected
 * the cups", "Use your own judgment". The gap between that and eight numeric
 * clauses is the 23.5%. The rank and this detector's output are not the same set,
 * and the rank must not be allowed to do the arguing for a detection.
 *
 * ── What the shape asserts ──
 *
 * Price rises, rolls over into a ROUNDED turn — a cup, not a spike — recovers to
 * roughly the price it left, then pulls back a little and pauses. That pause is
 * the handle. The pattern completes when price closes back above the right cup
 * lip.
 *
 * ── Provenance of every clause ──
 *
 *   https://thepatternsite.com/cup.html   (read 2026-07-30)
 *
 * Where Bulkowski gives a number, the number is his and is cited at the clause
 * in `CUP_CITATIONS`. Where he gives a WORD — "near the same price level but be
 * flexible", "U-shaped, not V-shaped" — the number is OURS and is labelled
 * `ours`, because a rule with no number cannot be measured against noise. Two
 * clauses are entirely ours (`cup_depth_in_range`, `cup_contains_no_higher_high`)
 * and exist so a flat drift and a two-peaked staircase cannot be read as cups.
 *
 * ── Volume is SUPPORTING evidence and never part of the verdict ──
 *
 * Handle volume dry-up is a classic cup clause and it is deliberately excluded
 * from `qualifies`. The harness's `barsFromPath` writes near-flat volume
 * (`1000 + floor(rand()*500)`), so ANY volume clause measured against it is
 * decided by the fixture rather than by the detector — the shape of the defect
 * that left `ignition.js` without a floor and made `gaps.js`'s exhaustion class a
 * bracket instead of a number. `gaps.js` solves it by reporting the hedged
 * clauses under `supporting`; so does this. The consequence is stated plainly:
 * CUP_NOISE_BASELINE is a floor on the PRICE clauses only, and it is honest
 * precisely because no volume clause reaches the verdict.
 *
 * All pure. No chart, no network.
 */
import { findPivots } from './pivots.js';

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * `Number(null)` is 0, and that has produced a fabricated finding three times in
 * this repo. Anything that is not a finite number becomes null here and stays
 * null all the way to the output, where a null clause reports NOT CHECKED and
 * does NOT pass.
 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A clause, in the vcp_check / gaps.js shape: pass, the value, and what was required. */
const clause = (pass, value, required, extra = {}) => ({ pass: !!pass, value, required, ...extra });

/** A clause whose input was missing. NOT CHECKED is not a pass — see CLAUDE.md. */
const notChecked = (required, why) => ({
  pass: false, value: 'NOT CHECKED', required,
  note: `${why} Unknown is not satisfied, so this clause does NOT pass.`,
});

/**
 * ── Pivot density, and why it is LOW ──
 *
 * `findPivots` is the one backbone (P2.3). Its `lookback` is a density knob and
 * `pivots.js` carries the measured mapping: bandwidth = 0.4 x lookback, and at
 * lookback 10 a 400-bar series yields ~22.9 pivots — roughly one every 17 bars.
 *
 * A cup spans **35 to 325 bars**. At the repo's default lookback 5 a 300-bar
 * window holds ~34 pivots, one every ~9 bars, so a 60-bar cup contains six or
 * seven of them: the rounded bottom fragments into a run of minor highs and lows,
 * and the "left rim" the scan picks is whichever wiggle happened to peak rather
 * than the rim a reader would draw. Worse, the P2.3 note in CLAUDE.md records the
 * consequence at the other end — pattern recency is counted in SWINGS, so under
 * dense pivots a long pattern ages out of a 300-bar scan sooner than it used to
 * (observed live on GRMN). A pattern that can be 325 bars long needs pivots
 * sparse enough that its two rims are still adjacent-ish highs in the sequence.
 *
 * So the default here is **lookback 9**, bandwidth 3.6 bars — about one pivot per
 * 15 bars, which puts 3 to 4 pivots inside a 60-bar cup (a left rim, a bottom, a
 * right rim, with one spare) and ~20 inside the longest legal one.
 *
 * It is NOT fixed, and that matters. `assessment.js` sweeps the detector at
 * lookback 3/4/5/6/8 and calls a pattern STABLE only when it survives 3 of the 5.
 * A cup detector that ignored the sweep would survive 5 of 5 every time and the
 * stability measure would silently read 100% — the same failure `pivots.js`
 * refuses cross-validated bandwidth for ("a confidence number that cannot fail is
 * worse than no confidence number"). `cupPatterns` therefore maps the caller's
 * lookback through `+ CUP_LOOKBACK_OFFSET`, so the sweep becomes 7/8/9/10/12:
 * monotone, always sparse enough, and genuinely able to disagree with itself.
 */
export const CUP_LOOKBACK_OFFSET = 4;

export const CUP_DEFAULTS = {
  /** PIVOT density, not the caller's detector lookback. See the note above. */
  lookback: 9,

  /** Bulkowski quotes the cup's duration in WEEKS. Daily bars, 5 a week. */
  bars_per_week: 5,
  /** Bulkowski: "From 7 to 65 weeks (allow variations)." 7 x 5. */
  min_cup_bars: 35,
  /** 65 x 5. */
  max_cup_bars: 325,

  /** OURS. Bulkowski: "Cup rims should be near the same price level but be flexible." */
  rim_tolerance_pct: 5,

  /**
   * OURS. The U/V separator — see `U_SHAPE_ARITHMETIC` for the derivation.
   * `base_band_frac` is the bottom slice of the cup's height that counts as "the
   * base"; `min_base_time_pct` is how much of the cup's time must be spent in it.
   */
  base_band_frac: 0.25,
  min_base_time_pct: 35,

  /** Bulkowski: handle "1 week minimum with no maximum". No maximum is enforced. */
  min_handle_bars: 5,
  /** Bulkowski: the handle forms "in the upper half of the cup". Half is his. */
  max_handle_retrace_frac: 0.5,
  /** OURS. Below this the "handle" is noise at the rim and there is no handle. */
  min_handle_retrace_frac: 0.05,

  /** OURS. A 2% wiggle over 60 bars is a drift, not a cup. */
  min_cup_depth_pct: 10,
  /** OURS. Past half the rim price the "rounded turn" is a collapse and a recovery. */
  max_cup_depth_pct: 50,

  /** Supporting only — Bulkowski explicitly de-emphasises the prior rise. */
  prior_rise_bars: 40,
  /** Supporting only. */
  volume_lookback: 20,

  /**
   * How far OUTSIDE the legal duration a rim pair may sit and still be SCORED.
   *
   * Without this the duration bound is a candidate pre-filter, and a pre-filter is
   * a clause that cannot fail: a 20-bar cup would never become a candidate, so
   * `duration_in_range` would report `pass` on every result it ever appeared in
   * and the near miss would come back as the useless "no_candidate_pair". Scoring
   * a wider window and REJECTING on the clause is what makes "62 bars, needs 35"
   * reachable. It cannot add a qualifying detection — `duration_in_range` is
   * required — so it changes the diagnosis and not the verdict.
   */
  candidate_span_slack: 2,
};

/**
 * Why `min_base_time_pct` is 35, worked out rather than picked.
 *
 * "U-shaped, not V-shaped" is a picture. The measurable content of it is TIME
 * SPENT NEAR THE LOW: a V touches its low once and leaves, a U sits there.
 *
 * Take a symmetric pattern of n bars and ask what share of them have a low inside
 * the bottom `base_band_frac` (0.25) of the cup's height:
 *
 *   V (two straight legs)   price is within the bottom quarter over the last
 *                           quarter of each leg  ->  **25%** of bars
 *   U (parabola)            price = low + depth * (2t/n - 1)^2, which is inside
 *                           the bottom quarter when |2t/n - 1| <= 0.5, i.e. for
 *                           t/n in [0.25, 0.75]  ->  **50%** of bars
 *
 * 35% sits between them with room either side for noise, and it is the only
 * number in this module that separates the two shapes Bulkowski names. The
 * SYMMETRY of the two legs is measured too, but reported as supporting evidence
 * and NOT gated: Bulkowski never requires symmetry, and gating on it would reject
 * real cups for a clause he does not have.
 */
export const U_SHAPE_ARITHMETIC = Object.freeze({
  band: 'the bottom 25% of the cup height, measured on real bar lows',
  v_bottom_expected_pct: 25,
  u_bottom_expected_pct: 50,
  threshold_pct: 35,
  source: 'ours — derived from the two idealised shapes, not from any published number',
  bulkowski_words: 'The cup should be U-shaped, not V-shaped, but allow variations.',
});

/**
 * Where each clause came from. `ours` means the source describes the clause in
 * words and gives no number, so the number is a modelling choice and must be
 * quoted as one.
 *
 * Source page: https://thepatternsite.com/cup.html, read 2026-07-30.
 */
export const CUP_CITATIONS = Object.freeze({
  shape: {
    source: 'https://thepatternsite.com/cup.html',
    quote: 'A rounded turn that looks like a cup with a handle on the right of the cup.',
  },
  u_shaped_not_v: {
    source: 'https://thepatternsite.com/cup.html',
    quote: 'The cup should be U-shaped, not V-shaped, but allow variations.',
    number_is: 'ours',
    why: 'He gives the shape and no threshold. See U_SHAPE_ARITHMETIC for how 35% was derived.',
  },
  handle_required: {
    source: 'https://thepatternsite.com/cup.html',
    quote: 'The cup must have a handle on the right.',
    second_source: 'Encyclopedia of Chart Patterns 2nd ed. (2005) ch. 9: "A cup without a handle is a rounding bottom." '
      + 'That is why `handle_present` is a required clause and not a preference — without it this detector would be '
      + 'a rounding-bottom detector wearing the cup\'s base rates.',
  },
  cup_duration: {
    source: 'https://thepatternsite.com/cup.html',
    quote: 'From 7 to 65 weeks (allow variations).',
    conversion: '7 and 65 weeks at 5 trading days a week = 35 and 325 daily bars. On any other '
      + 'timeframe `bars_per_week` is wrong and must be supplied — a 65-week cup is 325 daily bars '
      + 'and 3,250 hourly ones.',
  },
  handle_duration_and_position: {
    source: 'https://thepatternsite.com/cup.html',
    quote: '1 week minimum with no maximum, forming in the upper half of the cup.',
    note: 'BOTH halves are his: the 1-week floor AND "the upper half of the cup", which is the '
      + '50% retrace bound. There is deliberately no maximum handle length here either.',
    second_source: 'Encyclopedia 2nd ed. ch. 9 gives the same two rules in units this code can use directly: '
      + '"Also removed were those cups with handles shorter than 7 days (5 trading days)" — which is the 5-bar '
      + 'floor — and "I visually inspected the cups to be sure prices in the handle drifted no lower than halfway '
      + 'down the cup. I removed those drifting lower". The midpoint clause is literally his selection rule.',
    handle_window: 'Encyclopedia 2nd ed. ch. 9: "I considered the handle length as the distance from the right cup '
      + 'lip to the breakout." That is exactly how the handle window is built here — right rim exclusive to the '
      + 'first close above the rim, or to the last bar when there is none. It was chosen before this quote was '
      + 'found, and the agreement is why a stale breakout ages out through `bars_ago` instead of growing an '
      + 'ever-longer handle that eventually fails the upper-half clause for the wrong reason.',
  },
  rim_tolerance: {
    source: 'https://thepatternsite.com/cup.html',
    quote: 'Cup rims should be near the same price level but be flexible.',
    number_is: 'ours',
    why: '5%. He gives no figure and says "be flexible"; for DOUBLE TOPS, where he does give one, '
      + 'it is "usually less than 3%". "Flexible" must mean looser than that, so 5% widens his own '
      + 'tightest stated tolerance by two points rather than inventing a scale.',
    second_source: 'Encyclopedia 2nd ed. ch. 9 confirms there is no number to find: "I assign no hard percentages '
      + 'to the difference. Use your own judgment." It also says what a wide-lipped cup IS — "Cups with uneven '
      + 'lips are better classified as scallops" — so failing this clause is a reclassification, not a near miss.',
  },
  prior_trend: {
    source: 'https://thepatternsite.com/cup.html',
    quote: "Price rises into the start of the cup, but I don't pay much attention to this guideline.",
    note: 'He de-emphasises it in the same sentence he states it, so it is SUPPORTING evidence here '
      + 'and not a required clause. Compare `structuralPatterns`, which does gate on a prior trend — '
      + 'for double tops and head-and-shoulders Bulkowski states that requirement without hedging it.',
    sources_disagree: 'THE TWO SOURCES CONTRADICT EACH OTHER HERE, and it is the only place they do. The 2005 '
      + 'Encyclopedia applied a HARD 30% prior-rise filter — Table 9.1 marks O\'Neil\'s "Rise before cup is at '
      + 'least 30%" as "Same", and the prose confirms it: "So I used O\'Neil\'s minimum rise to the left cup lip '
      + 'of 30%." The site, twenty years later, says he does not pay much attention to it. The SITE wins, per '
      + 'this repo\'s rule that the current source supersedes the 2005 edition, so the 30% is measured and '
      + 'reported under `supporting.prior_rise_into_cup` and gates nothing. A reviewer who wants the book\'s '
      + 'behaviour has the number in front of them.',
  },
  measure_rule: {
    source: 'https://thepatternsite.com/cup.html',
    quote: "Measure the height from the right cup lip (A) to the lowest valley (B) then multiply by "
      + "the above 'percentage meeting price target.' Add the result to the breakout price (A) to get a target.",
  },
  cup_depth: {
    source: 'ours, bracketing O\'Neil',
    why: 'Bulkowski sets NO depth bound at all — Encyclopedia 2nd ed. Table 9.1 lists O\'Neil\'s "Cup depth: 12% '
      + 'or 15% to 33%; some decline 40% to 50%" against a Bulkowski selection guideline of "None". Without a '
      + 'minimum a 2% drift over 60 bars is a cup, so the clause exists; 10-50% brackets O\'Neil\'s band on both '
      + 'sides rather than inventing a scale.',
    stricter_than_his_sample: 'THIS DETECTOR IS STRICTER THAN THE SAMPLE THE BASE RATES CAME FROM. Bulkowski\'s '
      + '913 trades include cups this clause would reject. A depth-filtered detector quoting an unfiltered '
      + 'pattern\'s rank is quoting a number measured on a different population — stated here rather than hidden, '
      + 'and the same is true of the volume criteria he also declines to apply.',
  },
  no_higher_high_inside: { source: 'ours', why: 'Structural validity, not a guideline: a "cup" containing a high above its own rims is a staircase.' },
  volume: {
    source: 'ours — and reported as SUPPORTING evidence only',
    why: 'Handle volume dry-up is the classic clause and it is kept OUT of the verdict on purpose. '
      + 'The synthetic harness writes near-flat volume, so a volume clause measured against it is '
      + 'decided by the fixture. See the module header and gaps.js GAP_NOISE_BASELINE.',
    and_bulkowski_agrees: 'He applies no volume criterion either. Encyclopedia 2nd ed. Table 9.1 lists three of '
      + 'O\'Neil\'s volume rules — "Substantial increase in volume during prior uptrend", "Handle downward volume '
      + 'trend", "High breakout volume, at least 50% above normal" — and marks his own guideline "None" against '
      + 'all three. So excluding volume from the verdict is not merely a fixture workaround; it also keeps this '
      + 'detector on the same selection basis as the sample its base rates were measured on.',
  },
});

/**
 * The second source, and the sharp limit on what it may be used for.
 *
 * `Encyclopedia of Chart Patterns`, 2nd ed. (2005), ch. 9, was read for the
 * IDENTIFICATION GUIDELINES only — the wording of the clauses, the units, and
 * O'Neil's original criteria beside Bulkowski's own selection rules in Table 9.1.
 *
 * Its PERFORMANCE STATISTICS are deliberately not used anywhere in this module.
 * patterns.js records why: the 2005 figures were quoted in this repo as fact and
 * were wrong on three counts at once — obsolete pattern universe (23/21 rather
 * than 39/36), much smaller samples, and at least one outright parse error.
 * `STRUCTURAL_STATS.cup_with_handle` and `CUP_BASE_RATES` both come from the site.
 *
 * The ONE exception is the pair of measure-rule hit rates in
 * `CUP_BASE_RATES.measure_rule_hit_rates`, which are quoted BECAUSE the site does
 * not publish them and they are labelled with their edition at the point of use.
 */
export const CUP_SECOND_SOURCE = Object.freeze({
  work: 'Bulkowski, Encyclopedia of Chart Patterns, 2nd edition (2005), ch. 9 "Cup with Handle"',
  used_for: 'identification guidelines, units, and O\'Neil\'s criteria in Table 9.1',
  NOT_used_for: 'performance statistics, ranks or failure rates — see patterns.js STRUCTURAL_STATS on why the '
    + '2005 figures were withdrawn from this repo',
  bulkowski_applies_none_of: Object.freeze([
    'improving relative strength', 'volume increase during the prior uptrend', 'cup depth bounds',
    'handle downward price trend', 'handle downward volume trend', 'handle above the 200-day average',
    'handle price drop of 10-15%', 'breakout volume 50% above normal',
  ]),
  u_shape_caveat: 'On removing V-shaped cups he says plainly: "I am not sure about the performance effect of '
    + 'this." The U/V clause is therefore an IDENTIFICATION rule with no measured payoff behind it, from him or '
    + 'from here — and it is the clause that does most of the rejecting on real data.',
});

/**
 * Bulkowski's own measured figures, quoted so they travel with the detection.
 *
 * The numbers themselves live in `STRUCTURAL_STATS.cup_with_handle` in
 * patterns.js, where `statsFor()` and the coverage test read them. This block
 * carries the two readings that are easy to get wrong.
 */
export const CUP_BASE_RATES = Object.freeze({
  source: 'https://thepatternsite.com/cup.html',
  read_on: '2026-07-30',
  rank: '3/39',
  break_even_failure_pct: 5,
  average_rise_pct: 54,
  throwback_pct: 62,
  meeting_target_pct: 61,
  sample: '913 perfect trades',
  average_rise_is_not_a_target: 'The 54% average rise is measured from the breakout to the ULTIMATE HIGH '
    + 'before a 20% reversal, gross of costs, on perfect trades. It is not the measure rule and must never '
    + 'be used as one — the measure rule is the cup height, and even that he discounts by 61%.',
  throwback_discriminates_nothing: 'A 62% throwback rate sits inside the 58-74% band every pattern in '
    + 'STRUCTURAL_STATS reports. A throwback is what most breakouts do, so its presence carries no '
    + 'information about this one.',
  /**
   * The only numbers taken from the 2005 edition, and they are here because the
   * site does not publish them. They are what turn "the measure rule" from one
   * number into a choice with a hit rate attached.
   */
  measure_rule_hit_rates: Object.freeze({
    source: 'Encyclopedia of Chart Patterns 2nd ed. (2005), ch. 9 — NOT the site, and labelled as such',
    full_height_reached_pct: { bull: 50, bear: 27 },
    half_height_reached_pct: { bull: 76, bear: 55 },
    quote: 'However, this method only has a 50% success rate (half the formations reach their price targets in a '
      + 'bull market--fewer, 27%, in a bear market). For a better target, compute the cup height and take half of '
      + 'it. Then continue as before. The stock reaches the new, lower-priced target 76% of the time in a bull '
      + 'market; 55% in a bear market.',
    authors_own_verdict: 'Of the 76% he adds: "This is still shy of the 80% number I consider reliable."',
    reconciliation: 'His 2005 full-height figure (50% bull) and his current site figure (61%) disagree by 11 '
      + 'points across editions and samples. Both are reported; neither is averaged, because an average of two '
      + 'numbers he never combined is a number nobody measured.',
  }),
});

/**
 * Measured by scripts/detector-noise.js.
 *
 * ── Which null, and what it can and cannot say ──
 *
 * `barsFromPath(randomWalk(...))` — the standard harness path. Legitimate here in
 * a way it is NOT for gaps.js: every clause in the verdict reads only bar highs,
 * lows and closes, all of which a reconstructed path produces faithfully. The one
 * quantity that path cannot produce honestly is VOLUME, and no volume clause
 * reaches the verdict, so the floor below is a floor on the whole verdict rather
 * than on part of it.
 *
 * TWO arms, because one would have measured only part of the duration space: at
 * 200 bars a cup longer than ~195 is unreachable by construction, and the legal
 * range runs to 325. The 400-bar arm opens the whole range.
 */
export const CUP_NOISE_BASELINE = Object.freeze({
  measured: true,
  measured_on: '2026-07-30',
  walks: 200,
  generator: 'barsFromPath(randomWalk({ n, seed: 7000+s }), { noise: 0.006, seed: 8000+s }) — src/core/synthetic.js',

  /** THE headline: the rate at the length the workflow actually loads. */
  bars_each: 300,
  qualifying_pct_of_walks: 23.5,

  volume_note: 'The generator writes near-flat volume (1000 + floor(rand()*500)). That is why every volume '
    + 'clause here is SUPPORTING and none of them reaches `qualifies`: a verdict clause measured against '
    + 'flat volume would be decided by the fixture, which is the ignition.js failure. VERIFIED rather than '
    + 'asserted — the harness re-runs the 300-bar arm with every volume field deleted and the result is '
    + 'identical, walk for walk and clause for clause. So this floor covers the WHOLE verdict.',

  /**
   * ── THE FLOOR IS NOT ONE NUMBER. IT CLIMBS WITH SERIES LENGTH. ──
   *
   * That is not noise in the measurement, it is the detector's structure. A cup is
   * defined by a PAIR of rims, so every pair of pivot highs a legal distance apart
   * is a candidate and the best one is reported. Pairs grow quadratically in pivot
   * highs, and pivot highs grow linearly in bars — so the number of trials grows
   * quadratically in the length of the series, and the qualifying rate tracks it
   * almost linearly.
   *
   * This is CLAUDE.md's trial-count rule appearing inside a detector instead of
   * inside a backtest: "a result without a trial count flatters itself". Every
   * detection therefore reports `candidates_scored`, and the examples below are
   * labelled with theirs — the 300-bar hits were the best of 34 to 44 rim pairs.
   */
  length_dependence: Object.freeze({
    bars_150: { qualifying_pct: 7.0, pivot_highs_per_walk: 4.5, rim_pairs_scored_per_walk: 7.9 },
    bars_200: { qualifying_pct: 11.0, pivot_highs_per_walk: 6.1, rim_pairs_scored_per_walk: 15.2 },
    bars_300: { qualifying_pct: 23.5, pivot_highs_per_walk: 9.1, rim_pairs_scored_per_walk: 37.0 },
    bars_400: { qualifying_pct: 35.0, pivot_highs_per_walk: 12.1, rim_pairs_scored_per_walk: 67.5 },
    reading: 'Quote the rate FOR THE LENGTH YOU RAN. Quoting the 200-bar 11% against a 300-bar chart '
      + 'understates the floor by half, and a 400-bar load would be worse again. The rate tracks the '
      + 'rim-pair count, not the bar count — 7.9 pairs to 67.5 pairs, 7% to 35%.',
  }),

  /**
   * Which clause does the rejecting, at 300 bars — counted on the BEST near-miss
   * candidate of each walk, attributed to the first failing clause in declared
   * order. Published because a bare rate says the conjunction is or is not
   * selective without saying which part of it does the work.
   */
  failing_clause_pct_of_walks_at_300: Object.freeze({
    rims_near_same_price: 48.5,
    u_shaped_not_v: 20.0,
    cup_depth_in_range: 4.0,
    handle_in_upper_half: 3.0,
    handle_present: 1.0,
    cup_contains_no_higher_high: 0.0,
    duration_in_range: 0.0,
    handle_is_a_pullback: 0.0,
    reading: 'The RIM TOLERANCE does two-thirds of the rejecting and the U/V clause most of the rest. Both '
      + 'are OURS, so the selectivity such as it is rests on two numbers Bulkowski declined to give — he says '
      + '"I assign no hard percentages" for the rims and "I am not sure about the performance effect" for the '
      + 'U/V cut. THREE clauses never decide anything on a random walk: `duration_in_range`, '
      + '`handle_is_a_pullback` and `cup_contains_no_higher_high`. That is not a reason to remove them — the '
      + 'first two reject constructed fixtures and the third exists for a staircase, which a random walk pairs '
      + 'its way around — but it does mean they contribute nothing to this floor and must not be credited with it.',
  }),

  /**
   * How far the answer travels on the two OURS numbers that do the rejecting.
   * Same discipline as gaps.js's volume sweep: a threshold with no floor beside it
   * is not a threshold, and neither of these has a published value to defend.
   */
  sensitivity_at_300_bars: Object.freeze({
    rim_tolerance_pct: { 3: 13.0, 4: 18.5, 5: 23.5, 6: 35.0, 8: 52.5 },
    min_base_time_pct: { 25: 38.5, 30: 31.5, 35: 23.5, 40: 16.5, 45: 8.0 },
    reading: 'The floor is a BRACKET of roughly 8-52% across defensible settings of two unpublished '
      + 'numbers, not a point. 23.5% is the rate at the shipped defaults, and those defaults were fixed '
      + 'BEFORE this sweep was run — they have deliberately not been retuned to flatter the number, '
      + 'because a threshold chosen after seeing its own null is fitted to the null. Note that even the '
      + 'TIGHTEST settings measured here (rim 3%, base time 45%) leave the floor at 8-13%, an order of '
      + 'magnitude above VCP and pennants: this is not a detector one threshold away from being selective.',
  }),

  for_comparison: {
    vcp: '0% of 200 walks (vcp.js VCP_NOISE_BASELINE)',
    pennants: '0% (patterns.js NOISE_BASELINE)',
    springs_upthrusts: '0% (wyckoff.js)',
    breakout_of_a_prior_high: '32.5% (breakout.js)',
    structural_patterns_any: '61% of 200 walks contain at least one (patterns.js NOISE_BASELINE.cross_check_200_walks)',
    elliott_rule_valid_count: '82%',
    zones: '99.5%',
  },

  /**
   * ── THE READING, AND IT IS UNFLATTERING ──
   *
   * This is NOT a selective detector, and its published pedigree makes that easy
   * to miss. Bulkowski ranks the cup with handle 3 of 39; this detector puts one
   * on **nearly one random walk in four** at the length the workflow runs. It
   * belongs with `breakout` (32.5%) and the structural family (61%), not with
   * VCP, pennants and springs (0%) — and the detections quoted from the 300-bar
   * arm are indistinguishable, clause by clause, from what a real cup produces.
   *
   * The mechanism is not a bug to be fixed by tightening. Bulkowski selected his
   * own 913 samples BY EYE — "I visually inspected the cups", "Use your own
   * judgment and the figures in this chapter as guides" — and the gap between a
   * human's visual judgment and eight numeric clauses IS this 19%. His rank
   * describes patterns a person picked; it does not transfer to patterns this
   * code picks, and the two must not be quoted as if they were the same set.
   *
   * So: a cup detection is CONFLUENCE material, in the same class as a zone or a
   * lone divergence. Quote `candidates_scored` beside it and never let the 3/39
   * rank do the arguing.
   */
  reading: 'NOT SELECTIVE. 23.5% of 300-bar random walks carry a qualifying cup — nearly one in four — '
    + 'against 0% for VCP, pennants and springs. Detections on noise are clause-for-clause indistinguishable '
    + 'from real ones (depth 11-19%, rims 1.9-4.8% apart, base time 35-45%, handles of 5-61 bars retracing '
    + '18-49%). Treat a cup as confluence, not as evidence, and quote candidates_scored with it.',

  caveat: 'Selectivity is not accuracy, and this cuts BOTH ways here. A 23.5% floor does not mean the pattern '
    + 'does not work — it means THIS DETECTOR cannot tell a cup from a meander often enough for a detection '
    + 'alone to carry information. The only return evidence attached to the pattern anywhere is Bulkowski\'s '
    + 'own, measured on hand-picked perfect trades gross of costs to a peak unknowable at the time. There is '
    + 'no forward test of this detector, and per this repo\'s holdout rule everything here is PROVISIONAL '
    + 'until one exists.',
  reproduce: 'node scripts/detector-noise.js --walks 200',
});

/** Mean volume over a bar range, or null if too little of it is usable. */
function avgVolume(bars, from, to) {
  const vols = [];
  for (let i = Math.max(0, from); i <= Math.min(bars.length - 1, to); i++) {
    const v = num(bars[i]?.volume);
    if (v == null || v <= 0) continue;
    vols.push(v);
  }
  if (!vols.length) return null;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

/** The lowest bar low in [from, to], with its index. */
function lowestLow(bars, from, to) {
  let price = null; let index = null;
  for (let i = Math.max(0, from); i <= Math.min(bars.length - 1, to); i++) {
    const l = num(bars[i]?.low);
    if (l == null) continue;
    if (price == null || l < price) { price = l; index = i; }
  }
  return { price, index };
}

/** The highest bar high in [from, to]. Null-safe: an empty or unusable range is null. */
function highestHigh(bars, from, to) {
  let price = null;
  for (let i = Math.max(0, from); i <= Math.min(bars.length - 1, to); i++) {
    const h = num(bars[i]?.high);
    if (h == null) continue;
    if (price == null || h > price) price = h;
  }
  return price;
}

/**
 * Score one candidate cup: a left rim high, a right rim high, and the real bar
 * low between them.
 *
 * Returns the full clause set whether or not it qualifies, so a near miss names
 * the clause that failed rather than reporting a bare no.
 */
function scoreCandidate(bars, left, right, o) {
  const lastIndex = bars.length - 1;
  const leftPrice = num(left.price);
  const rightPrice = num(right.price);
  if (leftPrice == null || rightPrice == null) return null;

  const bottom = lowestLow(bars, left.index, right.index);
  if (bottom.price == null || bottom.index == null) return null;
  // The low must sit strictly INSIDE the cup. A "cup" whose low is one of its own
  // rims is a leg, not a turn.
  if (bottom.index <= left.index || bottom.index >= right.index) return null;

  const rimHigh = Math.max(leftPrice, rightPrice);
  const depth = rimHigh - bottom.price;
  if (!(depth > 0)) return null;

  const cupBars = right.index - left.index;

  // ── the handle: everything after the right rim, ending at the breakout ──
  //
  // Ending it at the breakout rather than at the last bar is what lets a cup that
  // confirmed 90 bars ago age out through `bars_ago` instead of accumulating an
  // ever-longer "handle" that eventually fails the upper-half clause for the
  // wrong reason.
  let breakoutIdx = null;
  for (let i = right.index + 1; i <= lastIndex; i++) {
    const c = num(bars[i]?.close);
    if (c != null && c > rightPrice) { breakoutIdx = i; break; }
  }
  const endIdx = breakoutIdx == null ? lastIndex : breakoutIdx;
  const handleBars = endIdx - right.index;
  const handleLow = lowestLow(bars, right.index + 1, endIdx);
  const handleHigh = highestHigh(bars, right.index + 1, endIdx);

  const handleDrop = handleLow.price == null ? null : rightPrice - handleLow.price;
  const handleRetraceFrac = handleDrop == null ? null : handleDrop / depth;

  // ── U vs V: time spent in the bottom band of the cup ──
  const band = bottom.price + depth * o.base_band_frac;
  let inBase = 0; let counted = 0;
  for (let i = left.index; i <= right.index; i++) {
    const l = num(bars[i]?.low);
    if (l == null) continue;
    counted++;
    if (l <= band) inBase++;
  }
  const baseTimePct = counted ? (inBase / counted) * 100 : null;

  // ── structural validity: nothing inside may top the rims ──
  const interiorHigh = highestHigh(bars, left.index + 1, right.index - 1);

  const rimDiffPct = rimHigh > 0 ? (Math.abs(leftPrice - rightPrice) / rimHigh) * 100 : null;
  const depthPct = rightPrice > 0 ? (depth / rightPrice) * 100 : null;

  const checks = {
    duration_in_range: clause(
      cupBars >= o.min_cup_bars && cupBars <= o.max_cup_bars,
      `${cupBars} bars`,
      `${o.min_cup_bars}-${o.max_cup_bars} bars (${o.min_cup_bars / o.bars_per_week}-${o.max_cup_bars / o.bars_per_week} weeks at ${o.bars_per_week} bars a week)`,
      { source: 'Bulkowski: "From 7 to 65 weeks (allow variations)."' },
    ),
    rims_near_same_price: rimDiffPct == null
      ? notChecked(`<= ${o.rim_tolerance_pct}%`, 'The rim prices were not usable numbers.')
      : clause(rimDiffPct <= o.rim_tolerance_pct, `${round(rimDiffPct)}%`,
        `<= ${o.rim_tolerance_pct}% apart`,
        { source: 'concept his ("near the same price level but be flexible"), number OURS' }),
    u_shaped_not_v: baseTimePct == null
      ? notChecked(`>= ${o.min_base_time_pct}%`, 'No usable lows inside the cup.')
      : clause(baseTimePct >= o.min_base_time_pct, `${round(baseTimePct)}% of cup bars`,
        `>= ${o.min_base_time_pct}% of the cup's bars with a low inside its bottom ${o.base_band_frac * 100}%`,
        { source: 'concept his ("U-shaped, not V-shaped"), number OURS — see U_SHAPE_ARITHMETIC',
          reference_points: `a straight-sided V scores ~${U_SHAPE_ARITHMETIC.v_bottom_expected_pct}%, a parabola ~${U_SHAPE_ARITHMETIC.u_bottom_expected_pct}%` }),
    /**
     * A CUP, not a staircase — and the tolerance is the RIM tolerance, not zero.
     *
     * Written with a zero tolerance first, and a constructed textbook cup failed
     * it: one interior bar's high reached 100.64 against a right rim pivot of
     * 100.49, an overshoot of 0.15%. Kernel pivots map a smoothed extremum to the
     * real extreme WITHIN `map_window` bars of it, which is not the same as the
     * global maximum of the whole interior, so a wick a fraction of a percent
     * above the rim is routine and means nothing.
     *
     * Reusing `rim_tolerance_pct` is the coherent choice rather than a second
     * number: the band that decides whether two highs are "the same price level"
     * is the band inside which an interior high is not a distinct peak. What the
     * clause is actually for — a left rim at 100, an interior spike at 130, a
     * right rim at 100, which is an M and not a cup — is untouched by it.
     *
     * Note the direction of the correction: it makes the detector LOOSER and
     * therefore raises its own noise floor. It was found by constructed truth,
     * not by looking at the null.
     */
    cup_contains_no_higher_high: interiorHigh == null
      ? clause(true, 'no interior bars', 'nothing between the rims may exceed them')
      : clause(interiorHigh <= rimHigh * (1 + o.rim_tolerance_pct / 100),
        `interior high ${round(interiorHigh, 4)} vs rim ${round(rimHigh, 4)} `
        + `(${round(rimHigh > 0 ? ((interiorHigh - rimHigh) / rimHigh) * 100 : null)}% over)`,
        `no bar between the rims more than ${o.rim_tolerance_pct}% above the higher rim`,
        { source: 'ours — structural validity, not a Bulkowski guideline; the tolerance is the rim tolerance' }),
    cup_depth_in_range: depthPct == null
      ? notChecked(`${o.min_cup_depth_pct}-${o.max_cup_depth_pct}%`, 'The right rim was not a usable price.')
      : clause(depthPct >= o.min_cup_depth_pct && depthPct <= o.max_cup_depth_pct, `${round(depthPct)}%`,
        `${o.min_cup_depth_pct}-${o.max_cup_depth_pct}% of the right rim`,
        { source: 'ours — he sets no depth bound',
          note: `O'Neil treats cups deeper than about a third as failure-prone; that is reported, not gated.` }),
    handle_present: clause(handleBars >= o.min_handle_bars, `${handleBars} bar(s)`,
      `>= ${o.min_handle_bars} bars (Bulkowski: "1 week minimum with no maximum")`,
      { source: 'Bulkowski. NO maximum is enforced, because he states none.' }),
    handle_in_upper_half: handleRetraceFrac == null
      ? notChecked(`<= ${o.max_handle_retrace_frac * 100}% of the cup depth`, 'The handle had no usable low.')
      : clause(handleRetraceFrac <= o.max_handle_retrace_frac,
        `${round(handleRetraceFrac * 100)}% of cup depth (low ${round(handleLow.price, 4)} vs midpoint ${round(bottom.price + depth / 2, 4)})`,
        `<= ${o.max_handle_retrace_frac * 100}% — the handle must form in the UPPER HALF of the cup`,
        { source: 'Bulkowski: "forming in the upper half of the cup." The half is his.' }),
    handle_is_a_pullback: handleRetraceFrac == null
      ? notChecked(`>= ${o.min_handle_retrace_frac * 100}% of the cup depth`, 'The handle had no usable low.')
      : clause(handleRetraceFrac >= o.min_handle_retrace_frac,
        `${round(handleRetraceFrac * 100)}% of cup depth`,
        `>= ${o.min_handle_retrace_frac * 100}% — below this there is no handle, only bars after the rim`,
        { source: 'ours — he requires a handle and gives it no minimum depth' }),
  };

  const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([k]) => k);

  // ── supporting evidence: never part of the verdict ──
  const priorFrom = Math.max(0, left.index - o.prior_rise_bars);
  const priorLow = lowestLow(bars, priorFrom, left.index).price;
  const priorRisePct = priorLow != null && priorLow > 0 ? ((leftPrice - priorLow) / priorLow) * 100 : null;

  const cupVol = avgVolume(bars, left.index, right.index);
  const handleVol = avgVolume(bars, right.index + 1, endIdx);
  const volRatio = cupVol && handleVol ? handleVol / cupVol : null;

  const breakoutVol = breakoutIdx == null ? null : num(bars[breakoutIdx]?.volume);
  const preBreakVol = breakoutIdx == null ? null : avgVolume(bars, breakoutIdx - o.volume_lookback, breakoutIdx - 1);
  const breakoutVolRatio = breakoutVol && preBreakVol ? breakoutVol / preBreakVol : null;

  const leftLeg = bottom.index - left.index;
  const rightLeg = right.index - bottom.index;

  const supporting = {
    prior_rise_into_cup: priorRisePct == null
      ? notChecked('informational', `No usable low in the ${o.prior_rise_bars} bars before the left rim.`)
      : clause(priorRisePct >= 30, `${round(priorRisePct)}% off the ${o.prior_rise_bars}-bar low`,
        'informational — the 2005 edition used >= 30%, the site does not gate on it at all',
        { source: 'The two Bulkowski sources DISAGREE here; see CUP_CITATIONS.prior_trend.sources_disagree. The '
          + 'site wins, so this is measured and reported and gates nothing. `pass` reflects the BOOK\'s 30% so a '
          + 'reader who wants that behaviour can read it straight off.' }),
    handle_volume_dryup: volRatio == null
      ? notChecked('informational', 'Volume was missing or zero across the cup or the handle.')
      : clause(volRatio < 1, `${round(volRatio, 3)}x the cup average`, 'informational — SUPPORTING ONLY',
        { source: 'ours', why_not_a_gate: 'The synthetic null writes near-flat volume, so a verdict clause on it would be decided by the fixture. See CUP_NOISE_BASELINE.volume_note.' }),
    breakout_volume: breakoutVolRatio == null
      ? notChecked('informational', breakoutIdx == null ? 'No breakout bar yet.' : 'Volume was missing around the breakout.')
      : clause(breakoutVolRatio > 1, `${round(breakoutVolRatio, 2)}x the prior ${o.volume_lookback}-bar average`,
        'informational — SUPPORTING ONLY', { source: 'ours' }),
    leg_symmetry: clause(true,
      `left ${leftLeg} bars, right ${rightLeg} bars (imbalance ${cupBars ? round((Math.abs(leftLeg - rightLeg) / cupBars) * 100) : null}%)`,
      'informational — Bulkowski requires no symmetry, so this is NOT gated',
      { source: 'ours, reported only' }),
  };

  const status = breakoutIdx == null ? 'forming' : 'confirmed';

  return {
    qualifies: failed.length === 0,
    failed,
    checks,
    supporting,
    status,
    left, right,
    left_rim: leftPrice,
    right_rim: rightPrice,
    cup_low: bottom.price,
    cup_low_index: bottom.index,
    depth,
    depth_pct: depthPct,
    cup_bars: cupBars,
    handle_bars: handleBars,
    handle_low: handleLow.price,
    handle_high: handleHigh,
    handle_retrace_frac: handleRetraceFrac,
    base_time_pct: baseTimePct,
    rim_diff_pct: rimDiffPct,
    breakout_index: breakoutIdx,
    end_index: endIdx,
  };
}

/**
 * Detect a cup with handle.
 *
 * Returns a SINGLE result carrying `qualifies` plus every individual clause — the
 * same contract `detectVCP` uses, and for the same reason: which clause failed is
 * the useful output. "A 62-bar cup but the handle retraced 71% of it" is
 * actionable where "no cup" is not.
 *
 * When it qualifies, the object ALSO carries the structural-pattern fields
 * (`pattern`, `status`, `direction`, `target`, `completion_level`, `bars_ago`,
 * `from_time`, `to_time`, `measurements`) so downstream consumers built for
 * `detectPatterns().structural` work unchanged.
 */
export function detectCup(bars, options = {}) {
  const o = { ...CUP_DEFAULTS, ...options };
  const base = {
    pattern: 'cup_with_handle',
    citations: CUP_CITATIONS,
    base_rates: CUP_BASE_RATES,
    noise_floor: CUP_NOISE_BASELINE,
    pivot_lookback: o.lookback,
  };

  const minBars = o.min_cup_bars + o.min_handle_bars;
  if (!Array.isArray(bars) || bars.length < minBars) {
    return {
      ...base, qualifies: false, status: null, reason: 'insufficient_bars',
      note: `A cup is at least ${o.min_cup_bars} bars and its handle at least ${o.min_handle_bars}, so `
        + `${minBars} bars are the floor. Have ${Array.isArray(bars) ? bars.length : 0}.`,
    };
  }

  const pivots = findPivots(bars, { lookback: o.lookback });
  const highs = pivots.filter((p) => p.kind === 'high' && num(p.price) != null && Number.isInteger(p.index));
  if (highs.length < 2) {
    return {
      ...base, qualifies: false, status: null, reason: 'too_few_pivot_highs', pivot_highs_found: highs.length,
      note: `A cup needs two rims, which are two pivot HIGHS. Found ${highs.length} at lookback ${o.lookback}. `
        + 'A monotonic or very short series legitimately has none.',
    };
  }

  /**
   * Every pair of pivot highs whose separation is a legal cup duration. The cup
   * low is the real bar low between them, NOT a pivot — a rounded bottom often
   * has no single pivot at its lowest bar, and taking the pivot instead would
   * measure the depth to whichever wiggle the smoother happened to turn on.
   */
  const slack = Number.isFinite(o.candidate_span_slack) && o.candidate_span_slack >= 1 ? o.candidate_span_slack : 1;
  const spanFloor = Math.max(2, Math.floor(o.min_cup_bars / slack));
  const spanCeil = Math.round(o.max_cup_bars * slack);

  const candidates = [];
  for (let i = 0; i < highs.length - 1; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const span = highs[j].index - highs[i].index;
      if (span < spanFloor || span > spanCeil) continue;
      const c = scoreCandidate(bars, highs[i], highs[j], o);
      if (c) candidates.push(c);
    }
  }

  if (!candidates.length) {
    return {
      ...base, qualifies: false, status: null, reason: 'no_candidate_pair',
      pivot_highs_found: highs.length,
      note: `No pair of pivot highs sits ${spanFloor}-${spanCeil} bars apart with a low between `
        + 'them, so there is no shape to score. That is a normal result.',
    };
  }

  /**
   * Rank: qualifying first, then fewest failed clauses, then the MOST RECENT
   * right rim. Recency last rather than first because a stale cup that qualifies
   * is still a better answer than a live shape that fails four clauses — but
   * between two equally good readings the live one is the one being traded.
   */
  candidates.sort((a, b) => (a.failed.length - b.failed.length)
    || (b.right.index - a.right.index)
    || (b.depth - a.depth));
  const best = candidates[0];

  const lastClose = num(bars[bars.length - 1]?.close);
  const completion = best.right_rim;
  const target = completion + best.depth;
  const targetBulkowski = completion + best.depth * (CUP_BASE_RATES.meeting_target_pct / 100);
  const targetHalf = completion + best.depth / 2;

  const result = {
    ...base,
    qualifies: best.qualifies,
    type: 'continuation',
    direction: 'bullish',
    status: best.qualifies ? best.status : null,
    bars: best.cup_bars + best.handle_bars,
    bars_ago: 0,
    completion_level: round(completion, 4),
    target: round(target, 4),
    target_basis: 'the cup depth (right rim to the lowest valley) projected UP from the right cup lip. '
      + 'That is the standard height projection every other pattern here uses, so the numbers are comparable.',
    target_bulkowski_measure_rule: round(targetBulkowski, 4),
    target_half_height: round(targetHalf, 4),
    target_note: 'THREE projections off ONE construction, because Bulkowski publishes three and they are '
      + `different claims. FULL HEIGHT ${round(target, 4)} is the traditional rule and the one every other `
      + `pattern here uses — reached ~50% of the time in a bull market (2nd ed. p.156). His SITE discounts the `
      + `height by the meeting-target rate instead: ${CUP_BASE_RATES.meeting_target_pct}% of ${round(best.depth, 4)} `
      + `gives ${round(targetBulkowski, 4)}. His BOOK recommends HALF the height, ${round(targetHalf, 4)}, "for a `
      + 'better target" — reached 76% of the time in a bull market, and he still calls that shy of the 80% he '
      + `considers reliable. NONE of them is the ${CUP_BASE_RATES.average_rise_pct}% average rise, which is `
      + 'measured to the ultimate high before a 20% reversal and is not a target at all.',
    measurements: {
      left_rim: round(best.left_rim, 4),
      right_rim: round(best.right_rim, 4),
      cup_low: round(best.cup_low, 4),
      /**
       * ALIASES, on purpose, and the reason is drawing.
       *
       * `drawPatternGeometry`'s structural branch draws a trend line between
       * `peak_1` and `peak_2` — which, for a cup, is exactly the RIM LINE a
       * reader would draw across the two lips. Emitting the aliases gets the cup
       * its correct geometry with no change to assessment_draw.js, which another
       * agent owns this round. They are the same two numbers as `left_rim` and
       * `right_rim` above, named for the consumer rather than for the pattern.
       *
       * Deliberately ABSENT: `trough`, `peak`, `neckline`, `resistance_now`,
       * `support_now`, `pole_pct`. Each of those would route the cup into a
       * different drawing branch or make its break level the cup BOTTOM.
       */
      peak_1: round(best.left_rim, 4),
      peak_2: round(best.right_rim, 4),
      depth: round(best.depth, 4),
      depth_pct: round(best.depth_pct),
      rim_difference_pct: round(best.rim_diff_pct),
      cup_bars: best.cup_bars,
      handle_bars: best.handle_bars,
      handle_low: round(best.handle_low, 4),
      handle_high: round(best.handle_high, 4),
      handle_retrace_pct_of_cup: round(best.handle_retrace_frac == null ? null : best.handle_retrace_frac * 100),
      cup_midpoint: round(best.cup_low + best.depth / 2, 4),
      base_time_pct: round(best.base_time_pct),
      breakout_price: round(completion, 4),
    },
    from_time: bars[best.left.index]?.time ?? null,
    to_time: bars[best.end_index]?.time ?? null,
    checks: best.checks,
    ...(best.failed.length ? { failed_checks: best.failed } : {}),
    supporting: best.supporting,
    candidates_scored: candidates.length,
    pivot_highs_found: highs.length,
    distance_to_breakout_pct: lastClose && lastClose > 0 ? round(((completion - lastClose) / lastClose) * 100) : null,
    definition: 'A rounded U-shaped turn between two rims at roughly one price, followed by a shallow pause '
      + 'in the upper half of the cup. It completes on a CLOSE above the right cup lip.',
    what_it_is_not: 'A cup is a SETUP. Bulkowski ranks it 3 of 39 and that ranking is HIS measurement on 913 '
      + 'perfect trades gross of costs, not a measurement made here and not a forecast. Nothing in this module '
      + 'has been forward-tested.',
    horizon_warning: 'A cup breakout is a CONTINUATION bet. Below ~21 trading days the documented effect is '
      + 'REVERSAL, so this belongs in the monthly execution tier and not the weekly one. Run horizon_prior.',
  };

  return result;
}

/**
 * The roster adapter: `[]` or `[pattern]`, in the shape `detectPatterns` collects.
 *
 * `lookback` is the CALLER's detector density and is mapped through
 * `CUP_LOOKBACK_OFFSET` — see the note on that constant for why a cup needs
 * sparse pivots and why the mapping must still vary with the sweep.
 */
export function cupPatterns(bars, { lookback = 5, ...rest } = {}) {
  const res = detectCup(bars, { ...rest, lookback: lookback + CUP_LOOKBACK_OFFSET });
  if (!res.qualifies) return [];
  return [{
    pattern: 'cup_with_handle',
    type: res.type,
    direction: res.direction,
    status: res.status,
    bars: res.bars,
    bars_ago: 0,
    completion_level: res.completion_level,
    target: res.target,
    target_basis: res.target_basis,
    target_bulkowski_measure_rule: res.target_bulkowski_measure_rule,
    target_half_height: res.target_half_height,
    target_note: res.target_note,
    measurements: res.measurements,
    from_time: res.from_time,
    to_time: res.to_time,
    checks: res.checks,
    supporting: res.supporting,
    note: 'Completes on a CLOSE above the right cup lip. Target is the cup depth projected from it; '
      + 'target_bulkowski_measure_rule is his own discounted version of the same construction.',
    base_rate_warning: `Bulkowski ranks the cup with handle ${CUP_BASE_RATES.rank} with a `
      + `${CUP_BASE_RATES.break_even_failure_pct}% break-even failure rate over ${CUP_BASE_RATES.sample} — his `
      + 'best-ranked pattern this toolchain can detect. Those are PERFECT trades gross of costs, measured to '
      + 'the ultimate high. This detector has no forward test of its own.',
  }];
}
