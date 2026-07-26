/**
 * Market structure and key level unit tests — no TradingView connection needed.
 *
 * The detection is pure (bars in, findings out), so it is tested against price
 * series built to have a known answer. That matters more here than elsewhere:
 * a swing detector that is subtly wrong still returns plausible numbers, and
 * plausible-but-wrong levels are indistinguishable from real ones once drawn.
 *
 * Run: node --test tests/structure.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBars, findSwings, alternateSwings, classifyStructure,
  roundNumberNear, countTests, findKeyLevels, labelFor,
} from '../src/core/structure.js';

/** Build bars from closes, with highs/lows a fixed fraction either side. */
function bars(closes, { spread = 0, startTime = 1_700_000_000, step = 86400, volume = 1000 } = {}) {
  return closes.map((c, i) => ({
    time: startTime + i * step,
    open: c, close: c,
    high: c + spread, low: c - spread,
    volume,
  }));
}

/** A zigzag: up to each peak, down to each trough. */
function zigzag(points, barsPerLeg = 8) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1];
    for (let j = 0; j < barsPerLeg; j++) out.push(from + ((to - from) * j) / barsPerLeg);
  }
  out.push(points[points.length - 1]);
  return out;
}

describe('normalizeBars', () => {
  it('reads array-form bars', () => {
    const out = normalizeBars([[100, 1, 2, 0.5, 1.5, 10]]);
    assert.equal(out.length, 1);
    assert.deepEqual(
      { t: out[0].time, h: out[0].high, l: out[0].low, c: out[0].close },
      { t: 100, h: 2, l: 0.5, c: 1.5 },
    );
  });

  it('reads object-form bars under either key spelling', () => {
    const long = normalizeBars([{ time: 1, open: 1, high: 3, low: 1, close: 2, volume: 5 }]);
    const short = normalizeBars([{ t: 1, o: 1, h: 3, l: 1, c: 2, v: 5 }]);
    assert.deepEqual(long, short);
  });

  it('unwraps a {bars:[...]} envelope', () => {
    assert.equal(normalizeBars({ bars: [{ t: 1, h: 2, l: 1, c: 1.5 }] }).length, 1);
  });

  it('drops bars missing a price rather than emitting NaN levels', () => {
    const out = normalizeBars([{ t: 1, h: 2, l: 1, c: 1.5 }, { t: 2, h: null, l: 1, c: 1.5 }, null]);
    assert.equal(out.length, 1);
  });

  it('sorts into chronological order', () => {
    const out = normalizeBars([{ t: 30, h: 1, l: 1, c: 1 }, { t: 10, h: 1, l: 1, c: 1 }, { t: 20, h: 1, l: 1, c: 1 }]);
    assert.deepEqual(out.map((b) => b.time), [10, 20, 30]);
  });
});

describe('findSwings', () => {
  it('finds the peak of a simple hill and nothing else', () => {
    const b = bars([1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
    const highs = findSwings(b, { lookback: 3 }).filter((s) => s.kind === 'high');
    assert.equal(highs.length, 1);
    assert.equal(highs[0].price, 6);
  });

  it('finds the trough of a simple valley', () => {
    const b = bars([6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6]);
    const lows = findSwings(b, { lookback: 3 }).filter((s) => s.kind === 'low');
    assert.equal(lows.length, 1);
    assert.equal(lows[0].price, 1);
  });

  it('does not mark every bar of a flat shelf as a swing', () => {
    // Without the strict-side requirement a plateau ties on both sides and each
    // of its bars reads as a swing — which would then cluster into a fake level.
    const b = bars([1, 2, 5, 5, 5, 5, 5, 2, 1]);
    const highs = findSwings(b, { lookback: 2 }).filter((s) => s.kind === 'high');
    assert.ok(highs.length <= 2, `flat shelf produced ${highs.length} swing highs`);
  });

  it('finds nothing when there are fewer bars than the window needs', () => {
    assert.deepEqual(findSwings(bars([1, 2, 3]), { lookback: 5 }), []);
  });

  it('a larger lookback finds fewer, more significant swings', () => {
    const b = bars(zigzag([10, 20, 12, 25, 15, 30], 6));
    const tight = findSwings(b, { lookback: 2 }).length;
    const loose = findSwings(b, { lookback: 8 }).length;
    assert.ok(loose <= tight, `lookback 8 found ${loose}, lookback 2 found ${tight}`);
  });
});

describe('alternateSwings', () => {
  it('collapses consecutive highs to the highest', () => {
    const alt = alternateSwings([
      { kind: 'high', price: 10, index: 0 },
      { kind: 'high', price: 14, index: 1 },
      { kind: 'low', price: 5, index: 2 },
    ]);
    assert.deepEqual(alt.map((s) => [s.kind, s.price]), [['high', 14], ['low', 5]]);
  });

  it('collapses consecutive lows to the lowest', () => {
    const alt = alternateSwings([
      { kind: 'low', price: 8, index: 0 },
      { kind: 'low', price: 3, index: 1 },
      { kind: 'high', price: 20, index: 2 },
    ]);
    assert.deepEqual(alt.map((s) => [s.kind, s.price]), [['low', 3], ['high', 20]]);
  });

  it('always returns a strictly alternating sequence', () => {
    const alt = alternateSwings([
      { kind: 'high', price: 10, index: 0 }, { kind: 'high', price: 11, index: 1 },
      { kind: 'low', price: 4, index: 2 }, { kind: 'low', price: 3, index: 3 },
      { kind: 'high', price: 15, index: 4 },
    ]);
    for (let i = 1; i < alt.length; i++) assert.notEqual(alt[i].kind, alt[i - 1].kind);
  });
});

describe('classifyStructure', () => {
  const seq = (pairs) => pairs.map(([kind, price], i) => ({ kind, price, index: i, time: i }));

  it('labels higher highs and higher lows, and calls it an uptrend', () => {
    const s = classifyStructure(seq([['low', 10], ['high', 20], ['low', 15], ['high', 25]]));
    assert.equal(s.trend, 'uptrend');
    assert.deepEqual(s.swings.map((x) => x.label), [null, null, 'HL', 'HH']);
  });

  it('labels lower highs and lower lows, and calls it a downtrend', () => {
    const s = classifyStructure(seq([['high', 30], ['low', 20], ['high', 25], ['low', 15]]));
    assert.equal(s.trend, 'downtrend');
    assert.deepEqual(s.swings.map((x) => x.label), [null, null, 'LH', 'LL']);
  });

  it('calls a higher high with a lower low a range, not a trend', () => {
    const s = classifyStructure(seq([['high', 20], ['low', 10], ['high', 25], ['low', 5]]));
    assert.equal(s.trend, 'range');
  });

  it('reports BOS when an established uptrend extends', () => {
    const s = classifyStructure(seq([['low', 10], ['high', 20], ['low', 15], ['high', 25], ['low', 18], ['high', 30]]));
    const bos = s.events.filter((e) => e.type === 'BOS' && e.direction === 'bullish');
    assert.ok(bos.length >= 1, 'expected a bullish BOS');
    assert.equal(bos[bos.length - 1].price, 30);
  });

  it('reports CHoCH when an uptrend breaks its low', () => {
    const s = classifyStructure(seq([
      ['low', 10], ['high', 20], ['low', 15], ['high', 25], // uptrend established
      ['low', 12],                                          // LL — character changed
    ]));
    const choch = s.events.filter((e) => e.type === 'CHoCH');
    assert.equal(choch.length, 1);
    assert.equal(choch[0].direction, 'bearish');
    assert.equal(choch[0].price, 12);
  });

  it('reports CHoCH when a downtrend breaks its high', () => {
    const s = classifyStructure(seq([
      ['high', 30], ['low', 20], ['high', 25], ['low', 15],
      ['high', 28],
    ]));
    const choch = s.events.filter((e) => e.type === 'CHoCH');
    assert.equal(choch.length, 1);
    assert.equal(choch[0].direction, 'bullish');
  });

  it('says undetermined rather than guessing from too little data', () => {
    assert.equal(classifyStructure(seq([['high', 20]])).trend, 'undetermined');
    assert.equal(classifyStructure([]).trend, 'undetermined');
  });
});

describe('roundNumberNear', () => {
  it('recognises a major round number', () => {
    assert.equal(roundNumberNear(100_050, 1).value, 100_000);
  });

  it('prefers the most significant step available', () => {
    // 100,000 and 50,000 are both multiples in range; the bigger one wins.
    assert.equal(roundNumberNear(99_900, 1).value, 100_000);
  });

  it('returns null when the price is nowhere near round', () => {
    assert.equal(roundNumberNear(63_472, 0.1), null);
  });

  it('scales with magnitude — 100 is round for a $100 stock', () => {
    assert.equal(roundNumberNear(100.2, 1).value, 100);
  });

  it('does not call every multiple of ten round for a mid-priced stock', () => {
    // Regression: with magnitude/10 as a candidate step, 570 / 550 / 340 all
    // read as "round numbers" on a $561 chart, so nearly every level collected
    // the bonus and the reason stopped distinguishing anything.
    const spurious = [566.83, 359.86, 338.06]
      .filter((p) => roundNumberNear(p, 1) !== null);
    assert.deepEqual(spurious, [], `these should not read as round: ${spurious.join(', ')}`);
  });

  it('does count half-magnitude levels, which are genuinely watched', () => {
    assert.equal(roundNumberNear(554.66, 1).value, 550);
    assert.equal(roundNumberNear(348.53, 1).value, 350);
  });

  it('still recognises genuinely round levels at the same magnitude', () => {
    assert.equal(roundNumberNear(499.5, 1).value, 500);
    assert.equal(roundNumberNear(601, 1).value, 600);
  });

  it('rejects nonsense input rather than throwing', () => {
    assert.equal(roundNumberNear(0, 1), null);
    assert.equal(roundNumberNear(-5, 1), null);
    assert.equal(roundNumberNear(NaN, 1), null);
  });
});

describe('countTests', () => {
  it('counts one visit as one test, not one per bar', () => {
    // Ten consecutive bars sitting in the band is a single test.
    const b = bars([1, 1, 1, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1]);
    const t = countTests(b, 4.9, 5.1);
    assert.equal(t.tests, 1);
    assert.equal(t.bars_in_band, 10);
  });

  it('counts separate visits separately', () => {
    const b = bars([5, 1, 1, 1, 1, 5, 1, 1, 1, 1, 5]);
    assert.equal(countTests(b, 4.9, 5.1).tests, 3);
  });

  it('does not split one visit because of a single bar poking out', () => {
    const b = bars([5, 5, 4, 5, 5]);
    assert.equal(countTests(b, 4.9, 5.1, { gap: 3 }).tests, 1);
  });

  it('accumulates volume only from bars inside the band', () => {
    const b = [
      { time: 1, high: 5, low: 5, close: 5, volume: 100 },
      { time: 2, high: 1, low: 1, close: 1, volume: 999 },
      { time: 3, high: 5, low: 5, close: 5, volume: 50 },
    ];
    assert.equal(countTests(b, 4.9, 5.1).volume_in_band, 150);
  });

  it('reports no tests when price never reaches the band', () => {
    const t = countTests(bars([1, 2, 3]), 100, 101);
    assert.deepEqual({ tests: t.tests, last: t.last_index }, { tests: 0, last: null });
  });
});

describe('findKeyLevels', () => {
  it('refuses to invent levels from too few bars', () => {
    const r = findKeyLevels(bars([1, 2, 3]), { lookback: 5 });
    assert.deepEqual(r.levels, []);
    assert.match(r.note, /not enough/i);
  });

  it('finds a level where price repeatedly turned', () => {
    // Three pushes into 110 and three bounces off 90.
    const b = bars(zigzag([90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 2 });
    assert.ok(r.levels.length >= 2, `expected at least 2 levels, got ${r.levels.length}`);
    assert.ok(r.levels.some((l) => Math.abs(l.price - 110) < 3), 'no level near 110');
    assert.ok(r.levels.some((l) => Math.abs(l.price - 90) < 3), 'no level near 90');
  });

  it('classifies levels above price as resistance and below as support', () => {
    const b = bars(zigzag([90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 2 });
    for (const l of r.levels) {
      assert.equal(l.side, l.price > r.current_price ? 'resistance' : 'support');
    }
  });

  it('gives every level a reason built from its own evidence', () => {
    const b = bars(zigzag([90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 2 });
    assert.ok(r.levels.length > 0);
    for (const l of r.levels) {
      assert.match(l.reason, /\d+ test/, `reason lacks a test count: ${l.reason}`);
      // The stated count must match the reported field — a reason that drifts
      // from its evidence is worse than no reason.
      assert.match(l.reason, new RegExp(`^${l.tests} test`));
      assert.ok(l.score > 0);
    }
  });

  it('honours min_touches', () => {
    const b = bars(zigzag([90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const strict = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 99 });
    assert.deepEqual(strict.levels, []);
  });

  it('caps output at max_levels and says so', () => {
    const b = bars(zigzag([90, 110, 92, 108, 94, 106, 96, 104, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 2, tolerance_pct: 0.5, min_touches: 1, max_levels: 2 });
    assert.ok(r.levels.length <= 2);
    if (r.truncated) assert.match(r.truncated, /max_levels/);
  });

  it('returns levels sorted high to low', () => {
    const b = bars(zigzag([90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 1 });
    for (let i = 1; i < r.levels.length; i++) {
      assert.ok(r.levels[i - 1].price >= r.levels[i].price, 'levels are not sorted high to low');
    }
  });

  it('marks a wide cluster as a zone with a high and a low', () => {
    // Turns scattered across 108-112 should read as one zone, not four lines.
    const b = bars(zigzag([90, 112, 90, 108, 90, 111, 90, 109, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 2, tolerance_pct: 3, min_touches: 2 });
    const zone = r.levels.find((l) => l.kind === 'zone');
    if (zone) {
      assert.ok(zone.zone.high > zone.zone.low, 'zone high must exceed its low');
      assert.ok(zone.price >= zone.zone.low && zone.price <= zone.zone.high, 'zone price sits outside its own bounds');
    }
  });

  it('scores a level tested more often above one tested less', () => {
    const b = bars(zigzag([90, 110, 90, 110, 90, 110, 90, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 1, max_levels: 20 });
    const byScore = [...r.levels].sort((a, b2) => b2.score - a.score);
    assert.ok(byScore[0].tests >= byScore[byScore.length - 1].tests);
  });

  it('excludes far-away levels and says how many it dropped', () => {
    // 90/110 cluster near price, plus an ancient 300 shelf that would otherwise
    // outscore everything simply by having had longer to accumulate tests.
    const b = bars(zigzag([300, 90, 300, 90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const near = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 1, max_distance_pct: 25 });
    assert.ok(near.levels.every((l) => Math.abs(l.distance_pct) <= 25), 'a level outside the range survived');
    if (near.excluded_far) assert.match(near.excluded_far, /max_distance_pct/);
  });

  it('max_distance_pct off includes everything', () => {
    const b = bars(zigzag([300, 90, 300, 90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const all = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 1, max_distance_pct: 0, max_levels: 50 });
    const near = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 1, max_distance_pct: 25, max_levels: 50 });
    assert.ok(all.levels.length >= near.levels.length);
    assert.equal(all.excluded_far, undefined);
  });

  it('never reports a level whose distance contradicts its side', () => {
    const b = bars(zigzag([90, 110, 90, 110, 90, 110, 100], 8), { spread: 0.2 });
    const r = findKeyLevels(b, { lookback: 3, tolerance_pct: 1.5, min_touches: 1 });
    for (const l of r.levels) {
      if (l.side === 'resistance') assert.ok(l.distance_pct > 0, `resistance at negative distance: ${JSON.stringify(l)}`);
      else assert.ok(l.distance_pct <= 0, `support at positive distance: ${JSON.stringify(l)}`);
    }
  });
});

describe('labelFor', () => {
  const lvl = {
    price: 554.66, tests: 4, swing_highs: 1, swing_lows: 1,
    volume_ratio: 1.5, round_number: 550,
    reason: '4 tests + flipped (1 swing high, 1 swing low) + round number 550 + 1.5x average volume + 14 bars traded within it',
  };

  it('compact stays short enough not to collide on a real chart', () => {
    const label = labelFor(lvl, 'compact');
    assert.ok(label.length < 45, `compact label is ${label.length} chars: ${label}`);
    assert.match(label, /554\.66/);
    assert.match(label, /4 tests/);
  });

  it('compact is meaningfully shorter than full', () => {
    assert.ok(labelFor(lvl, 'compact').length < labelFor(lvl, 'full').length / 2);
  });

  it('full carries the whole reason', () => {
    assert.ok(labelFor(lvl, 'full').includes(lvl.reason));
  });

  it('price gives the number alone', () => {
    assert.equal(labelFor(lvl, 'price'), '554.66');
  });

  it('defaults to compact', () => {
    assert.equal(labelFor(lvl), labelFor(lvl, 'compact'));
  });

  it('omits evidence a level does not have', () => {
    const bare = { price: 100, tests: 2, swing_highs: 0, swing_lows: 2, volume_ratio: null, round_number: null, reason: 'x' };
    const label = labelFor(bare, 'compact');
    assert.equal(label, '100 · 2 tests');
    assert.ok(!/vol|round|flipped/.test(label));
  });
});
