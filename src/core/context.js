/**
 * Trade context: pullback depth, level quality, market regime, volume profile.
 *
 * Four questions that come before "what pattern is this", and that decide
 * whether the answer matters:
 *
 *   1. How deep is this pullback?      → fibLevels
 *   2. Which swings are worth trusting? → classifySwings
 *   3. Is this market even tradeable?   → regime
 *   4. Where has volume actually traded? → volumeProfile
 *
 * The third is the one traders skip. Markets are close to random much of the
 * time, and the skill that separates people is not finding a setup — it is
 * being willing to say there isn't one. `regime` exists to make that sayable
 * with a number instead of a feeling.
 *
 * All pure: bars in, findings out.
 */
import { findSwings, alternateSwings, classifyStructure } from './structure.js';

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/* ----------------------------- fibonacci ------------------------------ */

/** The retracement ratios in common use. 0.5 is not a Fibonacci number, but it is watched. */
export const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

/**
 * Retracement levels for the most recent impulse, and where price sits in them.
 *
 * The "golden zone" is 38.2%–61.8%, where most healthy pullbacks end. Worth
 * knowing but not worth trusting on its own: in a steep trend pullbacks tend to
 * stay shallower than that, so a price above the zone is not automatically
 * "too high to enter" — it may just be a strong trend.
 */
export function fibLevels(bars, { lookback = 5 } = {}) {
  const swings = alternateSwings(findSwings(bars, { lookback }));
  if (swings.length < 2) {
    return { available: false, note: 'Fewer than two confirmed swings — no impulse to measure.' };
  }

  const b = swings[swings.length - 1];
  const a = swings[swings.length - 2];
  const direction = b.kind === 'high' ? 'up' : 'down';
  const from = a.price, to = b.price;
  const span = to - from;
  if (span === 0) return { available: false, note: 'The last impulse has zero height.' };

  const levels = FIB_RATIOS.map((r) => ({
    ratio: r,
    price: round(to - span * r, 6),
    golden: r >= 0.382 && r <= 0.618,
  }));

  const last = bars[bars.length - 1].close;
  // Retracement measured as a fraction of the impulse already given back.
  const retraced = (to - last) / span;
  const inGolden = retraced >= 0.382 && retraced <= 0.618;

  return {
    available: true,
    direction,
    impulse: { from: round(from, 6), to: round(to, 6), height: round(Math.abs(span), 6) },
    levels,
    current_price: round(last, 6),
    retraced_pct: round(retraced * 100, 1),
    in_golden_zone: inGolden,
    golden_zone: { high: round(to - span * 0.382, 6), low: round(to - span * 0.618, 6) },
    interpretation: retraced < 0
      ? 'Price has extended beyond the impulse — this is not a pullback, it is continuation.'
      : retraced > 1
        ? 'Price has given back the entire impulse. Treat the prior swing as broken, not as a pullback.'
        : inGolden
          ? 'Pullback sits in the 38.2-61.8% zone, where most healthy pullbacks end.'
          : retraced < 0.382
            ? 'Shallow pullback. Common in steep trends and not a weakness on its own.'
            : 'Deep pullback, past 61.8%. The move is on shakier ground the further it goes.',
    caveat: 'Retracement levels are arithmetic on the last impulse, not support. They matter when they coincide with a level that price has actually tested.',
  };
}

/* -------------------------- strong / weak swings ----------------------- */

/**
 * Which swings are strong and which are weak.
 *
 * A swing is STRONG when the move originating from it went on to break
 * structure — the market proved it mattered. It is WEAK when the move from it
 * failed to break anything. Weak levels get taken out; strong ones are where
 * stops belong.
 *
 * This is measurable and it is the single most useful thing to know about a
 * swing, yet "the low" is usually treated as one undifferentiated thing.
 */
export function classifySwings(bars, { lookback = 5 } = {}) {
  const alt = alternateSwings(findSwings(bars, { lookback }));
  const s = classifyStructure(alt);
  const labelled = s.swings;

  const out = [];
  for (let i = 0; i < labelled.length; i++) {
    const sw = labelled[i];
    // Look at the swings that FOLLOW this one: did the move starting here go
    // on to exceed the prior extreme of the same kind?
    const later = labelled.slice(i + 1);
    const sameKindBefore = labelled.slice(0, i).filter((x) => x.kind === sw.kind).pop();
    const oppositeAfter = later.find((x) => x.kind !== sw.kind);

    let strength = 'unproven', why = 'No completed move has originated from this swing yet.';
    if (oppositeAfter && sameKindBefore) {
      const broke = sw.kind === 'low'
        ? oppositeAfter.price > (labelled.slice(0, i).filter((x) => x.kind === 'high').pop()?.price ?? -Infinity)
        : oppositeAfter.price < (labelled.slice(0, i).filter((x) => x.kind === 'low').pop()?.price ?? Infinity);
      strength = broke ? 'strong' : 'weak';
      why = broke
        ? 'The move from this swing broke the prior structure, so the market confirmed it.'
        : 'The move from this swing failed to break the prior structure. Levels like this tend to get taken out.';
    }

    out.push({
      kind: sw.kind, label: sw.label, price: round(sw.price, 6), time: sw.time,
      strength, why,
    });
  }

  const strongLows = out.filter((x) => x.kind === 'low' && x.strength === 'strong');
  const strongHighs = out.filter((x) => x.kind === 'high' && x.strength === 'strong');

  return {
    trend: s.trend,
    swings: out,
    last_strong_low: strongLows[strongLows.length - 1] || null,
    last_strong_high: strongHighs[strongHighs.length - 1] || null,
    note: 'Strong swings are where stops belong and where bounces are more likely. Weak swings are the ones that get run.',
  };
}

/* ------------------------------- regime -------------------------------- */

/**
 * Is this market trending cleanly, or is it chop?
 *
 * Efficiency ratio: net distance travelled divided by the total path walked to
 * get there. A straight line scores 1; a market that thrashes and ends where it
 * started scores near 0.
 *
 * This is the "should I be trading this at all" number. Most of the time the
 * honest answer is no, and having it as a measurement makes that answer
 * possible to state instead of merely felt.
 */
export function regime(bars, { window = 30 } = {}) {
  const w = bars.slice(-window);
  if (w.length < 5) return { regime: 'unknown', note: 'Not enough bars to judge.' };

  const net = Math.abs(w[w.length - 1].close - w[0].close);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i].close - w[i - 1].close);
  if (path === 0) return { regime: 'flat', efficiency: 0, note: 'No movement at all in the window.' };

  const efficiency = net / path;
  const direction = w[w.length - 1].close > w[0].close ? 'up' : 'down';

  const label = efficiency >= 0.5 ? 'trending'
    : efficiency >= 0.3 ? 'mixed'
    : 'choppy';

  return {
    regime: label,
    efficiency: round(efficiency, 3),
    direction: label === 'choppy' ? null : direction,
    bars_examined: w.length,
    net_move: round(net, 6),
    path_walked: round(path, 6),
    interpretation: label === 'trending'
      ? `Price kept ${round(efficiency * 100, 0)}% of the distance it travelled — a clean, directional market.`
      : label === 'mixed'
        ? 'Some direction, but a lot of the movement cancelled itself out. Setups here are lower quality.'
        : `Only ${round(efficiency * 100, 0)}% of the movement went anywhere. This is chop.`,
    ...(label === 'choppy'
      ? { advice: 'Structure breaks in a market like this are mostly noise, stops get run, and patterns appear that are not there. The best available trade is usually no trade.' }
      : {}),
  };
}

/* --------------------------- volume profile ---------------------------- */

/**
 * Where volume actually traded, by price.
 *
 * Each bar's volume is spread evenly across its own high-low range, which is
 * the standard approximation when tick data is unavailable. It is an
 * approximation — a bar that traded all its volume at the close is treated as
 * if it traded evenly through the range — and the result says so.
 *
 * The point of control is the busiest price. The value area is the band holding
 * `value_area_pct` of the volume, grown outward from the POC.
 */
export function volumeProfile(bars, { bins = 40, value_area_pct = 70 } = {}) {
  const usable = bars.filter((b) => Number.isFinite(b.volume) && b.volume > 0 && b.high > b.low);
  if (usable.length < 5) {
    return { available: false, note: 'Not enough bars with usable volume and range to build a profile.' };
  }

  const hi = Math.max(...usable.map((b) => b.high));
  const lo = Math.min(...usable.map((b) => b.low));
  const size = (hi - lo) / bins;
  if (!(size > 0)) return { available: false, note: 'Price range is zero.' };

  const buckets = new Array(bins).fill(0);
  for (const b of usable) {
    const first = Math.max(0, Math.floor((b.low - lo) / size));
    const last = Math.min(bins - 1, Math.floor((b.high - lo) / size));
    const spread = last - first + 1;
    const per = b.volume / spread;
    for (let i = first; i <= last; i++) buckets[i] += per;
  }

  const total = buckets.reduce((a, c) => a + c, 0);
  let poc = 0;
  for (let i = 1; i < bins; i++) if (buckets[i] > buckets[poc]) poc = i;

  // Grow outward from the point of control, always taking the busier side.
  let lower = poc, upper = poc, acc = buckets[poc];
  const target = total * (value_area_pct / 100);
  while (acc < target && (lower > 0 || upper < bins - 1)) {
    const below = lower > 0 ? buckets[lower - 1] : -1;
    const above = upper < bins - 1 ? buckets[upper + 1] : -1;
    if (above >= below) { upper++; acc += buckets[upper]; }
    else { lower--; acc += buckets[lower]; }
  }

  const priceOf = (i) => lo + size * (i + 0.5);
  const avg = total / bins;
  const nodes = buckets.map((v, i) => ({ price: round(priceOf(i), 6), volume: round(v, 2), ratio: round(v / avg, 2) }));

  return {
    available: true,
    point_of_control: round(priceOf(poc), 6),
    value_area: { high: round(priceOf(upper), 6), low: round(priceOf(lower), 6), pct: value_area_pct },
    high_volume_nodes: nodes.filter((n) => n.ratio >= 1.5).sort((a, b) => b.volume - a.volume).slice(0, 5),
    low_volume_nodes: nodes.filter((n) => n.ratio <= 0.35).slice(0, 5),
    bars_used: usable.length,
    price_range: { high: round(hi, 6), low: round(lo, 6) },
    method: 'Each bar\'s volume is spread evenly across its high-low range — the standard approximation when tick data is unavailable, and an approximation rather than a measurement.',
    interpretation: 'High-volume nodes are prices the market accepted and often returns to. Low-volume nodes are prices it moved through quickly and tends to move through quickly again.',
  };
}
