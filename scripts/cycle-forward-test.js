#!/usr/bin/env node
/**
 * Does the owner's cycle ENTRY improve outcomes, or only describe them?
 *
 * The validation campaign the owner licensed (2026-07-31): their numbers are
 * defaults, not settled — "if you find better ones based on data you can
 * adjust them". This is the only way "better based on data" is allowed to
 * mean anything here: a pre-stated decision rule, the trial count carried,
 * and a HOLDOUT arm before any default moves. level_pressure passed the
 * in-sample bar (+39.1, z 3.96) and died on exactly this arm (+4.6, z 0.73).
 *
 * Method: identical to scripts/stage-forward-test.js — the measurement that
 * killed the stage GATE — so the two are comparable:
 *   SIGNAL     base -> accumulation transitions (LONG), and per the owner's
 *              ruling, base -> declining transitions (SHORT: "a base that
 *              breaks down is either an exit or a short signal")
 *   BASELINE   every eligible bar, same direction, same barriers, same series
 *   BARRIERS   2x ATR profit / 1x ATR stop / 20-bar time, tripleBarrier
 *   DISCIPLINE no lookahead (the machine is trailing by construction: the
 *              percentile ranks a trailing window, the slope looks back, the
 *              breakout level is the base high up to the PRIOR bar),
 *              direction-matched baselines, non-overlapping counts reported
 *              beside raw, censored events excluded from both arms.
 *
 * THE GRID: 27 threshold configs (spike 1.25/1.5/2.0 x base-percentile
 * 25/33/40 x fade 0.7/0.8/0.9). All three are `affects: 'thresholds'` knobs,
 * so columns compute ONCE per symbol and the sweep is nearly free — the split
 * stage_history.js was built with.
 *
 * THE DECISION RULE, stated before the data was seen:
 *   A config replaces the owner's defaults ONLY if (a) its in-sample long
 *   delta beats the owner config's by >= 2 points, (b) its in-sample z >= 2.5
 *   — chosen because the best of 27 nulls is expected near |z| ~ 2.5, so the
 *   bar is "beats the multiplicity", not "beats zero" — and (c) its HOLDOUT
 *   delta is positive with z >= 1.5. Anything less: the owner's numbers
 *   stand, now validated rather than provisional.
 *
 * ALSO MEASURED at the owner config: the heartbeat corollary — "the longer
 * the base, the stronger the breakup" (Weinstein's big-base-big-move). Base
 * length is prior_segment_bars on every entry; outcomes stratified by
 * quartile, buckets under MIN_N flagged, never ranked.
 *
 * Run: node scripts/cycle-forward-test.js            # both arms, ~10 min chart time
 *      node scripts/cycle-forward-test.js --in-sample-only
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cycleColumns, runCycle, segmentsFrom, transitionsFrom, CYCLE_PARAMS } from '../src/core/stage_history.js';
import { tripleBarrier } from '../src/core/labeling.js';
import { loadRealBars } from './_real_bars.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const IN_SAMPLE_ONLY = process.argv.includes('--in-sample-only');
const MAX_BARS = 20;
const BARRIERS = { profit_mult: 2, stop_mult: 1, max_bars: MAX_BARS };
const MIN_N = 8;

/** Universe A — the stage-forward-test's own 90, verbatim, for comparability. */
const IN_SAMPLE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V',
  'MA', 'XOM', 'CVX', 'JNJ', 'PG', 'KO', 'PEP', 'MRK', 'PFE', 'ABBV',
  'HD', 'LOW', 'WMT', 'COST', 'MCD', 'DIS', 'NFLX', 'CRM', 'ADBE', 'ORCL',
  'CSCO', 'INTC', 'AMD', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'BAC', 'WFC',
  'GS', 'MS', 'PNC', 'USB', 'SCHW', 'BLK', 'CAT', 'DE', 'BA', 'GE',
  'HON', 'UNP', 'UPS', 'LMT', 'RTX', 'NEE', 'DUK', 'SO', 'T', 'VZ',
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLE', 'XLF', 'XLK', 'XLV', 'XLU', 'XLI',
  'CYTK', 'SRPT', 'ALNY', 'BMRN', 'SOFI', 'HOOD', 'RIVN', 'PLUG', 'DAL', 'UAL',
  'CCL', 'F', 'GM', 'KSS', 'M', 'BBY', 'RIOT', 'MARA', 'UPST', 'AFRM',
];

/**
 * Universe B — the HOLDOUT: disjoint from A (asserted below), same breadth
 * recipe (mega/large mixed sectors, ETFs, higher beta). Dual classes deduped
 * against A (A has GOOGL, so no GOOG here).
 */
const HOLDOUT = [
  'LLY', 'UNH', 'TMO', 'ABT', 'DHR', 'LIN', 'APD', 'NKE', 'SBUX', 'TGT',
  'CMG', 'PANW', 'NOW', 'SNOW', 'SHOP', 'UBER', 'ABNB', 'PLTR', 'COIN', 'SQ',
  'AXP', 'C', 'TFC', 'COF', 'AIG', 'MET', 'MMM', 'EMR', 'ETN', 'ITW',
  'FDX', 'NOC', 'GD', 'AEP', 'EXC', 'D', 'TMUS', 'CMCSA', 'AMGN', 'GILD',
  'XLY', 'XLP', 'XLB', 'SMH', 'XBI',
  'CVNA', 'SMCI', 'DKNG', 'ROKU', 'ETSY', 'W', 'CHWY', 'AAL', 'X', 'CLF',
];
{
  const a = new Set(IN_SAMPLE);
  const dupes = HOLDOUT.filter((s) => a.has(s));
  if (dupes.length) throw new Error(`holdout overlaps in-sample: ${dupes.join(',')}`);
}

/** The grid: threshold knobs only, so columns are computed once per symbol. */
const GRID = [];
for (const spike_mult of [1.25, 1.5, 2.0]) {
  for (const base_pctile_max of [25, 33, 40]) {
    for (const fade_ratio of [0.7, 0.8, 0.9]) {
      GRID.push({ spike_mult, base_pctile_max, fade_ratio });
    }
  }
}
const OWNER = {
  spike_mult: CYCLE_PARAMS.spike_mult.value,
  base_pctile_max: CYCLE_PARAMS.base_pctile_max.value,
  fade_ratio: CYCLE_PARAMS.fade_ratio.value,
};
const isOwner = (c) => c.spike_mult === OWNER.spike_mult
  && c.base_pctile_max === OWNER.base_pctile_max && c.fade_ratio === OWNER.fade_ratio;

function nonOverlapping(indices, maxBars) {
  let count = 0; let lastEnd = -1;
  for (const i of indices) {
    if (i > lastEnd) { count += 1; lastEnd = i + maxBars; }
  }
  return count;
}

/** Same accumulator the stage forward test uses. */
function labelArm(barSets, pick, direction) {
  let events = 0; let independent = 0;
  let wins = 0; let losses = 0; let zeros = 0; let censored = 0;
  for (const set of barSets) {
    const idx = pick(set);
    if (!idx.length) continue;
    events += idx.length;
    independent += nonOverlapping(idx, MAX_BARS);
    const r = tripleBarrier(set.bars, idx.map((i) => ({ index: i, direction: direction === 'short' ? -1 : 1 })), BARRIERS);
    for (const l of r.labels) {
      if (l.label == null || l.truncated) { if (l.truncated) censored += 1; continue; }
      if (l.label === 1) wins += 1; else if (l.label === -1) losses += 1; else zeros += 1;
    }
  }
  const decided = wins + losses;
  return {
    events, independent, wins, losses, zeros, censored,
    win_rate_pct: decided ? Math.round((wins / decided) * 1000) / 10 : null,
  };
}

function zTest(a, b) {
  const n1 = a.wins + a.losses; const n2 = b.wins + b.losses;
  if (!n1 || !n2) return null;
  const p1 = a.wins / n1; const p2 = b.wins / n2;
  const p = (a.wins + b.wins) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? Math.round(((p1 - p2) / se) * 100) / 100 : null;
}

/** Evaluate one universe: columns once per symbol, then the grid over them. */
function evaluate(name, sets, configs) {
  // Per-symbol columns + per-config transitions.
  const perConfig = configs.map(() => []); // [{bars, longs: [idx], shorts: [idx], baseBars: {idx: bars}}...]
  for (const { symbol, bars } of sets) {
    if (bars.length < 200) continue;
    const cols = cycleColumns(bars);
    configs.forEach((cfg, k) => {
      const { readings } = runCycle(bars, cols, cfg);
      const transitions = transitionsFrom(segmentsFrom(readings));
      const longs = []; const shorts = []; const baseBars = {};
      for (const t of transitions) {
        if (t.from === 'base' && t.to === 'accumulation') {
          longs.push(t.index);
          baseBars[t.index] = t.prior_segment_bars ?? null;
        } else if (t.from === 'base' && t.to === 'declining') {
          shorts.push(t.index);
        }
      }
      perConfig[k].push({ symbol, bars, longs, shorts, baseBars });
    });
  }

  // Direction-matched baselines: every bar with a full forward window, once.
  const allSets = perConfig[0].map(({ symbol, bars }) => ({ symbol, bars }));
  const everyBar = (set) => {
    const out = [];
    for (let i = 200; i < set.bars.length - 1; i += 1) out.push(i);
    return out;
  };
  const baselineLong = labelArm(allSets.map((s) => ({ ...s })), everyBar, 'long');
  const baselineShort = labelArm(allSets.map((s) => ({ ...s })), everyBar, 'short');

  const rows = configs.map((cfg, k) => {
    const long = labelArm(perConfig[k], (s) => s.longs, 'long');
    const short = labelArm(perConfig[k], (s) => s.shorts, 'short');
    return {
      config: cfg, owner: isOwner(cfg),
      long: { ...long, baseline_win_rate_pct: baselineLong.win_rate_pct,
        delta_pp: long.win_rate_pct != null && baselineLong.win_rate_pct != null
          ? Math.round((long.win_rate_pct - baselineLong.win_rate_pct) * 10) / 10 : null,
        z: zTest(long, baselineLong) },
      short: { ...short, baseline_win_rate_pct: baselineShort.win_rate_pct,
        delta_pp: short.win_rate_pct != null && baselineShort.win_rate_pct != null
          ? Math.round((short.win_rate_pct - baselineShort.win_rate_pct) * 10) / 10 : null,
        z: zTest(short, baselineShort) },
    };
  });

  // The heartbeat corollary at the OWNER config: outcomes by base-length quartile.
  const ownerIdx = configs.findIndex(isOwner);
  let baseLength = null;
  if (ownerIdx >= 0) {
    const entries = [];
    for (const set of perConfig[ownerIdx]) {
      if (!set.longs.length) continue;
      const r = tripleBarrier(set.bars, set.longs.map((i) => ({ index: i, direction: 1 })), BARRIERS);
      r.labels.forEach((l, j) => {
        if (l.label == null || l.truncated) return;
        entries.push({ base_bars: set.baseBars[set.longs[j]], win: l.label === 1 ? 1 : (l.label === -1 ? 0 : null) });
      });
    }
    const usable = entries.filter((e) => e.base_bars != null && e.win != null)
      .sort((a, b) => a.base_bars - b.base_bars);
    const q = 4; const buckets = [];
    for (let i = 0; i < q; i += 1) {
      const slice = usable.slice(Math.floor((i * usable.length) / q), Math.floor(((i + 1) * usable.length) / q));
      const wins = slice.reduce((s, e) => s + e.win, 0);
      buckets.push({
        quartile: i + 1, n: slice.length,
        base_bars_range: slice.length ? [slice[0].base_bars, slice[slice.length - 1].base_bars] : null,
        win_rate_pct: slice.length ? Math.round((wins / slice.length) * 1000) / 10 : null,
        below_min_n: slice.length < MIN_N,
      });
    }
    baseLength = {
      hypothesis: 'the longer the base, the stronger the breakout (owner 2026-07-31; Weinstein big-base-big-move)',
      entries_usable: usable.length, quartiles: buckets, min_n: MIN_N,
      note: 'Quartiles of prior base length at the OWNER config. Buckets under min_n are flagged, never ranked.',
    };
  }

  return { name, symbols: sets.length, rows, baseline: { long: baselineLong, short: baselineShort }, base_length: baseLength };
}

const fmt = (r) => `spike ${r.config.spike_mult} pct ${r.config.base_pctile_max} fade ${r.config.fade_ratio}`
  + `${r.owner ? '  << OWNER' : ''}`;

// ---------------------------------------------------------------------------
console.log(`cycle forward test — grid of ${GRID.length}, barriers ${JSON.stringify(BARRIERS)}`);
const A = await loadRealBars(IN_SAMPLE, { timeframe: '1D', count: 900, label: 'cycle-forward-test A' });
console.log(`\nin-sample loaded: ${A.sets.length}/${IN_SAMPLE.length}`);
const inSample = evaluate('in_sample', A.sets, GRID);

console.log(`\nbaseline LONG ${inSample.baseline.long.win_rate_pct}% (${inSample.baseline.long.wins + inSample.baseline.long.losses} decided)`
  + ` | SHORT ${inSample.baseline.short.win_rate_pct}%`);
console.log('\nconfig                          longs ind  win%   Δpp     z   | shorts ind  win%   Δpp     z');
for (const r of inSample.rows) {
  const L = r.long; const S = r.short;
  console.log(`${fmt(r).padEnd(30)} ${String(L.events).padStart(5)} ${String(L.independent).padStart(3)} ${String(L.win_rate_pct ?? '-').padStart(5)} ${String(L.delta_pp ?? '-').padStart(5)} ${String(L.z ?? '-').padStart(5)} | ${String(S.events).padStart(5)} ${String(S.independent).padStart(3)} ${String(S.win_rate_pct ?? '-').padStart(5)} ${String(S.delta_pp ?? '-').padStart(5)} ${String(S.z ?? '-').padStart(5)}`);
}

const owner = inSample.rows.find((r) => r.owner);
const best = [...inSample.rows].sort((a, b) => (b.long.delta_pp ?? -99) - (a.long.delta_pp ?? -99))[0];
console.log(`\nOWNER  ${fmt(owner)}: long Δ ${owner.long.delta_pp}pp z ${owner.long.z} (${owner.long.independent} independent)`);
console.log(`BEST   ${fmt(best)}: long Δ ${best.long.delta_pp}pp z ${best.long.z} (${best.long.independent} independent)`);
console.log('DECISION RULE: adopt only if best beats owner by >=2pp, z >= 2.5 in-sample (the best of 27 nulls sits near 2.5), AND holdout Δ > 0 with z >= 1.5.');

if (inSample.base_length) {
  console.log('\nheartbeat corollary (owner config): win rate by base-length quartile');
  for (const b of inSample.base_length.quartiles) {
    console.log(`  Q${b.quartile}  base ${b.base_bars_range ? b.base_bars_range.join('-') : '-'} bars  n=${b.n}${b.below_min_n ? ' (below min_n — not rankable)' : ''}  win ${b.win_rate_pct ?? '-'}%`);
  }
}

let holdout = null;
if (!IN_SAMPLE_ONLY) {
  const holdoutConfigs = [OWNER, best.config].filter((c, i, arr) => arr.findIndex((x) => JSON.stringify(x) === JSON.stringify(c)) === i);
  const B = await loadRealBars(HOLDOUT, { timeframe: '1D', count: 900, label: 'cycle-forward-test B' });
  console.log(`\nholdout loaded: ${B.sets.length}/${HOLDOUT.length}`);
  holdout = evaluate('holdout', B.sets, holdoutConfigs);
  console.log(`baseline LONG ${holdout.baseline.long.win_rate_pct}% | SHORT ${holdout.baseline.short.win_rate_pct}%`);
  for (const r of holdout.rows) {
    console.log(`HOLDOUT ${fmt(r).padEnd(30)} long Δ ${r.long.delta_pp}pp z ${r.long.z} (${r.long.independent} ind) | short Δ ${r.short.delta_pp}pp z ${r.short.z}`);
  }
}

// reports/ root is contract-scanned for pipeline schema versions; measurement
// artifacts live one level down where the scan deliberately does not look.
mkdirSync(join('reports', 'measurements'), { recursive: true });
const out = join('reports', 'measurements', `cycle-forward-test-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(out, JSON.stringify({ barriers: BARRIERS, grid: GRID.length, owner: OWNER, in_sample: inSample, holdout }, null, 2));
console.log(`\n${out}`);
process.exit(0);
