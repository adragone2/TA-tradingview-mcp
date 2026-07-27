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
    'Detect candlestick and chart patterns on the chart from the bars themselves. Every structural pattern reports status "forming" or "confirmed" — a pattern is NOT complete until price closes through the level that completes it, and reporting a forming pattern as a signal is the classic error. Each detection carries the measurements behind it and, where defined, the measured-move target.',
    {
      count: z.coerce.number().optional().describe('Bars to analyze (default 300)'),
      recent_bars: z.coerce.number().optional().describe('How many recent bars to scan for candlestick patterns (default 10 — a doji 300 bars ago is noise)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity for structural patterns (default 5)'),
      peak_tolerance_pct: z.coerce.number().optional().describe('How close two peaks must be to count as the same level (default 2)'),
      max_age_bars: z.coerce.number().optional().describe('Ignore structural patterns that finished more than this many bars ago — older ones are history, not setups (default 60)'),
      include: z.array(z.string()).optional().describe('Only report these pattern names'),
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
        ],
        note: 'Patterns are computed from the bars with stated thresholds, not judged by eye. Every detection carries its measurements so the claim can be checked.',
      };
    }),
  );
}
