import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jsonResult } from './_format.js';
import * as data from '../core/data.js';
import * as chart from '../core/chart.js';
import { normalizeBars } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

/**
 * Export chart bars as CSV.
 *
 * The `patternz` format is Bulkowski's own — Date,Open,High,Low,Close,Volume
 * with ISO dates, exactly as shipped in his sample file. That matters because
 * it makes a cross-check possible: run Patternz over the same bars this
 * toolchain analysed and compare what his detector finds against what
 * patterns_detect finds.
 *
 * That comparison is the one form of validation this repo has never had.
 * Everything here is checked against its own tests and against a live chart,
 * but nothing has ever been checked against an independent implementation of
 * the same patterns — least of all the implementation written by the person
 * whose statistics the tool quotes.
 */
export function registerExportTools(server) {
  server.tool(
    'export_bars_csv',
    'Write the chart\'s bars to a CSV file. The "patternz" format matches Bulkowski\'s own sample file exactly (Date,Open,High,Low,Close,Volume, ISO dates), so his free Patternz software can read the same bars this toolchain analysed — which makes it possible to compare his pattern detections against patterns_detect on identical data. That cross-check against an independent implementation is validation this repo has never had.',
    {
      count: z.coerce.number().optional().describe('Bars to export (default 500)'),
      format: z.enum(['patternz', 'generic']).optional().describe('CSV layout (default patternz)'),
      filename: z.string().optional().describe('Output filename. Defaults to <TICKER>.csv, which is what Patternz expects'),
      directory: z.string().optional().describe('Output directory relative to the repo (default "exports")'),
    },
    wrap(async ({ count = 500, format = 'patternz', filename, directory = 'exports' }) => {
      const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!bars.length) throw new Error('No price bars came back from the chart.');

      const state = await chart.getState().catch(() => null);
      const symbol = state?.symbol || 'chart';
      const ticker = symbol.replace(/^.*:/, '').replace(/[^A-Za-z0-9._-]/g, '');

      // Patternz keys bars by DATE, so an intraday chart would collapse
      // multiple bars onto one date and silently corrupt the file.
      const spacing = bars.length > 1 ? bars[1].time - bars[0].time : 86400;
      const intraday = spacing < 86400;

      const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
      const rows = bars.map((b) =>
        [iso(b.time), b.open, b.high, b.low, b.close, Number.isFinite(b.volume) ? b.volume : 0].join(','));
      const header = 'Date,Open,High,Low,Close,Volume';
      const csv = [header, ...rows].join('\n') + '\n';

      const dir = resolve(process.cwd(), directory);
      mkdirSync(dir, { recursive: true });
      const name = filename || `${ticker}.csv`;
      const path = join(dir, name);
      writeFileSync(path, csv, 'utf8');

      return {
        success: true,
        file: path,
        symbol,
        bars: bars.length,
        format,
        first_date: iso(bars[0].time),
        last_date: iso(bars[bars.length - 1].time),
        ...(intraday
          ? { warning: `These are INTRADAY bars (${Math.round(spacing / 60)} minutes apart) and this format keys on date alone, so multiple bars share a date. Patternz expects daily data — switch the chart to 1D before exporting, or the file will be misread rather than rejected.` }
          : {}),
        how_to_use: `Open Patternz, point its file format at ${name} (Date,Open,High,Low,Close,Volume), and run its pattern search over the same bars. Then compare its detections against patterns_detect on this symbol.`,
        why: 'An independent implementation of the same patterns, written by the author whose statistics this toolchain quotes. Where the two disagree, at least one is wrong — and this repo has never had a way to find out which.',
      };
    }),
  );
}
