import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/position_tool.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerPositionToolTools(server) {
  server.tool(
    'position_draw',
    "Draw TradingView's native Long/Short Position tool — shaded risk and reward boxes with entry, stop and target, and a size TradingView computes from account size and risk percent. Prefer this over draw_trade_plan when the user wants a draggable plan whose sizing updates live; prefer draw_trade_plan for multiple targets and partials. Validates the levels against the direction. Places no order.",
    {
      direction: z.enum(['long', 'short']).describe('Trade direction'),
      entry: z.coerce.number().describe('Entry price'),
      stop: z.coerce.number().describe('Stop price — below entry for a long, above for a short'),
      target: z.coerce.number().describe('Target price — above entry for a long, below for a short'),
      account_size: z.coerce.number().optional().describe('Account size, so TradingView computes the quantity'),
      risk_percent: z.coerce.number().optional().describe('Percent of account risked on this trade'),
      time: z.union([z.number(), z.string()]).optional().describe('Anchor time: unix, "now", "last_bar", or ISO date (default last bar)'),
      group: z.string().optional().describe('Group name for clearing this plan later'),
    },
    wrap((args) => core.drawPosition(args)),
  );

  server.tool(
    'position_read',
    "Read Long/Short Position tools off the chart as plain prices — entry, stop, target, R:R and quantity. This is how to evaluate a trade the user drew by hand: TradingView stores the levels as tick offsets, which are meaningless without the symbol's tick size. Each is flagged created_by_mcp.",
    {
      entity_id: z.string().optional().describe('Read one specific tool (default: all on the chart)'),
    },
    wrap(({ entity_id }) => core.readPosition({ entity_id })),
  );

  server.tool(
    'position_size',
    'Position size for a trade already drawn on the chart, under ALL THREE constraints — risk budget, concentration cap, and liquidity — returning the MINIMUM and naming which one bound. A fixed-risk formula alone is unsafe: under fixed risk a TIGHTER stop buys MORE shares, so the concentration cap binds precisely when the entry looks best. Shannon\'s own worked example turns a 1% risk budget on a $100,000 account into a $66,650 position — 65% of capital in one idea — because the stop was only 75 cents away. Pass adv to apply the liquidity constraint; without it that constraint is reported as NOT CHECKED rather than silently passing. Reports TradingView\'s own quantity alongside, and flags when the drawing is configured for a different account size. Arithmetic on the levels drawn — not advice, and it places no order.',
    {
      account_size: z.coerce.number().describe('Account size'),
      risk_percent: z.coerce.number().describe('Percent of account to risk (Shannon: 1%, never more than 2%)'),
      entity_id: z.string().optional().describe('Which position tool (required when more than one is on the chart)'),
      adv: z.coerce.number().optional().describe('Average daily volume in shares. Without it the liquidity constraint cannot be applied and is reported as unchecked.'),
      max_position_pct: z.coerce.number().optional().describe('Concentration cap as percent of account in one position (default 20 — Shannon says 15-20)'),
      max_adv_pct: z.coerce.number().optional().describe('Liquidity cap as percent of average daily volume (default 2 — this repo\'s choice, not Shannon\'s; he names no number)'),
    },
    wrap((args) => core.sizePosition(args)),
  );
}
