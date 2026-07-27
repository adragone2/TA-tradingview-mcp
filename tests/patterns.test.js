/**
 * Pattern detection unit tests — no TradingView connection needed.
 *
 * Each pattern is tested against bars constructed to satisfy its definition,
 * and — more importantly — against near-misses that must NOT match. Pattern
 * detection is the easiest place in this codebase to produce confident
 * nonsense, so the negative cases carry as much weight as the positive ones.
 *
 * Run: node --test tests/patterns.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { anatomy, detectPatterns, CANDLE_PATTERNS, STRUCTURAL_PATTERNS } from '../src/core/patterns.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: 100 });
const reset = () => { t = 1_700_000_000; };

/** Bars trending in a direction, so reversal patterns have context. */
const downLeadIn = (n = 6, from = 120) =>
  Array.from({ length: n }, (_, i) => { const p = from - i * 3; return bar(p, p + 0.5, p - 3.5, p - 3); });
const upLeadIn = (n = 6, from = 100) =>
  Array.from({ length: n }, (_, i) => { const p = from + i * 3; return bar(p, p + 3.5, p - 0.5, p + 3); });

const names = (r) => r.candlestick.map((p) => p.pattern);
const find = (r, name) => r.candlestick.find((p) => p.pattern === name);

describe('anatomy', () => {
  it('measures body and wicks', () => {
    const a = anatomy({ open: 10, high: 15, low: 8, close: 12 });
    assert.equal(a.range, 7);
    assert.equal(a.body, 2);
    assert.equal(a.upper_wick, 3);
    assert.equal(a.lower_wick, 2);
    assert.equal(a.bullish, true);
  });

  it('handles a bar with no range without dividing by zero', () => {
    const a = anatomy({ open: 10, high: 10, low: 10, close: 10 });
    assert.equal(a.range, 0);
    assert.equal(a.body_pct, 0);
  });
});

describe('doji', () => {
  it('detects a bar whose open and close are nearly equal', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 105, 95, 100.1)];
    assert.ok(names(detectPatterns(bars, { recent_bars: 2 })).includes('doji'));
  });

  it('does not call a full-bodied bar a doji', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 110, 99, 109)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 2 })).includes('doji'));
  });
});

describe('hammer and hanging man — same shape, different context', () => {
  it('calls it a hammer after a decline', () => {
    reset();
    const bars = [...downLeadIn(), bar(100, 101, 92, 99)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'hammer');
    assert.ok(p, 'expected a hammer');
    assert.equal(p.direction, 'bullish');
    assert.equal(p.prior_trend, 'down');
  });

  it('calls the identical shape a hanging man after an advance', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 101, 92, 99)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'hanging_man');
    assert.ok(p, 'expected a hanging man');
    assert.equal(p.direction, 'bearish');
  });

  it('flags the lack of a trend rather than claiming a reversal', () => {
    reset();
    const flat = Array.from({ length: 6 }, () => bar(100, 101, 99, 100));
    const bars = [...flat, bar(100, 101, 92, 99)];
    const p = detectPatterns(bars, { recent_bars: 2 }).candlestick
      .find((x) => x.pattern === 'hammer' || x.pattern === 'hanging_man');
    if (p) assert.match(p.caveat, /little reversal meaning/i);
  });

  it('does not fire when the lower wick is short', () => {
    reset();
    const bars = [...downLeadIn(), bar(100, 105, 99, 104)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 2 })).includes('hammer'));
  });
});

describe('shooting star and inverted hammer', () => {
  it('detects a shooting star after an advance', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 112, 99, 101.5)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'shooting_star');
    assert.ok(p);
    assert.equal(p.direction, 'bearish');
  });

  it('detects an inverted hammer after a decline', () => {
    reset();
    const bars = [...downLeadIn(), bar(100, 112, 99, 101.5)];
    assert.ok(find(detectPatterns(bars, { recent_bars: 2 }), 'inverted_hammer'));
  });
});

describe('engulfing', () => {
  it('detects bullish engulfing', () => {
    reset();
    const bars = [...downLeadIn(), bar(100, 101, 97, 98), bar(97, 104, 96, 103)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'bullish_engulfing');
    assert.ok(p, 'expected bullish engulfing');
    assert.ok(p.measurements.body_ratio > 1);
  });

  it('detects bearish engulfing', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 103, 99, 102), bar(103, 104, 97, 98)];
    assert.ok(find(detectPatterns(bars, { recent_bars: 2 }), 'bearish_engulfing'));
  });

  it('does NOT fire when the second body fails to cover the first', () => {
    reset();
    const bars = [...downLeadIn(), bar(100, 101, 95, 96), bar(97, 100, 96, 99)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 2 })).includes('bullish_engulfing'));
  });

  it('does NOT fire when both bars are the same colour', () => {
    reset();
    const bars = [...upLeadIn(), bar(96, 99, 95, 98), bar(95, 104, 94, 103)];
    const n = names(detectPatterns(bars, { recent_bars: 2 }));
    assert.ok(!n.includes('bullish_engulfing') && !n.includes('bearish_engulfing'));
  });
});

describe('harami', () => {
  it('detects a small opposite body inside a large one', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 121, 99, 120), bar(112, 114, 110, 111)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'harami');
    assert.ok(p, 'expected a harami');
    assert.ok(p.measurements.body_ratio < 1);
    assert.match(p.caveat, /either way/i);
  });

  it('does not fire when the second body escapes the first', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 121, 99, 120), bar(119, 125, 118, 124)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 2 })).includes('harami'));
  });
});

describe('dark cloud cover and piercing line', () => {
  it('detects dark cloud cover', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 111, 99, 110), bar(113, 114, 103, 104)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'dark_cloud_cover');
    assert.ok(p, 'expected dark cloud cover');
    assert.ok(p.measurements.penetration_pct > 50, 'must close past the midpoint');
  });

  it('detects a piercing line', () => {
    reset();
    const bars = [...downLeadIn(), bar(110, 111, 99, 100), bar(97, 107, 96, 106)];
    assert.ok(find(detectPatterns(bars, { recent_bars: 2 }), 'piercing_line'));
  });

  it('does not fire when the close fails to reach the midpoint', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 111, 99, 110), bar(113, 114, 108, 109)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 2 })).includes('dark_cloud_cover'));
  });
});

describe('inside bar and gaps', () => {
  it('detects an inside bar and reports both breakout levels', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 115, 95, 110), bar(105, 112, 99, 107)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'inside_bar');
    assert.ok(p);
    assert.deepEqual(p.breakout_levels, { above: 115, below: 95 });
  });

  it('does not call an outside bar an inside bar', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 110, 100, 105), bar(104, 115, 95, 108)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 2 })).includes('inside_bar'));
  });

  it('detects gaps in both directions', () => {
    reset();
    const up = [...upLeadIn(), bar(100, 105, 99, 104), bar(110, 115, 109, 114)];
    assert.ok(find(detectPatterns(up, { recent_bars: 2 }), 'gap_up'));
    reset();
    const down = [...downLeadIn(), bar(100, 105, 99, 104), bar(90, 95, 89, 94)];
    assert.ok(find(detectPatterns(down, { recent_bars: 2 }), 'gap_down'));
  });

  it('does not report a gap when ranges overlap', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 105, 99, 104), bar(104, 108, 103, 107)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 2 })).includes('gap_up'));
  });
});

describe('narrow range', () => {
  it('detects NR4 when the last bar is the narrowest of four', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 110, 90, 105), bar(105, 114, 96, 100),
                  bar(100, 108, 94, 104), bar(104, 105, 103, 104.5)];
    assert.ok(names(detectPatterns(bars, { recent_bars: 2 })).includes('NR4'));
  });

  it('does not fire when an earlier bar is narrower', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 101, 100, 100.5), bar(100, 110, 90, 105),
                  bar(105, 115, 95, 100), bar(100, 105, 96, 104)];
    assert.ok(!names(detectPatterns(bars, { recent_bars: 1 })).includes('NR4'));
  });
});

/* -------------------------- structural patterns ----------------------- */

/** Build a zigzag through the given prices with smooth legs. */
function zig(points, per = 6) {
  reset();
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1];
    for (let j = 0; j < per; j++) {
      const p = from + ((to - from) * j) / per;
      out.push(bar(p, p + 0.3, p - 0.3, p));
    }
  }
  const lastP = points[points.length - 1];
  out.push(bar(lastP, lastP + 0.3, lastP - 0.3, lastP));
  return out;
}

const structural = (bars, name) =>
  detectPatterns(bars, { lookback: 3, peak_tolerance_pct: 2 }).structural.find((p) => p.pattern === name);

describe('double top and bottom', () => {
  it('detects a double top and computes its measured move', () => {
    const bars = zig([80, 120, 100, 120, 108]);
    const p = structural(bars, 'double_top');
    assert.ok(p, 'expected a double top');
    assert.equal(p.direction, 'bearish');
    // Height 20 from the trough at 100 → target 80.
    assert.ok(Math.abs(p.completion_level - 100) < 2, `completion ${p.completion_level}`);
    assert.ok(Math.abs(p.target - (p.completion_level - p.measurements.height)) < 0.01);
  });

  it('reports FORMING while price is still above the trough', () => {
    const bars = zig([80, 120, 100, 120, 108]);
    assert.equal(structural(bars, 'double_top').status, 'forming');
  });

  it('reports CONFIRMED only once price closes below the trough', () => {
    const bars = zig([80, 120, 100, 120, 92]);
    assert.equal(structural(bars, 'double_top').status, 'confirmed');
  });

  it('detects a double bottom', () => {
    const bars = zig([120, 80, 100, 80, 92]);
    const p = structural(bars, 'double_bottom');
    assert.ok(p, 'expected a double bottom');
    assert.equal(p.direction, 'bullish');
  });

  it('does NOT call two peaks at clearly different prices a double top', () => {
    const bars = zig([80, 120, 100, 145, 130]);
    assert.equal(structural(bars, 'double_top'), undefined);
  });
});

describe('head and shoulders', () => {
  it('detects a top with the middle peak highest', () => {
    const bars = zig([80, 110, 95, 130, 95, 110, 100]);
    const p = structural(bars, 'head_and_shoulders');
    assert.ok(p, 'expected head and shoulders');
    assert.equal(p.direction, 'bearish');
    assert.ok(p.measurements.head > p.measurements.left_shoulder);
    assert.ok(p.measurements.head > p.measurements.right_shoulder);
  });

  it('projects the target from the neckline by the head height', () => {
    const bars = zig([80, 110, 95, 130, 95, 110, 100]);
    const p = structural(bars, 'head_and_shoulders');
    assert.ok(Math.abs(p.target - (p.completion_level - p.measurements.height)) < 0.01);
  });

  it('detects the inverse', () => {
    const bars = zig([130, 100, 115, 80, 115, 100, 110]);
    const p = structural(bars, 'inverse_head_and_shoulders');
    assert.ok(p, 'expected inverse head and shoulders');
    assert.equal(p.direction, 'bullish');
  });

  it('does NOT fire when the middle peak is not the highest', () => {
    const bars = zig([80, 130, 95, 110, 95, 130, 100]);
    assert.equal(structural(bars, 'head_and_shoulders'), undefined);
  });
});

describe('triple top and bottom', () => {
  it('detects a triple top', () => {
    const bars = zig([80, 120, 100, 120, 100, 120, 108]);
    const p = structural(bars, 'triple_top');
    assert.ok(p, 'expected a triple top');
    assert.equal(p.measurements.peaks.length, 3);
  });

  it('detects a triple bottom', () => {
    const bars = zig([120, 80, 100, 80, 100, 80, 92]);
    assert.ok(structural(bars, 'triple_bottom'));
  });
});

describe('detectPatterns contract', () => {
  it('refuses to detect from too few bars', () => {
    reset();
    const r = detectPatterns([bar(1, 2, 0, 1)]);
    assert.deepEqual(r.candlestick, []);
    assert.match(r.note, /Not enough bars/i);
  });

  it('every structural pattern carries a status and a completion level', () => {
    const bars = zig([80, 120, 100, 120, 108]);
    for (const p of detectPatterns(bars, { lookback: 3 }).structural) {
      assert.ok(['forming', 'confirmed'].includes(p.status), `bad status ${p.status}`);
      assert.ok(Number.isFinite(p.completion_level));
      assert.ok(Number.isFinite(p.target));
    }
  });

  it('counts confirmed and forming consistently with the list', () => {
    const bars = zig([80, 120, 100, 120, 92]);
    const r = detectPatterns(bars, { lookback: 3 });
    assert.equal(r.confirmed_count, r.structural.filter((p) => p.status === 'confirmed').length);
    assert.equal(r.forming_count, r.structural.filter((p) => p.status === 'forming').length);
  });

  it('honours the include filter', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 105, 95, 100.1)];
    const r = detectPatterns(bars, { recent_bars: 3, include: ['doji'] });
    assert.ok(r.candlestick.every((p) => p.pattern === 'doji'));
  });

  it('returns candlestick patterns newest first', () => {
    const bars = zig([80, 120, 100, 120, 108]);
    const r = detectPatterns(bars, { recent_bars: 20, lookback: 3 });
    for (let i = 1; i < r.candlestick.length; i++) {
      assert.ok(r.candlestick[i - 1].index >= r.candlestick[i].index);
    }
  });

  it('only reports names it advertises', () => {
    const bars = zig([80, 120, 100, 120, 92]);
    const r = detectPatterns(bars, { recent_bars: 20, lookback: 3 });
    const known = new Set([...CANDLE_PATTERNS, ...STRUCTURAL_PATTERNS]);
    for (const p of [...r.candlestick, ...r.structural]) {
      assert.ok(known.has(p.pattern), `undeclared pattern: ${p.pattern}`);
    }
  });
});

describe('recency — history is not a finding', () => {
  it('ages every structural pattern by bars_ago', () => {
    const bars = zig([80, 120, 100, 120, 108]);
    for (const p of detectPatterns(bars, { lookback: 3 }).structural) {
      assert.ok(Number.isInteger(p.bars_ago) && p.bars_ago >= 0, `bad bars_ago: ${p.bars_ago}`);
    }
  });

  it('excludes patterns older than max_age_bars and says how many', () => {
    // An early double top, then a long unrelated advance away from it.
    const bars = zig([80, 120, 100, 120, 100, 140, 160, 180, 200, 220, 240], 6);
    const all = detectPatterns(bars, { lookback: 3, max_age_bars: 0 });
    const recent = detectPatterns(bars, { lookback: 3, max_age_bars: 10 });
    assert.ok(recent.structural.length <= all.structural.length);
    if (recent.excluded_old) assert.match(recent.excluded_old, /max_age_bars/);
    for (const p of recent.structural) assert.ok(p.bars_ago <= 10);
  });

  it('sorts structural patterns newest first', () => {
    const bars = zig([80, 120, 100, 120, 100, 120, 108]);
    const st = detectPatterns(bars, { lookback: 3, max_age_bars: 1000 }).structural;
    for (let i = 1; i < st.length; i++) {
      assert.ok(st[i - 1].bars_ago <= st[i].bars_ago, 'not sorted by recency');
    }
  });

  it('says plainly when there is no structural pattern, rather than reaching', () => {
    reset();
    const bars = Array.from({ length: 40 }, (_, i) => { const p = 100 + i; return bar(p, p + 1, p - 1, p); });
    const r = detectPatterns(bars, { lookback: 3 });
    if (!r.structural.length) assert.match(r.structural_note, /normal result/i);
  });
});
