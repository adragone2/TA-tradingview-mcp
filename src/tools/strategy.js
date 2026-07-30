import { z } from 'zod';
import * as catalogue from '../core/catalogue.js';
import { jsonResult } from './_format.js';
import * as core from '../core/strategy.js';
import { resolveRules } from '../core/rules.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

/**
 * Get a strategy either inline or by name from rules.json.
 *
 * Named strategies live in rules.json because that is where strategies belong —
 * a strategy embedded in a prompt cannot be scanned tomorrow or backtested.
 */
function loadStrategy({ strategy, strategy_name, rules_path }) {
  if (strategy && typeof strategy === 'object') return strategy;
  if (!strategy_name) {
    throw new Error('Pass either strategy (inline) or strategy_name (from the catalogue or rules.json). Use strategy_list to see what is defined.');
  }
  const { rules, path } = resolveRules(rules_path);
  // Both sources. rules.json wins a name clash — it is the owner's own file.
  const defined = catalogue.mergedStrategies(rules);
  const found = defined[strategy_name];
  if (!found) {
    const names = Object.keys(defined);
    throw new Error(
      names.length
        ? `No strategy "${strategy_name}" in the catalogue or ${path || 'the default rules'}. Defined: ${names.join(', ')}.`
        : 'No strategies are defined in strategies.json or rules.json. See docs/strategies.md.',
    );
  }
  // A REJECTED catalogue entry has empty criteria by design. Saying why beats
  // an "invalid strategy: criteria must be a non-empty array" error.
  const ok = catalogue.scannable(found);
  if (!ok.ok) throw new Error(`Cannot evaluate "${strategy_name}": ${ok.reason}`);
  return { name: strategy_name, ...found };
}

const criterionSchema = z.object({
  id: z.string().optional().describe('Short label for this criterion, used in results'),
  left: z.union([z.string(), z.number()]).describe('Left operand: an operand name, sma(200)/ema(20)/rsi(14)/atr(14), or a number'),
  op: z.enum(['>', '>=', '<', '<=', '==', '!=']).describe('Comparison'),
  right: z.union([z.string(), z.number()]).describe('Right operand, same forms as left'),
  note: z.string().optional().describe('Why this criterion exists'),
});

const strategySchema = z.object({
  name: z.string().optional(),
  direction: z.enum(['long', 'short']).optional(),
  description: z.string().optional(),
  criteria: z.array(criterionSchema).min(1),
}).describe('Inline strategy specification');

export function registerStrategyTools(server) {
  server.tool(
    'strategy_list',
    'Every strategy in the catalogue (strategies.json, tracked in git) plus any in rules.json, with criteria, execution tier, evidence tier and validation errors. Strategies are criteria as DATA, not prose — which is what makes them scannable and testable, unlike the bias_criteria sentences a model grades by judgement. Entries tiered REJECTED are listed deliberately: each has been measured and found to have no edge over its own null, and they are kept so nobody rediscovers them. They carry no criteria and strategy_check will refuse them with the reason. docs/strategies.md is the readable version of this same data.',
    {
      rules_path: z.string().optional().describe('Explicit rules.json path'),
      execution: z.enum(['intraday', 'weekly', 'monthly']).optional().describe('Only this execution tier'),
      evidence_tier: z.enum(['A', 'B', 'C', 'REJECTED']).optional().describe('Only this evidence tier'),
      scannable_only: z.coerce.boolean().optional().describe('Drop documentation-only and REJECTED entries (default false — seeing the rejected ones is the point)'),
    },
    wrap(({ rules_path, execution = null, evidence_tier = null, scannable_only = false }) => {
      const { rules, path, source } = resolveRules(rules_path);
      const cat = catalogue.loadCatalogue();
      const all = catalogue.mergedStrategies(rules);

      let names = Object.keys(all);
      if (execution) names = names.filter((n) => all[n].execution === execution);
      if (evidence_tier) names = names.filter((n) => all[n].evidence_tier === evidence_tier);
      if (scannable_only) names = names.filter((n) => catalogue.scannable(all[n]).ok);

      return {
        success: true,
        catalogue_path: cat.path,
        catalogue_available: cat.available,
        rules_path: path,
        rules_source: source,
        count: names.length,
        summary: catalogue.catalogueSummary(all),
        execution_tiers: cat.execution_tiers,
        evidence_tiers: cat.evidence_tiers,
        strategies: names.map((name) => {
          const spec = all[name];
          const hasCriteria = Array.isArray(spec.criteria) && spec.criteria.length > 0;
          const check = hasCriteria ? core.validateStrategy(spec) : { valid: false, errors: ['no criteria — documentation only'] };
          const can = catalogue.scannable(spec);
          return {
            name,
            label: spec.label || null,
            source: spec.source,
            execution: spec.execution || null,
            evidence_tier: spec.evidence_tier || null,
            evidence: spec.evidence || null,
            evidence_caveat: spec.evidence_caveat || null,
            direction: spec.direction || null,
            screener: spec.screener || null,
            entry: spec.entry || null,
            exit: spec.exit || null,
            exit_reason_keys: spec.exit_reason_keys || [],
            indicators: spec.indicators || [],
            skills: spec.skills || [],
            tools: spec.tools || [],
            risk_rules: spec.risk_rules || [],
            criteria_count: hasCriteria ? spec.criteria.length : 0,
            criteria: spec.criteria || [],
            ...(spec.criteria_note ? { criteria_note: spec.criteria_note } : {}),
            scannable: can.ok,
            ...(can.ok ? {} : { not_scannable_because: can.reason }),
            valid: check.valid,
            ...(check.valid ? {} : { errors: check.errors }),
            ...(spec.overrides_catalogue ? { overrides_catalogue: true } : {}),
          };
        }),
        operands: core.OPERANDS,
        how_to_read: 'execution says WHEN the trade is closed out; evidence_tier says how much to believe it. The '
          + 'horizon_evidence on each execution tier is the load-bearing part: the WEEKLY tier (2-10 days) is the '
          + 'REVERSAL zone, so a continuation setup placed there is fighting its own horizon.',
      };
    }),
  );

  server.tool(
    'strategy_check',
    'Evaluate a strategy against the symbol on the chart, criterion by criterion, showing the ACTUAL value on each side of every comparison. Indicators are computed from the bars, so the result does not depend on which studies are loaded. A criterion whose operands cannot be resolved is UNKNOWN, never a fail.',
    {
      strategy_name: z.string().optional().describe('Name of a strategy in rules.json'),
      strategy: strategySchema.optional().describe('Inline strategy, instead of strategy_name'),
      count: z.coerce.number().optional().describe('Bars to load (default 400 — a 200-period average needs at least 200)'),
      rules_path: z.string().optional().describe('Explicit rules.json path'),
    },
    wrap(({ strategy, strategy_name, count, rules_path }) =>
      core.checkStrategy({ strategy: loadStrategy({ strategy, strategy_name, rules_path }), count })),
  );

  server.tool(
    'strategy_scan',
    'Check a strategy across several symbols and return the ones where every criterion passes. Drives the chart through each symbol and restores it afterwards. Symbols that could not be evaluated are reported separately as unresolved — "not checked" is not the same as "did not qualify".',
    {
      symbols: z.array(z.string()).min(1).describe('Symbols to scan'),
      strategy_name: z.string().optional().describe('Name of a strategy in rules.json'),
      strategy: strategySchema.optional().describe('Inline strategy, instead of strategy_name'),
      timeframe: z.string().optional().describe('Timeframe to scan on (default: leave the chart on its current one)'),
      count: z.coerce.number().optional().describe('Bars per symbol (default 400)'),
      rules_path: z.string().optional().describe('Explicit rules.json path'),
    },
    wrap(({ symbols, strategy, strategy_name, timeframe, count, rules_path }) =>
      core.scanStrategy({ strategy: loadStrategy({ strategy, strategy_name, rules_path }), symbols, timeframe, count })),
  );
}
