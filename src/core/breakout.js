/**
 * Breakout quality — scoring a break of a level against measurable criteria.
 *
 * Every source says to trade breakouts and then describes the good ones with
 * adjectives: a "strong" candle, "increased" volume, an "obvious" level. Those
 * words are where judgement quietly replaces evidence, and where the same chart
 * gets read two different ways on two different days.
 *
 * This scores five things, each of which is a number:
 *
 *   1. momentum    — is the breakout body far larger than the recent average?
 *   2. close       — did it CLOSE beyond the level, and by how much?
 *   3. volume      — was volume above its recent average?
 *   4. level       — how many separate times had that level been tested?
 *   5. follow      — did the next bar continue, or close back inside?
 *
 * The same five, inverted, are the signs of a FALSE breakout — so one function
 * answers both questions rather than two that could disagree.
 *
 * Beside them, and deliberately NOT a sixth check, is the THROWBACK: did price
 * come back to the breakout level afterwards, and what happened when it did.
 * Check 5 already answers a one-bar version of that question, so the two are
 * derived from the same reading rather than computed twice — see
 * `readThrowback` and the note above `closedBackInside`. It is reported as a
 * status and a base rate, never as a score, because Bulkowski measures a
 * throwback as something 58% of breakouts do: common behaviour is a poor
 * discriminator, and folding it into `score` would have said otherwise.
 *
 * Pure: bars and a level in, a verdict out.
 */
import { countTests } from './structure.js';

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

const SECONDS_PER_DAY = 86400;

/**
 * How close to the level counts as "back at the level", as a percentage of it.
 *
 * Bulkowski's definition names no tolerance: price has to "zoom up, curl around
 * and return to, OR COME CLOSE TO, the breakout price"
 * (thepatternsite.com/throwbacks.html). Two of his own numbers bound what
 * "close" can mean. He measures the launch away from the level at a median 6%
 * in 5 days, and the whole round trip at 10 days
 * (thepatternsite.com/TrickThrow.html) — so a tolerance anywhere near 6% would
 * score the launch itself as a return and every breakout would "throw back"
 * instantly.
 *
 * 0.5% is the band `scoreBreakout` ALREADY uses to decide whether a bar tested
 * the level (`level * 0.005`, in the level_was_established check). Reusing it
 * is the point: "at the level" now means one thing in this module instead of
 * two, and a throwback touch is the same event the test count would have
 * counted. It is an eighth of his median launch, so the two legs stay
 * distinguishable.
 */
export const THROWBACK_TOLERANCE_PCT = 0.5;

/**
 * Bulkowski's throwback and pullback statistics, read from thepatternsite.com
 * on 2026-07-30 and quoted rather than paraphrased.
 *
 * A THROWBACK is the return to the breakout price after an UPWARD breakout; a
 * PULLBACK is the same behaviour after a DOWNWARD one. They are his two words
 * for one shape, he measures them separately, and the numbers differ — so both
 * are carried and the reading uses whichever matches the direction.
 *
 * ── Why carry them at all ──
 *
 * "Did it come back to the level?" is a question this module could already
 * almost answer: check 5 answers it for exactly one bar. Extending it to
 * Bulkowski's 30-day window is only worth doing beside his base rate, because
 * 58% is common enough that a throwback on its own is evidence of nothing.
 * The interesting halves are the CONDITIONAL ones — 70% after an above-average
 * volume breakout, and the gap between the arm where price held above the
 * breakout price and the arm where it did not.
 *
 * ── What these numbers are NOT ──
 *
 * They are population rates over 10,305 upward and 8,765 downward chart-pattern
 * breakouts since 2000. They are not a probability for the breakout on your
 * screen, and no random-walk null is attached to any of them — not by
 * Bulkowski, and not here. `scripts/detector-noise.js` has no throwback probe,
 * so the rate at which a series with no trend in it returns to its own breakout
 * level is UNMEASURED in this repo, and the module says so in every answer.
 * Compare that with what IS measured next door: a third of random walks break
 * their own prior high (BREAKOUT_NOISE_BASELINE). Read the status as a
 * description of what price did; read the percentages as a reason not to be
 * surprised by it.
 *
 * The performance arms are also his usual "perfect trades, gross of costs",
 * measured to an ultimate high before a 20% reversal — the same upper-bound
 * caveat that applies to every average_move_pct in STRUCTURAL_STATS.
 */
export const THROWBACK_STATS = {
  source: 'Bulkowski, thepatternsite.com, read 2026-07-30',
  window_days: 30,
  window_quote: 'By convention, a throwback occurs within 30 calendar days after the breakout.',
  window_url: 'https://thepatternsite.com/throwbacks.html',
  measured_on: 'daily bars',
  better_without_pct: 97,
  better_without_quote: 'Yes: 97% of the time chart patterns with upward breakouts perform better post breakout without a throwback.',
  better_without_url: 'https://thepatternsite.com/studystudy.html',
  noise_floor: null,
  noise_floor_note: 'UNMEASURED. scripts/detector-noise.js carries no throwback probe, so how often a random '
    + 'walk returns to its own breakout level within 30 days is unknown here. Bulkowski publishes no null either.',
  up: {
    term: 'throwback',
    rate_pct: 58,
    sample: 10305,
    rate_quote: 'Since year 2000, 58% of 10,305 chart patterns with upward breakouts had throwbacks.',
    high_volume_rate_pct: 70,
    high_volume_quote: 'A high volume (above the 30-day average) breakout throws back 70% of the time, on average.',
    days_before_turn: 6,
    round_trip_days: 10,
    timing_quote: 'Price climbs for 6 days after the breakout, on average, before beginning the return journey. '
      + 'It takes an average of 10 days, total, for price to complete the return trip back to the breakout.',
    held_move_pct: 40,
    held_sample: 400,
    through_move_pct: 29,
    through_sample: 2767,
    arms_quote: 'When price remained equal to or above the breakout price, the rise averaged 40% (400 samples '
      + 'qualified). When price dropped below the breakout, the resulting rise averaged just 29% (2,767 samples).',
    url: 'https://thepatternsite.com/throwbacks.html',
  },
  down: {
    term: 'pullback',
    rate_pct: 58,
    sample: 8765,
    rate_quote: 'Since year 2000, 58% of 8,765 chart patterns with downward breakouts had pullbacks.',
    high_volume_rate_pct: 66,
    high_volume_quote: 'A high volume (above the 30-day average) breakout pulls back 66% of the time, on average.',
    days_before_turn: 6,
    round_trip_days: 11,
    timing_quote: 'Price drops for 6 days after the breakout, on average, before beginning the return journey. '
      + 'It takes an average of 11 days, total, for price to complete the return trip back to the breakout.',
    held_move_pct: 25,
    held_sample: 323,
    through_move_pct: 20,
    through_sample: 2415,
    arms_quote: 'When price remained equal to or below the breakout price, the drop averaged 25% (323 samples '
      + 'qualified). When price climbed above the breakout, the resulting drop averaged just 20% (2,415 samples).',
    url: 'https://www.thepatternsite.com/pullbacks.html',
  },
};

/**
 * Did price come back to the breakout level, and what happened when it did?
 *
 * Four statuses, and the boundaries between them are all numbers:
 *
 *   none_yet        no bar since the breakout has reached back into the level
 *                   zone. Read `window.open` before reading anything into it —
 *                   "not yet" and "did not, within his window" are different
 *                   answers and this status covers both.
 *   in_progress     price is back at the level and has resolved neither way:
 *                   it has not closed back through the level, and it has not
 *                   closed clear of the zone.
 *   completed_held  after the touch, price closed clear of the zone without
 *                   ever closing back through the level. Bulkowski's arm where
 *                   price "remained equal to or above the breakout price".
 *   completed_failed  after the touch, price closed back through the level.
 *                   His arm where price "dropped below the breakout".
 *
 * The zone is +/- THROWBACK_TOLERANCE_PCT of the level, the same band the
 * level_was_established check uses. The window is his 30 CALENDAR days,
 * measured off the bar timestamps when they are usable and falling back to a
 * bar count — which is stated in `window.basis` rather than hidden, because 30
 * bars and 30 days are the same thing only on a chart nobody trades.
 *
 * `volume_ratio` is passed IN rather than recomputed: `scoreBreakout` already
 * measures it for check 3, and a second copy would be free to disagree with
 * the first. Absent, it reports `elevated: null` — unknown, which is not the
 * same claim as "not elevated".
 *
 * Descriptive. Nothing here forecasts anything, and every percentage quoted is
 * one Bulkowski published, with its URL.
 */
export function readThrowback(bars, {
  index,
  level,
  direction,
  tolerance_pct = THROWBACK_TOLERANCE_PCT,
  window_days = THROWBACK_STATS.window_days,
  volume_ratio = null,
  volume_lookback = null,
} = {}) {
  if (!Array.isArray(bars) || !bars.length) throw new Error('readThrowback needs the bar array.');
  if (!Number.isInteger(index) || index < 0 || index >= bars.length) {
    throw new Error('index must be the position of the breakout bar within bars.');
  }
  if (!Number.isFinite(level)) throw new Error('level must be a number.');
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'up' && dir !== 'down') throw new Error('direction must be "up" or "down".');

  const tol = Number.isFinite(tolerance_pct) && tolerance_pct > 0 ? tolerance_pct : THROWBACK_TOLERANCE_PCT;
  const win = Number.isFinite(window_days) && window_days > 0 ? window_days : THROWBACK_STATS.window_days;
  const stats = dir === 'up' ? THROWBACK_STATS.up : THROWBACK_STATS.down;
  const band = Math.abs(level) * (tol / 100);
  const up = dir === 'up';

  // Calendar days need timestamps. `normalizeBars` writes null rather than
  // dropping a bar with no time, so this checks rather than assumes — and says
  // which basis it used either way.
  const t0 = Number(bars[index]?.time);
  const tLast = Number(bars[bars.length - 1]?.time);
  const dated = Number.isFinite(t0) && t0 > 0 && Number.isFinite(tLast) && tLast > t0;
  const daysAt = (i) => {
    if (!dated) return null;
    const ti = Number(bars[i]?.time);
    return Number.isFinite(ti) ? (ti - t0) / SECONDS_PER_DAY : null;
  };

  // Bars after the breakout, bounded by the window.
  //
  // The bar IMMEDIATELY after the breakout is always in, whatever the calendar
  // says. On a monthly chart one bar spans more than 30 days, and excluding it
  // would let this reading contradict check 5 — which looks at exactly that bar
  // and calls a close back inside a failure. The two must not be able to
  // disagree, so the window cannot be allowed to hide the bar check 5 reads.
  const after = [];
  for (let i = index + 1; i < bars.length; i++) {
    if (i !== index + 1) {
      const d = dated ? daysAt(i) : (i - index);
      if (d == null || d > win) break;
    }
    after.push(i);
  }

  const closeAt = (i) => Number(bars[i]?.close);
  const reached = (i) => {
    const extreme = up ? Number(bars[i]?.low) : Number(bars[i]?.high);
    if (!Number.isFinite(extreme)) return false;
    return up ? extreme <= level + band : extreme >= level - band;
  };
  const sliced = (i) => {
    const c = closeAt(i);
    return Number.isFinite(c) && (up ? c < level : c > level);
  };
  const resumed = (i) => {
    const c = closeAt(i);
    return Number.isFinite(c) && (up ? c > level + band : c < level - band);
  };

  let touch = -1;
  for (const i of after) { if (reached(i)) { touch = i; break; } }

  // Resolution is scanned from the touch bar INCLUSIVE: a bar that dips into
  // the zone and closes clear of it again is a completed throwback in one bar.
  // Slicing is tested first, and the two tests are mutually exclusive anyway
  // (a close cannot be both below the level and above the top of the zone).
  let resolved = -1;
  let held = null;
  if (touch !== -1) {
    for (const i of after) {
      if (i < touch) continue;
      if (sliced(i)) { resolved = i; held = false; break; }
      if (resumed(i)) { resolved = i; held = true; break; }
    }
  }

  let status;
  if (touch === -1) status = 'none_yet';
  else if (resolved === -1) status = 'in_progress';
  else status = held ? 'completed_held' : 'completed_failed';

  const lastIdx = bars.length - 1;
  const daysElapsed = daysAt(lastIdx);
  const barsSince = lastIdx - index;
  const windowOpen = dated
    ? (daysElapsed == null ? null : daysElapsed <= win)
    : barsSince <= win;

  const ratio = Number.isFinite(volume_ratio) ? volume_ratio : null;
  const lookbackLabel = Number.isFinite(volume_lookback) ? `${volume_lookback}-bar` : 'recent';
  const breakout_volume_context = {
    // Bulkowski's cut is "above the 30-day average", so the threshold here is
    // simply above average. The module's own volume CHECK uses a stricter 1.2x,
    // which is a different question about the same number — both are stated so
    // one cannot be mistaken for the other being broken.
    elevated: ratio == null ? null : ratio > 1,
    ratio: round(ratio, 2),
    threshold: `above the ${lookbackLabel} average volume (ratio > 1). Bulkowski's cut is the 30-day average; `
      + "this module's volume CHECK is stricter at 1.2x, so the check can fail while this reads elevated.",
    detail: ratio == null
      ? 'No usable volume on the breakout bar or in the lookback — UNKNOWN, which is not the same as "not elevated".'
      : `Breakout-bar volume is ${round(ratio, 2)}x the ${lookbackLabel} average.`,
    base_rate: {
      all_breakouts_pct: stats.rate_pct,
      high_volume_breakouts_pct: stats.high_volume_rate_pct,
      quote: stats.high_volume_quote,
      sample: stats.sample,
      url: stats.url,
      note: `A ${stats.term} follows ${stats.rate_pct}% of breakouts in his sample and `
        + `${stats.high_volume_rate_pct}% of the above-average-volume ones. That is a population rate over `
        + `${stats.sample} chart-pattern breakouts, not a probability for this one, and it has no noise floor `
        + 'attached — see THROWBACK_STATS.noise_floor_note.',
    },
  };

  const heldDetail = held === true
    ? `Resumed: price returned to the level and then closed clear of the zone without closing back through ${round(level)}.`
    : held === false
      ? `Sliced through: price returned to the level and closed back through ${round(level)}.`
      : `No ${stats.term} has completed, so there is nothing to say about whether the level held.`;

  const pctNo = round(100 - stats.rate_pct, 1);
  let summary;
  if (status === 'none_yet' && windowOpen === false) {
    summary = `Price did not return to ${round(level)} within Bulkowski's ${win}-day window. `
      + `${pctNo}% of his ${stats.sample} breakouts did the same.`;
  } else if (status === 'none_yet') {
    summary = `Price has not returned to ${round(level)} in the ${barsSince} bar(s) since the breakout, and `
      + `the ${win}-day window is still open. That is "not yet", not "did not".`;
  } else if (status === 'in_progress') {
    summary = `Price is back in the level zone and has resolved neither way — it has not closed back through `
      + `${round(level)}, and it has not closed clear of the zone.`;
  } else {
    summary = `${heldDetail} His two arms: ${stats.held_move_pct}% average move when price stayed on the breakout `
      + `side (n=${stats.held_sample}) against ${stats.through_move_pct}% when it did not (n=${stats.through_sample}).`;
  }

  return {
    kind: stats.term,
    status,
    held,
    held_detail: heldDetail,
    bars_since_breakout: barsSince,
    days_since_breakout: round(daysElapsed, 1),
    bars_to_touch: touch === -1 ? null : touch - index,
    days_to_touch: touch === -1 ? null : round(daysAt(touch), 1),
    bars_to_resolution: resolved === -1 ? null : resolved - index,
    days_to_resolution: resolved === -1 ? null : round(daysAt(resolved), 1),
    tolerance_pct: tol,
    tolerance_price: round(band),
    level_zone: [round(level - band), round(level + band)],
    tolerance_basis: `Within ${tol}% of the level (+/- ${round(band)}). Bulkowski publishes no numeric tolerance — `
      + 'he says price returns "to, or comes close to, the breakout price" — but he measures the launch away from '
      + 'it at a median 6% in 5 days, so the tolerance has to be a small fraction of that or the launch itself '
      + 'reads as a return. This is the same 0.5% band the level_was_established check uses.',
    window: {
      days: win,
      open: windowOpen,
      basis: dated
        ? `${win} calendar days from the breakout bar's timestamp`
        : `${win} BARS — the bars carry no usable timestamps, so calendar days could not be measured. `
          + 'Bulkowski\'s convention is 30 calendar days on daily bars.',
      bars_considered: after.length,
      days_elapsed: round(daysElapsed, 1),
      quote: THROWBACK_STATS.window_quote,
    },
    breakout_volume_context,
    base_rate: {
      rate_pct: stats.rate_pct,
      sample: stats.sample,
      rate_quote: stats.rate_quote,
      arms_quote: stats.arms_quote,
      timing_quote: stats.timing_quote,
      better_without_pct: THROWBACK_STATS.better_without_pct,
      better_without_quote: THROWBACK_STATS.better_without_quote,
      urls: [stats.url, THROWBACK_STATS.better_without_url],
      measured_on: THROWBACK_STATS.measured_on,
      noise_floor: THROWBACK_STATS.noise_floor,
      noise_floor_note: THROWBACK_STATS.noise_floor_note,
    },
    summary,
    note: `A ${stats.term} is what ${stats.rate_pct}% of his breakouts do, so its presence discriminates almost `
      + 'nothing on its own. What his numbers separate is the two ARMS once one happens, and those are averages '
      + 'over perfect trades gross of costs. This status describes what price did; it is not a forecast, and no '
      + 'probability here was invented — every percentage is one he published, with its URL.',
  };
}

/**
 * Score the most recent break of `level`.
 *
 * `direction` is which way the break is meant to go: "up" through resistance
 * or "down" through support.
 */
export function scoreBreakout(bars, {
  level,
  direction,
  lookback = 20,
  min_close_pct = 0.25,
  throwback_tolerance_pct = THROWBACK_TOLERANCE_PCT,
  throwback_window_days = THROWBACK_STATS.window_days,
} = {}) {
  if (!Array.isArray(bars) || bars.length < lookback + 2) {
    throw new Error(`Need at least ${lookback + 2} bars to score a breakout; got ${bars?.length ?? 0}.`);
  }
  if (!Number.isFinite(level)) throw new Error('level must be a number.');
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'up' && dir !== 'down') throw new Error('direction must be "up" or "down".');

  // The breakout bar is the most recent bar that CLOSED beyond the level while
  // the one before it had not. A level price has been beyond for ten bars is
  // not breaking now.
  let idx = -1;
  for (let i = bars.length - 1; i > 0; i--) {
    const now = dir === 'up' ? bars[i].close > level : bars[i].close < level;
    const before = dir === 'up' ? bars[i - 1].close > level : bars[i - 1].close < level;
    if (now && !before) { idx = i; break; }
  }
  if (idx === -1) {
    return {
      broken: false,
      note: `No bar has closed ${dir === 'up' ? 'above' : 'below'} ${level} in the loaded range. Price may have traded through it intrabar without closing beyond it — which is exactly what a failed breakout looks like.`,
    };
  }

  const b = bars[idx];
  const prior = bars.slice(Math.max(0, idx - lookback), idx);
  const body = Math.abs(b.close - b.open);
  const avgBody = prior.reduce((s, x) => s + Math.abs(x.close - x.open), 0) / prior.length;
  const avgVol = prior.reduce((s, x) => s + (Number(x.volume) || 0), 0) / prior.length;

  // 1. momentum
  //
  // A null ratio means UNMEASURED, and `pass: null` is how this array already
  // says that — follow_through has used it since the module was written. It
  // used to collapse to `false`, so a bar with nothing to compare against
  // scored a hard FAIL whose own detail said "no prior bodies to compare".
  // The verdict is unaffected: a null and a false both contribute nothing to
  // `passed`, so only the denominator in `score` moves, which is the point.
  const bodyRatio = avgBody > 0 ? body / avgBody : null;
  const momentumOk = bodyRatio == null ? null : bodyRatio >= 1.5;

  // 2. close beyond the level, measured as a percentage of price. A close that
  // only just clears the level is the classic weak break.
  const closeBeyondPct = ((dir === 'up' ? b.close - level : level - b.close) / level) * 100;
  const closeOk = closeBeyondPct >= min_close_pct;

  // A long wick beyond the level with the close back near it is the signature
  // of a rejected break, so it is measured separately from the close.
  const wickBeyond = dir === 'up' ? b.high - Math.max(b.open, b.close) : Math.min(b.open, b.close) - b.low;
  const rejectionWick = body > 0 ? wickBeyond / body : null;

  // 3. volume
  //
  // `b.volume == null` is checked BEFORE Number(), because Number(null) is 0
  // and 0 is finite: a bar with no volume field was scoring a hard FAIL on this
  // check — "zero volume, definitely not elevated" — instead of leaving it
  // unscored. `normalizeBars` writes null for a missing volume, so this was
  // live, not hypothetical. Unknown is not a failure, the same principle as the
  // liquidity constraint reporting NOT CHECKED.
  const vol = b.volume == null ? NaN : Number(b.volume);
  const volRatio = avgVol > 0 && Number.isFinite(vol) ? vol / avgVol : null;
  const volumeOk = volRatio == null ? null : volRatio >= 1.2;   // unknown, not failed — see check 1

  // 4. how well-established the level was, BEFORE the break
  const band = level * 0.005;
  const t = countTests(bars.slice(0, idx), level - band, level + band);
  const levelOk = t.tests >= 2;

  // 5. follow-through on the next bar, if there is one
  const next = bars[idx + 1] || null;
  const followOk = next
    ? (dir === 'up' ? next.close > b.close : next.close < b.close)
    : null;

  // The throwback: the same "did it come back?" question over Bulkowski's
  // 30-day window instead of one bar. Volume comes from check 3 rather than
  // being measured again.
  const throwback = readThrowback(bars, {
    index: idx,
    level,
    direction: dir,
    tolerance_pct: throwback_tolerance_pct,
    window_days: throwback_window_days,
    volume_ratio: volRatio,
    volume_lookback: lookback,
  });

  // An immediate reclaim IS a throwback that completed on the first bar and
  // sliced through — the same event at the shortest possible horizon. So it is
  // DERIVED from the throwback rather than measured a second time: two
  // expressions for one fact are two expressions that can drift apart, and this
  // pair drives `verdict: "failed"`, which other layers read.
  //
  // The two are equivalent by construction. `next.close < level` (for an up
  // break) forces `next.low < level`, so the touch lands on bar idx+1, and the
  // resolution scan starts there and tests slicing first. `readThrowback`
  // always keeps bar idx+1 inside its window for exactly this reason.
  // tests/breakout_throwback.test.js checks the equivalence over 600 generated
  // series rather than trusting the argument.
  const closedBackInside = next
    ? (throwback.held === false && throwback.bars_to_resolution === 1)
    : null;

  const checks = [
    { name: 'momentum', pass: momentumOk, detail: bodyRatio == null ? 'no prior bodies to compare' : `breakout body is ${round(bodyRatio, 2)}x the ${lookback}-bar average`, },
    { name: 'close_beyond_level', pass: closeOk, detail: `closed ${round(closeBeyondPct, 2)}% beyond the level (want >= ${min_close_pct}%)` },
    { name: 'volume', pass: volumeOk, detail: volRatio == null ? 'no volume data' : `${round(volRatio, 2)}x the ${lookback}-bar average volume` },
    { name: 'level_was_established', pass: levelOk, detail: `${t.tests} separate test(s) of this level before the break` },
    { name: 'follow_through', pass: followOk, detail: next == null ? 'the breakout bar is the last bar — no follow-through yet' : (followOk ? 'next bar continued' : 'next bar did not continue') },
  ];

  const scored = checks.filter((c) => c.pass !== null);
  const passed = scored.filter((c) => c.pass).length;
  const unknown = checks.length - scored.length;

  let verdict;
  if (closedBackInside) verdict = 'failed';
  else if (passed >= 4) verdict = 'strong';
  else if (passed === 3) verdict = 'mixed';
  else verdict = 'weak';

  return {
    broken: true,
    verdict,
    score: `${passed} of ${scored.length}`,
    ...(unknown ? { unscored: unknown } : {}),
    direction: dir,
    level: round(level),
    breakout_bar: { time: b.time, index: idx, open: round(b.open), high: round(b.high), low: round(b.low), close: round(b.close), volume: b.volume ?? null },
    bars_since: bars.length - 1 - idx,
    checks,
    throwback,
    ...(rejectionWick != null && rejectionWick >= 1
      ? { rejection_wick: `The wick beyond the level is ${round(rejectionWick, 2)}x the body — price went through and was pushed back. That is the shape of a rejected break even when the close held.` }
      : {}),
    ...(closedBackInside
      ? { failed_reason: 'The next bar closed back inside the level. A break that is immediately reclaimed is a failed breakout, and those are frequently traded in the opposite direction.' }
      : {}),
    note: 'Each check is a measurement, not an opinion. A "strong" verdict is not a prediction — it means the break had the characteristics that usually accompany one that holds.',
    throwback_note: 'The verdict is deliberately NOT downgraded by a throwback that completes later than the next '
      + `bar. "failed" means immediately reclaimed; a ${throwback.kind} that slices through on bar 5 is Bulkowski's `
      + 'lower-performing ARM, which he reports as a smaller average move, not as a failure. Read `throwback.status` '
      + 'for that, and `verdict` for the reclaim.',
  };
}

/**
 * Is a level getting weaker as price approaches it?
 *
 * The insight this encodes: **lower highs approaching support** means each
 * bounce is failing earlier, and the level is likely to break. **Higher lows
 * approaching resistance** is the same thing upside down. It is also, read as
 * a shape, exactly what a descending or ascending triangle is — which is why
 * those patterns work.
 *
 * Reported as pressure ON the level, not as a prediction.
 */
export function approachPressure(bars, { level, side, lookback = 40, swing_lookback = 3 } = {}) {
  if (!Number.isFinite(level)) throw new Error('level must be a number.');
  const s = String(side || '').toLowerCase();
  if (s !== 'support' && s !== 'resistance') throw new Error('side must be "support" or "resistance".');

  const window = bars.slice(-lookback);
  if (window.length < swing_lookback * 2 + 3) {
    return { pressure: 'unknown', note: 'Not enough bars in the window to read the approach.' };
  }

  // Pivots of the kind that matters: for support we watch the HIGHS between
  // touches, for resistance the LOWS.
  const pivots = [];
  for (let i = swing_lookback; i < window.length - swing_lookback; i++) {
    const w = window.slice(i - swing_lookback, i + swing_lookback + 1);
    if (s === 'support' && window[i].high === Math.max(...w.map((x) => x.high))) {
      pivots.push({ index: i, price: window[i].high });
    }
    if (s === 'resistance' && window[i].low === Math.min(...w.map((x) => x.low))) {
      pivots.push({ index: i, price: window[i].low });
    }
  }

  if (pivots.length < 2) {
    return { pressure: 'unknown', pivots: pivots.length, note: 'Fewer than two intervening pivots — nothing to compare.' };
  }

  const recent = pivots.slice(-3);
  let weakening = true;
  for (let i = 1; i < recent.length; i++) {
    const lower = recent[i].price < recent[i - 1].price;
    if (s === 'support' ? !lower : lower) { weakening = false; break; }
  }

  return {
    pressure: weakening ? 'building' : 'not building',
    side: s,
    level: round(level),
    pivots: recent.map((p) => round(p.price)),
    interpretation: weakening
      ? (s === 'support'
        ? 'Lower highs into support: each bounce is failing earlier, so sellers are pressing. The level is more likely to break than to hold. Read as a shape, this is a descending triangle.'
        : 'Higher lows into resistance: each pullback is holding higher, so buyers are pressing. The level is more likely to break than to hold. Read as a shape, this is an ascending triangle.')
      : `The intervening pivots are not ${s === 'support' ? 'falling' : 'rising'}, so there is no build-up of pressure on this level from the approach.`,
    note: 'This describes pressure on the level, not a forecast. Levels break and hold for reasons price action cannot see.',
  };
}

/**
 * Breakouts of a prior high on data with no trend in it.
 *
 * Measured by scripts/detector-noise.js over 200 random walks of 200 bars,
 * taking the highest high of the first 150 bars as the level:
 *
 *   any close beyond the level        32.5% of walks
 *   passing 3 or more of the checks    17.5%
 *
 * A third of random walks break their own prior high, and half of those breaks
 * pass most of the quality checks. The checks are doing real work — they halve
 * the rate — but a break that passes them is still something noise produces
 * about one time in six.
 */
export const BREAKOUT_NOISE_BASELINE = {
  measured: true,
  script: 'scripts/detector-noise.js',
  walks: 200,
  bars_per_walk: 200,
  any_break_pct: 32.5,
  passing_3_of_5_checks_pct: 17.5,
  note: 'Noise breaks its own prior high on a third of walks, and 17.5% of walks produce a break that '
    + 'passes 3+ checks. The checks halve the rate rather than eliminating it.',
};
