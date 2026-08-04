import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vcpDrawPlan } from '../src/core/vcp.js';
import { isMcpText } from '../src/core/orphans.js';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Bars where index and time are trivially related, so mapping errors show. */
const bars = Array.from({ length: 50 }, (_, i) => ({
  time: 1_700_000_000 + i * 86400, open: 10, high: 11, low: 9, close: 10, volume: 1000,
}));

const QUALIFYING = {
  vcp_qualifies: true,
  pivot: 10.8,
  contraction_geometry: [
    { high_index: 10, low_index: 14, high: 12.0, low: 9.6, depth_pct: 20.0 },
    { high_index: 20, low_index: 23, high: 11.5, low: 10.2, depth_pct: 11.3 },
    { high_index: 30, low_index: 32, high: 11.2, low: 10.75, depth_pct: 4.02 },
  ],
};

describe('vcpDrawPlan — the drawing layer that replaced the community indicator (2026-08-03)', () => {
  test('one labelled trend_line per contraction, high to low, indices mapped to bar times', () => {
    const plan = vcpDrawPlan(QUALIFYING, { bars });
    assert.equal(plan.shapes.length, 3);
    const first = plan.shapes[0];
    assert.equal(first.shape, 'trend_line');
    assert.equal(first.point.time, bars[10].time);
    assert.equal(first.point.price, 12.0);
    assert.equal(first.point2.time, bars[14].time);
    assert.equal(first.point2.price, 9.6);
    assert.equal(first.text, 'VCP c1 20%');
    assert.equal(plan.shapes[2].text, 'VCP c3 4.02%');
  });

  test('every planned label matches a registered signature — an unsigned label is a permanent orphan', () => {
    for (const s of vcpDrawPlan(QUALIFYING, { bars }).shapes) {
      assert.ok(isMcpText(s.text), `"${s.text}" matches no signature in orphans.js`);
    }
  });

  test('no qualification, no shapes — and the why says so', () => {
    const plan = vcpDrawPlan({ vcp_qualifies: false }, { bars });
    assert.deepEqual(plan.shapes, []);
    assert.match(plan.why, /no qualifying VCP/);
  });

  test('qualifying but geometry not threaded is a NAMED gap, not a crash or a silent nothing', () => {
    const plan = vcpDrawPlan({ vcp_qualifies: true, pivot: 10 }, { bars });
    assert.deepEqual(plan.shapes, []);
    assert.match(plan.why, /contraction_geometry/);
  });

  test('an index outside the loaded window drops that leg rather than inventing a time', () => {
    const plan = vcpDrawPlan({
      vcp_qualifies: true,
      contraction_geometry: [
        { high_index: 10, low_index: 14, high: 12, low: 9.6, depth_pct: 20 },
        { high_index: 200, low_index: 205, high: 11, low: 10, depth_pct: 9 },
      ],
    }, { bars });
    assert.equal(plan.shapes.length, 1);
  });
});

describe('the wiring — geometry threaded, drawer gated on qualification', () => {
  test('assessment.js carries contraction_geometry in the block', () => {
    assert.match(src('src/core/assessment.js'), /contraction_geometry: v\.contractions \?\? null/);
  });

  test('assessment_draw plans under the SAME gate as the pivot line, through put/drawShape', () => {
    const d = src('src/core/assessment_draw.js');
    const block = d.slice(d.indexOf("if (a.volatility_contraction.vcp_qualifies && a.volatility_contraction.pivot)"));
    assert.match(block.slice(0, 1600), /vcpDrawPlan\(a\.volatility_contraction, \{ bars \}\)/);
    assert.match(block.slice(0, 1600), /drawn\.vcp/);
  });
});
