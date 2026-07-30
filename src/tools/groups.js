import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/groups.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerGroupTools(server) {
  server.tool(
    'group_context',
    'The industry-group context Livermore put BEFORE every trade, and the one thing this toolchain had no equivalent for. relative_strength compares a symbol to an INDEX; this asks whether its GROUP is moving and whether the SISTER STOCK agrees. "Livermore never tracked a single stock. He first tracked the industry group movements... a legitimate group movement had to include at least the two leaders of the group." Returns: the symbol\'s group and sector (the scanner\'s industry and sector map exactly onto his Group and Sector, a distinction he insisted people conflate), the group\'s two leaders by market cap, the KEY PRICE — his combined-move confirmation on those two leaders — and the LAGGARDS, members trailing the group median, which he read as weak or sick and therefore short candidates. Worth understanding about the Key Price: requiring the SUM of two moves to clear twice a bar is the same as requiring their AVERAGE to clear it, so it is more permissive than demanding both clear it individually — leaders_agree is what separates "both moving" from "one leader carrying it", and the second case is the false movement his rule exists to catch. His six-POINT threshold is not copied: six points on a $30 stock is 20%, a 1940 artefact, so the bar is a percentage here. IMPORTANT: this is CONTEXT, not an edge. His claim that groups lead the market by three to six months is UNMEASURED here, and this repo has already had two alignment claims (level_pressure, stage_plan) die on measurement.',
    {
      symbol: z.string().describe('Ticker, e.g. "AAPL". Exchange prefix optional.'),
      universe: z.string().optional().describe('Comma-separated universe keys to search for group members (default "sp500"). Use "sp500,nasdaq,russell2000" for a wider group.'),
      window: z.enum(['Perf.W', 'Perf.1M', 'Perf.3M']).optional().describe('Performance window for the Key Price (default Perf.1M — a month, matching his major-move framing better than a week)'),
      threshold_pct: z.coerce.number().optional().describe('Key Price bar as a percent move, per leader (default 6). Pass 20 to reproduce his original six-points-on-a-$30-stock.'),
      min_gap_pct: z.coerce.number().optional().describe('How far behind the group median a member must be to count as a laggard (default 5 points)'),
      limit: z.coerce.number().optional().describe('Rows to pull from the scanner (default 500)'),
    },
    wrap(async ({ symbol, universe = 'sp500', window = 'Perf.1M', threshold_pct = 6, min_gap_pct = 5, limit = 500 }) => {
      const keys = String(universe).split(',').map((s) => s.trim()).filter(Boolean);
      const { rows, fetched } = await core.fetchGroupRows({ universe: keys, limit });

      const row = core.findRow(rows, symbol);
      if (!row) {
        return {
          success: true,
          symbol: core.bare(symbol),
          available: false,
          note: `${core.bare(symbol)} is not in the ${keys.join('+')} universe as scanned (${fetched} rows). `
            + 'Widen `universe`, or raise `limit`.',
        };
      }
      if (!row.industry) {
        return {
          success: true, symbol: core.bare(symbol), available: false,
          note: `The scanner returned no industry for ${core.bare(symbol)}, so its group cannot be resolved. `
            + 'That is unknown, not "no group".',
        };
      }

      const members = core.groupMembers(rows, row.industry);
      const { leaders, members_considered, top_cap_share_pct, dominant } = core.groupLeaders(members);
      const kp = core.keyPrice(leaders, { window, threshold_pct });
      const lag = core.laggards(members, { window, min_gap_pct });

      const isLeader = leaders.some((l) => core.bare(l.symbol) === core.bare(symbol));
      const selfMove = Number(row[window]);
      const groupMedian = lag.available ? lag.group_median_move_pct : null;

      return {
        success: true,
        symbol: core.bare(symbol),
        name: row.name,
        available: true,
        sector: row.sector,
        group: row.industry,
        sector_vs_group: 'The scanner\'s `sector` is Livermore\'s Sector (an area, e.g. Electronic Technology) and '
          + '`industry` is his Group (e.g. Semiconductors). His rule operates on the GROUP. He was explicit that people '
          + 'conflate the two.',
        group_size: members_considered,
        universe_scanned: keys,
        rows_scanned: fetched,

        leaders: leaders.map((l) => ({
          symbol: core.bare(l.symbol),
          name: l.name,
          market_cap_b: Math.round((Number(l.market_cap_basic) || 0) / 1e9),
          move_pct: Number.isFinite(Number(l[window])) ? Math.round(Number(l[window]) * 100) / 100 : null,
          is_the_requested_symbol: core.bare(l.symbol) === core.bare(symbol),
        })),
        top_cap_share_pct,
        ...(dominant ? { dominant_leader: dominant } : {}),

        key_price: kp,

        this_symbol: {
          move_pct: Number.isFinite(selfMove) ? Math.round(selfMove * 100) / 100 : null,
          is_a_group_leader: isLeader,
          vs_group_median_pct: Number.isFinite(selfMove) && groupMedian !== null
            ? Math.round((selfMove - groupMedian) * 100) / 100
            : null,
          leader_note: isLeader
            ? 'This IS one of the two leaders. Livermore only traded leaders: "If you cannot make money out of the '
              + 'leading active issues, you are not going to make money out of the stock market."'
            : `This is NOT one of the group's two leaders (${leaders.map((l) => core.bare(l.symbol)).join(', ')}). `
              + 'He would trade the leader instead — "don\'t play in the junkyard with the weaker stocks."',
        },

        laggards: lag,

        threshold_note: core.LIVERMORE_POINT_NOTE,
        lead_lag_claim: core.GROUP_LEAD_LAG_STUDY,
        tandem_confirmation_study: core.TANDEM_CONFIRMATION_STUDY,
        how_to_use: 'CONTEXT, like short_interest and ta_trading_context. Read it BEFORE analysing the setup, not after. '
          + 'It does not say the trade is good — his lead-lag claim is unmeasured here, and two alignment gates in this '
          + 'repo have already been measured and found not to help.',
      };
    }),
  );

  server.tool(
    'group_top_down',
    'Livermore\'s Top Down Trading as an explicit four-step GATE, in his order: the market the stock trades on, then the industry group, then the two leaders in tandem (the Key Price), then the individual name. It CLOSES unless all three levels point the same way and both leaders agree — "no trader can or should play the market all the time; there will be many times when you should be out of the market, sitting in cash." Supply the market direction yourself from whatever measured it (market_regime, mtf_analyze, stage_plan) so this does not silently invent its own trend definition. The gate is honest about what it is not: an alignment gate is not an edge, and stage_plan — the last alignment gate built here — filtered well and made forward outcomes WORSE (long 33.5% vs a 36.4% baseline). Use this to decide when NOT to trade.',
    {
      symbol: z.string().describe('Ticker to evaluate'),
      market: z.enum(['up', 'down', 'flat']).describe('Direction of the market this stock trades on — get it from market_regime or mtf_analyze, do not guess'),
      universe: z.string().optional().describe('Universe keys for group membership (default "sp500")'),
      window: z.enum(['Perf.W', 'Perf.1M', 'Perf.3M']).optional().describe('Performance window (default Perf.1M)'),
      threshold_pct: z.coerce.number().optional().describe('Key Price bar per leader, percent (default 6)'),
      side: z.enum(['long', 'short']).optional().describe('Restrict to one side. A side contradicting the aligned direction closes the gate rather than obliging.'),
      limit: z.coerce.number().optional().describe('Scanner rows (default 500)'),
    },
    wrap(async ({ symbol, market, universe = 'sp500', window = 'Perf.1M', threshold_pct = 6, side = null, limit = 500 }) => {
      const keys = String(universe).split(',').map((s) => s.trim()).filter(Boolean);
      const { rows, fetched } = await core.fetchGroupRows({ universe: keys, limit });
      const row = core.findRow(rows, symbol);
      if (!row?.industry) {
        return {
          success: true, symbol: core.bare(symbol), available: false,
          note: `Could not resolve a group for ${core.bare(symbol)} in ${keys.join('+')} (${fetched} rows scanned).`,
        };
      }

      const members = core.groupMembers(rows, row.industry);
      const { leaders } = core.groupLeaders(members);
      const kp = core.keyPrice(leaders, { window, threshold_pct });

      // Group direction from the median member move — a median rather than a mean
      // so one runaway name cannot define the group's trend.
      const lag = core.laggards(members, { window });
      const median = lag.available ? lag.group_median_move_pct : null;
      const groupDir = median === null ? null : median > 0 ? 'up' : median < 0 ? 'down' : 'flat';

      return {
        success: true,
        symbol: core.bare(symbol),
        sector: row.sector,
        group: row.industry,
        group_median_move_pct: median,
        group_direction: groupDir,
        market_direction: market,
        key_price: kp,
        ...core.topDownGate({ market, group: groupDir, key_price: kp, side }),
        next_step: 'If the gate is OPEN, that means nothing is contradicting the trade — not that the trade is good. '
          + 'Size it with position_size_constrained, check ta_trading_context for an earnings date, and read '
          + 'horizon_prior for which side of the reversal/continuation boundary the hold sits on.',
        lead_lag_claim: core.GROUP_LEAD_LAG_STUDY,
        tandem_confirmation_study: core.TANDEM_CONFIRMATION_STUDY,
      };
    }),
  );
}
