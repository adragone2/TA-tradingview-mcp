import { test, describe } from 'node:test';
import assert from 'node:assert';
import { findOneTwoThree, IGNITION_NOISE_BASELINE } from '../src/core/ignition.js';

/** Flat filler so the ATR is small and predictable. */
const filler = (n, px = 100) => Array.from({ length: n }, (_, i) => ({
  time: 1000 + i, open: px, high: px + 0.4, low: px - 0.4, close: px, volume: 1000,
}));

/**
 * A textbook bullish 1-2-3 appended to flat filler.
 * `restAt` places the resting bar's low as a fraction of the igniting range.
 */
function withPattern({ restAt = 0.9, triggers = true, priorRun = 0 } = {}) {
  const bars = filler(30);
  let px = 100;
  // Optional run-up before the igniting bar, to exercise the must-ignite rule.
  for (let k = 0; k < priorRun; k++) {
    px += 1;
    bars.push({ time: 2000 + k, open: px - 1, high: px + 0.3, low: px - 1.2, close: px, volume: 1000 });
  }
  // Igniting bar: opens at its low, closes at its high, range ~8 vs ATR ~0.8.
  const lo = px;
  const hi = px + 8;
  bars.push({ time: 3000, open: lo, high: hi, low: lo, close: hi, volume: 5000 });
  // Resting bar, narrow, sitting `restAt` of the way up the igniting range.
  const base = lo + restAt * 8;
  bars.push({ time: 3001, open: base + 0.3, high: base + 0.6, low: base, close: base + 0.2, volume: 1200 });
  // Trigger.
  const level = Math.max(hi, base + 0.6);
  bars.push(triggers
    ? { time: 3002, open: level - 0.2, high: level + 1.5, low: level - 0.5, close: level + 1.2, volume: 4000 }
    : { time: 3002, open: level - 1, high: level - 0.1, low: level - 2, close: level - 1.5, volume: 900 });
  return bars;
}

describe('the 1-2-3, found', () => {
  test('detects a textbook bullish case', () => {
    const hits = findOneTwoThree(withPattern());
    assert.equal(hits.length, 1);
    assert.equal(hits[0].direction, 'bullish');
    assert.equal(hits[0].pattern, 'one_two_three');
  });

  test('reports the three bar indices in order', () => {
    const [h] = findOneTwoThree(withPattern());
    assert.equal(h.rest_index, h.ignite_index + 1);
    assert.equal(h.trigger_index, h.ignite_index + 2);
  });

  test('the entry is the higher of the two highs', () => {
    const bars = withPattern();
    const [h] = findOneTwoThree(bars);
    const ignite = bars[h.ignite_index];
    const rest = bars[h.rest_index];
    assert.equal(h.entry, Math.max(ignite.high, rest.high));
  });

  test('the stop sits under the resting/trigger bars, not the igniting bar', () => {
    // The tight stop is the entire reward-to-risk claim. Putting it under the
    // igniting bar would be several ATRs away and a different setup.
    const bars = findOneTwoThree(withPattern());
    const [h] = bars;
    assert.ok(h.stop > 100, 'stop fell back to the igniting bar low');
  });
});

describe('the clauses that make it selective', () => {
  test('a resting bar BELOW the top third is rejected', () => {
    /**
     * The load-bearing clause. Measured: dropping it takes the random-walk rate
     * from 22.5% to 63%, which is the structural family rate — i.e. without it
     * the pattern carries no information at all.
     */
    assert.equal(findOneTwoThree(withPattern({ restAt: 0.9 })).length, 1);
    assert.equal(findOneTwoThree(withPattern({ restAt: 0.30 })).length, 0);
  });

  test('relaxing rest_zone_pct to 100 admits the low resting bar', () => {
    // Confirms the rejection above is the zone clause and not some other filter.
    assert.equal(findOneTwoThree(withPattern({ restAt: 0.30 }), { rest_zone_pct: 100 }).length, 1);
  });

  test('an untriggered setup is NOT reported', () => {
    // A two-bar shape with no break is a setup, not a signal.
    assert.equal(findOneTwoThree(withPattern({ triggers: false })).length, 0);
  });

  test('a bar deep inside an existing run does not ignite', () => {
    assert.equal(findOneTwoThree(withPattern({ priorRun: 0 })).length, 1);
    assert.equal(findOneTwoThree(withPattern({ priorRun: 3 })).length, 0);
  });

  test('a narrow igniting bar is rejected however good the rest of the shape is', () => {
    assert.equal(findOneTwoThree(withPattern(), { min_ignite_atr: 50 }).length, 0);
  });

  test('flat data produces nothing', () => {
    assert.deepEqual(findOneTwoThree(filler(120)), []);
  });

  test('too few bars is empty, not a throw', () => {
    assert.deepEqual(findOneTwoThree(filler(5)), []);
    assert.deepEqual(findOneTwoThree([]), []);
    assert.deepEqual(findOneTwoThree(null), []);
  });
});

describe('the noise floor, and why there is not one', () => {
  test('the status is NOT ESTABLISHED and the verdict says do not use it', () => {
    /**
     * The detector fires on 5.9% of real charts and 22.5% of random walks —
     * FOUR TIMES LESS on real data than on noise. Something below its own null
     * cannot be shown to carry information, and the cause turned out to be the
     * null rather than the market. Shipping a number here would be worse than
     * shipping none.
     */
    assert.equal(IGNITION_NOISE_BASELINE.status, 'NOT ESTABLISHED');
    assert.match(IGNITION_NOISE_BASELINE.verdict, /DO NOT USE AS A SIGNAL/);
  });

  test('no single headline rate is exposed to be quoted by mistake', () => {
    // Every estimate lives under `estimates` with its construction attached.
    for (const k of ['full_rule_pct', 'noise_floor_pct', 'pct']) {
      assert.ok(!(k in IGNITION_NOISE_BASELINE), `a bare "${k}" invites being quoted as the floor`);
    }
    assert.ok(Object.keys(IGNITION_NOISE_BASELINE.estimates).length >= 4);
    for (const [k, v] of Object.entries(IGNITION_NOISE_BASELINE.estimates)) {
      assert.equal(typeof v.pct, 'number', `${k} has no rate`);
      assert.ok(v.detail && v.detail.length > 10, `${k} does not say how it was constructed`);
    }
  });

  test('the estimates genuinely disagree — that is the finding, not a rounding issue', () => {
    const pcts = Object.values(IGNITION_NOISE_BASELINE.estimates).map((e) => e.pct);
    assert.ok(Math.max(...pcts) / Math.min(...pcts) > 3,
      'if the nulls agreed, the floor WOULD be established and the verdict should change');
  });

  test('the ATR-gate explanation is recorded, not just the disagreement', () => {
    assert.match(IGNITION_NOISE_BASELINE.why_not_established, /ATR/);
    assert.match(IGNITION_NOISE_BASELINE.why_not_established, /gap/);
  });

  test('the one relative result that DOES survive is kept separate', () => {
    // Both arms ran under the same generator, so its defects cancel.
    assert.match(IGNITION_NOISE_BASELINE.established_relative_finding, /top-third clause is load-bearing/);
    assert.match(IGNITION_NOISE_BASELINE.established_relative_finding, /22\.5% to 63\.0%/);
  });

  test('it says what would be needed to establish the floor', () => {
    assert.match(IGNITION_NOISE_BASELINE.to_establish, /block bootstrap/);
  });
});

describe('the detector stays unexposed while unmeasured', () => {
  test('it is not registered as an MCP tool', async () => {
    /**
     * CLAUDE.md: every detector carries its noise floor. This one cannot yet,
     * so nothing may consume it. If someone wires it up, this fails first.
     */
    const { readdirSync, readFileSync } = await import('node:fs');
    // Import path and exported API names, NOT the bare word — gap_classify's
    // tool description legitimately cites "the ignition.js bar" as the
    // registration precedent, and a prose mention is not consumption.
    const hits = readdirSync('src/tools')
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /core\/ignition\.js|one_two_three|oneTwoThree/.test(readFileSync(`src/tools/${f}`, 'utf8')));
    assert.deepEqual(hits, [],
      `ignition.js is consumed by ${hits.join(', ')} but its noise floor is NOT ESTABLISHED`);
  });
});
