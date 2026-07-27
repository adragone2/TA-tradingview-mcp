/**
 * Relative strength — performance against a benchmark.
 *
 * Every other tool in this repo reads one symbol in isolation and can therefore
 * never answer "compared to what". A stock up 8% in a month looks strong until
 * its index is up 12%, at which point it is a laggard being described as a
 * winner. Pring treats this as a full chapter and calls it underappreciated;
 * it was entirely absent here.
 *
 * ── The distinction that trips people up ──
 *
 * This is NOT Wilder's RSI. They share three letters and nothing else:
 *
 *   RSI               one symbol against ITS OWN past. An oscillator, 0-100.
 *   relative strength one symbol against ANOTHER symbol. A ratio, unbounded.
 *
 * `rsi()` lives in strategy.js and answers a different question entirely. The
 * confusion is common enough that the output says so explicitly.
 *
 * ── How it is read ──
 *
 * The RS line is price ÷ benchmark, and it is analysed with the SAME tools as
 * price: trend, breakouts, divergence. The valuable case is when the two
 * disagree — price making a new high while RS does not means the advance is
 * being led by the market rather than by the stock, and it is the thing a
 * single-symbol chart structurally cannot show.
 *
 * All pure.
 */
import { findSwings, alternateSwings, classifyStructure } from './structure.js';

const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Common benchmarks, so a caller does not have to guess a ticker. */
export const BENCHMARKS = {
  us_broad: 'AMEX:SPY',
  us_tech: 'NASDAQ:QQQ',
  us_small: 'AMEX:IWM',
  equal_weight: 'AMEX:RSP',
};

/**
 * Align two bar series on shared timestamps.
 *
 * Inner join, never interpolation. A holiday one venue observes and the other
 * does not would otherwise silently shift the two series against each other and
 * every ratio after that point would be comparing different days.
 */
export function alignSeries(a, b) {
  const map = new Map(b.map((x) => [x.time, x]));
  const out = [];
  for (const x of a) {
    const y = map.get(x.time);
    if (y && Number.isFinite(x.close) && Number.isFinite(y.close) && y.close !== 0) {
      out.push({ time: x.time, symbol: x.close, benchmark: y.close, ratio: x.close / y.close });
    }
  }
  return out;
}

/**
 * Leadership across ALL windows, not just the shortest.
 *
 * Reading it off one window is how a stock that has lagged its index by 16%
 * over six months gets reported as "outperforming" because it bounced for a
 * month. Both facts are true and the short one alone is misleading, so a
 * disagreement between windows is named rather than resolved.
 */
function leadershipOf(perf, symbol, benchmark) {
  if (!perf.length) return { leadership: 'unknown' };
  const out = perf.filter((p) => p.outperforming).length;
  if (out === perf.length) return { leadership: 'outperforming', leadership_note: `Ahead of ${benchmark} over every window measured.` };
  if (out === 0) return { leadership: 'lagging', leadership_note: `Behind ${benchmark} over every window measured.` };

  const short = perf[0], long = perf[perf.length - 1];
  return {
    leadership: 'mixed',
    leadership_note: short.outperforming
      ? `${symbol} is ahead of ${benchmark} over ${short.bars} bars (${short.excess_pct}%) but BEHIND over ${long.bars} (${long.excess_pct}%). A recent bounce inside longer-term underperformance — do not read the short window alone as leadership.`
      : `${symbol} is behind ${benchmark} over ${short.bars} bars (${short.excess_pct}%) but AHEAD over ${long.bars} (${long.excess_pct}%). Longer-term leadership currently pulling back.`,
  };
}

/**
 * Relative strength of `symbolBars` against `benchmarkBars`.
 *
 * The RS line is treated as a price series and run through the same structure
 * detection, so "the RS line is in a downtrend" is a measurement rather than an
 * impression.
 */
export function relativeStrength(symbolBars, benchmarkBars, {
  lookback = 5,
  windows = [21, 63, 126],
  symbol = 'symbol',
  benchmark = 'benchmark',
} = {}) {
  const aligned = alignSeries(symbolBars || [], benchmarkBars || []);
  if (aligned.length < 30) {
    return {
      available: false,
      aligned_bars: aligned.length,
      note: `Only ${aligned.length} bars align between ${symbol} and ${benchmark}. Aligned on shared timestamps — never interpolated — so a mismatch here usually means different sessions or different history depth.`,
    };
  }

  // The RS line, as bars, so the structure tools can read it.
  const rsBars = aligned.map((p) => ({
    time: p.time, open: p.ratio, high: p.ratio, low: p.ratio, close: p.ratio, volume: 0,
  }));
  const s = classifyStructure(alternateSwings(findSwings(rsBars, { lookback })));

  // Performance over each window, and the difference, which is the point.
  const perf = [];
  for (const w of windows) {
    if (aligned.length <= w) continue;
    const then = aligned[aligned.length - 1 - w], now = aligned[aligned.length - 1];
    const sPct = ((now.symbol - then.symbol) / then.symbol) * 100;
    const bPct = ((now.benchmark - then.benchmark) / then.benchmark) * 100;
    perf.push({
      bars: w,
      symbol_pct: round(sPct, 2),
      benchmark_pct: round(bPct, 2),
      excess_pct: round(sPct - bPct, 2),
      outperforming: sPct > bPct,
    });
  }

  const last = aligned[aligned.length - 1];
  const ratios = aligned.map((p) => p.ratio);
  const prices = aligned.map((p) => p.symbol);

  // The case worth finding: price and RS disagreeing over the same window.
  const w = Math.min(63, aligned.length - 1);
  const priceUp = prices[prices.length - 1] > prices[prices.length - 1 - w];
  const rsUp = ratios[ratios.length - 1] > ratios[ratios.length - 1 - w];
  const disagree = priceUp !== rsUp;

  // New highs, compared. A price high without an RS high is market-led.
  const recent = Math.min(63, aligned.length);
  const priceHigh = Math.max(...prices.slice(-recent));
  const rsHigh = Math.max(...ratios.slice(-recent));
  const atPriceHigh = prices[prices.length - 1] >= priceHigh * 0.999;
  const atRsHigh = ratios[ratios.length - 1] >= rsHigh * 0.999;

  return {
    available: true,
    symbol, benchmark,
    aligned_bars: aligned.length,
    rs_ratio: round(last.ratio, 6),
    rs_trend: s.trend,
    rs_recent_events: s.events.slice(-2).map((e) => `${e.type}/${e.direction}`),
    performance: perf,
    ...leadershipOf(perf, symbol, benchmark),

    price_vs_rs: {
      window_bars: w,
      price_direction: priceUp ? 'up' : 'down',
      rs_direction: rsUp ? 'up' : 'down',
      disagree,
      ...(disagree
        ? {
            meaning: priceUp
              ? `${symbol} is UP over ${w} bars while its relative strength is DOWN — the advance is being led by ${benchmark}, not by the stock. A single-symbol chart cannot show this.`
              : `${symbol} is DOWN over ${w} bars while its relative strength is UP — it is falling less than ${benchmark}. That is relative leadership inside a decline, and it is where the next leaders usually come from.`,
          }
        : { meaning: `${symbol} and its relative strength are moving the same way. No divergence to read here.` }),
    },

    at_price_high: atPriceHigh,
    at_rs_high: atRsHigh,
    ...(atPriceHigh && !atRsHigh
      ? { high_warning: `${symbol} is at a ${recent}-bar price high but its RS line is NOT. The stock is rising with the market rather than leading it — the commonest quiet way a breakout disappoints.` }
      : {}),
    ...(!atPriceHigh && atRsHigh
      ? { rs_note: `The RS line is at a ${recent}-bar high while price is not. ${symbol} is outperforming without an absolute breakout — often the earlier signal.` }
      : {}),

    not_rsi: 'Relative strength is NOT the RSI. RSI compares a symbol to its own past and is bounded 0-100; this compares one symbol to another and is an unbounded ratio. They share three letters and nothing else.',
    method: 'RS line is symbol close divided by benchmark close, aligned on shared timestamps only. Its trend is read with the same swing detection used on price, so it carries the same confirmation lag.',
    caveat: 'Relative strength says nothing about direction. A stock can outperform all the way down, and in a bear market the strongest RS often belongs to something still falling. Pair it with the absolute read, never instead of it.',
  };
}
