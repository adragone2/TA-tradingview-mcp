import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { equalWeightBreadth, BREADTH_PAIRS, BREADTH_COLUMNS } from '../src/core/breadth_ew.js';

/**
 * Equal-weight against cap-weight: is a drawdown BROAD or concentrated?
 *
 * The pairs hold identical constituents, so the spread is weighting and nothing
 * else. That makes it a clean descriptive read — and it must stay descriptive.
 */

const row = (name, perf) => ({
  symbol: `AMEX:${name}`, name,
  'Perf.W': perf.w, 'Perf.1M': perf.m, 'Perf.3M': perf.q, 'Perf.6M': perf.h, 'Perf.Y': perf.y,
});

describe('the reading', () => {
  test('equal-weight ahead is BROAD', () => {
    // The live 2026-07-30 shape: SPY +0.05 on the month, RSP +1.22.
    const r = equalWeightBreadth([
      row('RSP', { w: 1.55, m: 1.22, q: 5.57, h: 8.77, y: 15.47 }),
      row('SPY', { w: 0.31, m: 0.05, q: 2.83, h: 7.21, y: 16.63 }),
    ]);
    const p = r.pairs.find((x) => x.key === 'sp500');
    assert.equal(p.available, true);
    assert.equal(p.spread_pts['1m'], 1.17);
    assert.match(p.reading, /^broad/);
  });

  test('cap-weight ahead is NARROW — the index is being carried', () => {
    const r = equalWeightBreadth([
      row('RSP', { w: 0, m: -4, q: 0, h: 0, y: 0 }),
      row('SPY', { w: 0, m: 2, q: 0, h: 0, y: 0 }),
    ]);
    const p = r.pairs.find((x) => x.key === 'sp500');
    assert.equal(p.spread_pts['1m'], -6);
    assert.match(p.reading, /^narrow/);
  });

  test('a small spread is EVEN, not a regime', () => {
    // A tenth of a point is not breadth. The band exists so the reading cannot
    // imply precision it has never been tested to carry.
    const r = equalWeightBreadth([
      row('RSP', { w: 0, m: 0.4, q: 0, h: 0, y: 0 }),
      row('SPY', { w: 0, m: 0.1, q: 0, h: 0, y: 0 }),
    ]);
    assert.match(r.pairs.find((x) => x.key === 'sp500').reading, /^even/);
  });
});

describe('a missing ETF is unknown, never zero', () => {
  test('an absent leg reports why instead of a 0.0 spread', () => {
    /**
     * A spread of 0.0 reads as "breadth is neutral" — a finding. An ETF that was
     * never fetched is not a finding, and the two must not look the same.
     */
    const r = equalWeightBreadth([row('SPY', { w: 0, m: 1, q: 0, h: 0, y: 0 })]);
    const p = r.pairs.find((x) => x.key === 'sp500');
    assert.equal(p.available, false);
    assert.equal(p.spread_pts, undefined, 'no spread may be invented');
    assert.match(p.why, /RSP was not in the rows supplied/);
  });

  test('no rows at all is reported, not computed', () => {
    const r = equalWeightBreadth([]);
    assert.equal(r.available, false);
    assert.match(r.summary, /no breadth pair could be computed/);
  });

  test('a null performance field yields a null spread, not NaN', () => {
    const r = equalWeightBreadth([
      row('RSP', { w: null, m: 1, q: 0, h: 0, y: 0 }),
      row('SPY', { w: 0, m: 0, q: 0, h: 0, y: 0 }),
    ]);
    const p = r.pairs.find((x) => x.key === 'sp500');
    assert.equal(p.spread_pts['1w'], null);
    assert.equal(p.spread_pts['1m'], 1);
  });
});

describe('it is CONTEXT and says so', () => {
  test('the output carries the not-a-signal warning', () => {
    /**
     * Three market/trend alignment gates have been forward-tested in this repo and
     * all three failed. Nothing here has been tested as a predictor, and a reading
     * that travels without that caveat is one refactor away from becoming a gate.
     */
    const r = equalWeightBreadth([]);
    assert.match(r.not_a_signal, /CONTEXT only/);
    assert.match(r.not_a_signal, /never as a reason to take or skip a trade/);
  });

  test('the morning screen consumes it as context, not as a filter', () => {
    const m = readFileSync(`${process.cwd()}/scripts/morning-screen.js`, 'utf8');
    assert.match(m, /equalWeightBreadth\(br\.rows\)/);
    assert.match(m, /breadth: breadth,/, 'it belongs in the report');
    // It must not touch selection.
    const gate = m.slice(m.indexOf('const { perScreen, gated }'), m.indexOf('const { tiers, unclassified }'));
    assert.ok(!/breadth/.test(gate), 'breadth must not participate in gating or selection');
  });

  test('the pairs hold identical constituents, which is the whole claim', () => {
    // RSP/SPY and QQQE/QQQ track the same indices. A pair with different members
    // would make the spread a composition difference, not a weighting one.
    assert.deepEqual(BREADTH_PAIRS.map((p) => [p.equal, p.cap]), [['RSP', 'SPY'], ['QQQE', 'QQQ']]);
    for (const p of BREADTH_PAIRS) assert.match(p.note, /[Ss]ame \d+ names/);
  });

  test('the columns a caller must request are exported', () => {
    // Requesting the wrong columns yields rows with undefined performance fields,
    // which would read as null spreads rather than as a caller error.
    for (const c of ['Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y']) {
      assert.ok(BREADTH_COLUMNS.includes(c), `${c} must be in BREADTH_COLUMNS`);
    }
  });
});
