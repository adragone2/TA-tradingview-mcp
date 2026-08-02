#!/usr/bin/env node
/**
 * The noise floor for the owner's cycle machine.
 *
 *   node scripts/stage-cycle-noise.js [--walks 200] [--bars 600]
 *
 * ── Why the VOLUME MODE is part of the answer ──
 *
 * The machine reads volume, and the plain harness (`barsFromPath`) emits
 * near-constant volume — 1000 plus a uniform draw under 500. A spike clause of
 * ">= 1.5x the 20-bar average" essentially cannot fire on that, and a fade clause
 * of "recent < 0.8x trailing" cannot either. A floor measured against it would
 * report 0% for every volume-gated state, and the number would be about the
 * GENERATOR rather than the detector. That is the ignition.js failure exactly:
 * the null moved the gate instead of the pattern.
 *
 * So this measures with `randomWalkWithGaps`, whose `volume_mode` is exposed for
 * precisely this reason, and reports ALL THREE modes side by side:
 *
 *   flat          the degenerate case. Kept so the degeneracy is visible rather
 *                 than merely asserted.
 *   lognormal     dispersed volume, gap bars NOT elevated.
 *   gap_elevated  dispersed volume, gap bars multiplied — the default.
 *
 * Read the arm that matches the clause you are quoting. A state whose entry
 * requires a volume spike has no meaningful floor under `flat`, and saying so is
 * the point.
 *
 * ── What "reached" means ──
 *
 * Occupancy is the share of BARS in each state. Reach is the share of WALKS that
 * ever enter it. They answer different questions: a state can be reached by most
 * walks and occupy few bars (a one-bar waypoint), which is exactly what
 * DISTRIBUTION does under the owner's default parameters.
 */
import { randomWalkWithGaps } from '../src/core/synthetic.js';
import {
  cycleColumns, runCycle, segmentsFrom, transitionsFrom, CYCLE_STATES, UNDETERMINED, resolveParams,
} from '../src/core/stage_history.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};

const WALKS = arg('walks', 200);
const BARS = arg('bars', 600);
const MODES = ['flat', 'lognormal', 'gap_elevated'];
const STATES = [UNDETERMINED, ...Object.keys(CYCLE_STATES)];

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

const out = { walks: WALKS, bars: BARS, params: resolveParams({}), by_volume_mode: {} };

for (const volume_mode of MODES) {
  const barsInState = Object.fromEntries(STATES.map((s) => [s, 0]));
  const walksReaching = Object.fromEntries(STATES.map((s) => [s, 0]));
  const transitionCounts = new Map();
  let totalBars = 0;
  let totalTransitions = 0;
  let clauseHits = { sideways: 0, buy_spike: 0, sell_spike: 0, fading: 0, rising: 0, falling: 0, flat: 0 };
  let clauseBars = 0;

  for (let w = 0; w < WALKS; w += 1) {
    const { bars } = randomWalkWithGaps({ n: BARS, seed: w + 1, volume_mode });
    const cols = cycleColumns(bars);
    const run = runCycle(bars, cols);
    const segs = segmentsFrom(run.readings);
    const trans = transitionsFrom(segs);

    for (const r of run.readings) { barsInState[r.state] += 1; totalBars += 1; }
    for (const s of new Set(run.readings.map((r) => r.state))) walksReaching[s] += 1;
    for (const t of trans) {
      const k = `${t.from}>${t.to}`;
      transitionCounts.set(k, (transitionCounts.get(k) || 0) + 1);
      totalTransitions += 1;
    }

    // Raw clause firing rates, independent of the state machine — so a state that
    // never appears can be attributed to the clause that never fired.
    const p = resolveParams({});
    for (let i = 0; i < bars.length; i += 1) {
      const bw = cols.bandwidth_pctile[i];
      const vr = cols.vol_ratio[i];
      const fr = cols.fade_ratio[i];
      const sl = cols.slope_pct[i];
      const dir = cols.closed_up[i];
      if (bw == null && vr == null && fr == null && sl == null) continue;
      clauseBars += 1;
      const spike = vr != null && vr >= p.spike_mult;
      if (bw != null && bw <= p.base_pctile_max) clauseHits.sideways += 1;
      if (spike && dir === 1) clauseHits.buy_spike += 1;
      if (spike && dir === -1) clauseHits.sell_spike += 1;
      if (fr != null && fr < p.fade_ratio) clauseHits.fading += 1;
      if (sl != null && sl > 0) clauseHits.rising += 1;
      if (sl != null && sl < 0) clauseHits.falling += 1;
      if (sl != null && Math.abs(sl) < p.flat_slope_pct) clauseHits.flat += 1;
    }
  }

  out.by_volume_mode[volume_mode] = {
    occupancy_pct: Object.fromEntries(STATES.map((s) => [s, pct(barsInState[s], totalBars)])),
    walks_reaching_pct: Object.fromEntries(STATES.map((s) => [s, pct(walksReaching[s], WALKS)])),
    transitions_per_walk: Math.round((totalTransitions / WALKS) * 100) / 100,
    transition_counts: Object.fromEntries([...transitionCounts.entries()].sort((a, b) => b[1] - a[1])),
    clause_fire_pct: Object.fromEntries(
      Object.entries(clauseHits).map(([k, v]) => [k, pct(v, clauseBars)]),
    ),
  };
}

console.log(JSON.stringify(out, null, 2));
