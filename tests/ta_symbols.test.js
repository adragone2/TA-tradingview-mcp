import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolveTaSymbol, partitionTaTickers } from '../src/core/ta_symbols.js';
import { applyWallsForSymbols } from '../src/core/ta_walls.js';

/**
 * The hyphen is TradingView's SPREAD operator, and that is the whole subject of
 * this file.
 *
 * `BTC-USD` was measured live resolving to `CRYPTOCAP:BTC-BATS:USD` — 300 bars, a
 * real price, every detector running happily on a series that is not Bitcoin. It
 * does not throw. It lies. A share class is the same shape on an instrument this
 * layer actually trades: `BRK-B` is BRK minus B, and it would have been filed under
 * "BRK-B" with levels and a stop drawn on it.
 *
 * So every assertion below is about one of two failure modes: a ticker that gets
 * silently mis-resolved, or a mapping invented for a form nobody has verified.
 */

const SRC = 'src/core/ta_symbols.js';

describe('share classes are mapped to the dot form, not passed through', () => {
  test('BRK-B charts as BRK.B, and expect follows the mapping', () => {
    /**
     * `expect` is what the caller compares the LOADED series against
     * (scripts/sunday-review.js loadSymbol). If it stayed "BRK-B" the correct load
     * would be rejected; if the symbol stayed "BRK-B" the wrong series would be
     * accepted. Both fields have to move together.
     */
    const r = resolveTaSymbol('BRK-B');
    assert.equal(r.symbol, 'BRK.B');
    assert.equal(r.expect, 'BRK.B');
    assert.equal(r.kind, 'equity');
    assert.equal(r.chartable, true);
    assert.equal(r.mapped, true);
  });

  test('BF-B and MOG-A too — a two-letter root and a class A', () => {
    // BF-B (Brown-Forman) has a two-character root, MOG-A (Moog) is a class A.
    // Neither is exotic; both would have charted as a spread.
    assert.equal(resolveTaSymbol('BF-B').symbol, 'BF.B');
    assert.equal(resolveTaSymbol('BF-B').expect, 'BF.B');
    assert.equal(resolveTaSymbol('MOG-A').symbol, 'MOG.A');
    assert.equal(resolveTaSymbol('MOG-A').expect, 'MOG.A');
  });

  test('the reason names the spread trap, so a reader learns why the dot matters', () => {
    /**
     * `why` on a chartable symbol is not an exclusion — it is the explanation of a
     * rewrite. Without the reason attached, the next person to see "BRK-B" become
     * "BRK.B" has no way to tell a translation from a typo.
     */
    const why = resolveTaSymbol('BRK-B').why;
    assert.match(why, /SPREAD/, 'it must name the spread operator');
    assert.match(why, /BRK\.B/, 'and the form it is charted as');
  });

  test('case does not decide the outcome', () => {
    // TA writes upper case, but a lower-case string must not silently fall through
    // to the pass-through branch and become a spread.
    assert.equal(resolveTaSymbol('brk-b').symbol, 'BRK.B');
  });
});

describe('crypto is untouched by the class-share rule', () => {
  test('BTC-USD is still excluded crypto', () => {
    const r = resolveTaSymbol('BTC-USD');
    assert.equal(r.kind, 'crypto');
    assert.equal(r.chartable, false);
    assert.equal(r.symbol, 'BTC-USD', 'excluded, so nothing is rewritten');
    assert.equal(r.expect, 'BTC-USD');
    assert.match(r.why, /CRYPTOCAP:BTC-BATS:USD/, 'the measured resolution stays on the record');
  });

  test('ARB11841-USD — the CoinMarketCap-id form — is still crypto', () => {
    // TA writes some crypto with a numeric id on the base. This is the ticker the
    // ordering exists for: it must reach the crypto branch and be excluded, never
    // be handed to any mapping rule.
    const r = resolveTaSymbol('ARB11841-USD');
    assert.equal(r.kind, 'crypto');
    assert.equal(r.chartable, false);
    assert.equal(r.symbol, 'ARB11841-USD');
  });

  test('the crypto test runs FIRST in the source, not merely by luck of the regex', () => {
    /**
     * The two patterns happen to be disjoint today — `-USD` is three letters after
     * the hyphen, a class is one — so no current input can tell the order apart.
     * That is exactly why it is pinned here: the day either pattern widens, the
     * ordering is the only thing standing between the crypto book and a rewrite,
     * and a behavioural test would not have noticed it move.
     */
    const s = readFileSync(`${process.cwd()}/${SRC}`, 'utf8');
    assert.ok(s.indexOf('raw.match(CRYPTO_RE)') < s.indexOf('raw.match(CLASS_SHARE_RE)'),
      'crypto must be decided before any class-share mapping is attempted');
  });
});

describe('everything else is left alone', () => {
  test('a plain ticker passes through untouched', () => {
    const r = resolveTaSymbol('ANET');
    assert.equal(r.symbol, 'ANET');
    assert.equal(r.expect, 'ANET');
    assert.equal(r.kind, 'equity');
    assert.equal(r.chartable, true);
    assert.equal(r.mapped, false, 'nothing was rewritten, so nothing is claimed to have been');
    assert.equal(r.why, null);
  });

  test('an exchange prefix still only affects expect', () => {
    // TradingView answers with a prefixed symbol, so the caller strips the prefix
    // before comparing. `expect` is stored already stripped.
    const r = resolveTaSymbol('BATS:ANET');
    assert.equal(r.symbol, 'BATS:ANET');
    assert.equal(r.expect, 'ANET');
  });

  test('a TWO-letter suffix is NOT a share class, and no mapping is invented', () => {
    /**
     * `ABC-XY` is not a class. Two letters after the hyphen is a preferred series, a
     * unit, or a foreign listing convention, and each has its own TradingView
     * spelling — guessing `ABC.XY` would be inventing a symbol, the same class of
     * error as the spread it would be trying to avoid.
     *
     * What it DOES instead, documented rather than asserted-into-existence: it falls
     * through the pass-through branch unchanged, still `chartable`, still a spread
     * risk — and `expect` is the backstop. A spread comes back as a different series,
     * so the caller's identity check fails loudly rather than filing another
     * instrument's bars. Map it here only once someone has loaded it on the chart.
     */
    const r = resolveTaSymbol('ABC-XY');
    assert.equal(r.symbol, 'ABC-XY', 'unchanged — not rewritten to ABC.XY');
    assert.equal(r.expect, 'ABC-XY');
    assert.equal(r.mapped, false);
    assert.equal(r.kind, 'equity');
  });

  test('a root longer than five letters is not a share class either', () => {
    // US roots are at most five characters; anything longer with a trailing letter
    // is some other convention, so it is left alone for the same reason as ABC-XY.
    assert.equal(resolveTaSymbol('ABCDEF-B').symbol, 'ABCDEF-B');
    assert.equal(resolveTaSymbol('ABCDEF-B').mapped, false);
  });

  test('an empty ticker is unknown, not chartable', () => {
    const r = resolveTaSymbol('');
    assert.equal(r.kind, 'unknown');
    assert.equal(r.chartable, false);
    assert.equal(r.why, 'empty ticker');
  });
});

describe('partitionTaTickers still splits the book the same way', () => {
  test('crypto excluded, equities in, the class share mapped on its way through', () => {
    /**
     * The partition is what the Sunday review filters on, and EXCLUDED is reported
     * separately from FAILED. A class share must land in `chartable` — it is an
     * equity on the equity layer — carrying the mapped symbol, while `ticker` keeps
     * TA's own string so the two can still be matched up in the report.
     */
    const { chartable, excluded } = partitionTaTickers(['ANET', 'BRK-B', 'BTC-USD']);
    assert.deepEqual(chartable.map((c) => c.ticker), ['ANET', 'BRK-B']);
    assert.deepEqual(chartable.map((c) => c.symbol), ['ANET', 'BRK.B']);
    assert.deepEqual(excluded.map((e) => e.ticker), ['BTC-USD']);
    assert.equal(excluded[0].kind, 'crypto');
  });

  test('an empty list is an empty split, not a throw', () => {
    const { chartable, excluded } = partitionTaTickers();
    assert.deepEqual(chartable, []);
    assert.deepEqual(excluded, []);
  });
});

/**
 * ── MERGE NOTE ──
 *
 * The resolver-contract suites above came from P0.2 (main). The walls-sweep suite
 * below came from P0.5, written in a worktree branched BEFORE the class-share
 * mapping existed — its own five resolver tests duplicated the coverage above and
 * were dropped in the merge; the sweep suite is the part main did not have. On the
 * pre-mapping base BRK-B was caught by the loaded-symbol check; on this base it is
 * mapped before the chart is ever driven. Both layers are asserted below.
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
    /**
     * This test originally used BRK-B as "the trap the resolver cannot know" — and
     * then P0.2 taught the resolver exactly that trap, so on this base BRK-B is
     * MAPPED to BRK.B before the chart is ever driven and the spread never occurs.
     * The merge caught the collision: the fixture keyed its fake load on 'BRK-B',
     * the sweep asked for 'BRK.B', and walls were applied to the default load.
     *
     * The intent stands, so the example moves to a form the resolver still and
     * DELIBERATELY passes through unmapped: a two-letter suffix (preferred-share /
     * unit conventions have their own spellings, and inventing one is the same
     * error class as the spread — ta_symbols.js documents `expect` as the loud
     * backstop for exactly this). Here that backstop is the thing under test.
     */
    const chart = fakeChart({ loads: { 'SOME-PF': 'NYSE:SOME-NYSE:PF' } });
    const applyOne = fakeApply();
    const r = await run(['SOME-PF'], { chart, applyOne });

    assert.equal(applyOne.calls.length, 0, 'walls were written onto a spread series');
    const f = r.results[0];
    assert.equal(f.ok, false);
    assert.ok(!f.skipped, 'a wrong load was ATTEMPTED — it is a failure, not a skip');
    assert.match(f.error, /NYSE:SOME-NYSE:PF/, 'the error must name what actually loaded');
    assert.match(f.error, /SOME-PF/, 'the error must name what was asked for');
    assert.equal(r.failed, 1);
    assert.equal(r.skipped, 0);
  });

  test('a class share is mapped BEFORE the chart is driven — the spread never happens', async () => {
    // The other half of the collision above: BRK-B is no longer the backstop's
    // example because the resolver now owns it. Assert the promotion explicitly —
    // the chart must be asked for BRK.B, never BRK-B.
    const chart = fakeChart();
    const applyOne = fakeApply();
    const r = await run(['BRK-B'], { chart, applyOne });

    assert.deepEqual(chart.setSymbolCalls.filter((s) => s === 'BRK-B'), [],
      'the raw hyphen form must never reach the chart');
    assert.ok(chart.setSymbolCalls.includes('BRK.B'), 'the mapped dot form is what gets driven');
    assert.equal(applyOne.calls.length, 1, 'and walls apply normally to the verified load');
    assert.equal(r.results[0].ok, true);
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
