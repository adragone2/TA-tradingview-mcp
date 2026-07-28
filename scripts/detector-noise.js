/**
 * The random-walk baseline for the five detectors that shipped without one.
 *
 * CLAUDE.md: "A result without a trial count flatters itself." Every detector
 * here is supposed to carry the rate at which it fires on data with no pattern
 * in it — patterns, channels, VCP, pennants and the LMW definitions all do. A
 * 2026-07-28 audit found that zones, wyckoff, elliott, divergence and breakout
 * did not, so their detections have been unmeasured this whole time.
 *
 * This measures them. The numbers go into each module's own NOISE_BASELINE.
 *
 *   node scripts/detector-noise.js [--walks 200]
 */
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';
import * as Z from '../src/core/zones.js';
import * as W from '../src/core/wyckoff.js';
import * as E from '../src/core/elliott.js';
import * as D from '../src/core/divergence.js';
import * as B from '../src/core/breakout.js';

const args = process.argv.slice(2);
const i = args.indexOf('--walks');
const WALKS = i >= 0 ? Number(args[i + 1]) : 200;
const BARS = 200;

const walk = (s) => barsFromPath(randomWalk({ n: BARS, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });

/**
 * Each probe returns a NUMBER of detections on one walk. A detector that
 * always returns something (a phase, a count) is measured on whether it
 * returns a CONFIDENT something, since that is what a reader acts on.
 */
const PROBES = {
  'zones.findZones': (b) => (Z.findZones(b).zones || []).length,

  'wyckoff.classifyPhase (non-undetermined)': (b) => {
    const p = W.classifyPhase(b);
    return p && p.phase && !/undeterm|unclear|none/i.test(p.phase) ? 1 : 0;
  },
  'wyckoff.findSpringsUpthrusts': (b) => (W.findSpringsUpthrusts(b).events || []).length,

  'elliott.surveyCounts (rule-valid)': (b) => E.surveyCounts(b).total_valid_counts || 0,

  'divergence.surveyDivergences (recent)': (b) =>
    (D.surveyDivergences(b).runs || []).reduce((a, r) => a + (r.shown || 0), 0),
  'divergence — 2+ indicators agreeing': (b) =>
    (D.surveyDivergences(b).agreeing_indicators || []).length >= 2 ? 1 : 0,

  // A breakout needs a level. Use the highest high of the first 150 bars, which
  // is a level a reader would plausibly draw, and score the last 50.
  // The parameter is `direction`, not `side` — passing the wrong one threw on
  // all 200 walks and read as "never fires", which is the flattering answer.
  'breakout — any break of the prior high': (b) => {
    const level = Math.max(...b.slice(0, 150).map((x) => x.high));
    return B.scoreBreakout(b, { level, direction: 'up' }).broken ? 1 : 0;
  },
  'breakout — passing 3+ of its checks': (b) => {
    const level = Math.max(...b.slice(0, 150).map((x) => x.high));
    const r = B.scoreBreakout(b, { level, direction: 'up' });
    if (!r.broken) return 0;
    return Number(String(r.score).split(' of ')[0]) >= 3 ? 1 : 0;
  },
};

const out = {};
for (const [name, probe] of Object.entries(PROBES)) {
  let walksWithAny = 0, total = 0, errors = 0;
  for (let s = 0; s < WALKS; s++) {
    try {
      const n = probe(walk(s)) || 0;
      if (n > 0) walksWithAny++;
      total += n;
    } catch { errors++; }
  }
  out[name] = {
    walks_with_any_pct: Number(((walksWithAny / WALKS) * 100).toFixed(1)),
    per_walk: Number((total / WALKS).toFixed(2)),
    errors,
  };
}

console.log(`${WALKS} random walks of ${BARS} bars\n`);
const pad = Math.max(...Object.keys(out).map((k) => k.length));
console.log(`${'detector'.padEnd(pad)}   walks%   per-walk`);
for (const [k, v] of Object.entries(out)) {
  console.log(`${k.padEnd(pad)}   ${String(v.walks_with_any_pct).padStart(5)}   ${String(v.per_walk).padStart(7)}${v.errors ? `   (${v.errors} errors)` : ''}`);
}
console.log('\nFor comparison: structural patterns 68% of walks, LMW definitions 43.4%,');
console.log('channels 33.5% (12% stable), VCP 0%, pennants 0%.');
