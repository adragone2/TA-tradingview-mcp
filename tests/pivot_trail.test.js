import { test, describe } from 'node:test';
import assert from 'node:assert';
import { pivotTrail } from '../src/core/stops.js';
import { normalizeBars, findSwings, alternateSwings, classifyStructure } from '../src/core/structure.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

/**
 * Shannon's Figure 16.4 numbered exactly as he does: odd numbers are new highs,
 * even numbers the higher lows between them. "As the stock clears point 5, the
 * stop is raised from point 4 to point 6."
 */
const sw = (kind, price, time) => ({ kind, price, time });
const FIG_16_4 = [
  sw('low', 96.0, 1),   // (before point 1)
  sw('high', 97.0, 2),  // 1
  sw('low', 95.5, 3),   // 2
  sw('high', 97.6, 4),  // 3
  sw('low', 96.5, 5),   // 4
  sw('high', 99.5, 6),  // 5  -> promotes stop to point 4 (96.5)
  sw('low', 97.6, 7),   // 6
  sw('high', 100.5, 8), // 7  -> promotes stop to point 6 (97.6)
  sw('low', 98.2, 9),   // 8
];

describe('pivotTrail — Shannon Figure 16.4, the long side', () => {
  test('a new higher high promotes the stop to the most recent higher low', () => {
    const r = pivotTrail(FIG_16_4, { direction: 'long' });
    assert.equal(r.available, true);
    // The last confirmed promotion: high 100.5 confirmed the 97.6 low held.
    assert.equal(r.stop, 97.6);
    assert.equal(r.steps.at(-1).from_pivot.price, 97.6);
    assert.equal(r.steps.at(-1).trigger.price, 100.5);
  });

  test('reproduces his worked step: clearing point 5 moves the stop from point 4 to point 6', () => {
    const r = pivotTrail(FIG_16_4, { direction: 'long' });
    const atPoint5 = r.steps.find((s) => s.trigger.price === 99.5);
    assert.ok(atPoint5, 'no step triggered by the point-5 high');
    assert.equal(atPoint5.from_pivot.price, 96.5); // point 4
    assert.equal(atPoint5.stop_moved_to, 96.5);
  });

  test('the trigger is a new EXTREME, not the pullback itself', () => {
    /**
     * The distinction that separates this from a distance rule. The stop moves
     * only once a higher high CONFIRMS the prior higher low held — so the count
     * of steps equals the count of confirming highs, not of lows.
     */
    const r = pivotTrail(FIG_16_4, { direction: 'long' });
    for (const s of r.steps) assert.equal(s.trigger.kind, 'high');
    for (const s of r.steps) assert.equal(s.from_pivot.kind, 'low');
  });

  test('the stop only ever rises', () => {
    const r = pivotTrail(FIG_16_4, { direction: 'long' });
    const stops = r.steps.map((s) => s.stop_moved_to);
    for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i] > stops[i - 1]);
  });

  test('the most recent pullback is PENDING until a new high confirms it', () => {
    // Point 8 (98.2) is above the current stop but unconfirmed. Promoting it
    // early would place the stop above a low the market has not yet defended.
    const r = pivotTrail(FIG_16_4, { direction: 'long' });
    assert.equal(r.anchor_pivot.price, 98.2);
    assert.equal(r.pending_promotion.to, 98.2);
    assert.match(r.pending_promotion.waiting_for, /higher high/);
    assert.ok(r.stop < 98.2);
  });
});

describe('pivotTrail — the ratchet', () => {
  test('REFUSES a step that would loosen the stop, and counts it', () => {
    /**
     * Shannon: "the only time stops should be changed on short trades is when
     * the market moves in your favor." A trail that can loosen is the failure
     * mode this rule replaces, so a refusal is a feature and must be visible.
     */
    const withShallowPullback = [
      sw('low', 96.0, 1),
      sw('high', 100.0, 2),
      sw('low', 98.0, 3),
      sw('high', 101.0, 4),   // promotes to 98.0
      sw('low', 97.0, 5),     // a LOWER low — would loosen
      sw('high', 102.0, 6),   // new high, but the anchor is worse than the stop
    ];
    const r = pivotTrail(withShallowPullback, { direction: 'long' });
    assert.equal(r.stop, 98.0);
    assert.equal(r.ratchet_refusals, 1);
    assert.match(r.ratchet_note, /LOOSENED/);
  });

  test('flags the trend as invalidated when a lower low breaks the series', () => {
    const broken = [
      sw('low', 96.0, 1), sw('high', 100.0, 2), sw('low', 98.0, 3),
      sw('high', 101.0, 4), sw('low', 95.0, 5),
    ];
    const r = pivotTrail(broken, { direction: 'long' });
    assert.ok(r.trend_invalidated);
    assert.equal(r.trend_invalidated.at.price, 95.0);
    assert.match(r.trend_invalidated.reason, /LOWER LOW/);
  });

  test('an initial stop is respected and never loosened by the trail', () => {
    const r = pivotTrail(FIG_16_4, { direction: 'long', initial_stop: 99.0 });
    // Every pivot anchor is below 99, so no step may fire.
    assert.equal(r.stop, 99.0);
    assert.equal(r.steps_taken, 0);
    assert.ok(r.ratchet_refusals > 0);
  });
});

describe('pivotTrail — the short side mirrors it', () => {
  const FIG_16_5 = [
    sw('high', 80.0, 1),
    sw('low', 77.0, 2),   // 1
    sw('high', 78.0, 3),  // 2
    sw('low', 74.0, 4),   // 3
    sw('high', 76.0, 5),  // 4
    sw('low', 71.0, 6),   // 5
    sw('high', 72.5, 7),  // 6
  ];

  test('a new lower low promotes the stop to the most recent lower high', () => {
    const r = pivotTrail(FIG_16_5, { direction: 'short' });
    assert.equal(r.direction, 'short');
    assert.equal(r.stop, 76.0);
    assert.equal(r.steps.at(-1).trigger.kind, 'low');
    assert.equal(r.steps.at(-1).from_pivot.kind, 'high');
  });

  test('the stop only ever falls', () => {
    const r = pivotTrail(FIG_16_5, { direction: 'short' });
    const stops = r.steps.map((s) => s.stop_moved_to);
    for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i] < stops[i - 1]);
  });

  test('a higher high invalidates a downtrend trail', () => {
    const r = pivotTrail([...FIG_16_5, sw('low', 70.0, 8), sw('high', 79.0, 9)], { direction: 'short' });
    assert.ok(r.trend_invalidated);
    assert.match(r.trend_invalidated.reason, /HIGHER HIGH/);
  });
});

describe('pivotTrail — buffer, honesty and edges', () => {
  test('a buffer places the stop just BELOW the low for a long, ABOVE for a short', () => {
    // A stop sitting exactly on the pivot is hit by a tick that merely equals it.
    const long = pivotTrail(FIG_16_4, { direction: 'long', buffer_pct: 1 });
    assert.ok(long.stop < 97.6 && long.stop > 96.5);
    const short = pivotTrail(
      [sw('high', 80, 1), sw('low', 77, 2), sw('high', 78, 3), sw('low', 74, 4)],
      { direction: 'short', buffer_pct: 1 },
    );
    assert.ok(short.stop > 78);
  });

  test('too few swings is unavailable, and says why', () => {
    const r = pivotTrail([sw('low', 96, 1), sw('high', 100, 2)]);
    assert.equal(r.available, false);
    assert.match(r.note, /at least 3/);
    assert.equal(pivotTrail(null).available, false);
  });

  test('no confirming extreme means the stop never moves, and it says to hold the initial one', () => {
    // Highs failing to extend: nothing confirms the pullback, so no promotion.
    const r = pivotTrail([sw('high', 100, 1), sw('low', 98, 2), sw('high', 99, 3), sw('low', 97, 4)], { direction: 'long' });
    assert.equal(r.available, false);
    assert.match(r.note, /most recent higher low/);
  });

  test('every result carries the persistence caveat and its source', () => {
    /**
     * A trail is a bet on persistence, and 9 of 12 real holdings measured here
     * had none. The caveat travelling with the number is the point.
     */
    const r = pivotTrail(FIG_16_4);
    assert.match(r.persistence_caveat, /Kaminski & Lo/);
    assert.match(r.persistence_caveat, /stoppingPremium/);
    assert.match(r.persistence_caveat, /definitional, not empirical/);
    assert.match(r.source, /Figures 16\.4 and 16\.5/);
  });
});

describe('pivotTrail — against real pivot machinery', () => {
  test('runs end to end on structure.js output without special-casing', () => {
    // The fixtures above are hand-built. This proves the real pipeline shape
    // (findSwings -> alternateSwings -> classifyStructure) feeds it unchanged.
    const bars = barsFromPath(randomWalk({ n: 400, drift: 0.0012, vol: 0.012, seed: 7 }));
    const norm = normalizeBars(bars);
    const alt = alternateSwings(findSwings(norm, { lookback: 5 }));
    const labelled = classifyStructure(alt).swings;
    const r = pivotTrail(labelled, { direction: 'long' });
    assert.equal(typeof r.available, 'boolean');
    if (r.available) {
      // Labels survive onto the trigger, so a step can be read as HH/HL.
      assert.ok(r.steps.every((s) => 'label' in s.trigger));
      // The invariant that must hold on any input: monotone stops.
      const stops = r.steps.map((s) => s.stop_moved_to);
      for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i] > stops[i - 1]);
    }
  });

  test('the monotone invariant holds across many random series, both directions', () => {
    // The one property that must never break, whatever the structure looks like.
    for (let seed = 1; seed <= 25; seed += 1) {
      const norm = normalizeBars(barsFromPath(randomWalk({ n: 300, vol: 0.015, seed })));
      const alt = alternateSwings(findSwings(norm, { lookback: 4 }));
      for (const direction of ['long', 'short']) {
        const r = pivotTrail(alt, { direction });
        if (!r.available) continue;
        const stops = r.steps.map((s) => s.stop_moved_to);
        for (let i = 1; i < stops.length; i += 1) {
          const ok = direction === 'long' ? stops[i] > stops[i - 1] : stops[i] < stops[i - 1];
          assert.ok(ok, `seed ${seed} ${direction}: stop moved the wrong way (${stops[i - 1]} -> ${stops[i]})`);
        }
      }
    }
  });
});
