import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/ta_api.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerTaApiTools(server) {
  server.tool(
    'ta_health',
    'Check whether the Tactical Alpha API is reachable and whether an API key is configured. Unauthenticated, so it separates "TA is down" from "my key is wrong". Start here when any ta_* tool fails.',
    {},
    wrap(() => core.health()),
  );

  server.tool(
    'ta_status',
    'Show which TA base URL is in use and whether a key is configured. Never returns the key itself.',
    {},
    wrap(() => core.apiStatus()),
  );

  server.tool(
    'ta_trading_context',
    'For specific tickers, pull the two things a chart cannot tell you: whether you already hold the name, and whether it reports soon — plus the current market regime. Call this BEFORE acting on a chart setup. This is risk context, not a signal.',
    {
      symbols: z.array(z.string()).describe('Tickers to check, e.g. ["AMD","AVGO"]'),
    },
    wrap(({ symbols }) => core.tradingContext({ symbols })),
  );

  server.tool(
    'ta_portfolio',
    'Current portfolio positions from Tactical Alpha. Use to check existing exposure and concentration before adding a trade.',
    {
      live: z.coerce.boolean().optional().describe('Use the live endpoint with current marks (default false)'),
    },
    wrap(({ live }) => core.portfolio({ live })),
  );

  server.tool(
    'ta_earnings',
    'The TA earnings calendar. This is the authoritative source for upcoming report dates — prefer it over web search.',
    {},
    wrap(() => core.earnings()),
  );

  server.tool(
    'ta_regime',
    'Current market regime from TA. Use to judge whether conditions favour the kind of setup being considered.',
    {
      detail: z.enum(['regime', 'vol', 'vix', 'macro', 'sectors', 'breadth']).optional()
        .describe('Which view (default "regime")'),
    },
    wrap(({ detail }) => {
      switch (detail) {
        case 'vol': return core.volRegime();
        case 'vix': return core.vix();
        case 'macro': return core.macro();
        case 'sectors': return core.sectors();
        case 'breadth': return core.breadth();
        default: return core.regime();
      }
    }),
  );

  server.tool(
    'ta_alerts',
    'Active alerts from Tactical Alpha.',
    {},
    wrap(() => core.alerts()),
  );

  server.tool(
    'ta_investing_brief',
    "TA's own morning brief. This is the INVESTING view — portfolio, macro and regime. It is distinct from this server's morning_brief, which is the TRADING view built from live charts. Use both when the user wants the full picture; do not conflate them.",
    {},
    wrap(() => core.investingBrief()),
  );

  server.tool(
    'ta_digest',
    "TA's AI digest feed.",
    {},
    wrap(() => core.digest()),
  );

  server.tool(
    'ta_get',
    'GET any Tactical Alpha API endpoint. Use for endpoints without a dedicated tool, or to inspect an unfamiliar response shape. Read-only.',
    {
      path: z.string().describe('Endpoint path, e.g. "/api/v1/etf/SPY/holdings"'),
      // Zod 4 needs an explicit key AND value type; a single-argument
      // z.record() builds a schema that fails JSON Schema conversion and takes
      // the whole tools/list response down with it.
      params: z.record(z.string(), z.string()).optional().describe('Query string parameters'),
    },
    wrap(({ path, params }) => core.get(path, { params })),
  );
}
