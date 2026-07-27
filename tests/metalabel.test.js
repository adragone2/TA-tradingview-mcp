import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  trainMetaModel, metaPredict, evaluateMetaModel, buildMetaRows,
} from '../src/core/metalabel.js';
import { tripleBarrier, labelSpans } from '../src/core/labeling.js';
import { barsFromPath, randomWalk, rng } from '../src/core/synthetic.js';

/** Rows where one feature genuinely predicts the label, and two are noise. */
function learnableRows(n = 200, seed = 3) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const signal = r();
    const win = signal > 0.5 ? r() < 0.85 : r() < 0.15;   // strong but not perfect
    return {
      index: i, exit_index: i + 5,
      label: win ? 1 : 0,
      ret: win ? 0.02 : -0.01,
      features: { useful: signal, noise_a: r(), noise_b: r() },
    };
  });
}

/** Rows where nothing predicts anything. */
function uselessRows(n = 200, seed = 4) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    index: i, exit_index: i + 5,
    label: r() < 0.5 ? 1 : 0,
    ret: r() < 0.5 ? 0.02 : -0.01,
    features: { noise_a: r(), noise_b: r(), noise_c: r() },
  }));
}

describe('trainMetaModel', () => {
  test('finds the predictive feature and ignores the noise', () => {
    const m = trainMetaModel(learnableRows());
    assert.ok(m.trained);
    const useful = m.stumps.filter((s) => s.feature === 'useful').length;
    assert.ok(useful / m.stumps.length > 0.6,
      `expected most stumps to pick 'useful', got ${useful}/${m.stumps.length}`);
  });

  test('refuses to train on too few events rather than memorising them', () => {
    const m = trainMetaModel(learnableRows(10));
    assert.strictEqual(m.trained, false);
    assert.match(m.note, /memorises rather than learns/);
  });

  test('is reproducible for a given seed', () => {
    const a = trainMetaModel(learnableRows(), { seed: 42 });
    const b = trainMetaModel(learnableRows(), { seed: 42 });
    assert.deepStrictEqual(a.rules, b.rules);
  });

  test('exposes its rules as readable sentences', () => {
    const m = trainMetaModel(learnableRows());
    assert.ok(m.rules.length > 0);
    assert.match(m.rules[0], /^\w+ (>|<=) [\d.-]+$/);
  });
});

describe('metaPredict', () => {
  test('votes higher for feature values on the predictive side', () => {
    const m = trainMetaModel(learnableRows());
    const hi = metaPredict(m, { useful: 0.95, noise_a: 0.5, noise_b: 0.5 });
    const lo = metaPredict(m, { useful: 0.05, noise_a: 0.5, noise_b: 0.5 });
    assert.ok(hi > lo, `expected a higher vote for the winning side: ${hi} vs ${lo}`);
  });

  test('returns null for an untrained model', () => {
    assert.strictEqual(metaPredict({ trained: false }, { a: 1 }), null);
  });

  test('abstains on missing features rather than guessing', () => {
    const m = trainMetaModel(learnableRows());
    assert.strictEqual(metaPredict(m, {}), null);
  });
});

describe('evaluateMetaModel — the comparison that decides it', () => {
  test('reports a precision LIFT when a real relationship exists', () => {
    const rows = learnableRows(300);
    const out = evaluateMetaModel(rows, { k: 5, label_spans: rows.map((r) => [r.index, r.exit_index]) });
    assert.ok(out.evaluated);
    assert.ok(out.precision_lift > 0, `expected a lift, got ${out.precision_lift}`);
    assert.match(out.verdict, /helps|marginal/);
  });

  test('DOES NOT claim to help when the features are pure noise', () => {
    const rows = uselessRows(300);
    const out = evaluateMetaModel(rows, { k: 5, label_spans: rows.map((r) => [r.index, r.exit_index]) });
    assert.ok(out.evaluated);
    assert.ok(out.precision_lift < 0.05,
      `noise features must not produce a real lift, got ${out.precision_lift}`);
    assert.match(out.verdict, /does NOT help|marginal/);
  });

  test('always reports the take-everything baseline', () => {
    const rows = learnableRows(300);
    const out = evaluateMetaModel(rows, { k: 5 });
    assert.ok(out.primary_baseline.precision > 0);
    assert.match(out.primary_baseline.description, /Take EVERY primary signal/);
  });

  test('reports total return, not just the mean', () => {
    const rows = learnableRows(300);
    const out = evaluateMetaModel(rows, { k: 5 });
    assert.ok(out.returns.total_return_taken !== undefined);
    assert.match(out.returns.note, /less money/);
  });

  test('purges overlapping label windows', () => {
    const rows = learnableRows(300).map((r) => ({ ...r, exit_index: r.index + 30 }));
    const out = evaluateMetaModel(rows, { k: 5, label_spans: rows.map((r) => [r.index, r.exit_index]) });
    assert.ok(out.purged_rows > 0, 'long label windows must cause purging');
  });

  test('refuses to evaluate too small a sample', () => {
    const out = evaluateMetaModel(learnableRows(20));
    assert.strictEqual(out.evaluated, false);
    assert.match(out.note, /floor for a/);
  });

  test('carries the needs-a-good-primary caveat', () => {
    const out = evaluateMetaModel(learnableRows(300), { k: 5 });
    assert.match(out.caveat, /needs a good primary model/);
  });
});

describe('buildMetaRows', () => {
  const bars = barsFromPath(randomWalk({ n: 400, seed: 51 }), { noise: 0.01, seed: 52 });
  const events = Array.from({ length: 50 }, (_, i) => 30 + i * 6);

  test('turns triple-barrier labels into binary meta rows with spans', () => {
    const { labels } = tripleBarrier(bars, events, { profit_mult: 2, stop_mult: 1, max_bars: 20 });
    const out = buildMetaRows(bars, events, labels, (i) => ({ close: bars[i].close }));
    assert.ok(out.rows.length > 0);
    for (const r of out.rows) assert.ok(r.label === 0 || r.label === 1, 'meta labels are binary');
    assert.strictEqual(out.spans.length, out.rows.length);
  });

  test('timed-out trades become 0, not dropped', () => {
    const { labels } = tripleBarrier(bars, events, { profit_mult: 50, stop_mult: 50, max_bars: 5 });
    const out = buildMetaRows(bars, events, labels, (i) => ({ close: bars[i].close }));
    const zeros = out.rows.filter((r) => r.label === 0).length;
    assert.ok(zeros > 0);
    assert.match(out.note, /Timed-out trades count as 0, not as missing/);
  });

  test('spans feed straight into purged CV', () => {
    const { labels } = tripleBarrier(bars, events, { profit_mult: 2, stop_mult: 1, max_bars: 20 });
    const out = buildMetaRows(bars, events, labels, (i) => ({ close: bars[i].close }));
    assert.deepStrictEqual(out.spans, labelSpans(labels.filter((l) => l.label != null)));
  });

  test('states the no-look-ahead contract it cannot enforce', () => {
    const { labels } = tripleBarrier(bars, events, { profit_mult: 2, stop_mult: 1, max_bars: 20 });
    const out = buildMetaRows(bars, events, labels, (i) => ({ close: bars[i].close }));
    assert.match(out.contract, /not checked and cannot be/);
  });

  test('rejects mismatched events and labels', () => {
    assert.throws(() => buildMetaRows(bars, [1, 2], [{ label: 1 }], () => ({})), /one to one/);
  });

  test('rejects a non-function feature builder', () => {
    assert.throws(() => buildMetaRows(bars, [1], [{ label: 1 }], null), /must be a function/);
  });
});
