import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/patterns.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerPatternTools(server) {
  server.tool(
    'patterns_detect',
    'Detect candlestick and chart patterns on the chart from the bars themselves. CONFIRMED structural patterns carry Bulkowski\'s measured statistics — break-even failure rate, average move, how often the measured-move target is reached — split by breakout direction and bull/bear market. Every structural pattern reports status "forming" or "confirmed" — a pattern is NOT complete until price closes through the level that completes it, and reporting a forming pattern as a signal is the classic error. Each detection carries the measurements behind it and, where defined, the measured-move target.',
    {
      count: z.coerce.number().optional().describe('Bars to analyze (default 300)'),
      recent_bars: z.coerce.number().optional().describe('How many recent bars to scan for candlestick patterns (default 10 — a doji 300 bars ago is noise)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity for structural patterns (default 5)'),
      peak_tolerance_pct: z.coerce.number().optional().describe('How close two peaks must be to count as the same level (default 2)'),
      max_age_bars: z.coerce.number().optional().describe('Ignore structural patterns that finished more than this many bars ago — older ones are history, not setups (default 60)'),
      include: z.array(z.string()).optional().describe('Only report these pattern names'),
      market: z.enum(['bull', 'bear']).optional().describe('Broader market regime, for Bulkowski statistics (default bull). The bull/bear difference is often large'),
    },
    wrap(async ({ count = 300, ...opts }) => {
      const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      const result = core.detectPatterns(bars, opts);
      return {
        success: true,
        last_price: bars[bars.length - 1].close,
        ...result,
        known_patterns: { candlestick: core.CANDLE_PATTERNS, structural: core.STRUCTURAL_PATTERNS },
        rules: [
          'A structural pattern with status "forming" has NOT completed. Say so — do not present it as a signal.',
          'Candlestick reversal patterns only mean something against a prior trend. Check prior_trend; where it is sideways the tool says so in a caveat.',
          'Targets are the standard measured move, not a forecast. They assume the pattern behaves typically, which often it does not.',
          'Measured statistics are attached only to CONFIRMED patterns. Bulkowski measures from the breakout onward, so they do not apply to a forming shape — quote meeting_target_pct alongside any target you report.',
        ],
        note: 'Patterns are computed from the bars with stated thresholds, not judged by eye. Every detection carries its measurements so the claim can be checked.',
      };
    }),
  );

  server.tool(
    'candle_read',
    'Classify the most recent candles into the only three families that exist — momentum (one side held control), reaction (one side pushed, the other took it back), indecision (neither held). Unlike patterns_detect this ALWAYS answers, because every candle is one of the three whether or not it is also a named pattern. Use it for "what is the last candle saying"; use patterns_detect when you need a named pattern with measured statistics behind it.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 60)'),
      recent: z.coerce.number().optional().describe('How many recent candles to classify (default 5)'),
      context_bars: z.coerce.number().optional().describe('Bars before each candle used to judge what counts as large here (default 10)'),
    },
    wrap(async ({ count = 60, recent, context_bars }) => {
      const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      return {
        success: true,
        last_price: bars[bars.length - 1].close,
        ...core.classifyRecent(bars, { count: recent, context_bars }),
        rules: [
          'A reaction candle means something at a level price has already tested. In the middle of a range it is a bar with a long wick.',
          'On a reaction candle the wick carries the information, not the body colour.',
          'An indecision candle is not tradeable alone. Where it appears is the whole point — after a long run it is momentum stalling.',
        ],
      };
    }),
  );
}
