import { test, describe } from 'node:test';
import assert from 'node:assert';
import { detectVCP, VCP_DEFAULTS, VCP_NOISE_BASELINE } from '../src/core/vcp.js';
import { legs, barsFromPath, randomWalk } from '../src/core/synthetic.js';

/**
 * Build a VCP by construction: an advance, then pullbacks of the given depths,
 * each recovering to just under the prior high. Volume optionally dries up.
 */
function makeVCP({ depths = [18, 12, 6], advance = 40, per = 8, dryup = true } = {}) {
  const start = 100;
  const top = start * (1 + advance / 100);
  const points = [start, top];
  let high = top;
  for (const d of depths) {
    const low = high * (1 - d / 100);
    points.push(low, high * 0.995);
    high = high * 0.995;
  }
  const path = legs(points, per);
  const bars = barsFromPath(path, { noise: 0.002, seed: 11 });
  // Volume: high through the advance, tapering across the contractions.
  const advanceBars = per * 1;
  return bars.map((b, i) => {
    if (i < advanceBars) return { ...b, volume: 2_000_000 };
    const frac = (i - advanceBars) / Math.max(1, bars.length - advanceBars);
    return { ...b, volume: Math.round(dryup ? 2_000_000 * (1 - 0.6 * frac) : 2_000_000) };
  });
}

describe('detectVCP — the canonical shape', () => {
  test('accepts a constructed 18/12/6 contraction on drying volume', () => {
    const out = detectVCP(makeVCP());
    assert.ok(out.qualifies, `failed: ${JSON.stringify(out.failed_checks)} depths=${JSON.stringify(out.depths_pct)}`);
    assert.ok(out.contraction_count >= 3);
  });

  test('reports the depths in order, each tighter than the last', () => {
    const out = detectVCP(makeVCP());
    const d = out.depths_pct;
    for (let i = 1; i < d.length; i++) {
      assert.ok(d[i] <= d[i - 1] * VCP_DEFAULTS.tightening_ratio, `${d[i]} not tighter than ${d[i - 1]}`);
    }
  });

  test('the pivot is the high of the final contraction', () => {
    const out = detectVCP(makeVCP());
    assert.strictEqual(out.pivot, out.contractions[out.contractions.length - 1].high);
  });
});

describe('detectVCP — what it refuses', () => {
  test('rejects contractions that WIDEN', () => {
    const out = detectVCP(makeVCP({ depths: [6, 12, 18] }));
    assert.ok(!out.qualifies);
  });

  test('rejects a final contraction that is still loose', () => {
    const out = detectVCP(makeVCP({ depths: [40, 30, 22] }));
    assert.ok(!out.qualifies);
    assert.ok((out.failed_checks || []).includes('final_contraction_tight')
      || (out.failed_checks || []).includes('first_pullback_in_range'),
      `expected a tightness failure, got ${JSON.stringify(out.failed_checks)}`);
  });

  test('rejects a base with no prior advance', () => {
    const out = detectVCP(makeVCP({ advance: 2 }));
    assert.ok(!out.qualifies);
    assert.ok((out.failed_checks || []).includes('prior_advance'));
  });

  test('rejects too few contractions', () => {
    const out = detectVCP(makeVCP({ depths: [18, 9] }));
    assert.ok(!out.qualifies);
    assert.ok((out.failed_checks || []).includes('enough_contractions'));
  });

  test('missing volume is NOT treated as a pass', () => {
    const noVol = makeVCP().map((b) => ({ ...b, volume: 0 }));
    const out = detectVCP(noVol, { require_volume_dryup: true });
    assert.strictEqual(out.checks.volume_dryup.pass, false);
    assert.match(out.checks.volume_dryup.note, /NOT a pass/);
  });

  test('flat volume fails the dry-up clause', () => {
    const out = detectVCP(makeVCP({ dryup: false }));
    assert.strictEqual(out.checks.volume_dryup.pass, false);
  });

  test('short input is reported, not crashed on', () => {
    const out = detectVCP([{ high: 1, low: 1, close: 1, open: 1, time: 0, volume: 1 }]);
    assert.strictEqual(out.qualifies, false);
    assert.strictEqual(out.reason, 'insufficient_bars');
  });
});

describe('detectVCP — noise behaviour', () => {
  test('is rare on random walks', () => {
    let hits = 0;
    const WALKS = 40;
    for (let w = 0; w < WALKS; w++) {
      const b = barsFromPath(randomWalk({ n: 200, seed: 700 + w }), { noise: 0.008, seed: 800 + w })
        .map((x) => ({ ...x, volume: 1_000_000 + (w * 7919 % 500_000) }));
      if (detectVCP(b).qualifies) hits++;
    }
    assert.ok(hits / WALKS <= 0.15,
      `VCP fired on ${hits}/${WALKS} random walks — too permissive to be worth reporting`);
  });
});

describe('detectVCP — honesty of the output', () => {
  test('every check is reported with its value and requirement, pass or fail', () => {
    const out = detectVCP(makeVCP({ depths: [6, 12, 18] }));
    for (const [name, c] of Object.entries(out.checks)) {
      assert.ok(typeof c.pass === 'boolean', `${name} has no pass flag`);
      assert.ok('value' in c && 'required' in c, `${name} does not show its value and requirement`);
    }
  });

  test('says plainly that a VCP forecasts nothing', () => {
    const out = detectVCP(makeVCP());
    assert.match(out.what_it_is_not, /SETUP, not a direction/);
    assert.match(out.what_it_is_not, /46% of the time/);
  });

  test('does not present the track record as verified', () => {
    const out = detectVCP(makeVCP());
    assert.match(out.provenance, /cannot verify/);
  });
});

describe('VCP_NOISE_BASELINE', () => {
  test('records the measured zero-detection result and its caveat', () => {
    assert.strictEqual(VCP_NOISE_BASELINE.detections, 0);
    assert.strictEqual(VCP_NOISE_BASELINE.walks, 200);
    assert.match(VCP_NOISE_BASELINE.caveat, /Selectivity is not accuracy/);
  });

  test('keeps the comparison to the looser detectors alongside', () => {
    // P2.7/P2.8 review (2026-07-30): figures moved with the measurements —
    // 68% was a 40-walk harness (64.5% unified), and 43.4% predated the
    // kernel ordering fix (37.9% after).
    assert.match(VCP_NOISE_BASELINE.for_comparison.structural_patterns_any, /64\.5%/);
    assert.match(VCP_NOISE_BASELINE.for_comparison.lmw_definitions, /37\.9%/);
  });
});
