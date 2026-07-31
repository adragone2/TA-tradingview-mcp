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
import * as CUP from '../src/core/cup.js';
import { detectPatterns, STRUCTURAL_PATTERNS, NOISE_BASELINE } from '../src/core/patterns.js';
import { classifyFive, LMW_NOISE_PROFILE } from '../src/core/lmw_patterns.js';
import { findKernelPivots } from '../src/core/kernel.js';

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
console.log('\nFor comparison: channels 33.5% (12% stable), VCP 0%, pennants 0%.');
console.log('Structural patterns and the LMW definitions are MEASURED below rather than quoted.');

/* ────────────────────────────────────────────────────────────────────────────
 * patterns.js — the denominator vsNoise divides by.
 *
 * `NOISE_BASELINE.per_walk` used to be three harnesses filed as one: seven rows
 * from `measure(detect, { walk_trials: 40 })` with the TEST wrapper's options
 * (lookback 4, window_bars 90, max_age_bars 400) on measure()'s null, three
 * rectangle rows from `detectPatterns` at its DEFAULTS over 200 walks of the
 * null below, and the cup from this script. Each row was measured; nothing lined
 * up, and `per_walk_provenance` sat at UNRESOLVED for it.
 *
 * It is measured HERE now because this is where the numerator's procedure can be
 * matched: `vsNoise` divides a count taken from `detectPatterns` at its
 * defaults, so the floor has to be taken the same way. Running it beside the
 * other detectors on the same null is the point — patterns.js was the one module
 * whose floor could not be compared with anything else in this file.
 *
 * The DIFF column is the part that earns its keep. A threshold change inside
 * patterns.js moves these numbers and nothing else in the repo notices; here it
 * shows up as drift against the recorded constant on the next run.
 * ──────────────────────────────────────────────────────────────────────────── */

{
  const occ = {}, walksWith = {};
  let anyWalks = 0, total = 0;
  for (let s = 0; s < WALKS; s++) {
    const names = (detectPatterns(walk(s), { lookback: 5 }).structural || []).map((p) => p.pattern);
    if (names.length) anyWalks++;
    total += names.length;
    for (const n of names) occ[n] = (occ[n] || 0) + 1;
    for (const n of new Set(names)) walksWith[n] = (walksWith[n] || 0) + 1;
  }
  const rec = NOISE_BASELINE.per_walk;
  const recWalks = NOISE_BASELINE.per_walk_provenance.walks;

  console.log(`\n\n=== patterns.js structural — ${WALKS} walks of ${BARS} bars, detectPatterns at DEFAULTS ===`);
  console.log(`  detections/walk ${(total / WALKS).toFixed(3)}   walks with any pattern ${((anyWalks / WALKS) * 100).toFixed(1)}%`);
  console.log(`  (recorded: ${NOISE_BASELINE.unified_harness.detections_per_walk} and ${NOISE_BASELINE.unified_harness.walks_with_any_pattern_pct}%)\n`);
  console.log('  pattern                          occ   per_walk   walks%   recorded   diff');
  let drift = 0;
  for (const p of STRUCTURAL_PATTERNS) {
    const o = occ[p] || 0, pw = o / WALKS, r = rec[p];
    const d = r == null ? null : pw - r;
    if (d != null && Math.abs(d) > 1e-9) drift++;
    console.log(`  ${p.padEnd(28)} ${String(o).padStart(5)}   ${pw.toFixed(3).padStart(8)}   ${(((walksWith[p] || 0) / WALKS) * 100).toFixed(1).padStart(6)}   `
      + `${(r == null ? 'MISSING' : r.toFixed(3)).padStart(8)}   ${d == null ? '' : `${d >= 0 ? '+' : ''}${d.toFixed(3)}`}`);
  }
  console.log(WALKS === recWalks
    ? (drift
      ? `\n  DRIFT: ${drift} row(s) differ from NOISE_BASELINE.per_walk. Re-record it or find what changed.`
      : '\n  All rows match NOISE_BASELINE.per_walk exactly.')
    : `\n  (recorded at ${recWalks} walks; this run used ${WALKS}, so the diff column is sampling error as much as drift)`);
  console.log('  Read walks% rather than per_walk before quoting selectivity. Every row is under 0.35 even at');
  console.log('  400 bars, so vsNoise calls a SINGLE detection "clearly above the noise floor" for every pattern');
  console.log('  here — the discriminating number is how often a walk contains one at all.');
}

/* ────────────────────────────────────────────────────────────────────────────
 * lmw_patterns.js — the academic definitions, measured per five-pivot WINDOW.
 *
 * Deliberately NOT on this script's null. `LMW_NOISE_PROFILE` was measured by
 * scripts/lmw-permissiveness.js on measure()'s generator, and the point of
 * re-running it here is to diff against that constant — changing the null would
 * change the number and destroy the comparison. The generator is therefore
 * spelled out rather than reusing `walk` above.
 *
 * This is the arm that moved when the kernel's index inversion was fixed: the
 * raw sequence used to contain adjacent pivots mapped onto the SAME BAR, and a
 * bar's high and low read as a very flat top and bottom, which is exactly what
 * the rectangle definition's 0.75% tolerance rewards.
 * ──────────────────────────────────────────────────────────────────────────── */

{
  const LMW_WALKS = 60;
  const lmwWalk = (w) => barsFromPath(randomWalk({ n: 200, seed: 5000 + w }), { noise: 0.005, seed: 9000 + w });
  const counts = {};
  let windows = 0, withAny = 0, pivotTotal = 0;
  for (let w = 0; w < LMW_WALKS; w++) {
    const { pivots } = findKernelPivots(lmwWalk(w), { bandwidth_multiplier: LMW_NOISE_PROFILE.bandwidth_multiplier });
    pivotTotal += pivots.length;
    for (let i = 0; i + 4 < pivots.length; i++) {
      windows++;
      const hits = classifyFive(pivots.slice(i, i + 5));
      if (hits.length) withAny++;
      for (const h of hits) counts[h] = (counts[h] || 0) + 1;
    }
  }
  const anyPct = Number(((withAny / windows) * 100).toFixed(1));
  console.log(`\n\n=== lmw_patterns.js — ${LMW_WALKS} walks of 200 bars, seeds 5000/9000 (the constant's own null) ===`);
  console.log(`  five-pivot windows ${windows}   pivots/walk ${(pivotTotal / LMW_WALKS).toFixed(1)}`);
  console.log(`  ANY definition ${anyPct}%   (recorded ${LMW_NOISE_PROFILE.any_definition_pct}%${anyPct === LMW_NOISE_PROFILE.any_definition_pct ? ' — match' : ' — DRIFT'})`);
  console.log('\n  definition                     fires   % of windows   recorded');
  for (const [name, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) {
    const pct = ((n / windows) * 100).toFixed(1);
    const r = LMW_NOISE_PROFILE.by_pattern_pct[name];
    console.log(`  ${name.padEnd(28)} ${String(n).padStart(5)}   ${pct.padStart(12)}   ${(r == null ? 'MISSING' : `${r}%`).padStart(8)}`);
  }
  console.log('\n  These are not selective detectors and this module is not a scanner. Its value is DISAGREEMENT');
  console.log(`  with a selective one: ${anyPct}% of random five-pivot windows match at least one definition,`);
  console.log(`  against ${NOISE_BASELINE.unified_harness.walks_with_any_pattern_pct}% of whole walks containing any structural pattern at all.`);
}

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

/* ────────────────────────────────────────────────────────────────────────────
 * cup.js — prices only, so the standard path-based null is legitimate.
 *
 * Every clause in the cup's VERDICT reads bar highs, lows and closes, all of
 * which `barsFromPath` produces faithfully. The one quantity it does not — volume
 * — is deliberately excluded from the verdict (cup.js reports it under
 * `supporting`, the pattern gaps.js established), so this floor covers the whole
 * decision rather than part of it. Say that out loud rather than assuming it: the
 * arm below re-runs the detector with every volume reading stripped and asserts
 * the answer is byte-identical.
 *
 * TWO LENGTHS, because one measures only part of the duration space: a cup is
 * legal from 35 to 325 bars, and at 200 bars anything past ~195 is unreachable by
 * construction. The 400-bar arm opens the whole range and is the honest floor.
 *
 * The FAILING-CLAUSE table is the point of this arm. "0%" alone says the
 * conjunction is selective without saying which part of it is doing the work,
 * which is the criticism this repo levels at every unattributed selectivity
 * number — so the clause that rejects each walk's best candidate is counted.
 * ──────────────────────────────────────────────────────────────────────────── */

const cupWalk = (n) => (s) => barsFromPath(randomWalk({ n, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });

function cupArm(label, bars_each, makeBars, opts = {}) {
  const failing = {};
  let qualifying = 0, scored = 0, errors = 0, candidates = 0, highs = 0;
  const examples = [];
  for (let s = 0; s < WALKS; s++) {
    try {
      const r = CUP.detectCup(makeBars(s), opts);
      candidates += r.candidates_scored || 0;
      highs += r.pivot_highs_found || 0;
      if (r.qualifies) {
        qualifying++;
        if (examples.length < 4) examples.push({ seed: 7000 + s, m: r.measurements, status: r.status, n: r.candidates_scored });
        continue;
      }
      if (r.reason) { failing[r.reason] = (failing[r.reason] || 0) + 1; continue; }
      scored++;
      // The clause that rejected the BEST near miss. First in the declared order,
      // so a candidate failing three is attributed to one of them consistently.
      const first = (r.failed_checks || [])[0] || 'unknown';
      failing[first] = (failing[first] || 0) + 1;
    } catch (e) { errors++; if (errors <= 2) console.error(`  cup error: ${e.message}`); }
  }
  return {
    label, bars_each, qualifying, scored, failing, errors, examples,
    pct: Number(((qualifying / WALKS) * 100).toFixed(1)),
    candidates_per_walk: Number((candidates / WALKS).toFixed(1)),
    highs_per_walk: Number((highs / WALKS).toFixed(1)),
  };
}

const cupArms = [
  cupArm('200-bar walks (only the SHORT half of the 35-325 range is reachable)', 200, cupWalk(200)),
  cupArm('300-bar walks — THE OPERATIONAL LENGTH (ticker_analyze loads ~300 daily bars)', 300, cupWalk(300)),
  cupArm('400-bar walks (the whole legal duration range is reachable)', 400, cupWalk(400)),
  cupArm('300-bar walks, VOLUME STRIPPED (must match the 300-bar arm exactly)', 300,
    (s) => cupWalk(300)(s).map(({ volume, ...b }) => b)),
];

console.log(`\n\n=== cup.js cup-with-handle — ${WALKS} walks per arm ===`);
for (const arm of cupArms) {
  console.log(`\n${arm.label}`);
  console.log(`  QUALIFYING          ${String(arm.pct).padStart(6)}%  (${arm.qualifying}/${WALKS})${arm.errors ? `  [${arm.errors} errors]` : ''}`);
  console.log(`  pivot highs/walk    ${String(arm.highs_per_walk).padStart(6)}   rim PAIRS scored/walk ${arm.candidates_per_walk}`);
  const rows = Object.entries(arm.failing).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of rows) {
    console.log(`    ${k.padEnd(32)} ${String(n).padStart(4)}  (${((n / WALKS) * 100).toFixed(1)}%)`);
  }
  for (const ex of arm.examples) {
    console.log(`    FIRED seed ${ex.seed} ${ex.status} (best of ${ex.n}): depth ${ex.m.depth_pct}%, ${ex.m.cup_bars} bars, `
      + `rims ${ex.m.rim_difference_pct}% apart, base time ${ex.m.base_time_pct}%, handle ${ex.m.handle_bars} bars `
      + `retracing ${ex.m.handle_retrace_pct_of_cup}%`);
  }
}
{
  const same = cupArms[1].qualifying === cupArms[3].qualifying
    && JSON.stringify(cupArms[1].failing) === JSON.stringify(cupArms[3].failing);
  console.log(`\nVolume independence: ${same ? 'CONFIRMED — identical with volume stripped, so this floor covers the WHOLE verdict' : 'FAILED — a volume clause reached the verdict, and the floor is a fixture artefact'}`);
}

/**
 * The floor is NOT a single number: it climbs with series length, because the
 * detector reports the BEST of every legal rim PAIR and the pair count grows
 * quadratically in the number of pivot highs. That is a trial-count problem in a
 * detector rather than in a backtest, and CLAUDE.md's rule applies unchanged — a
 * result without its trial count flatters itself. So `candidates_scored` is on
 * every detection and the length dependence is measured rather than averaged away.
 */
console.log('\n--- length dependence: the same detector, four series lengths ---');
console.log('  bars   qualifying%   pivot highs/walk   rim pairs scored/walk');
for (const n of [150, 200, 300, 400]) {
  const a = cupArm(`n=${n}`, n, cupWalk(n));
  console.log(`  ${String(n).padStart(4)}   ${String(a.pct).padStart(10)}%   ${String(a.highs_per_walk).padStart(16)}   ${String(a.candidates_per_walk).padStart(21)}`);
}

/**
 * Sensitivity on the two OURS numbers that do the most rejecting. Swept for the
 * same reason gaps.js sweeps its volume multiple: a threshold with no floor
 * beside it is not a threshold, and a reader has to be able to see how far the
 * answer travels on a number nobody published.
 */
console.log('\n--- sensitivity at 300 bars: the two OURS clauses that reject most ---');
console.log('  rim_tolerance_pct   qualifying%        min_base_time_pct   qualifying%');
for (const [rim, base] of [[3, 25], [4, 30], [5, 35], [6, 40], [8, 45]]) {
  const a = cupArm('rim', 300, cupWalk(300), { rim_tolerance_pct: rim });
  const b = cupArm('base', 300, cupWalk(300), { min_base_time_pct: base });
  console.log(`  ${String(rim).padStart(17)}   ${String(a.pct).padStart(10)}%        ${String(base).padStart(17)}   ${String(b.pct).padStart(10)}%`);
}
console.log('\nRead the 300-bar arm as the operational floor — it is the length the workflow loads.');
console.log('The failing-clause table says WHICH clause earns the selectivity; a bare rate with no');
console.log('attribution is a claim, not a measurement.');
console.log(`For comparison: VCP 0%, pennants 0%, springs/upthrusts 0%, any structural pattern ${NOISE_BASELINE.unified_harness.walks_with_any_pattern_pct}%`);
console.log('(200-bar walks — see the patterns.js arm above, and note the cup is measured INSIDE that');
console.log(' figure as well as on its own here, at a lower rate because detectPatterns ages it out).');
