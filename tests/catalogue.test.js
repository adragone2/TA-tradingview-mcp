import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  loadCatalogue, mergedStrategies, byExecution, scannable, catalogueSummary, TRADEABLE_TIERS,
} from '../src/core/catalogue.js';
import { validateStrategy, OPERANDS } from '../src/core/strategy.js';
import { buildStructureContext } from '../src/core/structure_context.js';
import { normalizeBars } from '../src/core/structure.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

const cat = loadCatalogue({ fresh: true });

describe('the catalogue file', () => {
  test('exists and declares its schema', () => {
    assert.equal(cat.available, true, 'strategies.json is missing');
    assert.ok(cat.schema_version);
    assert.ok(Object.keys(cat.strategies).length >= 15);
  });

  test('every strategy declares an execution tier that is defined', () => {
    for (const [name, s] of Object.entries(cat.strategies)) {
      assert.ok(s.execution, `${name} has no execution tier`);
      assert.ok(cat.execution_tiers[s.execution], `${name} claims undeclared tier "${s.execution}"`);
    }
  });

  test('every strategy declares an evidence tier that is defined', () => {
    for (const [name, s] of Object.entries(cat.strategies)) {
      assert.ok(s.evidence_tier, `${name} has no evidence tier`);
      assert.ok(cat.evidence_tiers[s.evidence_tier], `${name} claims undeclared tier "${s.evidence_tier}"`);
    }
  });

  test('every strategy carries the EVIDENCE behind its tier, not just the letter', () => {
    // A tier without its measurement is an opinion with a grade attached.
    for (const [name, s] of Object.entries(cat.strategies)) {
      assert.ok(s.evidence && s.evidence.length > 30, `${name} has no evidence statement`);
    }
  });

  test('every strategy names a screener, entry, exit, indicators, skills and tools', () => {
    /**
     * The five things the catalogue exists to answer. A row missing one of them
     * is not actionable, which was the whole complaint it was built to fix.
     */
    for (const [name, s] of Object.entries(cat.strategies)) {
      assert.ok(s.screener, `${name} names no screener (use "none — ..." if it has none)`);
      assert.ok(s.entry, `${name} has no entry rule`);
      assert.ok(s.exit, `${name} has no exit rule`);
      assert.ok(Array.isArray(s.indicators), `${name} has no indicators array`);
      assert.ok(Array.isArray(s.skills), `${name} has no skills array`);
      assert.ok(Array.isArray(s.tools), `${name} has no tools array`);
      assert.ok(Array.isArray(s.risk_rules), `${name} has no risk_rules array`);
    }
  });

  test('the WEEKLY tier warns that it is the reversal zone', () => {
    /**
     * The single most load-bearing sentence in the catalogue. The owner's
     * weekly bucket (2-10 days) is where continuation is weakest, and most
     * structural setups are continuation bets.
     */
    const w = cat.execution_tiers.weekly;
    assert.deepEqual(w.horizon_days, [2, 10]);
    assert.match(w.horizon_evidence, /REVERSAL/);
    assert.match(w.horizon_evidence, /continuation/i);
    assert.match(w.horizon_evidence, /horizon_prior/);
  });

  test('the MONTHLY tier admits the contested gap rather than claiming evidence', () => {
    const m = cat.execution_tiers.monthly;
    assert.match(m.horizon_evidence, /CONTESTED GAP/);
    assert.match(m.horizon_evidence, /63/);
  });

  test('the INTRADAY tier admits there is no academic evidence for it here', () => {
    assert.match(cat.execution_tiers.intraday.horizon_evidence, /NONE/);
  });
});

describe('machine-evaluable criteria', () => {
  test('every non-REJECTED strategy with criteria VALIDATES', () => {
    for (const [name, s] of Object.entries(cat.strategies)) {
      if (!Array.isArray(s.criteria) || !s.criteria.length) continue;
      const v = validateStrategy(s);
      assert.ok(v.valid, `${name}: ${(v.errors || []).join('; ')}`);
    }
  });

  test('every criterion uses a real operand or a number', () => {
    /**
     * A typo'd operand resolves to UNKNOWN forever, and an UNKNOWN makes the
     * whole strategy unknown — so a scan quietly stops finding anything.
     */
    const bases = new Set(OPERANDS.map((o) => String(o).replace(/\(.*\)/, '').trim()));
    const known = (tok) => {
      if (typeof tok === 'number') return true;
      const t = String(tok).split(/\s*[*+\-/]\s*/)[0].trim();
      return bases.has(t.replace(/\(.*\)/, '').trim());
    };
    for (const [name, s] of Object.entries(cat.strategies)) {
      for (const c of s.criteria || []) {
        assert.ok(known(c.left), `${name}: unknown left operand "${c.left}"`);
        assert.ok(known(c.right), `${name}: unknown right operand "${c.right}"`);
      }
    }
  });

  test('REJECTED strategies carry NO criteria, so they cannot be scanned by accident', () => {
    for (const [name, s] of Object.entries(cat.strategies)) {
      if (s.evidence_tier !== 'REJECTED') continue;
      assert.equal((s.criteria || []).length, 0, `${name} is REJECTED but has criteria`);
    }
  });

  test('exit_reason_keys on tradeable strategies are real taxonomy keys', async () => {
    const { EXIT_REASONS } = await import('../src/core/exits.js');
    for (const [name, s] of Object.entries(cat.strategies)) {
      for (const k of s.exit_reason_keys || []) {
        assert.ok(EXIT_REASONS[k], `${name}: "${k}" is not in EXIT_REASONS`);
      }
    }
  });
});

describe('scannable()', () => {
  test('refuses a REJECTED strategy WITH the reason, not a validation error', () => {
    /**
     * "criteria must be a non-empty array" tells the caller nothing. "this was
     * measured and has no edge" tells them why not to look for a workaround.
     */
    const rej = Object.entries(cat.strategies).find(([, s]) => s.evidence_tier === 'REJECTED');
    const r = scannable(rej[1]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /REJECTED/);
    assert.match(r.reason, /not rediscovered|not so it can be scanned/);
  });

  test('accepts a tradeable strategy with criteria', () => {
    assert.equal(scannable(cat.strategies.momentum_pullback).ok, true);
  });

  test('a missing strategy is refused, not crashed on', () => {
    assert.equal(scannable(undefined).ok, false);
    assert.equal(scannable(null).ok, false);
  });
});

describe('merging with rules.json', () => {
  test('the catalogue supplies strategies when rules.json has none', () => {
    // This was the bug: strategy_list returned count: 0 with tooling built to read it.
    const merged = mergedStrategies({});
    assert.ok(Object.keys(merged).length >= 15);
    assert.equal(merged.momentum_pullback.source, 'catalogue');
  });

  test('rules.json WINS a name clash, and the override is flagged', () => {
    // The owner's own file must not be silently overridden by a shared catalogue.
    const merged = mergedStrategies({
      strategies: { momentum_pullback: { direction: 'short', criteria: [{ left: 'close', op: '>', right: 1 }] } },
    });
    assert.equal(merged.momentum_pullback.source, 'rules.json');
    assert.equal(merged.momentum_pullback.direction, 'short');
    assert.equal(merged.momentum_pullback.overrides_catalogue, true);
  });

  test('a rules.json-only strategy is kept alongside', () => {
    const merged = mergedStrategies({
      strategies: { my_own: { criteria: [{ left: 'close', op: '>', right: 'sma(50)' }] } },
    });
    assert.equal(merged.my_own.source, 'rules.json');
    assert.equal(merged.my_own.overrides_catalogue, undefined);
  });

  test('a missing catalogue file degrades to rules.json, it does not throw', () => {
    const empty = loadCatalogue({ path: '/nonexistent/strategies.json' });
    assert.equal(empty.available, false);
    assert.deepEqual(empty.strategies, {});
  });
});

describe('grouping and summary', () => {
  test('groups by execution tier in the declared order', () => {
    const g = byExecution(cat.strategies, cat.execution_tiers);
    assert.deepEqual(Object.keys(g).slice(0, 3), ['intraday', 'weekly', 'monthly']);
  });

  test('a REJECTED entry never heads a section', () => {
    // Ordering is evidence-first, so the top of each tier is its best entry.
    const g = byExecution(cat.strategies, cat.execution_tiers);
    for (const [tier, rows] of Object.entries(g)) {
      if (!rows.length) continue;
      const tiers = rows.map((r) => r.evidence_tier);
      const firstRejected = tiers.indexOf('REJECTED');
      if (firstRejected === -1) continue;
      assert.ok(firstRejected > 0, `${tier} leads with a REJECTED strategy`);
      // And nothing tradeable appears after the first rejected one.
      assert.ok(tiers.slice(firstRejected).every((t) => t === 'REJECTED'),
        `${tier} mixes tradeable strategies after REJECTED ones`);
    }
  });

  test('the summary counts scannable separately from total', () => {
    const s = catalogueSummary(cat.strategies);
    assert.ok(s.total > s.scannable, 'rejected entries must not count as scannable');
    assert.ok(s.by_evidence_tier.REJECTED > 0);
    assert.deepEqual(TRADEABLE_TIERS, ['A', 'B', 'C']);
  });
});

describe('buildStructureContext — the operands nothing used to supply', () => {
  const bars = normalizeBars(barsFromPath(randomWalk({ n: 300, drift: 0.001, seed: 3 })));

  test('resolves all six structure operands', () => {
    /**
     * buildContext declares these and leaves them null without a structure
     * object. Nothing ever built one, so any criterion using them was UNKNOWN
     * forever — and an UNKNOWN makes the whole strategy unknown, so five
     * catalogue strategies could never pass.
     */
    const c = buildStructureContext(bars);
    assert.equal(c.available, true);
    for (const k of ['pullback_pct', 'nearest_level_tests', 'nearest_level_distance_pct',
      'in_demand_zone', 'in_supply_zone', 'nearest_zone_distance_pct']) {
      assert.ok(c[k] !== undefined, `${k} missing`);
    }
  });

  test('pullback_pct is measured from the last swing HIGH, and is positive on a dip', () => {
    const c = buildStructureContext(bars);
    assert.ok(Number.isFinite(c.pullback_pct));
    assert.ok(c.derived_from.last_swing_high > 0);
  });

  test('zone flags are 1/0, because criteria compare numbers', () => {
    const c = buildStructureContext(bars);
    assert.ok([0, 1].includes(c.in_demand_zone));
    assert.ok([0, 1].includes(c.in_supply_zone));
    assert.match(c.note, /1\/0 rather than true\/false/);
  });

  test('carries provenance so a number can be traced', () => {
    const d = buildStructureContext(bars).derived_from;
    for (const k of ['swings', 'levels_found', 'zones_found', 'lookback']) {
      assert.ok(Number.isFinite(d[k]), `${k} missing from provenance`);
    }
  });

  test('too few bars is unavailable, and says UNKNOWN is correct rather than a fail', () => {
    const r = buildStructureContext(bars.slice(0, 8));
    assert.equal(r.available, false);
    assert.match(r.note, /UNKNOWN, which is correct/);
  });

  test('reminds the caller a zone alone is 99.5% noise', () => {
    assert.match(buildStructureContext(bars).note, /99\.5%/);
  });
});
