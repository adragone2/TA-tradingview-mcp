import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';

import { ZONE_NOISE_BASELINE } from '../src/core/zones.js';
import { WYCKOFF_NOISE_BASELINE, findSpringsUpthrusts, classifyPhase } from '../src/core/wyckoff.js';
import { ELLIOTT_NOISE_BASELINE, surveyCounts } from '../src/core/elliott.js';
import { BREAKOUT_NOISE_BASELINE } from '../src/core/breakout.js';
import { DIVERGENCE_NOISE_BASELINE, surveyDivergences } from '../src/core/divergence.js';
import { findZones } from '../src/core/zones.js';
import { barsFromPath, randomWalk } from '../src/core/synthetic.js';

const walk = (s) => barsFromPath(randomWalk({ n: 200, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });

describe('every detector carries a measured noise floor', () => {
  /**
   * CLAUDE.md: "A result without a trial count flatters itself." Five detectors
   * shipped without one and a 2026-07-28 audit found them. This asserts they
   * cannot regress to a placeholder.
   */
  const BASELINES = {
    zones: ZONE_NOISE_BASELINE,
    wyckoff: WYCKOFF_NOISE_BASELINE,
    elliott: ELLIOTT_NOISE_BASELINE,
    breakout: BREAKOUT_NOISE_BASELINE,
    divergence: DIVERGENCE_NOISE_BASELINE,
  };

  for (const [name, b] of Object.entries(BASELINES)) {
    test(`${name} is measured, not a placeholder`, () => {
      assert.equal(b.measured, true);
      assert.equal(b.walks, 200);
      assert.ok(b.note && b.note.length > 40, 'a bare number without its reading is not enough');
    });
  }

  test('no core module claims a baseline it never measured', () => {
    for (const f of readdirSync('src/core').filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(`src/core/${f}`, 'utf8');
      if (!/NOISE_BASELINE\s*=/.test(src)) continue;
      assert.ok(!/measured:\s*false/.test(src), `src/core/${f} declares measured: false`);
    }
  });
});

describe('the numbers still hold', () => {
  /**
   * Regimes, not digits — a detector drifting from "fires on almost everything"
   * to "fires on almost nothing" is what matters, and asserting the exact
   * percentage would just break on any threshold change.
   */
  const N = 60;

  test('divergence: a LONE divergence is near-universal in noise', () => {
    let any = 0;
    for (let s = 0; s < N; s++) {
      const d = surveyDivergences(walk(s));
      if ((d.runs || []).some((r) => (r.shown || 0) > 0)) any++;
    }
    assert.ok((any / N) * 100 > 80, `only ${any}/${N} — the 99% baseline no longer describes this`);
  });

  test('divergence: AGREEMENT is what discriminates', () => {
    let agreeing = 0;
    for (let s = 0; s < N; s++) {
      if ((surveyDivergences(walk(s)).agreeing_indicators || []).length >= 2) agreeing++;
    }
    const pct = (agreeing / N) * 100;
    // The whole justification for the agreement rule: it must be far rarer.
    assert.ok(pct < 40, `2+ indicators agreed on ${pct.toFixed(1)}% of walks — the filter has stopped filtering`);
  });

  test('wyckoff: classifyPhase never abstains, so a phase is descriptive', () => {
    let confident = 0;
    for (let s = 0; s < N; s++) {
      const p = classifyPhase(walk(s));
      if (p?.phase && !/undeterm|unclear|none/i.test(p.phase)) confident++;
    }
    assert.ok((confident / N) * 100 > 90,
      'classifyPhase started abstaining — good, but the baseline and its note need re-measuring');
  });

  test('wyckoff: springs and upthrusts stay absent from noise', () => {
    let hits = 0;
    for (let s = 0; s < N; s++) hits += (findSpringsUpthrusts(walk(s)).events || []).length;
    assert.equal(hits, 0, `springs fired ${hits} times on ${N} random walks — was 0 of 200`);
  });

  test('elliott: rule-valid counts exist on most random walks', () => {
    let withCount = 0;
    for (let s = 0; s < N; s++) if ((surveyCounts(walk(s)).total_valid_counts || 0) > 0) withCount++;
    assert.ok((withCount / N) * 100 > 50,
      'rule-valid counts became rare in noise — re-measure before trusting a count');
  });

  test('zones: found on nearly every random walk', () => {
    let any = 0;
    for (let s = 0; s < N; s++) if ((findZones(walk(s)).zones || []).length) any++;
    assert.ok((any / N) * 100 > 85, `zones on only ${any}/${N} walks — the 99.5% baseline is stale`);
  });
});
