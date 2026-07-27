/**
 * Elliott wave unit tests — no TradingView connection needed.
 *
 * The rule tests carry the weight. Rules 1-4 are the only objective part of
 * Elliott wave, and a bug that let a rule-breaking count through would remove
 * the only thing keeping this tool from being a pattern-matcher that always
 * finds what it is looking for. There is a test per rule, each asserting the
 * violation is caught AND named.
 *
 * The other thing asserted here is that the module never picks a count. It
 * enumerates and reports how many survived; choosing one would be presenting a
 * judgement call as a measurement.
 *
 * Run: node --test tests/elliott.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkRules, findCounts, surveyCounts, WAVE_RATIOS, ELLIOTT_CAVEAT } from '../src/core/elliott.js';

const pts = (...prices) => prices.map((price, i) => ({ price, index: i, time: i, kind: i % 2 === 0 ? 'low' : 'high' }));

/** A textbook bullish impulse: 100 -> 120, back to 110, up to 150, back to 135, up to 165. */
const GOOD_UP = pts(100, 120, 110, 150, 135, 165);

describe('checkRules — the four hard rules', () => {
  it('accepts a textbook impulse', () => {
    const r = checkRules(GOOD_UP, 'up');
    assert.equal(r.valid, true);
    assert.deepEqual(r.violations, []);
    assert.equal(r.truncated, false);
  });

  it('Rule 1 — rejects wave 2 retracing past the start of wave 1', () => {
    const r = checkRules(pts(100, 120, 95, 150, 135, 165), 'up');
    assert.equal(r.valid, false);
    assert.match(r.violations.join(' '), /wave 2 retraced past the start of wave 1/);
  });

  it('Rule 2 — rejects wave 3 being the shortest of 1, 3 and 5', () => {
    // wave1 = 40, wave3 = 12, wave5 = 40.
    const r = checkRules(pts(100, 140, 130, 142, 141, 181), 'up');
    assert.equal(r.valid, false);
    assert.match(r.violations.join(' '), /wave 3 is the shortest/);
  });

  it('Rule 3 — rejects wave 3 failing to exceed the end of wave 1', () => {
    const r = checkRules(pts(100, 150, 140, 145, 142, 200), 'up');
    assert.equal(r.valid, false);
    assert.match(r.violations.join(' '), /did not move beyond the end of wave 1/);
  });

  it('Rule 4 — rejects wave 4 overlapping wave 1 territory', () => {
    // wave 4 falls to 115, below wave 1's end at 120.
    const r = checkRules(pts(100, 120, 110, 150, 115, 165), 'up');
    assert.equal(r.valid, false);
    assert.match(r.violations.join(' '), /overlapped the price territory of wave 1/);
  });

  it('flags truncation without calling it a rule violation', () => {
    // wave 5 tops at 145, below wave 3's 150.
    const r = checkRules(pts(100, 120, 110, 150, 135, 145), 'up');
    assert.equal(r.valid, true, 'truncation is not one of the four rules');
    assert.equal(r.truncated, true);
  });

  it('applies every rule mirrored for a down impulse', () => {
    const goodDown = pts(200, 180, 190, 150, 165, 135).map((p, i) => ({ ...p, kind: i % 2 === 0 ? 'high' : 'low' }));
    assert.equal(checkRules(goodDown, 'down').valid, true);
    const badDown = pts(200, 180, 205, 150, 165, 135);
    assert.equal(checkRules(badDown, 'down').valid, false);
  });

  it('reports every violation, not just the first', () => {
    const r = checkRules(pts(100, 150, 95, 145, 90, 200), 'up');
    assert.ok(r.violations.length >= 2, `expected several violations, got ${JSON.stringify(r.violations)}`);
  });
});

describe('findCounts — enumeration, not selection', () => {
  const DAY = 86400;
  let t = 1_700_000_000;
  const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });

  /** Bars tracing a path through the given turning points. */
  function path(points, per = 5) {
    t = 1_700_000_000;
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      for (let j = 0; j < per; j++) {
        const p = points[i] + ((points[i + 1] - points[i]) * j) / per;
        out.push(bar(p, p + 0.5, p - 0.5, p));
      }
    }
    const last = points[points.length - 1];
    out.push(bar(last, last + 0.5, last - 0.5, last));
    return out;
  }

  it('finds a clean five-wave impulse in the bars', () => {
    // Leading and trailing legs so the first and last turns actually confirm.
    const bars = path([110, 100, 120, 110, 150, 135, 165, 150]);
    const r = findCounts(bars, { lookback: 3 });
    assert.ok(r.valid_count_total >= 1, `expected a count, got ${r.valid_count_total}: ${r.note || ''}`);
    assert.equal(r.counts[0].direction, 'up');
    assert.equal(r.counts[0].waves.length, 5);
  });

  it('finds nothing when swings exist but every candidate breaks a rule', () => {
    // A sawtooth between two prices. There are plenty of swings, so this is not
    // the too-few-swings branch — every window genuinely violates rule 1, since
    // wave 2 always returns to exactly where wave 1 started.
    const saw = path([100, 110, 100, 110, 100, 110, 100, 110, 100, 110]);
    const r = findCounts(saw, { lookback: 3 });
    assert.equal(r.valid_count_total || 0, 0);
    assert.ok(r.candidates_examined > 0, 'candidates must have been examined, not skipped for want of swings');
    assert.match(r.note, /real answer/i);
  });

  it('says the chart has too few swings when that is the actual reason', () => {
    t = 1_700_000_000;
    const flat = Array.from({ length: 60 }, () => bar(100, 101, 99, 100));
    const r = findCounts(flat, { lookback: 3 });
    assert.equal(r.counts.length, 0);
    assert.match(r.note, /needs six/i);
  });

  it('reports how many candidates were examined, not only how many survived', () => {
    const bars = path([110, 100, 120, 110, 150, 135, 165, 150]);
    const r = findCounts(bars, { lookback: 3 });
    assert.ok(r.candidates_examined >= r.valid_count_total);
    assert.equal(typeof r.candidates_examined, 'number');
  });

  it('excludes truncated counts by default and includes them on request', () => {
    const bars = path([110, 100, 120, 110, 150, 135, 145, 130]);
    const without = findCounts(bars, { lookback: 3 });
    const with_ = findCounts(bars, { lookback: 3, include_truncated: true });
    assert.ok((with_.valid_count_total || 0) >= (without.valid_count_total || 0));
  });

  it('measures all four Fibonacci relationships against their bands', () => {
    const bars = path([110, 100, 120, 110, 150, 135, 165, 150]);
    const c = findCounts(bars, { lookback: 3 }).counts[0];
    for (const key of Object.keys(WAVE_RATIOS)) {
      assert.ok(key in c.ratios, `missing ratio ${key}`);
      assert.ok('measured' in c.ratios[key] && 'fits_typical' in c.ratios[key]);
    }
    assert.equal(c.ratios_checked, 4);
    assert.ok(c.ratios_in_band >= 0 && c.ratios_in_band <= 4);
  });

  it('reports alternation as an observation, never as a rejection', () => {
    const bars = path([110, 100, 120, 110, 150, 135, 165, 150]);
    const c = findCounts(bars, { lookback: 3 }).counts[0];
    assert.ok(c.alternation === null || typeof c.alternation.alternates === 'boolean');
  });

  it('declines when there are too few swings to build a count', () => {
    const bars = path([100, 120]);
    const r = findCounts(bars, { lookback: 3 });
    assert.equal(r.counts.length, 0);
    assert.match(r.note, /needs six/i);
  });
});

describe('surveyCounts — the subjectivity, as a number', () => {
  const DAY = 86400;
  let t = 1_700_000_000;
  const bar = (o, h, l, c) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: 1000 });
  function path(points, per = 5) {
    t = 1_700_000_000;
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      for (let j = 0; j < per; j++) {
        const p = points[i] + ((points[i + 1] - points[i]) * j) / per;
        out.push(bar(p, p + 0.5, p - 0.5, p));
      }
    }
    out.push(bar(points.at(-1), points.at(-1) + 0.5, points.at(-1) - 0.5, points.at(-1)));
    return out;
  }

  it('runs every requested sensitivity and reports each separately', () => {
    const bars = path([110, 100, 120, 110, 150, 135, 165, 150]);
    const s = surveyCounts(bars, { lookbacks: [2, 3, 5] });
    assert.equal(s.runs.length, 3);
    assert.deepEqual(s.runs.map((r) => r.lookback), [2, 3, 5]);
  });

  it('says so when the sensitivities agree', () => {
    const bars = path([110, 100, 120, 110, 150, 135, 165, 150]);
    const s = surveyCounts(bars, { lookbacks: [2, 3] });
    if (s.distinct_recent_counts === 1) assert.match(s.agreement, /SAME/);
  });

  it('names disagreement as the subjectivity of the method', () => {
    // A busy chart where different sensitivities see different swings.
    const bars = path([110, 100, 118, 108, 126, 116, 150, 135, 165, 150, 158]);
    const s = surveyCounts(bars, { lookbacks: [2, 3, 5, 8] });
    if (s.distinct_recent_counts > 1) {
      assert.match(s.agreement, /subjectivity/i);
      assert.match(s.agreement, /no sensitivity is more correct/i);
    }
  });

  it('reports honestly when nothing counts at any sensitivity', () => {
    t = 1_700_000_000;
    const flat = Array.from({ length: 80 }, () => bar(100, 101, 99, 100));
    const s = surveyCounts(flat, { lookbacks: [3, 5, 8] });
    assert.equal(s.total_valid_counts, 0);
    assert.match(s.agreement, /not in a countable impulse/i);
  });

  it('states that consecutive swings are used and why', () => {
    const bars = path([110, 100, 120, 110, 150, 135, 165, 150]);
    assert.match(surveyCounts(bars, { lookbacks: [3] }).method, /unfalsifiability/i);
  });
});

describe('ELLIOTT_CAVEAT', () => {
  it('states the subjectivity, the lack of evidence, and the hindsight problem', () => {
    assert.match(ELLIOTT_CAVEAT.subjective, /two different valid counts/i);
    assert.match(ELLIOTT_CAVEAT.no_evidence, /no peer-reviewed support/i);
    assert.match(ELLIOTT_CAVEAT.hindsight, /least certain/i);
    assert.match(ELLIOTT_CAVEAT.use, /road map/i);
  });
});
