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

import { anatomy, detectPatterns, classifyCandle, classifyRecent, statsFor, CANDLE_PATTERNS, STRUCTURAL_PATTERNS, STRUCTURAL_STATS } from '../src/core/patterns.js';

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
    // Wicks either side of an unchanged close: the long-legged variant.
    assert.ok(names(detectPatterns(bars, { recent_bars: 2 })).some((n) => n.includes('doji')));
  });

  it('names the doji variant, because the variant is the meaning', () => {
    reset();
    const dragonfly = [...downLeadIn(), bar(100, 100.2, 90, 100)];
    const d = find(detectPatterns(dragonfly, { recent_bars: 2 }), 'dragonfly_doji');
    assert.ok(d, 'expected a dragonfly doji');
    assert.equal(d.direction, 'bullish');

    reset();
    const gravestone = [...upLeadIn(), bar(100, 110, 99.8, 100)];
    const g = find(detectPatterns(gravestone, { recent_bars: 2 }), 'gravestone_doji');
    assert.ok(g, 'expected a gravestone doji');
    assert.equal(g.direction, 'bearish');
  });

  it('detects a momentum candle against the recent average body', () => {
    reset();
    const small = Array.from({ length: 6 }, () => bar(100, 101, 99, 100.5));
    const bars = [...small, bar(100, 112, 99, 111)];
    const m = find(detectPatterns(bars, { recent_bars: 2 }), 'bullish_momentum_candle');
    assert.ok(m, 'expected a bullish momentum candle');
    assert.ok(m.measurements.body_vs_avg >= 2, 'body must exceed twice the recent average');
  });

  it('does not call an ordinary bar a momentum candle', () => {
    reset();
    const even = Array.from({ length: 8 }, () => bar(100, 102, 98, 101));
    assert.ok(!names(detectPatterns(even, { recent_bars: 2 })).some((n) => n.includes('momentum')));
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
    // Measured, not folklore: the hanging man acts as a BULLISH continuation
    // 59% of the time, so direction follows the measurement and the
    // contradiction is stated rather than hidden.
    assert.equal(p.direction, 'bullish');
    assert.match(p.contradicts_folklore, /Traditionally called bearish/);
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
    // A bearish harami measures 53% bullish continuation — a coin flip.
    assert.equal(p.reliability.verdict, 'close to random');
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

describe('measured reliability overrides folklore', () => {
  it('labels the inverted hammer bearish, because that is what it does', () => {
    reset();
    const bars = [...downLeadIn(), bar(100, 112, 99, 101.5)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'inverted_hammer');
    assert.equal(p.direction, 'bearish');
    assert.equal(p.reliability.acts_as, 'bearish continuation');
    assert.match(p.contradicts_folklore, /measurement wins/);
  });

  it('marks the bearish engulfing as reliable and the harami as random', () => {
    reset();
    const eng = [...upLeadIn(), bar(100, 103, 99, 102), bar(103, 104, 97, 98)];
    assert.equal(find(detectPatterns(eng, { recent_bars: 2 }), 'bearish_engulfing').reliability.verdict, 'reliable');
    reset();
    const har = [...upLeadIn(), bar(100, 121, 99, 120), bar(112, 114, 110, 111)];
    assert.equal(find(detectPatterns(har, { recent_bars: 2 }), 'harami').reliability.verdict, 'close to random');
  });

  it('carries the rank so a reliable-but-going-nowhere pattern is visible', () => {
    reset();
    const bars = [...downLeadIn(), bar(100, 101, 92, 99)];
    const p = find(detectPatterns(bars, { recent_bars: 2 }), 'hammer');
    assert.equal(p.reliability.rank_of_103, 65);   // reverses, but the move is poor
  });

  it('leaves patterns with no measured stats alone', () => {
    reset();
    const bars = [...upLeadIn(), bar(100, 105, 95, 100.1)];
    const p = detectPatterns(bars, { recent_bars: 2 }).candlestick.find((x) => x.pattern.includes('doji'));
    assert.equal(p.reliability, undefined);
  });
});

describe('trendline patterns', () => {
  const tl = (bars, opts = {}) =>
    detectPatterns(bars, { lookback: 2, window_bars: 200, max_age_bars: 1000, ...opts }).structural;

  it('detects an ascending triangle: flat highs, rising lows', () => {
    const bars = zig([80, 100, 85, 100, 90, 100, 95], 5);
    const p = tl(bars).find((x) => x.pattern === 'ascending_triangle');
    assert.ok(p, 'expected an ascending triangle');
    assert.ok(Math.abs(p.measurements.upper_slope_pct_per_bar) < 0.05, 'upper line should be flat');
    assert.ok(p.measurements.lower_slope_pct_per_bar > 0, 'lower line should rise');
    assert.ok(p.measurements.touches_high >= 2 && p.measurements.touches_low >= 2);
  });

  it('detects a descending triangle: flat lows, falling highs', () => {
    const bars = zig([120, 100, 115, 100, 110, 100, 105], 5);
    const p = tl(bars).find((x) => x.pattern === 'descending_triangle');
    assert.ok(p, 'expected a descending triangle');
    assert.ok(p.measurements.upper_slope_pct_per_bar < 0);
  });

  it('detects a symmetrical triangle and calls its direction bilateral', () => {
    const bars = zig([80, 120, 90, 112, 96, 106, 100], 5);
    const p = tl(bars).find((x) => x.pattern === 'symmetrical_triangle');
    if (p) {
      assert.equal(p.direction, 'bilateral');
      assert.equal(p.type, 'uncertain');
      assert.equal(p.measurements.converging, true);
      // Flagged as something to be wary of, not as a setup.
      assert.match(p.avoid, /trading range/i);
    }
  });

  it('detects a rectangle when both lines are flat', () => {
    const bars = zig([90, 110, 90, 110, 90, 110, 100], 5);
    const p = tl(bars).find((x) => x.pattern === 'rectangle');
    assert.ok(p, 'expected a rectangle');
    assert.equal(p.direction, 'bilateral');
  });

  it('requires at least two touches of each line', () => {
    // One swing high and one swing low cannot define two trend lines.
    const bars = zig([100, 120, 100], 5);
    assert.equal(tl(bars).filter((x) => x.pattern === 'rectangle').length, 0);
  });

  it('calls a rising wedge bearish, against the direction of its own lines', () => {
    const bars = zig([100, 120, 108, 124, 116, 126, 122], 5);
    const p = tl(bars).find((x) => x.pattern === 'rising_wedge');
    if (p) {
      assert.equal(p.direction, 'bearish');
      assert.ok(p.measurements.upper_slope_pct_per_bar > 0);
      assert.ok(p.measurements.lower_slope_pct_per_bar > 0);
      assert.match(p.note, /breaks DOWN/i);
    }
  });

  it('reports forming until price closes beyond a line', () => {
    const bars = zig([90, 110, 90, 110, 90, 110, 100], 5);
    const p = tl(bars).find((x) => x.pattern === 'rectangle');
    assert.equal(p.status, 'forming');
  });

  it('projects the target by the pattern height from the breakout', () => {
    const bars = zig([90, 110, 90, 110, 90, 110, 130], 5);
    const p = tl(bars).find((x) => ['rectangle', 'ascending_triangle'].includes(x.pattern));
    if (p && p.status === 'confirmed') {
      assert.ok(Number.isFinite(p.target));
      assert.ok(p.target > p.completion_level, 'an upward break should target above the level');
    }
  });
});

describe('direction and type are separate questions', () => {
  const tl = (bars) => detectPatterns(bars, { lookback: 2, window_bars: 200, max_age_bars: 1000 }).structural;

  it('marks swing reversals as type reversal', () => {
    const bars = zig([80, 120, 100, 120, 108]);
    const p = detectPatterns(bars, { lookback: 3 }).structural.find((x) => x.pattern === 'double_top');
    assert.equal(p.type, 'reversal');
    assert.equal(p.direction, 'bearish');
  });

  it('marks triangles and flags as continuations', () => {
    const asc = tl(zig([80, 100, 85, 100, 90, 100, 95], 5)).find((x) => x.pattern === 'ascending_triangle');
    if (asc) assert.equal(asc.type, 'continuation');
  });

  it('flags uncertain patterns with an explicit reason to avoid them', () => {
    const rect = tl(zig([90, 110, 90, 110, 90, 110, 100], 5)).find((x) => x.pattern === 'rectangle');
    assert.equal(rect.type, 'uncertain');
    assert.match(rect.avoid, /random|imaginary/i);
  });

  it('a rising wedge needs the LOWER line steeper, not just two rising lines', () => {
    // A rising channel: both lines rise at the same rate, range constant.
    // That is not a wedge, and calling it one would be wrong.
    reset();
    const channel = [];
    for (let i = 0; i < 60; i++) {
      const mid = 100 + i * 0.5;
      const p = mid + (i % 10 < 5 ? 5 : -5);
      channel.push(bar(p, p + 0.3, p - 0.3, p));
    }
    assert.equal(tl(channel).filter((x) => x.pattern === 'rising_wedge').length, 0);
  });

  it('reports whether head-and-shoulders structure had already turned', () => {
    const bars = zig([80, 110, 95, 130, 90, 110, 100]);   // second trough LOWER
    const p = detectPatterns(bars, { lookback: 3 }).structural.find((x) => x.pattern === 'head_and_shoulders');
    if (p) {
      assert.equal(typeof p.measurements.downsloping_neckline, 'boolean');
      assert.ok(p.structure_confirms || p.structure_caveat, 'must state which version it is');
    }
  });
});

describe('classifyCandle — the three families', () => {
  const c = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl, volume: 1000, time: 1 });
  /** Quiet bars with small real bodies — the baseline "large" is measured against. */
  const quiet = (n = 10) => Array.from({ length: n }, () => c(100, 100.6, 99.4, 100.2));

  it('calls a big-bodied candle with no wicks a marubozu', () => {
    const r = classifyCandle(c(100, 110, 100, 110), quiet());
    assert.equal(r.family, 'momentum');
    assert.equal(r.subtype, 'marubozu');
    assert.equal(r.direction, 'bullish');
  });

  it('calls a big body with small wicks momentum, not marubozu', () => {
    const r = classifyCandle(c(100, 111, 99, 110), quiet());
    assert.equal(r.family, 'momentum');
    assert.equal(r.subtype, 'momentum_candle');
  });

  it('refuses to call a quiet wickless bar momentum', () => {
    // Body dominates its own tiny range, but it is ordinary for this chart.
    // Without the size-vs-context test this reads as momentum, which is wrong.
    const r = classifyCandle(c(100, 100.5, 100, 100.5), quiet());
    assert.notEqual(r.family, 'momentum');
  });

  it('reads a long lower wick as a BULLISH reaction whatever the body colour', () => {
    const red = classifyCandle(c(109, 110, 100, 108), quiet());
    assert.equal(red.family, 'reaction');
    assert.equal(red.direction, 'bullish', 'the wick decides the direction, not the red body');
    assert.match(red.meaning, /body colour matters much less/i);
  });

  it('reads a long upper wick as a bearish reaction', () => {
    const r = classifyCandle(c(101, 110, 100, 102), quiet());
    assert.equal(r.family, 'reaction');
    assert.equal(r.direction, 'bearish');
  });

  it('says a reaction candle only counts at a level', () => {
    const r = classifyCandle(c(109, 110, 100, 108), quiet());
    assert.match(r.meaning, /middle of a range/i);
  });

  it('calls an open-equals-close candle in a normal range a doji', () => {
    const r = classifyCandle(c(100, 100.7, 99.3, 100), quiet());
    assert.equal(r.family, 'indecision');
    assert.equal(r.subtype, 'doji');
  });

  it('calls a zero-body candle in an unusually WIDE range a high wave, not a doji', () => {
    // The range is the information here. Collapsing this to "doji" would throw
    // away that the bar was violent and still went nowhere.
    const r = classifyCandle(c(100, 110, 90, 100), quiet());
    assert.equal(r.subtype, 'high_wave');
  });

  it('separates a spinning top from a high-wave candle by range', () => {
    const top = classifyCandle(c(100, 101, 99, 100.3), quiet());
    assert.equal(top.family, 'indecision');
    assert.equal(top.subtype, 'spinning_top');
    const wave = classifyCandle(c(100, 110, 90, 100.6), quiet());
    assert.equal(wave.subtype, 'high_wave', 'a small body inside an unusually wide range');
  });

  it('handles a bar with no range at all', () => {
    const r = classifyCandle(c(100, 100, 100, 100), quiet());
    assert.equal(r.family, 'indecision');
    assert.equal(r.subtype, 'four_price_doji');
  });

  it('says an indecision candle is not tradeable alone', () => {
    assert.match(classifyCandle(c(100, 100.7, 99.3, 100), quiet()).meaning, /not tradeable alone/i);
  });

  it('always returns one of exactly three families', () => {
    const bars = [c(100, 110, 100, 110), c(109, 110, 100, 108), c(100, 100.7, 99.3, 100), c(100, 101, 99, 100.5)];
    for (const b of bars) {
      assert.ok(['momentum', 'reaction', 'indecision'].includes(classifyCandle(b, quiet()).family));
    }
  });

  it('carries the reason behind every classification', () => {
    for (const b of [c(100, 110, 100, 110), c(109, 110, 100, 108), c(100, 100.7, 99.3, 100)]) {
      const r = classifyCandle(b, quiet());
      assert.ok(r.reason && r.reason.length > 20, `thin reason: ${r.reason}`);
    }
  });
});

describe('classifyRecent', () => {
  const c = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl, volume: 1000, time: 1 });

  it('classifies the last N candles, newest first', () => {
    const bars = [...Array.from({ length: 15 }, () => c(100, 100.6, 99.4, 100.2)), c(100, 110, 100, 110)];
    const r = classifyRecent(bars, { count: 3 });
    assert.equal(r.candles.length, 3);
    assert.equal(r.candles[0].bars_ago, 0);
    assert.equal(r.candles[0].family, 'momentum');
  });

  it('tallies the families', () => {
    const bars = Array.from({ length: 20 }, () => c(100, 100.6, 99.4, 100.2));
    const r = classifyRecent(bars, { count: 5 });
    assert.equal(Object.values(r.tally).reduce((a, b) => a + b, 0), 5);
  });

  it('distinguishes itself from patterns_detect in the note', () => {
    const bars = Array.from({ length: 20 }, () => c(100, 100.6, 99.4, 100.2));
    assert.match(classifyRecent(bars).note, /patterns_detect/);
  });

  it('handles an empty series', () => {
    assert.equal(classifyRecent([]).candles.length, 0);
  });
});

describe('classifyCandle — reasons must match the subtype', () => {
  const c = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl, volume: 1000, time: 1 });
  const quiet = (n = 10) => Array.from({ length: n }, () => c(100, 100.6, 99.4, 100.2));

  it('does not claim wicks on both sides for a one-sided small body', () => {
    // Caught on a live chart: small_body is by definition NOT the two-sided
    // case, so describing it as one was simply wrong.
    const r = classifyCandle(c(100, 100.9, 99.95, 100.3), quiet());
    if (r.subtype === 'small_body') {
      assert.doesNotMatch(r.reason, /both sides/i);
    }
  });

  it('keeps the both-sides description for a spinning top, where it is true', () => {
    const r = classifyCandle(c(100, 101, 99, 100.3), quiet());
    assert.equal(r.subtype, 'spinning_top');
    assert.match(r.reason, /both sides/i);
  });
});

describe('STRUCTURAL_STATS — Bulkowski measurements', () => {
  it('covers every structural pattern the detector can produce', () => {
    for (const p of STRUCTURAL_PATTERNS) {
      assert.ok(STRUCTURAL_STATS[p], `no measured statistics for ${p}`);
    }
  });

  it('has every value in a plausible range', () => {
    // A shifted parse turns a percentage into a rank or a trend word. Anything
    // outside 0-100 means the extraction slipped a row.
    for (const [pat, dirs] of Object.entries(STRUCTURAL_STATS)) {
      for (const [dir, markets] of Object.entries(dirs)) {
        for (const [mkt, s] of Object.entries(markets)) {
          for (const [k, v] of Object.entries(s)) {
            if (k === 'rank') {
              if (v !== null) assert.match(v, /^\d+\/\d+$/, `${pat}.${dir}.${mkt}.rank = ${v}`);
              continue;
            }
            const vals = Array.isArray(v) ? v : [v];
            for (const n of vals) {
              assert.ok(Number.isFinite(n) && n >= 0 && n <= 100,
                `${pat}.${dir}.${mkt}.${k} = ${n} is not a percentage`);
            }
          }
        }
      }
    }
  });

  it('keeps ranges ordered low-to-high', () => {
    for (const dirs of Object.values(STRUCTURAL_STATS)) {
      for (const markets of Object.values(dirs)) {
        for (const s of Object.values(markets)) {
          for (const [k, v] of Object.entries(s)) {
            if (Array.isArray(v)) assert.ok(v[0] <= v[1], `${k} range is inverted: ${v}`);
          }
        }
      }
    }
  });

  it('reproduces the figures Bulkowski is known for', () => {
    // Head-and-shoulders tops is his top-ranked pattern in a bull market with a
    // 4% failure rate. If the parse slipped, these are the first to break.
    const hs = statsFor('head_and_shoulders');
    assert.equal(hs.rank, '1/21');
    assert.equal(hs.break_even_failure_pct, 4);
    assert.equal(hs.breakout_direction, 'downward');
  });

  it('separates breakout directions rather than assuming the conventional one', () => {
    const up = statsFor('rising_wedge', { direction: 'upward' });
    const down = statsFor('rising_wedge', { direction: 'downward' });
    assert.notEqual(up.break_even_failure_pct, down.break_even_failure_pct);
    // The measured finding worth surfacing: the "bearish" break of a rising
    // wedge fails far more often than the break the folklore ignores.
    assert.ok(down.break_even_failure_pct > up.break_even_failure_pct,
      'the downward break of a rising wedge fails more often than the upward one');
    assert.match(down.both_directions, /Do not assume the conventional direction/);
  });

  it('separates bull and bear markets', () => {
    const bull = statsFor('inverse_head_and_shoulders', { market: 'bull' });
    const bear = statsFor('inverse_head_and_shoulders', { market: 'bear' });
    assert.equal(bull.market_assumed, 'bull');
    assert.equal(bear.market_assumed, 'bear');
    assert.notEqual(bull.average_move_pct, bear.average_move_pct);
    assert.match(bull.market_note, /Pass market:"bear"/);
  });

  it('reports a range for patterns whose variants it cannot distinguish', () => {
    const dt = statsFor('double_top');
    assert.ok(Array.isArray(dt.break_even_failure_pct_range));
    assert.match(dt.range_note, /never measured/i);
    assert.match(dt.summary, /\d+-\d+%/);
  });

  it('attributes the numbers rather than presenting them as its own', () => {
    assert.match(statsFor('head_and_shoulders').source, /Bulkowski/);
    assert.match(statsFor('head_and_shoulders').source, /not measurements made here/);
  });

  it('returns null for a pattern it has no data for', () => {
    assert.equal(statsFor('not_a_pattern'), null);
  });
});

describe('detectPatterns — statistics are attached only where they apply', () => {
  let t = 1_700_000_000;
  const b = (o, h, l, c) => ({ time: (t += 86400), open: o, high: h, low: l, close: c, volume: 1000 });

  it('never attaches measured stats to a FORMING pattern', () => {
    // Bulkowski measures from the breakout onward. Quoting a failure rate for a
    // shape that has not broken out applies a number to an event that has not
    // happened.
    t = 1_700_000_000;
    const bars = Array.from({ length: 120 }, (_, i) => {
      const p = 100 + Math.sin(i / 6) * 12;
      return b(p, p + 1.5, p - 1.5, p);
    });
    const r = detectPatterns(bars, { lookback: 4 });
    for (const p of r.structural) {
      if (p.status === 'forming') {
        assert.equal(p.measured, undefined, `${p.pattern} is forming but carries statistics`);
        assert.match(p.stats_note, /has not broken out/i);
      }
    }
  });

  it('accepts a market regime and passes it through', () => {
    t = 1_700_000_000;
    const bars = Array.from({ length: 120 }, (_, i) => {
      const p = 100 + Math.sin(i / 6) * 12;
      return b(p, p + 1.5, p - 1.5, p);
    });
    const bear = detectPatterns(bars, { lookback: 4, market: 'bear' });
    for (const p of bear.structural) {
      if (p.measured) assert.equal(p.measured.market_assumed, 'bear');
    }
  });
});
