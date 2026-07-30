#!/usr/bin/env node
/**
 * Shannon's touch-count inversion, measured against its own null.
 *
 * The claim (ch. 7, figs 7.4/7.5): the MORE times a level is tested, the MORE
 * likely it is to break — absorption, not reinforcement. This contradicts how
 * `findKeyLevels` in this repo scores levels, where touch count IS strength. If
 * Shannon is right, that scoring has the sign backwards.
 *
 * The trap: more touches means more exposure, so P(break | n tests) rises with n
 * on a random walk with no absorption anywhere. So the only thing that settles
 * it is the SHAPE of the hazard rate on real data against the SAME shape on
 * matched noise — and the two aggression clauses measured as conditionals,
 * because that is where a real mechanism would show up if there is one.
 *
 *   node scripts/level-test-inversion.js
 *   node scripts/level-test-inversion.js --noise
 */
import { levelTestStudy } from '../src/core/level_tests.js';
import { normalizeBars } from '../src/core/structure.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

const NOISE_ONLY = process.argv.includes('--noise');
const WALKS = 200;
const BARS = 400;
const SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'JNJ', 'PG',
  'HD', 'PNC', 'BAC', 'CVX', 'MRK', 'PFE', 'KO', 'DIS', 'INTC', 'CSCO',
];

/** Pool every level across a set of series, then tabulate once. */
function pool(barSets, label) {
  const perTest = new Map();   // n -> { reached, broke }
  let levels = 0; let broke = 0;
  const clauses = {
    price: { withT: [0, 0], withoutT: [0, 0] },   // [broke, total]
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

  return {
    label,
    levels,
    overall_break_rate_pct: pct(broke, levels),
    hazard,
    clause_price: {
      with: pct(clauses.price.withT[0], clauses.price.withT[1]), n_with: clauses.price.withT[1],
      without: pct(clauses.price.withoutT[0], clauses.price.withoutT[1]), n_without: clauses.price.withoutT[1],
    },
    clause_time: {
      with: pct(clauses.time.withT[0], clauses.time.withT[1]), n_with: clauses.time.withT[1],
      without: pct(clauses.time.withoutT[0], clauses.time.withoutT[1]), n_without: clauses.time.withoutT[1],
    },
  };
}

const noiseSets = [];
for (let seed = 1; seed <= WALKS; seed += 1) {
  noiseSets.push(normalizeBars(barsFromPath(randomWalk({ n: BARS, vol: 0.015, seed }))));
}
const noise = pool(noiseSets, 'random walk');

let real = null;
if (!NOISE_ONLY) {
  const data = await import('../src/core/data.js');
  const chart = await import('../src/core/chart.js');
  let restore = null;
  try {
    restore = (await chart.getState())?.symbol || null;
    const sets = [];
    for (const sym of SYMBOLS) {
      try {
        await chart.setSymbol({ symbol: sym });
        const bars = normalizeBars(await data.getOhlcv({ count: BARS + 20, summary: false }));
        sets.push(bars.slice(0, -1));
        process.stderr.write(`  ${sym}: ${bars.length}\n`);
      } catch (err) { process.stderr.write(`  ${sym}: ${err.message}\n`); }
    }
    real = pool(sets, 'real data');
  } catch (err) {
    process.stderr.write(`\nChart unavailable, noise arm only: ${err.message}\n`);
  } finally {
    if (restore) { try { await chart.setSymbol({ symbol: restore }); } catch {} }
  }
}

console.log(`\nShannon's touch-count inversion: does a level weaken with each test?\n`);
console.log(`  ${WALKS} random walks x ${BARS} bars${real ? `, plus ${SYMBOLS.length} symbols x ~${BARS} daily bars` : ''}\n`);

const maxN = Math.max(noise.hazard.length, real?.hazard.length || 0);
console.log('  P(break AT test n | level reached test n)');
console.log(`  test n  ${'random walk'.padStart(14)}  ${real ? 'real data'.padStart(14) : ''}`);
for (let i = 0; i < maxN; i += 1) {
  const nz = noise.hazard[i];
  const rd = real?.hazard[i];
  const n = nz?.n ?? rd?.n;
  console.log(`  ${String(n).padStart(6)}  ${`${nz ? `${nz.break_rate_pct}% (n=${nz.reached})` : '-'}`.padStart(14)}  `
    + `${real ? `${rd ? `${rd.break_rate_pct}% (n=${rd.reached})` : '-'}`.padStart(14) : ''}`);
}

const trend = (h) => (h.length >= 3
  ? Math.round((h[h.length - 1].break_rate_pct - h[0].break_rate_pct) * 10) / 10
  : null);
const nzTrend = trend(noise.hazard);
const rdTrend = real ? trend(real.hazard) : null;

console.log(`\n  Hazard trend, test 1 -> test ${noise.hazard.at(-1)?.n}:`);
console.log(`    random walk  ${nzTrend > 0 ? '+' : ''}${nzTrend} points`);
if (real) console.log(`    real data    ${rdTrend > 0 ? '+' : ''}${rdTrend} points`);

console.log('\n  The aggression clauses (eventual break rate):');
for (const [name, key] of [['through PRICE (rising interim lows)', 'clause_price'], ['through TIME (tests closer together)', 'clause_time']]) {
  console.log(`\n    ${name}`);
  console.log(`      random walk  with ${noise[key].with}% (n=${noise[key].n_with})  without ${noise[key].without}% (n=${noise[key].n_without})  `
    + `lift ${Math.round((noise[key].with - noise[key].without) * 10) / 10}`);
  if (real) {
    console.log(`      real data    with ${real[key].with}% (n=${real[key].n_with})  without ${real[key].without}% (n=${real[key].n_without})  `
      + `lift ${Math.round((real[key].with - real[key].without) * 10) / 10}`);
  }
}

console.log('\nVerdict:');
if (!real) {
  console.log('  Noise arm only. The null alone cannot settle the claim — rerun with the chart up.');
} else {
  const excess = (rdTrend ?? 0) - (nzTrend ?? 0);
  console.log(`  Hazard rises by ${rdTrend} points on real data and ${nzTrend} on noise (excess ${excess > 0 ? '+' : ''}${Math.round(excess * 10) / 10}).`);
  console.log(`  Overall break rate: real ${real.overall_break_rate_pct}%, noise ${noise.overall_break_rate_pct}%.`);
  if (excess > 5) {
    console.log('  -> The inversion has excess over its null. Shannon may be right, and findKeyLevels scoring');
    console.log('     touch count as STRENGTH would have the sign backwards. Needs a trial count before use.');
  } else if (excess < -5) {
    console.log('  -> Real data shows LESS of the effect than noise. The rise in hazard is exposure arithmetic,');
    console.log('     not absorption. Shannon\'s mechanism is not visible here.');
  } else {
    console.log('  -> NO EXCESS over the null. The hazard rises for the trivial reason (more tests = more');
    console.log('     exposure), so touch count says nothing about the NEXT test in either direction.');
    console.log('     Do NOT invert findKeyLevels on this evidence, and do not defend it either.');
  }
}
console.log();
