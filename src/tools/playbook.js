import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as check from '../core/screen_check.js';
import { scan } from '../core/scanner.js';
import { scannerTrust } from '../core/session.js';
import { loadCatalogue, mergedStrategies } from '../core/catalogue.js';
import { resolveRules } from '../core/rules.js';
import * as chart from '../core/chart.js';
import { planIndicators, PERMANENT_STUDIES, MAX_STUDIES } from '../core/chart_budget.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

const bare = (s) => String(s || '').split(':').pop().toUpperCase();

export function registerPlaybookTools(server) {
  server.tool(
    'ticker_playbook',
    'THE ENTRY POINT for analysing one ticker. Reverses the screener: instead of scanning a universe for a filter, it takes ONE symbol and reports which of the 8 swing screens and 1 intraday screen it passes, CLAUSE BY CLAUSE, then names the strategies each passing screen implies — with entry rules, exit rules, TradingView indicators, skills and tools for each, ranked by evidence tier. Before this existed there was no way to ask the question at all: SCREENS ran universe-first only and was not imported by any tool, so learning whether a symbol passed momentum_pullback meant scanning the whole universe and looking for it. NEAR MISSES are reported deliberately — "fails RSI by 2 points" tells you what to wait for, where a bare "no match" tells you nothing. Session-restricted screens are skipped with a reason rather than evaluated on data that cannot support them. IMPORTANT: a screen is a COARSE FILTER. Passing one means WORTH LOOKING AT, not worth trading — stage 2 is this repo\'s own detectors returning a verdict, several strategies are Tier C, and six catalogue entries are REJECTED outright. Follow this with the ticker-playbook skill for the full chart workflow.',
    {
      symbol: z.string().describe('Ticker to analyse, e.g. "AAPL". Exchange prefix optional.'),
      universe: z.string().optional().describe('Comma-separated universe keys to look the symbol up in (default "sp500,nasdaq,russell2000" — wide, because a symbol outside the scanned set returns nothing)'),
      include_intraday: z.coerce.boolean().optional().describe('Also evaluate the intraday screen (default true)'),
      limit: z.coerce.number().optional().describe('Scanner rows to pull (default 2000 — this is a lookup, not a ranking)'),
    },
    wrap(async ({ symbol, universe = 'sp500,nasdaq,russell2000', include_intraday = true, limit = 2000 }) => {
      const keys = String(universe).split(',').map((s) => s.trim()).filter(Boolean);
      const want = bare(symbol);
      const r = await scan({
        columns: check.requiredColumns(),
        universe: keys,
        range: [0, limit],
        sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      });
      const row = (r.rows || []).find((x) => bare(x.symbol) === want);
      if (!row) {
        return {
          success: true, symbol: want, available: false,
          note: `${want} was not in ${keys.join('+')} across ${(r.rows || []).length} rows. Widen \`universe\` or raise \`limit\`. `
            + 'This is "not found", not "no setup".',
        };
      }

      const trust = scannerTrust();
      const result = check.screenCheck(row, {
        volume_fields_usable: trust.volume_fields_usable,
        include_intraday,
      });

      return {
        success: true,
        symbol: want,
        name: row.description || row.name,
        sector: row.sector,
        group: row.industry,
        close: row.close,
        session: { state: trust.session_state, volume_fields_usable: trust.volume_fields_usable, reason: trust.reason },
        ...result,
        next_steps: [
          'Run the `ticker-playbook` skill for the full chart workflow — it drives the analysis, the drawings and the indicators.',
          'ta_trading_context FIRST: do you already hold it, and does it report soon? Shannon holds nothing into earnings.',
          'group_context for where it sits in its industry group.',
          'horizon_prior for which side of the reversal/continuation boundary the intended hold is on.',
          'strategy_check strategy_name="<one of the strategies above>" to see the criteria evaluated against the chart.',
          'chart_indicators_for_strategy to put that strategy\'s indicators on the chart.',
        ],
      };
    }),
  );

  server.tool(
    'chart_indicators_for_strategy',
    'Put a strategy\'s TradingView indicators on the chart, from the catalogue\'s own `indicators` field. Closes the last gap in the ticker workflow: every catalogue entry already names the studies it needs, and chart_manage_indicator adds them one at a time by FULL name, but nothing drove the one from the other. Reports what was added, what was already present, and what failed — a study name TradingView does not recognise fails silently otherwise, leaving the analysis reading indicators that are not there. Pass dry_run to see the list without touching the chart.',
    {
      strategy_name: z.string().describe('A strategy from the catalogue — use ticker_playbook or strategy_list to pick one'),
      dry_run: z.coerce.boolean().optional().describe('List the indicators without adding them (default false)'),
      clear_added: z.coerce.boolean().optional().describe('Remove the non-permanent studies first to free slots. Volume and Moving Average Ribbon are NEVER removed. (default false)'),
      rules_path: z.string().optional().describe('Explicit rules.json path'),
    },
    wrap(async ({ strategy_name, dry_run = false, clear_added = false, rules_path }) => {
      const { rules } = resolveRules(rules_path);
      const all = mergedStrategies(rules);
      const spec = all[strategy_name];
      if (!spec) {
        throw new Error(`No strategy "${strategy_name}". Defined: ${Object.keys(all).join(', ')}.`);
      }
      const indicators = spec.indicators || [];
      if (!indicators.length) {
        return {
          success: true, strategy: strategy_name, indicators: [],
          note: spec.evidence_tier === 'REJECTED'
            ? `"${spec.label}" is tiered REJECTED and names no indicators, deliberately. ${spec.evidence}`
            : 'This strategy names no indicators.',
        };
      }
      if (dry_run) {
        const st = await chart.getState().catch(() => null);
        return { success: true, strategy: strategy_name, label: spec.label, dry_run: true, indicators,
          ...planIndicators(indicators, st?.studies || [], { clear_added }),
          note: 'Nothing was added. chart_manage_indicator needs FULL study names — these are stored that way.' };
      }

      /**
       * Read `studies`, not `indicators`. getState returns
       * {success, symbol, resolution, chartType, studies} — there is no
       * `indicators` field, so the previous version's "already present" set was
       * always empty.
       */
      const before = await chart.getState().catch(() => null);
      /**
       * The chart has a BUDGET: Volume and Moving Average Ribbon are permanent and
       * the total is capped at 5, so at most 3 may be added. Several strategies name
       * more than that — momentum_pullback names five — so without this the tool
       * would blow past the cap on a live chart.
       */
      const plan = planIndicators(indicators, before?.studies || [], { clear_added });
      if (plan.no_room) {
        return { success: true, strategy: strategy_name, label: spec.label, ...plan,
          note: 'Nothing was added. Pass clear_added:true to free the non-permanent slots.' };
      }
      for (const r of plan.will_remove) {
        await chart.manageIndicator({ action: 'remove', entity_id: r.entity_id }).catch(() => {});
      }

      const added = []; const already = [...plan.already_on_chart.map((i) => i.label || i.study || i)];
      const failed = [];
      for (const ind of plan.will_add) {
        const study = ind && typeof ind === 'object' ? ind.study : ind;
        const label = ind && typeof ind === 'object' ? (ind.label || ind.study) : ind;
        const inputs = ind && typeof ind === 'object' ? ind.inputs : undefined;

        if (!study || ind?.external) {
          failed.push({ indicator: label, why: ind?.note || 'not a TradingView study — supply it from another source' });
          continue;
        }

        let r = null;
        try {
          r = await chart.manageIndicator({ action: 'add', indicator: study, ...(inputs ? { inputs } : {}) });
        } catch (e) {
          failed.push({ indicator: label, study, why: e.message });
          continue;
        }
        /**
         * manageIndicator returns {success: false, new_study_count: 0} and does
         * NOT throw when TradingView rejects a study name. Catching only
         * exceptions recorded a silent failure as a success — exactly the
         * "success: true while doing nothing" case this repo's first rule is
         * about. Verify the flag AND the count.
         */
        if (r?.success && (r.new_study_count ?? 0) > 0) {
          added.push({ indicator: label, study, entity_id: r.entity_id, ...(inputs ? { inputs } : {}) });
        } else {
          failed.push({
            indicator: label, study,
            why: `TradingView did not create a study for "${study}" (new_study_count ${r?.new_study_count ?? 0}). `
              + 'The name must be EXACT — "Moving Average", not "Simple Moving Average (50)".',
          });
        }
      }

      // Verify against the chart rather than trusting the loop.
      const after = await chart.getState().catch(() => null);
      const studiesNow = (after?.studies || []).length;

      return {
        success: true,
        strategy: strategy_name,
        label: spec.label,
        evidence_tier: spec.evidence_tier,
        added, already_present: already, failed,
        budget: plan.budget,
        ...(plan.dropped?.length ? { dropped: plan.dropped, dropped_note: plan.dropped_note } : {}),
        ...(plan.will_remove.length ? { removed_to_make_room: plan.will_remove } : {}),
        studies_on_chart_before: (before?.studies || []).length,
        studies_on_chart_after: studiesNow,
        verified: studiesNow === ((before?.studies || []).length + added.length),
        ...(studiesNow !== ((before?.studies || []).length + added.length) ? {
          verification_warning: 'The chart study count does not match what was reported added. Believe the chart, '
            + 'not this result — re-read chart_get_state before relying on any of these indicators.',
        } : {}),
        ...(failed.length ? {
          failed_note: 'chart_manage_indicator needs the FULL study name ("Relative Strength Index", not "RSI"). A name '
            + 'TradingView does not recognise fails silently, which would leave the analysis reading indicators that '
            + 'are not on the chart.',
        } : {}),
        note: 'Pine graphics tools need a study to be VISIBLE to read it. Verify with chart_get_state before relying on '
          + 'data_get_study_values.',
      };
    }),
  );
}
