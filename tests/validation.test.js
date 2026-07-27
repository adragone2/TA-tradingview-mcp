import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  normalCdf, normalInv, moments, sharpeRatio, probabilisticSharpe,
  expectedMaxSharpe, deflatedSharpe, minTrackRecordLength,
  purgedKFold, combinatorialPurgedCV,
} from '../src/core/validation.js';
import { rng } from '../src/core/synthetic.js';

const close = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

describe('normalCdf / normalInv', () => {
  test('known values', () => {
    assert.ok(close(normalCdf(0), 0.5, 1e-9));
    assert.ok(close(normalCdf(1.959964), 0.975, 1e-6));
    assert.ok(close(normalCdf(-1.959964), 0.025, 1e-6));
  });

  test('normalInv inverts normalCdf', () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
      assert.ok(close(normalCdf(normalInv(p)), p, 1e-6), `round trip failed at p=${p}`);
    }
  });

  test('normalInv rejects out-of-range p', () => {
    assert.throws(() => normalInv(0), /0 < p < 1/);
    assert.throws(() => normalInv(1), /0 < p < 1/);
  });
});

describe('moments', () => {
  test('symmetric series has ~zero skew and kurtosis near 3 is not assumed', () => {
    const m = moments([-2, -1, 0, 1, 2]);
    assert.ok(close(m.mean, 0, 1e-12));
    assert.ok(Math.abs(m.skewness) < 1e-12);
  });

  test('left-skewed series reports negative skew', () => {
    const m = moments([-10, 1, 1, 1, 1, 1]);
    assert.ok(m.skewness < 0, `expected negative skew, got ${m.skewness}`);
  });

  test('refuses a series too short to have a variance', () => {
    assert.throws(() => moments([0.01]), /at least 2/);
  });
});

describe('probabilisticSharpe', () => {
  test('PSR rises with sample length for the same Sharpe', () => {
    const short = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.02 : -0.01));
    const long = Array.from({ length: 300 }, (_, i) => (i % 2 ? 0.02 : -0.01));
    const a = probabilisticSharpe(short).psr;
    const b = probabilisticSharpe(long).psr;
    assert.ok(b > a, `more data should raise PSR: short=${a} long=${b}`);
  });

  test('negative skew penalises PSR against an otherwise identical series', () => {
    // Same mean and SD, opposite skew.
    const base = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01];
    const leftTail = [...base, -0.20];
    const rightTail = [...base.map((x) => -x), 0.20];
    const l = probabilisticSharpe(leftTail);
    const r = probabilisticSharpe(rightTail);
    assert.ok(l.skewness < 0 && r.skewness > 0, 'fixture should have opposite skew');
  });
});

describe('expectedMaxSharpe — the number the module exists for', () => {
  test('a single trial needs no correction', () => {
    assert.strictEqual(expectedMaxSharpe(1, 0.25), 0);
  });

  test('expected best Sharpe grows with the number of trials', () => {
    const v = 0.25;
    const a = expectedMaxSharpe(10, v);
    const b = expectedMaxSharpe(100, v);
    const c = expectedMaxSharpe(1000, v);
    assert.ok(a < b && b < c, `should increase with trials: ${a}, ${b}, ${c}`);
  });

  test('with 100 trials and sd 0.5, the best of nothing still reaches a respectable Sharpe', () => {
    const sr0 = expectedMaxSharpe(100, 0.25);   // variance 0.25 => sd 0.5
    assert.ok(sr0 > 1.0 && sr0 < 1.6, `expected roughly 1.3, got ${sr0}`);
  });
});

describe('deflatedSharpe', () => {
  test('derives trials and variance from the supplied trial Sharpes', () => {
    const returns = Array.from({ length: 200 }, (_, i) => (i % 3 ? 0.004 : -0.002));
    const out = deflatedSharpe(returns, { trial_sharpes: [0.1, 0.2, -0.1, 0.3, 0.05] });
    assert.strictEqual(out.trials, 5);
    assert.ok(out.sharpe_variance > 0);
    assert.ok(out.deflated_sharpe >= 0 && out.deflated_sharpe <= 1);
  });

  test('THE PROPERTY THAT MATTERS: a winner mined from noise does not survive', () => {
    // Search 200 independent random-return series, keep the best. There is no
    // edge anywhere in this data by construction.
    const r = rng(42);
    const gauss = () => {
      // Box-Muller from the seeded uniform, so the test is reproducible.
      const u1 = Math.max(r(), 1e-12), u2 = r();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const trials = [];
    let best = null, bestSharpe = -Infinity;
    for (let t = 0; t < 200; t++) {
      const series = Array.from({ length: 250 }, () => gauss() * 0.01);
      const sr = sharpeRatio(series);
      trials.push(sr);
      if (sr > bestSharpe) { bestSharpe = sr; best = series; }
    }
    assert.ok(bestSharpe > 0, 'the best of 200 noise series should look positive');

    const naive = probabilisticSharpe(best).psr;
    const out = deflatedSharpe(best, { trial_sharpes: trials });

    assert.ok(naive > 0.9, `uncorrected PSR should look convincing, got ${naive}`);
    assert.ok(out.deflated_sharpe < 0.95,
      `deflated Sharpe must NOT clear 0.95 for a noise-mined winner, got ${out.deflated_sharpe}`);
    assert.match(out.verdict, /does NOT survive|marginal/);
  });

  test('refuses to guess the variance when trial Sharpes are not given', () => {
    const returns = Array.from({ length: 100 }, () => 0.001);
    assert.throws(() => deflatedSharpe(returns, { trials: 50 }), /sharpe_variance/);
  });

  test('says out loud that uncounted trials are invisible', () => {
    const returns = Array.from({ length: 200 }, (_, i) => (i % 3 ? 0.004 : -0.002));
    const out = deflatedSharpe(returns, { trial_sharpes: [0.1, 0.2, 0.3] });
    assert.match(out.caveat, /Every rule you tried and discarded/);
  });
});

describe('minTrackRecordLength', () => {
  test('reports insufficiency rather than a verdict when the sample is short', () => {
    const out = minTrackRecordLength(Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.011 : -0.01)));
    assert.ok(out.required_observations > 0);
    assert.strictEqual(out.have, 20);
  });

  test('a Sharpe below the benchmark can never be established', () => {
    const out = minTrackRecordLength([-0.01, -0.02, -0.01, -0.03], { benchmark_sharpe: 1 });
    assert.strictEqual(out.required_observations, null);
    assert.match(out.note, /does not exceed/);
  });
});

describe('purgedKFold', () => {
  test('train and test never overlap', () => {
    const { folds } = purgedKFold(100, { k: 5 });
    for (const f of folds) {
      const t = new Set(f.test);
      assert.ok(!f.train.some((i) => t.has(i)), `fold ${f.fold} leaked test rows into train`);
    }
  });

  test('every index appears in exactly one test fold', () => {
    const { folds } = purgedKFold(100, { k: 5 });
    const seen = new Set();
    for (const f of folds) for (const i of f.test) {
      assert.ok(!seen.has(i), `index ${i} appears in two test folds`);
      seen.add(i);
    }
    assert.strictEqual(seen.size, 100);
  });

  test('an overlapping label window is purged from training', () => {
    // Every observation's label depends on the next 10 bars.
    const n = 100;
    const spans = Array.from({ length: n }, (_, i) => [i, Math.min(n - 1, i + 10)]);
    const plain = purgedKFold(n, { k: 5, embargo_pct: 0 });
    const purged = purgedKFold(n, { k: 5, label_spans: spans, embargo_pct: 0 });
    assert.ok(purged.total_purged > plain.total_purged,
      'a 10-bar label horizon must purge more than a zero-length one');
  });

  test('rows whose labels reach into the test fold are actually gone', () => {
    const n = 50;
    const spans = Array.from({ length: n }, (_, i) => [i, Math.min(n - 1, i + 5)]);
    const { folds } = purgedKFold(n, { k: 5, label_spans: spans, embargo_pct: 0 });
    for (const f of folds) {
      const lo = f.test[0], hi = f.test[f.test.length - 1];
      for (const i of f.train) {
        const [s, e] = spans[i];
        assert.ok(!(s <= hi && e >= lo), `train row ${i} (label ${s}..${e}) overlaps test ${lo}..${hi}`);
      }
    }
  });

  test('the embargo removes rows immediately after the test fold', () => {
    const noEmbargo = purgedKFold(200, { k: 4, embargo_pct: 0 });
    const embargoed = purgedKFold(200, { k: 4, embargo_pct: 0.05 });
    assert.ok(embargoed.total_purged > noEmbargo.total_purged);
    assert.strictEqual(embargoed.folds[0].embargo_bars, 10);
  });

  test('rejects an impossible k', () => {
    assert.throws(() => purgedKFold(10, { k: 1 }), /between 2 and n/);
    assert.throws(() => purgedKFold(10, { k: 11 }), /between 2 and n/);
  });
});

describe('combinatorialPurgedCV', () => {
  test('produces the documented number of combinations and paths', () => {
    // C(6,2) = 15 combinations; paths = 15*2/6 = 5
    const out = combinatorialPurgedCV(300, { k: 6, groups_test: 2 });
    assert.strictEqual(out.combinations, 15);
    assert.strictEqual(out.backtest_paths, 5);
    assert.strictEqual(out.splits.length, 15);
  });

  test('every split keeps train and test disjoint', () => {
    const out = combinatorialPurgedCV(120, { k: 6, groups_test: 2 });
    for (const s of out.splits) {
      const t = new Set(s.test);
      assert.ok(!s.train.some((i) => t.has(i)));
    }
  });

  test('tells the user to read the distribution, not the best path', () => {
    const out = combinatorialPurgedCV(120, { k: 5, groups_test: 2 });
    assert.match(out.note, /DISTRIBUTION across paths/);
  });

  test('rejects a test-group count that leaves nothing to train on', () => {
    assert.throws(() => combinatorialPurgedCV(100, { k: 5, groups_test: 5 }), /between 1 and k-1/);
  });
});
