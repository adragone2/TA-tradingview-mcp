import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/breakout.js';
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

export function registerBreakoutTools(server) {
  server.tool(
    'breakout_check',
    'Score a breakout of a price level against five measurable criteria: momentum (body vs recent average), how far beyond the level it CLOSED, volume vs average, how well established the level was, and follow-through on the next bar. The same five inverted are the signs of a false breakout, so this answers both questions. Replaces judging a breakout by whether the candle "looks strong".',
    {
      level: z.coerce.number().describe('The price level being broken'),
      direction: z.enum(['up', 'down']).describe('"up" through resistance, "down" through support'),
      count: z.coerce.number().optional().describe('Bars to load (default 200)'),
      lookback: z.coerce.number().optional().describe('Bars used for the momentum and volume averages (default 20)'),
      min_close_pct: z.coerce.number().optional().describe('How far beyond the level the close must be, in percent, to count as decisive (default 0.25)'),
    },
    wrap(async ({ count = 200, level, direction, lookback, min_close_pct }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.scoreBreakout(bars, { level, direction, lookback, min_close_pct }) };
    }),
  );

  server.tool(
    'level_pressure',
    'Is a level weakening as price approaches it? Lower highs into support (or higher lows into resistance) mean each attempt is failing earlier and the level is more likely to break than hold — the same shape as a descending or ascending triangle. Use before assuming a tested level will hold again.',
    {
      level: z.coerce.number().describe('The level to assess'),
      side: z.enum(['support', 'resistance']).describe('Which side of price the level sits on'),
      count: z.coerce.number().optional().describe('Bars to load (default 200)'),
      lookback: z.coerce.number().optional().describe('Bars of approach to examine (default 40)'),
    },
    wrap(async ({ count = 200, level, side, lookback }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.approachPressure(bars, { level, side, lookback }) };
    }),
  );
}
