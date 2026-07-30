import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  bare, findRow, issuerOf, dedupeShareClasses, groupMembers, groupLeaders,
  keyPrice, laggards, topDownGate, LIVERMORE_POINT_NOTE,
  TANDEM_CONFIRMATION_STUDY, GROUP_LEAD_LAG_STUDY, PERF_WINDOWS,
} from '../src/core/groups.js';

/** Scanner-shaped rows. `description` is the company name; `name` is the ticker. */
const row = (sym, o = {}) => ({
  symbol: `NASDAQ:${sym}`, name: sym, description: o.description || sym,
  close: 100, industry: 'Semiconductors', sector: 'Electronic Technology',
  market_cap_basic: 1e11, 'Perf.1M': 0, 'Perf.W': 0, ...o,
});

describe('symbol handling', () => {
  test('strips the exchange prefix', () => {
    assert.equal(bare('NASDAQ:AAPL'), 'AAPL');
    assert.equal(bare('aapl'), 'AAPL');
    assert.equal(bare(null), '');
  });

  test('finds a row by bare ticker regardless of prefix', () => {
    const rows = [row('NVDA'), row('AVGO')];
    assert.equal(bare(findRow(rows, 'nvda').symbol), 'NVDA');
    assert.equal(bare(findRow(rows, 'NASDAQ:AVGO').symbol), 'AVGO');
    assert.equal(findRow(rows, 'ZZZZ'), null);
  });
});

describe('dual share classes — the bug that hid a real result', () => {
  test('collapses two listings of one company by issuer name', () => {
    /**
     * The load-bearing case. GOOG and GOOGL as a group's "two leaders" makes the
     * Key Price a tautology — measured, they confirmed each other on 57 of 57
     * signals, which diluted the tandem study from -9.3 to -5.6 points.
     */
    const rows = [
      row('GOOG', { description: 'Alphabet Inc. Class C', market_cap_basic: 4.1e12 }),
      row('GOOGL', { description: 'Alphabet Inc. Class A', market_cap_basic: 4.1e12 }),
      row('META', { description: 'Meta Platforms Inc.', market_cap_basic: 1.5e12 }),
    ];
    const out = dedupeShareClasses(rows);
    assert.equal(out.length, 2);
    assert.ok(out.some((r) => bare(r.symbol) === 'META'));
    assert.equal(out.filter((r) => issuerOf(r) === 'alphabet inc.').length, 1);
  });

  test('strips Class, Cl and Series suffixes', () => {
    assert.equal(issuerOf({ description: 'Fox Corporation Class A' }), 'fox corporation');
    assert.equal(issuerOf({ description: 'Fox Corporation Class B' }), 'fox corporation');
    assert.equal(issuerOf({ description: 'Acme Cl. B' }), 'acme');
    assert.equal(issuerOf({ description: 'Acme Series A' }), 'acme');
  });

  test('ALSO catches them by identical market cap, when the name does not match', () => {
    // Dual classes report the same company cap. Alphabet's differ only by
    // floating-point noise, so the test has to be relative, not exact.
    const rows = [
      row('AAA', { description: 'Widget Holdings', market_cap_basic: 4112712646698.0005 }),
      row('AAAB', { description: 'Widget Hldgs Inc', market_cap_basic: 4112712646697.9995 }),
    ];
    assert.equal(dedupeShareClasses(rows).length, 1);
  });

  test('does NOT collapse two genuinely different companies of similar size', () => {
    const rows = [
      row('X', { description: 'Alpha Corp', market_cap_basic: 1.0e11 }),
      row('Y', { description: 'Beta Corp', market_cap_basic: 1.01e11 }),
    ];
    assert.equal(dedupeShareClasses(rows).length, 2);
  });

  test('keeps the LARGER listing when collapsing', () => {
    const rows = [
      row('SMALL', { description: 'Acme Class B', market_cap_basic: 9e10 }),
      row('BIG', { description: 'Acme Class A', market_cap_basic: 1e11 }),
    ];
    const out = dedupeShareClasses(rows);
    assert.equal(out.length, 1);
    assert.equal(bare(out[0].symbol), 'BIG');
  });

  test('groupMembers applies the dedup', () => {
    const rows = [
      row('GOOG', { description: 'Alphabet Inc. Class C', industry: 'Internet', market_cap_basic: 4e12 }),
      row('GOOGL', { description: 'Alphabet Inc. Class A', industry: 'Internet', market_cap_basic: 4e12 }),
      row('META', { description: 'Meta Platforms', industry: 'Internet', market_cap_basic: 1.5e12 }),
    ];
    const m = groupMembers(rows, 'Internet');
    assert.equal(m.length, 2);
    assert.deepEqual(m.map((r) => bare(r.symbol)), ['GOOG', 'META']);
  });
});

describe('groupLeaders', () => {
  const members = [
    row('A', { market_cap_basic: 5e11, description: 'A Co' }),
    row('B', { market_cap_basic: 2e11, description: 'B Co' }),
    row('C', { market_cap_basic: 1e11, description: 'C Co' }),
  ];

  test('takes the top two by market cap, because that is his rule', () => {
    const r = groupLeaders(members);
    assert.deepEqual(r.leaders.map((x) => bare(x.symbol)), ['A', 'B']);
    assert.equal(r.members_considered, 3);
  });

  test('flags a DOMINANT leader, his stated exception to needing two', () => {
    // "when a single stock may comprise over 50 percent or more of the total
    // sales of the group... one will do."
    const r = groupLeaders([row('BIG', { market_cap_basic: 9e11 }), row('SMALL', { market_cap_basic: 1e11 })]);
    assert.ok(r.dominant);
    assert.equal(r.dominant.symbol, 'BIG');
    // And it must say cap share is a PROXY for sales, which we cannot see.
    assert.match(r.dominant.note, /PROXY/);
    assert.match(r.dominant.note, /cannot see sales/);
  });

  test('no dominance flag when the group is balanced', () => {
    // Four roughly equal names: the top one is ~28%, well under the 50% bar.
    const balanced = [
      row('A', { market_cap_basic: 1.1e11 }), row('B', { market_cap_basic: 1.0e11 }),
      row('C', { market_cap_basic: 1.0e11 }), row('D', { market_cap_basic: 0.9e11 }),
    ];
    assert.equal(groupLeaders(balanced).dominant, null);
  });
});

describe('keyPrice — what the rule actually says', () => {
  const pair = (a, b, w = 'Perf.1M') => [row('A', { [w]: a }), row('B', { [w]: b })];

  test('is an AVERAGE of two leaders, not a demand that both clear the bar', () => {
    /**
     * His own example: U.S. Steel moving 5-1/8 counts if Bethlehem moved 7,
     * because the SUM clears 12. Requiring a sum to clear 2x a bar is the same
     * as requiring the average to clear it — so one leader can carry the other.
     */
    const r = keyPrice(pair(5.125, 7), { threshold_pct: 6 });
    assert.equal(r.available, true);
    assert.equal(r.combined_move_pct, 12.13);
    assert.equal(r.clears_key_price, true);
    assert.ok(r.leaders[0].move_pct < 6, 'one leader is below the bar and it still clears');
    assert.match(r.how_it_works, /same as requiring their AVERAGE/);
  });

  test('flags the ONE-LEADER-CARRYING case as unconfirmed', () => {
    // Average clears, but the leaders point opposite ways. That is precisely the
    // "false movement from one stock" his rule exists to catch.
    const r = keyPrice(pair(20, -5), { threshold_pct: 6 });
    assert.equal(r.clears_key_price, true);
    assert.equal(r.leaders_agree, false);
    assert.match(r.verdict, /leaders DISAGREE/);
    assert.match(r.verdict, /unconfirmed/);
  });

  test('confirms when both agree and the bar is cleared', () => {
    const r = keyPrice(pair(8, 9), { threshold_pct: 6 });
    assert.equal(r.clears_key_price, true);
    assert.equal(r.leaders_agree, true);
    assert.equal(r.direction, 'up');
    assert.match(r.verdict, /both leaders agree/);
  });

  test('works on the short side', () => {
    const r = keyPrice(pair(-8, -9), { threshold_pct: 6 });
    assert.equal(r.direction, 'down');
    assert.equal(r.clears_key_price, true);
  });

  test('REFUSES with one leader — that is the entire point of the rule', () => {
    const r = keyPrice([row('A', { 'Perf.1M': 30 })], { threshold_pct: 6 });
    assert.equal(r.available, false);
    assert.match(r.note, /needs TWO leaders/);
    assert.match(r.note, /false movement/);
  });

  test('a missing performance figure is UNKNOWN, not zero', () => {
    const r = keyPrice([row('A', { 'Perf.1M': null }), row('B', { 'Perf.1M': 8 })]);
    assert.equal(r.available, false);
    assert.match(r.note, /unknown, not zero/);
  });

  test('the six-POINT original is documented and deliberately not copied', () => {
    // Six points on a $30 stock is 20% — a 1940 artefact.
    assert.match(LIVERMORE_POINT_NOTE.problem, /20%/);
    assert.match(LIVERMORE_POINT_NOTE.problem, /1940/);
    assert.match(LIVERMORE_POINT_NOTE.what_we_do, /percentage/);
    assert.ok(Object.keys(PERF_WINDOWS).includes('Perf.1M'));
  });
});

describe('laggards — the sick stock in a healthy group', () => {
  test('finds members materially behind the group median', () => {
    const members = [
      row('A', { 'Perf.1M': 10 }), row('B', { 'Perf.1M': 9 }), row('C', { 'Perf.1M': 8 }),
      row('SICK', { 'Perf.1M': -15 }),
    ];
    const r = laggards(members, { min_gap_pct: 5 });
    assert.equal(r.available, true);
    assert.equal(r.laggards.length, 1);
    assert.equal(r.laggards[0].symbol, 'SICK');
    assert.ok(r.laggards[0].gap_pct < -5);
    assert.match(r.note, /weak or sick/);
  });

  test('uses a MEDIAN so one runaway name cannot define the group', () => {
    const members = [
      row('MOON', { 'Perf.1M': 200 }), row('A', { 'Perf.1M': 2 }),
      row('B', { 'Perf.1M': 1 }), row('C', { 'Perf.1M': 0 }),
    ];
    const r = laggards(members, { min_gap_pct: 5 });
    assert.ok(r.group_median_move_pct < 5, `median was ${r.group_median_move_pct}`);
    assert.equal(r.laggards.length, 0, 'nobody is a laggard just because one name went up 200%');
  });

  test('too few members is unavailable, not an empty finding', () => {
    assert.equal(laggards([row('A', { 'Perf.1M': 1 })]).available, false);
    assert.equal(laggards([]).available, false);
  });
});

describe('topDownGate — his four steps, in order', () => {
  const confirmed = { available: true, clears_key_price: true, leaders_agree: true, direction: 'up' };

  test('OPENS only when all three levels agree', () => {
    const r = topDownGate({ market: 'up', group: 'up', key_price: confirmed });
    assert.equal(r.gate, 'OPEN');
    assert.equal(r.direction, 'up');
    assert.equal(r.side, 'long');
    assert.equal(r.steps_passed, 3);
  });

  test('CLOSES when the market disagrees with the group', () => {
    const r = topDownGate({ market: 'down', group: 'up', key_price: confirmed });
    assert.equal(r.gate, 'CLOSED');
    assert.equal(r.side, null);
    // Every step passes individually here — it is a DIRECTION CONFLICT, and
    // reporting that as "0 of 3 levels did not confirm" would be nonsense.
    assert.ok(r.steps.every((s) => s.pass));
    assert.match(r.reason, /DIFFERENT DIRECTIONS/);
    assert.match(r.reason, /conflict, not a failed/);
  });

  test('CLOSES when the Key Price is not met, even with market and group aligned', () => {
    const r = topDownGate({
      market: 'up', group: 'up',
      key_price: { available: true, clears_key_price: false, leaders_agree: false, direction: 'up' },
    });
    assert.equal(r.gate, 'CLOSED');
    assert.equal(r.steps.find((s) => s.step === 3).pass, false);
  });

  test('CLOSES when the leaders disagree, even if the average clears', () => {
    const r = topDownGate({
      market: 'up', group: 'up',
      key_price: { available: true, clears_key_price: true, leaders_agree: false, direction: 'up' },
    });
    assert.equal(r.gate, 'CLOSED');
  });

  test('a flat market fails step 1 — flat is not a direction to trade with', () => {
    assert.equal(topDownGate({ market: 'flat', group: 'up', key_price: confirmed }).gate, 'CLOSED');
  });

  test('refuses a side that contradicts the aligned direction', () => {
    const r = topDownGate({ market: 'up', group: 'up', key_price: confirmed, side: 'short' });
    assert.equal(r.gate, 'CLOSED');
    assert.match(r.reason, /contradicts/);
  });

  test('every step carries its reason, and step order is his', () => {
    const r = topDownGate({ market: 'up', group: 'up', key_price: confirmed });
    assert.deepEqual(r.steps.map((s) => s.step), [1, 2, 3]);
    assert.match(r.steps[0].name, /line of least resistance/);
    assert.match(r.steps[1].name, /industry group/);
    assert.match(r.steps[2].name, /two leaders/);
    for (const s of r.steps) assert.ok(s.why && s.why.length > 20);
  });

  test('says outright that a gate is not an edge, citing stage_plan', () => {
    // The lesson already paid for once in this repo.
    const r = topDownGate({ market: 'up', group: 'up', key_price: confirmed });
    assert.match(r.what_this_is_not, /not an edge/);
    assert.match(r.what_this_is_not, /stage_plan/);
    assert.match(r.what_this_is_not, /WORSE/);
  });
});

describe('the measured studies', () => {
  test('the tandem confirmation claim is recorded as NEGATIVE, with both arms', () => {
    const s = TANDEM_CONFIRMATION_STUDY;
    assert.match(s.status, /NEGATIVE/);
    assert.equal(s.solo.win_rate_pct, 30.9);
    assert.equal(s.tandem.win_rate_pct, 21.6);
    assert.equal(s.lift_points, -9.3);
    assert.ok(s.tandem.win_rate_pct < s.solo.win_rate_pct);
    assert.match(s.verdict, /HURTS/);
  });

  test('records how many signals the filter discards, not just the win rate', () => {
    // A filter that costs 58% of signals has to earn it. This one does not.
    assert.ok(TANDEM_CONFIRMATION_STUDY.signals_discarded_pct > 50);
  });

  test('records the dual-class BUG that initially hid the result', () => {
    /**
     * Fixing it made the effect stronger (-5.6 -> -9.3). A data-quality bug was
     * diluting a real finding, which is the opposite of the usual direction and
     * worth keeping on the record.
     */
    const b = TANDEM_CONFIRMATION_STUDY.bug_that_hid_it;
    assert.match(b, /GOOG/);
    assert.match(b, /57 of 57/);
    assert.match(b, /-5\.6/);
  });

  test('ties the failure to the other two gates measured here', () => {
    assert.match(TANDEM_CONFIRMATION_STUDY.why_it_is_coherent, /third to fail/);
    assert.match(TANDEM_CONFIRMATION_STUDY.why_it_is_coherent, /stage_plan/);
  });

  test('admits it has no out-of-sample arm', () => {
    const c = TANDEM_CONFIRMATION_STUDY.caveats.join(' ');
    assert.match(c, /No out-of-sample arm/i);
    assert.match(c, /optimistic/);
  });

  test('separates the rejected FILTER from the useful DESCRIPTION', () => {
    // Killing the confirmation rule does not kill knowing a stock's group.
    assert.match(TANDEM_CONFIRMATION_STUDY.caveats.join(' '), /CONFIRMATION FILTER, not the value/);
  });

  test('the lead-lag claim is honestly marked NOT YET MEASURED', () => {
    const g = GROUP_LEAD_LAG_STUDY;
    assert.match(g.status, /NOT YET MEASURED/);
    assert.match(g.why_it_is_hard, /~300 bars/);
    // And it records that Livermore's own experience contradicted him.
    assert.match(g.his_own_counterexample, /lost his shirt/);
  });
});
