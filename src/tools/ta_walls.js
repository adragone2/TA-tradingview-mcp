import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/ta_walls.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerTaWallsTools(server) {
  server.tool(
    'walls_coverage',
    "List the tickers TA has gamma-wall data for, and the date of the latest snapshot. Walls are derived from option chains, so coverage is limited to names with a liquid chain — check here before assuming a symbol is available.",
    {},
    wrap(() => core.listCoverage()),
  );

  server.tool(
    'walls_get',
    "Build the Institutional Matrix JSON for a symbol from TA's latest wall snapshot, without writing it to the chart. Use to inspect the levels or check freshness first.",
    {
      symbol: z.string().describe('Ticker, with or without exchange prefix (e.g. "SMH" or "BATS:SMH")'),
    },
    wrap(({ symbol }) => core.buildWallsJson({ symbol })),
  );

  server.tool(
    'walls_apply',
    "Write TA's latest gamma walls into the Institutional Matrix indicator on the current chart, replacing the hand-pasted JSON. Defaults to the symbol already on the chart. The write is verified, and the response carries warnings when the snapshot is stale or a horizon had a thin option chain.",
    {
      symbol: z.string().optional().describe('Override the symbol (defaults to the chart\'s current symbol)'),
      dry_run: z.coerce.boolean().optional().describe('Build and return the JSON without writing it'),
    },
    wrap(({ symbol, dry_run }) => core.applyWalls({ symbol, dry_run })),
  );

  server.tool(
    'walls_draw',
    "Draw TA's gamma walls as native chart lines instead of writing them into the Institutional Matrix indicator. Use when the indicator isn't on the layout, when you want walls alongside entry/exit levels in one visual system, or when the levels need to be readable back via draw_list. Prefer walls_apply where the indicator IS present — it also renders a panel and recalculates with the chart, whereas these lines are a static snapshot.",
    {
      symbol: z.string().optional().describe("Override the symbol (defaults to the chart's current symbol)"),
      horizons: z.array(z.enum(['d', 'w', 'm'])).optional()
        .describe('Expiry horizons to draw: d=daily, w=weekly, m=monthly (default ["d","w"])'),
      include_gex: z.coerce.boolean().optional().describe('Include GEX walls as well as OI walls (default true)'),
      include_flip: z.coerce.boolean().optional().describe('Include the gamma flip level (default true)'),
    },
    wrap(({ symbol, horizons, include_gex, include_flip }) =>
      core.drawWalls({ symbol, horizons, include_gex, include_flip })),
  );

  server.tool(
    'walls_apply_many',
    'Apply walls across several symbols, switching the chart to each in turn and restoring it afterwards. The indicator holds one symbol\'s walls at a time, so this is for pre-loading a sweep rather than showing them all at once.',
    {
      symbols: z.array(z.string()).describe('Tickers to apply, e.g. ["SMH","XLK","XLE"]'),
      dry_run: z.coerce.boolean().optional().describe('Build without writing'),
    },
    wrap(({ symbols, dry_run }) => core.applyWallsForSymbols({ symbols, dry_run })),
  );
}
