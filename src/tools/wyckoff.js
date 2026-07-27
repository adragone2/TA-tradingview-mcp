import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/wyckoff.js';
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

export function registerWyckoffTools(server) {
  server.tool(
    'wyckoff_phase',
    'Classify the chart into a Wyckoff phase — accumulation, markup, distribution, markdown, or a plain range — with the measurements behind the label. A phase is only claimed when a range actually exists by efficiency ratio, not by eye. Accumulation and distribution differ ONLY by what preceded the range. Returns "unclear" freely; most charts are not in a clean phase.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 200)'),
      range_window: z.coerce.number().optional().describe('Bars treated as the possible range (default 40)'),
      prior_window: z.coerce.number().optional().describe('Bars before it, used to decide accumulation vs distribution (default 40)'),
    },
    wrap(async ({ count = 200, range_window, prior_window }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.classifyPhase(bars, { range_window, prior_window }) };
    }),
  );

  server.tool(
    'wyckoff_spring',
    'Find springs and upthrusts — false breaks of a range boundary that get reclaimed. A spring requires price to trade BELOW support and then CLOSE back inside; a wick below with a close still below is a breakdown, not a spring, and confusing the two is how people buy into a decline. Candidates that failed to close back inside are returned separately as unconfirmed.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 200)'),
      range_window: z.coerce.number().optional().describe('Bars used to define the range (default 40)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity for the boundaries (default 3)'),
      min_penetration_pct: z.coerce.number().optional().describe('How far beyond the boundary counts as a penetration (default 0.05)'),
    },
    wrap(async ({ count = 200, range_window, lookback, min_penetration_pct }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.findSpringsUpthrusts(bars, { range_window, lookback, min_penetration_pct }) };
    }),
  );

  server.tool(
    'effort_vs_result',
    'Wyckoff\'s third law as a measurement: volume is effort, price movement is result. Rising price on FALLING volume is a rally nobody is backing; falling price on falling volume means selling is drying up. Returns which of the four combinations is in play. A bias, not a signal.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 200)'),
      window: z.coerce.number().optional().describe('Recent bars to assess (default 10)'),
      baseline: z.coerce.number().optional().describe('Prior bars used as the volume baseline (default 30)'),
    },
    wrap(async ({ count = 200, window, baseline }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.effortVsResult(bars, { window, baseline }) };
    }),
  );
}
