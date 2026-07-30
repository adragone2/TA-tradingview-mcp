#!/usr/bin/env node
/**
 * Does the SISTER STOCK actually help? Livermore's core claim, measured.
 *
 * > "There is danger of being caught in a false movement by depending upon only
 * >  one stock. The movement of the two stocks combined gives reasonable assurance."
 *
 * That is a falsifiable claim about signal quality, and it is the honest thing to
 * test — unlike his OTHER claim (groups lead the market by three to six months),
 * which needs a stored panel of group series across cycles and cannot be done from
 * ~300 bars per symbol. This script tests the one that is reachable.
 *
 * Method. For each industry group, take its two leaders by market cap. Signal on
 * leader A: a new N-day closing high. Then two arms on the SAME signals:
 *
 *   SOLO    every leader-A signal, labelled forward
 *   TANDEM  only those where leader B ALSO made a new N-day high within `confirm`
 *           bars, labelled forward
 *
 * Both arms are labelled with triple-barrier (target / stop / time — the only
 * three exits a backtest can model), same barriers, same bars, same direction. If
 * Livermore is right, TANDEM has a higher win rate than SOLO. If it does not, the
 * sister stock is costing signals for nothing.
 *
 * Four things this is careful about, each of which can manufacture a result:
 *   1. NO LOOKAHEAD. Leader B's confirmation must land at or before the signal bar,
 *      never after — checking a window that extends forward is reading the future.
 *   2. SAME UNDERLYING SET. Tandem is a SUBSET of solo, so the comparison is
 *      filtering-on-the-same-signals, not two different strategies.
 *   3. OVERLAP. Consecutive signals share forward windows; the non-overlapping
 *      count is reported and is the honest sample size.
 *   4. CENSORING. Events whose window runs past the series end are excluded.
 *
 *   node scripts/group-lead-lag.js
 *   node scripts/group-lead-lag.js --groups 14 --hold 20 --lookback 40
 */
import { fetchGroupRows, groupMembers, groupLeaders, bare } from '../src/core/groups.js';
import { tripleBarrier } from '../src/core/labeling.js';
import { loadRealBars, describeBatch } from './_real_bars.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const GROUPS = Number(arg('groups', 14));
const LOOKBACK = Number(arg('lookback', 40));    // bars defining a "new high"
const CONFIRM = Number(arg('confirm', 3));       // bars within which the sister must confirm
const HOLD = Number(arg('hold', 20));
const PROFIT = Number(arg('profit', 3));
const STOP = Number(arg('stop', 1.5));
const TIMEFRAME = String(arg('timeframe', '1D'));

const BARRIERS = { profit_mult: PROFIT, stop_mult: STOP, max_bars: HOLD };

/** Indices where close is the highest of the trailing `lookback` closes. */
function newHighs(bars, lookback) {
  const out = [];
  for (let i = lookback; i < bars.length; i += 1) {
    let hi = -Infinity;
    for (let j = i - lookback; j < i; j += 1) hi = Math.max(hi, bars[j].close);
    if (bars[i].close > hi) out.push(i);
  }
  return out;
}

function nonOverlapping(idx, span) {
  let n = 0; let last = -1;
  for (const i of idx) if (i > last) { n += 1; last = i + span; }
  return n;
}

function label(bars, idx, direction = 1) {
  if (!idx.length) return { events: 0, independent: 0, wins: 0, losses: 0, zeros: 0, censored: 0 };
  const r = tripleBarrier(bars, idx.map((i) => ({ index: i, direction })), BARRIERS);
  let wins = 0; let losses = 0; let zeros = 0; let censored = 0;
  for (const l of r.labels) {
    if (l.label == null || l.truncated) { if (l.truncated) censored += 1; continue; }
    if (l.label === 1) wins += 1; else if (l.label === -1) losses += 1; else zeros += 1;
  }
  return { events: idx.length, independent: nonOverlapping(idx, HOLD), wins, losses, zeros, censored };
}

const add = (a, b) => {
  for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k];
  return a;
};

// ---- pick groups and their two leaders ------------------------------------
process.stderr.write('Resolving groups from the scanner...\n');
const { rows } = await fetchGroupRows({ universe: ['sp500'], limit: 500 });
const byGroup = new Map();
for (const r of rows) if (r.industry) byGroup.set(r.industry, (byGroup.get(r.industry) || 0) + 1);

const pairs = [];
for (const [group] of [...byGroup.entries()].sort((a, b) => b[1] - a[1])) {
  const { leaders } = groupLeaders(groupMembers(rows, group));
  if (leaders.length < 2) continue;
  pairs.push({ group, a: bare(leaders[0].symbol), b: bare(leaders[1].symbol) });
  if (pairs.length >= GROUPS) break;
}
process.stderr.write(`${pairs.length} groups with two leaders each:\n`);
for (const p of pairs) process.stderr.write(`  ${p.group}: ${p.a} + ${p.b}\n`);

// ---- load bars once for every symbol involved ----------------------------
const symbols = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
const batch = await loadRealBars(symbols, { timeframe: TIMEFRAME, count: 900 });
process.stderr.write(`\n${describeBatch(batch, 'leaders')}\n\n`);
const barsOf = new Map(batch.sets.map((s) => [bare(s.symbol), s.bars]));

// ---- the two arms --------------------------------------------------------
const solo = {}; const tandem = {};
const perGroup = [];

for (const p of pairs) {
  const A = barsOf.get(p.a); const B = barsOf.get(p.b);
  if (!A || !B || A.length < 120 || B.length < 120) continue;

  const sigA = newHighs(A, LOOKBACK);
  const sigB = new Set(newHighs(B, LOOKBACK));

  /**
   * Confirmation must be at or BEFORE the signal bar. A window reaching forward
   * would be reading the future — the single easiest way to fake this result.
   */
  const confirmed = sigA.filter((i) => {
    for (let k = 0; k <= CONFIRM; k += 1) if (sigB.has(i - k)) return true;
    return false;
  });

  const s = label(A, sigA);
  const t = label(A, confirmed);
  add(solo, s); add(tandem, t);
  perGroup.push({ group: p.group, a: p.a, b: p.b, solo: sigA.length, tandem: confirmed.length });
}

const rate = (x) => { const d = x.wins + x.losses; return d ? Math.round((x.wins / d) * 1000) / 10 : null; };
const z = (a, b) => {
  const n1 = a.wins + a.losses; const n2 = b.wins + b.losses;
  if (!n1 || !n2) return null;
  const p1 = a.wins / n1; const p2 = b.wins / n2;
  const p = (a.wins + b.wins) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? Math.round(((p1 - p2) / se) * 100) / 100 : null;
};

console.log('\nDoes the sister stock help? Livermore\'s false-movement claim, measured\n');
console.log(`  resolution ${batch.actual_resolution}, ${pairs.length} groups, new ${LOOKBACK}-bar closing high as the signal`);
console.log(`  sister must confirm within ${CONFIRM} bars AT OR BEFORE the signal (no lookahead)`);
console.log(`  barriers: target ${PROFIT}x vol, stop ${STOP}x vol, time ${HOLD} bars\n`);

console.log(`  ${'arm'.padEnd(10)}${'events'.padStart(8)}${'indep.'.padStart(8)}${'win rate'.padStart(10)}${'wins'.padStart(7)}${'losses'.padStart(8)}${'timeout'.padStart(9)}`);
for (const [name, a] of [['SOLO', solo], ['TANDEM', tandem]]) {
  console.log(`  ${name.padEnd(10)}${String(a.events).padStart(8)}${String(a.independent).padStart(8)}`
    + `${String(rate(a)).padStart(9)}%${String(a.wins).padStart(7)}${String(a.losses).padStart(8)}${String(a.zeros).padStart(9)}`);
}

const lift = rate(tandem) !== null && rate(solo) !== null
  ? Math.round((rate(tandem) - rate(solo)) * 10) / 10 : null;
const zz = z(tandem, solo);
const kept = solo.events ? Math.round((tandem.events / solo.events) * 1000) / 10 : null;

console.log(`\n  Tandem keeps ${kept}% of the solo signals (${tandem.events} of ${solo.events}).`);
console.log(`  Win rate: tandem ${rate(tandem)}% vs solo ${rate(solo)}%  lift ${lift > 0 ? '+' : ''}${lift} points  z ${zz}`);

console.log('\nVERDICT\n');
const MIN_IND = 30;
if (tandem.independent < MIN_IND) {
  console.log(`  UNDERPOWERED. Only ${tandem.independent} independent tandem events (need ~${MIN_IND}).`);
  console.log('  This neither supports nor refutes the claim — the filter is too selective to test on this history.');
} else if (lift > 0 && Math.abs(zz ?? 0) > 1.96) {
  console.log(`  The sister stock HELPS: +${lift} points on ${tandem.independent} independent events (z ${zz}).`);
  console.log('  Needs a holdout before anyone sizes on it — two claims in this repo cleared a null and a trial');
  console.log('  count and still died out of sample.');
} else if (lift < 0 && Math.abs(zz ?? 0) > 1.96) {
  console.log(`  The sister stock HURTS by ${Math.abs(lift)} points (z ${zz}). Requiring confirmation discarded`);
  console.log(`  ${100 - kept}% of signals and made the survivors worse. That is an argument against the rule.`);
} else {
  console.log(`  NO detectable difference (${lift > 0 ? '+' : ''}${lift} points, z ${zz}). The sister stock costs`);
  console.log(`  ${100 - kept}% of the signals and buys no measurable improvement in the ones that remain.`);
  console.log('  Read group context as CONTEXT, not as confirmation that improves outcomes.');
}

console.log('\n  What this does NOT test: his lead-lag claim that groups turn three to six months before the');
console.log('  market. That needs a stored panel of group series across cycles; the chart serves ~300 bars');
console.log('  per symbol. It remains unmeasured, and group tools say so.\n');

console.log('  Per group (solo signals -> tandem-confirmed):');
for (const g of perGroup.sort((a, b) => b.solo - a.solo).slice(0, 12)) {
  console.log(`    ${g.group.slice(0, 34).padEnd(34)} ${g.a}/${g.b}  ${String(g.solo).padStart(4)} -> ${String(g.tandem).padStart(4)}`);
}
console.log();
