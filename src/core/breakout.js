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
 * Pure: bars and a level in, a verdict out.
 */
import { countTests } from './structure.js';

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

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
  const bodyRatio = avgBody > 0 ? body / avgBody : null;
  const momentumOk = bodyRatio != null && bodyRatio >= 1.5;

  // 2. close beyond the level, measured as a percentage of price. A close that
  // only just clears the level is the classic weak break.
  const closeBeyondPct = ((dir === 'up' ? b.close - level : level - b.close) / level) * 100;
  const closeOk = closeBeyondPct >= min_close_pct;

  // A long wick beyond the level with the close back near it is the signature
  // of a rejected break, so it is measured separately from the close.
  const wickBeyond = dir === 'up' ? b.high - Math.max(b.open, b.close) : Math.min(b.open, b.close) - b.low;
  const rejectionWick = body > 0 ? wickBeyond / body : null;

  // 3. volume
  const vol = Number(b.volume);
  const volRatio = avgVol > 0 && Number.isFinite(vol) ? vol / avgVol : null;
  const volumeOk = volRatio != null && volRatio >= 1.2;

  // 4. how well-established the level was, BEFORE the break
  const band = level * 0.005;
  const t = countTests(bars.slice(0, idx), level - band, level + band);
  const levelOk = t.tests >= 2;

  // 5. follow-through on the next bar, if there is one
  const next = bars[idx + 1] || null;
  const followOk = next
    ? (dir === 'up' ? next.close > b.close : next.close < b.close)
    : null;
  const closedBackInside = next
    ? (dir === 'up' ? next.close < level : next.close > level)
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
    ...(rejectionWick != null && rejectionWick >= 1
      ? { rejection_wick: `The wick beyond the level is ${round(rejectionWick, 2)}x the body — price went through and was pushed back. That is the shape of a rejected break even when the close held.` }
      : {}),
    ...(closedBackInside
      ? { failed_reason: 'The next bar closed back inside the level. A break that is immediately reclaimed is a failed breakout, and those are frequently traded in the opposite direction.' }
      : {}),
    note: 'Each check is a measurement, not an opinion. A "strong" verdict is not a prediction — it means the break had the characteristics that usually accompany one that holds.',
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
