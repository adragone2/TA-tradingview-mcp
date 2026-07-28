/**
 * Supply and demand zones — the origin of a move, not the point of a reversal.
 *
 * This is the one thing in the SMC and supply/demand material that `levels_find`
 * genuinely does not cover, and the distinction is worth stating precisely:
 *
 *   levels_find  — where price REVERSED, repeatedly. Evidence is the tests.
 *   findZones    — where price DEPARTED from, fast. Evidence is the departure.
 *
 * A level earns its place by being hit many times. A zone earns its place by
 * being left in a hurry. They are different questions and a chart usually
 * answers them at different prices.
 *
 * ── What is measurable here, and what is not ──
 *
 * The standard explanation is institutional: a large buyer could not fill their
 * whole order, so unfilled bids remain at that price and lift it again on the
 * return. That story is not visible in OHLCV and cannot be checked from it.
 * Nothing in this module depends on it being true.
 *
 * What IS measured, and all that is reported as evidence:
 *   - price left this area unusually fast (the momentum candle, quantified),
 *   - how far it got before coming back (departure),
 *   - whether it has since reacted here at all (tests).
 *
 * That is a weaker claim than the courses make, and it is the claim the data
 * supports.
 *
 * ── The frequency problem, again ──
 *
 * Like fair value gaps, zones are not rare. `total_found` and every filter count
 * come back with the result so a single returned zone is never mistaken for a
 * discovery.
 *
 * All pure.
 */
import { countTests } from './structure.js';

const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Find supply and demand zones.
 *
 * A zone is the base a momentum candle departed from. Detection is three
 * measurements, each reported:
 *
 *   1. Momentum — the candle's body is `momentum_multiple`x the average body of
 *      the preceding candles, AND at least as large as their average full range.
 *      The second condition is not decoration: after a cluster of dojis the
 *      average body approaches zero and the first test alone would call every
 *      subsequent candle a momentum candle.
 *   2. Engulfing — the body swallows the prior candle's body. Not required.
 *   3. Follow-through — price kept going after the candle. Not required.
 *
 * All three present is what the material calls an "aggressive" zone; that label
 * is applied, but it is a description of the three flags rather than a separate
 * finding.
 *
 * `base_candles` — 1 or 3 — is the drawing convention, and it is genuinely
 * arbitrary. What matters is that one is chosen and kept, so the choice is a
 * parameter and the answer always says which was used.
 */
export function findZones(bars, {
  momentum_multiple = 2,
  lookback_bodies = 3,
  base_candles = 1,
  follow_window = 3,
  max_age_bars = 120,
  min_departure_pct = 0,
  include_broken = false,
  strong_swings = null,
} = {}) {
  const N = Math.max(1, Math.floor(lookback_bodies));
  const B = Math.max(1, Math.floor(base_candles));

  if (!Array.isArray(bars) || bars.length < N + B + 2) {
    return { zones: [], note: `Need at least ${N + B + 2} bars to detect a zone.` };
  }

  const body = (b) => Math.abs(b.close - b.open);
  const all = [];

  for (let i = N + B; i < bars.length; i++) {
    const m = bars[i];
    const mBody = body(m);
    if (!(mBody > 0)) continue;

    const prev = bars.slice(i - N, i);
    const avgBody = prev.reduce((s, b) => s + body(b), 0) / prev.length;
    const avgRange = prev.reduce((s, b) => s + (b.high - b.low), 0) / prev.length;

    // Both conditions, for the reason in the doc comment above.
    if (!(mBody >= momentum_multiple * avgBody)) continue;
    if (!(mBody >= avgRange)) continue;

    const bullish = m.close > m.open;

    // The base: the candles immediately before the departure.
    const base = bars.slice(i - B, i);
    const top = Math.max(...base.map((b) => b.high));
    const bottom = Math.min(...base.map((b) => b.low));
    if (!(top > bottom)) continue;

    const before = bars[i - 1];
    const engulfing = bullish
      ? m.close >= Math.max(before.open, before.close) && m.open <= Math.min(before.open, before.close)
      : m.close <= Math.min(before.open, before.close) && m.open >= Math.max(before.open, before.close);

    // Follow-through: did the next few bars keep going, measured against the
    // momentum candle's own body so it scales with the move.
    const nextBars = bars.slice(i + 1, i + 1 + Math.max(0, follow_window));
    let followThrough = 0;
    if (nextBars.length) {
      const extreme = bullish
        ? Math.max(...nextBars.map((b) => b.high))
        : Math.min(...nextBars.map((b) => b.low));
      followThrough = (bullish ? extreme - m.close : m.close - extreme) / mBody;
    }

    // Departure: how far price got from the zone before returning to it.
    const after = bars.slice(i + 1);
    const anchor = bullish ? top : bottom;
    let departure = 0;
    for (const b of after) {
      const reach = bullish ? b.high - anchor : anchor - b.low;
      if (reach > departure) departure = reach;
      // Stop measuring once price is back inside the zone.
      if (b.low <= top && b.high >= bottom) break;
    }
    const departurePct = (departure / anchor) * 100;

    // Broken on a CLOSE through the far side, not a wick — the same discipline
    // that separates a spring from a breakdown.
    const broken = after.some((b) => (bullish ? b.close < bottom : b.close > top));

    // Tests count separate visits, not bars, so a slow grind through the zone
    // is one test rather than fifteen.
    const t = countTests(after, bottom, top);

    all.push({
      kind: bullish ? 'demand' : 'supply',
      top: round(top),
      bottom: round(bottom),
      midpoint: round((top + bottom) / 2),
      height_pct: round(((top - bottom) / bottom) * 100, 3),
      index: i,
      time: m.time,
      bars_ago: bars.length - 1 - i,
      momentum_x: round(avgBody > 0 ? mBody / avgBody : null, 2),
      engulfing,
      follow_through_x: round(followThrough, 2),
      departure_pct: round(departurePct, 2),
      tests: t.tests,
      status: broken ? 'broken' : t.tests === 0 ? 'fresh' : 'tested',
      broken,
    });
  }

  // Grade, tag against proven swings, and explain — after the raw pass, so the
  // counts above are honest about how many candidates existed.
  for (const z of all) {
    const aggressive = z.engulfing && z.follow_through_x >= 0.5;
    z.grade = aggressive ? 'aggressive' : 'plain';
    z.at_strong_swing = null;
    if (Array.isArray(strong_swings)) {
      const hit = strong_swings.find((s) =>
        s.strength === 'strong' && s.price >= z.bottom && s.price <= z.top &&
        ((z.kind === 'demand' && s.kind === 'low') || (z.kind === 'supply' && s.kind === 'high')));
      if (hit) z.at_strong_swing = hit.kind === 'low' ? 'strong_low' : 'strong_high';
    }

    const why = [`price left it at ${z.momentum_x}x the prior average body`];
    if (z.engulfing) why.push('the departure candle engulfed the one before it');
    if (z.follow_through_x >= 0.5) why.push(`follow-through carried ${z.follow_through_x}x further`);
    if (z.departure_pct > 0) why.push(`price reached ${z.departure_pct}% away before returning`);
    why.push(z.tests === 0 ? 'never revisited' : `revisited ${z.tests} time${z.tests === 1 ? '' : 's'} since`);
    if (z.at_strong_swing) why.push(`sits on a ${z.at_strong_swing.replace('_', ' ')} — a swing that went on to break structure`);
    z.evidence = why.join('; ');
  }

  const recent = all.filter((z) => z.bars_ago <= max_age_bars);
  const moved = recent.filter((z) => z.departure_pct >= min_departure_pct);
  const kept = include_broken ? moved : moved.filter((z) => !z.broken);

  kept.sort((a, b) => a.bars_ago - b.bars_ago);

  return {
    zones: kept,
    total_found: all.length,
    filtered_too_old: all.length - recent.length,
    filtered_weak_departure: recent.length - moved.length,
    ...(include_broken ? {} : { filtered_broken: moved.length - kept.length }),
    base_candles: B,
    method: `Zone drawn from the ${B === 1 ? 'single candle' : `${B} candles`} before the departure, wick to wick. The 1-candle and 3-candle conventions are both in common use and neither has a measured advantage — what matters is that one is used consistently, so it is reported here.`,
    reality_check: `${all.length} zones exist in these ${bars.length} bars before filtering. Zones are common; a returned one is a place price left quickly, not a place it is obliged to return to.`,
    caveat: 'The usual explanation — unfilled institutional orders resting in the zone — is not observable in price and volume data and nothing here depends on it. What is measured is that price departed fast, how far it got, and whether it has reacted here since.',
    fresh_vs_tested: 'A fresh zone is one price has not come back to. The convention that fresh zones are stronger than tested ones is convention, not a measurement made here — backtest it before weighting it.',
  };
}

/**
 * The nearest untested zone on each side of price.
 *
 * The practical question a zone list is usually being asked, separated out so
 * it does not have to be re-derived by eye from a dozen entries.
 */
export function nearestZones(zones, currentPrice) {
  if (!Array.isArray(zones) || !Number.isFinite(currentPrice)) return { above: null, below: null };
  const below = zones
    .filter((z) => z.top < currentPrice)
    .sort((a, b) => b.top - a.top)[0] || null;
  const above = zones
    .filter((z) => z.bottom > currentPrice)
    .sort((a, b) => a.bottom - b.bottom)[0] || null;
  return {
    below: below ? { ...below, distance_pct: round(((below.top - currentPrice) / currentPrice) * 100, 2) } : null,
    above: above ? { ...above, distance_pct: round(((above.bottom - currentPrice) / currentPrice) * 100, 2) } : null,
  };
}

/**
 * How often supply/demand zones appear in PURE NOISE.
 *
 * Measured by scripts/detector-noise.js over 200 seeded random walks of 200
 * bars. This detector shipped without the number for a long time, and the
 * number is not kind:
 *
 *   zones found on 99.5% of random walks, 4.4 zones per walk
 *
 * A shape present on essentially every random walk carries no information ON
 * ITS OWN. That does not make zones useless — it makes the CONFLUENCE the
 * evidence. A zone matters when structure, a level and a reaction agree with
 * it, and the zone alone is close to a coin flip about where price paused.
 *
 * Read alongside the supply-demand-setup skill, which already insists a zone
 * without structural backing "is a rectangle, and should be reported as one".
 * This is the measurement behind that sentence.
 */
export const ZONE_NOISE_BASELINE = {
  measured: true,
  script: 'scripts/detector-noise.js',
  walks: 200,
  bars_per_walk: 200,
  walks_with_any_zone_pct: 99.5,
  zones_per_walk: 4.4,
  note: 'A zone is found on almost every random walk. Never quote one as evidence by itself — the '
    + 'confluence with structure and a reaction is what carries the information.',
  context: { structural_patterns_pct: 68, channels_pct: 33.5, vcp_pct: 0, pennants_pct: 0 },
};
