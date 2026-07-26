import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerStructureTools(server) {
  server.tool(
    'structure_analyze',
    'Market structure from the chart\'s own price data: swing highs and lows, each labelled HH/HL/LH/LL, the resulting trend, and every break of structure (BOS) and change of character (CHoCH). Use this instead of eyeballing a screenshot — swings here come from the bars, not from a guess. Swings need `lookback` bars to their right to confirm, so the newest bars are deliberately absent.',
    {
      count: z.coerce.number().optional().describe('Bars to analyze (default 200)'),
      lookback: z.coerce.number().optional().describe('Bars either side that define a swing — higher finds fewer, more significant swings (default 5)'),
      max_swings: z.coerce.number().optional().describe('How many recent swings to return (default 20)'),
    },
    wrap((args) => core.analyzeStructure(args)),
  );

  server.tool(
    'levels_find',
    'Support and resistance levels computed from price history, each carrying the evidence that earned it: how many SEPARATE times price tested it, how many swings formed it, volume traded there, and whether a round number coincides. Wide clusters are returned as zones rather than lines. Read-only — pairs with levels_draw.',
    {
      count: z.coerce.number().optional().describe('Bars to analyze (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      tolerance_pct: z.coerce.number().optional().describe('How close two swings must be to count as the same level, percent (default 0.75)'),
      min_touches: z.coerce.number().optional().describe('Separate tests required before a level qualifies (default 2)'),
      max_levels: z.coerce.number().optional().describe('Strongest N to return (default 12)'),
      max_distance_pct: z.coerce.number().optional().describe('Ignore levels further than this percent from price — they outscore nearby ones simply by being older (default 25)'),
    },
    wrap((args) => core.keyLevels(args)),
  );

  server.tool(
    'levels_draw',
    'Draw computed key levels on the chart — horizontal lines for tight levels, shaded rectangles for zones — green for support, red for resistance, thickness by strength. Each label carries the evidence behind the level, not just the price. Grouped so draw_clear removes them without touching the user\'s own drawings.',
    {
      count: z.coerce.number().optional().describe('Bars to analyze (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      tolerance_pct: z.coerce.number().optional().describe('Clustering tolerance, percent (default 0.75)'),
      min_touches: z.coerce.number().optional().describe('Separate tests required (default 2)'),
      max_levels: z.coerce.number().optional().describe('How many to draw (default 8 — more than this clutters the chart)'),
      max_distance_pct: z.coerce.number().optional().describe('Ignore levels further than this percent from price (default 25)'),
      label_detail: z.enum(['price', 'compact', 'full']).optional().describe('How much to put in the chart label. "compact" (default) keeps it readable; "full" writes the whole reason and will overlap when levels are close. The complete evidence is in the result either way.'),
      extend_bars: z.coerce.number().optional().describe('Extend zones this many bars past the last bar (default 0)'),
      group: z.string().optional().describe('Group name for clearing later (default "levels-<TICKER>")'),
    },
    wrap((args) => core.drawKeyLevels(args)),
  );
}
