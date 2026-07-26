import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/ta_decisions.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerTaDecisionTools(server) {
  server.tool(
    'ta_actionable',
    "Everything Tactical Alpha currently flags for action — exits ordered by urgency, entries by score. Start a trading session here: CRITICAL exits are positions TA says are past their stop. These are TA's decisions, not recommendations produced here.",
    {
      limit: z.coerce.number().optional().describe('Max rows per side (default 25)'),
    },
    wrap(({ limit }) => core.actionable({ limit })),
  );

  server.tool(
    'ta_entry',
    "TA's entry decision for a symbol: action, conviction, suggested size, and the levels behind it (put wall, BB lower, PIF support, distance to stop).",
    { symbol: z.string().describe('Ticker, with or without exchange prefix') },
    wrap(({ symbol }) => core.entryFor({ symbol })),
  );

  server.tool(
    'ta_exit',
    "TA's exit decision for a held position: urgency, action, how much to exit, and the levels behind it (stop, call wall, BB upper, PIF resistance). Only exists for positions actually held.",
    { symbol: z.string().describe('Ticker, with or without exchange prefix') },
    wrap(({ symbol }) => core.exitFor({ symbol })),
  );

  server.tool(
    'ta_draw_decision',
    "Draw TA's entry and/or exit levels for a symbol on the current chart, colour-coded (stops red, resistance green, support blue) and grouped so they clear in one call. Defaults to the chart's symbol and to whichever decisions exist.",
    {
      symbol: z.string().optional().describe("Override the symbol (defaults to the chart's)"),
      side: z.enum(['auto', 'entry', 'exit']).optional().describe('Which decision to draw (default auto — both if present)'),
    },
    wrap(({ symbol, side }) => core.drawDecision({ symbol, side })),
  );
}
