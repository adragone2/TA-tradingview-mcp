import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/risk.js';
import { exitMix, EXIT_REASONS } from '../core/exits.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

const DISCLAIMER = 'Arithmetic on the numbers supplied. Not advice, and it places no order.';

export function registerRiskTools(server) {
  server.tool(
    'risk_expectancy',
    'Expectancy, break-even win rate and Kelly from a win rate and a payoff. Answers the question BEFORE a trade that backtest_evaluate answers after one. A win rate is meaningless without its payoff — 80% loses money if the losses are big enough — so the break-even win rate for that payoff always comes back alongside. Kelly is reported with halves and quarters and a warning, because full Kelly assumes your numbers are exact.',
    {
      win_rate_pct: z.coerce.number().describe('Percent of trades that win (0-100)'),
      risk_reward: z.coerce.number().optional().describe('Reward divided by risk, e.g. 2 for a 2:1'),
      avg_win: z.coerce.number().optional().describe('Average winning trade — preferred over risk_reward when known'),
      avg_loss: z.coerce.number().optional().describe('Average losing trade, as a positive number'),
      sample_size: z.coerce.number().optional().describe('How many trades these figures came from. Supply it — it decides how far the Kelly numbers can be trusted'),
    },
    wrap((args) => ({ success: true, ...core.tradeMath(args), disclaimer: DISCLAIMER })),
  );

  server.tool(
    'risk_of_ruin',
    'How often a drawdown this deep happens, by seeded Monte Carlo. Expectancy says whether the edge is positive; this says whether the account survives long enough to collect it. A strategy with a real edge still ruins an account if an ordinary losing streak ends it. Seeded, so the same inputs always give the same answer.',
    {
      win_rate_pct: z.coerce.number().describe('Percent of trades that win (0-100)'),
      risk_reward: z.coerce.number().optional().describe('Reward divided by risk (default 2)'),
      risk_per_trade_pct: z.coerce.number().optional().describe('Percent of the account risked per trade (default 1)'),
      ruin_drawdown_pct: z.coerce.number().optional().describe('Drawdown from peak that counts as ruin (default 50)'),
      trades: z.coerce.number().optional().describe('Trades per run (default 200)'),
      simulations: z.coerce.number().optional().describe('Runs (default 5000)'),
      seed: z.coerce.number().optional().describe('PRNG seed (default 12345)'),
    },
    wrap((args) => ({ success: true, ...core.riskOfRuin(args), disclaimer: DISCLAIMER })),
  );

  server.tool(
    'drawdown_recovery',
    'What a drawdown costs to recover: down 50% needs +100%, down 80% needs +400%. The curve is not linear, which is why capping the loss matters more than maximising the win. Returns the figure for a given drawdown plus the whole curve for context.',
    {
      drawdown_pct: z.coerce.number().optional().describe('A specific drawdown to price (0-100, exclusive)'),
    },
    wrap(({ drawdown_pct }) => ({
      success: true,
      ...(Number.isFinite(drawdown_pct) ? { specific: core.recoveryRequired(drawdown_pct) } : {}),
      ...core.recoveryTable(),
    })),
  );

  server.tool(
    'position_size_atr',
    'Position size from volatility instead of from a fixed price stop. Places the stop a multiple of ATR from entry, so the position shrinks when the instrument gets more volatile and the stop sits outside its ordinary bar range. Pass manual_stop to compare against a stop you already chose — a stop tighter than 1x ATR will be hit by normal noise rather than by being wrong. Read ATR off the chart with data_get_study_values.',
    {
      account_size: z.coerce.number().describe('Account size'),
      risk_percent: z.coerce.number().describe('Percent of the account to risk on this trade'),
      entry: z.coerce.number().describe('Entry price'),
      atr: z.coerce.number().describe('Current ATR value for this symbol and timeframe'),
      atr_multiple: z.coerce.number().optional().describe('ATR multiples from entry to the stop (default 2)'),
      direction: z.enum(['long', 'short']).optional().describe('Trade direction (default long)'),
      manual_stop: z.coerce.number().optional().describe('A stop price you already picked, to compare against the ATR stop'),
    },
    wrap((args) => ({ success: true, ...core.sizeByVolatility(args), disclaimer: DISCLAIMER })),
  );

  server.tool(
    'exit_mix',
    "Split a set of journalled exits into PLANNED versus DISCRETIONARY, using the twelve-key Reasons2Sell taxonomy. The point is not discipline: a backtest can only model an exit that was specifiable before entry, so if most real exits were decided while the position was live, the backtest is measuring a different strategy that merely shares an entry signal. Also counts exits driven by the INDEX rather than the position, which no single-symbol backtest can see. Pass reason keys from EXIT_REASONS.",
    {
      exits: z.array(z.string()).describe('Exit reason keys, one per closed trade'),
    },
    wrap(({ exits }) => ({ success: true, ...exitMix(exits), taxonomy: Object.keys(EXIT_REASONS) })),
  );
}
