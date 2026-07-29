import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildBucketed, sectionSymbols, parseSections } from '../src/core/watchlist_rewrite.js';

/** The user's list as it actually stands before this change: names + one KEEP. */
const LEGACY = ['NASDAQ:AAPL', 'NYSE:CVS', '###KEEP', 'NASDAQ:NVDA', 'NYSE:JPM'];

describe('sectionSymbols', () => {
  test('reads a named section', () => {
    assert.deepEqual(sectionSymbols(LEGACY, 'KEEP'), ['NASDAQ:NVDA', 'NYSE:JPM']);
  });

  test('is case-insensitive', () => {
    assert.deepEqual(sectionSymbols(LEGACY, 'keep'), ['NASDAQ:NVDA', 'NYSE:JPM']);
  });

  test('a missing section is empty, not an error', () => {
    assert.deepEqual(sectionSymbols(LEGACY, 'Months'), []);
  });

  test('returns a copy — callers must not be able to mutate the list', () => {
    const got = sectionSymbols(LEGACY, 'KEEP');
    got.push('NASDAQ:MSFT');
    assert.equal(sectionSymbols(LEGACY, 'KEEP').length, 2);
  });
});

describe('buildBucketed', () => {
  test('produces Months, Weeks, and carries KEEP through', () => {
    const r = buildBucketed(LEGACY, { weeks: ['NASDAQ:TSLA'], months: ['NYSE:XOM'] });
    const parsed = parseSections(r.entries);
    assert.deepEqual(parsed.sections.map((s) => s.name), ['Months', 'Weeks', 'KEEP']);
    assert.deepEqual(sectionSymbols(r.entries, 'KEEP'), ['NASDAQ:NVDA', 'NYSE:JPM']);
  });

  test('the existing plain ###KEEP survives — prefix match, not exact name', () => {
    /**
     * The user already has a section called exactly "KEEP". Matching an exact
     * list of ['KEEP weeks','KEEP months'] would have deleted it along with
     * every symbol they had pinned there.
     */
    const r = buildBucketed(LEGACY, { weeks: [], months: [] });
    assert.equal(r.preserved_sections.length, 1);
    assert.equal(r.preserved_sections[0].name, 'KEEP');
  });

  test('KEEP weeks and KEEP months are preserved too', () => {
    const list = ['###KEEP weeks', 'A', '###KEEP months', 'B'];
    const r = buildBucketed(list, { weeks: ['C'], months: ['D'] });
    assert.deepEqual(r.preserved_sections.map((s) => s.name), ['KEEP weeks', 'KEEP months']);
  });

  test('a pinned symbol is dropped from the buckets, never duplicated', () => {
    // TradingView rejects the ENTIRE write with 422 on a duplicate, so this is
    // not cosmetic — one dupe loses the whole list.
    const r = buildBucketed(LEGACY, { weeks: ['NASDAQ:NVDA'], months: ['NASDAQ:NVDA', 'NYSE:XOM'] });
    assert.ok(!r.months.includes('NASDAQ:NVDA'));
    assert.ok(!r.weeks.includes('NASDAQ:NVDA'));
    const all = r.entries.filter((e) => !e.startsWith('###'));
    assert.equal(new Set(all).size, all.length, 'a duplicate symbol reached the write');
  });

  test('a name in both buckets lands in Months only', () => {
    const r = buildBucketed([], { weeks: ['X', 'Y'], months: ['X'] });
    assert.deepEqual(r.months, ['X']);
    assert.deepEqual(r.weeks, ['Y']);
  });
});

describe('the cadence, expressed in the watchlist', () => {
  const day1 = buildBucketed(LEGACY, { weeks: ['W1'], months: ['M1', 'M2'] }).entries;

  test('months: null carries the existing Months section forward untouched', () => {
    /**
     * This IS the fix. On 20 of 21 weekdays the Months section must not move,
     * because the factors behind it were measured at monthly rebalance.
     */
    const r = buildBucketed(day1, { weeks: ['W2'], months: null });
    assert.deepEqual(r.months, ['M1', 'M2']);
    assert.equal(r.months_carried_forward, true);
    assert.deepEqual(r.weeks, ['W2'], 'Weeks should still rebalance daily');
  });

  test('passing months explicitly replaces the section', () => {
    const r = buildBucketed(day1, { weeks: ['W2'], months: ['M3'] });
    assert.deepEqual(r.months, ['M3']);
    assert.equal(r.months_carried_forward, false);
  });

  test('an empty array is a real instruction, not the same as null', () => {
    // months: [] means "the rebalance ran and selected nothing" — which must
    // clear the section. Conflating it with null would freeze a stale list.
    const r = buildBucketed(day1, { weeks: [], months: [] });
    assert.deepEqual(r.months, []);
    assert.equal(r.months_carried_forward, false);
  });

  test('repeated carry-forward runs are stable', () => {
    let entries = day1;
    for (let i = 0; i < 5; i++) entries = buildBucketed(entries, { weeks: [`W${i}`], months: null }).entries;
    assert.deepEqual(sectionSymbols(entries, 'Months'), ['M1', 'M2']);
    assert.deepEqual(sectionSymbols(entries, 'Weeks'), ['W4']);
    assert.deepEqual(sectionSymbols(entries, 'KEEP'), ['NASDAQ:NVDA', 'NYSE:JPM']);
  });
});

describe('what gets reported rather than silently discarded', () => {
  test('names in the old default section are surfaced as orphaned', () => {
    // They hold drawings. Losing them silently is how stale shapes accumulate.
    const r = buildBucketed(LEGACY, { weeks: [], months: [] });
    assert.deepEqual(r.orphaned_default, ['NASDAQ:AAPL', 'NYSE:CVS']);
  });

  test('a section that is neither KEEP nor a bucket is reported before it is dropped', () => {
    const list = ['###Watching', 'A', 'B', '###KEEP', 'C'];
    const r = buildBucketed(list, { weeks: [], months: [] });
    assert.deepEqual(r.dropped_sections, [{ name: 'Watching', count: 2 }]);
  });

  test('the bucket sections themselves are not reported as dropped', () => {
    const r = buildBucketed(buildBucketed([], { weeks: ['W'], months: ['M'] }).entries,
      { weeks: ['W'], months: ['M'] });
    assert.deepEqual(r.dropped_sections, []);
  });
});
