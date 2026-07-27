import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/context.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

async function loadBars(count) {
  const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  return bars;
}

export function registerContextTools(server) {
  server.tool(
    'market_regime',
    'Is this market trending cleanly or is it chop? Returns an efficiency ratio — net distance travelled divided by the total path walked. Call this BEFORE hunting for setups: in a choppy market, structure breaks are noise, stops get run, and patterns appear that are not there. The best available trade is often no trade, and this is how to say so with a number.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 200)'),
      window: z.coerce.number().optional().describe('Bars to measure over (default 30)'),
    },
    wrap(async ({ count = 200, window }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.regime(bars, { window }) };
    }),
  );

  server.tool(
    'fib_levels',
    'Fibonacci retracement levels for the most recent impulse, with where price currently sits in them and whether it is in the 38.2-61.8% golden zone. Use to measure pullback depth objectively instead of eyeballing it. A shallow pullback is normal in a steep trend, not a weakness.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
    },
    wrap(async ({ count = 300, lookback }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.fibLevels(bars, { lookback }) };
    }),
  );

  server.tool(
    'swing_strength',
    'Classify each swing high and low as strong, weak or unproven. A swing is STRONG when the move originating from it went on to break structure — the market proved it mattered. WEAK swings are the ones that get taken out. This is where stops belong, and "the low" is usually treated as one undifferentiated thing when it is not.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
    },
    wrap(async ({ count = 300, lookback }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.classifySwings(bars, { lookback }) };
    }),
  );

  server.tool(
    'volume_profile',
    'Where volume actually traded, by price: point of control, value area, and high/low volume nodes. High-volume nodes are prices the market accepted and returns to; low-volume nodes are prices it moves through quickly. Computed from the bars by spreading each bar\'s volume across its range — an approximation, and the result says so.',
    {
      count: z.coerce.number().optional().describe('Bars to profile (default 300)'),
      bins: z.coerce.number().optional().describe('Price buckets (default 40)'),
      value_area_pct: z.coerce.number().optional().describe('Percent of volume in the value area (default 70)'),
    },
    wrap(async ({ count = 300, bins, value_area_pct }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.volumeProfile(bars, { bins, value_area_pct }) };
    }),
  );
}
