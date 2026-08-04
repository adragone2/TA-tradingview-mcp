/**
 * ConnorsRSI — the quantified short-horizon fear gauge, as published.
 *
 * Public-domain formula (Connors Research): the average of three components,
 * each 0-100 —
 *
 *   1. RSI(close, 3)            — Wilder RSI of price, shortened from 14 to 3
 *   2. RSI(streak, 2)           — Wilder RSI of the CLOSE STREAK series
 *                                 (+n after n consecutive up closes, -n down, 0 flat)
 *   3. PercentRank(ret1, 100)   — the share of the last 100 one-day returns
 *                                 strictly below today's, x100
 *
 * Why it is in this repo at all: Connors' own framing (podcast, read
 * 2026-08-03) is that a floored short-term RSI measures FEAR — a pause in
 * buying ahead of an event, or event-driven selling — and the repo's horizon
 * evidence says sub-21-day REVERSAL is the one documented effect at the swing
 * boundary. A quantified fear reading is at least pointed at the right
 * horizon, which none of the continuation detectors are.
 *
 * What it is NOT: an adopted signal. The floor below is the yardstick a
 * real-data claim has to beat, and the published mean-reversion stats behind
 * it are Connors' own, unverified here. It feeds NO screen and gates NOTHING
 * until it has a forward campaign (the level_pressure lesson: in-sample +
 * floor + trial count STILL died on the holdout). Reuses divergence.js's
 * rsiSeries — one RSI definition in the repo, not two.
 */

import { rsiSeries } from './divergence.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** +n after n consecutive up closes, -n after n consecutive down, 0 on flat. */
export function streakSeries(closes) {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out.push(out[i - 1] > 0 ? out[i - 1] + 1 : 1);
    else if (closes[i] < closes[i - 1]) out.push(out[i - 1] < 0 ? out[i - 1] - 1 : -1);
    else out.push(0);
  }
  return out;
}

/** Share of the previous `period` one-day returns strictly below today's, x100. */
export function percentRankSeries(closes, period = 100) {
  const rets = closes.map((c, i) => (i === 0 ? null : (c - closes[i - 1]) / closes[i - 1]));
  return closes.map((_, i) => {
    if (i < period + 1) return null;
    const windowRets = rets.slice(i - period, i);
    const below = windowRets.filter((r) => r != null && r < rets[i]).length;
    return (below / period) * 100;
  });
}

/** The full ConnorsRSI series over closes. Pure. */
export function connorsRsiSeries(closes, { rsi_period = 3, streak_period = 2, rank_period = 100 } = {}) {
  const rsiClose = rsiSeries(closes, rsi_period);
  const rsiStreak = rsiSeries(streakSeries(closes), streak_period);
  const rank = percentRankSeries(closes, rank_period);
  return closes.map((_, i) => {
    const a = rsiClose[i], b = rsiStreak[i], c = rank[i];
    if (a == null || b == null || c == null) return null;
    return (a + b + c) / 3;
  });
}

/** The bar-facing wrapper: current reading, components, and the floor. */
export function connorsRsi(bars, { rsi_period = 3, streak_period = 2, rank_period = 100, tail = 10 } = {}) {
  const closes = (bars || []).map((b) => b.close);
  const need = rank_period + 2;
  if (closes.length < need) {
    return { available: false, why: `needs ${need} bars (${rank_period} for the percent-rank window), got ${closes.length}` };
  }
  const opts = { rsi_period, streak_period, rank_period };
  const series = connorsRsiSeries(closes, opts);
  const last = series.length - 1;
  const rsiClose = rsiSeries(closes, rsi_period);
  const rsiStreak = rsiSeries(streakSeries(closes), streak_period);
  const rank = percentRankSeries(closes, rank_period);
  return {
    available: true,
    current: r2(series[last]),
    components: {
      rsi_close: r2(rsiClose[last]),
      rsi_streak: r2(rsiStreak[last]),
      percent_rank: r2(rank[last]),
    },
    tail: series.slice(-tail).map(r2),
    params: opts,
    noise_baseline: CONNORS_RSI_NOISE,
    reading: 'A quantified FEAR reading, not a signal. Low values mean the last few closes were weak in a way '
      + 'that is rare in this window — Connors\' claim is that below ~10 marks event-fear worth fading, but that '
      + 'claim is HIS, at portfolio scale, and unverified here. Feeds no screen, gates nothing; a forward '
      + 'campaign (sweep + holdout) comes before any adoption. One chart is not a portfolio (edge_breadth).',
  };
}

/**
 * Measured 2026-08-03, `node scripts/connors-rsi-noise.js` re-measures.
 * The occupancy numbers say how often pure noise visits each band — the
 * yardstick any "it was oversold" story has to clear. The lift row is the
 * NULL for the mean-reversion claim itself: on random walks the mean
 * next-5-bar return after CRSI<10 minus the unconditional mean, with its
 * spread across walks. A real-data lift inside that spread is noise.
 */
export const CONNORS_RSI_NOISE = {
  walks: 200,
  bars_each: 300,
  occupancy_pct: { lt5: 0.4, lt10: 2.3, lt20: 12.9, gt80: 12.9, gt90: 2.3, gt95: 0.5 },
  lift_null: {
    condition: 'CRSI < 10',
    horizon_bars: 5,
    mean_pp: -0.011,
    sd_pp: 1.256,
    walks_with_events: 156,
  },
  reading: 'Pure noise reads "oversold" (<10) on 2.3% of bars — about 7 times per 300-bar chart — and the '
    + 'next-5-bar lift after those readings is 0.0pp +/- 1.26pp. A real-data lift inside +/-2.5pp is noise. '
    + 'The bands are symmetric by construction (2.3% both tails), so the gauge itself carries no drift.',
};
