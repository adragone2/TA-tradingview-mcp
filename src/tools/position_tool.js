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
    'Position size for a trade already drawn on the chart, given an account size and risk percent. Reports TradingView\'s own quantity alongside, and flags when the drawing is configured for a different account size. Arithmetic on the levels drawn — not advice, and it places no order.',
    {
      account_size: z.coerce.number().describe('Account size'),
      risk_percent: z.coerce.number().describe('Percent of account to risk'),
      entity_id: z.string().optional().describe('Which position tool (required when more than one is on the chart)'),
    },
    wrap(({ account_size, risk_percent, entity_id }) => core.sizePosition({ account_size, risk_percent, entity_id })),
  );
}
