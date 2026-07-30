#!/usr/bin/env node
/**
 * Does Shannon's stage GATE improve outcomes, or only filter?
 *
 * `stage-noise.js` established that the gate is selective — it abstains on 54%
 * of random walks where Wyckoff's classifyPhase abstains on none — and that it
 * opens on no more real symbols than random ones. Neither of those says whether
 * a trade taken on a PARTICIPATE reading does better than one taken blind. That
 * is the question a filter has to answer, and this is it.
 *
 * Method: triple-barrier labelling (Lopez de Prado ch. 3, already in
 * `labeling.js`), which resolves each entry by whichever of target / stop / time
 * it reaches FIRST — the only three exits a backtest can model.
 *
 *   SIGNAL    bars where the machine says PARTICIPATE
 *   BASELINE  EVERY eligible bar, same direction, same barriers, same series
 *
 * Four things this is careful about, because each one can manufacture an edge:
 *
 *   1. NO LOOKAHEAD. The stage at bar i is computed from bars 0..i only, and the
 *      gate timeframe is aggregated from a FIXED ORIGIN so truncating the series
 *      cannot shift the grouping. A stage read off the whole array would be
 *      reading the future.
 *   2. DIRECTION-MATCHED BASELINE. A long signal is compared against every bar
 *      labelled LONG, never against a mixed baseline — otherwise the comparison
 *      measures market drift, not the gate.
 *   3. OVERLAP. Consecutive PARTICIPATE bars produce labels that share most of
 *      their forward window, so the raw count wildly overstates the sample. The
 *      non-overlapping count is reported beside it and is the one to believe.
 *   4. CENSORING. Events whose window runs past the end of the series have no
 *      outcome. tripleBarrier flags them; they are excluded from both arms.
 *
 *   node scripts/stage-forward-test.js
 *   node scripts/stage-forward-test.js --timeframe 60 --gate 7
 */
import { classifyStage, stageAction, MA_SETS } from '../src/core/stages.js';
import { tripleBarrier } from '../src/core/labeling.js';
import { loadRealBars, describeBatch } from './_real_bars.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const TIMEFRAME = String(arg('timeframe', '1D'));
const GATE_N = Number(arg('gate', 5));          // base bars per gate bar (5 = a week of daily)
const PROFIT_MULT = Number(arg('profit', 2));
const STOP_MULT = Number(arg('stop', 1));
const MAX_BARS = Number(arg('hold', 20));
/**
 * The MA triple. Shannon's daily set is 10/20/50, but on a 5-bar gate that needs
 * 56 gate bars = 280 base bars of warm-up, and the chart serves ~300 — leaving
 * ~20 testable bars per symbol. His own set is effectively UNTESTABLE on the
 * history available here, which is itself worth knowing.
 */
const PERIODS = String(arg('periods', '10,20,50')).split(',').map(Number);

/**
 * A wide universe on purpose. The chart serves ~300 bars per symbol whatever the
 * resolution, and independent events are capped at bars/max_bars per symbol — so
 * with a 20-bar hold that is ~14 per symbol AT MOST, and the gate is open far
 * less often than that. Power here comes from breadth, not from history.
 */
const SYMBOLS = [
  // mega and large cap, mixed sectors
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V',
  'MA', 'XOM', 'CVX', 'JNJ', 'PG', 'KO', 'PEP', 'MRK', 'PFE', 'ABBV',
  'HD', 'LOW', 'WMT', 'COST', 'MCD', 'DIS', 'NFLX', 'CRM', 'ADBE', 'ORCL',
  'CSCO', 'INTC', 'AMD', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'BAC', 'WFC',
  'GS', 'MS', 'PNC', 'USB', 'SCHW', 'BLK', 'CAT', 'DE', 'BA', 'GE',
  'HON', 'UNP', 'UPS', 'LMT', 'RTX', 'NEE', 'DUK', 'SO', 'T', 'VZ',
  // ETFs
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLE', 'XLF', 'XLK', 'XLV', 'XLU', 'XLI',
  // higher beta and smaller
  'CYTK', 'SRPT', 'ALNY', 'BMRN', 'SOFI', 'HOOD', 'RIVN', 'PLUG', 'DAL', 'UAL',
  'CCL', 'F', 'GM', 'KSS', 'M', 'BBY', 'RIOT', 'MARA', 'UPST', 'AFRM',
];

/**
 * Aggregate from a FIXED ORIGIN: bars [0..N-1] form gate bar 0, and so on. This
 * matters — `resampleBars` counts groups from the END so that the newest group
 * is complete, which is right for a live chart and wrong here, because it would
 * make the grouping shift every time the series is truncated.
 */
function aggregateFixed(bars, n) {
  const out = [];
  for (let i = 0; i + n <= bars.length; i += n) {
    const slice = bars.slice(i, i + n);
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((b) => b.high)),
      low: Math.min(...slice.map((b) => b.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((a, b) => a + (b.volume || 0), 0),
      end_index: i + n - 1,
    });
  }
  return out;
}

/** Signal bars for one series, with no lookahead anywhere. */
function findSignals(bars, { periods = PERIODS, gateN = GATE_N } = {}) {
  const gateAll = aggregateFixed(bars, gateN);
  const slow = Math.max(...periods);
  const minBase = slow + 6;
  const minGate = slow + 6;

  const longs = []; const shorts = []; const eligible = [];

  for (let i = minBase; i < bars.length; i += 1) {
    // Gate bars COMPLETE at or before base bar i. Never the forming one.
    const gateBars = gateAll.filter((g) => g.end_index <= i);
    if (gateBars.length < minGate) continue;
    eligible.push(i);

    const g = classifyStage(gateBars, { periods });
    if (!g.available || (g.stage !== 2 && g.stage !== 4)) continue;
    const t = classifyStage(bars.slice(0, i + 1), { periods });
    if (!t.available) continue;

    const a = stageAction({ long_stage: g.stage, short_stage: t.stage });
    if (a.action !== 'PARTICIPATE') continue;
    (a.side === 'long' ? longs : shorts).push(i);
  }
  return { longs, shorts, eligible };
}

/** How many of these events do NOT share a forward window? */
function nonOverlapping(indices, maxBars) {
  let count = 0; let lastEnd = -1;
  for (const i of indices) {
    if (i > lastEnd) { count += 1; lastEnd = i + maxBars; }
  }
  return count;
}

const BARRIERS = { profit_mult: PROFIT_MULT, stop_mult: STOP_MULT, max_bars: MAX_BARS };

function labelArm(barSets, pick, direction) {
  let events = 0; let independent = 0;
  let wins = 0; let losses = 0; let zeros = 0; let censored = 0; let ambiguous = 0;
  let heldSum = 0; let heldN = 0;

  for (const { bars, sig } of barSets) {
    const idx = pick(sig);
    if (!idx.length) continue;
    events += idx.length;
    independent += nonOverlapping(idx, MAX_BARS);
    const r = tripleBarrier(bars, idx.map((i) => ({ index: i, direction })), BARRIERS);
    for (const l of r.labels) {
      if (l.label == null || l.truncated) { if (l.truncated) censored += 1; continue; }
      if (l.label === 1) wins += 1; else if (l.label === -1) losses += 1; else zeros += 1;
      if (l.ambiguous) ambiguous += 1;
      heldSum += l.bars_held; heldN += 1;
    }
  }
  const decided = wins + losses;
  return {
    events, independent, wins, losses, zeros, censored, ambiguous,
    labelled: decided + zeros,
    win_rate_pct: decided ? Math.round((wins / decided) * 1000) / 10 : null,
    avg_bars_held: heldN ? Math.round((heldSum / heldN) * 10) / 10 : null,
    ambiguous_pct: (decided + zeros) ? Math.round((ambiguous / (decided + zeros)) * 1000) / 10 : null,
  };
}

/** Two-proportion z on two win rates. */
function zTest(a, b) {
  const n1 = a.wins + a.losses; const n2 = b.wins + b.losses;
  if (!n1 || !n2) return null;
  const p1 = a.wins / n1; const p2 = b.wins / n2;
  const p = (a.wins + b.wins) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? Math.round(((p1 - p2) / se) * 100) / 100 : null;
}

// ---------------------------------------------------------------------------
const batch = await loadRealBars(SYMBOLS, { timeframe: TIMEFRAME, count: 900 });
process.stderr.write(`\n${describeBatch(batch, 'universe')}\n\n`);

const prepared = batch.sets
  .filter((s) => s.bars.length > 120)
  .map((s) => ({ symbol: s.symbol, bars: s.bars, sig: findSignals(s.bars) }));

const arms = {
  signal_long: labelArm(prepared, (s) => s.longs, 1),
  baseline_long: labelArm(prepared, (s) => s.eligible, 1),
  signal_short: labelArm(prepared, (s) => s.shorts, -1),
  baseline_short: labelArm(prepared, (s) => s.eligible, -1),
};

console.log(`\nStage gate forward test — does PARTICIPATE beat entering blind?\n`);
console.log(`  resolution ${batch.actual_resolution} (requested ${TIMEFRAME}), gate = ${GATE_N} base bars per gate bar`);
console.log(`  barriers: target ${PROFIT_MULT}x vol, stop ${STOP_MULT}x vol, time ${MAX_BARS} bars`);
console.log(`  MA triple ${PERIODS.join('/')} — gate warm-up ${(Math.max(...PERIODS) + 6) * GATE_N} base bars`);
console.log(`  ${prepared.length} symbols, ${prepared.reduce((a, p) => a + p.bars.length, 0)} bars\n`);

const row = (name, a) => `  ${name.padEnd(16)}${String(a.events).padStart(8)}${String(a.independent).padStart(9)}`
  + `${String(a.win_rate_pct).padStart(9)}%${String(a.wins).padStart(7)}${String(a.losses).padStart(8)}`
  + `${String(a.zeros).padStart(7)}${String(a.avg_bars_held).padStart(8)}${String(a.ambiguous_pct).padStart(8)}%`;

console.log(`  ${'arm'.padEnd(16)}${'events'.padStart(8)}${'indep.'.padStart(9)}${'win rate'.padStart(10)}${'wins'.padStart(7)}${'losses'.padStart(8)}${'timeout'.padStart(7)}${'held'.padStart(8)}${'ambig'.padStart(9)}`);
for (const [k, v] of Object.entries(arms)) console.log(row(k, v));

console.log('\nVERDICT\n');
for (const side of ['long', 'short']) {
  const s = arms[`signal_${side}`]; const b = arms[`baseline_${side}`];
  if (!s.events) { console.log(`  ${side.toUpperCase()}: no PARTICIPATE signals fired.`); continue; }
  const z = zTest(s, b);
  const lift = s.win_rate_pct !== null && b.win_rate_pct !== null
    ? Math.round((s.win_rate_pct - b.win_rate_pct) * 10) / 10 : null;
  console.log(`  ${side.toUpperCase()}: signal ${s.win_rate_pct}% vs baseline ${b.win_rate_pct}%  `
    + `lift ${lift > 0 ? '+' : ''}${lift} points  z ${z}`);
  console.log(`    effective sample: ${s.independent} independent signal events (${s.events} raw, heavily overlapping)`);
  /**
   * The z is computed on RAW counts, which are not independent — consecutive
   * PARTICIPATE bars share most of their forward window. So a significant z on
   * few independent events is not a result in either direction, and saying
   * "no improvement" there would be as wrong as claiming one.
   */
  const MIN_INDEPENDENT = 30;
  if (s.independent < MIN_INDEPENDENT) {
    console.log(`    -> UNDERPOWERED. Only ${s.independent} independent events (need ~${MIN_INDEPENDENT}). The z of ${z} is`);
    console.log(`       computed on ${s.events} OVERLAPPING observations and is not trustworthy in either direction.`);
    console.log('       This neither supports nor refutes the gate. It says the gate fires too rarely here to test.');
    continue;
  }
  const real = lift !== null && lift > 0 && Math.abs(z ?? 0) > 1.96;
  console.log(real
    ? `    -> the gate ADDS ${lift} points on this sample. Needs a holdout before anyone sizes on it — the`
      + `\n       level_pressure clause looked exactly like this and did not replicate.`
    : lift !== null && lift < 0 && Math.abs(z ?? 0) > 1.96
      ? `    -> the gate is WORSE than blind entry by ${Math.abs(lift)} points on this sample. Taken at face value`
        + `\n       that is an argument against using it as a filter at all.`
      : `    -> NO detectable improvement. The gate filters (54% abstention on noise) but on these bars a`
        + `\n       PARTICIPATE entry resolves no better than an arbitrary one in the same direction.`);
}

console.log('\n  What this does and does not settle:');
console.log('    - It measures the GATE, not Shannon\'s full method. He also sizes, scales out, trails a');
console.log('      pivot stop and refuses to hold into earnings. None of that is in these barriers.');
console.log('    - A filter can be worth having without improving win rate, by reducing TRADE COUNT and');
console.log('      therefore cost. turnover_cost prices that separately.');
console.log('    - Overlapping events mean the raw counts are not independent observations. Read the');
console.log('      independent column, and treat any z computed on the raw counts as optimistic.\n');
