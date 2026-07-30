import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/breakout.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';
import { TOUCH_COUNT_FINDING } from '../core/level_tests.js';

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
    'Is a level weakening as price approaches it? Lower highs into support (or higher lows into resistance) mean each attempt is failing earlier. Useful as a DESCRIPTION of whether attempts are getting stronger or weaker. MEASURED, AND THE PREDICTIVE CLAIM DID NOT SURVIVE: on the sample it was found in, levels whose interim retreat extremes moved toward the level broke 39.1 points more often (z = 3.96, n = 103) — but on a FRESH universe of 20 different symbols that collapses to +4.6 at z = 0.73 across a LARGER sample of 251 levels, which is indistinguishable from the -1.4 a random walk carries. An older, non-overlapping window on the original symbols gives +3.4 at z = 0.31. So it holds in 1 of 3 arms: the one it came from. Read this to describe the approach, not to forecast the break, and do not size on it. Its companion claim is also dead: TOUCH COUNT carries nothing — the break hazard rises 4.5 to 21.2 points across real arms where a random walk rises 40.3. That is exposure arithmetic, and it is not licence to invert levels_find either. level_test_history has every arm.',
    {
      level: z.coerce.number().describe('The level to assess'),
      side: z.enum(['support', 'resistance']).describe('Which side of price the level sits on'),
      count: z.coerce.number().optional().describe('Bars to load (default 200)'),
      lookback: z.coerce.number().optional().describe('Bars of approach to examine (default 40)'),
    },
    wrap(async ({ count = 200, level, side, lookback }) => {
      const bars = await loadBars(count);
      return {
        success: true,
        ...core.approachPressure(bars, { level, side, lookback }),
        // The premise this tool rests on, with its null attached.
        measurement: TOUCH_COUNT_FINDING.aggression_through_price,
        touch_count_does_not_help: TOUCH_COUNT_FINDING.count_claim.consequence,
      };
    }),
  );
}
