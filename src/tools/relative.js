import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/relative.js';
import * as data from '../core/data.js';
import * as chart from '../core/chart.js';
import { normalizeBars } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerRelativeTools(server) {
  server.tool(
    'relative_strength',
    'Performance against a benchmark — the "compared to what" question no single-symbol tool can answer. A stock up 8% looks strong until its index is up 12%. Returns the RS line (symbol/benchmark), its trend, excess return over several windows, and the case worth finding: price and RS disagreeing, which means the move is market-led rather than stock-led. NOT the RSI — that compares a symbol to its own past.',
    {
      benchmark: z.string().optional().describe('Benchmark ticker (default AMEX:SPY). Try NASDAQ:QQQ for tech, AMEX:RSP for equal-weight, or a sector ETF'),
      count: z.coerce.number().optional().describe('Bars to compare (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity for the RS line trend (default 5)'),
    },
    wrap(async ({ benchmark = 'AMEX:SPY', count = 300, lookback = 5 }) => {
      const before = await chart.getState().catch(() => null);
      const original = before?.symbol || null;
      if (!original) throw new Error('Could not read the current symbol, so the chart could not be safely restored. Aborting rather than risk leaving it elsewhere.');

      const symbolBars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!symbolBars.length) throw new Error('No price bars for the current symbol.');

      let benchBars = [];
      let switchError = null;
      try {
        await chart.setSymbol({ symbol: benchmark });
        benchBars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      } catch (e) {
        switchError = e.message;
      } finally {
        // Always put the chart back, even if the benchmark failed to load.
        try { await chart.setSymbol({ symbol: original }); }
        catch (e) {
          throw new Error(`Loaded ${benchmark} but FAILED to restore ${original}: ${e.message}. The chart is on the wrong symbol — set it back manually.`);
        }
      }
      if (switchError) throw new Error(`Could not load benchmark ${benchmark}: ${switchError}. The chart was restored to ${original}.`);
      if (!benchBars.length) throw new Error(`No bars came back for ${benchmark}. The chart was restored to ${original}.`);

      const r = core.relativeStrength(symbolBars, benchBars, { lookback, symbol: original, benchmark });
      return { success: true, restored_to: original, benchmarks_available: core.BENCHMARKS, ...r };
    }),
  );
}
