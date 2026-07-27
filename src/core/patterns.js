/**
 * Chart and candlestick pattern detection.
 *
 * Patterns are the part of technical analysis most easily faked. The reference
 * material this was built from lists "see patterns where there aren't any" as
 * the FIRST human failure mode, and states the rule that keeps it honest:
 *
 *     a pattern is not complete or activated until a breakout occurs.
 *
 * So every pattern here reports `status`:
 *   - "forming"   — the shape is present, the breakout has NOT happened
 *   - "confirmed" — price has broken the level that completes it
 *
 * A forming pattern is a hypothesis. Reporting it as a signal is the error the
 * literature warns about, and it is why `status` is not optional here.
 *
 * Every detection also carries the measurements that produced it, so a caller
 * can check the claim rather than trust it. Nothing is scored on "looks like".
 *
 * All of this is pure: bars in, patterns out.
 */
import { findSwings, alternateSwings } from './structure.js';

const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const pct = (a, b) => (b === 0 ? Infinity : Math.abs(a - b) / Math.abs(b) * 100);

/**
 * What each candlestick pattern ACTUALLY does, measured.
 *
 * Bulkowski tested 103 candle types against real price data, and several of
 * the results contradict what the patterns are traditionally said to mean:
 *
 *   - the hanging man is called bearish, and acts as a BULLISH continuation
 *   - the inverted hammer is called bullish, and acts as a BEARISH continuation
 *   - the bearish harami is called bearish, and acts as a BULLISH continuation
 *
 * Those three were labelled the traditional way here until this table was
 * added. Folk direction is not a fact, so `acts_as` and `reliability_pct`
 * come from the measurements and `direction` follows them — not the folklore.
 *
 * `rank` is out of 103 candle types, 1 best, and describes how far price
 * travels AFTER the pattern. High reliability with a poor rank means it
 * reliably marks a turn that then goes nowhere much.
 *
 * Source: thepatternsite.com (Bulkowski), accessed July 2026.
 */
export const CANDLE_STATS = {
  hammer:            { acts_as: 'bullish reversal',     reliability_pct: 60, rank: 65 },
  hanging_man:       { acts_as: 'bullish continuation', reliability_pct: 59, rank: 87 },
  shooting_star:     { acts_as: 'bearish reversal',     reliability_pct: 59, rank: null },
  inverted_hammer:   { acts_as: 'bearish continuation', reliability_pct: 65, rank: 6 },
  bullish_engulfing: { acts_as: 'bullish reversal',     reliability_pct: 63, rank: 22 },
  bearish_engulfing: { acts_as: 'bearish reversal',     reliability_pct: 79, rank: 5 },
  harami_bullish:    { acts_as: 'bullish reversal',     reliability_pct: 53, rank: 38 },
  harami_bearish:    { acts_as: 'bullish continuation', reliability_pct: 53, rank: 72 },
  piercing_line:     { acts_as: 'bullish reversal',     reliability_pct: 64, rank: 21 },
  dark_cloud_cover:  { acts_as: 'bearish reversal',     reliability_pct: 60, rank: 22 },
};

/**
 * Nison's context and confirmation rules.
 *
 * `CANDLE_STATS` says how often a pattern WORKS. This says when it is a pattern
 * at all — which is the prior question, and the one detection alone cannot
 * answer. Nison is explicit that the identical shape means different things in
 * different places, and that some patterns require confirmation while others do
 * not:
 *
 *   "A hammer must come after a decline. A hanging man must come after a rally."
 *   "A hanging man should be confirmed, while a hammer need not be."
 *
 * That asymmetry was not represented here at all — the two were reported the
 * same way, which makes an unconfirmed hanging man look like a signal when its
 * own author says it is not one yet.
 *
 * For the engulfing pattern he requires "a clearly definable uptrend or
 * downtrend, even if the trend is short term", and allows one exception to the
 * opposite-colour rule: a DOJI engulfed by a very large body still counts.
 *
 * Source: Nison, Japanese Candlestick Charting Techniques, 2nd ed., ch. 4.
 */
export const NISON_RULES = {
  hammer:            { requires_prior: 'down', confirmation_required: false, note: 'A hammer is valid even after a short-term decline, and need not be confirmed.' },
  hanging_man:       { requires_prior: 'up',   confirmation_required: true,  extended_move_preferred: true,
                       confirmation: 'a close beneath the hanging man; at minimum a lower opening under its real body',
                       note: 'Should emerge after an EXTENDED rally, preferably at a high. Nison requires confirmation for this one.' },
  shooting_star:     { requires_prior: 'up',   confirmation_required: true,
                       confirmation: 'a lower close on the following session' },
  inverted_hammer:   { requires_prior: 'down', confirmation_required: true,
                       confirmation: 'a higher close on the following session' },
  bullish_engulfing: { requires_prior: 'down', confirmation_required: false, note: 'Needs a clearly definable downtrend, even a short-term one.' },
  bearish_engulfing: { requires_prior: 'up',   confirmation_required: false, note: 'Needs a clearly definable uptrend, even a short-term one.' },
  dark_cloud_cover:  { requires_prior: 'up',   confirmation_required: false },
  piercing_line:     { requires_prior: 'down', confirmation_required: false },
};

/**
 * Check a detected candle against Nison's context and confirmation rules.
 *
 * Confirmation is judged from the bar AFTER the pattern. Where that bar does
 * not exist yet the answer is `awaiting_confirmation` — the same discipline
 * structural patterns already use for `forming`, and for the same reason: a
 * pattern whose required confirmation has not happened is a hypothesis.
 */
export function nisonCheck(pattern, bars, index) {
  const rule = NISON_RULES[pattern];
  if (!rule) return null;

  const trend = priorTrend(bars, index);
  const contextOk = trend === rule.requires_prior;

  const out = {
    requires_prior_trend: rule.requires_prior,
    prior_trend_seen: trend,
    context_ok: contextOk,
    confirmation_required: rule.confirmation_required,
    ...(rule.note ? { nison_note: rule.note } : {}),
  };

  if (!contextOk) {
    out.context_warning = trend === 'unknown'
      ? `Not enough prior bars to establish the ${rule.requires_prior}trend this pattern requires.`
      : `This pattern requires a prior ${rule.requires_prior}trend and the prior move was ${trend}. Nison's own rule makes it not a ${pattern} here — it is the shape without the context.`;
  }

  if (rule.confirmation_required) {
    const next = bars[index + 1];
    const p = bars[index];
    if (!next) {
      out.confirmation_status = 'awaiting_confirmation';
      out.confirmation_rule = rule.confirmation;
      out.confirmation_warning = `Nison requires confirmation for this pattern and the next bar does not exist yet. Needed: ${rule.confirmation}. Until then it is a hypothesis, not a signal.`;
    } else {
      const bearishPattern = rule.requires_prior === 'up';
      const confirmed = bearishPattern
        ? next.close < Math.min(p.open, p.close)
        : next.close > Math.max(p.open, p.close);
      out.confirmation_status = confirmed ? 'confirmed' : 'not_confirmed';
      out.confirmation_rule = rule.confirmation;
      if (!confirmed) {
        out.confirmation_warning = `The following bar did not confirm (needed ${rule.confirmation}). Nison treats an unconfirmed ${pattern} as no signal.`;
      }
    }
  }

  return out;
}

/** Attach the measured behaviour, and let it override the traditional label. */
function withStats(p, statsKey = p.pattern) {
  const s = CANDLE_STATS[statsKey];
  if (!s) return p;
  const measuredDirection = s.acts_as.startsWith('bullish') ? 'bullish' : 'bearish';
  const contradicts = p.direction !== 'neutral' && p.direction !== measuredDirection;
  return {
    ...p,
    direction: measuredDirection,
    reliability: {
      acts_as: s.acts_as,
      pct: s.reliability_pct,
      rank_of_103: s.rank,
      // Near 50% is a coin flip dressed as a signal — say so rather than
      // letting the pattern's name do the arguing.
      verdict: s.reliability_pct >= 65 ? 'reliable'
        : s.reliability_pct >= 58 ? 'modest'
        : 'close to random',
    },
    ...(contradicts
      ? { contradicts_folklore: `Traditionally called ${p.direction}, but measured as a ${s.acts_as} ${s.reliability_pct}% of the time. The measurement wins.` }
      : {}),
  };
}

/* ---------------------------- bar anatomy ---------------------------- */

export function anatomy(bar) {
  const range = bar.high - bar.low;
  const body = Math.abs(bar.close - bar.open);
  const top = Math.max(bar.open, bar.close);
  const bottom = Math.min(bar.open, bar.close);
  return {
    range,
    body,
    upper_wick: bar.high - top,
    lower_wick: bottom - bar.low,
    bullish: bar.close > bar.open,
    bearish: bar.close < bar.open,
    body_pct: range > 0 ? (body / range) * 100 : 0,
  };
}

/**
 * Classify ANY candle into one of three families.
 *
 * The named-pattern list runs to seventy-odd entries and memorising it is not
 * how anyone reads a chart. Every candle, named or not, is one of three things,
 * and the three answer the only question a single bar can answer — who was in
 * control:
 *
 *   momentum   — a large body, small wicks. One side held control throughout.
 *   reaction   — a wick far longer than the body. One side pushed, the other
 *                took it back before the close.
 *   indecision — a small body with wicks on both sides. Neither side held.
 *
 * This is deliberately independent of `detectCandlePatterns`: that function
 * answers "is this a named pattern", which is often no. This one always answers.
 *
 * `context` is the previous bars, used to judge what counts as large here — a
 * body is only a momentum body relative to the ones around it.
 */
export function classifyCandle(bar, context = []) {
  const a = anatomy(bar);
  if (!(a.range > 0)) {
    return { family: 'indecision', subtype: 'four_price_doji', reason: 'Open, high, low and close are all the same price — no trading range at all.' };
  }

  const avgBody = context.length
    ? context.reduce((s, b) => s + Math.abs(b.close - b.open), 0) / context.length
    : null;
  const avgRange = context.length
    ? context.reduce((s, b) => s + (b.high - b.low), 0) / context.length
    : null;

  const bodyPct = a.body_pct;
  const upper = a.upper_wick, lower = a.lower_wick;
  const dir = a.bullish ? 'bullish' : a.bearish ? 'bearish' : 'neutral';

  // Momentum: body dominates its own range, AND the body is large against
  // recent bodies, AND it is large against the recent RANGE.
  //
  // All three are needed. Body-vs-range alone calls any wickless bar momentum.
  // Adding body-vs-average-body is not enough either: on a chart of 1.2-wide
  // bars, a 0.5-wide bar with no wicks is still 2.5x the average BODY while
  // being a fraction of the average bar. Comparing against the average range is
  // what catches that — the same guard zones.js needs, for the same reason.
  const bodyDominates = bodyPct >= 65;
  const bigForHere = avgBody == null ? true : a.body >= avgBody * 2;
  const bigAgainstRange = avgRange == null ? true : a.body >= avgRange;
  if (bodyDominates && bigForHere && bigAgainstRange) {
    const shaved = upper <= a.range * 0.03 && lower <= a.range * 0.03;
    return {
      family: 'momentum',
      subtype: shaved ? 'marubozu' : 'momentum_candle',
      direction: dir,
      body_pct: round(bodyPct, 1),
      ...(avgBody ? { body_vs_average: round(a.body / avgBody, 2) } : {}),
      reason: `Body is ${round(bodyPct, 0)}% of the range${avgBody ? ` and ${round(a.body / avgBody, 1)}x the recent average body` : ''}${shaved ? ', with effectively no wicks' : ''}. The ${dir === 'bullish' ? 'buyers' : 'sellers'} held control throughout.`,
      meaning: 'Trade with it, not against it, unless something else says the move is exhausted.',
    };
  }

  // Reaction: one wick dominates. The body's colour matters far less than which
  // side got pushed back — that is the whole content of the bar.
  const dominantWick = Math.max(upper, lower);
  if (bodyPct <= 35 && dominantWick >= a.range * 0.55 && Math.min(upper, lower) <= a.range * 0.25) {
    const rejectedFrom = upper > lower ? 'above' : 'below';
    return {
      family: 'reaction',
      subtype: upper > lower ? 'upper_wick_rejection' : 'lower_wick_rejection',
      direction: upper > lower ? 'bearish' : 'bullish',
      wick_pct: round((dominantWick / a.range) * 100, 1),
      body_pct: round(bodyPct, 1),
      reason: `The ${rejectedFrom === 'above' ? 'upper' : 'lower'} wick is ${round((dominantWick / a.range) * 100, 0)}% of the range. Price was pushed ${rejectedFrom} and taken back before the close.`,
      meaning: `An early reversal clue, and only that. It means something at a level price has already tested; in the middle of a range it is a bar with a long wick. The body colour matters much less than the wick.`,
    };
  }

  // Indecision: everything left. Small body, wicks both sides.
  const bothWicks = upper >= a.range * 0.2 && lower >= a.range * 0.2;
  const wide = avgRange != null && a.range >= avgRange * 2;
  // High wave is checked BEFORE doji. A near-zero body inside an unusually wide
  // range with long wicks both sides is a high-wave candle, and calling it a
  // plain doji throws away the part that matters — that the range was violent.
  const subtype = wide && bothWicks
    ? 'high_wave'
    : a.body <= a.range * 0.05
      ? 'doji'
      : bothWicks
        ? 'spinning_top'
        : 'small_body';

  return {
    family: 'indecision',
    subtype,
    direction: dir,
    body_pct: round(bodyPct, 1),
    reason: subtype === 'doji'
      ? 'Open and close are effectively the same price. Buying and selling attempts cancelled out exactly.'
      : subtype === 'high_wave'
        ? 'A small body inside an unusually wide range with long wicks both sides — violent movement that went nowhere.'
        : subtype === 'spinning_top'
          ? 'A small body with wicks on both sides. Neither side held control.'
          // small_body is the leftover: too small to be momentum, too even to be
          // a reaction, and without the two-sided wicks of a spinning top.
          : `A ${round(bodyPct, 0)}% body, too small to show control and too even to be a rejection of either side.`,
    meaning: 'Not tradeable alone. It matters for WHERE it appears — after a long run it is momentum stalling; inside a range it is nothing.',
  };
}

/** Classify the last `count` candles, each against the bars before it. */
export function classifyRecent(bars, { count = 5, context_bars = 10 } = {}) {
  if (!Array.isArray(bars) || !bars.length) return { candles: [], note: 'No bars supplied.' };
  const n = Math.min(count, bars.length);
  const out = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const ctx = bars.slice(Math.max(0, i - context_bars), i);
    out.push({ index: i, time: bars[i].time, bars_ago: bars.length - 1 - i, ...classifyCandle(bars[i], ctx) });
  }
  const tally = out.reduce((m, c) => ({ ...m, [c.family]: (m[c.family] || 0) + 1 }), {});
  return {
    candles: out.reverse(),
    tally,
    note: 'Every candle is one of three families — momentum, reaction, or indecision — whether or not it is also a named pattern. This answers "who is in control right now"; patterns_detect answers "is this a pattern with measured statistics behind it".',
  };
}

/**
 * Direction of the bars leading into a candle.
 *
 * Candlestick reversal patterns only mean anything against a prior trend — a
 * hammer in the middle of a range is a bar with a long wick, not a reversal.
 * Reported as context so the caller can discount patterns lacking it.
 */
function priorTrend(bars, index, lookback = 5) {
  const start = Math.max(0, index - lookback);
  if (index - start < 2) return 'unknown';
  const first = bars[start].close, last = bars[index - 1].close;
  const change = ((last - first) / first) * 100;
  if (change > 1.5) return 'up';
  if (change < -1.5) return 'down';
  return 'sideways';
}

/* -------------------------- candlestick patterns ---------------------- */

/**
 * Single- and two-bar patterns at a given index.
 *
 * Thresholds are stated as numbers rather than adjectives, because "small
 * body" and "long wick" are where pattern detection silently becomes opinion.
 */
function candlesAt(bars, i, opts) {
  const { doji_body_pct = 10, wick_ratio = 2, small_body_pct = 30 } = opts;
  const out = [];
  const b = bars[i];
  const a = anatomy(b);
  if (!(a.range > 0)) return out;

  const trend = priorTrend(bars, i);
  const base = { index: i, time: b.time, prior_trend: trend };

  // --- one-bar ---
  if (a.body_pct <= doji_body_pct) {
    // The doji family. Which one it is depends on where the tiny body sits,
    // and that changes the meaning completely: a dragonfly is buyers taking
    // back a whole session, a gravestone is sellers doing the same.
    const upper = a.upper_wick, lower = a.lower_wick;
    let variant = 'doji', dir = 'neutral', meaning = 'indecision — open and close nearly equal';
    if (a.range === 0) {
      variant = 'four_price_doji'; meaning = 'open, high, low and close identical — no information, and very rare';
    } else if (lower >= a.range * 0.66 && upper <= a.range * 0.15) {
      variant = 'dragonfly_doji'; dir = 'bullish';
      meaning = 'sold off through the session, then closed back at the open — buyers took it all back';
    } else if (upper >= a.range * 0.66 && lower <= a.range * 0.15) {
      variant = 'gravestone_doji'; dir = 'bearish';
      meaning = 'rallied through the session, then closed back at the open — sellers took it all back';
    } else if (a.range > 0 && upper > a.range * 0.25 && lower > a.range * 0.25) {
      variant = 'long_legged_doji';
      meaning = 'wide range either side of an unchanged close — volatile indecision';
    }
    out.push({
      ...base, pattern: variant, bars: 1, direction: dir,
      meaning,
      measurements: {
        body_pct_of_range: round(a.body_pct, 1),
        upper_wick_pct: round(a.range ? (upper / a.range) * 100 : 0, 1),
        lower_wick_pct: round(a.range ? (lower / a.range) * 100 : 0, 1),
      },
    });
  }

  // Momentum candle: a body more than `momentum_ratio` times the average of
  // the preceding bodies. This is the measurable version of "a strong candle",
  // which every source leans on and none of them define.
  if (i >= 5) {
    const prevBodies = bars.slice(i - 5, i).map((x) => Math.abs(x.close - x.open));
    const avgBody = prevBodies.reduce((x, y) => x + y, 0) / prevBodies.length;
    if (avgBody > 0 && a.body >= avgBody * (opts.momentum_ratio || 2)) {
      out.push({
        ...base,
        pattern: a.bullish ? 'bullish_momentum_candle' : 'bearish_momentum_candle',
        bars: 1, direction: a.bullish ? 'bullish' : 'bearish',
        meaning: 'body far larger than the recent average — one side took control, and momentum often carries on',
        measurements: { body_vs_avg: round(a.body / avgBody, 2), body: round(a.body), avg_prior_body: round(avgBody) },
      });
    }
  }

  const longLower = a.lower_wick >= wick_ratio * a.body && a.upper_wick <= a.body;
  const longUpper = a.upper_wick >= wick_ratio * a.body && a.lower_wick <= a.body;

  if (longLower && a.body_pct > doji_body_pct) {
    // Same shape, different name by context — that is the entire distinction.
    out.push(withStats({
      ...base,
      pattern: trend === 'down' ? 'hammer' : 'hanging_man',
      bars: 1,
      direction: trend === 'down' ? 'bullish' : 'bearish',
      meaning: trend === 'down'
        ? 'long lower wick after a decline — sellers rejected'
        : 'long lower wick after an advance — same shape, opposite context',
      measurements: { lower_wick_to_body: round(a.body ? a.lower_wick / a.body : null, 2), body_pct_of_range: round(a.body_pct, 1) },
      ...(trend === 'sideways' || trend === 'unknown'
        ? { caveat: 'No clear prior trend, so this shape carries little reversal meaning.' }
        : {}),
    }));
  }

  if (longUpper && a.body_pct > doji_body_pct) {
    out.push(withStats({
      ...base,
      pattern: trend === 'up' ? 'shooting_star' : 'inverted_hammer',
      bars: 1,
      direction: trend === 'up' ? 'bearish' : 'bullish',
      meaning: trend === 'up'
        ? 'long upper wick after an advance — buyers rejected'
        : 'long upper wick after a decline',
      measurements: { upper_wick_to_body: round(a.body ? a.upper_wick / a.body : null, 2), body_pct_of_range: round(a.body_pct, 1) },
      ...(trend === 'sideways' || trend === 'unknown'
        ? { caveat: 'No clear prior trend, so this shape carries little reversal meaning.' }
        : {}),
    }));
  }

  if (i === 0) return out;

  // --- two-bar ---
  const p = bars[i - 1];
  const pa = anatomy(p);
  const pTop = Math.max(p.open, p.close), pBottom = Math.min(p.open, p.close);
  const cTop = Math.max(b.open, b.close), cBottom = Math.min(b.open, b.close);

  // Engulfing: the second BODY completely contains the first body.
  if (cTop >= pTop && cBottom <= pBottom && a.body > pa.body && pa.body > 0) {
    if (a.bullish && pa.bearish) {
      out.push(withStats({
        ...base, pattern: 'bullish_engulfing', bars: 2, direction: 'bullish',
        meaning: 'up bar whose body swallows the prior down bar',
        measurements: { body_ratio: round(a.body / pa.body, 2) },
      }));
    } else if (a.bearish && pa.bullish) {
      out.push(withStats({
        ...base, pattern: 'bearish_engulfing', bars: 2, direction: 'bearish',
        meaning: 'down bar whose body swallows the prior up bar',
        measurements: { body_ratio: round(a.body / pa.body, 2) },
      }));
    }
  }

  // Harami: small opposite-coloured body entirely INSIDE the prior body.
  if (cTop <= pTop && cBottom >= pBottom && pa.body > 0 && a.body < pa.body
      && (a.body / pa.body) * 100 <= small_body_pct
      && ((a.bullish && pa.bearish) || (a.bearish && pa.bullish))) {
    out.push(withStats({
      ...base, pattern: 'harami', bars: 2,
      direction: a.bullish ? 'bullish' : 'bearish',
      meaning: 'small body contained within the previous larger body — momentum stalling',
      measurements: { body_ratio: round(a.body / pa.body, 2) },
    }, a.bullish ? 'harami_bullish' : 'harami_bearish'));
  }

  // Dark cloud cover / piercing line: opens beyond the prior bar, closes back
  // past the MIDPOINT of the prior body without fully engulfing it.
  const pMid = (p.open + p.close) / 2;
  if (pa.bullish && a.bearish && b.open > p.high && b.close < pMid && b.close > p.open) {
    out.push(withStats({
      ...base, pattern: 'dark_cloud_cover', bars: 2, direction: 'bearish',
      meaning: 'gapped up, then closed back below the midpoint of the prior up bar',
      measurements: { penetration_pct: round(((p.close - b.close) / (p.close - p.open)) * 100, 1) },
    }));
  }
  if (pa.bearish && a.bullish && b.open < p.low && b.close > pMid && b.close < p.open) {
    out.push(withStats({
      ...base, pattern: 'piercing_line', bars: 2, direction: 'bullish',
      meaning: 'gapped down, then closed back above the midpoint of the prior down bar',
      measurements: { penetration_pct: round(((b.close - p.close) / (p.open - p.close)) * 100, 1) },
    }));
  }

  // Inside bar — the whole RANGE is contained, not just the body.
  if (b.high <= p.high && b.low >= p.low) {
    out.push({
      ...base, pattern: 'inside_bar', bars: 2, direction: 'neutral',
      meaning: 'entire range inside the prior bar — volatility contracting',
      measurements: { range_ratio: round(pa.range ? a.range / pa.range : null, 2) },
      breakout_levels: { above: round(p.high), below: round(p.low) },
    });
  }

  // Gaps.
  if (b.low > p.high) {
    out.push({
      ...base, pattern: 'gap_up', bars: 2, direction: 'bullish',
      meaning: 'no trading between the prior high and this low',
      measurements: { gap_pct: round(((b.low - p.high) / p.high) * 100, 2) },
    });
  }
  if (b.high < p.low) {
    out.push({
      ...base, pattern: 'gap_down', bars: 2, direction: 'bearish',
      meaning: 'no trading between the prior low and this high',
      measurements: { gap_pct: round(((p.low - b.high) / p.low) * 100, 2) },
    });
  }

  return out;
}

/** Narrow-range pattern: this bar's range is the smallest of the last N. */
function narrowRangeAt(bars, i, n) {
  if (i < n - 1) return null;
  const r = bars[i].high - bars[i].low;
  for (let k = i - n + 1; k < i; k++) {
    if (bars[k].high - bars[k].low <= r) return null;
  }
  const window = bars.slice(i - n + 1, i + 1);
  return {
    index: i, time: bars[i].time, pattern: `NR${n}`, bars: n, direction: 'neutral',
    prior_trend: priorTrend(bars, i),
    meaning: `narrowest range of the last ${n} bars — volatility compressed, and new trends often start here`,
    measurements: { range: round(r), widest_in_window: round(Math.max(...window.map((b) => b.high - b.low))) },
    breakout_levels: { above: round(bars[i].high), below: round(bars[i].low) },
  };
}

/* ------------------------- swing-based patterns ----------------------- */

/**
 * Double / triple tops and bottoms, and head-and-shoulders.
 *
 * Built on confirmed swings, and each one reports the level whose break
 * completes it. The measured-move target follows the standard construction:
 * the pattern's height projected from the breakout level.
 */
function structuralPatterns(bars, swings, opts) {
  const { peak_tolerance_pct = 2 } = opts;
  const alt = alternateSwings(swings);
  const found = [];
  const last = bars[bars.length - 1];

  const confirm = (level, direction) => {
    // "Completed" means price CLOSED through the level, not merely touched it.
    const broken = direction === 'down' ? last.close < level : last.close > level;
    return broken ? 'confirmed' : 'forming';
  };

  for (let i = 0; i + 2 < alt.length; i++) {
    const [a, b, c] = [alt[i], alt[i + 1], alt[i + 2]];

    // Double top: high - low - high, the two highs at roughly one price.
    if (a.kind === 'high' && c.kind === 'high' && pct(a.price, c.price) <= peak_tolerance_pct) {
      const neck = b.price;
      const height = Math.max(a.price, c.price) - neck;
      found.push({
        pattern: 'double_top', type: 'reversal', direction: 'bearish', bars: c.index - a.index + 1,
        status: confirm(neck, 'down'),
        completion_level: round(neck),
        target: round(neck - height),
        measurements: { peak_1: round(a.price), peak_2: round(c.price), trough: round(neck), peak_difference_pct: round(pct(a.price, c.price), 2), height: round(height) },
        from_time: a.time, to_time: c.time,
        note: 'Completes on a close below the trough between the peaks. Target is the height projected down from it.',
      });
    }

    // Double bottom: low - high - low.
    if (a.kind === 'low' && c.kind === 'low' && pct(a.price, c.price) <= peak_tolerance_pct) {
      const neck = b.price;
      const height = neck - Math.min(a.price, c.price);
      found.push({
        pattern: 'double_bottom', type: 'reversal', direction: 'bullish', bars: c.index - a.index + 1,
        status: confirm(neck, 'up'),
        completion_level: round(neck),
        target: round(neck + height),
        measurements: { trough_1: round(a.price), trough_2: round(c.price), peak: round(neck), trough_difference_pct: round(pct(a.price, c.price), 2), height: round(height) },
        from_time: a.time, to_time: c.time,
        note: 'Completes on a close above the peak between the troughs. Target is the height projected up from it.',
      });
    }
  }

  for (let i = 0; i + 4 < alt.length; i++) {
    const w = alt.slice(i, i + 5);
    const kinds = w.map((s) => s.kind).join(',');

    // Triple top: three highs at roughly one price.
    if (kinds === 'high,low,high,low,high') {
      const [p1, t1, p2, t2, p3] = w;
      if (pct(p1.price, p2.price) <= peak_tolerance_pct && pct(p2.price, p3.price) <= peak_tolerance_pct) {
        const neck = Math.min(t1.price, t2.price);
        const height = Math.max(p1.price, p2.price, p3.price) - neck;
        found.push({
          pattern: 'triple_top', type: 'reversal', direction: 'bearish', bars: p3.index - p1.index + 1,
          status: confirm(neck, 'down'),
          completion_level: round(neck), target: round(neck - height),
          measurements: { peaks: [round(p1.price), round(p2.price), round(p3.price)], troughs: [round(t1.price), round(t2.price)], height: round(height) },
          from_time: p1.time, to_time: p3.time,
          note: 'Completes on a close below the lower of the two intervening troughs.',
        });
      }

      // Head and shoulders top: middle peak highest, outer two comparable.
      if (p2.price > p1.price && p2.price > p3.price && pct(p1.price, p3.price) <= peak_tolerance_pct * 1.5) {
        const neck = (t1.price + t2.price) / 2;
        const height = p2.price - neck;
        found.push({
          pattern: 'head_and_shoulders', type: 'reversal', direction: 'bearish', bars: p3.index - p1.index + 1,
          status: confirm(neck, 'down'),
          completion_level: round(neck), target: round(neck - height),
          measurements: { left_shoulder: round(p1.price), head: round(p2.price), right_shoulder: round(p3.price), neckline: round(neck), shoulder_difference_pct: round(pct(p1.price, p3.price), 2), height: round(height), trough_1: round(t1.price), trough_2: round(t2.price), downsloping_neckline: t2.price < t1.price },
          from_time: p1.time, to_time: p3.time,
          note: 'Completes only on a close below the neckline. Target is head-to-neckline projected down from the neckline.',
          ...(t2.price < t1.price
            ? { structure_confirms: 'The second trough is below the first, so price is already making lower highs AND lower lows — structure has turned before the neckline breaks. This is the stronger version.' }
            : { structure_caveat: 'The second trough is not below the first, so structure has not yet turned. Weaker than the down-sloping-neckline version.' }),
        });
      }
    }

    if (kinds === 'low,high,low,high,low') {
      const [t1, p1, t2, p2, t3] = w;
      if (pct(t1.price, t2.price) <= peak_tolerance_pct && pct(t2.price, t3.price) <= peak_tolerance_pct) {
        const neck = Math.max(p1.price, p2.price);
        const height = neck - Math.min(t1.price, t2.price, t3.price);
        found.push({
          pattern: 'triple_bottom', type: 'reversal', direction: 'bullish', bars: t3.index - t1.index + 1,
          status: confirm(neck, 'up'),
          completion_level: round(neck), target: round(neck + height),
          measurements: { troughs: [round(t1.price), round(t2.price), round(t3.price)], peaks: [round(p1.price), round(p2.price)], height: round(height) },
          from_time: t1.time, to_time: t3.time,
          note: 'Completes on a close above the higher of the two intervening peaks.',
        });
      }

      if (t2.price < t1.price && t2.price < t3.price && pct(t1.price, t3.price) <= peak_tolerance_pct * 1.5) {
        const neck = (p1.price + p2.price) / 2;
        const height = neck - t2.price;
        found.push({
          pattern: 'inverse_head_and_shoulders', type: 'reversal', direction: 'bullish', bars: t3.index - t1.index + 1,
          status: confirm(neck, 'up'),
          completion_level: round(neck), target: round(neck + height),
          measurements: { left_shoulder: round(t1.price), head: round(t2.price), right_shoulder: round(t3.price), neckline: round(neck), shoulder_difference_pct: round(pct(t1.price, t3.price), 2), height: round(height) },
          from_time: t1.time, to_time: t3.time,
          note: 'Completes only on a close above the neckline.',
        });
      }
    }
  }

  return found;
}

/* ------------------------ trendline patterns -------------------------- */

/** Least-squares slope of price against bar index, as percent of price per bar. */
export function slopePctPerBar(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.index, 0) / n;
  const my = points.reduce((s, p) => s + p.price, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.index - mx) * (p.price - my); den += (p.index - mx) ** 2; }
  if (den === 0 || my === 0) return null;
  return (num / den) / my * 100;
}

/** Value of the fitted line at a given bar index. */
function lineAt(points, index) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.index, 0) / n;
  const my = points.reduce((s, p) => s + p.price, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.index - mx) * (p.price - my); den += (p.index - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  return my + slope * (index - mx);
}

/**
 * Triangles, rectangles, wedges, flags and broadening formations.
 *
 * All of these are "two trend lines" patterns; what separates them is only the
 * SIGN of each slope and whether the lines converge. So they are detected once,
 * from the same fitted lines, and named from the geometry — rather than as six
 * near-duplicate detectors that could disagree with each other.
 *
 * Bulkowski's requirement is enforced: at least two minor highs AND two minor
 * lows must touch (or come close to) the lines. Fewer than that is not a
 * pattern, it is two points and an opinion.
 */
function trendlinePatterns(bars, swings, {
  window_bars = 60,
  flat_slope_pct = 0.05,
  min_touches = 2,
} = {}) {
  const lastIndex = bars.length - 1;
  const start = Math.max(0, lastIndex - window_bars);
  const inWindow = swings.filter((s) => s.index >= start);
  const highs = inWindow.filter((s) => s.kind === 'high');
  const lows = inWindow.filter((s) => s.kind === 'low');

  if (highs.length < min_touches || lows.length < min_touches) return [];

  const hSlope = slopePctPerBar(highs);
  const lSlope = slopePctPerBar(lows);
  if (hSlope == null || lSlope == null) return [];

  const first = Math.min(highs[0].index, lows[0].index);
  const widthStart = lineAt(highs, first) - lineAt(lows, first);
  const widthEnd = lineAt(highs, lastIndex) - lineAt(lows, lastIndex);
  if (!(widthStart > 0) || !(widthEnd > 0)) return [];
  const converging = widthEnd < widthStart * 0.9;
  const diverging = widthEnd > widthStart * 1.1;

  const flatHigh = Math.abs(hSlope) < flat_slope_pct;
  const flatLow = Math.abs(lSlope) < flat_slope_pct;
  const resistance = lineAt(highs, lastIndex);
  const support = lineAt(lows, lastIndex);
  const height = Math.max(...highs.map((s) => s.price)) - Math.min(...lows.map((s) => s.price));
  const spanBars = lastIndex - first;
  const last = bars[lastIndex];

  let pattern = null, direction = 'bilateral', note = '', type = null, avoid = null;
  if (flatHigh && lSlope > flat_slope_pct) {
    pattern = 'ascending_triangle'; direction = 'bullish'; type = 'continuation';
    note = 'Horizontal resistance with rising lows. Usually continues the prior trend, but it does break down sometimes.';
  } else if (flatLow && hSlope < -flat_slope_pct) {
    pattern = 'descending_triangle'; direction = 'bearish'; type = 'continuation';
    note = 'Horizontal support with falling highs. Roughly two in three break downward.';
  } else if (hSlope < -flat_slope_pct && lSlope > flat_slope_pct && converging) {
    pattern = 'symmetrical_triangle'; direction = 'bilateral'; type = 'uncertain';
    note = 'Converging lines with no directional bias of its own. Textbooks call it a continuation; in practice it often just becomes a sideways range.';
    avoid = 'Direction is not knowable in advance, and these frequently resolve into a trading range rather than a trend. A breakout from one is often just a normal swing inside that range. Treat with suspicion rather than as a setup.';
  } else if (flatHigh && flatLow) {
    pattern = 'rectangle'; direction = 'bilateral'; type = 'uncertain';
    note = 'A trading range bounded by two horizontal lines. Prone to false breakouts.';
    avoid = 'Price action inside a range is close to random. Beware of finding further patterns in it — that is where most imaginary patterns come from.';
  } else if (hSlope > flat_slope_pct && lSlope > flat_slope_pct && converging && lSlope > hSlope) {
    // Both rise, and the LOWER line rises faster — that is what closes the
    // wedge. Without the steeper-line test this is just a rising channel.
    pattern = 'rising_wedge'; direction = 'bearish'; type = 'reversal or continuation';
    note = 'Both lines rise while the lower one rises faster, narrowing the range. Breaks DOWN despite rising prices. Acts as a reversal after an uptrend and a continuation after a downtrend.';
  } else if (hSlope < -flat_slope_pct && lSlope < -flat_slope_pct && converging && hSlope < lSlope) {
    pattern = 'falling_wedge'; direction = 'bullish'; type = 'reversal or continuation';
    note = 'Both lines fall while the upper one falls faster, narrowing the range. Breaks UP despite falling prices. Acts as a reversal after a downtrend and a continuation after an uptrend.';
  } else if (diverging && hSlope > 0 && lSlope < 0) {
    pattern = 'broadening_formation'; direction = 'bilateral'; type = 'uncertain';
    note = 'Diverging lines — a megaphone, meaning volatility is rising. Direction AND type are both uncertain.';
    avoid = 'These frequently resolve into a plain trading range. Inside a range, price action is close to random and it is easy to "find" more patterns in the noise. Treat as a reason NOT to trade rather than a setup.';
  } else if (Math.abs(hSlope - lSlope) < flat_slope_pct && !flatHigh && spanBars <= 15) {
    pattern = hSlope < 0 ? 'bull_flag' : 'bear_flag';
    direction = hSlope < 0 ? 'bullish' : 'bearish';
    type = 'continuation';
    note = 'Parallel lines sloping against the prior move, over a short span — a pause, not a turn. Quality depends mostly on the IMPULSE INTO it: a sharp move with large candles makes a good flag, a slow drift makes a poor one.';
  }
  if (!pattern) return [];

  // Which line completes it, and which way. Bilateral patterns can complete
  // either way, so the nearer line is reported as the one in play.
  const upBreak = last.close > resistance;
  const downBreak = last.close < support;
  const completion = direction === 'bearish' ? support
    : direction === 'bullish' ? resistance
    : (Math.abs(last.close - resistance) < Math.abs(last.close - support) ? resistance : support);

  const status = (upBreak || downBreak) ? 'confirmed' : 'forming';
  const brokeUp = upBreak;

  return [{
    pattern, direction,
    ...(type ? { type } : {}),
    status,
    ...(avoid ? { avoid } : {}),
    ...(status === 'confirmed' ? { broke: brokeUp ? 'up' : 'down' } : {}),
    bars: spanBars,
    bars_ago: 0,
    completion_level: round(completion),
    // Measure rule: the pattern's height projected from the breakout level.
    target: status === 'confirmed'
      ? round(brokeUp ? resistance + height : support - height)
      : round(direction === 'bearish' ? support - height : resistance + height),
    measurements: {
      resistance_now: round(resistance), support_now: round(support),
      upper_slope_pct_per_bar: round(hSlope, 4), lower_slope_pct_per_bar: round(lSlope, 4),
      touches_high: highs.length, touches_low: lows.length,
      height: round(height), width_start: round(widthStart), width_end: round(widthEnd),
      converging, diverging,
    },
    from_time: bars[first]?.time ?? null,
    to_time: last.time,
    note,
  }];
}

/* ------------------------------ entry point --------------------------- */

export const CANDLE_PATTERNS = [
  'doji', 'dragonfly_doji', 'gravestone_doji', 'long_legged_doji', 'four_price_doji',
  'bullish_momentum_candle', 'bearish_momentum_candle', 'hammer', 'hanging_man', 'shooting_star', 'inverted_hammer',
  'bullish_engulfing', 'bearish_engulfing', 'harami',
  'dark_cloud_cover', 'piercing_line', 'inside_bar', 'gap_up', 'gap_down',
  'NR4', 'NR7',
];
/* ---------------------- measured structural statistics ------------------ */

/**
 * Bulkowski's measured statistics for the chart patterns this file detects.
 *
 * Extracted from the Results Snapshot of each chapter in the Encyclopedia of
 * Chart Patterns (2nd ed., 2005) — his own measurements over thousands of
 * patterns, not folklore. Until now every structural detection here reported
 * "no measured success rate", which was honest but unhelpful when the numbers
 * exist and the user owns the book.
 *
 * Fields, all as percentages:
 *   rank                    performance rank among his pattern set, 1 = best
 *   break_even_failure_pct  how often price fails to move even 5% after the break
 *   average_move_pct        average rise (up breakouts) or decline (down breakouts)
 *   meeting_target_pct      how often the measured-move target is reached
 *   throwback_pullback_pct  how often price returns to the breakout level first
 *
 * Split by BREAKOUT DIRECTION and by BULL/BEAR market, because that split is
 * the most valuable thing in the data and the part folklore omits entirely. A
 * rising wedge breaking down fails 24% of the time in a bull market; the same
 * pattern is presented everywhere as simply "bearish".
 *
 * `_range` fields mean Bulkowski measured sub-variants this detector does not
 * distinguish — the four Adam/Eve double top and bottom combinations, and the
 * top/bottom split for rectangles and broadening formations. The range is
 * reported rather than an average, because an average across variants is a
 * number he never measured.
 *
 * Extraction note: the values were parsed from the PDF's two-column layout and
 * validated by field SHAPE — a rank must read "N out of M", a volume trend must
 * be Upward/Downward/Flat, the rest must be percentages. That check caught a
 * block where a "Flat" volume trend shifted every subsequent row by one and
 * turned a 44% target rate into 1%. A shifted row is worse than missing data
 * because it is wrong without looking wrong.
 */
export const STRUCTURAL_STATS = {
  ascending_triangle: {
    downward: {
      bull: { rank: '9/21', break_even_failure_pct: 11, average_move_pct: 19, meeting_target_pct: 68, throwback_pullback_pct: 49 },
      bear: { rank: '9/21', break_even_failure_pct: 3, average_move_pct: 24, meeting_target_pct: 66, throwback_pullback_pct: 45 },
    },
    upward: {
      bull: { rank: '17/23', break_even_failure_pct: 13, average_move_pct: 35, meeting_target_pct: 75, throwback_pullback_pct: 57 },
      bear: { rank: '11/19', break_even_failure_pct: 12, average_move_pct: 30, meeting_target_pct: 63, throwback_pullback_pct: 54 },
    },
  },
  bear_flag: {
    downward: {
      bull: { rank: null, break_even_failure_pct: 2, average_move_pct: 16, meeting_target_pct: 47, throwback_pullback_pct: 46 },
      bear: { rank: null, break_even_failure_pct: 0, average_move_pct: 25, meeting_target_pct: 54, throwback_pullback_pct: 44 },
    },
  },
  broadening_formation: {
    downward: {
      bull: { break_even_failure_pct_range: [16, 18], average_move_pct_range: [15, 15], meeting_target_pct_range: [37, 44], throwback_pullback_pct_range: [42, 48] },
      bear: { break_even_failure_pct_range: [3, 9], average_move_pct_range: [18, 20], meeting_target_pct_range: [31, 32], throwback_pullback_pct_range: [56, 62] },
    },
    upward: {
      bull: { break_even_failure_pct_range: [10, 15], average_move_pct_range: [27, 29], meeting_target_pct_range: [59, 62], throwback_pullback_pct_range: [41, 54] },
      bear: { break_even_failure_pct_range: [9, 11], average_move_pct_range: [21, 24], meeting_target_pct_range: [53, 61], throwback_pullback_pct_range: [44, 53] },
    },
  },
  bull_flag: {
    upward: {
      bull: { rank: null, break_even_failure_pct: 4, average_move_pct: 23, meeting_target_pct: 64, throwback_pullback_pct: 43 },
      bear: { rank: null, break_even_failure_pct: 3, average_move_pct: 17, meeting_target_pct: 55, throwback_pullback_pct: 53 },
    },
  },
  descending_triangle: {
    downward: {
      bull: { rank: '10/21', break_even_failure_pct: 16, average_move_pct: 16, meeting_target_pct: 54, throwback_pullback_pct: 54 },
      bear: { rank: '12/21', break_even_failure_pct: 11, average_move_pct: 25, meeting_target_pct: 50, throwback_pullback_pct: 59 },
    },
    upward: {
      bull: { rank: '5/23', break_even_failure_pct: 7, average_move_pct: 47, meeting_target_pct: 84, throwback_pullback_pct: 37 },
      bear: { rank: '7/19', break_even_failure_pct: 9, average_move_pct: 27, meeting_target_pct: 61, throwback_pullback_pct: 52 },
    },
  },
  double_bottom: {
    upward: {
      bull: { break_even_failure_pct_range: [4, 5], average_move_pct_range: [35, 40], meeting_target_pct_range: [66, 67], throwback_pullback_pct_range: [55, 64] },
      bear: { break_even_failure_pct_range: [4, 8], average_move_pct_range: [23, 33], meeting_target_pct_range: [47, 56], throwback_pullback_pct_range: [46, 61] },
    },
  },
  double_top: {
    downward: {
      bull: { break_even_failure_pct_range: [8, 14], average_move_pct_range: [15, 19], meeting_target_pct_range: [69, 73], throwback_pullback_pct_range: [59, 64] },
      bear: { break_even_failure_pct_range: [2, 11], average_move_pct_range: [19, 25], meeting_target_pct_range: [68, 79], throwback_pullback_pct_range: [48, 58] },
    },
  },
  falling_wedge: {
    downward: {
      bull: { rank: '17/21', break_even_failure_pct: 15, average_move_pct: 15, meeting_target_pct: 30, throwback_pullback_pct: 69 },
      bear: { rank: '7/21', break_even_failure_pct: 6, average_move_pct: 24, meeting_target_pct: 36, throwback_pullback_pct: 72 },
    },
    upward: {
      bull: { rank: '20/23', break_even_failure_pct: 11, average_move_pct: 32, meeting_target_pct: 70, throwback_pullback_pct: 56 },
      bear: { rank: '11/19', break_even_failure_pct: 11, average_move_pct: 26, meeting_target_pct: 60, throwback_pullback_pct: 61 },
    },
  },
  head_and_shoulders: {
    downward: {
      bull: { rank: '1/21', break_even_failure_pct: 4, average_move_pct: 22, meeting_target_pct: 55, throwback_pullback_pct: 50 },
      bear: { rank: '6/21', break_even_failure_pct: 1, average_move_pct: 29, meeting_target_pct: 56, throwback_pullback_pct: 64 },
    },
  },
  inverse_head_and_shoulders: {
    upward: {
      bull: { rank: '7/23', break_even_failure_pct: 3, average_move_pct: 38, meeting_target_pct: 74, throwback_pullback_pct: 45 },
      bear: { rank: '6/19', break_even_failure_pct: 4, average_move_pct: 30, meeting_target_pct: 58, throwback_pullback_pct: 51 },
    },
  },
  rectangle: {
    downward: {
      bull: { break_even_failure_pct_range: [11, 16], average_move_pct_range: [14, 17], meeting_target_pct_range: [50, 63], throwback_pullback_pct_range: [58, 69] },
      bear: { break_even_failure_pct_range: [4, 9], average_move_pct_range: [21, 25], meeting_target_pct_range: [63, 66], throwback_pullback_pct_range: [53, 65] },
    },
    upward: {
      bull: { break_even_failure_pct_range: [9, 10], average_move_pct_range: [39, 46], meeting_target_pct_range: [80, 85], throwback_pullback_pct_range: [53, 64] },
      bear: { break_even_failure_pct_range: [11, 16], average_move_pct_range: [20, 24], meeting_target_pct_range: [60, 64], throwback_pullback_pct_range: [60, 71] },
    },
  },
  rising_wedge: {
    downward: {
      bull: { rank: '20/21', break_even_failure_pct: 24, average_move_pct: 14, meeting_target_pct: 46, throwback_pullback_pct: 63 },
      bear: { rank: '21/21', break_even_failure_pct: 15, average_move_pct: 20, meeting_target_pct: 40, throwback_pullback_pct: 63 },
    },
    upward: {
      bull: { rank: '18/23', break_even_failure_pct: 8, average_move_pct: 28, meeting_target_pct: 58, throwback_pullback_pct: 73 },
      bear: { rank: '17/19', break_even_failure_pct: 14, average_move_pct: 17, meeting_target_pct: 33, throwback_pullback_pct: 66 },
    },
  },
  symmetrical_triangle: {
    downward: {
      bull: { rank: '15/21', break_even_failure_pct: 13, average_move_pct: 17, meeting_target_pct: 48, throwback_pullback_pct: 59 },
      bear: { rank: '18/21', break_even_failure_pct: 9, average_move_pct: 19, meeting_target_pct: 42, throwback_pullback_pct: 62 },
    },
    upward: {
      bull: { rank: '16/23', break_even_failure_pct: 9, average_move_pct: 31, meeting_target_pct: 66, throwback_pullback_pct: 37 },
      bear: { rank: '7/19', break_even_failure_pct: 7, average_move_pct: 26, meeting_target_pct: 57, throwback_pullback_pct: 55 },
    },
  },
  triple_bottom: {
    upward: {
      bull: { rank: '7/23', break_even_failure_pct: 4, average_move_pct: 37, meeting_target_pct: 64, throwback_pullback_pct: 64 },
      bear: { rank: '8/19', break_even_failure_pct: 8, average_move_pct: 23, meeting_target_pct: 57, throwback_pullback_pct: 61 },
    },
  },
  triple_top: {
    downward: {
      bull: { rank: '7/21', break_even_failure_pct: 10, average_move_pct: 19, meeting_target_pct: 40, throwback_pullback_pct: 61 },
      bear: { rank: '12/21', break_even_failure_pct: 5, average_move_pct: 24, meeting_target_pct: 51, throwback_pullback_pct: 64 },
    },
  },
};

/**
 * Measured statistics for a detected pattern.
 *
 * `direction` is the breakout direction; `market` is the broader regime, which
 * the caller has to supply because a chart of one symbol cannot know it. Both
 * default to the pattern's conventional reading, and the answer says which
 * assumptions it used.
 */
export function statsFor(pattern, { direction = null, market = 'bull' } = {}) {
  const entry = STRUCTURAL_STATS[pattern];
  if (!entry) return null;

  const dir = direction && entry[direction] ? direction : Object.keys(entry)[0];
  const mkt = market === 'bear' ? 'bear' : 'bull';
  const s = entry[dir]?.[mkt];
  if (!s) return null;

  const ranged = 'break_even_failure_pct_range' in s;
  const fail = ranged ? s.break_even_failure_pct_range : s.break_even_failure_pct;
  const target = ranged ? s.meeting_target_pct_range : s.meeting_target_pct;
  const move = ranged ? s.average_move_pct_range : s.average_move_pct;
  const pct = (v) => (Array.isArray(v) ? `${v[0]}-${v[1]}%` : `${v}%`);

  return {
    ...s,
    breakout_direction: dir,
    market_assumed: mkt,
    directions_measured: Object.keys(entry),
    summary: `Measured over Bulkowski's sample: fails to move 5% ${pct(fail)} of the time, average ${dir === 'upward' ? 'rise' : 'decline'} ${pct(move)}, reaches the measured-move target ${pct(target)} of the time.`,
    ...(ranged ? { range_note: 'A range because Bulkowski measured sub-variants this detector does not distinguish. The range is reported rather than an average, which is a number he never measured.' } : {}),
    ...(entry.upward && entry.downward ? {
      both_directions: 'This pattern was measured breaking BOTH ways. Do not assume the conventional direction — pass the direction price actually broke.',
    } : {}),
    market_note: mkt === 'bull'
      ? 'Bull-market figures. Pass market:"bear" for the other set — the difference is often large and is the part folklore omits.'
      : 'Bear-market figures.',
    source: 'Bulkowski, Encyclopedia of Chart Patterns, 2nd ed. (2005). His measurements, not measurements made here.',
  };
}

export const STRUCTURAL_PATTERNS = [
  'double_top', 'double_bottom', 'triple_top', 'triple_bottom',
  'head_and_shoulders', 'inverse_head_and_shoulders',
  'ascending_triangle', 'descending_triangle', 'symmetrical_triangle',
  'rectangle', 'rising_wedge', 'falling_wedge', 'broadening_formation',
  'bull_flag', 'bear_flag',
];

/**
 * Detect patterns across a bar series.
 *
 * `recent_bars` limits candlestick scanning to the tail — a doji 300 bars ago
 * is noise, and returning every one of them would bury the ones that matter.
 * Structural patterns are searched across the whole series, since a
 * head-and-shoulders takes many bars to form.
 */
export function detectPatterns(bars, {
  recent_bars = 10,
  lookback = 5,
  peak_tolerance_pct = 2,
  max_age_bars = 60,
  window_bars = 60,
  flat_slope_pct = 0.05,
  doji_body_pct = 10,
  wick_ratio = 2,
  small_body_pct = 30,
  include = null,
  market = 'bull',
} = {}) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return { candlestick: [], structural: [], note: 'Not enough bars to detect anything.' };
  }

  const opts = { doji_body_pct, wick_ratio, small_body_pct, peak_tolerance_pct };
  const start = Math.max(1, bars.length - recent_bars);

  const candlestick = [];
  for (let i = start; i < bars.length; i++) {
    candlestick.push(...candlesAt(bars, i, opts));
    for (const n of [4, 7]) {
      const nr = narrowRangeAt(bars, i, n);
      if (nr) candlestick.push(nr);
    }
  }

  const swings = findSwings(bars, { lookback });
  const all = [
    ...structuralPatterns(bars, swings, opts),
    ...trendlinePatterns(bars, swings, { window_bars, flat_slope_pct, min_touches: 2 }),
  ];

  // Age every pattern by how long ago it finished forming. Without this the
  // output is dominated by shapes from hundreds of bars back, at prices far
  // from anything current — history presented as findings, which is the same
  // "patterns everywhere" failure wearing a different hat.
  const lastIndex = bars.length - 1;
  const lastTime = bars[lastIndex].time;
  for (const p of all) {
    const endIdx = bars.findIndex((b) => b.time === p.to_time);
    p.bars_ago = endIdx >= 0 ? lastIndex - endIdx : null;
  }

  const limit = Number.isFinite(max_age_bars) && max_age_bars > 0 ? max_age_bars : Infinity;
  const recent = all.filter((p) => p.bars_ago == null || p.bars_ago <= limit);
  const tooOld = all.length - recent.length;

  const wanted = Array.isArray(include) && include.length ? new Set(include) : null;
  const filter = (list) => (wanted ? list.filter((p) => wanted.has(p.pattern)) : list);

  // Newest first — the most recent shape is the one being acted on.
  const cs = filter(candlestick).sort((a, b) => b.index - a.index);

  // Nison's context and confirmation rules. Detection says the shape is there;
  // this says whether it is a pattern at all, and whether its author would
  // consider it actionable yet.
  for (const p of cs) {
    const n = nisonCheck(p.pattern, bars, p.index);
    if (n) p.nison = n;
  }
  const st = filter(recent).sort((a, b) => (a.bars_ago ?? 1e9) - (b.bars_ago ?? 1e9));

  // Attach Bulkowski's measured statistics. Only to CONFIRMED patterns: his
  // figures are all measured from the breakout onward, so quoting them against
  // a shape that has not broken out yet applies a number to an event that has
  // not happened.
  for (const p of st) {
    if (p.status !== 'confirmed') {
      p.stats_note = 'No measured statistics attached: Bulkowski measures from the breakout onward, and this pattern has not broken out. The numbers do not apply to a forming shape.';
      continue;
    }
    const dir = p.breakout_direction
      || (p.direction === 'bullish' ? 'upward' : p.direction === 'bearish' ? 'downward' : null);
    const s = statsFor(p.pattern, { direction: dir, market });
    if (s) p.measured = s;
  }

  return {
    candlestick: cs,
    structural: st,
    swings_detected: swings.length,
    bars_analyzed: bars.length,
    candles_scanned: bars.length - start,
    last_bar_time: lastTime,
    confirmed_count: st.filter((p) => p.status === 'confirmed').length,
    forming_count: st.filter((p) => p.status === 'forming').length,
    ...(tooOld ? { excluded_old: `${tooOld} pattern(s) finished more than ${limit} bars ago and were excluded as history. Raise max_age_bars to include them.` } : {}),
    ...(st.length ? {} : { structural_note: 'No structural pattern within the age window. That is a normal result — most of the time there isn\'t one.' }),
  };
}
