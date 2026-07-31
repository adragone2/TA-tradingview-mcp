import { test, describe } from 'node:test';
import assert from 'node:assert';
import { resolveTaSymbol, partitionTaTickers } from '../src/core/ta_symbols.js';
import { applyWallsForSymbols } from '../src/core/ta_walls.js';

/**
 * TradingView reads a hyphen as a SPREAD operator. A TA ticker like `BTC-USD`
 * handed straight to the chart does not fail — it silently resolves to
 * `CRYPTOCAP:BTC-BATS:USD`, returns bars with a real price, and everything
 * downstream files the wrong instrument under the right name. Measured live;
 * the decision and the trap live in src/core/ta_symbols.js.
 *
 * Two layers of defence are under test here:
 *   1. resolveTaSymbol — refuses the forms it KNOWS are unchartable (crypto).
 *   2. applyWallsForSymbols — verifies what the chart says it LOADED against
 *      what was asked for, which catches the forms the resolver cannot know
 *      about (BRK-B is a share class, not crypto, and still reads as a spread).
 *      The same guard scripts/sunday-review.js loadSymbol() uses.
 *
 * Everything is injected — walls, vol, chart, applier — so nothing here can
 * reach the TA API or drive the live chart (shared, locked).
 */

// Tripwire: if a regression makes the walls sweep ignore its injected fixtures
// and reach for the real TA API, fail fast against a port nothing listens on
// rather than touching the live service. node --test runs each file in its own
// process, so this cannot leak into other test files. (ta_api.js reads the env
// at call time, so setting it after the hoisted imports still works.)
process.env.TA_API_URL = 'http://127.0.0.1:1';

describe('resolveTaSymbol — the hyphen is a SPREAD operator, not punctuation', () => {
  test('crypto forms are refused, and the why names the spread they would become', () => {
    for (const t of ['BTC-USD', 'ETH-USD', 'SOL-USD']) {
      const r = resolveTaSymbol(t);
      assert.equal(r.chartable, false, `${t} must not be chartable`);
      assert.equal(r.kind, 'crypto');
      assert.match(r.why, /SPREAD/, 'the reason must explain the trap, not just say no');
      assert.match(r.why, /CRYPTOCAP:/);
    }
  });

  test('a CoinMarketCap id on the base is still crypto', () => {
    // TA writes some positions as ARB11841-USD. The digits are an id, not a
    // different asset class.
    const r = resolveTaSymbol('ARB11841-USD');
    assert.equal(r.chartable, false);
    assert.equal(r.kind, 'crypto');
  });

  test('equities and ETFs pass through chartable, with expect stripped to the bare ticker', () => {
    const smh = resolveTaSymbol('SMH');
    assert.equal(smh.chartable, true);
    assert.equal(smh.expect, 'SMH');

    // An exchange-prefixed form must expect the BARE ticker: the chart answers
    // "BATS:SMH" for "SMH", and comparing prefixed-to-prefixed would reject
    // correct loads.
    const prefixed = resolveTaSymbol('BATS:SMH');
    assert.equal(prefixed.chartable, true);
    assert.equal(prefixed.expect, 'SMH');
  });

  test('an empty ticker is refused rather than resolved to something', () => {
    const r = resolveTaSymbol('');
    assert.equal(r.chartable, false);
    assert.match(r.why, /empty/);
  });

  test('partitionTaTickers splits the list and keeps each exclusion reason', () => {
    const { chartable, excluded } = partitionTaTickers(['SMH', 'BTC-USD', 'XLK']);
    assert.deepEqual(chartable.map((c) => c.ticker), ['SMH', 'XLK']);
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].ticker, 'BTC-USD');
    assert.match(excluded[0].why, /crypto/);
  });
});

describe('applyWallsForSymbols — resolve first, verify what loaded, skip what cannot chart', () => {
  /**
   * Fixtures. `applyOne` stands in for applyWalls (which needs the live
   * Institutional Matrix study), and the fake chart answers setSymbol with a
   * `resolved_symbol` the way src/core/chart.js does — what actually LOADED,
   * not what was asked for.
   */
  const WALLS = { asOf: '2026-07-28', age_hours: 5, source: 'walls_history', tickers: ['SMH', 'XLK'], byTicker: new Map() };
  const VOL = { vix: 14, vvix: 90, source: 'ta' };

  const fakeChart = ({ initial = 'BATS:QQQ', loads = {} } = {}) => {
    const setSymbolCalls = [];
    const setTimeframeCalls = [];
    return {
      setSymbolCalls,
      setTimeframeCalls,
      async getState() { return { success: true, symbol: initial, resolution: '1D' }; },
      async setSymbol({ symbol }) {
        setSymbolCalls.push(symbol);
        const loaded = Object.hasOwn(loads, symbol) ? loads[symbol] : `BATS:${symbol}`;
        return { success: true, symbol, resolved_symbol: loaded, chart_ready: true };
      },
      async setTimeframe({ timeframe }) { setTimeframeCalls.push(timeframe); },
    };
  };

  const fakeApply = () => {
    const calls = [];
    const fn = async (args) => {
      calls.push(args);
      return { as_of: '2026-07-28', payload: { flip: 100 }, applied: !args.dry_run };
    };
    fn.calls = calls;
    return fn;
  };

  const run = (symbols, opts = {}) =>
    applyWallsForSymbols({ symbols, walls: WALLS, vol: VOL, ...opts });

  test('a crypto ticker is SKIPPED with its reason — the chart is never driven to it', async () => {
    const chart = fakeChart();
    const applyOne = fakeApply();
    const r = await run(['SMH', 'BTC-USD'], { chart, applyOne });

    assert.ok(!chart.setSymbolCalls.includes('BTC-USD'),
      'BTC-USD reached the chart — it would have loaded the CRYPTOCAP spread');
    const skipped = r.results.find((x) => x.symbol === 'BTC-USD');
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
    assert.match(skipped.why, /SPREAD/, 'the skip must carry resolveTaSymbol\'s reason');

    // Skipped is not failed: one was never attempted, the other would have
    // been attempted and broken. Collapsing them makes a scope boundary read
    // as breakage — same rule as the Sunday review's EXCLUDED vs FAILED.
    assert.equal(r.applied, 1);
    assert.equal(r.skipped, 1);
    assert.equal(r.failed, 0);
  });

  test('a chartable ticker is driven via the RESOLVED form and applied once verified', async () => {
    const chart = fakeChart();
    const applyOne = fakeApply();
    const r = await run(['SMH'], { chart, applyOne });

    assert.equal(chart.setSymbolCalls[0], 'SMH');
    // The chart answered "BATS:SMH" for "SMH". The guard must compare BARE
    // forms — rejecting a correct exchange-prefixed load would break every
    // healthy symbol.
    assert.equal(r.results[0].ok, true);
    assert.equal(r.results[0].flip, 100);
    // The injected data flows through untouched: loaded once, used per symbol.
    assert.equal(applyOne.calls.length, 1);
    assert.equal(applyOne.calls[0].symbol, 'SMH');
    assert.equal(applyOne.calls[0].walls, WALLS);
    assert.equal(applyOne.calls[0].vol, VOL);
  });

  test('a load that resolves to a DIFFERENT instrument is refused — walls are not written onto it', async () => {
    // The resolver passes BRK-B (it is a share class, not crypto, and the
    // resolver cannot know every trap). The chart then loads a spread. This is
    // exactly the case only load verification can catch.
    const chart = fakeChart({ loads: { 'BRK-B': 'NYSE:BRK-NYSE:B' } });
    const applyOne = fakeApply();
    const r = await run(['BRK-B'], { chart, applyOne });

    assert.equal(applyOne.calls.length, 0, 'walls were written onto a spread series');
    const f = r.results[0];
    assert.equal(f.ok, false);
    assert.ok(!f.skipped, 'a wrong load was ATTEMPTED — it is a failure, not a skip');
    assert.match(f.error, /NYSE:BRK-NYSE:B/, 'the error must name what actually loaded');
    assert.match(f.error, /BRK-B/, 'the error must name what was asked for');
    assert.equal(r.failed, 1);
    assert.equal(r.skipped, 0);
  });

  test('a load the chart cannot attribute to a symbol is refused — unknown is not verified', async () => {
    const chart = fakeChart({ loads: { SMH: null } });
    const applyOne = fakeApply();
    const r = await run(['SMH'], { chart, applyOne });

    assert.equal(applyOne.calls.length, 0);
    assert.equal(r.results[0].ok, false);
    assert.equal(r.failed, 1);
  });

  test('the chart is restored to where it started, even after a refused load', async () => {
    const chart = fakeChart({ loads: { 'BRK-B': 'NYSE:BRK-NYSE:B' } });
    const applyOne = fakeApply();
    const r = await run(['SMH', 'BRK-B'], { chart, applyOne });

    assert.equal(chart.setSymbolCalls.at(-1), 'BATS:QQQ', 'the chart was left on a working symbol');
    assert.deepEqual(chart.setTimeframeCalls, ['1D']);
    assert.deepEqual(r.chart_restored_to, { symbol: 'BATS:QQQ', timeframe: '1D' });
  });

  test('an all-skipped list never touches the chart at all', async () => {
    // No symbol was chartable, so there is nothing to restore FROM — driving
    // the shared chart just to put it back is a write with no purpose.
    const chart = fakeChart();
    const applyOne = fakeApply();
    const r = await run(['BTC-USD', 'ETH-USD'], { chart, applyOne });

    assert.equal(chart.setSymbolCalls.length, 0);
    assert.equal(r.skipped, 2);
    assert.equal(r.applied, 0);
    assert.strictEqual(r.chart_restored_to, null);
  });

  test('an empty symbols list still throws', async () => {
    await assert.rejects(
      () => run([], { chart: fakeChart(), applyOne: fakeApply() }),
      /symbols is required/,
    );
  });
});
