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
    'walls_apply_many',
    'Apply walls across several symbols, switching the chart to each in turn and restoring it afterwards. The indicator holds one symbol\'s walls at a time, so this is for pre-loading a sweep rather than showing them all at once.',
    {
      symbols: z.array(z.string()).describe('Tickers to apply, e.g. ["SMH","XLK","XLE"]'),
      dry_run: z.coerce.boolean().optional().describe('Build without writing'),
    },
    wrap(({ symbols, dry_run }) => core.applyWallsForSymbols({ symbols, dry_run })),
  );
}
