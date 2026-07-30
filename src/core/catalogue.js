/**
 * The strategy catalogue — `strategies.json` at the project root.
 *
 * Two files hold strategies and they exist for different reasons:
 *
 *   rules.json      the OWNER'S own criteria. Git-ignored, edited by hand, and
 *                   authoritative — if a name appears in both, this one wins.
 *   strategies.json the shared CATALOGUE. Tracked in git, carries an evidence
 *                   tier and a measurement for every entry, and is what
 *                   docs/strategies.md is generated from.
 *
 * Before this existed, `strategy_list` returned `count: 0`. Three tools and a
 * skill were built to evaluate strategies as DATA and there were no strategies
 * defined anywhere, so every strategy in the repo lived as prose in a markdown
 * table — exactly what those tools exist to replace.
 *
 * ── Why REJECTED entries are in here ──
 *
 * Several catalogue entries have been measured and found to have no edge over
 * their own null. Deleting them would mean the next person rediscovers a
 * candlestick reversal or a touch-count level rule and believes it is new. They
 * are kept, tiered REJECTED, with the measurement attached — and they carry
 * empty `criteria`, so `strategy_check` will refuse to evaluate them rather than
 * quietly scanning for something known not to work.
 *
 * All pure except the file read.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');
const CATALOGUE_PATH = join(PROJECT_ROOT, 'strategies.json');

/** Tiers that are safe to trade from, and the one that is not. */
export const TRADEABLE_TIERS = Object.freeze(['A', 'B', 'C']);

let cached = null;

/**
 * Read the catalogue. Returns an empty catalogue rather than throwing when the
 * file is absent, so a checkout without it degrades to rules.json alone.
 */
export function loadCatalogue({ path = CATALOGUE_PATH, fresh = false } = {}) {
  if (cached && !fresh && path === CATALOGUE_PATH) return cached;
  if (!existsSync(path)) {
    return { available: false, path, strategies: {}, note: `No strategy catalogue at ${path}.` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    // A malformed catalogue must be loud. Falling back silently would leave
    // strategy_list reporting count: 0 with no hint why.
    throw new Error(`strategies.json at ${path} is not valid JSON: ${e.message}`);
  }
  const out = {
    available: true,
    path,
    schema_version: parsed.schema_version || null,
    execution_tiers: parsed.execution_tiers || {},
    evidence_tiers: parsed.evidence_tiers || {},
    strategies: parsed.strategies || {},
  };
  if (path === CATALOGUE_PATH) cached = out;
  return out;
}

/**
 * Every strategy from both sources, with `source` recorded on each.
 *
 * rules.json wins a name clash, because it is the owner's own file and a shared
 * catalogue silently overriding personal criteria would be the wrong way round.
 */
export function mergedStrategies(rules = {}, { path } = {}) {
  const cat = loadCatalogue(path ? { path } : {});
  const out = {};
  for (const [name, spec] of Object.entries(cat.strategies)) {
    out[name] = { ...spec, source: 'catalogue' };
  }
  const own = rules?.strategies || {};
  for (const [name, spec] of Object.entries(own)) {
    out[name] = {
      ...spec,
      source: 'rules.json',
      ...(cat.strategies[name] ? { overrides_catalogue: true } : {}),
    };
  }
  return out;
}

/** Group by execution tier, in the catalogue's own declared order. */
export function byExecution(strategies, executionTiers = {}) {
  const order = Object.keys(executionTiers);
  const groups = {};
  for (const key of order) groups[key] = [];
  for (const [name, spec] of Object.entries(strategies)) {
    const tier = spec.execution || 'unclassified';
    (groups[tier] = groups[tier] || []).push({ name, ...spec });
  }
  for (const list of Object.values(groups)) {
    // Best evidence first, so a REJECTED entry never heads a section.
    const rank = { A: 0, B: 1, C: 2, REJECTED: 9 };
    list.sort((a, b) => (rank[a.evidence_tier] ?? 5) - (rank[b.evidence_tier] ?? 5)
      || String(a.name).localeCompare(String(b.name)));
  }
  return groups;
}

/**
 * Is this entry safe to hand to strategy_check / strategy_scan?
 *
 * A REJECTED entry has empty criteria by design, so scanning it would be
 * scanning for nothing. Saying WHY beats an "invalid strategy" error.
 */
export function scannable(spec) {
  if (!spec) return { ok: false, reason: 'No such strategy.' };
  if (spec.evidence_tier === 'REJECTED') {
    return {
      ok: false,
      reason: `"${spec.label || 'this strategy'}" is tiered REJECTED: ${spec.evidence} `
        + 'It is in the catalogue so it is not rediscovered, not so it can be scanned.',
    };
  }
  if (!Array.isArray(spec.criteria) || !spec.criteria.length) {
    return { ok: false, reason: 'This entry has no machine-evaluable criteria — it is documentation only.' };
  }
  return { ok: true };
}

/** Counts by execution tier and evidence tier, for a status line. */
export function catalogueSummary(strategies) {
  const byExec = {}; const byEvidence = {};
  for (const spec of Object.values(strategies)) {
    const e = spec.execution || 'unclassified';
    byExec[e] = (byExec[e] || 0) + 1;
    const t = spec.evidence_tier || 'untiered';
    byEvidence[t] = (byEvidence[t] || 0) + 1;
  }
  return {
    total: Object.keys(strategies).length,
    by_execution: byExec,
    by_evidence_tier: byEvidence,
    scannable: Object.values(strategies).filter((s) => scannable(s).ok).length,
  };
}
