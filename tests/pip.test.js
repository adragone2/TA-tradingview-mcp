import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  findPIPs, gridRow, fitByPip, fitByRank, matchBullFlag, scanBullFlag,
  PIP_TEMPLATES, PIP_DEFAULTS, PIP_NOISE_BASELINE, PIP_REPLICATION, PIP_THRESHOLD_PROVENANCE,
} from '../src/core/pip.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

/** A textbook bull flag over 20 closes: pole, shallow flag, breakout past the pole high. */
const bullFlag = () => [
  ...Array.from({ length: 10 }, (_, i) => 80 + i * 2.2),   // pole 80 -> 99.8
  ...Array.from({ length: 8 }, (_, i) => 100 - i * 0.55),  // flag 100 -> 96.15
  104, 109,                                                // breakout
];

const downtrend = () => Array.from({ length: 20 }, (_, i) => 110 - i * 1.5);
const bearFlag = () => Array.from({ length: 20 }, (_, i) => (i < 10 ? 110 - i * 2.2 : 88 + ((i - 10) % 8) * 0.55));
const flatLine = () => Array.from({ length: 20 }, () => 100);

describe('findPIPs — the downsampling', () => {
  test('the first and last points are always kept', () => {
    const v = [5, 9, 3, 8, 2, 7, 4, 6, 1, 10, 5, 2];
    const pips = findPIPs(v, 5);
    assert.equal(pips[0], 0);
    assert.equal(pips[pips.length - 1], v.length - 1);
  });

  test('exactly k points come back, in ascending index order', () => {
    const v = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3) * 10 + 100);
    for (const k of [2, 5, 10, 20]) {
      const pips = findPIPs(v, k);
      assert.equal(pips.length, k, `asked for ${k}, got ${pips.length}`);
      for (let i = 1; i < pips.length; i++) assert.ok(pips[i] > pips[i - 1], 'indices out of order');
    }
  });

  test('the sharpest turn is picked before anything else', () => {
    // A straight line with one spike. The spike must be the third PIP.
    const v = Array.from({ length: 21 }, (_, i) => 100 + i * 0.1);
    v[10] = 130;
    assert.deepEqual(findPIPs(v, 3), [0, 10, 20]);
  });

  test('a straight line has no interior turns, so PIPs are arbitrary but complete', () => {
    const v = Array.from({ length: 20 }, (_, i) => 100 + i);
    const pips = findPIPs(v, 6);
    assert.equal(pips.length, 6);
    assert.equal(pips[0], 0);
    assert.equal(pips[5], 19);
  });

  test('a series shorter than k comes back whole rather than padded', () => {
    assert.deepEqual(findPIPs([1, 2, 3], 10), [0, 1, 2]);
  });

  test('junk in, empty out — never a throw and never an invented point', () => {
    assert.deepEqual(findPIPs(null, 5), []);
    assert.deepEqual(findPIPs([], 5), []);
    assert.deepEqual(findPIPs([1, null, 3], 3), []);
    assert.deepEqual(findPIPs([1, undefined, 3], 3), []);
  });

  test('the perpendicular measure runs and normalises both axes', () => {
    const v = Array.from({ length: 21 }, (_, i) => 100 + i * 0.1);
    v[10] = 130;
    // The spike dominates under either measure; what matters is that a price
    // axis in the thousands does not swamp a bar-index axis in the tens.
    assert.deepEqual(findPIPs(v, 3, { distance: 'perpendicular' }), [0, 10, 20]);
    const scaled = v.map((x) => x * 1000);
    assert.deepEqual(findPIPs(scaled, 3, { distance: 'perpendicular' }), [0, 10, 20]);
  });
});

describe('gridRow — the price-to-row mapping', () => {
  test('the window high is row 0 and the window low is the last row', () => {
    assert.equal(gridRow(100, 80, 100, 10), 0);
    assert.equal(gridRow(80, 80, 100, 10), 9);
    assert.equal(gridRow(90, 80, 100, 10), 5);
  });

  test('a flat window returns null — there is no shape in a straight line', () => {
    /**
     * The alternative, returning the middle row, was tried: it scored a
     * perfectly flat 20-close window at 3.7, above the published threshold and
     * above a real bull flag. A degenerate input has to refuse, not average.
     */
    assert.equal(gridRow(100, 100, 100, 10), null);
  });

  test('nulls do not become zeroes', () => {
    assert.equal(gridRow(null, 80, 100, 10), null);
    assert.equal(gridRow(90, null, 100, 10), null);
  });
});

describe('the templates are transcribed, not invented', () => {
  test('both are 10x10', () => {
    for (const t of Object.values(PIP_TEMPLATES)) {
      assert.equal(t.weights.length, 10, `${t.name} has ${t.weights.length} rows`);
      for (const row of t.weights) assert.equal(row.length, 10, `${t.name} has a row of ${row.length}`);
    }
  });

  test('each template matches the range printed in its source figure', () => {
    for (const t of Object.values(PIP_TEMPLATES)) {
      const flatW = t.weights.flat();
      assert.equal(Math.min(...flatW), t.range_printed[0], `${t.name} min weight`);
      assert.equal(Math.max(...flatW), t.range_printed[1], `${t.name} max weight`);
    }
  });

  test('the caption/figure discrepancy in Wang & Chan is recorded, not reconciled away', () => {
    const t = PIP_TEMPLATES.wang_chan_2007;
    assert.notDeepEqual(t.range_printed, t.range_in_caption);
    assert.equal(t.range_printed[0], -1.6);
    assert.equal(t.range_in_caption[0], -1.65);
  });

  test('every template names where it came from', () => {
    for (const t of Object.values(PIP_TEMPLATES)) {
      assert.match(t.source, /^Fernandes \(2022\)/);
      assert.match(t.source, /https?:\/\//);
      assert.ok(t.fitted_on, `${t.name} does not say what it was fitted on`);
    }
  });

  test('Leigh/Purvis/Ragusa says out loud that it used volume, which this module does not have', () => {
    assert.match(PIP_TEMPLATES.leigh_purvis_ragusa_2002.fitted_on, /volumes.*closes only/s);
  });

  test('the Wang & Chan shape reads bottom-left to top-right, as a bull flag must', () => {
    // Column 0's best row should be near the bottom; column 9's near the top.
    const w = PIP_TEMPLATES.wang_chan_2007.weights;
    const bestRow = (col) => w.map((r, i) => [r[col], i]).sort((a, b) => b[0] - a[0])[0][1];
    assert.ok(bestRow(0) >= 8, `column 0 rewards row ${bestRow(0)} — the pole should start low`);
    assert.ok(bestRow(9) <= 2, `column 9 rewards row ${bestRow(9)} — the breakout should end high`);
  });
});

describe('fitByRank — the paper\'s own mapping', () => {
  test('the maximum possible fit is the grid size', () => {
    const r = fitByRank(bullFlag(), PIP_TEMPLATES.wang_chan_2007);
    assert.ok(r.fit <= 10, `fit ${r.fit} exceeds the stated maximum of 10`);
  });

  test('each column carries p/10 days, so a column contributes at most its own weight', () => {
    const r = fitByRank(bullFlag(), PIP_TEMPLATES.wang_chan_2007);
    assert.equal(r.days_per_column, 2);
    const byCol = {};
    for (const c of r.cells) byCol[c.column] = (byCol[c.column] || 0) + c.contribution;
    for (const [col, total] of Object.entries(byCol)) {
      assert.ok(Math.abs(total) <= 10, `column ${col} contributed ${total}`);
    }
  });

  test('it uses only the ORDERING, so a monotone rescale cannot move it', () => {
    const v = bullFlag();
    const a = fitByRank(v, PIP_TEMPLATES.wang_chan_2007).fit;
    // Squash the amplitude without changing any ordering.
    const b = fitByRank(v.map((x) => 100 + (x - 100) * 0.05), PIP_TEMPLATES.wang_chan_2007).fit;
    assert.equal(a, b, 'the rank mapping moved on a monotone rescale — it is no longer rank-based');
  });

  test('a flat window is refused rather than scored on the template diagonal', () => {
    const r = fitByRank(flatLine(), PIP_TEMPLATES.wang_chan_2007);
    assert.equal(r.fit, null);
    assert.equal(r.reason, 'flat_window');
  });
});

describe('fitByPip — our mapping', () => {
  test('it samples the PIP skeleton on the TIME axis, one cell per column', () => {
    const r = fitByPip(bullFlag(), PIP_TEMPLATES.wang_chan_2007);
    assert.equal(r.cells.length, 10);
    r.cells.forEach((c, i) => assert.equal(c.column, i));
    // and the sample points advance through the window
    for (let i = 1; i < r.cells.length; i++) assert.ok(r.cells[i].at_bar > r.cells[i - 1].at_bar);
  });

  test('it is scale-sensitive where the rank mapping is not', () => {
    // The whole reason both are reported: depth matters here and not there.
    const v = bullFlag();
    const deep = fitByPip(v, PIP_TEMPLATES.wang_chan_2007).fit;
    const shallow = fitByPip(v.map((x) => 100 + (x - 100) * 0.05), PIP_TEMPLATES.wang_chan_2007).fit;
    assert.equal(deep, shallow,
      'a pure rescale should not move it either — rows come from the window\'s own high and low');

    // But changing the SHAPE's proportions must move it.
    const shallowFlag = [
      ...Array.from({ length: 10 }, (_, i) => 80 + i * 2.2),
      ...Array.from({ length: 8 }, (_, i) => 100 - i * 0.1),
      104, 109,
    ];
    assert.notEqual(fitByPip(shallowFlag, PIP_TEMPLATES.wang_chan_2007).fit, deep);
  });

  test('a flat window is refused, and says why', () => {
    const r = fitByPip(flatLine(), PIP_TEMPLATES.wang_chan_2007);
    assert.equal(r.fit, null);
    assert.equal(r.reason, 'flat_window');
    assert.match(r.note, /no price range/);
  });

  test('a null close is refused, not coerced to zero', () => {
    const v = bullFlag();
    v[5] = null;
    assert.equal(fitByPip(v, PIP_TEMPLATES.wang_chan_2007).reason, 'non_numeric_close');
    assert.equal(fitByRank(v, PIP_TEMPLATES.wang_chan_2007).reason, 'non_numeric_close');
  });

  test('too few closes is refused rather than padded', () => {
    assert.equal(fitByPip([1, 2, 3], PIP_TEMPLATES.wang_chan_2007).reason, 'too_few_closes');
  });
});

describe('matchBullFlag — does the template rank the shapes sensibly', () => {
  test('a textbook bull flag scores well above a downtrend under both mappings', () => {
    const flag = matchBullFlag(bullFlag(), { window: 20 });
    const down = matchBullFlag(downtrend(), { window: 20 });
    assert.ok(flag.by_mapping.pip > down.by_mapping.pip + 2,
      `pip: flag ${flag.by_mapping.pip} vs downtrend ${down.by_mapping.pip}`);
    assert.ok(flag.by_mapping.rank > down.by_mapping.rank + 1,
      `rank: flag ${flag.by_mapping.rank} vs downtrend ${down.by_mapping.rank}`);
  });

  test('a bull flag scores above a bear flag', () => {
    const bull = matchBullFlag(bullFlag(), { window: 20 });
    const bear = matchBullFlag(bearFlag(), { window: 20 });
    assert.ok(bull.by_mapping.pip > bear.by_mapping.pip);
    assert.ok(bull.by_mapping.rank > bear.by_mapping.rank);
  });

  test('the constructed flag clears the threshold that noise mostly does not', () => {
    // PIP_NOISE_BASELINE: 1.2% of random-walk windows reach 6.0.
    const r = matchBullFlag(bullFlag(), { window: 20, mapping: 'pip' });
    assert.ok(r.fit >= 6, `the constructed flag scored ${r.fit}; the baseline text quotes 6.35`);
  });

  test('accepts bars as well as raw closes', () => {
    const closes = bullFlag();
    const bars = closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
    assert.equal(matchBullFlag(bars, { window: 20 }).fit, matchBullFlag(closes, { window: 20 }).fit);
  });

  test('both mappings are always reported, and disagreement is called out', () => {
    const r = matchBullFlag(bullFlag(), { window: 20 });
    assert.ok('pip' in r.by_mapping && 'rank' in r.by_mapping);
    assert.equal(typeof r.mappings_agree, 'boolean');

    // A shallow flag is where they part company: rank ignores magnitude.
    const shallow = [
      ...Array.from({ length: 10 }, (_, i) => 80 + i * 2.2),
      ...Array.from({ length: 8 }, (_, i) => 100 - i * 0.55),
      99, 100.6,
    ];
    const s = matchBullFlag(shallow, { window: 20, min_fit: 3 });
    assert.equal(s.mappings_agree, false, `pip ${s.by_mapping.pip}, rank ${s.by_mapping.rank}`);
    assert.match(s.disagreement, /SHAPE.*SCHEDULE/s);
  });

  test('it returns NO entry, stop or target', () => {
    const r = matchBullFlag(bullFlag(), { window: 20 });
    for (const k of ['entry', 'stop', 'target', 'signal', 'direction', 'action']) {
      assert.ok(!(k in r), `matchBullFlag returned "${k}" — it is a score, not a plan`);
    }
    assert.match(r.what_this_is_not, /not a signal/);
  });

  test('short input, unknown template and a flat window all report rather than throw', () => {
    assert.equal(matchBullFlag([1, 2, 3], { window: 20 }).reason, 'insufficient_bars');
    assert.equal(matchBullFlag(bullFlag(), { template: 'nope' }).reason, 'unknown_template');
    assert.equal(matchBullFlag(flatLine(), { window: 20 }).fit, null);
    for (const junk of [null, undefined, [], [null, null]]) {
      assert.doesNotThrow(() => matchBullFlag(junk, { window: 20 }));
    }
  });

  test('the other template can be selected and gives a different answer', () => {
    const a = matchBullFlag(bullFlag(), { window: 20, template: 'wang_chan_2007' });
    const b = matchBullFlag(bullFlag(), { window: 20, template: 'leigh_purvis_ragusa_2002' });
    assert.notEqual(a.fit, b.fit);
    assert.equal(b.template, 'leigh_purvis_ragusa_2002');
  });
});

describe('the threshold carries its provenance, and its limits', () => {
  test('the default threshold, window and template come from the same published result', () => {
    assert.equal(PIP_DEFAULTS.min_fit, 3.0);
    assert.equal(PIP_DEFAULTS.window, 20);
    assert.equal(PIP_DEFAULTS.template, 'wang_chan_2007');
    assert.match(PIP_THRESHOLD_PROVENANCE.where_it_comes_from, /p = 20 and T = 3/);
  });

  test('it says plainly that the threshold does not transfer between mappings', () => {
    assert.match(PIP_THRESHOLD_PROVENANCE.the_catch, /does NOT transfer/);
  });

  test('the replication record travels with every match', () => {
    const r = matchBullFlag(bullFlag(), { window: 20 });
    assert.equal(r.replication, PIP_REPLICATION);
    assert.match(PIP_REPLICATION.read_as, /not evidence of an edge/);
    assert.match(PIP_REPLICATION.the_problem_with_all_of_it, /trial count/);
  });
});

describe('PIP_NOISE_BASELINE — the floor', () => {
  test('it is measured, with walks, window and generator recorded', () => {
    assert.equal(PIP_NOISE_BASELINE.measured, true);
    assert.equal(PIP_NOISE_BASELINE.walks, 200);
    assert.equal(PIP_NOISE_BASELINE.window, 20);
    assert.match(PIP_NOISE_BASELINE.generator, /closes only/);
  });

  test('the floor is reported at several thresholds, not just the published one', () => {
    for (const mapping of ['pip', 'rank']) {
      const rows = PIP_NOISE_BASELINE.by_threshold.wang_chan_2007[mapping];
      assert.ok(Object.keys(rows).length >= 5, `${mapping} has too few thresholds to pick one from`);
      for (const [t, v] of Object.entries(rows)) {
        assert.equal(typeof v.windows_pct, 'number', `${mapping} ${t} has no windows_pct`);
        assert.equal(typeof v.walks_with_any_pct, 'number', `${mapping} ${t} has no walks_with_any_pct`);
      }
    }
  });

  test('the rate falls monotonically as the threshold rises', () => {
    for (const mapping of ['pip', 'rank']) {
      const vals = Object.values(PIP_NOISE_BASELINE.by_threshold.wang_chan_2007[mapping]).map((v) => v.windows_pct);
      for (let i = 1; i < vals.length; i++) {
        assert.ok(vals[i] <= vals[i - 1], `${mapping} rate rose from ${vals[i - 1]} to ${vals[i]}`);
      }
    }
  });

  test('the published threshold is recorded as NOT selective', () => {
    const at3 = PIP_NOISE_BASELINE.by_threshold.wang_chan_2007.rank['T>=3.0'];
    assert.ok(at3.windows_pct > 5, 'if T=3 became selective the headline needs rewriting');
    assert.match(PIP_NOISE_BASELINE.headline, /not scarcity/);
  });

  test('it explains why PIP is looser rather than presenting it as a result', () => {
    assert.match(PIP_NOISE_BASELINE.pip_is_looser_than_rank, /structural/);
    assert.match(PIP_NOISE_BASELINE.rank_ignores_magnitude, /ORDERING/);
  });

  test('selectivity is not claimed as accuracy', () => {
    assert.match(PIP_NOISE_BASELINE.caveat, /Selectivity is not accuracy/);
    assert.match(PIP_NOISE_BASELINE.caveat, /No forward test/);
  });
});

describe('the numbers still hold', () => {
  /** Regimes, not digits — the same rule the other noise tests follow. */
  const N = 25;
  const walk = (s) => barsFromPath(randomWalk({ n: 200, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });

  test('the published threshold matches a large share of pure-noise windows', () => {
    let hits = 0, windows = 0;
    for (let s = 0; s < N; s++) {
      const r = scanBullFlag(walk(s), { mapping: 'rank', min_fit: 3, window: 20 });
      hits += r.count; windows += r.windows_scored;
    }
    const pct = (hits / windows) * 100;
    assert.ok(pct > 2, `only ${pct.toFixed(1)}% of noise windows meet T=3 — the 6.7% baseline is stale`);
  });

  test('raising the threshold to 6 empties the rank mapping', () => {
    let hits = 0;
    for (let s = 0; s < N; s++) hits += scanBullFlag(walk(s), { mapping: 'rank', min_fit: 6, window: 20 }).count;
    assert.equal(hits, 0, `rank fired ${hits} times at T=6 — the baseline says 0.0% of walks`);
  });

  test('PIP stays looser than rank at every threshold, as recorded', () => {
    for (const T of [3, 5]) {
      let pip = 0, rank = 0;
      for (let s = 0; s < N; s++) {
        pip += scanBullFlag(walk(s), { mapping: 'pip', min_fit: T, window: 20 }).count;
        rank += scanBullFlag(walk(s), { mapping: 'rank', min_fit: T, window: 20 }).count;
      }
      assert.ok(pip > rank, `at T=${T} pip ${pip} is no longer looser than rank ${rank}`);
    }
  });

  test('scanBullFlag reports how many windows it scored, not just its hits', () => {
    // A hit count with no denominator is the flattering half of the number.
    const r = scanBullFlag(walk(0), { min_fit: 3, window: 20 });
    assert.ok(r.windows_scored > 100);
    assert.equal(typeof r.rate_pct, 'number');
  });
});

describe('the detector stays unexposed while unreviewed', () => {
  test('it is not registered as an MCP tool', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const hits = readdirSync('src/tools')
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /core\/pip\.js|matchBullFlag|scanBullFlag|findPIPs/.test(readFileSync(`src/tools/${f}`, 'utf8')));
    assert.deepEqual(hits, [],
      `pip.js is consumed by ${hits.join(', ')} but it has not been through review`);
  });
});

// ---------------------------------------------------------------------------
// Reviewer addition 2026-07-30: the real-data arm, run on the live chart over
// 20 large caps (scripts/gaps-real-arm.js). The finding worth pinning: at the
// PUBLISHED threshold the PIP mapping matches real charts and pure noise at
// the same rate — 17.6% vs 17.1% of windows. Real charts trend; a bull-flag
// template firing no more on real data than on noise is not seeing flags.
// ---------------------------------------------------------------------------
describe('PIP_NOISE_BASELINE.real_arm', () => {
  const ra = PIP_NOISE_BASELINE.real_arm;
  test('exists, with both sides of every rate', () => {
    assert.ok(ra, 'real_arm block missing');
    for (const mapping of ['pip', 'rank']) {
      for (const row of Object.values(ra.windows_pct[mapping])) {
        assert.ok(Number.isFinite(row.real) && Number.isFinite(row.null));
      }
    }
  });
  test('records zero discrimination at the published threshold', () => {
    const t3 = ra.windows_pct.pip['T>=3.0'];
    assert.ok(Math.abs(t3.real - t3.null) < 1.0, 'if this widened, the verdict below is stale — rewrite it');
    assert.match(ra.verdict, /ZERO discrimination/);
  });
});
