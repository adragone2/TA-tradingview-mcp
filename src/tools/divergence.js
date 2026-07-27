import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/divergence.js';
import * as data from '../core/data.js';
import { normalizeBars, findSwings, alternateSwings, classifyLegs } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

async function loadBars(count) {
  const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  return bars;
}

const SERIES = {
  rsi: (bars, len) => ({ label: `RSI(${len || 14})`, series: core.rsiSeries(bars.map((b) => b.close), len || 14) }),
  macd: (bars) => ({ label: 'MACD histogram', series: core.macdSeries(bars.map((b) => b.close)).histogram }),
  macd_line: (bars) => ({ label: 'MACD line', series: core.macdSeries(bars.map((b) => b.close)).macd }),
  obv: (bars) => ({ label: 'OBV', series: core.obvSeries(bars) }),
  mfi: (bars, len) => ({ label: `MFI(${len || 14})`, series: core.mfiSeries(bars, len || 14) }),
  volume: (bars) => ({ label: 'volume', series: bars.map((b) => (Number.isFinite(b.volume) ? b.volume : null)) }),
};

export function registerDivergenceTools(server) {
  server.tool(
    'divergence_find',
    'Divergence between price and one indicator — RSI, MACD, OBV, MFI or raw volume. Regular divergence (price makes a new extreme, the indicator does not) is traditionally read as a reversal warning; hidden divergence is read as continuation. Both are returned and labelled, neither is called a signal. The indicator is read AT each price swing, not at its own swings, because letting it pick its turning points means picking which pairs to compare.',
    {
      count: z.coerce.number().optional().describe('Bars to scan (default 300)'),
      indicator: z.enum(['rsi', 'macd', 'macd_line', 'obv', 'mfi', 'volume']).optional().describe('Which indicator to compare against (default rsi)'),
      length: z.coerce.number().optional().describe('Indicator length where it applies (default 14)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      max_age_bars: z.coerce.number().optional().describe('Ignore divergences older than this (default 60)'),
      min_bars_between: z.coerce.number().optional().describe('Minimum bars between the two swings compared (default 5)'),
      include_hidden: z.boolean().optional().describe('Include hidden (continuation) divergences (default true)'),
    },
    wrap(async ({ count = 300, indicator = 'rsi', length, ...opts }) => {
      const bars = await loadBars(count);
      const { label, series } = SERIES[indicator](bars, length);
      if (!series.some((v) => Number.isFinite(v))) {
        throw new Error(`${label} could not be computed from these bars — check there is enough history and, for OBV/MFI, usable volume.`);
      }
      return {
        success: true,
        last_price: bars[bars.length - 1].close,
        ...core.findDivergences(bars, series, { ...opts, label }),
        caveat: core.DIVERGENCE_CAVEAT,
      };
    }),
  );

  server.tool(
    'divergence_survey',
    'Run divergence across RSI, MACD histogram, OBV and MFI at once and report where they AGREE. Agreement across independent measures is the only thing that makes a divergence worth more than a single reading — if one of four diverges, that is far weaker than a reader shown only that one would assume. In a strong trend divergence is normal rather than a warning.',
    {
      count: z.coerce.number().optional().describe('Bars to scan (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      max_age_bars: z.coerce.number().optional().describe('Ignore divergences older than this (default 60)'),
      agreement_window: z.coerce.number().optional().describe('How recent a divergence must be to count toward agreement (default 10 bars)'),
    },
    wrap(async ({ count = 300, ...opts }) => {
      const bars = await loadBars(count);
      return { success: true, last_price: bars[bars.length - 1].close, ...core.surveyDivergences(bars, opts) };
    }),
  );

  server.tool(
    'legs_classify',
    'Classify each leg between swings as an IMPULSE or a PULLBACK, with the measurements behind it — body share, colour agreement, and where bars closed in their range. This is the unit the trend is built from (impulse, pullback, impulse) and underlies flags, pennants and every pullback entry. Also marks whether a pullback is simple or complex; a complex one looks like a reversal while forming, which is why traders abandon them early.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      max_legs: z.coerce.number().optional().describe('Most recent legs to return (default 10)'),
    },
    wrap(async ({ count = 300, lookback = 5, max_legs = 10 }) => {
      const bars = await loadBars(count);
      const swings = alternateSwings(findSwings(bars, { lookback }));
      const r = classifyLegs(bars, swings);
      return {
        success: true,
        last_price: bars[bars.length - 1].close,
        ...r,
        legs: r.legs.slice(-max_legs).reverse(),
        ...(r.legs.length > max_legs ? { note: `${r.legs.length} legs found; showing the ${max_legs} most recent.` } : {}),
      };
    }),
  );
}
