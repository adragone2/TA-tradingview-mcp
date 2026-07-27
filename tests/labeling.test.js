import { test, describe } from 'node:test';
import assert from 'node:assert';
import { rollingVolatility, labelEvent, tripleBarrier, labelSpans } from '../src/core/labeling.js';
import { purgedKFold } from '../src/core/validation.js';
import { barsFromPath, randomWalk } from '../src/core/synthetic.js';

/** Flat bars with a controllable move appended, so barriers are predictable. */
function bars(closes, { spread = 0 } = {}) {
  return closes.map((c, i) => ({
    time: 1700000000 + i * 86400,
    open: c, close: c,
    high: c + spread, low: c - spread,
    volume: 1000,
  }));
}

/** 30 bars of gentle noise so volatility is defined, then a scripted move. */
const withHistory = (tail, { spread = 0 } = {}) => {
  const hist = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 0.5 : -0.5));
  return bars([...hist, ...tail], { spread });
};

describe('rollingVolatility', () => {
  test('is null until the window is filled', () => {
    const v = rollingVolatility(bars([1, 2, 3, 4, 5]), { window: 20 });
    assert.ok(v.every((x) => x == null));
  });

  test('is positive once there is movement', () => {
    const v = rollingVolatility(withHistory([]), { window: 20 });
    assert.ok(v[29] > 0);
  });
});

describe('labelEvent', () => {
  test('+1 when the profit target is reached first on a long', () => {
    const b = withHistory([100, 130]);
    const out = labelEvent(b, 30, { direction: 1, profit_mult: 2, stop_mult: 1, max_bars: 5 });
    assert.strictEqual(out.label, 1);
    assert.strictEqual(out.reason, 'profit_target');
  });

  test('-1 when the stop is reached first on a long', () => {
    const b = withHistory([100, 70]);
    const out = labelEvent(b, 30, { direction: 1, profit_mult: 2, stop_mult: 1, max_bars: 5 });
    assert.strictEqual(out.label, -1);
    assert.strictEqual(out.reason, 'stop');
  });

  test('barriers FLIP for a short — a fall is a win', () => {
    const b = withHistory([100, 70]);
    const out = labelEvent(b, 30, { direction: -1, profit_mult: 2, stop_mult: 1, max_bars: 5 });
    assert.strictEqual(out.label, 1);
    assert.strictEqual(out.reason, 'profit_target');
  });

  test('a short is stopped out by a rise', () => {
    const b = withHistory([100, 130]);
    const out = labelEvent(b, 30, { direction: -1, profit_mult: 2, stop_mult: 1, max_bars: 5 });
    assert.strictEqual(out.label, -1);
    assert.strictEqual(out.reason, 'stop');
  });

  test('0 when neither barrier is touched inside the time limit', () => {
    const b = withHistory([100, 100.1, 100.05, 100.02, 100.01, 100.03]);
    const out = labelEvent(b, 30, { direction: 1, profit_mult: 20, stop_mult: 20, max_bars: 5 });
    assert.strictEqual(out.label, 0);
    assert.strictEqual(out.reason, 'time_limit');
  });

  test('an AMBIGUOUS bar spanning both barriers is resolved as a loss and flagged', () => {
    const b = withHistory([100], { spread: 0 });
    b.push({ time: 0, open: 100, close: 100, high: 200, low: 20, volume: 1 });
    const out = labelEvent(b, 30, { direction: 1, profit_mult: 2, stop_mult: 1, max_bars: 5 });
    assert.strictEqual(out.label, -1);
    assert.strictEqual(out.reason, 'ambiguous_bar');
    assert.strictEqual(out.ambiguous, true);
    assert.match(out.note, /talks itself into an edge/);
  });

  test('a censored label says the outcome is unknown, not neutral', () => {
    const b = withHistory([100, 100.1]);
    const out = labelEvent(b, 30, { direction: 1, profit_mult: 20, stop_mult: 20, max_bars: 50 });
    assert.strictEqual(out.label, 0);
    assert.strictEqual(out.truncated, true);
    assert.match(out.note, /CENSORED/);
  });

  test('refuses to label without a volatility estimate', () => {
    const out = labelEvent(bars([100, 101, 102]), 1, { vol_window: 20 });
    assert.strictEqual(out.label, null);
    assert.strictEqual(out.reason, 'no_volatility_estimate');
  });

  test('rejects a bad direction and an out-of-range index', () => {
    assert.throws(() => labelEvent(withHistory([100]), 30, { direction: 0 }), /must be 1 \(long\) or -1/);
    assert.throws(() => labelEvent(withHistory([100]), 999), /outside the/);
  });
});

describe('tripleBarrier', () => {
  const b = barsFromPath(randomWalk({ n: 300, seed: 21 }), { noise: 0.01, seed: 22 });
  const events = Array.from({ length: 40 }, (_, i) => 30 + i * 6);

  test('labels every event and summarises the set', () => {
    const out = tripleBarrier(b, events, { profit_mult: 2, stop_mult: 1, max_bars: 20 });
    assert.strictEqual(out.labels.length, events.length);
    assert.strictEqual(out.summary.wins + out.summary.losses + out.summary.zeros, out.summary.labelled);
  });

  test('the win rate EXCLUDES timed-out trades from its denominator', () => {
    const out = tripleBarrier(b, events, { profit_mult: 2, stop_mult: 1, max_bars: 20 });
    const { wins, losses, win_rate_pct } = out.summary;
    if (wins + losses > 0) {
      assert.ok(Math.abs(win_rate_pct - (wins / (wins + losses)) * 100) < 0.11);
      assert.match(out.summary.win_rate_basis, /zeros excluded/);
    }
  });

  test('warns when the time limit is doing most of the labelling', () => {
    const out = tripleBarrier(b, events, { profit_mult: 50, stop_mult: 50, max_bars: 3 });
    assert.ok(out.summary.zeros / out.summary.labelled > 0.5);
    assert.ok((out.warnings || []).some((w) => /time limit is doing most/.test(w)));
  });

  test('warns when too many labels rest on ambiguous bars', () => {
    // Very tight barriers on wide bars => most events span both.
    const wide = barsFromPath(randomWalk({ n: 200, seed: 31 }), { noise: 0.08, seed: 32 });
    const out = tripleBarrier(wide, Array.from({ length: 30 }, (_, i) => 25 + i * 5),
      { profit_mult: 0.05, stop_mult: 0.05, max_bars: 10 });
    if (out.summary.ambiguous_pct > 15) {
      assert.ok((out.warnings || []).some((w) => /tie-breaking convention/.test(w)));
    }
  });

  test('accepts per-event directions', () => {
    const mixed = events.map((i, n) => ({ index: i, direction: n % 2 ? -1 : 1 }));
    const out = tripleBarrier(b, mixed, { profit_mult: 2, stop_mult: 1, max_bars: 20 });
    const dirs = new Set(out.labels.map((l) => l.direction));
    assert.deepStrictEqual([...dirs].sort(), [-1, 1]);
  });

  test('rejects a non-array events argument', () => {
    assert.throws(() => tripleBarrier(b, 5), /must be an array/);
  });
});

describe('labelSpans feeding purgedKFold', () => {
  test('spans run from event to exit and drive real purging', () => {
    const b = barsFromPath(randomWalk({ n: 300, seed: 41 }), { noise: 0.01, seed: 42 });
    const events = Array.from({ length: 50 }, (_, i) => 30 + i * 5);
    const { labels } = tripleBarrier(b, events, { profit_mult: 2, stop_mult: 1, max_bars: 20 });
    const spans = labelSpans(labels);

    for (let i = 0; i < spans.length; i++) {
      assert.ok(spans[i][1] >= spans[i][0], 'a label cannot resolve before it starts');
    }

    const naive = purgedKFold(spans.length, { k: 5, embargo_pct: 0 });
    const purged = purgedKFold(spans.length, { k: 5, label_spans: spans, embargo_pct: 0 });
    assert.ok(purged.total_purged >= naive.total_purged,
      'overlapping label windows must purge at least as much as point labels');
  });
});
