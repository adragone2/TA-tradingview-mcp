#!/usr/bin/env node
/**
 * WRDS MCP server — read-only SQL access to Wharton Research Data Services.
 *
 * Kept separate from the TradingView server on purpose: different data, its own
 * dependency (`pg`), and no CDP involvement. Run it as its own MCP server.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wrds from './wrds.js';
import * as backtest from './backtest.js';

const CONDITION_SCHEMA = z.object({
  indicator: z.enum(['sma', 'ema', 'rsi', 'close']).describe('Which indicator to evaluate'),
  period: z.coerce.number().optional().describe('Lookback period (default 14)'),
  op: z.enum(['above', 'below', 'price_above', 'price_below'])
    .describe('price_above/price_below compare close to the indicator; above/below compare the indicator to value or compare'),
  value: z.coerce.number().optional().describe('Constant to compare against, e.g. RSI below 60'),
  compare: z.object({
    indicator: z.enum(['sma', 'ema', 'rsi', 'close']),
    period: z.coerce.number().optional(),
  }).optional().describe('Compare against another indicator instead of a constant, e.g. SMA50 above SMA200'),
});

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader so credentials live in a git-ignored file rather than
// being exported into a shell or, worse, pasted into a conversation.
function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

function jsonResult(payload, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError };
}

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

const server = new McpServer(
  { name: 'wrds-mcp', version: '0.1.0' },
  {
    instructions: [
      'Read-only SQL access to WRDS (Wharton Research Data Services) over PostgreSQL.',
      '',
      'WHAT THIS IS GOOD FOR: historical research — CRSP returns, Compustat fundamentals,',
      'IBES estimates and historical announcement dates. Use it to validate whether a',
      'strategy actually had edge, not to fetch live prices.',
      '',
      'WHAT IT IS NOT: a real-time feed. WRDS updates periodically (daily to quarterly by',
      'dataset). Do NOT use it for current quotes or a forward earnings calendar — for',
      'live data use the TradingView tools, and for upcoming event dates use web search.',
      '',
      'START WITH wrds_health_check, then wrds_list_schemas. Entitlements differ per',
      'institution — never assume a dataset exists, discover it. Then wrds_list_tables and',
      'wrds_describe_table before writing a query, because column names vary by vintage.',
      '',
      'Queries are SELECT/WITH only and get a LIMIT if none is supplied. WRDS tables are',
      'large: filter by date and identifier, and prefer aggregates over pulling raw rows.',
    ].join('\n'),
  },
);

server.tool(
  'wrds_health_check',
  'Verify the WRDS connection and report which datasets this subscription can see. Call this first — it distinguishes a credentials problem from an entitlement problem.',
  {},
  wrap(() => wrds.healthCheck()),
);

server.tool(
  'wrds_list_schemas',
  'List the schemas this WRDS account can read, with table counts. Entitlements vary per institution, so use this instead of assuming a dataset is present.',
  { filter: z.string().optional().describe('Case-insensitive substring filter, e.g. "crsp" or "ciq"') },
  wrap(({ filter }) => wrds.listSchemas({ filter })),
);

server.tool(
  'wrds_list_tables',
  'List tables in a WRDS schema.',
  {
    schema: z.string().describe('Schema name from wrds_list_schemas'),
    filter: z.string().optional().describe('Case-insensitive substring filter on the table name'),
  },
  wrap(({ schema, filter }) => wrds.listTables({ schema, filter })),
);

server.tool(
  'wrds_describe_table',
  'List the columns and types of a WRDS table. Do this before writing a query — column names differ across datasets and vintages.',
  {
    schema: z.string().describe('Schema name'),
    table: z.string().describe('Table name'),
  },
  wrap(({ schema, table }) => wrds.describeTable({ schema, table })),
);

server.tool(
  'wrds_query',
  'Run a read-only SQL query against WRDS. SELECT and WITH only; anything else is rejected. A LIMIT is added when the query has none. Use parameterised placeholders ($1, $2) rather than interpolating values. WRDS tables are very large — always filter by date range and identifier.',
  {
    sql: z.string().describe('A single SELECT or WITH statement'),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
      .describe('Values for $1, $2, ... placeholders'),
    limit: z.coerce.number().optional().describe('Row cap when the query has no LIMIT (default 1000, max 50000)'),
  },
  wrap(({ sql, params, limit }) => wrds.query({ sql, params, limit })),
);

server.tool(
  'wrds_resolve_tickers',
  'Map tickers to CRSP permnos for a date window. Run this before a backtest to see which names resolve, and to catch tickers that were reused by a different company during the window.',
  {
    tickers: z.array(z.string()).describe('Ticker symbols, e.g. ["AMD","AMZN"]'),
    start: z.string().describe('Window start, YYYY-MM-DD'),
    end: z.string().describe('Window end, YYYY-MM-DD'),
  },
  wrap(({ tickers, start, end }) => backtest.resolveTickers({ tickers, start, end })),
);

server.tool(
  'wrds_backtest_signal',
  'Test whether a technical signal actually preceded better-than-baseline returns, using CRSP daily data. Conditions are ANDed. Always reports the unconditional baseline over the same names and dates alongside the signal — the signal number alone is meaningless without it. Returns are gross of costs, forward windows overlap, and CRSP daily data ends in 2024, so this validates a rule rather than predicting tomorrow.',
  {
    tickers: z.array(z.string()).describe('Tickers to test, max 100'),
    conditions: z.array(CONDITION_SCHEMA).describe('Signal definition; all conditions must hold on the same bar'),
    start: z.string().optional().describe('Start date YYYY-MM-DD (default 2005-01-01)'),
    end: z.string().optional().describe('End date YYYY-MM-DD (default 2024-12-31 — CRSP daily coverage ends there)'),
    horizons: z.array(z.coerce.number()).optional().describe('Forward horizons in trading days (default [5,10,20], suited to swing holds)'),
  },
  wrap((args) => backtest.backtestSignal(args)),
);

process.stderr.write(
  '⚠  wrds-mcp  |  Read-only WRDS access. Data is licensed to your institution — check your\n' +
  '   subscription terms before using it outside permitted research, and do not redistribute.\n',
);

const shutdown = async () => { await wrds.closePool(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
