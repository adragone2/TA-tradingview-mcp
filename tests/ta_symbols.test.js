import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolveTaSymbol, partitionTaTickers } from '../src/core/ta_symbols.js';

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
