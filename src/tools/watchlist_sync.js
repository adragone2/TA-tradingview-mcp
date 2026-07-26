import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist_sync.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerWatchlistSyncTools(server) {
  server.tool(
    'watchlist_read',
    "Read the active TradingView watchlist split into its sections. Sections are stored as entries prefixed '###'; this returns them structured.",
    {},
    wrap(async () => {
      const tv = await core.readTvWatchlist();
      return {
        success: true,
        id: tv.id,
        name: tv.name,
        total_entries: tv.total,
        sections: tv.sections.map((s) => ({ name: s.name, count: s.symbols.length, symbols: s.symbols })),
      };
    }),
  );

  server.tool(
    'watchlist_sync_plan',
    'Show what syncing from Tactical Alpha would change, without writing anything. Additive only — reports per-section additions, TA files with no mapped section, and symbols already present elsewhere. Run this before watchlist_sync.',
    {
      mapping: z.record(z.string(), z.string()).optional()
        .describe('Override the TA-file → TV-section map, e.g. {"watchlist_pillar2.csv":"MIX"}'),
    },
    wrap(({ mapping }) => core.planSync({ mapping })),
  );

  server.tool(
    'watchlist_sync',
    "Sync the TradingView watchlist from Tactical Alpha. ADDITIVE ONLY — adds symbols TA has that TradingView lacks, into the matching existing section, and never removes anything. Resolves TA tickers to TradingView equivalents (RHM.DE → XETR:RHM, BTC → COINBASE:BTCUSD). Refuses to write if the rebuild would drop any existing symbol.",
    {
      dry_run: z.coerce.boolean().optional().describe('Plan only, write nothing'),
      mapping: z.record(z.string(), z.string()).optional().describe('Override the TA-file → TV-section map'),
    },
    wrap(({ dry_run, mapping }) => core.applySync({ dry_run, mapping })),
  );
}
