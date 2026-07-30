/**
 * Market structure and key levels, computed from price data.
 *
 * Two things a chart cannot tell you by looking at it, and that no other tool
 * here computes:
 *
 *   1. Where the swing highs and lows actually are, and what they imply —
 *      trend, break of structure (BOS), change of character (CHoCH).
 *   2. Which price levels have earned attention, and WHY — how many separate
 *      times price tested them, how much volume traded there, whether a round
 *      number sits on top.
 *
 * The "why" is the point. A level with no evidence behind it is a guess with a
 * price attached, and those are indistinguishable from real levels once they
 * are drawn on a chart. Every level this produces carries its own evidence, and
 * `reason` is assembled from that evidence rather than written by hand.
 *
 * Everything down to `analyzeStructure` is pure — bars in, findings out — so
 * the detection can be tested without a live chart.
 */
import * as data from './data.js';
import { completeBars } from './session.js';
import { COLORS, resolveTime, drawShape } from './drawing.js';
import { evaluate, getChartApi } from '../connection.js';

/** A level wider than this fraction of price is reported as a zone, not a line. */
const ZONE_SPAN_PCT = 0.6;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round = (n, dp = 8) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Normalize whatever getOhlcv returned into {time, open, high, low, close, volume}.
 * Bars arrive in a couple of shapes depending on the path they came through, and
 * silently mis-reading one of them would poison every level downstream.
 */
export function normalizeBars(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.bars) ? raw.bars : []);
  const out = [];
  for (const b of list) {
    if (!b) continue;
    const bar = Array.isArray(b)
      ? { time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }
      : {
          time: num(b.time ?? b.t ?? b.timestamp),
          open: num(b.open ?? b.o),
          high: num(b.high ?? b.h),
          low: num(b.low ?? b.l),
          close: num(b.close ?? b.c),
          volume: num(b.volume ?? b.v),
        };
    if (![bar.high, bar.low, bar.close].every((v) => Number.isFinite(v))) continue;
    out.push(bar);
  }
  out.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
}

/**
 * Normalised bars with the still-forming one removed.
 *
 * `normalizeBars` deliberately stays a pure normaliser — it has 39 call sites
 * and some of them (quotes, stop checks, screenshots) genuinely want the live
 * bar. This is the opt-in variant, for unattended runs where nobody is
 * watching to notice that "today" is 15% of a day.
 *
 * Pass the whole `getOhlcv` payload so the resolution travels with the bars;
 * a bare array cannot say whether it is daily or five-minute, and the answer
 * differs.
 */
export function completeSeries(raw, { now = Date.now(), resolution = null } = {}) {
  const all = normalizeBars(raw);
  const res = resolution
    ?? (raw && !Array.isArray(raw) ? raw.resolution : null)
    ?? '1D';
  const { bars, dropped, state, note } = completeBars(all, { resolution: res, now });
  return { bars, partial_bar: dropped, state, note };
}

/**
 * Fractal swing detection: a bar is a swing high when its high is the highest
 * in the window `lookback` bars either side.
 *
 * The comparison is deliberately asymmetric — STRICTLY beyond every bar to the
 * left, ties allowed to the right. On a flat shelf every bar is tied for the
 * highest, so a symmetric test marks the whole shelf and then clusters it into
 * a fistful of "levels" that are really one. Asymmetry marks the shelf once, at
 * the bar where price first reached it.
 */
export function findSwings(bars, { lookback = 5 } = {}) {
  const L = Math.max(1, Math.floor(lookback));
  const swings = [];

  for (let i = L; i < bars.length - L; i++) {
    const bar = bars[i];
    let isHigh = true, isLow = true;

    for (let j = i - L; j < i; j++) {
      if (bars[j].high >= bar.high) isHigh = false;
      if (bars[j].low <= bar.low) isLow = false;
    }
    for (let j = i + 1; j <= i + L; j++) {
      if (bars[j].high > bar.high) isHigh = false;
      if (bars[j].low < bar.low) isLow = false;
    }

    if (isHigh) swings.push({ index: i, time: bar.time, price: bar.high, kind: 'high' });
    if (isLow) swings.push({ index: i, time: bar.time, price: bar.low, kind: 'low' });
  }

  swings.sort((a, b) => a.index - b.index);
  return swings;
}

/**
 * Reduce swings to a strictly alternating high/low sequence.
 *
 * Two highs in a row is not a structure — it is one leg the detector saw twice.
 * Keeping the more extreme of the pair is what makes HH/HL/LH/LL meaningful.
 */
export function alternateSwings(swings) {
  const out = [];
  for (const s of swings) {
    const last = out[out.length - 1];
    if (!last || last.kind !== s.kind) { out.push(s); continue; }
    const replace = s.kind === 'high' ? s.price > last.price : s.price < last.price;
    if (replace) out[out.length - 1] = s;
  }
  return out;
}

/**
 * Classify trend and label each swing HH / HL / LH / LL, then derive BOS and
 * CHoCH from the sequence.
 *
 * BOS   — a swing extends the trend (higher high in an uptrend).
 * CHoCH — the trend's defining low/high fails, the first sign it has turned.
 *
 * These are read off confirmed swings, so they are what the structure HAS done.
 * A swing needs `lookback` bars to its right before it is confirmed, so the
 * most recent bars are deliberately not represented — that lag is the price of
 * not inventing structure that has yet to happen.
 */
export function classifyStructure(alt) {
  const labelled = [];
  let prevHigh = null, prevLow = null;

  for (const s of alt) {
    let label = null;
    if (s.kind === 'high') {
      if (prevHigh != null) label = s.price > prevHigh ? 'HH' : 'LH';
      prevHigh = s.price;
    } else {
      if (prevLow != null) label = s.price > prevLow ? 'HL' : 'LL';
      prevLow = s.price;
    }
    labelled.push({ ...s, label });
  }

  const events = [];
  let trend = 'undetermined';

  for (const s of labelled) {
    if (!s.label) continue;
    if (s.label === 'HH' && trend !== 'down') {
      if (trend === 'up') events.push({ type: 'BOS', direction: 'bullish', time: s.time, price: s.price });
      trend = 'up';
    } else if (s.label === 'LL' && trend !== 'up') {
      if (trend === 'down') events.push({ type: 'BOS', direction: 'bearish', time: s.time, price: s.price });
      trend = 'down';
    } else if (s.label === 'LL' && trend === 'up') {
      events.push({ type: 'CHoCH', direction: 'bearish', time: s.time, price: s.price });
      trend = 'down';
    } else if (s.label === 'HH' && trend === 'down') {
      events.push({ type: 'CHoCH', direction: 'bullish', time: s.time, price: s.price });
      trend = 'up';
    }
  }

  // The last confirmed high and low agreeing is what makes a trend, rather than
  // the last event alone — one HH inside a downtrend is noise, not a reversal.
  const lastHigh = [...labelled].reverse().find((s) => s.kind === 'high' && s.label);
  const lastLow = [...labelled].reverse().find((s) => s.kind === 'low' && s.label);
  let current = 'range';
  if (lastHigh?.label === 'HH' && lastLow?.label === 'HL') current = 'uptrend';
  else if (lastHigh?.label === 'LH' && lastLow?.label === 'LL') current = 'downtrend';
  else if (lastHigh && lastLow) current = 'range';
  else current = 'undetermined';

  return { trend: current, swings: labelled, events, last_high: lastHigh || null, last_low: lastLow || null };
}

/**
 * Classify each leg between swings as an IMPULSE or a PULLBACK.
 *
 * `classifyCandle` in patterns.js answers this for a single bar. This answers it
 * for a leg, which is the unit the fundamental trend pattern is built from —
 * impulse, pullback, impulse — and which underlies flags, pennants, wedges,
 * Elliott waves and every pullback entry.
 *
 * Three measurements per leg, each reported:
 *
 *   1. body share — how much of each bar's range was real body. An impulse is
 *      made of decisive bars; a pullback of indecisive ones.
 *   2. colour agreement — what fraction of bars moved with the leg. An impulse
 *      is mostly one colour; a pullback is mixed.
 *   3. close position — where bars closed inside their range. An impulse closes
 *      near its extreme; a pullback closes anywhere.
 *
 * A leg is an impulse when at least two of the three agree, and the verdict
 * always carries which ones did. Two of three rather than all three because
 * real impulses routinely contain one contrary bar, and requiring unanimity
 * classifies almost everything as a pullback.
 */
export function classifyLegs(bars, swings, { min_bars = 2 } = {}) {
  const legs = [];
  for (let i = 1; i < swings.length; i++) {
    const a = swings[i - 1], b = swings[i];
    const slice = bars.slice(a.index + 1, b.index + 1);
    if (slice.length < min_bars) continue;

    const up = b.price > a.price;
    let bodySum = 0, rangeSum = 0, withTrend = 0, closeNearExtreme = 0;

    for (const bar of slice) {
      const range = bar.high - bar.low;
      const body = Math.abs(bar.close - bar.open);
      bodySum += body;
      rangeSum += range;
      if (up ? bar.close > bar.open : bar.close < bar.open) withTrend++;
      if (range > 0) {
        // How far through its own range the bar closed, oriented to the leg.
        const pos = up ? (bar.close - bar.low) / range : (bar.high - bar.close) / range;
        if (pos >= 0.65) closeNearExtreme++;
      }
    }

    const bodyShare = rangeSum > 0 ? bodySum / rangeSum : 0;
    const colourAgreement = withTrend / slice.length;
    const closeQuality = closeNearExtreme / slice.length;

    const tests = {
      decisive_bodies: bodyShare >= 0.5,
      one_colour: colourAgreement >= 0.65,
      closes_near_extreme: closeQuality >= 0.5,
    };
    const passed = Object.entries(tests).filter(([, v]) => v).map(([k]) => k);
    const isImpulse = passed.length >= 2;

    legs.push({
      kind: isImpulse ? 'impulse' : 'pullback',
      direction: up ? 'up' : 'down',
      from: { price: round(a.price, 6), time: a.time, index: a.index },
      to: { price: round(b.price, 6), time: b.time, index: b.index },
      move_pct: round(((b.price - a.price) / Math.abs(a.price)) * 100, 2),
      bars: slice.length,
      body_share: round(bodyShare, 3),
      colour_agreement: round(colourAgreement, 3),
      close_quality: round(closeQuality, 3),
      tests,
      tests_passed: passed,
      evidence: `${passed.length} of 3 impulse tests passed${passed.length ? ` (${passed.join(', ')})` : ''}.`,
    });
  }

  // A pullback containing more than one counter-trend leg of its own is what
  // the material calls COMPLEX — flags and pennants are the common shapes. The
  // distinction matters because a complex pullback looks like a reversal while
  // it is forming, and gets abandoned for that reason.
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].kind !== 'pullback') continue;
    let run = 1;
    while (i + run < legs.length && legs[i + run].kind === 'pullback') run++;
    const complexity = run > 1 ? 'complex' : 'simple';
    for (let j = 0; j < run; j++) {
      legs[i + j].pullback_shape = complexity;
      legs[i + j].shape_note = complexity === 'complex'
        ? 'Part of a multi-leg pullback. Complex pullbacks look like reversals while forming, which is why they get abandoned early.'
        : 'A single-leg pullback.';
    }
    i += run - 1;
  }

  // A "pullback" bigger than the impulse it follows is a contradiction in
  // terms, and it is the shape a trend change makes. The tests measure
  // decisiveness, not size, so without this a 27% move with messy bars gets
  // reported as a pullback and read as a minor retracement.
  for (let i = 1; i < legs.length; i++) {
    if (legs[i].kind !== 'pullback') continue;
    const prior = legs[i - 1];
    if (prior.kind !== 'impulse') continue;
    const size = Math.abs(legs[i].to.price - legs[i].from.price);
    const priorSize = Math.abs(prior.to.price - prior.from.price);
    if (size > priorSize) {
      legs[i].larger_than_prior_impulse = true;
      legs[i].size_warning = `This leg moved ${round((size / priorSize), 2)}x further than the impulse before it. It failed the impulse tests on bar quality, not on size — a retracement this large is usually a change of trend rather than a pullback within one.`;
    }
  }

  const impulses = legs.filter((l) => l.kind === 'impulse');
  const last = legs[legs.length - 1] || null;

  // Swings need bars to their right before they confirm, so the last leg always
  // ends some way back. When price has since travelled a long way, reporting
  // `last_leg` without saying so describes a chart that no longer exists.
  let staleness = null;
  if (last && bars.length) {
    const now = bars[bars.length - 1].close;
    const since = bars.length - 1 - last.to.index;
    const movePct = ((now - last.to.price) / Math.abs(last.to.price)) * 100;
    staleness = {
      bars_since_last_leg: since,
      price_now: round(now, 6),
      price_move_since_pct: round(movePct, 2),
      ...(Math.abs(movePct) >= 3
        ? { warning: `Price has moved ${round(movePct, 1)}% in the ${since} bars since the last confirmed leg ended at ${round(last.to.price, 6)}. That move is not represented in any leg yet — do not describe the last leg as what price is doing now.` }
        : {}),
    };
  }

  return {
    legs,
    counts: { impulse: impulses.length, pullback: legs.length - impulses.length },
    last_leg: last,
    ...(staleness ? { since_last_leg: staleness } : {}),
    method: 'A leg is an impulse when at least two of three measurements agree: decisive bodies, one dominant colour, closes near the leg\'s extreme. Two of three rather than three because real impulses routinely contain a contrary bar. The tests measure decisiveness, not size.',
  };
}

/* --------------------------- time corrections ---------------------------- */

/**
 * Corrections come in TWO kinds, and a depth-based detector can only see one.
 *
 * Shannon (ch. 8) splits them:
 *
 *   - a **PRICE correction** moves against the trend — a pullback in an uptrend,
 *     a snapback in a downtrend. It has a retracement percentage.
 *   - a **TIME correction** is where "the stock digests the move in a
 *     horizontal, low-volatility, trendless manner."
 *
 * Both are digestion. Only the first shows up as depth. `classifyLegs` measures
 * bar quality between swings, so a horizontal stretch produces either no legs
 * at all or tiny offsetting ones — and a caller looking for a pullback entry
 * concludes "no pullback" and skips a setup that is digesting perfectly well.
 * That is the gap this closes.
 *
 * It also matters for the trendline finding in the same book: a broken trendline
 * "typically signals only that the RATE OF CHANGE has slowed, and that the
 * stock is likely to experience a correction THROUGH TIME." So the thing a
 * trendline break predicts is precisely the kind of correction a depth rule
 * cannot detect.
 *
 * Four clauses, each a number, each reported with its threshold:
 *
 *   1. **prior impulse** — this is a digestion OF something. Without a move to
 *      digest, a quiet stretch is just a quiet stretch.
 *   2. **horizontal** — net drift across the window is small.
 *   3. **low volatility** — mean true range contracted against the prior move.
 *   4. **trendless** — efficiency (net distance / path walked) is low.
 *
 * ── Honesty ──
 *
 * This overlaps Crabel's narrow-range coils almost exactly, and `volatility_state`
 * already detects those with the humbling measurement attached: every Crabel
 * pattern fires on 100% of random walks, and a narrow range is followed by a
 * wider one LESS often on real data (76.4%) than on noise (80.2%). A time
 * correction is a volatility STATE, not a direction — the same verdict. Shannon
 * claims resolution "in the direction of the primary trend"; `resolution` below
 * measures which way each completed correction actually broke, so the claim can
 * be checked rather than repeated. `TIME_CORRECTION_NOISE_BASELINE` carries the
 * random-walk floor.
 *
 * Pure.
 */
export function findTimeCorrections(bars, {
  window = 10,
  prior_window = 20,
  min_prior_impulse_pct = 4,
  max_drift_pct = 3,
  max_vol_ratio = 0.7,
  max_efficiency = 0.35,
  resolution_bars = 10,
} = {}) {
  const W = Math.max(3, Math.floor(window));
  const P = Math.max(3, Math.floor(prior_window));
  if (!Array.isArray(bars) || bars.length < W + P + 2) {
    return {
      available: false,
      corrections: [],
      note: `Need at least ${W + P + 2} bars to measure a ${W}-bar window against a ${P}-bar prior move; got ${bars?.length || 0}.`,
    };
  }

  const trueRange = (i) => (i > 0
    ? Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close),
      )
    : bars[i].high - bars[i].low);

  const meanTR = (from, to) => {
    let sum = 0; let n = 0;
    for (let i = from; i <= to; i += 1) { sum += trueRange(i); n += 1; }
    return n ? sum / n : 0;
  };

  const candidates = [];

  for (let end = P + W - 1; end < bars.length; end += 1) {
    const start = end - W + 1;
    const priorStart = start - P;
    if (priorStart < 1) continue;

    // 1. Was there a move to digest?
    const priorFrom = bars[priorStart].close;
    const priorTo = bars[start - 1].close;
    const priorImpulsePct = ((priorTo - priorFrom) / Math.abs(priorFrom)) * 100;
    if (Math.abs(priorImpulsePct) < min_prior_impulse_pct) continue;

    // 2. Horizontal: net drift across the window.
    const driftPct = ((bars[end].close - bars[start].close) / Math.abs(bars[start].close)) * 100;
    if (Math.abs(driftPct) > max_drift_pct) continue;

    // 3. Volatility contracted against the impulse it is digesting.
    const windowTR = meanTR(start, end);
    const priorTR = meanTR(priorStart, start - 1);
    const volRatio = priorTR > 0 ? windowTR / priorTR : null;
    if (volRatio === null || volRatio > max_vol_ratio) continue;

    // 4. Trendless: net distance over path walked.
    let path = 0;
    for (let i = start + 1; i <= end; i += 1) path += Math.abs(bars[i].close - bars[i - 1].close);
    const net = Math.abs(bars[end].close - bars[start].close);
    const efficiency = path > 0 ? net / path : 0;
    if (efficiency > max_efficiency) continue;

    let hi = -Infinity; let lo = Infinity;
    for (let i = start; i <= end; i += 1) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }

    candidates.push({
      start_index: start,
      end_index: end,
      prior_impulse_pct: round(priorImpulsePct, 2),
      drift_pct: round(driftPct, 2),
      range_pct: round(((hi - lo) / ((hi + lo) / 2)) * 100, 2),
      vol_ratio: round(volRatio, 3),
      efficiency: round(efficiency, 3),
      high: round(hi, 6),
      low: round(lo, 6),
    });
  }

  // Merge overlapping windows: one digestion, not one per sliding position.
  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && c.start_index <= last.end_index) {
      last.end_index = Math.max(last.end_index, c.end_index);
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      // Keep the extreme readings across the merged stretch, not the last ones.
      last.vol_ratio = Math.min(last.vol_ratio, c.vol_ratio);
      last.efficiency = Math.min(last.efficiency, c.efficiency);
      if (Math.abs(c.prior_impulse_pct) > Math.abs(last.prior_impulse_pct)) last.prior_impulse_pct = c.prior_impulse_pct;
      last.windows += 1;
      continue;
    }
    merged.push({ ...c, windows: 1 });
  }

  const corrections = merged.map((c) => {
    const direction = c.prior_impulse_pct > 0 ? 'up' : 'down';
    const barsIn = c.end_index - c.start_index + 1;

    // Which way did it actually break? Only for corrections with enough bars
    // after them — an unresolved one must say so rather than be scored.
    const after = c.end_index + resolution_bars;
    let resolution = null;
    if (after < bars.length) {
      const from = bars[c.end_index].close;
      const movePct = ((bars[after].close - from) / Math.abs(from)) * 100;
      const brokeUp = bars[after].close > c.high;
      const brokeDown = bars[after].close < c.low;
      resolution = {
        bars_after: resolution_bars,
        move_pct: round(movePct, 2),
        broke: brokeUp ? 'up' : brokeDown ? 'down' : 'still_inside',
        with_prior_trend: brokeUp || brokeDown
          ? ((brokeUp ? 'up' : 'down') === direction)
          : null,
      };
    }

    return {
      kind: 'time_correction',
      start_index: c.start_index,
      end_index: c.end_index,
      start_time: bars[c.start_index].time,
      end_time: bars[c.end_index].time,
      bars: barsIn,
      // How many sliding windows merged into this one. >1 means the digestion
      // outlasted the scan window rather than qualifying at a single position.
      windows_merged: c.windows,
      digesting: { direction, move_pct: c.prior_impulse_pct },
      high: round(c.high, 6),
      low: round(c.low, 6),
      measurements: {
        drift_pct: c.drift_pct,
        range_pct: c.range_pct,
        vol_ratio: c.vol_ratio,
        efficiency: c.efficiency,
      },
      thresholds: {
        max_drift_pct, max_vol_ratio, max_efficiency, min_prior_impulse_pct,
      },
      evidence: `${barsIn} bars digesting a ${c.prior_impulse_pct}% move: drift ${c.drift_pct}% (max ${max_drift_pct}), `
        + `true range ${c.vol_ratio}x the impulse's (max ${max_vol_ratio}), efficiency ${c.efficiency} (max ${max_efficiency}).`,
      ...(resolution ? { resolution } : { resolution_pending: `Fewer than ${resolution_bars} bars have passed since this ended.` }),
    };
  });

  const resolved = corrections.filter((c) => c.resolution && c.resolution.broke !== 'still_inside');
  const withTrend = resolved.filter((c) => c.resolution.with_prior_trend).length;

  return {
    available: true,
    corrections,
    count: corrections.length,
    windows_scanned: bars.length - (P + W - 1),
    ...(resolved.length
      ? {
          resolution_summary: {
            resolved: resolved.length,
            unresolved_or_still_inside: corrections.length - resolved.length,
            broke_with_prior_trend: withTrend,
            broke_with_prior_trend_pct: round((withTrend / resolved.length) * 100, 1),
            note: `Shannon: a time correction "often will be resolved in the direction of the primary trend". On this `
              + `series ${withTrend} of ${resolved.length} did. A count this small proves nothing — it is here so the `
              + 'claim is measured rather than repeated, and 50% is the coin-flip baseline.',
          },
        }
      : {}),
    what_this_is:
      'A volatility STATE, never a direction. Shannon\'s time correction is the same phenomenon as Crabel\'s '
      + 'narrow-range coils, and volatility_state carries the measurement: every Crabel pattern fires on 100% of '
      + 'random walks, and contraction is followed by expansion LESS often on real data (76.4%) than on noise (80.2%). '
      + 'Treat this as "digesting, setup may be live", not as a signal.',
    why_it_matters:
      'A pullback detector that measures DEPTH scores a time correction as "no pullback" and skips the setup. '
      + 'legs_classify measures bar quality between swings, so a horizontal stretch produces no legs or tiny '
      + 'offsetting ones. This is the correction it cannot see.',
    source: 'Shannon, Technical Analysis Using Multiple Timeframes (2008), ch. 8.',
  };
}

/**
 * Measured floor for `findTimeCorrections`, both arms.
 * `node scripts/time-correction-noise.js` re-measures.
 *
 * Two findings, and the second is the one that matters:
 *
 *  1. The detector fires on 88% of random walks and 83.3% of real symbols. A
 *     horizontal, low-volatility stretch after a move is one of the most common
 *     shapes a price series makes. So this is DESCRIPTIVE — "digesting" — and
 *     the near-identical rates mean it carries no information about which data
 *     it is looking at.
 *
 *  2. Shannon's resolution claim does not survive. He says a time correction
 *     "often will be resolved in the direction of the primary trend." Measured:
 *     real data 50%, random walk 52.8%. A LOWER figure on real data than on
 *     noise, and the null itself is a coin flip — so there is no room for the
 *     claim to be true in the way it is stated.
 *
 * This is the same shape as the Crabel result in `crabel.js`: real data showing
 * less lift than noise, on a claim that reads as a market tendency but is
 * arithmetic. Report the state; refuse to predict the break.
 */
export const TIME_CORRECTION_NOISE_BASELINE = Object.freeze({
  status: 'MEASURED',
  detection: {
    random_walk: { walks: 200, bars: 300, fires_pct: 88.0, mean_per_walk: 1.66, mean_duration_bars: 11.8 },
    real_data: { symbols: 12, bars: 300, fires_pct: 83.3, mean_per_symbol: 1.67, mean_duration_bars: 13.3 },
    verdict: 'DESCRIPTIVE ONLY. Real data fires slightly LESS often than noise, so the detection itself '
      + 'distinguishes nothing.',
  },
  resolution_claim: {
    claim: 'Shannon ch. 8: a time correction "often will be resolved in the direction of the primary trend."',
    random_walk: { resolved: 214, with_prior_trend_pct: 52.8 },
    real_data: { resolved: 14, with_prior_trend_pct: 50.0 },
    lift_points: -2.8,
    verdict: 'NO EDGE. Real data is BELOW its own null, and the null is a coin flip. The real-data sample (n=14) '
      + 'is far too small to stand alone — but the null at 52.8% (n=214) is well estimated, and it leaves no room '
      + 'for a directional claim regardless.',
  },
  note: 'A time correction is a volatility STATE, never a direction — the same verdict as every Crabel pattern. '
    + 'Its use is to stop a depth-based pullback rule from scoring a digesting chart as "no pullback".',
  script: 'scripts/time-correction-noise.js',
});

/**
 * Is `price` sitting on a psychologically round number, and how significant is
 * the roundness? Step scales with magnitude — 100 is round for a $95 stock and
 * unremarkable for Bitcoin.
 */
export function roundNumberNear(price, tolerancePct) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const magnitude = 10 ** Math.floor(Math.log10(price));
  const tol = price * (tolerancePct / 100);
  // Only the magnitude and its half count. Including magnitude/10 would make
  // any level near a multiple of 10 "round" for a $500 stock — which is nearly
  // all of them, and a reason that fires everywhere is not a reason.
  for (const step of [magnitude, magnitude / 2]) {
    if (step <= 0) continue;
    const nearest = Math.round(price / step) * step;
    if (nearest > 0 && Math.abs(price - nearest) <= tol) {
      return { value: round(nearest, 6), step: round(step, 6) };
    }
  }
  return null;
}

/**
 * Count how many SEPARATE times price visited a band, and how many bars traded
 * inside it.
 *
 * The distinction is the whole point. Twenty consecutive bars grinding along a
 * level is one test, not twenty — counting bars would score a slow drift as the
 * most-respected level on the chart. A visit ends once price leaves the band and
 * stays out for `gap` bars.
 */
export function countTests(bars, low, high, { gap = 3 } = {}) {
  let tests = 0, barsInBand = 0, volumeInBand = 0;
  let inside = false, outsideRun = 0;
  let lastIndex = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const touching = b.low <= high && b.high >= low;
    if (touching) {
      barsInBand++;
      volumeInBand += Number.isFinite(b.volume) ? b.volume : 0;
      lastIndex = i;
      if (!inside) { tests++; inside = true; }
      outsideRun = 0;
    } else if (inside) {
      outsideRun++;
      if (outsideRun >= gap) inside = false;
    }
  }

  return { tests, bars_in_band: barsInBand, volume_in_band: volumeInBand, last_index: lastIndex };
}

/**
 * Find key levels, each with the evidence that earned it a place.
 *
 * Swings are clustered by price, then each cluster is scored on what actually
 * happened there: how many independent swings formed it, how many separate
 * tests it survived, how much volume traded in it, and whether a round number
 * coincides. Clusters that clear `min_touches` are returned; the rest are
 * dropped rather than reported weakly.
 */
export function findKeyLevels(bars, {
  lookback = 5,
  tolerance_pct = 0.75,
  min_touches = 2,
  max_levels = 12,
  max_distance_pct = 25,
  current_price = null,
} = {}) {
  if (bars.length < lookback * 2 + 5) {
    return { levels: [], note: `Only ${bars.length} bars — not enough to detect structure. Ask for more with count.` };
  }

  const swings = findSwings(bars, { lookback });
  const price = Number.isFinite(current_price) ? current_price : bars[bars.length - 1].close;
  const avgVolume = bars.reduce((s, b) => s + (Number.isFinite(b.volume) ? b.volume : 0), 0) / bars.length;

  // Greedy price clustering. Swings sorted by price, so members of a cluster are
  // adjacent; a new swing joins while it stays within tolerance of the running mean.
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const s of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(s.price - c.mean) <= c.mean * (tolerance_pct / 100)) {
      c.members.push(s);
      c.mean = c.members.reduce((sum, m) => sum + m.price, 0) / c.members.length;
    } else {
      clusters.push({ members: [s], mean: s.price });
    }
  }

  const levels = [];
  for (const c of clusters) {
    const prices = c.members.map((m) => m.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const band = c.mean * (tolerance_pct / 100);
    // Widen a single-swing cluster to the tolerance band so a lone swing is
    // still tested fairly against the price data.
    const bandLow = Math.min(lo, c.mean - band);
    const bandHigh = Math.max(hi, c.mean + band);

    const t = countTests(bars, bandLow, bandHigh);
    if (t.tests < min_touches) continue;

    const spanPct = ((hi - lo) / c.mean) * 100;
    const isZone = spanPct >= ZONE_SPAN_PCT;
    const roundNum = roundNumberNear(c.mean, tolerance_pct);
    const volumeRatio = avgVolume > 0 ? t.volume_in_band / (avgVolume * Math.max(1, t.bars_in_band)) : null;
    const barsSince = t.last_index == null ? null : bars.length - 1 - t.last_index;

    const highs = c.members.filter((m) => m.kind === 'high').length;
    const lows = c.members.filter((m) => m.kind === 'low').length;

    // Score is deliberately simple and additive: every term is something that
    // happened, and each is reported alongside so the number can be checked.
    const score =
      t.tests * 2 +
      c.members.length +
      (roundNum ? 2 : 0) +
      (volumeRatio && volumeRatio > 1.25 ? 2 : 0) +
      (highs > 0 && lows > 0 ? 2 : 0);          // flipped S/R — held from both sides

    const reasons = [];
    reasons.push(`${t.tests} test${t.tests === 1 ? '' : 's'}`);
    if (highs && lows) reasons.push(`flipped (${highs} swing high${highs === 1 ? '' : 's'}, ${lows} swing low${lows === 1 ? '' : 's'})`);
    else if (highs) reasons.push(`${highs} swing high${highs === 1 ? '' : 's'}`);
    else if (lows) reasons.push(`${lows} swing low${lows === 1 ? '' : 's'}`);
    if (roundNum) reasons.push(`round number ${roundNum.value}`);
    if (volumeRatio && volumeRatio > 1.25) reasons.push(`${volumeRatio.toFixed(1)}x average volume`);
    reasons.push(`${t.bars_in_band} bars traded within it`);

    levels.push({
      price: round(c.mean, 6),
      ...(isZone ? { zone: { low: round(lo, 6), high: round(hi, 6) } } : {}),
      kind: isZone ? 'zone' : 'line',
      side: c.mean > price ? 'resistance' : 'support',
      tests: t.tests,
      bars_in_band: t.bars_in_band,
      swing_highs: highs,
      swing_lows: lows,
      volume_ratio: volumeRatio == null ? null : round(volumeRatio, 2),
      round_number: roundNum ? roundNum.value : null,
      bars_since_last_test: barsSince,
      distance_pct: round(((c.mean - price) / price) * 100, 2),
      score,
      reason: reasons.join(' + '),
    });
  }

  // A level 50% away is real history, but it is not a level for today's chart
  // and it outscores nearby ones simply by having had longer to accumulate
  // tests. Filtered by distance, and the exclusion is reported rather than
  // quietly applied.
  const limit = Number.isFinite(max_distance_pct) && max_distance_pct > 0 ? max_distance_pct : Infinity;
  const inRange = levels.filter((l) => Math.abs(l.distance_pct) <= limit);
  const tooFar = levels.length - inRange.length;

  inRange.sort((a, b) => b.score - a.score);
  const kept = inRange.slice(0, max_levels).sort((a, b) => b.price - a.price);

  return {
    levels: kept,
    current_price: round(price, 6),
    swings_detected: swings.length,
    bars_analyzed: bars.length,
    ...(tooFar ? { excluded_far: `${tooFar} qualifying level(s) sit further than ${limit}% from price and were excluded. Raise max_distance_pct to include them.` } : {}),
    ...(inRange.length > kept.length ? { truncated: `${inRange.length} levels qualified within range; showing the ${kept.length} strongest. Raise max_levels to see the rest.` } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Chart-facing wrappers
 * ------------------------------------------------------------------ */

async function loadBars(count) {
  const raw = await data.getOhlcv({ count, summary: false });
  const bars = normalizeBars(raw);
  if (!bars.length) throw new Error('No price bars came back from the chart. Check the symbol is loaded.');
  return bars;
}

/** Market structure for the chart as it stands: trend, swings, BOS and CHoCH. */
export async function analyzeStructure({ count = 200, lookback = 5, max_swings = 20 } = {}) {
  const bars = await loadBars(count);
  const swings = findSwings(bars, { lookback });
  const alt = alternateSwings(swings);
  const s = classifyStructure(alt);

  const recent = s.swings.slice(-max_swings).map((x) => ({
    kind: x.kind, label: x.label, price: round(x.price, 6), time: x.time,
  }));

  return {
    success: true,
    trend: s.trend,
    bars_analyzed: bars.length,
    lookback,
    last_price: round(bars[bars.length - 1].close, 6),
    last_swing_high: s.last_high ? { price: round(s.last_high.price, 6), label: s.last_high.label, time: s.last_high.time } : null,
    last_swing_low: s.last_low ? { price: round(s.last_low.price, 6), label: s.last_low.label, time: s.last_low.time } : null,
    swings: recent,
    events: s.events.slice(-10).map((e) => ({ ...e, price: round(e.price, 6) })),
    ...(s.swings.length > recent.length ? { note: `${s.swings.length} swings found; showing the last ${recent.length}.` } : {}),
    caveat: `Swings need ${lookback} bars to their right before they confirm, so the most recent ${lookback} bars are not yet represented. Structure describes what price has done, not what it will do.`,
  };
}

/** Key levels for the chart as it stands, each with its evidence. */
export async function keyLevels({ count = 300, lookback = 5, tolerance_pct = 0.75, min_touches = 2, max_levels = 12, max_distance_pct = 25 } = {}) {
  const bars = await loadBars(count);
  const result = findKeyLevels(bars, { lookback, tolerance_pct, min_touches, max_levels, max_distance_pct });

  const supports = result.levels.filter((l) => l.side === 'support');
  const resistances = result.levels.filter((l) => l.side === 'resistance');

  return {
    success: true,
    ...result,
    counts: { support: supports.length, resistance: resistances.length },
    nearest_support: supports[0] ? { price: supports[0].price, distance_pct: supports[0].distance_pct } : null,
    nearest_resistance: resistances[resistances.length - 1]
      ? { price: resistances[resistances.length - 1].price, distance_pct: resistances[resistances.length - 1].distance_pct }
      : null,
    note: 'Levels are derived from this chart\'s price history only. They describe where price has reacted before, not where it will react next.',
  };
}

/**
 * Chart label for a level.
 *
 * Compact by default. The full reason is 80-odd characters, which on a chart
 * with levels a few percent apart guarantees overlapping labels and buries the
 * price action underneath them. The complete evidence always comes back in the
 * tool result, so the chart carries the level and the session carries the
 * argument — which is the right division of labour between them.
 */
export function labelFor(lvl, detail = 'compact') {
  const price = String(round(lvl.price, 4));
  if (detail === 'price') return price;
  if (detail === 'full') return `${price} — ${lvl.reason}`;

  // Test count always, then at most two more — in descending order of how much
  // they distinguish one level from another. A label that lists everything is
  // back to being too long to read.
  const extras = [];
  if (lvl.swing_highs > 0 && lvl.swing_lows > 0) extras.push('flipped');
  if (lvl.round_number) extras.push(`round ${lvl.round_number}`);
  if (lvl.volume_ratio && lvl.volume_ratio > 1.25) extras.push(`${lvl.volume_ratio}x vol`);
  return [`${price}`, `${lvl.tests} tests`, ...extras.slice(0, 2)].join(' · ');
}

/**
 * Draw computed levels — lines for tight ones, shaded rectangles for zones.
 *
 * Grouped so they can be cleared in one call without touching the user's own
 * drawings, and labelled with the evidence rather than the price alone: a line
 * that says "4 tests + round number 600" can be argued with, one that says
 * "600" cannot.
 */
export async function drawKeyLevels({
  count = 300, lookback = 5, tolerance_pct = 0.75, min_touches = 2, max_levels = 8,
  max_distance_pct = 25, group, label_detail = 'compact', extend_bars = 0,
} = {}) {
  const bars = await loadBars(count);
  const found = findKeyLevels(bars, { lookback, tolerance_pct, min_touches, max_levels, max_distance_pct });
  if (!found.levels.length) {
    return { success: true, drawn: 0, levels: [], note: found.note || 'No levels cleared the evidence threshold. Lower min_touches or raise tolerance_pct.' };
  }

  const apiPath = await getChartApi();
  const state = await evaluate(`(function(){try{return ${apiPath}.symbol();}catch(e){return null;}})()`);
  const ticker = (state || 'chart').replace(/^.*:/, '');
  const groupName = group || `levels-${ticker}`;

  const lastTime = await resolveTime('last_bar');
  const barSeconds = bars.length > 1 ? Math.max(1, (bars[bars.length - 1].time - bars[0].time) / (bars.length - 1)) : 86400;
  const startTime = bars[0].time || lastTime;
  const endTime = lastTime + Math.round(extend_bars * barSeconds);

  const drawn = [];
  let ok = 0;

  // Levels sit close together by nature, and a label anchored the same way on
  // each one lands on top of its neighbour — unreadable, and worse, it hides
  // the evidence that is the whole point of the label. Alternating the anchor
  // by price rank separates adjacent labels vertically.
  const rank = new Map(
    [...found.levels].sort((a, b) => a.price - b.price).map((lvl, i) => [lvl, i]),
  );

  for (const lvl of found.levels) {
    const colour = lvl.side === 'support' ? COLORS.target : COLORS.stop;
    const label = labelFor(lvl, label_detail);
    const vertAlign = rank.get(lvl) % 2 === 0 ? 'bottom' : 'top';
    // Strength earns width, so the chart reads at a glance.
    const width = lvl.score >= 12 ? 3 : lvl.score >= 8 ? 2 : 1;

    try {
      const res = lvl.zone
        ? await drawShape({
            shape: 'rectangle',
            point: { price: lvl.zone.high, time: startTime },
            point2: { price: lvl.zone.low, time: endTime },
            text: label,
            group: groupName,
            overrides: {
              color: colour, linewidth: 1, backgroundColor: colour,
              fillBackground: true, transparency: 88,
              showLabel: true, textcolor: colour, fontsize: 11,
            },
          })
        : await drawShape({
            shape: 'horizontal_line',
            point: { price: lvl.price, time: startTime },
            text: label,
            group: groupName,
            overrides: {
              linecolor: colour, linewidth: width, linestyle: 0,
              showLabel: true, textcolor: colour, fontsize: 11,
              horzLabelsAlign: 'left', vertLabelsAlign: vertAlign,
            },
          });

      if (res.entity_id) {
        ok++;
        drawn.push({ price: lvl.price, kind: lvl.kind, side: lvl.side, score: lvl.score, reason: lvl.reason, entity_id: res.entity_id });
      } else {
        drawn.push({ price: lvl.price, error: 'TradingView accepted the shape but did not expose an id for it.' });
      }
    } catch (e) {
      drawn.push({ price: lvl.price, error: e.message });
    }
  }

  const failed = drawn.filter((d) => d.error);
  return {
    success: true,
    group: groupName,
    drawn: ok,
    requested: found.levels.length,
    current_price: found.current_price,
    levels: drawn,
    ...(failed.length ? { warning: `${failed.length} of ${found.levels.length} level(s) failed to draw.` } : {}),
    clear_hint: `Remove with draw_clear group="${groupName}".`,
    note: 'Levels derived from this chart\'s price history. Labels carry the evidence behind each one — check it rather than taking the level on trust.',
  };
}
