/**
 * Divergence between price and an indicator — and indicator series to run it on.
 *
 * This was the last item on the playbook's missing-primitives list that kept
 * coming back. RSI divergence, MACD divergence, MFI divergence, volume
 * divergence, the wave-5 divergence Elliott traders watch for — they are all
 * the same measurement, and none of it was computable here.
 *
 * ── The claim, and its limits ──
 *
 * Divergence is the most over-claimed signal in technical analysis. It occurs
 * constantly, and in a strong trend it is NORMAL rather than a warning: an
 * indicator bounded at 100 cannot keep making higher highs while price does, so
 * a sustained trend manufactures divergence as a matter of arithmetic. Price
 * ignores it most of the time, and it can persist for months.
 *
 * So `total_found` comes back with every result, the same discipline as fair
 * value gaps and zones, and nothing here calls a divergence a signal.
 *
 * ── The methodological choice that matters ──
 *
 * The indicator is read AT the bar of each price swing — not at the indicator's
 * own swings. This matters. Letting the indicator pick its own turning points
 * means choosing which pairs to compare, and any chart will then yield a
 * divergence somewhere. Anchoring both readings to the same price swings is the
 * version that can be wrong.
 *
 * All pure.
 */
import { findSwings, alternateSwings } from './structure.js';

const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/* --------------------------- indicator series --------------------------- */
/*
 * Series versions of the scalar indicators in strategy.js. They must agree:
 * the last element of each series equals what the scalar function returns for
 * the same input, and the tests assert exactly that. Two implementations of one
 * formula is a liability unless something checks they match.
 */

/** EMA series, seeded with the SMA of the first `length` values — chart convention. */
export function emaSeries(values, length) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < length || length < 1) return out;
  const k = 2 / (length + 1);
  let e = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = e;
  for (let i = length; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder's RSI as a series. */
export function rsiSeries(values, length = 14) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < length + 1) return out;

  let gain = 0, loss = 0;
  for (let i = 1; i <= length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / length, avgLoss = loss / length;
  const rsiFrom = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[length] = rsiFrom(avgGain, avgLoss);

  for (let i = length + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (length - 1) + (d > 0 ? d : 0)) / length;
    avgLoss = (avgLoss * (length - 1) + (d < 0 ? -d : 0)) / length;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/** MACD line, signal and histogram. */
export function macdSeries(values, { fast = 12, slow = 26, signal = 9 } = {}) {
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  const macd = values.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));

  // The signal line is an EMA of the MACD line, which only begins where the
  // MACD line does — so it is computed on the defined tail and mapped back.
  const start = macd.findIndex((v) => v != null);
  const sig = new Array(values.length).fill(null);
  if (start >= 0) {
    const tail = macd.slice(start);
    const e = emaSeries(tail, signal);
    for (let i = 0; i < e.length; i++) sig[start + i] = e[i];
  }

  const hist = values.map((_, i) => (macd[i] == null || sig[i] == null ? null : macd[i] - sig[i]));
  return { macd, signal: sig, histogram: hist };
}

/** On-balance volume — cumulative, so it has a value from the second bar. */
export function obvSeries(bars) {
  const out = new Array(bars.length).fill(null);
  if (!Array.isArray(bars) || bars.length < 2) return out;
  let v = 0;
  out[0] = 0;
  for (let i = 1; i < bars.length; i++) {
    const vol = Number.isFinite(bars[i].volume) ? bars[i].volume : 0;
    if (bars[i].close > bars[i - 1].close) v += vol;
    else if (bars[i].close < bars[i - 1].close) v -= vol;
    out[i] = v;
  }
  return out;
}

/**
 * Money Flow Index — RSI weighted by volume, which is why it is sometimes
 * called volume-weighted RSI. Undefined without volume.
 */
export function mfiSeries(bars, length = 14) {
  const out = new Array(bars.length).fill(null);
  if (!Array.isArray(bars) || bars.length < length + 1) return out;

  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const flow = bars.map((b, i) => tp[i] * (Number.isFinite(b.volume) ? b.volume : 0));

  for (let i = length; i < bars.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - length + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) pos += flow[j];
      else if (tp[j] < tp[j - 1]) neg += flow[j];
    }
    if (pos + neg === 0) { out[i] = null; continue; }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/* ---------------------------- divergence ------------------------------- */

/**
 * Find divergences between price swings and an indicator series.
 *
 * REGULAR divergence — price makes a new extreme, the indicator does not.
 * Traditionally read as a reversal warning.
 *
 * HIDDEN divergence — the indicator makes a new extreme, price does not.
 * Traditionally read as trend continuation.
 *
 * Both are reported and labelled. Neither is called a signal.
 */
export function findDivergences(bars, series, {
  lookback = 5,
  max_age_bars = 60,
  min_bars_between = 5,
  include_hidden = true,
  label = 'indicator',
} = {}) {
  if (!Array.isArray(bars) || !Array.isArray(series) || series.length !== bars.length) {
    return { divergences: [], note: 'The indicator series must be the same length as the bars.' };
  }

  const swings = alternateSwings(findSwings(bars, { lookback }));
  const all = [];

  const scan = (kind) => {
    const pts = swings.filter((s) => s.kind === kind && Number.isFinite(series[s.index]));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (b.index - a.index < min_bars_between) continue;

      const pA = a.price, pB = b.price;
      const iA = series[a.index], iB = series[b.index];
      if (pA === pB || iA === iB) continue;

      let type = null, direction = null, klass = null;
      if (kind === 'high') {
        if (pB > pA && iB < iA) { type = 'regular_bearish'; direction = 'bearish'; klass = 'regular'; }
        else if (pB < pA && iB > iA) { type = 'hidden_bearish'; direction = 'bearish'; klass = 'hidden'; }
      } else {
        if (pB < pA && iB > iA) { type = 'regular_bullish'; direction = 'bullish'; klass = 'regular'; }
        else if (pB > pA && iB < iA) { type = 'hidden_bullish'; direction = 'bullish'; klass = 'hidden'; }
      }
      if (!type) continue;

      all.push({
        type, direction, class: klass, swing_kind: kind, indicator: label,
        from: { time: a.time, price: round(pA), indicator_value: round(iA, 4), index: a.index },
        to: { time: b.time, price: round(pB), indicator_value: round(iB, 4), index: b.index },
        price_change_pct: round(((pB - pA) / Math.abs(pA)) * 100, 2),
        indicator_change: round(iB - iA, 4),
        bars_between: b.index - a.index,
        bars_ago: bars.length - 1 - b.index,
        meaning: klass === 'regular'
          ? `Price made a ${kind === 'high' ? 'higher high' : 'lower low'} but ${label} did not follow. Traditionally read as the move losing conviction.`
          : `${label} made a ${kind === 'high' ? 'higher high' : 'lower low'} but price did not. Traditionally read as trend continuation, not reversal.`,
      });
    }
  };

  scan('high');
  scan('low');

  const recent = all.filter((d) => d.bars_ago <= max_age_bars);
  const kept = include_hidden ? recent : recent.filter((d) => d.class === 'regular');
  kept.sort((a, b) => a.bars_ago - b.bars_ago);

  return {
    divergences: kept,
    total_found: all.length,
    filtered_too_old: all.length - recent.length,
    ...(include_hidden ? {} : { filtered_hidden: recent.length - kept.length }),
    swings_compared: swings.length,
    indicator: label,
    ...(kept.length === 0 && all.length === 0
      ? { note: `No divergence between price and ${label} over these bars. That is a common and unremarkable result.` }
      : {}),
  };
}

/**
 * Run the standard divergence set — RSI, MACD histogram, OBV and MFI — and
 * report where they agree.
 *
 * Agreement across independent indicators is the one thing that makes a
 * divergence worth more than a single reading, and it is also the honest way to
 * present it: if only one of four diverges, that is much weaker than a reader
 * shown only that one indicator would assume.
 */
export function surveyDivergences(bars, opts = {}) {
  const closes = bars.map((b) => b.close);
  const hasVolume = bars.some((b) => Number.isFinite(b.volume) && b.volume > 0);

  const sources = [
    { label: 'RSI(14)', series: rsiSeries(closes, 14) },
    { label: 'MACD histogram', series: macdSeries(closes).histogram },
    ...(hasVolume ? [
      { label: 'OBV', series: obvSeries(bars) },
      { label: 'MFI(14)', series: mfiSeries(bars, 14) },
    ] : []),
  ];

  const runs = sources.map((s) => ({
    indicator: s.label,
    ...findDivergences(bars, s.series, { ...opts, label: s.label }),
  }));

  // Two divergences agree when they point the same way and sit close in time.
  const recent = runs.flatMap((r) => r.divergences.filter((d) => d.bars_ago <= (opts.agreement_window ?? 10)));
  const byDirection = { bullish: new Set(), bearish: new Set() };
  for (const d of recent) if (d.class === 'regular') byDirection[d.direction].add(d.indicator);

  const bullish = [...byDirection.bullish], bearish = [...byDirection.bearish];
  const strongest = bullish.length >= bearish.length ? bullish : bearish;
  const side = bullish.length >= bearish.length ? 'bullish' : 'bearish';

  return {
    runs: runs.map((r) => ({
      indicator: r.indicator,
      total_found: r.total_found,
      shown: r.divergences.length,
      most_recent: r.divergences[0] || null,
    })),
    indicators_checked: sources.length,
    ...(hasVolume ? {} : { volume_note: 'No usable volume on these bars, so OBV and MFI were skipped.' }),
    agreement: strongest.length === 0
      ? 'No indicator shows a recent regular divergence. This is the ordinary state of a chart.'
      : strongest.length === 1
        ? `Only ${strongest[0]} shows a recent ${side} divergence. One indicator out of ${sources.length} is weak evidence — the others disagree by staying silent.`
        : `${strongest.length} of ${sources.length} indicators show a recent ${side} divergence (${strongest.join(', ')}). Agreement across independent measures is the strongest form this signal takes.`,
    agreeing_indicators: strongest,
    agreement_direction: strongest.length ? side : null,
    caveat: DIVERGENCE_CAVEAT,
  };
}

/** Attached to every divergence answer. */
export const DIVERGENCE_CAVEAT = {
  frequency: 'Divergence is the most over-claimed signal in technical analysis. It occurs constantly and price ignores it most of the time. total_found is reported so a single returned divergence is never mistaken for a rare event.',
  strong_trends: 'In a strong trend, divergence is NORMAL rather than a warning. A bounded oscillator cannot keep making higher highs while price does, so a sustained trend manufactures divergence as a matter of arithmetic — not as a sign of weakness.',
  persistence: 'A divergence can persist for a long time before price does anything, and often it does nothing at all. It is not a timing tool.',
  method: 'The indicator is read at the bar of each PRICE swing, not at the indicator\'s own swings. Letting the indicator choose its turning points means choosing which pairs to compare, and any chart will then yield a divergence somewhere.',
  use: 'Worth something only where it coincides with a level price has actually tested, and with a confirmation at the entry. On its own it is an observation, not a setup.',
};
