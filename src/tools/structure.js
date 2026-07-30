import { z } from 'zod';
import { trackLevel, levelTestStudy, TOUCH_COUNT_FINDING } from '../core/level_tests.js';
import { jsonResult } from './_format.js';
import * as core from '../core/structure.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';

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
    'Support and resistance levels computed from price history, each carrying the evidence that earned it: how many SEPARATE times price tested it, how many swings formed it, volume traded there, and whether a round number coincides. Wide clusters are returned as zones rather than lines. Read-only — pairs with levels_draw. IMPORTANT about the touch count: it is MEASURED to carry no information about whether the level holds next time. Over 554 real levels the break hazard rose 14.5 points from test 1 to test 5, but it rose 40.3 points on random walks — more tests simply means more exposure. So touch count is not strength and it is not weakness either; it is how much the level has been looked at. Use level_pressure for the clause that DID survive.',
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

  server.tool(
    'level_test_history',
    'The full test-by-test history of a level: every separate approach, where price RETREATED TO between them, and whether the level eventually broke. This is the measurement arm behind level_pressure, and it settled two of Shannon\'s ch. 7 claims in opposite directions. Over 20 symbols and 554 levels against 200 random walks: his COUNT claim FAILED — the break hazard rose 14.5 points from test 1 to test 5 on real data but 40.3 points on noise, so "more tests means more likely to break" is exposure arithmetic, not absorption, and touch count says nothing about the next test in either direction. His PRESSURE clause SURVIVED — levels whose interim retreat lows rose broke 73.8% of the time against 54.3% when they did not, a 19.5-point lift, against a random-walk lift of MINUS 1.4 (z = 3.36 over 272 levels, clearing a three-test Bonferroni correction). Use level_pressure to read the current approach; use this to see the whole sequence or to re-check the measurement. One universe, no out-of-sample arm — a finding, not a settled effect.',
    {
      count: z.coerce.number().optional().describe('Bars to analyse (default 400)'),
      price: z.coerce.number().optional().describe('Track one specific level. Omit to survey every swing-formed level in the window.'),
      kind: z.enum(['resistance', 'support']).optional().describe('Which side the level is (required with price)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      tolerance_pct: z.coerce.number().optional().describe('Half-width of the level band, percent (default 0.5)'),
      break_margin_pct: z.coerce.number().optional().describe('A CLOSE this far beyond the band counts as a break (default 0.3). A wick through with a close back inside is not a break.'),
      resolve_bars: z.coerce.number().optional().describe('Bars after a test in which a break must occur to be attributed to it (default 5)'),
    },
    wrap(async ({ count = 400, price = null, kind = null, lookback = 5, ...opts }) => {
      const series = await data.getOhlcv({ count, summary: false });
      const bars = normalizeBars(series);
      if (!bars.length) throw new Error('No price bars came back from the chart.');

      if (price !== null) {
        if (!kind) throw new Error('Pass kind ("resistance" or "support") with an explicit price.');
        // Track from the start of the window, so every test in it is counted.
        return {
          success: true, symbol: series.symbol, timeframe: series.resolution, bars: bars.length,
          ...trackLevel(bars, { from_index: 0, price, kind, ...opts }),
          finding: TOUCH_COUNT_FINDING,
        };
      }

      return {
        success: true, symbol: series.symbol, timeframe: series.resolution, bars: bars.length,
        ...levelTestStudy(bars, { lookback, ...opts }),
        finding: TOUCH_COUNT_FINDING,
      };
    }),
  );
}
