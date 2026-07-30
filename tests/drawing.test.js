/**
 * Drawing unit tests — no TradingView connection needed.
 *
 * Covers everything that runs before CDP is touched: input validation, R:R and
 * sizing arithmetic, timestamp coercion, style defaults, and the provenance
 * registry that makes scoped draw_clear possible.
 *
 * Live rendering (does TradingView actually place the line) is covered by
 * tests/e2e.test.js, which requires a running chart.
 *
 * Run: node --test tests/drawing.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { buildTradePlan, drawShape, clearAll, resolveTime, DEFAULT_STYLE, COLORS } from '../src/core/drawing.js';
import * as registry from '../src/core/drawing_registry.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tvmcp-draw-'));
  return { path: join(dir, 'drawings.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('style defaults', () => {
  it('every line shape has an explicit colour so labels are never invisible', () => {
    for (const shape of ['horizontal_line', 'vertical_line', 'trend_line']) {
      const s = DEFAULT_STYLE[shape];
      assert.ok(s.linecolor, `${shape} must set linecolor`);
      assert.ok(s.textcolor, `${shape} must set textcolor`);
      assert.match(s.linecolor, /^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('text shape sets an explicit colour', () => {
    assert.match(DEFAULT_STYLE.text.color, /^#[0-9A-Fa-f]{6}$/);
  });

  it('no default colour is plain white, which would vanish on a light chart', () => {
    for (const [shape, style] of Object.entries(DEFAULT_STYLE)) {
      for (const key of ['linecolor', 'textcolor', 'color']) {
        if (style[key]) {
          assert.notEqual(style[key].toUpperCase(), '#FFFFFF', `${shape}.${key} must not default to white`);
        }
      }
    }
  });

  it('role colours are distinct so entry/stop/target are tellable apart', () => {
    const used = [COLORS.entry, COLORS.stop, COLORS.target, COLORS.breakeven];
    assert.equal(new Set(used).size, used.length);
  });
});

describe('resolveTime', () => {
  it('passes a unix number through, floored', async () => {
    assert.equal(await resolveTime(1750000000), 1750000000);
    assert.equal(await resolveTime(1750000000.9), 1750000000);
  });

  it('accepts a numeric string', async () => {
    assert.equal(await resolveTime('1750000000'), 1750000000);
  });

  it('accepts "now"', async () => {
    const t = await resolveTime('now');
    assert.ok(Math.abs(t - Math.floor(Date.now() / 1000)) < 5);
  });

  it('accepts an ISO date', async () => {
    assert.equal(await resolveTime('2026-07-26'), Math.floor(Date.parse('2026-07-26') / 1000));
  });

  it('rejects unparseable input with a message naming the accepted forms', async () => {
    await assert.rejects(() => resolveTime('next tuesday'), /unix timestamp.*last_bar.*ISO/s);
  });
});

describe('drawShape — validation before connecting', () => {
  it('requires a numeric price', async () => {
    await assert.rejects(() => drawShape({ shape: 'horizontal_line', point: {} }), /point\.price is required/);
    await assert.rejects(() => drawShape({ shape: 'horizontal_line', point: { price: 'abc' } }), /point\.price is required/);
  });

  it('reports malformed overrides JSON with an example', async () => {
    await assert.rejects(
      () => drawShape({ shape: 'horizontal_line', point: { price: 100 }, overrides: '{bad' }),
      /overrides is not valid JSON.*linecolor/s,
    );
  });
});

describe('buildTradePlan — validation', () => {
  const base = { entry: 100, stop: 95, targets: [110] };

  it('requires a direction', () => {
    assert.throws(() => buildTradePlan({ ...base }), /direction must be "long" or "short"/);
    assert.throws(() => buildTradePlan({ ...base, direction: 'sideways' }), /direction must be/);
  });

  it('requires numeric entry and stop', () => {
    assert.throws(() => buildTradePlan({ direction: 'long', stop: 95 }), /entry must be a number/);
    assert.throws(() => buildTradePlan({ direction: 'long', entry: 100 }), /stop must be a number/);
  });

  it('rejects a zero-risk plan', () => {
    assert.throws(
      () => buildTradePlan({ direction: 'long', entry: 100, stop: 100 }),
      /cannot be equal.*risk would be zero/,
    );
  });

  it('rejects a long whose stop sits above entry', () => {
    assert.throws(
      () => buildTradePlan({ direction: 'long', entry: 100, stop: 105, targets: [110] }),
      /Long plan has its stop \(105\) above entry \(100\)/,
    );
  });

  it('rejects a short whose stop sits below entry', () => {
    assert.throws(
      () => buildTradePlan({ direction: 'short', entry: 100, stop: 95, targets: [90] }),
      /Short plan has its stop \(95\) below entry \(100\)/,
    );
  });

  it('rejects a long target at or below entry', () => {
    assert.throws(
      () => buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [99] }),
      /Long target "TP1" \(99\) is at or below entry/,
    );
  });

  it('rejects a short target at or above entry', () => {
    assert.throws(
      () => buildTradePlan({ direction: 'short', entry: 100, stop: 105, targets: [101] }),
      /Short target "TP1" \(101\) is at or above entry/,
    );
  });

  it('rejects a malformed target entry', () => {
    assert.throws(
      () => buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [{ label: 'no price' }] }),
      /targets\[0\] must be a number or an object with a price/,
    );
  });

  it('rejects non-positive sizing inputs before anything is drawn', () => {
    assert.throws(
      () => buildTradePlan({ ...base, direction: 'long', account_size: 0, risk_percent: 1 }),
      /account_size must be a positive number/,
    );
    assert.throws(
      () => buildTradePlan({ ...base, direction: 'long', account_size: 10000, risk_percent: -1 }),
      /risk_percent must be a positive number/,
    );
  });
});

describe('buildTradePlan — arithmetic', () => {
  it('computes R:R per target for a long', () => {
    const plan = buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [110, 115] });
    assert.equal(plan.risk_per_unit, 5);
    const targets = plan.levels.filter((l) => l.role === 'target');
    assert.equal(targets[0].rr, 2);   // 10 / 5
    assert.equal(targets[1].rr, 3);   // 15 / 5
    assert.equal(plan.best_rr, 3);
    assert.equal(plan.worst_rr, 2);
  });

  it('computes R:R per target for a short', () => {
    const plan = buildTradePlan({ direction: 'short', entry: 100, stop: 104, targets: [92] });
    assert.equal(plan.risk_per_unit, 4);
    assert.equal(plan.levels.find((l) => l.role === 'target').rr, 2);
  });

  it('computes position size from account risk and stop distance', () => {
    const plan = buildTradePlan({
      direction: 'long', entry: 100, stop: 95, targets: [110],
      account_size: 10000, risk_percent: 1,
    });
    assert.equal(plan.sizing.risk_amount, 100);       // 1% of 10k
    assert.equal(plan.sizing.position_size, 20);      // 100 / 5
    assert.ok(/Not advice/i.test(plan.sizing.note));
  });

  it('omits sizing when account details are not supplied', () => {
    assert.equal(buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [110] }).sizing, null);
  });

  it('handles fractional prices without float noise in R:R', () => {
    const plan = buildTradePlan({ direction: 'long', entry: 0.3, stop: 0.2, targets: [0.5] });
    assert.equal(plan.levels.find((l) => l.role === 'target').rr, 2);
  });

  it('builds entry, stop and one line per target', () => {
    const plan = buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [110, 120, 130] });
    assert.deepEqual(plan.levels.map((l) => l.role), ['entry', 'stop', 'target', 'target', 'target']);
  });

  it('adds a break-even line when given one', () => {
    const plan = buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [110], breakeven: 101 });
    const be = plan.levels.find((l) => l.role === 'breakeven');
    assert.ok(be);
    assert.equal(be.price, 101);
    assert.equal(be.color, COLORS.breakeven);
  });

  it('rejects a non-numeric break-even', () => {
    assert.throws(
      () => buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [110], breakeven: 'soon' }),
      /breakeven must be a number/,
    );
  });

  it('colour-codes each role distinctly', () => {
    const plan = buildTradePlan({ direction: 'long', entry: 100, stop: 95, targets: [110] });
    assert.equal(plan.levels.find((l) => l.role === 'entry').color, COLORS.entry);
    assert.equal(plan.levels.find((l) => l.role === 'stop').color, COLORS.stop);
    assert.equal(plan.levels.find((l) => l.role === 'target').color, COLORS.target);
  });

  it('labels targets with their R multiple and partial percentage', () => {
    const plan = buildTradePlan({
      direction: 'long', entry: 100, stop: 95,
      targets: [{ price: 110, label: 'TP1', partial_pct: 50 }],
    });
    const label = plan.levels.find((l) => l.role === 'target').label;
    assert.match(label, /TP1/);
    assert.match(label, /50%/);
    assert.match(label, /2R/);
  });

  it('defaults the group name from direction and entry', () => {
    assert.equal(buildTradePlan({ direction: 'short', entry: 42.5, stop: 45, targets: [40] }).group, 'short-42.5');
  });

  it('honours an explicit group name', () => {
    assert.equal(buildTradePlan({ direction: 'long', entry: 100, stop: 95, group: 'algo-long' }).group, 'algo-long');
  });

  it('accepts a plan with no targets at all', () => {
    const plan = buildTradePlan({ direction: 'long', entry: 100, stop: 95 });
    assert.equal(plan.best_rr, null);
    assert.deepEqual(plan.levels.map((l) => l.role), ['entry', 'stop']);
  });
});

describe('clearAll — scope guards', () => {
  it('rejects an unknown scope and names the valid ones', async () => {
    await assert.rejects(() => clearAll({ scope: 'everything' }), /Unknown scope "everything".*"mcp".*"all"/s);
  });

  it('refuses group combined with scope all', async () => {
    await assert.rejects(
      () => clearAll({ scope: 'all', group: 'my-plan' }),
      /group cannot be combined with scope "all"/,
    );
  });
});

describe('drawing registry', () => {
  it('records and lists entries', () => {
    const { path, cleanup } = tempStore();
    try {
      registry.record([{ entity_id: 'a', shape: 'horizontal_line', role: 'entry' }], { group: 'g1', path });
      registry.record([{ entity_id: 'b', shape: 'horizontal_line', role: 'stop' }], { group: 'g1', path });
      const all = registry.list({ path });
      assert.equal(all.length, 2);
      assert.deepEqual(all.map((e) => e.entity_id), ['a', 'b']);
      assert.equal(all[0].group, 'g1');
    } finally { cleanup(); }
  });

  it('filters by group', () => {
    const { path, cleanup } = tempStore();
    try {
      registry.record([{ entity_id: 'a' }], { group: 'g1', path });
      registry.record([{ entity_id: 'b' }], { group: 'g2', path });
      assert.deepEqual(registry.list({ group: 'g2', path }).map((e) => e.entity_id), ['b']);
    } finally { cleanup(); }
  });

  it('ignores items with no entity_id', () => {
    const { path, cleanup } = tempStore();
    try {
      const res = registry.record([{ entity_id: null }, {}, null], { path });
      assert.equal(res.recorded, 0);
      assert.equal(registry.list({ path }).length, 0);
    } finally { cleanup(); }
  });

  it('summarises groups with counts', () => {
    const { path, cleanup } = tempStore();
    try {
      registry.record([{ entity_id: 'a' }, { entity_id: 'b' }], { group: 'plan-1', path });
      registry.record([{ entity_id: 'c' }], { group: 'plan-2', path });
      registry.record([{ entity_id: 'd' }], { path }); // ungrouped
      const groups = registry.groups({ path });
      assert.equal(groups.length, 2);
      assert.equal(groups.find((g) => g.group === 'plan-1').count, 2);
      assert.equal(groups.find((g) => g.group === 'plan-2').count, 1);
    } finally { cleanup(); }
  });

  it('forgets specific ids', () => {
    const { path, cleanup } = tempStore();
    try {
      registry.record([{ entity_id: 'a' }, { entity_id: 'b' }], { path });
      assert.equal(registry.forget(['a'], { path }).forgotten, 1);
      assert.deepEqual(registry.list({ path }).map((e) => e.entity_id), ['b']);
    } finally { cleanup(); }
  });

  it('prunes ids that no longer exist on the chart', () => {
    const { path, cleanup } = tempStore();
    try {
      // Recorded WITH a symbol, and pruned against that same symbol. `liveIds` comes
      // from getAllShapes(), which only ever sees one chart, so the pair is the only
      // form in which the comparison means anything.
      registry.record([{ entity_id: 'live' }, { entity_id: 'stale' }], { path, symbol: 'BATS:AAA' });
      const res = registry.prune(['live'], { path, symbol: 'BATS:AAA' });
      assert.equal(res.pruned, 1);
      assert.equal(res.remaining, 1);
      assert.deepEqual(registry.list({ path }).map((e) => e.entity_id), ['live']);
    } finally { cleanup(); }
  });

  it('pruning against an empty chart clears that symbol', () => {
    const { path, cleanup } = tempStore();
    try {
      registry.record([{ entity_id: 'a' }], { path, symbol: 'BATS:AAA' });
      assert.equal(registry.prune([], { path, symbol: 'BATS:AAA' }).remaining, 0);
    } finally { cleanup(); }
  });

  it('an UNSCOPED prune refuses instead of clearing everything', () => {
    /**
     * This test used to be "pruning against an empty chart clears everything", with
     * no symbol passed — asserting the behaviour that emptied the live store.
     *
     * `currentSymbol()` returns null on any failure, and the old guard was
     * `if (symbol && ...)`, so one null reading made every entry for every OTHER
     * symbol look non-live. Those drawings stayed on their charts and became
     * unclearable by `scope: "mcp"`, because the registry no longer knew they were
     * ours. See tests/drawing_registry_scope.test.js for the full case.
     */
    const { path, cleanup } = tempStore();
    try {
      registry.record([{ entity_id: 'a' }], { path, symbol: 'BATS:AAA' });
      const res = registry.prune([], { path });
      assert.equal(res.refused, true);
      assert.equal(res.remaining, 1, 'unknown symbol must be a no-op, never a wipe');
    } finally { cleanup(); }
  });

  it('survives a corrupt store rather than blocking drawing', () => {
    const { path, cleanup } = tempStore();
    try {
      writeFileSync(path, 'not json at all');
      assert.deepEqual(registry.list({ path }), []);
      registry.record([{ entity_id: 'a' }], { path });
      assert.deepEqual(registry.list({ path }).map((e) => e.entity_id), ['a']);
    } finally { cleanup(); }
  });

  it('treats a store with the wrong shape as empty', () => {
    const { path, cleanup } = tempStore();
    try {
      writeFileSync(path, JSON.stringify({ entries: 'nope' }));
      assert.deepEqual(registry.list({ path }), []);
    } finally { cleanup(); }
  });

  it('clear empties the store', () => {
    const { path, cleanup } = tempStore();
    try {
      registry.record([{ entity_id: 'a' }], { path });
      registry.clear({ path });
      assert.deepEqual(registry.list({ path }), []);
    } finally { cleanup(); }
  });
});
