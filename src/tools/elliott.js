import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/elliott.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

async function loadBars(count) {
  const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  return bars;
}

export function registerElliottTools(server) {
  server.tool(
    'elliott_count',
    'Every rule-valid five-wave Elliott count in the bars — not "the" count. Elliott wave is subjective by construction, so this enumerates all counts the swing data supports, tests each against the five rules (which ARE objective once a count is proposed), and returns all survivors with the total stated. If several are valid, that number is itself the finding. The four conventional Fibonacci relationships are measured per count and shown next to their typical bands, so fit is visible without any count being called correct.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 300)'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5). Different values give different counts — that is the method, not a bug'),
      include_truncated: z.boolean().optional().describe('Include counts where wave 5 failed to exceed wave 3 (default false)'),
      max_counts: z.coerce.number().optional().describe('Most counts to return, newest first (default 5)'),
    },
    wrap(async ({ count = 300, lookback, include_truncated, max_counts = 5 }) => {
      const bars = await loadBars(count);
      const r = core.findCounts(bars, { lookback, include_truncated });
      const shown = r.counts.slice(0, max_counts);
      return {
        success: true,
        ...r,
        counts: shown,
        ...(r.counts.length > shown.length
          ? { truncated_output: `${r.counts.length} valid counts found; showing the ${shown.length} most recent. Raise max_counts to see the rest.` }
          : {}),
        caveat: core.ELLIOTT_CAVEAT,
      };
    }),
  );

  server.tool(
    'elliott_survey',
    'Run the Elliott enumeration at several swing sensitivities and report whether they agree. "Two analysts get different valid counts on the same chart" is the standard criticism of the method, usually left as a remark — this turns it into a number for this chart. Agreement across sensitivities is the strongest confirmation Elliott offers; disagreement is a reason to weight the count lightly.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 300)'),
      lookbacks: z.string().optional().describe('Comma-separated sensitivities, e.g. "3,5,8" (default 3,5,8)'),
      include_truncated: z.boolean().optional().describe('Include truncated counts (default false)'),
    },
    wrap(async ({ count = 300, lookbacks, include_truncated }) => {
      const bars = await loadBars(count);
      const lbs = lookbacks
        ? lookbacks.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
        : undefined;
      return {
        success: true,
        ...core.surveyCounts(bars, { lookbacks: lbs, include_truncated }),
        caveat: core.ELLIOTT_CAVEAT,
      };
    }),
  );
}
