/**
 * The forward question a report has to answer: at what price would you act?
 *
 * Every other tool here describes what has already happened. This one turns that
 * description into a CONDITIONAL — a trigger price, the event required at it, a
 * stop, and the price that ends the idea — for both directions, so the bear case
 * gets a number instead of a caveat.
 *
 * It composes existing measurements and invents nothing. Triggers come from a
 * forming pattern's own `completion_level`, a swing extreme, or a level that
 * already exists. If none of those is available on a side, that side returns null
 * with a reason rather than a rounded guess.
 *
 * ── The three things it refuses to do ──
 *
 * 1. Round a trigger to a pretty number. "A daily close above 15.37" is checkable;
 *    "around 15.40" is not.
 * 2. Place a stop inside the noise. A stop closer than 1x ATR is hit by ordinary
 *    bar range rather than by being wrong, so it widens to the next structural
 *    level and says that it did.
 * 3. Present a trigger as reachable when it is not. If a catalyst lands before the
 *    trigger can plausibly be hit, that is reported — a breakout entry four
 *    sessions before earnings is a position held into the report.
 *
 * All pure.
 */

/** Livermore: more than this far above the trigger and the edge is gone. */
export const CHASE_PCT = 10;
/** A stop tighter than this many ATRs is inside ordinary bar range. */
export const MIN_STOP_ATR = 1;

const pct = (from, to) => ((to - from) / from) * 100;
const r2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : null);

/**
 * Build one side of the hypothesis.
 *
 * `dir` is 1 for long, -1 for short. Everything below is written once and mirrored
 * by the sign, because two near-identical blocks is how the short case ends up
 * quietly wrong.
 */
function side(dir, {
  price, atr, patterns, levels, swingHigh, swingLow, holdingDays, daysToCatalyst,
}) {
  const isLong = dir === 1;
  const beyond = (p) => (isLong ? p > price : p < price);
  const sortOut = (a, b) => (isLong ? a - b : b - a);

  // ── trigger ──────────────────────────────────────────────────────────────
  const wantDir = isLong ? 'bullish' : 'bearish';
  const forming = patterns
    .filter((p) => p.status === 'forming' && p.direction === wantDir
      && Number.isFinite(p.completion_level) && beyond(p.completion_level))
    .sort((a, b) => sortOut(a.completion_level, b.completion_level));

  const swing = isLong ? swingHigh : swingLow;
  const levelsBeyond = levels
    .filter((l) => Number.isFinite(l.price) && beyond(l.price))
    .sort((a, b) => sortOut(a.price, b.price));

  let trigger = null; let triggerBasis = null;
  if (forming.length) {
    trigger = forming[0].completion_level;
    triggerBasis = `${forming[0].pattern} completes — it is FORMING, so this is the level that would `
      + 'confirm it, not a signal now';
  } else if (Number.isFinite(swing) && beyond(swing)) {
    trigger = swing;
    triggerBasis = `a break of the last confirmed swing ${isLong ? 'high' : 'low'}`;
  } else if (levelsBeyond.length) {
    trigger = levelsBeyond[0].price;
    triggerBasis = `the nearest level ${isLong ? 'above' : 'below'} price — no forming pattern and no `
      + 'swing extreme on this side, so this is the weakest of the three bases';
  } else {
    return {
      available: false,
      why: `Nothing to trigger on ${isLong ? 'above' : 'below'} price: no forming ${wantDir} pattern, `
        + `no swing ${isLong ? 'high' : 'low'}, and no level. A hypothesis would have to invent a price.`,
    };
  }

  // ── stop ─────────────────────────────────────────────────────────────────
  // Structural first: the nearest level on the far side of the trigger.
  const behind = levels
    .filter((l) => Number.isFinite(l.price) && (isLong ? l.price < trigger : l.price > trigger))
    .sort((a, b) => sortOut(b.price, a.price));

  let stop = null; let stopBasis = null; let widened = null;
  const minGap = Number.isFinite(atr) ? atr * MIN_STOP_ATR : 0;
  for (const l of behind) {
    if (Math.abs(trigger - l.price) >= minGap) {
      stop = l.price;
      stopBasis = `below the ${l.price} level${l.reason ? ` (${l.reason})` : ''}`;
      break;
    }
    if (!widened) widened = l.price;   // remember the one that was too tight
  }
  if (stop == null) {
    if (!Number.isFinite(atr)) {
      return { available: false, why: 'No ATR, so a stop cannot be checked against ordinary bar range.' };
    }
    stop = isLong ? trigger - minGap : trigger + minGap;
    stopBasis = `no level sat at least ${MIN_STOP_ATR}x ATR from the trigger, so the stop is placed `
      + `${MIN_STOP_ATR}x ATR away (${r2(minGap)}) rather than inside the noise`;
  }

  const risk = Math.abs(trigger - stop);
  const stopAtr = Number.isFinite(atr) && atr > 0 ? risk / atr : null;

  // ── invalidation: the OTHER side's forming pattern, or the opposite swing ──
  const against = patterns
    .filter((p) => p.status === 'forming' && p.direction !== wantDir
      && Number.isFinite(p.completion_level) && !beyond(p.completion_level))
    .sort((a, b) => sortOut(b.completion_level, a.completion_level));
  const invalidation = against.length
    ? { price: against[0].completion_level, basis: `${against[0].pattern} completes instead` }
    : (Number.isFinite(isLong ? swingLow : swingHigh)
      ? { price: isLong ? swingLow : swingHigh, basis: `the last swing ${isLong ? 'low' : 'high'} gives way` }
      : null);

  // ── targets: levels beyond the trigger ───────────────────────────────────
  const targets = levels
    .filter((l) => Number.isFinite(l.price) && (isLong ? l.price > trigger : l.price < trigger))
    .sort((a, b) => sortOut(a.price, b.price))
    .slice(0, 3)
    .map((l) => ({
      price: l.price,
      rr: risk > 0 ? r2(Math.abs(l.price - trigger) / risk) : null,
      ...(l.reason ? { reason: l.reason } : {}),
    }));

  const distancePct = pct(price, trigger);
  const chasing = Math.abs(distancePct) > CHASE_PCT;

  return {
    available: true,
    direction: isLong ? 'long' : 'short',
    trigger: r2(trigger),
    trigger_event: `a daily CLOSE ${isLong ? 'above' : 'below'} ${r2(trigger)}`,
    trigger_basis: triggerBasis,
    distance_pct: r2(distancePct),
    stop: r2(stop),
    stop_basis: stopBasis,
    risk_per_share: r2(risk),
    stop_in_atr: r2(stopAtr),
    ...(widened != null ? {
      stop_widened_from: r2(widened),
      stop_widened_note: `${r2(widened)} is the nearer level but sits inside ${MIN_STOP_ATR}x ATR of the `
        + 'trigger, where ordinary bar range hits it rather than the idea being wrong.',
    } : {}),
    targets,
    invalidation,
    ...(chasing ? {
      chasing_warning: `The trigger is ${r2(Math.abs(distancePct))}% away. Beyond ${CHASE_PCT}% Livermore `
        + 'treats the edge as gone — this is a level to watch, not a plan to act on.',
    } : {}),
    ...(Number.isFinite(daysToCatalyst) && Number.isFinite(holdingDays)
      && daysToCatalyst < holdingDays ? {
        catalyst_conflict: `A catalyst lands in ${daysToCatalyst} trading day(s) but the intended hold is `
          + `${holdingDays}. Triggering would put the position INTO the event, which no exit rule here covers.`,
      } : {}),
  };
}

/**
 * Both directions at once.
 *
 * Both, always — a report that gives the bull case a number and the bear case a
 * sentence has quietly taken a side.
 */
export function entryHypothesis({
  price, atr = null, patterns = [], levels = [], swing_high = null, swing_low = null,
  holding_days = null, days_to_catalyst = null,
} = {}) {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('entryHypothesis needs the current price.');
  }
  const args = {
    price,
    atr,
    patterns: patterns || [],
    levels: levels || [],
    swingHigh: swing_high,
    swingLow: swing_low,
    holdingDays: holding_days,
    daysToCatalyst: days_to_catalyst,
  };
  return {
    price,
    atr,
    long: side(1, args),
    short: side(-1, args),
    method: 'Triggers come from a forming pattern\'s completion level, a swing extreme, or an existing '
      + 'level — in that order of preference, and the basis is named. Nothing is rounded and no price is '
      + 'invented: a side with none of the three returns unavailable with a reason.',
    not_a_forecast: 'A forming pattern is NOT a signal. These are the prices at which each case would '
      + 'become checkable, not a claim that either will happen.',
  };
}
