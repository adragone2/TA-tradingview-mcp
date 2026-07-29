import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as costs from '../core/costs.js';
import * as pf from '../core/portfolio.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

const DISCLAIMER = 'Arithmetic on the numbers supplied. Not advice, and it places no order.';

const POSITION = z.object({
  symbol: z.string().optional(),
  entry: z.coerce.number(),
  stop: z.coerce.number(),
  shares: z.coerce.number(),
  direction: z.enum(['long', 'short']).optional(),
  sector: z.string().optional(),
}).passthrough();

export function registerCostTools(server) {
  server.tool(
    'trade_cost',
    'The round-trip cost of a trade — commission, spread, slippage and borrow — in currency and in R. R is the unit that matters: a 0.15R cost against a 0.35R edge has taken 43% of it. Use preset "ibkr_pro_fixed" for the real IBKR schedule ($0.005/share, $1.00 minimum per order, 1% cap), which matters because the MINIMUM is what small orders actually pay and a per-share model understates them by 2-4x.',
    {
      entry: z.coerce.number().describe('Entry price'),
      shares: z.coerce.number().describe('Position size in shares or units'),
      stop: z.coerce.number().optional().describe('Stop price — required to express the cost in R'),
      direction: z.enum(['long', 'short']).optional().describe('Trade direction (default long); borrow applies to shorts only'),
      bars_held: z.coerce.number().optional().describe('Bars the position is held, for borrow cost (default 1)'),
      preset: z.enum(['ibkr_pro_fixed', 'ibkr_pro_tiered', 'us_equity_zero_commission', 'crypto', 'forex_major', 'futures']).optional().describe('Cost schedule. The IBKR ones are the real published rates; the rest are order-of-magnitude starting points'),
      atr: z.coerce.number().optional().describe('Current ATR — slippage is a fraction of it, and is OMITTED with a warning if absent'),
      commission_per_share: z.coerce.number().optional(),
      commission_per_trade: z.coerce.number().optional(),
      commission_pct: z.coerce.number().optional().describe('Commission as a percent of notional, per leg (crypto convention)'),
      commission_min_per_order: z.coerce.number().optional().describe('Minimum commission per order, per leg'),
      commission_max_pct_of_trade: z.coerce.number().optional().describe('Commission cap as a percent of trade value'),
      spread_pct: z.coerce.number().optional().describe('Bid-ask spread as a percent of price'),
      slippage_atr: z.coerce.number().optional().describe('Slippage per leg as a fraction of ATR'),
      borrow_apr_pct: z.coerce.number().optional().describe('Annual borrow rate for shorts'),
    },
    wrap((args) => ({ success: true, ...costs.tradeCost(args), disclaimer: DISCLAIMER })),
  );

  server.tool(
    'costs_vs_edge',
    'What transaction costs do to a stated edge. The number that matters is not the cost per trade but the fraction of the edge it consumes — and an edge smaller than its costs is a losing strategy however good the backtest looked. Costs scale with turnover, so pass trades_per_year to see the annual drag.',
    {
      expectancy_r: z.coerce.number().describe('Gross expectancy in R, from risk_expectancy or backtest_evaluate'),
      cost_in_r: z.coerce.number().describe('Round-trip cost in R, from trade_cost'),
      trades_per_year: z.coerce.number().optional().describe('Turnover, to scale the drag annually'),
    },
    wrap((args) => ({ success: true, ...costs.applyCostsToEdge(args), disclaimer: DISCLAIMER })),
  );

  server.tool(
    'gap_risk',
    'How often price GAPPED past a given stop distance on this chart. Backtests here fill at the stop price exactly, but a stop is a market order once touched — a gap fills at the open instead. This measures the exposure that every backtest in this toolchain understates. It does not correct it.',
    {
      count: z.coerce.number().optional().describe('Bars to examine (default 500)'),
      stop_distance_pct: z.coerce.number().optional().describe('Stop distance from the prior close, in percent (default 2)'),
    },
    wrap(async ({ count = 500, stop_distance_pct }) => {
      const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      return { success: true, ...costs.gapRisk(bars, { stop_distance_pct }) };
    }),
  );

  server.tool(
    'luld_band',
    'The Limit Up-Limit Down band around a price — how far it can run before trading halts. The intraday twin of gap_risk: in a halt a stop does not get its price, it gets the resumption auction. Tier 1 (S&P 500 / Russell 1000) is 5% above $3; Tier 2 is 10%. Retail sources routinely quote the Tier 2 number for large caps, which is twice the real band. Bands DOUBLE 09:30-09:45 and 15:35-16:00 ET.',
    {
      price: z.coerce.number().describe('Reference price'),
      tier: z.coerce.number().optional().describe('1 for S&P 500 / Russell 1000 / select ETPs, 2 for everything else (default 2)'),
      in_doubling_window: z.coerce.boolean().optional().describe('True during 09:30-09:45 or 15:35-16:00 ET, when bands double'),
    },
    wrap(({ price, tier = 2, in_doubling_window = false }) => ({
      success: true, ...costs.luldBand({ price, tier, in_doubling_window }), disclaimer: DISCLAIMER,
    })),
  );

  server.tool(
    'portfolio_heat',
    'Total open risk across positions if every stop is hit at once. Per-trade sizing is the wrong unit for the thing that actually ends accounts — six positions risking 1% each is not 1% of risk, especially if they move together. Run position_correlation alongside this.',
    {
      positions: z.array(POSITION).describe('Open positions, each with entry, stop and shares'),
      account_size: z.coerce.number().describe('Account size'),
      max_heat_pct: z.coerce.number().optional().describe('Heat limit to check against (default 6)'),
    },
    wrap(({ positions, ...opts }) => ({ success: true, ...pf.portfolioHeat(positions, opts), disclaimer: DISCLAIMER })),
  );

  server.tool(
    'position_correlation',
    'How much open positions actually move together, from their return series. Reports effective_positions — N positions at an average correlation r behave like N/(1+(N-1)r) independent bets, so six at r=0.8 are about 1.4 bets. Pairs without enough data are reported UNKNOWN, never as zero, because assuming independence is the error this measures.',
    {
      returns: z.record(z.string(), z.array(z.coerce.number())).describe('Return series per symbol, e.g. {"AAPL": [0.01, -0.02, ...]}'),
      min_points: z.coerce.number().optional().describe('Minimum overlapping points for a pair to be measured (default 20)'),
    },
    wrap(({ returns, ...opts }) => ({ success: true, ...pf.positionCorrelation(returns, opts) })),
  );

  server.tool(
    'position_concentration',
    'How open RISK is distributed across a bucket — sector, direction, or any tag on the positions. Measured by risk rather than notional, because two equally sized positions with different stop distances carry very different risk and notional hides that.',
    {
      positions: z.array(POSITION).describe('Open positions, tagged with the grouping key'),
      key: z.string().optional().describe('Field to group by (default "sector")'),
      account_size: z.coerce.number().optional().describe('Account size, to express each bucket as a percent of it'),
    },
    wrap(({ positions, ...opts }) => ({ success: true, ...pf.concentration(positions, opts) })),
  );
}
