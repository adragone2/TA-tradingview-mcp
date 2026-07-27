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
 *
 * ── The academic verdict, which is worse ──
 *
 * Bulkowski's figures describe how often a shape is FOLLOWED by a move. That
 * is not the same question as whether trading the shape makes money against a
 * proper null, and two peer-reviewed studies have asked the second question
 * and answered no. See CANDLE_ACADEMIC_EVIDENCE below. Both are reported
 * alongside every candlestick detection, because a 60% reliability figure
 * quoted without them reads as an edge that two independent tests could not
 * find.
 */

/**
 * What happens when candlesticks are tested against a proper null.
 *
 * Marshall, Young & Rose (2006), Journal of Banking & Finance 30, 2303-2323,
 * tested candlestick strategies on DJIA stocks using a bootstrap that
 * generates random OPEN, HIGH, LOW and CLOSE series — the right null for a
 * pattern defined by the relationship between those four prices, and an
 * advance on earlier methods that could only randomise closes. They found
 * candlestick trading strategies do not have value for DJIA stocks.
 *
 * Marshall, Young & Cahan (2008), Review of Quantitative Finance and
 * Accounting 31, 191-207, repeated it in the market that invented the
 * technique: the largest 100 stocks on the Tokyo Stock Exchange, 1975-2004.
 * No evidence candlestick strategies add value **in the entire 30-year period,
 * in any of three 10-year sub-periods, or in bull or bear markets.**
 *
 * This is the most direct academic test of anything in this file, it was run
 * twice on two continents, and it came back negative both times. Candlestick
 * detections here should be treated as descriptions of what a bar did, not as
 * signals.
 */
export const CANDLE_ACADEMIC_EVIDENCE = {
  us: {
    source: 'Marshall, Young & Rose (2006), Journal of Banking & Finance 30, 2303-2323',
    market: 'DJIA stocks',
    method: 'Bootstrap generating random open, high, low AND close prices — the correct null for OHLC-defined patterns',
    result: 'Candlestick trading strategies do not have value for DJIA stocks.',
  },
  japan: {
    source: 'Marshall, Young & Cahan (2008), Review of Quantitative Finance and Accounting 31, 191-207',
    market: 'Largest 100 stocks on the Tokyo Stock Exchange, 1975-2004',
    result: 'No evidence candlestick strategies add value in the whole 30-year period, in any 10-year sub-period, '
      + 'or in bull or bear markets.',
    why_it_matters: 'Run in the market where the technique originated, over 30 years, split every way that might have '
      + 'rescued it.',
  },
  how_to_read_our_stats: 'Bulkowski measures how often a shape is FOLLOWED by a move. These studies test whether trading '
    + 'the shape beats a random-OHLC null. Those are different questions, and the second one answers no. Report a '
    + 'candlestick as a description of what the bar did — momentum, reaction or indecision — not as a signal.',
};

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

/**
 * Bulkowski's measured statistics for the narrow-range patterns, from
 * thepatternsite.com/nr7.html — 1,201 stocks, January 1990 to March 2013.
 *
 * These belong next to every squeeze call. A volatility contraction reads as a
 * coiled spring and gets described that way; the measured up-breakout in a
 * bull market fails to move 5% **46% of the time**, and the trading win rate
 * is 57%. Neither number is visible from the chart, and an NR7 flagged without
 * them invites a confidence the data does not support.
 *
 * Bulkowski's own note: "The failure rates may appear high, but that's typical
 * for short-term patterns like the NR7."
 */
export const NARROW_RANGE_STATS = {
  NR7: {
    source: 'thepatternsite.com/nr7.html, 1201 stocks, Jan 1990 - Mar 2013, sampling one trade every 25',
    bull_market: {
      up_breakout: { failure_rate_pct: 46, average_move_pct: 7, measure_rule_success_pct: 43, win_rate_pct: 57, avg_hold_days: 31 },
      down_breakout: { failure_rate_pct: 47, average_move_pct: -6, measure_rule_success_pct: 37, win_rate_pct: 45, avg_hold_days: 25 },
    },
    bear_market: {
      up_breakout: { failure_rate_pct: 40, average_move_pct: 8, measure_rule_success_pct: 32 },
      down_breakout: { failure_rate_pct: 27, average_move_pct: -12, measure_rule_success_pct: 39 },
    },
    authors_caveat: 'The failure rates may appear high, but that is typical for short-term patterns like the NR7.',
  },
};

/** Narrow-range pattern: this bar's range is the smallest of the last N. */
function narrowRangeAt(bars, i, n) {
  if (i < n - 1) return null;
  const r = bars[i].high - bars[i].low;
  for (let k = i - n + 1; k < i; k++) {
    if (bars[k].high - bars[k].low <= r) return null;
  }
  const window = bars.slice(i - n + 1, i + 1);
  const stats = NARROW_RANGE_STATS[`NR${n}`];
  return {
    index: i, time: bars[i].time, pattern: `NR${n}`, bars: n, direction: 'neutral',
    prior_trend: priorTrend(bars, i),
    meaning: `narrowest range of the last ${n} bars — volatility compressed, and new trends often start here`,
    measurements: { range: round(r), widest_in_window: round(Math.max(...window.map((b) => b.high - b.low))) },
    breakout_levels: { above: round(bars[i].high), below: round(bars[i].low) },
    ...(stats ? {
      measured: stats,
      base_rate_warning: `Measured on ${stats.source.split(',')[1].trim()}: an up breakout in a bull market fails to move 5% `
        + `${stats.bull_market.up_breakout.failure_rate_pct}% of the time, with a ${stats.bull_market.up_breakout.win_rate_pct}% `
        + `trading win rate and a ${stats.bull_market.up_breakout.average_move_pct}% average rise. A squeeze is a setup, not a direction.`,
    } : {
      base_rate_warning: `No measured statistics exist for NR${n} in this toolchain. NR7 is the variant Bulkowski measured; `
        + `treat NR${n} as a description of volatility, not as a pattern with a known base rate.`,
    }),
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

/**
 * Flags, and the high tight flag, detected properly.
 *
 * These were previously left to `trendlinePatterns`, which fits two lines across
 * a fixed window. That cannot work: a flag is a SHORT consolidation attached to
 * a sharp prior move, and fitting lines over a 60-90 bar window never isolates
 * the 3-15 bar pause. Measured, the old branch detected flags 0% of the time at
 * every noise level, in both directions.
 *
 * This looks for the structure a flag actually is:
 *
 *   POLE          a sharp move, `min_pole_pct` or more over `max_pole_bars`
 *   FLAG          a short consolidation, 3 to `max_flag_bars`, retracing less
 *                 than `max_retrace_pct` of the pole
 *   CONFIRMATION  a close beyond the flag, in the direction of the pole
 *
 * The HIGH TIGHT FLAG is Bulkowski's own variant and the only one worth much:
 * price must rise at least 90% in two months or less, and it confirms on a
 * close above the highest peak in the pattern. His figures separate them
 * sharply — an ordinary flag fails 44% of the time and is unranked; the high
 * tight flag fails 15% and reaches its target 82% of the time, the best hit
 * rate of any pattern here. Its measure rule is also different: HALF the pole
 * added to the flag bottom, not the whole pole.
 */
function flagPatterns(bars, {
  min_pole_pct = 15,
  max_pole_bars = 25,
  max_flag_bars = 15,
  max_retrace_pct = 50,
  htf_pole_pct = 90,
  htf_pole_bars = 42,
} = {}) {
  const out = [];
  const n = bars.length;
  if (n < 20) return out;

  const last = bars[n - 1];

  // Walk back over plausible flag lengths, and for each, look for a pole
  // immediately before it.
  for (let flagLen = 3; flagLen <= Math.min(max_flag_bars, n - 10); flagLen++) {
    const flag = bars.slice(n - flagLen, n);
    const flagHigh = Math.max(...flag.map((b) => b.high));
    const flagLow = Math.min(...flag.map((b) => b.low));

    // Take the LARGEST qualifying pole, not the first. Breaking on the first
    // match found the SHORTEST pole that cleared the minimum, which capped
    // every move at just over the threshold and made a high tight flag —
    // defined by a 90% pole — impossible to ever detect.
    let bestPole = null;
    for (let poleLen = 5; poleLen <= Math.min(max_pole_bars, n - flagLen); poleLen++) {
      const p0 = bars.slice(n - flagLen - poleLen, n - flagLen);
      if (p0.length < 5) continue;
      const mv = ((p0[p0.length - 1].close - p0[0].close) / p0[0].close) * 100;
      if (Math.abs(mv) < min_pole_pct) continue;
      if (!bestPole || Math.abs(mv) > Math.abs(bestPole.movePct)) bestPole = { pole: p0, poleLen, movePct: mv };
    }
    {
      if (!bestPole) continue;
      const { pole, poleLen, movePct } = bestPole;
      const poleStart = pole[0].close, poleEnd = pole[pole.length - 1].close;
      const up = movePct > 0;

      // The flag must retrace only part of the pole, and lean against it.
      const poleRange = Math.abs(poleEnd - poleStart);
      const retrace = up ? (poleEnd - flagLow) / poleRange : (flagHigh - poleEnd) / poleRange;
      if (!(retrace >= 0 && retrace * 100 <= max_retrace_pct)) continue;

      const isHTF = up && movePct >= htf_pole_pct && poleLen <= htf_pole_bars;
      const completion = up ? flagHigh : flagLow;
      const status = up
        ? (last.close > completion ? 'confirmed' : 'forming')
        : (last.close < completion ? 'confirmed' : 'forming');

      // High tight flag takes HALF the pole from the flag bottom; an ordinary
      // flag takes the whole pole from the breakout.
      const target = isHTF
        ? round(flagLow + poleRange / 2)
        : round(up ? completion + poleRange : completion - poleRange);

      out.push({
        pattern: isHTF ? 'high_tight_flag' : (up ? 'bull_flag' : 'bear_flag'),
        type: 'continuation',
        direction: up ? 'bullish' : 'bearish',
        status,
        bars: flagLen + poleLen,
        bars_ago: 0,
        completion_level: round(completion),
        target,
        ...(isHTF
          ? { target_basis: 'high tight flag: HALF the pole added to the flag bottom, which is Bulkowskis own measure rule for this pattern' }
          : {}),
        measurements: {
          pole_pct: round(movePct, 2),
          pole_bars: poleLen,
          flag_bars: flagLen,
          retrace_pct: round(retrace * 100, 1),
          flag_high: round(flagHigh),
          flag_low: round(flagLow),
        },
        from_time: pole[0].time,
        to_time: last.time,
        note: isHTF
          ? 'Price rose at least 90% in two months or less, then paused. The strongest continuation pattern in the measured set — 15% failure, 82% reaching target — and the rarest.'
          : 'A short pause attached to a sharp move. Ordinary flags are weak on measured data: 44% fail to move even 5%, and they are unranked.',
      });
    }
  }

  // Keep the best candidate per pattern name: the one with the biggest pole.
  const best = new Map();
  for (const f of out) {
    const prev = best.get(f.pattern);
    if (!prev || Math.abs(f.measurements.pole_pct) > Math.abs(prev.measurements.pole_pct)) best.set(f.pattern, f);
  }
  return [...best.values()];
}

/**
 * Bulkowski's identification guidelines, as thresholds.
 *
 * Detection previously required only that two swings sat within a price
 * tolerance of each other. Measured against random walks that produced 19
 * patterns per 200 bars — about five double tops and five double bottoms in
 * pure noise. The shape test alone is nowhere near enough.
 *
 * These are his numbers, not invented ones:
 *
 *   valley depth   "the valley drop between the tops should measure at least
 *                   10%, but allow exceptions"
 *   separation     "the twin peaks are usually several weeks apart" (16 days
 *                   is his stated median for bottoms)
 *   price variance "the variation between price peaks is small, usually less
 *                   than 3%"
 *   prior trend    upward into a double top, downward into a double bottom
 *
 * The valley requirement does most of the work. A random walk throws up pairs
 * of similar highs constantly; it throws up pairs separated by a genuine 10%
 * retracement far less often.
 */
const ID_DEFAULTS = {
  min_valley_pct: 10,
  // Bulkowski's "16 days is the median" is DESCRIPTIVE, not a floor — using a
  // median as a minimum rejects half of all real patterns by construction.
  // Swept against random walks and it changed the noise rate not at all: 0.9
  // per walk at 6, 8, 10, 12 and 16 bars alike. The valley requirement does
  // all the work. So the floor is token, only enough to stop two adjacent
  // swings pairing up, and the actual separation is reported instead.
  min_separation_bars: 5,
  require_prior_trend: true,
};

function structuralPatterns(bars, swings, opts) {
  const {
    peak_tolerance_pct = 2,
    min_valley_pct = ID_DEFAULTS.min_valley_pct,
    min_separation_bars = ID_DEFAULTS.min_separation_bars,
    require_prior_trend = ID_DEFAULTS.require_prior_trend,
  } = opts;
  const alt = alternateSwings(swings);
  const found = [];
  const last = bars[bars.length - 1];

  /** Retracement between the two extremes, as a percent of the extreme. */
  const valleyPct = (extreme, middle) => (Math.abs(extreme - middle) / Math.abs(extreme)) * 100;

  /** Trend into the pattern, measured over the bars before it starts. */
  const trendInto = (index, want) => {
    if (!require_prior_trend) return true;
    const lookback = Math.min(40, index);
    // Not enough history to judge is UNKNOWN, not "no trend". Rejecting on
    // insufficient data silently drops real patterns near the start of the
    // series — the same mistake strategy_check refuses to make with operands.
    if (lookback < 5) return true;
    const from = bars[index - lookback].close, to = bars[index].close;
    const change = ((to - from) / from) * 100;
    return want === 'up' ? change > 3 : change < -3;
  };

  const confirm = (level, direction) => {
    // "Completed" means price CLOSED through the level, not merely touched it.
    const broken = direction === 'down' ? last.close < level : last.close > level;
    return broken ? 'confirmed' : 'forming';
  };

  for (let i = 0; i + 2 < alt.length; i++) {
    const [a, b, c] = [alt[i], alt[i + 1], alt[i + 2]];

    // Double top: high - low - high, the two highs at roughly one price.
    if (a.kind === 'high' && c.kind === 'high' && pct(a.price, c.price) <= peak_tolerance_pct
        && c.index - a.index >= min_separation_bars
        && valleyPct(Math.max(a.price, c.price), b.price) >= min_valley_pct
        && trendInto(a.index, 'up')) {
      const neck = b.price;
      const height = Math.max(a.price, c.price) - neck;
      found.push({
        pattern: 'double_top', type: 'reversal', direction: 'bearish', bars: c.index - a.index + 1,
        status: confirm(neck, 'down'),
        completion_level: round(neck),
        target: round(neck - height),
        measurements: { peak_1: round(a.price), peak_2: round(c.price), trough: round(neck), peak_difference_pct: round(pct(a.price, c.price), 2), height: round(height), valley_pct: round(valleyPct(Math.max(a.price, c.price), b.price), 1), separation_bars: c.index - a.index },
        from_time: a.time, to_time: c.time,
        note: 'Completes on a close below the trough between the peaks. Target is the height projected down from it.',
      });
    }

    // Double bottom: low - high - low.
    if (a.kind === 'low' && c.kind === 'low' && pct(a.price, c.price) <= peak_tolerance_pct
        && c.index - a.index >= min_separation_bars
        && valleyPct(Math.min(a.price, c.price), b.price) >= min_valley_pct
        && trendInto(a.index, 'down')) {
      const neck = b.price;
      const height = neck - Math.min(a.price, c.price);
      found.push({
        pattern: 'double_bottom', type: 'reversal', direction: 'bullish', bars: c.index - a.index + 1,
        status: confirm(neck, 'up'),
        completion_level: round(neck),
        target: round(neck + height),
        measurements: { trough_1: round(a.price), trough_2: round(c.price), peak: round(neck), trough_difference_pct: round(pct(a.price, c.price), 2), height: round(height), valley_pct: round(valleyPct(Math.min(a.price, c.price), b.price), 1), separation_bars: c.index - a.index },
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
      if (pct(p1.price, p2.price) <= peak_tolerance_pct && pct(p2.price, p3.price) <= peak_tolerance_pct
          && p3.index - p1.index >= min_separation_bars
          && valleyPct(Math.max(p1.price, p2.price, p3.price), Math.min(t1.price, t2.price)) >= min_valley_pct
          && trendInto(p1.index, 'up')) {
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
      if (p2.price > p1.price && p2.price > p3.price && pct(p1.price, p3.price) <= peak_tolerance_pct * 1.5
          && p3.index - p1.index >= min_separation_bars
          && valleyPct(p2.price, Math.min(t1.price, t2.price)) >= min_valley_pct
          && trendInto(p1.index, 'up')) {
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
      if (pct(t1.price, t2.price) <= peak_tolerance_pct && pct(t2.price, t3.price) <= peak_tolerance_pct
          && t3.index - t1.index >= min_separation_bars
          && valleyPct(Math.min(t1.price, t2.price, t3.price), Math.max(p1.price, p2.price)) >= min_valley_pct
          && trendInto(t1.index, 'down')) {
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

      if (t2.price < t1.price && t2.price < t3.price && pct(t1.price, t3.price) <= peak_tolerance_pct * 1.5
          && t3.index - t1.index >= min_separation_bars
          && valleyPct(t2.price, Math.max(p1.price, p2.price)) >= min_valley_pct
          && trendInto(t1.index, 'down')) {
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
    // Flags are handled by flagPatterns(), which looks for a pole and a short
    // consolidation rather than fitting lines across a fixed window. Fitting
    // lines never isolated the 3-15 bar pause and detected flags 0% of the time.
    return [];
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

  // Which way the height projection points. Once price has actually broken out
  // the break decides; while the pattern is still FORMING there is no break to
  // read, so the projection has to follow the direction the pattern is expected
  // to resolve. Bilateral patterns have no expected direction and keep the
  // upward default they have always had.
  //
  // This was keyed on `brokeUp` alone, which is false for everything unbroken,
  // so every forming pattern projected DOWNWARD — a bullish falling wedge
  // reported an upward `target` next to a `target_projected_height` below
  // price. Caught on CSCO 1D, where a third-party TradingView indicator
  // independently produced the same 84.69 while labelling the shape a bearish
  // rising wedge. The agreement looked like corroboration and was coincidence:
  // both had arrived at `support - height` by different routes. A wrong-side
  // projection that happens to match another tool is a trap, not a check.
  const projectUp = status === 'confirmed' ? brokeUp : direction !== 'bearish';
  const projectedHeight = round(projectUp ? resistance + height : support - height);

  const isWedge = pattern === 'rising_wedge' || pattern === 'falling_wedge';
  const patternHigh = Math.max(...highs.map((h) => h.price));
  const patternLow = Math.min(...lows.map((l) => l.price));
  const touchTotal = highs.length + lows.length;

  return [{
    pattern, direction,
    ...(type ? { type } : {}),
    status,
    ...(avoid ? { avoid } : {}),
    ...(isWedge && touchTotal < 5
      ? { touch_warning: `A wedge needs price to touch its boundaries at least five times (three on one line, two on the other) before a breakout. This one has ${touchTotal}. Under-touched wedges are frequently just a channel.` }
      : {}),
    ...(status === 'confirmed' ? { broke: brokeUp ? 'up' : 'down' } : {}),
    bars: spanBars,
    bars_ago: 0,
    completion_level: round(completion),
    // Measure rule: the pattern's height projected from the breakout level —
    // EXCEPT for wedges, which are measured differently and where the standard
    // projection is materially too optimistic.
    //
    // Two independent sources agree on the wedge construction: the minimum
    // objective is to take out the pattern's OWN opposite extreme (its first
    // reversal point), not to project its height. A falling wedge aims to take
    // out the highest point in the pattern; a rising wedge, the lowest. That is
    // usually a much nearer target, and it matters here because the measured
    // data already says wedges are weak — a rising wedge breaking down fails
    // 24% of the time in a bull market and reaches its target only 46% of the
    // time. A too-generous target compounds that.
    ...(isWedge
      ? {
          target: round(direction === 'bearish' ? patternLow : patternHigh),
          target_basis: 'wedge rule: the opposite extreme of the pattern itself, not a projected height',
          target_projected_height: projectedHeight,
          target_note: 'The standard height projection is reported as target_projected_height for comparison. Both Kirkpatrick/Dahlquist and the price-pattern material define the wedge objective as taking out the opposite extreme of the pattern itself, which is the nearer and better-supported number.',
        }
      : { target: projectedHeight }),
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
 * Bulkowski's measured statistics, taken from thepatternsite.com (his own
 * site), read July 2026.
 *
 * REPLACED the figures previously parsed out of the 2005 2nd-edition PDF,
 * which disagreed with these materially and in the wrong direction. Three
 * things were wrong with them at once:
 *
 *   - Wrong edition. The pattern universe grew from 23/21 to 39/36, so the
 *     old ranks were not comparable to anything current.
 *   - Much smaller samples. These pages quote 599 to 3,197 perfect trades
 *     per pattern.
 *   - At least one parse error. Descending-triangle-upward came out of the
 *     PDF at rank 5/23 with an 84% target rate, the best figure in the whole
 *     old table; his site puts the same pattern at 33/39 with 64%.
 *
 * Corrections worth knowing, because the old numbers were quoted in this
 * repo as fact:
 *
 *   head-and-shoulders top   1/21, 4% failure   ->  9/36, 19% failure
 *   descending triangle up   5/23, 84% target   ->  33/39, 64% target
 *   rising wedge down        24% failure        ->  51% failure, rank LAST
 *   flags                    2-4% failure       ->  44-45% failure, unranked
 *
 * ── Two limits, both deliberate ──
 *
 * BULL MARKET ONLY. The site does not publish the bear-market split the book
 * does. Currency and sample size were judged worth more than a dimension
 * whose ranks came from an obsolete universe, but the loss is real and
 *  says so on every answer.
 *
 * PERFECT TRADES, GROSS OF COSTS. From his own methodology note: "the average
 * rise and decline are for hundreds of perfect trades without commissions or
 * fees deducted", measured from the open the day after the breakout to the
 * ultimate high or low before a 20% reversal. Every average_move_pct here is
 * therefore an upper bound measured to a peak unknowable at the time. Quote
 * them beside trade_cost, never alone.
 *
 *  fields mean he measures sub-variants this detector cannot tell
 * apart — the four Adam/Eve double combinations, and the top/bottom split for
 * rectangles and broadening formations. The range is reported rather than an
 * average, which is a number he never published.
 *
 * Source: thepatternsite.com, per-pattern pages, read July 2026.
 */
export const STRUCTURAL_STATS = {
  ascending_triangle: {
    downward: {
      rank: '30/36', break_even_failure_pct: 38, average_move_pct: 13, throwback_pullback_pct: 63, meeting_target_pct: 44, sample: '1400+',
    },
    upward: {
      rank: '16/39', break_even_failure_pct: 17, average_move_pct: 43, throwback_pullback_pct: 64, meeting_target_pct: 70, sample: '1400+',
    },
  },
  bear_flag: {
    downward: {
      rank: null, break_even_failure_pct: 45, average_move_pct: 8, throwback_pullback_pct: null, meeting_target_pct: 46, sample: 'hundreds',
    },
  },
  broadening_formation: {
    downward: {
      rank_range: '23-28/36', break_even_failure_pct_range: [26, 27], average_move_pct_range: [13, 15],
      throwback_pullback_pct_range: [62, 67], meeting_target_pct_range: [41, 42], sample: '405-804', variants: 'tops and bottoms',
    },
    upward: {
      rank_range: '15-22/39', break_even_failure_pct_range: [16, 18], average_move_pct_range: [42, 45],
      throwback_pullback_pct_range: [67, 69], meeting_target_pct_range: [65, 66], sample: '599-1215', variants: 'tops and bottoms',
    },
  },
  bull_flag: {
    upward: {
      rank: null, break_even_failure_pct: 44, average_move_pct: 9, throwback_pullback_pct: null, meeting_target_pct: 46, sample: 'hundreds',
    },
  },
  descending_triangle: {
    downward: {
      rank: '15/36', break_even_failure_pct: 23, average_move_pct: 15, throwback_pullback_pct: 58, meeting_target_pct: 50, sample: '1300+',
    },
    upward: {
      rank: '33/39', break_even_failure_pct: 22, average_move_pct: 38, throwback_pullback_pct: 60, meeting_target_pct: 64, sample: '1300+',
    },
  },
  double_bottom: {
    upward: {
      rank_range: '5-26/39', break_even_failure_pct_range: [12, 16], average_move_pct_range: [39, 50],
      throwback_pullback_pct_range: [65, 67], meeting_target_pct_range: [65, 73], sample: '759-1154 per variant', variants: 'Adam/Eve combinations',
    },
  },
  double_top: {
    downward: {
      rank_range: '10-19/36', break_even_failure_pct_range: [20, 25], average_move_pct_range: [15, 16],
      throwback_pullback_pct_range: [64, 65], meeting_target_pct_range: [43, 64], sample: '651-1114 per variant', variants: 'Adam/Eve combinations',
    },
  },
  falling_wedge: {
    downward: {
      rank: '27/36', break_even_failure_pct: 29, average_move_pct: 14, throwback_pullback_pct: 74, meeting_target_pct: 29, sample: '800+',
    },
    upward: {
      rank: '31/39', break_even_failure_pct: 26, average_move_pct: 38, throwback_pullback_pct: 62, meeting_target_pct: 62, sample: '800+',
    },
  },
  head_and_shoulders: {
    downward: {
      rank: '9/36', break_even_failure_pct: 19, average_move_pct: 16, throwback_pullback_pct: 68, meeting_target_pct: 51, sample: '2800+',
    },
  },
  high_tight_flag: {
    upward: {
      rank: '30/39', break_even_failure_pct: 15, average_move_pct: 39, throwback_pullback_pct: 67, meeting_target_pct: 82, sample: '1028',
    },
  },
  inverse_head_and_shoulders: {
    upward: {
      rank: '13/39', break_even_failure_pct: 11, average_move_pct: 45, throwback_pullback_pct: 65, meeting_target_pct: 71, sample: '3197',
    },
  },
  rectangle: {
    downward: {
      rank_range: '14-32/36', break_even_failure_pct_range: [24, 34], average_move_pct_range: [13, 16],
      throwback_pullback_pct_range: [64, 66], meeting_target_pct_range: [54, 55], sample: '900-1000+', variants: 'tops and bottoms',
    },
    upward: {
      rank_range: '4-8/39', break_even_failure_pct_range: [15, 15], average_move_pct_range: [48, 51],
      throwback_pullback_pct_range: [64, 66], meeting_target_pct_range: [78, 79], sample: '900-1000+', variants: 'tops and bottoms',
    },
  },
  rising_wedge: {
    downward: {
      rank: '36/36', break_even_failure_pct: 51, average_move_pct: 9, throwback_pullback_pct: 72, meeting_target_pct: 32, sample: '1400+',
    },
    upward: {
      rank: '32/39', break_even_failure_pct: 19, average_move_pct: 38, throwback_pullback_pct: 72, meeting_target_pct: 63, sample: '1400+',
    },
  },
  symmetrical_triangle: {
    downward: {
      rank: '34/36', break_even_failure_pct: 37, average_move_pct: 12, throwback_pullback_pct: 65, meeting_target_pct: 36, sample: '3000+',
    },
    upward: {
      rank: '36/39', break_even_failure_pct: 25, average_move_pct: 34, throwback_pullback_pct: 62, meeting_target_pct: 58, sample: '3000+',
    },
  },
  triple_bottom: {
    upward: {
      rank: '12/39', break_even_failure_pct: 13, average_move_pct: 46, throwback_pullback_pct: 65, meeting_target_pct: 74, sample: '2500+',
    },
  },
  triple_top: {
    downward: {
      rank: '24/36', break_even_failure_pct: 25, average_move_pct: 14, throwback_pullback_pct: 66, meeting_target_pct: 49, sample: '1964',
    },
  },
};

/**
 * Measured statistics for a detected pattern.
 *
 * `direction` is the breakout direction. There is no market parameter any more:
 * the source publishes bull-market figures only, and inventing a bear split
 * would be worse than not having one.
 */
export function statsFor(pattern, { direction = null } = {}) {
  const entry = STRUCTURAL_STATS[pattern];
  if (!entry) return null;

  const dir = direction && entry[direction] ? direction : Object.keys(entry)[0];
  const s = entry[dir];
  if (!s) return null;

  const ranged = 'break_even_failure_pct_range' in s;
  const fail = ranged ? s.break_even_failure_pct_range : s.break_even_failure_pct;
  const move = ranged ? s.average_move_pct_range : s.average_move_pct;
  const target = ranged ? s.meeting_target_pct_range : s.meeting_target_pct;
  const pctOf = (v) => (Array.isArray(v) ? `${v[0]}-${v[1]}%` : `${v}%`);

  return {
    ...s,
    breakout_direction: dir,
    directions_measured: Object.keys(entry),
    summary: `Measured over ${s.sample} trades in a BULL market: fails to move 5% ${pctOf(fail)} of the time, average ${dir === 'upward' ? 'rise' : 'decline'} ${pctOf(move)}, reaches the measured-move target ${pctOf(target)} of the time.`,
    ...(ranged ? { range_note: `A range because sub-variants (${s.variants}) are measured separately and this detector cannot tell them apart. The range is reported rather than an average, which was never published.` } : {}),
    ...(entry.upward && entry.downward ? {
      both_directions: 'Measured breaking BOTH ways. Do not assume the conventional direction — pass the direction price actually broke.',
    } : {}),
    market_note: 'BULL MARKET figures only. The source does not publish a bear-market split, so these do not describe how the pattern behaves in a downtrend.',
    cost_note: 'These are "perfect trades without commissions or fees deducted", measured from the open after the breakout to the ultimate high or low before a 20% reversal. average_move_pct is an upper bound to a peak unknowable at the time — quote it beside trade_cost, never alone.',
    source: 'thepatternsite.com (Bulkowski), read July 2026. His measurements, not measurements made here.',
  };
}


/**
 * How often each structural pattern appears in PURE NOISE.
 *
 * Measured with src/core/synthetic.js over 40 seeded random walks of 200 bars
 * each, at lookback 4 — the same settings detectPatterns uses by default.
 *
 * These are the numbers that decide whether a detection means anything.
 *
 * The first measurement was damning: 19.3 patterns per 200-bar random walk,
 * including about five double tops and five double bottoms, with something
 * firing on 100% of walks. That is precisely the failure mode the header of
 * this file warns about — "see patterns where there aren't any".
 *
 * Adding Bulkowski's own identification thresholds (a 10% valley between the
 * extremes, 16 bars of separation, a prior trend) took it to 0.78 per walk,
 * with double tops down from 5.13 to 0.03. Detection of constructed shapes was
 * unaffected: every pattern is still found 100% of the time at realistic noise.
 *
 * The floor is not zero and cannot be. `rectangle` and the wedges still appear
 * in noise, which is why the baseline is reported rather than assumed away.
 *
 * Re-measure with `node --test tests/synthetic.test.js` after any change to
 * detection thresholds.
 */
export const NOISE_BASELINE = {
  bars: 200,
  walks: 40,
  detections_per_walk: 0.78,
  walks_with_any_pattern_pct: 68,
  per_walk: {
    rectangle: 0.3,
    falling_wedge: 0.18,
    inverse_head_and_shoulders: 0.13,
    rising_wedge: 0.08,
    double_top: 0.03,
    triple_top: 0.03,
    ascending_triangle: 0.03,
    descending_triangle: 0.03,
  },
  previously: {
    detections_per_walk: 19.3,
    double_bottom: 5.15,
    double_top: 5.13,
    note: 'Before the identification filters were added. Kept so the size of the change is visible and a regression is obvious.',
  },
  note: 'Measured on seeded random walks, not on real data. A count at or below the baseline is indistinguishable from noise.',
};

/** Compare a detection count against the noise floor for that pattern. */
export function vsNoise(pattern, count, bars) {
  const base = NOISE_BASELINE.per_walk[pattern];
  if (base == null || !(bars > 0)) return null;
  const expected = base * (bars / NOISE_BASELINE.bars);
  return {
    found: count,
    expected_in_noise: Math.round(expected * 100) / 100,
    above_noise: count > expected,
    verdict: count > expected * 2
      ? `${count} found against ~${Math.round(expected * 10) / 10} expected in pure noise over ${bars} bars — clearly above the noise floor.`
      : count > expected
        ? `${count} found against ~${Math.round(expected * 10) / 10} expected in pure noise over ${bars} bars — only marginally above the floor.`
        : `${count} found against ~${Math.round(expected * 10) / 10} expected in PURE NOISE over ${bars} bars. This is at or below the noise floor and should not be read as a finding.`,
  };
}

export const STRUCTURAL_PATTERNS = [
  'double_top', 'double_bottom', 'triple_top', 'triple_bottom',
  'head_and_shoulders', 'inverse_head_and_shoulders',
  'ascending_triangle', 'descending_triangle', 'symmetrical_triangle',
  'rectangle', 'rising_wedge', 'falling_wedge', 'broadening_formation',
  'bull_flag', 'bear_flag', 'high_tight_flag',
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
    ...flagPatterns(bars, {}),
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
    const s = statsFor(p.pattern, { direction: dir });
    if (s) p.measured = s;
  }

  // Compare each pattern's count against how often it shows up in pure noise.
  const counts = {};
  for (const p of st) counts[p.pattern] = (counts[p.pattern] || 0) + 1;
  const noise_check = Object.entries(counts)
    .map(([pattern, n]) => ({ pattern, ...vsNoise(pattern, n, bars.length) }))
    .filter((x) => x.verdict);

  return {
    candlestick: cs,
    structural: st,
    ...(cs.length ? { candlestick_academic_evidence: CANDLE_ACADEMIC_EVIDENCE } : {}),
    noise_baseline: NOISE_BASELINE,
    ...(noise_check.length ? { noise_check } : {}),
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
