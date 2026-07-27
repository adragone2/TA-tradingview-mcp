import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/backtest.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerBacktestTools(server) {
  server.tool(
    'backtest_strategy',
    'Evaluate the Pine strategy on the chart: win rate, payoff, expectancy, profit factor and streaks, computed from its trades — AND compared against buy-and-hold over the same bars. Always report the comparison: net profit alone cannot tell a good strategy from a rising market.',
    {
      max_trades: z.coerce.number().optional().describe('Trades to read from the Strategy Tester (default 100)'),
      count: z.coerce.number().optional().describe('Bars used for the buy-and-hold benchmark (default 500)'),
      risk_per_trade: z.coerce.number().optional().describe('Currency risked per trade, so expectancy can be expressed in R against a real risk rather than the average loss'),
    },
    wrap((args) => core.evaluateStrategy(args)),
  );

  server.tool(
    'backtest_drawn',
    'Backtest the trades the user DREW on the chart. Reads every Long/Short Position tool and walks each one forward through subsequent bars to see whether stop or target was touched first, then reports win rate, expectancy and R. Trades where one bar contains both stop and target are resolved as losses and flagged — OHLC cannot say which came first.',
    {
      count: z.coerce.number().optional().describe('Bars to walk forward through (default 1000)'),
      risk_per_trade: z.coerce.number().optional().describe('Currency risked per trade, for expectancy in R'),
    },
    wrap((args) => core.evaluateDrawn(args)),
  );

  server.tool(
    'backtest_benchmark',
    'Buy-and-hold return and max drawdown for the bars on the chart. The number every backtest must clear before it means anything. Use when evaluating a strategy result from Bar Replay or any source that is not the Strategy Tester.',
    {
      count: z.coerce.number().optional().describe('Bars to measure over (default 500)'),
    },
    wrap((args) => core.benchmark(args)),
  );

  server.tool(
    'backtest_evaluate',
    'Win rate, payoff, expectancy, profit factor and streaks for a list of trades you supply — the way to score trades taken manually in Bar Replay, or imported from anywhere else. Each trade needs a profit; entry/exit/direction are used when profit is absent. Trades with no readable profit are excluded and counted, never scored as zero.',
    {
      trades: z.array(z.object({
        profit: z.coerce.number().optional().describe('Profit or loss for the trade'),
        entry: z.coerce.number().optional().describe('Entry price — used to derive profit when profit is absent'),
        exit: z.coerce.number().optional().describe('Exit price'),
        direction: z.enum(['long', 'short']).optional().describe('Trade direction'),
      }).passthrough()).describe('The trades to score'),
      risk_per_trade: z.coerce.number().optional().describe('Currency risked per trade, for expectancy in R'),
    },
    wrap(({ trades, risk_per_trade }) => {
      const { trades: normalized, unusable } = core.normalizeTrades(trades);
      return {
        success: true,
        source: 'supplied',
        statistics: core.evaluateTrades(normalized, { risk_per_trade }),
        ...(unusable.length ? { unusable_trades: unusable.length, unusable_note: 'Excluded for having no readable profit — not counted as zero.' } : {}),
        note: 'Arithmetic on the trades supplied. Compare the result against backtest_benchmark before calling it an edge.',
      };
    }),
  );
}
