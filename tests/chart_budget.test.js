import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  PERMANENT_STUDIES, MAX_STUDIES, isPermanent, budget, planIndicators,
} from '../src/core/chart_budget.js';

const st = (...names) => names.map((n, i) => ({ name: n, id: `id${i}` }));
const want = (...labels) => labels.map((l) => ({ study: l, label: l }));

describe('the chart budget', () => {
  test('Volume and Moving Average Ribbon are permanent', () => {
    // The owner keeps a deliberately sparse chart. These two are always on it.
    assert.deepEqual(PERMANENT_STUDIES, ['Volume', 'Moving Average Ribbon']);
    assert.equal(MAX_STUDIES, 5);
    assert.equal(isPermanent('Volume'), true);
    assert.equal(isPermanent('moving average ribbon'), true, 'matching must be case-insensitive');
    assert.equal(isPermanent('Moving Average'), false, 'a plain MA is NOT the Ribbon');
  });

  test('permanents are never listed as removable', () => {
    const b = budget(st('Volume', 'Moving Average Ribbon', 'MACD'));
    assert.deepEqual(b.permanent_present, ['Volume', 'Moving Average Ribbon']);
    assert.deepEqual(b.removable, ['MACD']);
  });

  test('counts free slots against the cap, permanents included', () => {
    assert.equal(budget(st('Volume', 'Moving Average Ribbon')).slots_free, 3);
    assert.equal(budget(st('Volume', 'Moving Average Ribbon', 'A', 'B', 'C')).slots_free, 0);
    assert.equal(budget([]).slots_free, 5);
  });

  test('slots_if_cleared frees only the non-permanent studies', () => {
    const b = budget(st('Volume', 'Moving Average Ribbon', 'A', 'B', 'C'));
    assert.equal(b.slots_free, 0);
    assert.equal(b.slots_if_cleared, 3, 'clearing must leave the two permanents in place');
  });

  test('WARNS when a permanent study is missing rather than using the slot', () => {
    const b = budget(st('Moving Average Ribbon', 'MACD'));
    assert.deepEqual(b.missing_permanent, ['Volume']);
    assert.match(b.warning, /should always be on this chart/);
    assert.match(b.warning, /rather than using the free slot/);
  });
});

describe('planIndicators', () => {
  const chart = st('Volume', 'Moving Average Ribbon', 'MACD', 'Auto Anchored Volume Profile');

  test('adds only what fits, and NAMES what it dropped', () => {
    /**
     * The load-bearing case. This repo's rule is that a silent cap reads as
     * "covered everything" when it did not, so the dropped ones are named in
     * priority order rather than quietly skipped.
     */
    const p = planIndicators(want('Moving Average', 'Average True Range', 'Bollinger Bands'), chart);
    assert.equal(p.budget.slots_free, 1);
    assert.equal(p.will_add.length, 1);
    assert.equal(p.dropped.length, 2);
    assert.match(p.dropped_note, /did NOT fit the 5-study cap/);
    assert.match(p.dropped_note, /named rather than silently skipped/);
  });

  test('priority is the catalogue order, because that is the order the rules reference them', () => {
    const p = planIndicators(want('FIRST', 'SECOND', 'THIRD'), chart);
    assert.equal(p.will_add[0].study, 'FIRST');
    assert.deepEqual(p.dropped.map((d) => d.study), ['SECOND', 'THIRD']);
  });

  test('a study already on the chart is neither added nor counted against the budget', () => {
    // Volume is permanent and present; momentum_pullback names it anyway.
    const p = planIndicators(want('Volume', 'Moving Average', 'Average True Range'), chart);
    assert.deepEqual(p.already_on_chart.map((x) => x.study), ['Volume']);
    assert.equal(p.will_add.length, 1, 'the free slot goes to a NEW study, not a duplicate');
    assert.ok(!p.will_add.some((x) => x.study === 'Volume'));
  });

  test('clear_added frees the non-permanent slots and NEVER the permanents', () => {
    const p = planIndicators(want('A', 'B', 'C'), chart, { clear_added: true });
    assert.equal(p.will_add.length, 3);
    assert.deepEqual(p.will_remove.map((r) => r.name), ['MACD', 'Auto Anchored Volume Profile']);
    for (const r of p.will_remove) assert.equal(isPermanent(r.name), false);
  });

  test('refuses with a reason when the chart is full and nothing is removable', () => {
    const full = st('Volume', 'Moving Average Ribbon', 'Volume', 'Moving Average Ribbon', 'Volume');
    const p = planIndicators(want('A'), full);
    assert.equal(p.will_add.length, 0);
    assert.match(p.no_room, /at the 5-study cap/);
    assert.match(p.no_room, /permanent and will not be removed/);
  });

  test('an external indicator is passed through as a candidate, not silently dropped', () => {
    // Some catalogue entries name a non-TradingView input, e.g. a volatility index.
    const p = planIndicators(
      [{ study: null, label: 'Volatility Index (external)', external: true }],
      st('Volume', 'Moving Average Ribbon'),
    );
    assert.equal(p.will_add.length, 1);
    assert.equal(p.will_add[0].external, true);
  });

  test('an empty want list is a no-op, not an error', () => {
    const p = planIndicators([], chart);
    assert.equal(p.will_add.length, 0);
    assert.equal(p.dropped.length, 0);
    assert.equal(p.dropped_note, undefined);
  });
});
