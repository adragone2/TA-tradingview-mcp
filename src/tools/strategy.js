import { z } from 'zod';
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
    throw new Error('Pass either strategy (inline) or strategy_name (from rules.json). Use strategy_list to see what is defined.');
  }
  const { rules, path, using_defaults } = resolveRules(rules_path);
  const defined = rules.strategies || {};
  const found = defined[strategy_name];
  if (!found) {
    const names = Object.keys(defined);
    throw new Error(
      names.length
        ? `No strategy "${strategy_name}" in ${path || 'the default rules'}. Defined: ${names.join(', ')}.`
        : `No strategies are defined${using_defaults ? ' (no rules.json found — run rules_init)' : ` in ${path}`}. Add a "strategies" block. See skills/strategy-scan/SKILL.md for the format.`,
    );
  }
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
    'List the machine-evaluable strategies defined in rules.json, with their criteria and any validation errors. Strategies are criteria as DATA, not prose — which is what makes them scannable across symbols and testable, unlike the bias_criteria sentences a model has to grade by judgement.',
    {
      rules_path: z.string().optional().describe('Explicit rules.json path'),
    },
    wrap(({ rules_path }) => {
      const { rules, path, source, using_defaults } = resolveRules(rules_path);
      const defined = rules.strategies || {};
      const names = Object.keys(defined);
      return {
        success: true,
        rules_path: path,
        source,
        count: names.length,
        strategies: names.map((name) => {
          const spec = defined[name];
          const check = core.validateStrategy(spec);
          return {
            name,
            direction: spec.direction || null,
            description: spec.description || null,
            criteria_count: Array.isArray(spec.criteria) ? spec.criteria.length : 0,
            criteria: spec.criteria,
            valid: check.valid,
            ...(check.valid ? {} : { errors: check.errors }),
          };
        }),
        operands: core.OPERANDS,
        ...(names.length ? {} : {
          note: using_defaults
            ? 'No rules.json found, so no strategies are defined. Run rules_init, then add a "strategies" block.'
            : `No "strategies" block in ${path}. bias_criteria are prose a model grades; strategies are data that can be scanned and tested.`,
        }),
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
