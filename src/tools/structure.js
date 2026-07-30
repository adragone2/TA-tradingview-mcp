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
    'Draw the key levels on the chart, labelled with the evidence behind each one, grouped so draw_clear removes them cleanly. BY DEFAULT it draws exactly TWO lines: the PRIMARY support and PRIMARY resistance, anchored to the last confirmed swing low and swing high — the levels that BOUND the range. Ask for `tier: 2` to walk out to the next level beyond each, then 3, and so on. Two earlier rankings were tried and both failed on a live chart: ranking by `score` put six supports and no resistance on a name sitting under overhead supply, because score is driven by test count and touch count carries no measured information about whether a level holds; and ranking by PROXIMITY is worse still when price sits mid-range, because the nearest levels are then the congestion price is inside — measured on DLO the three nearest were traded through 16.7%, 16.7% and 21.7% of the last 60 bars, the three worst on the chart, while the swing-anchored resistance was traded through 0.0%. Everything not drawn comes back in `interior` and `beyond` rather than being silently dropped. Pass mode:"band" for the nearest-N-per-side ATR behaviour, with `pins` to force your stop/entry/targets through.',
    {
      count: z.coerce.number().optional().describe('Bars to analyze (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      tolerance_pct: z.coerce.number().optional().describe('Clustering tolerance, percent (default 0.75)'),
      min_touches: z.coerce.number().optional().describe('Separate tests required (default 2)'),
      mode: z.enum(['primary', 'band']).optional().describe('"primary" (DEFAULT) draws ONE support and ONE resistance, anchored to the last confirmed swing low and swing high — the levels that BOUND the range. "band" draws the nearest N per side inside an ATR band.'),
      tier: z.coerce.number().optional().describe('Which tier to draw in primary mode (default 1 = the boundaries). Tier 2 is the next level beyond each boundary, tier 3 the one after. This is "show me the next one".'),
      select: z.coerce.boolean().optional().describe('Band mode only: filter to the nearest N per side (default true). false restores the old score-ranked top-max_levels behaviour.'),
      atr_multiple: z.coerce.number().optional().describe('Band half-width in ATRs (default 1.5). This is the knob for "show me the next ones" — raise it to 3, then 6.'),
      per_side: z.coerce.number().optional().describe('How many levels per side, at most (default 3). Applied to support and resistance separately so one side cannot crowd out the other.'),
      pins: z.array(z.union([z.number(), z.object({ price: z.number(), label: z.string().optional() })])).optional().describe('Prices that must be drawn however far away they are — your stop, entry and targets. A filter that hides your own stop hides the decision.'),
      max_bars_since_test: z.coerce.number().optional().describe('Optional recency cut: drop levels last tested more than this many bars ago. OFF by default — measured on DLO it removed only 2 of 19 levels and both were resistances, because an active name revisits most of its range constantly.'),
      max_levels: z.coerce.number().optional().describe('Only used when select:false — how many to draw, ranked by score (default 8)'),
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
