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
    'Support and resistance levels computed from price history, each carrying the evidence that earned it: how many SEPARATE times price tested it, how many swings formed it, volume traded there, and whether a round number coincides. Wide clusters are returned as zones rather than lines. Read-only — pairs with levels_draw. IMPORTANT about the touch count: it is MEASURED to carry no information about whether the level holds next time. Across real arms the break hazard rises 4.5 to 21.2 points from the first test to the last, where a random walk rises 40.3 — more tests simply means more exposure. So touch count is not strength and it is not weakness either; it is how much the level has been looked at. level_pressure describes whether successive attempts are strengthening, which is a better question, but its predictive claim also failed out of sample — see level_test_history for every arm.',
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
    'The full test-by-test history of a level: every separate approach, where price RETREATED TO between them, and whether the level eventually broke. This is the measurement arm behind level_pressure, and it settled two of the ch. 7 claims — both against him. His COUNT claim is DEAD in every arm: the break hazard rises 4.5 to 21.2 points across real samples where a random walk rises 40.3, so the idea that more tests make a break more likely is exposure arithmetic. His PRESSURE clause looked strong (+39.1 points, z = 3.96) on the sample it was found in and then did NOT replicate — a fresh universe of 20 different symbols gives +4.6 at z = 0.73 on a LARGER sample of 251 levels, and an older window on the original symbols gives +3.4 at z = 0.31. Both the noise floor and the trial count were attached to the original result and neither caught it; only the holdout did. Returns every tracked test with the interim extreme between them, both clauses, and all four arms so no single number can be quoted alone.',
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
