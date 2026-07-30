import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/risk.js';
import { exitMix, EXIT_REASONS, sliceTrades, DEFAULT_BUCKETS } from '../core/exits.js';
import { accountSettings } from '../core/rules.js';

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
      account_size: z.coerce.number().optional().describe('Account size. Omit to read it from rules.json (account.account_size). If neither is set the tool REFUSES rather than assuming a figure — an invented account size produces a real-looking share count.'),
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
    'position_size_constrained',
    'Position size under all THREE constraints at once — risk budget, concentration cap, and liquidity — returning the MINIMUM and naming which one bound. Use this when you have prices but nothing drawn on the chart; position_size does the same for a plan already drawn. The reason it exists: a fixed-risk formula alone is unsafe, because under fixed risk a TIGHTER stop buys MORE shares. So the concentration cap binds exactly when the entry looks best. Shannon\'s worked example: a $50 stock with the stop 75 cents away, 1% of a $100,000 account, gives 1,333 shares — $66,650, or 65% of capital in one idea. His second example binds on liquidity instead: a $2.50 stock with support 15 cents away gives 6,666 shares, which is 2.2% of a 300,000-share ADV. Reports what the risk budget alone would have bought, so the difference is visible. Without adv the liquidity constraint is reported as NOT CHECKED — unknown is not the same as satisfied.',
    {
      account_size: z.coerce.number().describe('Account size'),
      entry: z.coerce.number().describe('Entry price'),
      stop: z.coerce.number().describe('Stop price'),
      risk_percent: z.coerce.number().optional().describe('Percent of account to risk (default 1 — Shannon says never more than 2)'),
      adv: z.coerce.number().optional().describe('Average daily volume in shares. Omit and the liquidity constraint is reported as unchecked, not passed.'),
      max_position_pct: z.coerce.number().optional().describe('Concentration cap as percent of account in one position (default 20 — Shannon says 15-20)'),
      max_adv_pct: z.coerce.number().optional().describe('Liquidity cap as percent of average daily volume (default 2 — this repo\'s choice; Shannon names no number)'),
    },
    wrap((args) => {
      /**
       * Resolve the account size rather than defaulting it. A size computed from a
       * number nobody supplied looks exactly like a correct one — during a live DLO
       * analysis $100,000 was invented because there was nowhere to read it from.
       */
      let { account_size } = args;
      let resolved_from = 'argument';
      if (account_size == null) {
        const cfg = accountSettings(args.rules_path);
        if (cfg.account_size == null) {
          throw new Error(
            'No account size. Pass account_size, or set account.account_size in rules.json '
            + `(looked in ${cfg.rules_path || 'the default locations'}). This tool will not assume one: `
            + 'a share count derived from an invented account is indistinguishable from a correct one.',
          );
        }
        account_size = cfg.account_size;
        resolved_from = `rules.json (${cfg.rules_path})`;
      }
      return {
        success: true,
        ...core.sizeWithConstraints({ ...args, account_size }),
        account_size_from: resolved_from,
        caps: core.SIZING_CAPS,
        disclaimer: DISCLAIMER,
      };
    }),
  );

  server.tool(
    'exit_mix',
    "Split a set of journalled exits into PLANNED versus DISCRETIONARY, using the fifteen-key taxonomy (Bellafiore's Reasons2Sell plus Shannon's gap-against-trend and moving-average-crossover exits, both of which are planned). The point is not discipline: a backtest can only model an exit that was specifiable before entry, so if most real exits were decided while the position was live, the backtest is measuring a different strategy that merely shares an entry signal. Also counts exits driven by the INDEX rather than the position, which no single-symbol backtest can see. Pass reason keys from EXIT_REASONS.",
    {
      exits: z.array(z.string()).describe('Exit reason keys, one per closed trade'),
    },
    wrap(({ exits }) => ({ success: true, ...exitMix(exits), taxonomy: Object.keys(EXIT_REASONS) })),
  );

  server.tool(
    'journal_slice',
    'Slice closed trades by direction, share size, share price and holding time, and report P&L per bucket. The reason is Shannon\'s Figure 16.2 — his own broker\'s report over three weeks of real trading — where TWO buckets were net NEGATIVE inside a profitable book: stocks over $100 averaged −3.82 across 159 trades, and trades held 16–30 minutes averaged −17.93 across 44. Neither is visible in an aggregate win rate, and both are actionable in a way "improve your discipline" is not. His shorts also won MORE often than his longs (56.4% vs 52.0%). exit_mix answers whether a backtest can represent a book; this answers which parts of it make the money. Guards the obvious hazard: every bucket reports its own n, buckets under min_n are flagged underpowered and never ranked, and the result states how many buckets were examined — cut a small book enough ways and one looks terrible by chance. A losing bucket is a hypothesis about where to look, not a conclusion.',
    {
      trades: z.array(z.object({
        pnl: z.coerce.number().describe('Realised P&L. Required — nothing can be computed without it.'),
        direction: z.string().optional().describe('"long" or "short"'),
        shares: z.coerce.number().optional().describe('Position size in shares'),
        price: z.coerce.number().optional().describe('Entry price'),
        minutes_held: z.coerce.number().optional().describe('Holding time in minutes'),
        reason: z.string().optional().describe('An EXIT_REASONS key, so planned and discretionary can be split too'),
        setup_tier: z.string().optional().describe('Your own grade for the setup, e.g. "A"'),
      })).describe('Closed trades, one object each'),
      min_n: z.coerce.number().optional().describe('Trades a bucket needs before it is ranked rather than flagged underpowered (default 10)'),
    },
    wrap(({ trades, min_n = 10 }) => ({
      success: true,
      ...sliceTrades(trades, { min_n }),
      bucket_edges: DEFAULT_BUCKETS,
      disclaimer: DISCLAIMER,
    })),
  );
}
