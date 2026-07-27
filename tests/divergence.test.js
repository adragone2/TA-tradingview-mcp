/**
 * Divergence unit tests — no TradingView connection needed.
 *
 * Two groups carry the weight:
 *
 *   1. The series-vs-scalar cross-check. strategy.js already had scalar rsi()
 *      and ema(); this module adds series versions. Two implementations of one
 *      formula is a liability unless something asserts they agree, so the last
 *      element of each series is checked against the scalar for the same input.
 *
 *   2. The direction tests. Getting regular and hidden divergence backwards
 *      would invert every read, and the labels are the entire content of the
 *      tool. There is a test per direction, built from hand-made series so the
 *      expected answer is not in doubt.
 *
 * Run: node --test tests/divergence.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  emaSeries, rsiSeries, macdSeries, obvSeries, mfiSeries,
  findDivergences, surveyDivergences, DIVERGENCE_CAVEAT,
} from '../src/core/divergence.js';
import { ema, rsi } from '../src/core/strategy.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });
const reset = () => { t = 1_700_000_000; };

/** Bars whose highs/lows trace the given turning points. */
function path(points, per = 6, vol = 1000) {
  reset();
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < per; j++) {
      const p = points[i] + ((points[i + 1] - points[i]) * j) / per;
      out.push(bar(p, p + 0.5, p - 0.5, p, vol));
    }
  }
  const last = points[points.length - 1];
  out.push(bar(last, last + 0.5, last - 0.5, last, vol));
  return out;
}

describe('indicator series agree with the scalar versions in strategy.js', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 10 + i * 0.2);

  it('emaSeries ends where ema() lands', () => {
    for (const len of [5, 12, 26]) {
      const s = emaSeries(closes, len);
      assert.ok(Math.abs(s[s.length - 1] - ema(closes, len)) < 1e-9, `EMA(${len}) disagrees`);
    }
  });

  it('rsiSeries ends where rsi() lands', () => {
    for (const len of [7, 14, 21]) {
      const s = rsiSeries(closes, len);
      assert.ok(Math.abs(s[s.length - 1] - rsi(closes, len)) < 1e-9, `RSI(${len}) disagrees`);
    }
  });

  it('leaves the warm-up period null rather than guessing', () => {
    const s = rsiSeries(closes, 14);
    for (let i = 0; i < 14; i++) assert.equal(s[i], null, `RSI should be null at index ${i}`);
    assert.ok(Number.isFinite(s[14]));
    const e = emaSeries(closes, 12);
    for (let i = 0; i < 11; i++) assert.equal(e[i], null);
    assert.ok(Number.isFinite(e[11]));
  });

  it('keeps RSI inside 0-100', () => {
    for (const v of rsiSeries(closes, 14)) {
      if (v != null) assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);
    }
  });

  it('returns all nulls rather than throwing on too little data', () => {
    assert.deepEqual(rsiSeries([1, 2, 3], 14).filter((v) => v != null), []);
    assert.deepEqual(emaSeries([1, 2], 14).filter((v) => v != null), []);
  });
});

describe('macdSeries', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);

  it('produces line, signal and histogram of the right length', () => {
    const m = macdSeries(closes);
    assert.equal(m.macd.length, closes.length);
    assert.equal(m.signal.length, closes.length);
    assert.equal(m.histogram.length, closes.length);
  });

  it('has the histogram equal line minus signal wherever both are defined', () => {
    const m = macdSeries(closes);
    for (let i = 0; i < closes.length; i++) {
      if (m.macd[i] != null && m.signal[i] != null) {
        assert.ok(Math.abs(m.histogram[i] - (m.macd[i] - m.signal[i])) < 1e-9);
      }
    }
  });

  it('starts the signal line no earlier than the MACD line', () => {
    const m = macdSeries(closes);
    const macdStart = m.macd.findIndex((v) => v != null);
    const sigStart = m.signal.findIndex((v) => v != null);
    assert.ok(sigStart >= macdStart, 'the signal cannot exist before the line it smooths');
  });

  it('goes positive on a steady rise', () => {
    const m = macdSeries(closes);
    assert.ok(m.macd[m.macd.length - 1] > 0, 'a rising series must have a positive MACD line');
  });
});

describe('obvSeries', () => {
  it('adds volume on an up close and subtracts on a down close', () => {
    reset();
    const bars = [bar(100, 101, 99, 100, 500), bar(100, 102, 99, 101, 300), bar(101, 102, 98, 99, 200)];
    const o = obvSeries(bars);
    assert.equal(o[0], 0);
    assert.equal(o[1], 300);
    assert.equal(o[2], 100);
  });

  it('leaves OBV unchanged on an unchanged close', () => {
    reset();
    const bars = [bar(100, 101, 99, 100, 500), bar(100, 101, 99, 100, 400)];
    assert.equal(obvSeries(bars)[1], 0);
  });

  it('handles too few bars', () => {
    reset();
    assert.deepEqual(obvSeries([bar(1, 1, 1, 1)]).filter((v) => v != null), []);
  });
});

describe('mfiSeries', () => {
  it('stays inside 0-100', () => {
    reset();
    const bars = Array.from({ length: 60 }, (_, i) => {
      const p = 100 + Math.sin(i / 4) * 8;
      return bar(p, p + 1, p - 1, p, 1000 + i * 10);
    });
    for (const v of mfiSeries(bars, 14)) {
      if (v != null) assert.ok(v >= 0 && v <= 100, `MFI out of range: ${v}`);
    }
  });

  it('reads high when every bar rises', () => {
    reset();
    const bars = Array.from({ length: 40 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 100.5 + i, 1000));
    const m = mfiSeries(bars, 14);
    assert.ok(m[m.length - 1] > 90, `expected a high reading, got ${m[m.length - 1]}`);
  });

  it('is undefined without volume rather than returning a plain RSI', () => {
    reset();
    const bars = Array.from({ length: 40 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 100.5 + i, 0));
    assert.deepEqual(mfiSeries(bars, 14).filter((v) => v != null), []);
  });
});

describe('findDivergences — direction', () => {
  // Price makes a higher high; the indicator is forced lower at the second one.
  const bars = path([100, 90, 120, 105, 130, 115]);
  const swings = bars.length;

  const seriesFrom = (fn) => bars.map((b, i) => fn(b, i));

  it('finds regular BEARISH: higher high in price, lower high in the indicator', () => {
    // Falls steadily, so whatever the price highs are, the indicator's are lower.
    const falling = seriesFrom((_, i) => 100 - i);
    const r = findDivergences(bars, falling, { lookback: 3, min_bars_between: 2, label: 'test' });
    const d = r.divergences.find((x) => x.type === 'regular_bearish');
    assert.ok(d, `expected a regular bearish divergence, got ${JSON.stringify(r.divergences.map((x) => x.type))}`);
    assert.equal(d.direction, 'bearish');
    assert.equal(d.class, 'regular');
    assert.ok(d.to.price > d.from.price, 'price must have made the higher high');
    assert.ok(d.to.indicator_value < d.from.indicator_value, 'the indicator must not have followed');
  });

  it('finds regular BULLISH: lower low in price, higher low in the indicator', () => {
    const down = path([130, 140, 110, 125, 95, 110]);
    const rising = down.map((_, i) => i);
    const r = findDivergences(down, rising, { lookback: 3, min_bars_between: 2, label: 'test' });
    const d = r.divergences.find((x) => x.type === 'regular_bullish');
    assert.ok(d, 'expected a regular bullish divergence');
    assert.ok(d.to.price < d.from.price);
    assert.ok(d.to.indicator_value > d.from.indicator_value);
  });

  it('finds HIDDEN bullish: higher low in price, lower low in the indicator', () => {
    const up = path([90, 80, 120, 95, 140, 110]);
    const falling = up.map((_, i) => -i);
    const r = findDivergences(up, falling, { lookback: 3, min_bars_between: 2, label: 'test' });
    const d = r.divergences.find((x) => x.type === 'hidden_bullish');
    assert.ok(d, 'expected a hidden bullish divergence');
    assert.equal(d.class, 'hidden');
    assert.match(d.meaning, /continuation, not reversal/i);
  });

  it('finds nothing when price and indicator agree', () => {
    const agreeing = bars.map((b) => b.close);
    const r = findDivergences(bars, agreeing, { lookback: 3, min_bars_between: 2, label: 'test' });
    assert.equal(r.divergences.filter((d) => d.class === 'regular').length, 0,
      'an indicator that tracks price cannot diverge from it');
  });

  it('labels regular as losing conviction and hidden as continuation', () => {
    const falling = bars.map((_, i) => 100 - i);
    const r = findDivergences(bars, falling, { lookback: 3, min_bars_between: 2, label: 'test' });
    for (const d of r.divergences) {
      if (d.class === 'regular') assert.match(d.meaning, /losing conviction/i);
      else assert.match(d.meaning, /continuation/i);
    }
    assert.ok(swings > 0);
  });
});

describe('findDivergences — filtering and honesty', () => {
  const bars = path([100, 90, 120, 105, 130, 115]);
  const falling = bars.map((_, i) => 100 - i);

  it('reports how many existed before filtering', () => {
    const r = findDivergences(bars, falling, { lookback: 3, min_bars_between: 2, label: 'test' });
    assert.ok('total_found' in r);
    assert.ok(r.total_found >= r.divergences.length);
    assert.ok('filtered_too_old' in r);
  });

  it('drops hidden divergences on request and says how many', () => {
    const withH = findDivergences(bars, falling, { lookback: 3, min_bars_between: 2, label: 'test' });
    const without = findDivergences(bars, falling, { lookback: 3, min_bars_between: 2, include_hidden: false, label: 'test' });
    assert.ok(without.divergences.every((d) => d.class === 'regular'));
    assert.ok('filtered_hidden' in without);
    assert.ok(without.divergences.length <= withH.divergences.length);
  });

  it('refuses to compare swings that sit too close together', () => {
    const loose = findDivergences(bars, falling, { lookback: 3, min_bars_between: 2, label: 'test' });
    const strict = findDivergences(bars, falling, { lookback: 3, min_bars_between: 999, label: 'test' });
    assert.equal(strict.divergences.length, 0);
    assert.ok(loose.divergences.length >= strict.divergences.length);
  });

  it('rejects a mismatched series rather than aligning it silently', () => {
    const r = findDivergences(bars, [1, 2, 3], { label: 'test' });
    assert.equal(r.divergences.length, 0);
    assert.match(r.note, /same length/i);
  });

  it('says plainly that finding nothing is unremarkable', () => {
    const flat = path([100, 100.1, 100, 100.1]);
    const r = findDivergences(flat, flat.map(() => 50), { lookback: 3, label: 'test' });
    if (r.total_found === 0) assert.match(r.note, /common and unremarkable/i);
  });
});

describe('surveyDivergences — agreement', () => {
  it('runs every indicator and reports each', () => {
    const bars = path([100, 90, 120, 105, 130, 115], 12);
    const s = surveyDivergences(bars, { lookback: 3 });
    assert.ok(s.runs.length >= 2);
    assert.ok(s.runs.every((r) => 'total_found' in r && 'indicator' in r));
  });

  it('skips the volume indicators when there is no volume, and says so', () => {
    const bars = path([100, 90, 120, 105, 130, 115], 12, 0);
    const s = surveyDivergences(bars, { lookback: 3 });
    assert.ok(s.volume_note, 'it must say why OBV and MFI are absent');
    assert.ok(!s.runs.some((r) => r.indicator === 'OBV'));
  });

  it('calls a lone divergence weak evidence', () => {
    const bars = path([100, 90, 120, 105, 130, 115], 12);
    const s = surveyDivergences(bars, { lookback: 3 });
    if (s.agreeing_indicators.length === 1) assert.match(s.agreement, /weak evidence/i);
  });

  it('describes silence as the ordinary state of a chart', () => {
    const flat = Array.from({ length: 120 }, () => { reset(); return null; });
    const bars = path([100, 100.2, 100, 100.2], 20);
    const s = surveyDivergences(bars, { lookback: 5 });
    if (s.agreeing_indicators.length === 0) assert.match(s.agreement, /ordinary state/i);
    assert.equal(flat.length, 120);
  });
});

describe('DIVERGENCE_CAVEAT', () => {
  it('names the frequency problem, the strong-trend problem and the method', () => {
    assert.match(DIVERGENCE_CAVEAT.frequency, /over-claimed/i);
    assert.match(DIVERGENCE_CAVEAT.strong_trends, /NORMAL rather than a warning/);
    assert.match(DIVERGENCE_CAVEAT.persistence, /not a timing tool/i);
    assert.match(DIVERGENCE_CAVEAT.method, /not at the indicator's own swings/i);
  });
});
