import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { applyTradability } from '../src/core/finviz.js';

/**
 * Finviz is a CONSTRAINT, not a screen.
 *
 * The tempting move after reading a swing-trading workflow is to add its screener.
 * Everything in it — sector, relative volume, price above the 20/50/200 — is
 * already in TradingView's scanner, and the trend-alignment clause is `stage_plan`,
 * forward-tested at 33.5% against a 36.4% baseline. What Finviz uniquely has is not
 * a way to FIND a candidate but a reason to REJECT one.
 */
const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');
const cand = (symbol, bias) => ({ symbol, stage2: { bias } });

describe('the veto is direction-aware', () => {
  const constraints = {
    available: true,
    tickers: {
      NOBORROW: { optionable_and_shortable: false, basis: 'liquid enough, genuine gap' },
      FINE: { optionable_and_shortable: true },
      UNTESTED: { optionable_and_shortable: null, basis: 'below the liquidity bar' },
    },
  };

  test('a BEARISH read on a name with no borrow is vetoed', () => {
    const r = applyTradability([cand('NASDAQ:NOBORROW', 'BEARISH')], constraints);
    assert.deepEqual(r.kept, []);
    assert.equal(r.vetoed.length, 1);
    assert.match(r.vetoed[0].why, /no borrow means no trade/);
  });

  test('a BULLISH read on the SAME name is kept', () => {
    // Shortability only binds on something we would short. Vetoing a long for a
    // borrow it never needed would discard a perfectly good candidate.
    const r = applyTradability([cand('NASDAQ:NOBORROW', 'BULLISH')], constraints);
    assert.equal(r.kept.length, 1);
    assert.equal(r.vetoed.length, 0);
    assert.match(r.flagged[0].why, /a SHORT here would not be executable/);
  });

  test('a BEARISH read on a shortable name passes untouched', () => {
    const r = applyTradability([cand('NASDAQ:FINE', 'BEARISH')], constraints);
    assert.equal(r.kept.length, 1);
    assert.deepEqual(r.vetoed, []);
    assert.deepEqual(r.flagged, []);
  });
});

describe('unknown is not a negative', () => {
  test('a null shortability vetoes nothing, even on a bearish read', () => {
    /**
     * `null` means the query failed OR the name sat below the liquidity bar the
     * query used and was never tested. Neither is evidence it cannot be borrowed.
     */
    const r = applyTradability([cand('NASDAQ:UNTESTED', 'BEARISH')], {
      available: true,
      tickers: { UNTESTED: { optionable_and_shortable: null, basis: 'never tested' } },
    });
    assert.equal(r.kept.length, 1);
    assert.deepEqual(r.vetoed, []);
  });

  test('a name Finviz never answered for vetoes nothing', () => {
    const r = applyTradability([cand('NASDAQ:MISSING', 'BEARISH')], { available: true, tickers: {} });
    assert.equal(r.kept.length, 1);
    assert.deepEqual(r.vetoed, []);
  });

  test('Finviz being DOWN vetoes nothing, and says so', () => {
    /**
     * The whole point. This shells out to Python and scrapes a third-party site —
     * it will be down, slow, or newly-broken. Dropping candidates because a scrape
     * failed would be inventing a reason.
     */
    const all = [cand('A', 'BEARISH'), cand('B', 'BEARISH'), cand('C', 'BULLISH')];
    const r = applyTradability(all, { available: false, why: 'timed out', tickers: {} });
    assert.equal(r.kept.length, 3);
    assert.deepEqual(r.vetoed, []);
    assert.match(r.note, /UNAVAILABLE/);
    assert.match(r.note, /not evidence a name is untradeable/);
  });
});

describe('earnings timing is carried, not acted on', () => {
  test('reporting this week is a flag', () => {
    // The existing veto already handles the DATE. What Finviz adds is BMO/AMC, and
    // that is a fact for the plan to weigh, not a second automatic rejection.
    const r = applyTradability([cand('X', 'BULLISH')], {
      available: true,
      tickers: { X: { optionable_and_shortable: true, reports_this_week: true } },
    });
    assert.equal(r.kept.length, 1);
    assert.match(r.flagged[0].why, /reports this week/);
  });
});

describe('it is wired in, and it is not a screen', () => {
  test('the morning routine applies it before the watchlist is written', () => {
    const m = src('scripts/morning-screen.js');
    assert.match(m, /await finvizConstraints\(/);
    assert.match(m, /applyTradability\(allSelected, tradability\)/);
    assert.ok(m.indexOf('applyTradability') < m.indexOf('const built = buildSectioned'),
      'a vetoed name must never reach the watchlist');
  });

  test('vetoed names are removed from their tier', () => {
    // Reporting a veto without acting on it is the "declared and skipped" pattern.
    assert.match(src('scripts/morning-screen.js'), /tiers\[t\] = tiers\[t\]\.filter\(\(x\) => !dead\.has\(x\.symbol\)\)/);
  });

  test('it is NOT registered as a screen', () => {
    /**
     * A ninth screen would duplicate what TradingView already does faster, from a
     * scraped source, and would need a strategy in the catalogue or its survivors
     * would classify as null and vanish. Finviz finds nothing; it only removes.
     */
    const screens = src('src/core/screens.js');
    assert.ok(!/finviz/i.test(screens), 'Finviz must not appear in SCREENS or INTRADAY_SCREENS');
    assert.match(src('src/core/finviz.js'), /not a screener/i);
  });

  test('the report distinguishes vetoed from flagged, and says when it could not run', () => {
    const m = src('scripts/morning-screen.js');
    assert.match(m, /vetoed: tradabilityResult\.vetoed/);
    assert.match(m, /flagged: tradabilityResult\.flagged/);
    assert.match(m, /why_unavailable: tradability\.why/);
  });
});
