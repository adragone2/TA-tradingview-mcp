#!/usr/bin/env node
/**
 * How often is a big move in days-to-cover actually a change in LIQUIDITY
 * rather than in short positioning?
 *
 * Shannon's Figure 15.1 contains the trap: days-to-cover falls 12.91 -> 4.11
 * (-68%) while the short position moves only -7%, because average volume
 * tripled. He reads the table correctly himself, but nothing in the ratio warns
 * a reader who does not.
 *
 * This measures how common that is on real data, so `short_interest`'s
 * decomposition carries a number rather than an anecdote. Every other detector
 * in this repo ships with its noise floor; this is the same discipline applied
 * to a ratio.
 *
 *   node scripts/short-interest-driver.js
 *   node scripts/short-interest-driver.js --threshold 20 --periods 24
 */
import { fetchSeries, buildSeries, decomposeDaysToCover, normalizeRow } from '../src/core/finra.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

const THRESHOLD = arg('threshold', 20);   // "big" move in days-to-cover, percent
const PERIODS = arg('periods', 24);       // settlement periods per symbol (~1 year)

/**
 * A deliberately mixed sample: mega-caps, mid-caps, heavily-shorted names and
 * illiquid ones, so the result is not an artefact of one liquidity band.
 */
const SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'PNC', 'BAC',
  'XOM', 'CVX', 'JNJ', 'PFE', 'MRK', 'CYTK', 'SRPT', 'ALNY', 'BMRN', 'IONS',
  'GME', 'AMC', 'BBY', 'M', 'KSS', 'F', 'GM', 'DAL', 'UAL', 'CCL',
  'PLUG', 'FCEL', 'RIOT', 'MARA', 'AI', 'UPST', 'AFRM', 'SOFI', 'HOOD', 'RIVN',
];

const asOf = new Date().toISOString().slice(0, 10);

let bigMoves = 0;
let liquidityDriven = 0;
let allMoves = 0;
let liquidityAll = 0;
const perSymbol = [];
const worst = [];
let failed = 0;

for (const sym of SYMBOLS) {
  let rows;
  try {
    ({ rows } = await fetchSeries(sym, { periods: PERIODS, asOf }));
  } catch (err) {
    process.stderr.write(`  ${sym}: ${err.message}\n`);
    failed += 1;
    continue;
  }
  if (rows.length < 3) { failed += 1; continue; }

  const series = rows.map(normalizeRow)
    .filter((r) => r.settlement_date)
    .sort((a, b) => (a.settlement_date < b.settlement_date ? 1 : -1));

  let big = 0; let liq = 0;
  for (let i = 0; i < series.length - 1; i += 1) {
    const d = decomposeDaysToCover(series[i + 1], series[i]);
    if (!d.available) continue;
    allMoves += 1;
    if (d.driver === 'average_volume') liquidityAll += 1;
    if (Math.abs(d.days_to_cover_change_pct) >= THRESHOLD) {
      big += 1; bigMoves += 1;
      if (d.driver === 'average_volume') {
        liq += 1; liquidityDriven += 1;
        worst.push({
          symbol: sym, date: series[i].settlement_date,
          dtc: d.days_to_cover_change_pct, si: d.short_interest_change_pct, adv: d.average_volume_change_pct,
        });
      }
    }
  }
  perSymbol.push({ symbol: sym, periods: series.length, big, liq });
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

console.log(`\nShort-interest days-to-cover: what actually moves the ratio`);
console.log(`asOf ${asOf} | ${SYMBOLS.length - failed}/${SYMBOLS.length} symbols | ${PERIODS} periods requested each`);
console.log(`"big" = |days-to-cover change| >= ${THRESHOLD}%\n`);

console.log(`ALL period-over-period changes:      ${allMoves}`);
console.log(`  driven by AVERAGE VOLUME:          ${liquidityAll}  (${pct(liquidityAll, allMoves)}%)`);
console.log(`BIG changes (>= ${THRESHOLD}%):${' '.repeat(Math.max(1, 16 - String(THRESHOLD).length))}${bigMoves}  (${pct(bigMoves, allMoves)}% of all)`);
console.log(`  driven by AVERAGE VOLUME:          ${liquidityDriven}  (${pct(liquidityDriven, bigMoves)}% of big moves)`);

console.log(`\nThe finding: ${pct(liquidityDriven, bigMoves)}% of large days-to-cover moves are a change in LIQUIDITY,`);
console.log(`not in short positioning. Quoting days-to-cover alone gets the direction of`);
console.log(`the story wrong about that often. Read vs_prior_period.driver first.`);

worst.sort((a, b) => Math.abs(b.dtc) - Math.abs(a.dtc));
console.log(`\nLargest liquidity-driven moves (days-to-cover moved, the short position did not):`);
console.log(`  ${'sym'.padEnd(7)}${'date'.padEnd(13)}${'DTC%'.padStart(9)}${'SI%'.padStart(9)}${'ADV%'.padStart(10)}`);
for (const w of worst.slice(0, 12)) {
  console.log(`  ${w.symbol.padEnd(7)}${w.date.padEnd(13)}${String(w.dtc).padStart(9)}${String(w.si).padStart(9)}${String(w.adv).padStart(10)}`);
}

const bySym = perSymbol.filter((s) => s.big > 0).sort((a, b) => pct(b.liq, b.big) - pct(a.liq, a.big));
console.log(`\nPer symbol, share of big moves that were liquidity-driven:`);
for (const s of bySym.slice(0, 10)) {
  console.log(`  ${s.symbol.padEnd(7)} ${String(s.liq).padStart(2)}/${String(s.big).padEnd(2)}  ${String(pct(s.liq, s.big)).padStart(5)}%   (${s.periods} periods)`);
}
if (failed) console.log(`\n${failed} symbol(s) returned too few rows to measure and were skipped.`);
console.log();
