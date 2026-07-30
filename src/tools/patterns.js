import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/patterns.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';
import { planPatternDrawings } from '../core/patterns_draw.js';
import { drawPatternGeometry } from '../core/assessment_draw.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerPatternTools(server) {
  server.tool(
    'patterns_draw',
    'Draw the detected patterns on the chart — the COMPLETION LEVEL of each, which is the price at which a shape stops being a shape and becomes a fact, and therefore the only line on a pattern that is also a trigger. Bullish patterns are labelled "completes", bearish ones "breaks at", because a rising wedge breaking DOWN through support is not the same event as a flag completing UP through its high. This closes the last manual step in the ticker workflow: patterns_detect returned completion_level and draw_shape could draw a line, but nothing joined them, so patterns were drawn by hand with hand-written labels — and a hand-written label is exactly what leaks an orphan, since entity IDs die with the TradingView session and a label matching no signature can never be swept up. Every label here uses a registered format. Targets are OFF by default: a measured move assumes the pattern behaves typically, and on a FORMING pattern it is projected off a shape that has not happened. Candlestick patterns are never drawn — they are single visible bars, and two independent academic tests found candlestick strategies add no value.',
    {
      count: z.coerce.number().optional().describe('Bars to analyse (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      max_age_bars: z.coerce.number().optional().describe('Ignore patterns that finished more than this many bars ago (default 60)'),
      include_targets: z.coerce.boolean().optional().describe('Also draw the measured-move target (default false). On a forming pattern this is a projection off a shape that has not completed.'),
      forming_only: z.coerce.boolean().optional().describe('Draw only patterns still forming (default false)'),
      max_patterns: z.coerce.number().optional().describe('Cap on patterns drawn (default 6)'),
      group: z.string().optional().describe('Group name for clearing later (default "patterns-<TICKER>")'),
    },
    wrap(async ({ count = 300, lookback = 5, max_age_bars = 60, include_targets = false, forming_only = false, max_patterns = 6, group }) => {
      const raw = await data.getOhlcv({ count, summary: false });
      const bars = normalizeBars(raw);
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      const symbol = raw?.symbol ?? null;
      const detected = core.detectPatterns(bars, { lookback, max_age_bars });
      const plan = planPatternDrawings(detected.structural || [], { include_targets, forming_only, max_patterns });

      if (!plan.patterns.length) {
        return {
          success: true, symbol, timeframe: raw?.resolution ?? null, drawn: 0, ...plan,
          note: 'No pattern had a completion level to draw. "None" is a real result — do not manufacture one.',
        };
      }

      const groupName = group || `patterns-${String(symbol || 'chart').replace(/^.*:/, '')}`;
      const drawn = []; const failed = [];
      /**
       * Draw the pattern's actual SHAPE, not just its break level.
       *
       * This tool originally drew one horizontal line per pattern and nothing
       * else — which silently dropped the geometry the chart had been showing for
       * months: wedge boundaries, flag poles, triangle edges, head-and-shoulders.
       * `drawPatternGeometry` already did all of it, anchored to REAL pivots via
       * TradingView's native triangle_pattern and head_and_shoulders tools, and it
       * carries two hard-won fixes: a rectangle gets a BOX rather than a
       * converging triangle, and boundaries are anchored to pivots rather than
       * extrapolated from a slope (a 0.93%/bar slope run back 46 bars once put a
       * lower edge at 22.25 on a bar trading near 29 — a line touching nothing).
       */
      const put = async (fn, label) => {
        try {
          const r = await fn();
          if (r?.success || r?.entity_id) drawn.push({ shape: label, entity_id: r?.entity_id ?? null });
          else failed.push({ shape: label, why: 'created but could not be identified' });
        } catch (e) { failed.push({ shape: label, why: e.message }); }
      };
      for (const pat of plan.patterns) {
        await drawPatternGeometry(pat, bars, groupName, put);
      }

      return {
        success: failed.length === 0,
        symbol,
        timeframe: raw?.resolution ?? null,
        group: groupName,
        drawn: drawn.length,
        shapes: drawn,
        ...plan,
        ...(failed.length ? { failed, warning: `${failed.length} shape(s) failed to draw.` } : {}),
        clear_hint: `Remove with draw_clear group="${groupName}".`,
        noise_floor: detected.noise_baseline ? { walks_with_any_pattern_pct: detected.noise_baseline.walks_with_any_pattern_pct } : undefined,
        rule: 'A FORMING pattern has not completed. The line is where it would confirm, not a signal now.',
      };
    }),
  );

  server.tool(
    'patterns_detect',
    'Detect candlestick and chart patterns on the chart from the bars themselves. CONFIRMED structural patterns carry Bulkowski\'s measured statistics — break-even failure rate, average move, how often the measured-move target is reached — split by breakout direction. Bull-market figures, and they are PERFECT TRADES gross of costs. Every structural pattern reports status "forming" or "confirmed" — a pattern is NOT complete until price closes through the level that completes it, and reporting a forming pattern as a signal is the classic error. Each detection carries the measurements behind it and, where defined, the measured-move target.',
    {
      count: z.coerce.number().optional().describe('Bars to analyze (default 300)'),
      recent_bars: z.coerce.number().optional().describe('How many recent bars to scan for candlestick patterns (default 10 — a doji 300 bars ago is noise)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity for structural patterns (default 5)'),
      peak_tolerance_pct: z.coerce.number().optional().describe('How close two peaks must be to count as the same level (default 2)'),
      max_age_bars: z.coerce.number().optional().describe('Ignore structural patterns that finished more than this many bars ago — older ones are history, not setups (default 60)'),
      include: z.array(z.string()).optional().describe('Only report these pattern names'),
    },
    wrap(async ({ count = 300, ...opts }) => {
      const series = await data.getOhlcv({ count, summary: false });
      const bars = normalizeBars(series);
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      const result = core.detectPatterns(bars, opts);
      return {
        success: true,
        // Which series this is. Reported because two calls seconds apart once
        // returned different prices for the same stated symbol, and nothing in
        // the output could have revealed it.
        symbol: series.symbol,
        timeframe: series.resolution,
        last_price: bars[bars.length - 1].close,
        ...result,
        known_patterns: { candlestick: core.CANDLE_PATTERNS, structural: core.STRUCTURAL_PATTERNS },
        rules: [
          'A structural pattern with status "forming" has NOT completed. Say so — do not present it as a signal.',
          'Candlestick reversal patterns only mean something against a prior trend. Check prior_trend; where it is sideways the tool says so in a caveat.',
          'Targets are the standard measured move, not a forecast. They assume the pattern behaves typically, which often it does not.',
          'Measured statistics are attached only to CONFIRMED patterns and are BULL MARKET only. They are perfect trades gross of costs, measured to a peak unknowable at the time — quote meeting_target_pct alongside any target, and pair average_move_pct with trade_cost.',
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
      const series = await data.getOhlcv({ count, summary: false });
      const bars = normalizeBars(series);
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      return {
        success: true,
        symbol: series.symbol,
        timeframe: series.resolution,
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
