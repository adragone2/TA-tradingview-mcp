import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import * as C from '../src/core/context.js';
import * as D from '../src/core/divergence.js';
import * as W from '../src/core/wyckoff.js';
import * as E from '../src/core/elliott.js';
import * as momentum from '../src/core/momentum.js';
import * as stops from '../src/core/stops.js';
import { barsFromPath, randomWalk } from '../src/core/synthetic.js';

/**
 * The Sunday review reads keys off core-module results. When it reads a key
 * that does not exist, nothing complains:
 *
 *   ta_action           read from the wrong place -> null on all 51 rows
 *   div.indicators_agreeing (module returns agreeing_indicators) -> null on 50
 *   div.divergences         (module returns runs)                -> 0 on 50
 *
 * The last one is the instructive case. A missing key that lands on `.length`
 * yields **0**, and 0 reads as a legitimate measurement — "no divergences
 * found" — rather than a missing field. Null is loud; zero is silent. It
 * survived a full 50-ticker run while the `agreement` TEXT in the very same
 * block reported divergences on five tickers.
 *
 * So this checks the CONTRACT rather than the output: every key the review
 * reads off a module must be a key that module actually returns.
 */

const SRC = readFileSync('scripts/sunday-review.js', 'utf8');

/** Bars with enough shape for every module to return its full result. */
const bars = barsFromPath(randomWalk({ n: 300, vol: 0.02, seed: 42 }), { noise: 0.006, seed: 7 });

/**
 * alias -> the result the review binds to it.
 *
 * Only modules whose call is reproducible without a live chart. That is not
 * every block, and the gap is stated rather than hidden: see the coverage test.
 */
const BINDINGS = {
  reg: C.regime(bars),
  mom: momentum.momentumProfile(bars),
  div: D.surveyDivergences(bars),
  wy: W.classifyPhase(bars),
  ell: E.surveyCounts(bars),
  sp: stops.stoppingPremium(bars),
};

/** Every `alias?.key` and `alias.key` the review reads. */
function keysReadFor(alias) {
  const found = new Set();
  for (const m of SRC.matchAll(new RegExp(`\\b${alias}\\??\\.([a-zA-Z_][a-zA-Z0-9_]*)`, 'g'))) {
    found.add(m[1]);
  }
  return [...found];
}

describe('sunday-review reads only keys its modules actually return', () => {
  for (const [alias, result] of Object.entries(BINDINGS)) {
    test(`${alias}: every key read exists on the result`, () => {
      assert.ok(result && typeof result === 'object', `${alias} produced no object to check against`);
      const available = new Set(Object.keys(result));
      const read = keysReadFor(alias);
      assert.ok(read.length > 0, `no keys found for alias "${alias}" — did the extraction break?`);
      const missing = read.filter((k) => !available.has(k));
      assert.deepEqual(missing, [],
        `scripts/sunday-review.js reads ${alias}.${missing.join(`, ${alias}.`)} — `
        + `not returned by the module. Available: ${[...available].sort().join(', ')}`);
    });
  }
});

describe('the divergence block specifically', () => {
  /**
   * Pinned, because this one shipped: the structured fields said zero across a
   * whole portfolio while the prose beside them said otherwise.
   */
  test('the module returns runs and agreeing_indicators, not divergences and indicators_agreeing', () => {
    const d = D.surveyDivergences(bars);
    assert.ok('runs' in d, 'runs is gone — the review reads it');
    assert.ok('agreeing_indicators' in d);
    assert.ok(!('divergences' in d), 'a `divergences` key now exists — the old wrong read would silently start working');
    assert.ok(!('indicators_agreeing' in d));
  });

  test('the review no longer reads either wrong key', () => {
    assert.ok(!/div\??\.divergences/.test(SRC), 'sunday-review reads div.divergences again');
    assert.ok(!/div\??\.indicators_agreeing/.test(SRC), 'sunday-review reads div.indicators_agreeing again');
  });

  test('a count and its own prose cannot disagree', () => {
    // The invariant that was violated: if the agreement text names indicators
    // showing a divergence, the count must not be zero.
    for (const seed of [1, 7, 13, 21, 42, 99]) {
      const b = barsFromPath(randomWalk({ n: 300, vol: 0.02, seed }), { noise: 0.006, seed: seed + 1 });
      const d = D.surveyDivergences(b);
      const count = (d.runs || []).reduce((a, r) => a + (r.shown || 0), 0);
      const textClaimsOne = /show a recent|shows a recent/.test(d.agreement || '');
      if (textClaimsOne) {
        assert.ok(count > 0,
          `seed ${seed}: agreement says a divergence was found but the count is ${count}`);
      }
    }
  });
});

describe('coverage of this check is stated, not assumed', () => {
  test('the aliases checked here are the ones bound to a reproducible call', () => {
    // Blocks needing a live chart (relative strength vs SPY, walls, TA) cannot
    // be bound here. Naming that is the point: a contract test that silently
    // covers a third of the surface is worse than one whose limits are written
    // down, because it reads as full coverage.
    const bound = Object.keys(BINDINGS).sort();
    assert.deepEqual(bound, ['div', 'ell', 'mom', 'reg', 'sp', 'wy']);
  });
});
