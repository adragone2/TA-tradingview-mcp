import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/liquidity.js';
import * as data from '../core/data.js';
import { normalizeBars, findSwings, alternateSwings } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

async function loadBars(count) {
  const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  return bars;
}

export function registerLiquidityTools(server) {
  server.tool(
    'anchored_vwap',
    'VWAP anchored to any bar, with standard-deviation bands. Session VWAP answers "what did today\'s average buyer pay"; anchored to a major swing low or an earnings gap it answers "what has everyone who bought since THAT moment paid" — which is what makes the line act like support or resistance. Anchor by bars-ago or by picking the most recent swing high/low. VWAP is context, not a trigger.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 300)'),
      anchor: z.enum(['start', 'swing_low', 'swing_high']).optional().describe('Anchor point: series start, or the most recent major swing (default swing_low)'),
      bars_ago: z.coerce.number().optional().describe('Anchor this many bars back instead, overriding `anchor`'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity when anchoring to a swing (default 5)'),
    },
    wrap(async ({ count = 300, anchor = 'swing_low', bars_ago, lookback = 5 }) => {
      const bars = await loadBars(count);
      let idx = 0;
      let how = 'series start';
      if (Number.isFinite(bars_ago)) {
        idx = Math.max(0, bars.length - 1 - Math.floor(bars_ago));
        how = `${bars_ago} bars ago`;
      } else if (anchor !== 'start') {
        const kind = anchor === 'swing_low' ? 'low' : 'high';
        const swings = alternateSwings(findSwings(bars, { lookback })).filter((s) => s.kind === kind);
        if (!swings.length) throw new Error(`No confirmed swing ${kind} found to anchor to. Lower lookback or use anchor:"start".`);
        idx = swings[swings.length - 1].index;
        how = `most recent swing ${kind}`;
      }
      return { success: true, anchored_to: how, ...core.anchoredVwap(bars, { anchor_index: idx }) };
    }),
  );

  server.tool(
    'fair_value_gaps',
    'Three-bar imbalances where bar 1 and bar 3 do not overlap — price moved so fast it left a band nothing traded in. Reports how many were found BEFORE filtering, because these occur constantly and their frequency is exactly why they mean little alone. Gaps price has already traded back through are excluded as spent.',
    {
      count: z.coerce.number().optional().describe('Bars to scan (default 300)'),
      min_size_pct: z.coerce.number().optional().describe('Ignore gaps smaller than this percent (default 0.1)'),
      max_age_bars: z.coerce.number().optional().describe('Ignore gaps older than this (default 60)'),
      include_filled: z.boolean().optional().describe('Include gaps price has already traded back through (default false)'),
    },
    wrap(async ({ count = 300, ...opts }) => {
      const bars = await loadBars(count);
      return { success: true, ...core.fairValueGaps(bars, opts) };
    }),
  );

  server.tool(
    'liquidity_pools',
    'Equal highs and equal lows — swing points stacked at effectively one price, where stop orders cluster. Each additional touch adds another cohort of stops in the same place, which is why a level tested three times breaks harder than one tested once: the break triggers the stops that fuel it. Where stops rest is an inference from convention, not observed order data.',
    {
      count: z.coerce.number().optional().describe('Bars to scan (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      tolerance_pct: z.coerce.number().optional().describe('How close two swings must be to count as equal (default 0.15)'),
      min_touches: z.coerce.number().optional().describe('Swings required to form a pool (default 2)'),
    },
    wrap(async ({ count = 300, lookback = 5, tolerance_pct, min_touches }) => {
      const bars = await loadBars(count);
      const swings = findSwings(bars, { lookback });
      const price = bars[bars.length - 1].close;
      return { success: true, current_price: price, ...core.equalHighsLows(swings, price, { tolerance_pct, min_touches }) };
    }),
  );
}
