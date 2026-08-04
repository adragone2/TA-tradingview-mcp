/**
 * The noise floor for ConnorsRSI: what does the gauge do on PURE NOISE?
 *
 * Two measurements over 200 random walks x 300 bars, headless:
 *   1. OCCUPANCY — the share of readable bars below 5/10/20 and above 80/90/95.
 *      By construction an oscillator visits its tails; the question is how often,
 *      so a real chart's "it was oversold" has a base rate beside it.
 *   2. THE LIFT NULL — mean next-5-bar return after CRSI<10, minus the
 *      unconditional mean next-5-bar return, per walk. Under no-edge this
 *      averages ~0; the SPREAD across walks is the yardstick any real-data
 *      mean-reversion lift has to clear before it means anything.
 */
import { randomWalkWithGaps } from '../src/core/synthetic.js';
import { connorsRsiSeries } from '../src/core/connors_rsi.js';

const WALKS = 200;
const BARS = 300;
const HORIZON = 5;
const OVERSOLD = 10;

const bands = { lt5: 0, lt10: 0, lt20: 0, gt80: 0, gt90: 0, gt95: 0 };
let readable = 0;
const lifts = [];

for (let s = 0; s < WALKS; s++) {
  const { bars } = randomWalkWithGaps({ n: BARS, seed: 7000 + s, volume_mode: 'lognormal' });
  const closes = bars.map((b) => b.close);
  const crsi = connorsRsiSeries(closes);

  const fwd = (i) => (i + HORIZON < closes.length ? (closes[i + HORIZON] - closes[i]) / closes[i] : null);
  const uncond = [], cond = [];
  for (let i = 0; i < crsi.length; i++) {
    const v = crsi[i];
    if (v == null) continue;
    readable++;
    if (v < 5) bands.lt5++;
    if (v < 10) bands.lt10++;
    if (v < 20) bands.lt20++;
    if (v > 80) bands.gt80++;
    if (v > 90) bands.gt90++;
    if (v > 95) bands.gt95++;
    const f = fwd(i);
    if (f == null) continue;
    uncond.push(f);
    if (v < OVERSOLD) cond.push(f);
  }
  if (cond.length >= 3 && uncond.length) {
    const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    lifts.push((m(cond) - m(uncond)) * 100);
  }
}

const pct = (x) => Math.round((x / readable) * 1000) / 10;
const mean = lifts.reduce((a, b) => a + b, 0) / lifts.length;
const sd = Math.sqrt(lifts.reduce((a, b) => a + (b - mean) ** 2, 0) / lifts.length);

console.log(`walks ${WALKS}, bars ${BARS}, readable bars ${readable}`);
console.log(`occupancy: <5 ${pct(bands.lt5)}%  <10 ${pct(bands.lt10)}%  <20 ${pct(bands.lt20)}%  >80 ${pct(bands.gt80)}%  >90 ${pct(bands.gt90)}%  >95 ${pct(bands.gt95)}%`);
console.log(`lift null (CRSI<${OVERSOLD}, next ${HORIZON} bars): mean ${mean.toFixed(3)}pp, sd ${sd.toFixed(3)}pp across ${lifts.length} walks with enough events`);
console.log('\nPaste into CONNORS_RSI_NOISE in src/core/connors_rsi.js.');
