import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as finra from '../core/finra.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerFinraTools(server) {
  server.tool(
    'short_interest',
    'FINRA short interest for a symbol — how many shares are sold short and not yet covered, the average daily volume behind it, and days to cover, as a bi-monthly series. This is the only field in this toolchain that measures POSITIONING rather than price, and every short is future demand because it must eventually be bought back. It is NOT a signal: Shannon is explicit that "a large outstanding short position or short interest ratio by itself is not a reason for buying a stock in anticipation of a short squeeze" — use it as context on a setup found some other way, like ta_trading_context. Two things this fixes in the raw feed: FINRA FLOORS days-to-cover at 1.00 (AAPL\'s true 0.90 was reported as 1), so the computed figure is returned alongside the reported one; and days-to-cover is a ratio that mostly moves when its DENOMINATOR moves, so every period change is decomposed into short-interest versus average-volume contributions. MEASURED over 40 symbols and 1000 period changes: 93% of days-to-cover moves of 20% or more were driven by AVERAGE VOLUME, not by the short position — 100% of them on NVDA, AMZN, GOOGL, META, TSLA, PNC, BAC, PFE, MRK and CYTK. Read vs_prior_period.driver before quoting the ratio, or you will report a liquidity change as shorts piling in. Pass with_price to estimate the shorts\' cost basis from the period VWAP and say whether they are underwater, which is the condition squeeze pressure actually needs.',
    {
      symbol: z.string().describe('Ticker, e.g. "PNC". Exchange-listed and OTC both work.'),
      periods: z.coerce.number().optional().describe('Settlement periods to return, newest first (default 12 — about six months at two per month)'),
      as_of: z.string().optional().describe('ISO date to measure staleness against (default today). Set it to make a result reproducible.'),
      with_price: z.coerce.boolean().optional().describe('Load daily bars for the symbol to compute each period\'s VWAP and whether the shorts are underwater (default false — it changes the chart symbol)'),
      dataset: z.enum(['consolidated', 'otc']).optional().describe('"consolidated" (default) covers all exchanges plus OTC. "otc" is OTC-only and returns nothing for a listed name.'),
    },
    wrap(async ({ symbol, periods = 12, as_of = null, with_price = false, dataset = 'consolidated' }) => {
      const asOf = as_of || new Date().toISOString().slice(0, 10);

      // fetchSeries owns the window and limit arithmetic, because FINRA's limit
      // truncates from the OLDEST end — a limit that binds drops the NEWEST
      // periods and makes a paging bug look like stale data.
      const {
        rows, dataset: usedDataset, empty_reason, window, truncation_warning,
      } = await finra.fetchSeries(symbol, { periods, asOf, dataset });

      if (!rows.length) {
        return {
          success: true, symbol: symbol.toUpperCase(), dataset: usedDataset,
          available: false, note: empty_reason, window,
        };
      }

      // Bars are optional because loading them changes the chart symbol — a
      // visible side effect on a live chart, so it is opt-in.
      let bars = null; let lastPrice = null;
      if (with_price) {
        try {
          const series = await data.getOhlcv({ symbol: symbol.toUpperCase(), count: 400, summary: false });
          bars = normalizeBars(series);
          lastPrice = bars.length ? bars[bars.length - 1].close : null;
        } catch (err) {
          bars = null;
          lastPrice = null;
          // Don't fail the whole call — the short-interest series is still good.
          return {
            success: true, symbol: symbol.toUpperCase(), dataset: usedDataset,
            ...finra.buildSeries(rows, { asOf, periods }),
            ...(truncation_warning ? { truncation_warning } : {}),
            price_context_unavailable: `Could not load bars for ${symbol}: ${err.message}. The series below is unaffected.`,
          };
        }
      }

      return {
        success: true,
        symbol: symbol.toUpperCase(),
        dataset: usedDataset,
        ...finra.buildSeries(rows, { asOf, bars, lastPrice, periods }),
        ...(truncation_warning ? { truncation_warning } : {}),
      };
    }),
  );

  server.tool(
    'finra_status',
    'Whether the FINRA credentials are configured and which short-interest dataset is in use, plus the reporting cadence. Reports configuration only — never a credential value. Call this when short_interest errors, to tell a missing credential apart from a bad request.',
    {},
    wrap(async () => finra.apiStatus()),
  );
}
