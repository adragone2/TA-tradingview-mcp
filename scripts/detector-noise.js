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
import { randomWalk, barsFromPath, randomWalkWithGaps } from '../src/core/synthetic.js';
import * as Z from '../src/core/zones.js';
import * as W from '../src/core/wyckoff.js';
import * as E from '../src/core/elliott.js';
import * as D from '../src/core/divergence.js';
import * as B from '../src/core/breakout.js';
import * as G from '../src/core/gaps.js';
import * as P from '../src/core/pip.js';

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
console.log('\nFor comparison: structural patterns 75% of walks, LMW definitions 43.4%,');
console.log('channels 33.5% (12% stable), VCP 0%, pennants 0%.');
console.log('(Structural patterns was 68% before the pivot backbone; measured at 200 walks the');
console.log(' move is 58% -> 61%, so the 40-walk harness both figures come from over-reads by ~10.)');

/* ────────────────────────────────────────────────────────────────────────────
 * gaps.js — and the reason it could not use the walk above.
 *
 * `barsFromPath` builds bar i's open from path[i-1], so consecutive bars always
 * overlap and the gap condition (low > prior high) is UNREACHABLE. Measured
 * against that null every gap class scores 0.0%, which reads as a perfect
 * detector and is in fact a fixture bug — the same shape that left ignition.js
 * without a floor, where the null moved the GATE instead of the pattern.
 *
 * So the gap arm runs against randomWalkWithGaps, which injects gaps at a
 * stated rate and size. Both volume regimes are measured because the choice
 * moves the answer for every clause that reads volume, and picking one silently
 * would repeat the mistake.
 * ──────────────────────────────────────────────────────────────────────────── */

const GAP_CLASSES = ['common', 'breakaway', 'runaway', 'exhaustion', 'unclassified', 'pending'];

function gapArm(label, makeBars) {
  const walksWith = {}, totals = {};
  let anyGapWalks = 0, totalGaps = 0, errors = 0;
  for (let s = 0; s < WALKS; s++) {
    try {
      const res = G.classifyGaps(makeBars(s));
      const gaps = res.gaps || [];
      if (gaps.length) anyGapWalks++;
      totalGaps += gaps.length;
      const seen = new Set();
      for (const g of gaps) {
        totals[g.verdict] = (totals[g.verdict] || 0) + 1;
        seen.add(g.verdict);
      }
      for (const v of seen) walksWith[v] = (walksWith[v] || 0) + 1;
    } catch { errors++; }
  }
  return {
    label,
    any_gap: { walks_pct: Number(((anyGapWalks / WALKS) * 100).toFixed(1)), per_walk: Number((totalGaps / WALKS).toFixed(2)) },
    by_class: Object.fromEntries(GAP_CLASSES.map((c) => [c, {
      walks_pct: Number((((walksWith[c] || 0) / WALKS) * 100).toFixed(1)),
      per_walk: Number(((totals[c] || 0) / WALKS).toFixed(2)),
    }])),
    errors,
  };
}

const gapArms = [
  gapArm('gap-aware null, gap_elevated volume (THE FLOOR)',
    (s) => randomWalkWithGaps({ n: BARS, seed: 7000 + s, volume_mode: 'gap_elevated' }).bars),
  gapArm('gap-aware null, dispersed volume, gaps NOT elevated',
    (s) => randomWalkWithGaps({ n: BARS, seed: 7000 + s, volume_mode: 'lognormal' }).bars),
  gapArm('gap-aware null, FLAT volume (fixture contrast)',
    (s) => randomWalkWithGaps({ n: BARS, seed: 7000 + s, volume_mode: 'flat' }).bars),
  gapArm('NAIVE null — barsFromPath, no gaps injected', (s) => walk(s)),
];

console.log(`\n\n=== gaps.js — ${WALKS} walks of ${BARS} bars ===`);
for (const arm of gapArms) {
  console.log(`\n${arm.label}`);
  console.log(`  any gap at all      ${String(arm.any_gap.walks_pct).padStart(6)}%  ${String(arm.any_gap.per_walk).padStart(7)} per walk`);
  for (const c of GAP_CLASSES) {
    const v = arm.by_class[c];
    console.log(`  ${c.padEnd(18)}${String(v.walks_pct).padStart(6)}%  ${String(v.per_walk).padStart(7)} per walk`);
  }
  if (arm.errors) console.log(`  (${arm.errors} errors)`);
}
console.log('\nRead the FIRST arm as the floor. The naive arm is the contrast that justifies');
console.log('the generator: a reconstructed price path barely produces overnight gaps at all,');
console.log('so a near-zero rate there measures the fixture and not the detector.');
console.log('The real-data arm is NOT RUN here — no chart access. A class firing LESS on real');
console.log('bars than on this null means the null is broken and nothing may be quoted.');

/**
 * Breakaway and exhaustion are the only two classes with a volume clause, and
 * the three arms above already show their rates swinging from 0% to something
 * substantial purely on how the null models gap-day volume. That is the shape
 * of the defect that left ignition.js without a floor, so it gets measured
 * rather than asserted: sweep the ONE free parameter and print how far the
 * answer travels.
 */
console.log('\n--- sensitivity: gap_volume_multiple (the null\'s one free volume parameter) ---');
console.log('  multiple   breakaway walks%   exhaustion walks%');
for (const mult of [1.0, 1.5, 2.0, 2.5, 3.0]) {
  const arm = gapArm(`x${mult}`, (s) => randomWalkWithGaps({
    n: BARS, seed: 7000 + s, volume_mode: 'gap_elevated', gap_volume_multiple: mult,
  }).bars);
  console.log(`  x${mult.toFixed(1)}      ${String(arm.by_class.breakaway.walks_pct).padStart(14)}%   ${String(arm.by_class.exhaustion.walks_pct).padStart(15)}%`);
}
console.log('If these two columns move a lot, neither class has a single floor — it has a');
console.log('bracket, and the bracket is what may be quoted. common and runaway read no');
console.log('volume and are identical across every arm, so their floors ARE established.');

/* ────────────────────────────────────────────────────────────────────────────
 * pip.js — closes only, so the standard path-based null is legitimate.
 *
 * Swept across thresholds because a threshold with no floor beside it is not a
 * threshold. `windows_pct` is the number that matters: the share of ALL windows
 * in pure noise that meet T, not the share of walks containing one somewhere.
 * ──────────────────────────────────────────────────────────────────────────── */

const PIP_THRESHOLDS = [3, 4, 5, 6, 7, 8];
const PIP_MAPPINGS = ['pip', 'rank'];

console.log(`\n\n=== pip.js bull flag — ${WALKS} walks of ${BARS} bars, 20-day window ===`);
for (const mapping of PIP_MAPPINGS) {
  console.log(`\nmapping: ${mapping}   (template wang_chan_2007, max fit 10)`);
  console.log('  threshold   walks%   windows%   hits/walk');
  for (const T of PIP_THRESHOLDS) {
    let walksWithAny = 0, hits = 0, windows = 0, errors = 0;
    for (let s = 0; s < WALKS; s++) {
      try {
        const r = P.scanBullFlag(walk(s), { mapping, min_fit: T, window: 20 });
        if (r.count > 0) walksWithAny++;
        hits += r.count;
        windows += r.windows_scored;
      } catch { errors++; }
    }
    const walksPct = ((walksWithAny / WALKS) * 100).toFixed(1);
    const winPct = windows ? ((hits / windows) * 100).toFixed(1) : 'n/a';
    console.log(`  T>=${T.toFixed(1)}   ${String(walksPct).padStart(7)}   ${String(winPct).padStart(8)}   ${String((hits / WALKS).toFixed(2)).padStart(9)}${errors ? `   (${errors} errors)` : ''}`);
  }
}
console.log('\nThe published threshold is T = 3 at a 20-day window (Fernandes 2022, p = 20,');
console.log('T = 3). Read the windows% column at that row before quoting any match.');
