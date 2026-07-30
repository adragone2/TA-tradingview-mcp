#!/usr/bin/env node
/**
 * Shannon's touch-count inversion, measured against its own null — WITH an
 * out-of-sample arm.
 *
 * The claim (ch. 7, figs 7.4/7.5): the MORE times a level is tested, the MORE
 * likely it is to break. Plus two mechanism clauses — the interim retreat
 * extremes moving toward the level ("aggression through price"), and the tests
 * coming closer together ("time-wise").
 *
 * The trap on the count claim: more touches means more exposure, so
 * P(break | n tests) rises with n on a random walk with no absorption anywhere.
 * Only the SHAPE against matched noise settles it.
 *
 * The trap on the clause: one universe over one period is one study. The first
 * pass found +19.5 points against a −1.4 null, which is the strongest single
 * result in this repo — and exactly the kind of number that evaporates out of
 * sample. So there are three real-data arms:
 *
 *   IN-SAMPLE  20 large/mid caps, recent window
 *   OOS-UNIVERSE  20 DIFFERENT symbols (small caps, ETFs, other sectors), same window
 *   OOS-PERIOD    the ORIGINAL 20, an EARLIER non-overlapping window of bars
 *
 * A finding that holds on one and dies on the others is a finding about that
 * one sample.
 *
 *   node scripts/level-test-inversion.js
 *   node scripts/level-test-inversion.js --noise            # skip the chart
 *   node scripts/level-test-inversion.js --timeframe 60     # measure hourly instead
 */
import { levelTestStudy } from '../src/core/level_tests.js';
import { normalizeBars } from '../src/core/structure.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';
import { loadRealBars, describeBatch } from './_real_bars.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const NOISE_ONLY = process.argv.includes('--noise');
const TIMEFRAME = String(arg('timeframe', '1D'));
const WALKS = 200;
const BARS = 400;

/** In-sample: large and mid caps. The original 20. */
const IN_SAMPLE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'JNJ', 'PG',
  'HD', 'PNC', 'BAC', 'CVX', 'MRK', 'PFE', 'KO', 'DIS', 'INTC', 'CSCO',
];

/**
 * Out-of-sample universe: deliberately unlike the first set — smaller caps,
 * higher-beta names, ETFs, and sectors absent above. If the clause is a
 * property of price behaviour it should not care.
 */
const OOS_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'XLE', 'XLU',
  'CYTK', 'SRPT', 'ALNY', 'BMRN', 'IONS',
  'PLUG', 'RIOT', 'SOFI', 'HOOD', 'RIVN',
  'DAL', 'CCL', 'KSS', 'M', 'F',
];

/** Pool every level across a set of series, then tabulate once. */
function pool(barSets, label) {
  const perTest = new Map();
  let levels = 0; let broke = 0;
  const clauses = {
    price: { withT: [0, 0], withoutT: [0, 0] },
    time: { withT: [0, 0], withoutT: [0, 0] },
  };

  for (const bars of barSets) {
    const r = levelTestStudy(bars);
    if (!r.available) continue;
    levels += r.levels_with_at_least_one_test;
    broke += Math.round((r.overall_break_rate_pct / 100) * r.levels_with_at_least_one_test);

    for (const row of r.hazard_by_test_number) {
      const cur = perTest.get(row.test_number) || { reached: 0, broke: 0 };
      cur.reached += row.levels_reaching;
      cur.broke += row.broke_here;
      perTest.set(row.test_number, cur);
    }
    for (const [key, src] of [['price', r.aggression_through_price], ['time', r.aggression_through_time]]) {
      if (src.with_clause.break_rate_pct !== null) {
        clauses[key].withT[0] += Math.round((src.with_clause.break_rate_pct / 100) * src.with_clause.n);
        clauses[key].withT[1] += src.with_clause.n;
      }
      if (src.without_clause.break_rate_pct !== null) {
        clauses[key].withoutT[0] += Math.round((src.without_clause.break_rate_pct / 100) * src.without_clause.n);
        clauses[key].withoutT[1] += src.without_clause.n;
      }
    }
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const hazard = [...perTest.entries()]
    .filter(([, v]) => v.reached >= 30)
    .sort((a, b) => a[0] - b[0])
    .map(([n, v]) => ({ n, reached: v.reached, break_rate_pct: pct(v.broke, v.reached) }));

  const clauseOut = (c) => {
    const w = pct(c.withT[0], c.withT[1]);
    const o = pct(c.withoutT[0], c.withoutT[1]);
    return {
      with: w, n_with: c.withT[1], without: o, n_without: c.withoutT[1],
      lift: w !== null && o !== null ? Math.round((w - o) * 10) / 10 : null,
      /** Two-proportion z, so a lift comes with whether it could be chance. */
      z: (() => {
        const n1 = c.withT[1]; const n2 = c.withoutT[1];
        if (!n1 || !n2) return null;
        const p1 = c.withT[0] / n1; const p2 = c.withoutT[0] / n2;
        const p = (c.withT[0] + c.withoutT[0]) / (n1 + n2);
        const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
        return se > 0 ? Math.round(((p1 - p2) / se) * 100) / 100 : null;
      })(),
    };
  };

  return {
    label, levels,
    overall_break_rate_pct: pct(broke, levels),
    hazard,
    hazard_trend: hazard.length >= 3
      ? Math.round((hazard[hazard.length - 1].break_rate_pct - hazard[0].break_rate_pct) * 10) / 10
      : null,
    clause_price: clauseOut(clauses.price),
    clause_time: clauseOut(clauses.time),
  };
}

// ---- noise arm -------------------------------------------------------------
const noiseSets = [];
for (let seed = 1; seed <= WALKS; seed += 1) {
  noiseSets.push(normalizeBars(barsFromPath(randomWalk({ n: BARS, vol: 0.015, seed }))));
}
const arms = [pool(noiseSets, `random walk (${WALKS} x ${BARS})`)];

// ---- real arms -------------------------------------------------------------
if (!NOISE_ONLY) {
  // Ask for double the window so the period split has two disjoint halves.
  const batch1 = await loadRealBars(IN_SAMPLE, { timeframe: TIMEFRAME, count: BARS * 2 + 20 });
  process.stderr.write(`\n${describeBatch(batch1, 'in-sample')}\n`);
  const batch2 = await loadRealBars(OOS_UNIVERSE, { timeframe: TIMEFRAME, count: BARS + 20 });
  process.stderr.write(`${describeBatch(batch2, 'oos-universe')}\n\n`);

  // Split the in-sample symbols in TIME. The newest window is in-sample, the
  // older, non-overlapping window is the period holdout.
  const recent = []; const older = [];
  for (const { bars } of batch1.sets) {
    if (bars.length < 200) continue;
    const half = Math.floor(bars.length / 2);
    older.push(bars.slice(0, half));
    recent.push(bars.slice(half));
  }

  arms.push(pool(recent, `IN-SAMPLE 20 large caps, newest half`));
  arms.push(pool(batch2.sets.map((s) => s.bars), `OOS-UNIVERSE 20 other symbols`));
  arms.push(pool(older, `OOS-PERIOD same 20, older half`));

  console.log(`\nResolution actually measured: ${batch1.actual_resolution} (requested ${TIMEFRAME})`);
}

// ---- report ---------------------------------------------------------------
console.log(`\nShannon's touch-count inversion — count claim vs mechanism clause\n`);

console.log('P(break AT test n | level reached test n)');
const maxN = Math.max(...arms.map((a) => a.hazard.length));
process.stdout.write('  test n');
for (const a of arms) process.stdout.write(`  ${a.label.slice(0, 22).padStart(23)}`);
process.stdout.write('\n');
for (let i = 0; i < maxN; i += 1) {
  process.stdout.write(`  ${String(arms[0].hazard[i]?.n ?? i + 1).padStart(6)}`);
  for (const a of arms) {
    const h = a.hazard[i];
    process.stdout.write(`  ${(h ? `${h.break_rate_pct}% (${h.reached})` : '-').padStart(23)}`);
  }
  process.stdout.write('\n');
}

console.log('\nHazard trend (test 1 -> last), and the two clauses:\n');
console.log(`  ${'arm'.padEnd(34)}${'levels'.padStart(7)}${'trend'.padStart(8)}${'price lift'.padStart(12)}${'z'.padStart(7)}${'time lift'.padStart(11)}${'z'.padStart(7)}`);
for (const a of arms) {
  console.log(`  ${a.label.padEnd(34)}${String(a.levels).padStart(7)}${String(a.hazard_trend).padStart(8)}`
    + `${String(a.clause_price.lift).padStart(12)}${String(a.clause_price.z).padStart(7)}`
    + `${String(a.clause_time.lift).padStart(11)}${String(a.clause_time.z).padStart(7)}`);
}

if (arms.length > 1) {
  const [noise, inS, oosU, oosP] = arms;
  console.log('\nVERDICT — count claim:');
  console.log(`  hazard trend: noise ${noise.hazard_trend}, in-sample ${inS.hazard_trend}, `
    + `oos-universe ${oosU.hazard_trend}, oos-period ${oosP.hazard_trend}`);
  const beats = [inS, oosU, oosP].filter((a) => (a.hazard_trend ?? 0) > (noise.hazard_trend ?? 0) + 5).length;
  console.log(beats === 0
    ? '  -> DEAD in every arm. The rise is exposure arithmetic, not absorption.'
    : `  -> beats the null in ${beats}/3 real arms. Worth another look.`);

  console.log('\nVERDICT — price-pressure clause:');
  for (const a of [inS, oosU, oosP]) {
    const c = a.clause_price;
    const holds = c.lift !== null && c.lift > 5 && Math.abs(c.z ?? 0) > 1.96;
    console.log(`  ${a.label.padEnd(34)} lift ${String(c.lift).padStart(6)}  z ${String(c.z).padStart(6)}  n ${c.n_with}+${c.n_without}  ${holds ? 'HOLDS' : 'does not hold'}`);
  }
  const held = [inS, oosU, oosP].filter((a) => a.clause_price.lift > 5 && Math.abs(a.clause_price.z ?? 0) > 1.96).length;
  console.log(`  noise lift ${noise.clause_price.lift} (z ${noise.clause_price.z}) — the null carries nothing, as it should.`);
  console.log(held === 3
    ? '  -> HOLDS OUT OF SAMPLE in all three arms. Promote it.'
    : held === 0
      ? '  -> FAILS EVERYWHERE. The first result was this sample, not this market.'
      : `  -> holds in ${held}/3. Partial. Report the split; do not quote the best arm alone.`);
}
console.log();
