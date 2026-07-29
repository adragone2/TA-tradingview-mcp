import { test, describe } from 'node:test';
import assert from 'node:assert';
import { offHighPct, daysToEarnings, movedSinceBar, UNIVERSES, DEFAULT_UNIVERSE, LIQUIDITY_FILTER } from '../src/core/scanner.js';
import { parseSections, flattenSections, buildWithPreserved } from '../src/core/watchlist_rewrite.js';
import { SCREENS, veto, VETO_DEFAULTS, mergeByConfluence, overlapMatrix, DEFAULT_SLOTS } from '../src/core/screens.js';

const row = (o = {}) => ({
  symbol: 'NASDAQ:TEST', name: 'TEST', close: 100,
  average_volume_10d_calc: 2_000_000, market_cap_basic: 5e9,
  'Perf.Y': 40, 'Perf.6M': 10, 'Perf.3M': 8, 'Perf.1M': -3, RSI: 45,
  'Volatility.D': 2, price_52_week_high: 110, price_52_week_low: 60,
  earnings_release_next_date: null, ...o,
});

describe('scanner helpers', () => {
  test('offHighPct is a positive distance BELOW the high', () => {
    assert.equal(offHighPct(row({ close: 90, price_52_week_high: 100 })), 10);
    assert.equal(offHighPct(row({ close: 100, price_52_week_high: 100 })), 0);
  });

  test('offHighPct is null rather than 0 when the high is missing', () => {
    // 0 would read as "at the high", which is the opposite of "unknown".
    assert.equal(offHighPct(row({ price_52_week_high: null })), null);
    assert.equal(offHighPct(row({ close: null })), null);
  });

  test('daysToEarnings converts the unix stamp, and is null when absent', () => {
    const now = Date.UTC(2026, 6, 29);
    assert.equal(daysToEarnings(row({ earnings_release_next_date: now / 1000 + 3 * 86400 }), now), 3);
    assert.equal(daysToEarnings(row(), now), null);
  });

  test('movedSinceBar measures the gap the detectors cannot see', () => {
    // Stage 2 reads yesterday's bar. An overnight move is invisible to it.
    const m = movedSinceBar(row({ close: 100 }), 104, 4);
    assert.equal(m.pct, 4);
    assert.equal(m.atr_multiple, 1);
    assert.equal(m.material, true);
    assert.match(m.note, /Not a signal/);
  });

  test('movedSinceBar is immaterial for a small move', () => {
    assert.equal(movedSinceBar(row({ close: 100 }), 100.5, 4).material, false);
  });

  test('the default universe is the three indices, and each id resolves', () => {
    assert.deepEqual(DEFAULT_UNIVERSE, ['sp500', 'nasdaq', 'russell2000']);
    for (const k of DEFAULT_UNIVERSE) assert.match(UNIVERSES[k].id, /^SYML:/);
  });
});

describe('every screen bounds its thresholds on BOTH sides', () => {
  /**
   * The lesson this whole module is shaped around. "12m momentum positive, RSI
   * below 40" returned SNDK at -49.5% on the month and -53% off its high —
   * collapses carrying a positive twelve-month number. A one-sided threshold on
   * a momentum screen selects the tail, and the tail is where the broken names
   * are.
   */
  const ONE_SIDED_RISK = new Set(['RSI', 'Perf.1M', 'Perf.W']);

  for (const s of SCREENS) {
    test(`${s.key}: no unbounded RSI or short-horizon performance filter`, () => {
      for (const f of s.filter) {
        if (!ONE_SIDED_RISK.has(f.left)) continue;
        assert.equal(f.operation, 'in_range',
          `${s.key} filters ${f.left} with "${f.operation}" — must be in_range so the tail is excluded`);
        assert.ok(Array.isArray(f.right) && f.right.length === 2);
      }
    });
  }

  test('every screen carries liquidity, a direction and its evidence tier', () => {
    for (const s of SCREENS) {
      assert.ok(['continuation', 'reversal'].includes(s.direction), `${s.key} has no direction`);
      assert.ok(s.evidence && s.horizon_side, `${s.key} is missing evidence or horizon_side`);
      for (const l of LIQUIDITY_FILTER) {
        assert.ok(s.filter.some((f) => f.left === l.left), `${s.key} dropped the ${l.left} liquidity filter`);
      }
    }
  });
});

describe('the veto', () => {
  const now = Date.UTC(2026, 6, 29);

  test('blocks a name reporting inside the window', () => {
    const r = veto(row({ earnings_release_next_date: now / 1000 + 2 * 86400 }), { now });
    assert.match(r.join(' '), /earnings in 2 day/);
  });

  test('allows one reporting after the window', () => {
    assert.deepEqual(veto(row({ earnings_release_next_date: now / 1000 + 30 * 86400 }), { now }), []);
  });

  test('blocks a name too far below its high to be a pullback', () => {
    assert.match(veto(row({ close: 50, price_52_week_high: 100 }), { now }).join(' '), /below the 52-week high/);
  });

  test('blocks a name whose costs would exceed the edge', () => {
    assert.match(veto(row({ close: 11, average_volume_10d_calc: 200_000 }), { now }).join(' '), /dollar volume/);
  });

  test('a clean row is allowed', () => {
    assert.deepEqual(veto(row(), { now }), []);
  });

  test('the thresholds are declared, not buried', () => {
    assert.ok(VETO_DEFAULTS.min_days_to_earnings > 0);
    assert.ok(VETO_DEFAULTS.min_dollar_volume > 0);
  });
});

describe('mergeByConfluence — direction-aware, because global confluence erased a whole side', () => {
  /**
   * Measured on the live universe: structural_reversal overlaps every other
   * screen at 0%, because it selects RSI 15-35 and they select 40-75. Under a
   * single global confluence ranking it can never score above 1 and is deleted
   * outright — the reversal side, which is the side the evidence favours under
   * 21 days.
   */
  const cont = (sym, perf) => ({ ...row({ 'Perf.Y': perf }), symbol: sym });
  const results = {
    momentum_pullback: [cont('A', 50), cont('B', 40)],
    near_52w_high: [cont('A', 50), cont('C', 30)],
    rs_leadership: [cont('A', 50), cont('B', 40)],
    structural_reversal: [cont('R1', 5), cont('R2', 3)],
  };

  test('a reversal candidate reaches the list despite confluence 1', () => {
    const m = mergeByConfluence(results, { top: 6 });
    const syms = m.candidates.map((c) => c.symbol);
    assert.ok(syms.includes('R1'), 'the reversal side was erased — the exact bug this fixes');
  });

  test('continuation candidates still rank by confluence among themselves', () => {
    const m = mergeByConfluence(results, { top: 6 });
    const contOnly = m.candidates.filter((c) => c.direction === 'continuation');
    assert.equal(contOnly[0].symbol, 'A');            // 3 screens
    assert.ok(contOnly[0].confluence > contOnly[1].confluence);
  });

  test('each direction gets its own slots', () => {
    const m = mergeByConfluence(results, { top: 4, slots: { continuation: 2, reversal: 2 } });
    assert.equal(m.candidates.filter((c) => c.direction === 'reversal').length, 2);
    assert.equal(m.candidates.filter((c) => c.direction === 'continuation').length, 2);
  });

  test('spare slots are reallocated rather than wasted', () => {
    const thin = { momentum_pullback: [cont('A', 50), cont('B', 40), cont('C', 30)], structural_reversal: [] };
    const m = mergeByConfluence(thin, { top: 3, slots: { continuation: 1, reversal: 2 } });
    assert.equal(m.candidates.length, 3, 'unused reversal slots were not given back');
  });

  test('the veto removes names before ranking, and says why', () => {
    const withBad = { ...results, momentum_pullback: [...results.momentum_pullback, { ...row({ close: 11, average_volume_10d_calc: 100 }), symbol: 'ILLIQ' }] };
    const m = mergeByConfluence(withBad, { top: 10 });
    assert.ok(!m.candidates.some((c) => c.symbol === 'ILLIQ'));
    assert.ok(m.vetoed_detail.some((v) => v.symbol === 'ILLIQ' && v.reasons.length));
  });

  test('the trial count is every symbol x screen, not the screen count', () => {
    const m = mergeByConfluence(results, { top: 6 });
    assert.equal(m.trials, 8);                       // 2+2+2+2
    assert.match(m.trial_note, /Deflate/);
  });

  test('heavy overlap is REPORTED so confluence is not overread', () => {
    const m = mergeByConfluence(results, { top: 6 });
    // momentum_pullback and rs_leadership are identical here -> 100%.
    assert.ok(m.overlap_warning, 'identical screens produced no redundancy warning');
    assert.match(m.overlap_warning, /NOT independent/);
  });

  test('overlapMatrix is symmetric-free and in percent', () => {
    const o = overlapMatrix(results);
    assert.equal(o['momentum_pullback|rs_leadership'], 100);
    assert.equal(o['momentum_pullback|structural_reversal'], 0);
  });

  test('a smaller top scales the slots instead of truncating the reversal side', () => {
    // --top 6 originally returned six continuation names: the slot lists were
    // concatenated and then sliced, and reversal sits at the end.
    const many = {
      momentum_pullback: Array.from({ length: 30 }, (_, i) => ({ ...row(), symbol: `C${i}` })),
      structural_reversal: Array.from({ length: 10 }, (_, i) => ({ ...row(), symbol: `R${i}` })),
    };
    const m = mergeByConfluence(many, { top: 6 });
    assert.equal(m.candidates.length, 6);
    assert.ok(m.candidates.some((c) => c.direction === 'reversal'),
      'the reversal side was truncated away again at a smaller top');
  });

  test('the default slots leave room for the reversal side', () => {
    assert.ok(DEFAULT_SLOTS.reversal >= 1, 'the reversal side would be erased again');
    assert.equal(DEFAULT_SLOTS.continuation + DEFAULT_SLOTS.reversal, 20);
  });
});

describe('KEEP — sections survive the daily rewrite', () => {
  /**
   * TradingView stores a watchlist as ONE flat array where a section header is
   * an entry prefixed with `###`. Moving a ticker into KEEP is how the user
   * tells the morning run to leave it alone: it stays in the list AND its
   * drawings stay on the chart.
   */
  const cur = ['NASDAQ:VLY', 'NYSE:CVS', '###KEEP', 'NASDAQ:NVDA', 'NASDAQ:AAPL'];

  test('parses the flat array into a default section plus named ones', () => {
    const p = parseSections(cur);
    assert.deepEqual(p.default, ['NASDAQ:VLY', 'NYSE:CVS']);
    assert.equal(p.sections.length, 1);
    assert.equal(p.sections[0].name, 'KEEP');
    assert.deepEqual(p.sections[0].symbols, ['NASDAQ:NVDA', 'NASDAQ:AAPL']);
  });

  test('a rewrite replaces the default section and preserves KEEP verbatim', () => {
    const b = buildWithPreserved(cur, ['NYSE:XOM', 'NYSE:WMT'], ['KEEP']);
    assert.deepEqual(b.entries, ['NYSE:XOM', 'NYSE:WMT', '###KEEP', 'NASDAQ:NVDA', 'NASDAQ:AAPL']);
    assert.deepEqual(b.protected_symbols, ['NASDAQ:NVDA', 'NASDAQ:AAPL']);
  });

  test('a name in KEEP that also screens today appears ONCE, in KEEP', () => {
    // TradingView 422s the entire write on a duplicate, so this is not
    // cosmetic — it would fail the whole run.
    const b = buildWithPreserved(cur, ['NASDAQ:NVDA', 'NYSE:XOM'], ['KEEP']);
    assert.equal(b.entries.filter((e) => e === 'NASDAQ:NVDA').length, 1);
    assert.ok(b.entries.indexOf('NASDAQ:NVDA') > b.entries.indexOf('###KEEP'));
  });

  test('section matching is case-insensitive', () => {
    const b = buildWithPreserved(['A', '###keep', 'B'], ['C'], ['KEEP']);
    assert.deepEqual(b.entries, ['C', '###keep', 'B']);
  });

  test('a list with no sections rewrites cleanly', () => {
    const b = buildWithPreserved(['A', 'B'], ['C', 'D'], ['KEEP']);
    assert.deepEqual(b.entries, ['C', 'D']);
    assert.deepEqual(b.protected_symbols, []);
  });

  test('an empty KEEP section is preserved so the user does not lose the header', () => {
    const b = buildWithPreserved(['A', '###KEEP'], ['C'], ['KEEP']);
    assert.deepEqual(b.entries, ['C', '###KEEP']);
  });

  test('sections NOT on the preserve list are reported, not silently dropped', () => {
    const b = buildWithPreserved(['A', '###OLD', 'X'], ['C'], ['KEEP']);
    assert.deepEqual(b.dropped_sections, ['OLD']);
  });

  test('flatten is the inverse of parse', () => {
    assert.deepEqual(flattenSections(parseSections(cur)), cur);
  });
});
