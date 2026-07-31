import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/zones.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';
import { classifySwings } from '../core/context.js';
import { COLORS, resolveTime, drawShape } from '../core/drawing.js';
import { evaluate, getChartApi } from '../connection.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

async function loadBars(count) {
  const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  return bars;
}

const ZONE_OPTS = {
  count: z.coerce.number().optional().describe('Bars to scan (default 300)'),
  momentum_multiple: z.coerce.number().optional().describe('How many times the prior average body the departure candle must be (default 2)'),
  base_candles: z.enum(['1', '3']).optional().describe('Candles before the departure that form the zone — the 1-candle or 3-candle convention (default 1)'),
  max_age_bars: z.coerce.number().optional().describe('Ignore zones older than this (default 120)'),
  min_departure_pct: z.coerce.number().optional().describe('Require price to have travelled this far from the zone (default 0)'),
  include_broken: z.boolean().optional().describe('Include zones price has closed through (default false)'),
  fresh_only: z.boolean().optional().describe('Only zones price has never returned to (default false)'),
};

async function collect({ count = 300, base_candles, fresh_only, ...opts }) {
  const bars = await loadBars(count);
  // Tag zones that sit on a swing the market already proved, rather than
  // recomputing break-of-structure here and risking a second opinion.
  const strong = classifySwings(bars, { lookback: 5 }).swings;
  const found = core.findZones(bars, {
    ...opts,
    base_candles: base_candles ? Number(base_candles) : 1,
    strong_swings: strong,
  });
  const zones = fresh_only ? found.zones.filter((z) => z.status === 'fresh') : found.zones;
  return { bars, found, zones };
}

export function registerZoneTools(server) {
  server.tool(
    'zones_find',
    'Supply and demand zones — the base a move DEPARTED from, which is a different question from levels_find (where price repeatedly reversed). A demand zone is the candles before a sharp move up; supply is the mirror. Each carries what was actually measured: how fast price left, how far it got, and whether it has reacted there since. Reports how many existed before filtering, because zones are common.',
    ZONE_OPTS,
    wrap(async (args) => {
      const { bars, found, zones } = await collect(args);
      const price = bars[bars.length - 1].close;
      return {
        success: true,
        ...found,
        zones,
        current_price: price,
        nearest: core.nearestZones(zones, price),
        ...(args.fresh_only ? { filtered_already_tested: found.zones.length - zones.length } : {}),
      };
    }),
  );

  server.tool(
    'zones_draw',
    'Draw supply and demand zones on the chart as shaded rectangles, grouped so they clear in one call without touching your own drawings. Demand green, supply red, with the evidence in the label. Call zones_find first if you want to see them before they land on a live chart.',
    {
      ...ZONE_OPTS,
      max_zones: z.coerce.number().optional().describe('Most zones to draw (default 6)'),
      group: z.string().optional().describe('Drawing group name (default zones-<TICKER>)'),
      extend_bars: z.coerce.number().optional().describe('Extend zones this many bars past the last bar (default 10)'),
    },
    wrap(async ({ max_zones = 6, group, extend_bars = 10, ...args }) => {
      const { bars, found, zones } = await collect(args);
      if (!zones.length) {
        return { success: true, drawn: 0, zones: [], note: found.note || 'No zones cleared the filters. Lower momentum_multiple or raise max_age_bars.' };
      }

      const apiPath = await getChartApi();
      const symbol = await evaluate(`(function(){try{return ${apiPath}.symbol();}catch(e){return null;}})()`);
      const ticker = (symbol || 'chart').replace(/^.*:/, '');
      const groupName = group || `zones-${ticker}`;

      const lastTime = await resolveTime('last_bar');
      const barSeconds = bars.length > 1
        ? Math.max(1, (bars[bars.length - 1].time - bars[0].time) / (bars.length - 1))
        : 86400;
      const endTime = lastTime + Math.round(extend_bars * barSeconds);

      const pick = zones.slice(0, max_zones);
      const drawn = [];
      let ok = 0;

      for (const z of pick) {
        const colour = z.kind === 'demand' ? COLORS.target : COLORS.stop;
        // The momentum slot is always filled — "n/a" when the multiple is
        // unmeasurable (zero-body base). A suffixless "demand fresh" is pinned
        // as hand-typed in the orphan-sweep negatives, so it must never be
        // emitted; this template is itself pinned verbatim in orphans.test.js.
        const label = `${z.kind} ${z.status}${z.grade === 'aggressive' ? ' · aggressive' : ''} · ${z.momentum_x == null ? 'n/a' : z.momentum_x + 'x'}`;
        try {
          const res = await drawShape({
            shape: 'rectangle',
            point: { price: z.top, time: z.time },
            point2: { price: z.bottom, time: endTime },
            text: label,
            group: groupName,
            overrides: {
              color: colour, linewidth: 1, backgroundColor: colour,
              fillBackground: true,
              // A fresh zone is drawn more solidly than one already traded
              // through — the same information the status field carries.
              transparency: z.status === 'fresh' ? 82 : 90,
              showLabel: true, textcolor: colour, fontsize: 11,
            },
          });
          if (res.entity_id) {
            ok++;
            drawn.push({ kind: z.kind, top: z.top, bottom: z.bottom, status: z.status, grade: z.grade, evidence: z.evidence, entity_id: res.entity_id });
          } else {
            drawn.push({ kind: z.kind, top: z.top, bottom: z.bottom, error: 'TradingView accepted the shape but did not expose an id for it.' });
          }
        } catch (e) {
          drawn.push({ kind: z.kind, top: z.top, bottom: z.bottom, error: e.message });
        }
      }

      const failed = drawn.filter((d) => d.error);
      return {
        success: true,
        group: groupName,
        drawn: ok,
        requested: pick.length,
        available: zones.length,
        zones: drawn,
        total_found: found.total_found,
        ...(failed.length ? { warning: `${failed.length} of ${pick.length} zone(s) failed to draw.` } : {}),
        clear_hint: `Remove with draw_clear group="${groupName}".`,
        caveat: found.caveat,
      };
    }),
  );
}
