/**
 * Load real bars for a list of symbols at an EXPLICIT timeframe, then restore
 * the chart.
 *
 * This exists because of a mistake worth not repeating. Three measurement
 * scripts called setSymbol but never setTimeframe, so they silently inherited
 * whatever resolution the chart happened to be on — 60-minute, as it turned
 * out — while their results were recorded as "daily bars". The numbers were
 * real measurements of the wrong thing, and nothing in the output would have
 * revealed it.
 *
 * So: the timeframe is a required argument, it is echoed back in the result, and
 * BOTH symbol and resolution are restored afterwards. A scan drives the chart
 * and must put it back.
 */
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { normalizeBars } from '../src/core/structure.js';

/**
 * @param {string[]} symbols
 * @param {object}   opts
 * @param {string}   opts.timeframe  Required, e.g. "1D". Never defaulted.
 * @param {number}   opts.count      Bars to request per symbol.
 * @param {number}   opts.skipNewest Drop this many newest bars (1 for the
 *                                   partial daily bar, whose high/low/volume
 *                                   are not a day's).
 */
export async function loadRealBars(symbols, { timeframe, count = 420, skipNewest = 1 } = {}) {
  if (!timeframe) {
    throw new Error('loadRealBars needs an explicit timeframe. Inheriting the chart\'s resolution is how a 60-minute '
      + 'measurement got recorded as daily.');
  }

  const before = await chart.getState();
  const restoreSymbol = before?.symbol || null;
  const restoreResolution = before?.resolution || null;

  const sets = [];
  const failures = [];
  let actualResolution = null;

  try {
    await chart.setTimeframe({ timeframe });
    for (const symbol of symbols) {
      try {
        await chart.setSymbol({ symbol });
        const series = await data.getOhlcv({ count, summary: false });
        const bars = normalizeBars(series);
        if (!actualResolution) actualResolution = series.resolution;
        // Verify rather than trust: if the resolution did not take, every
        // number downstream is mislabelled again.
        if (series.resolution && actualResolution && String(series.resolution) !== String(actualResolution)) {
          throw new Error(`resolution drifted to ${series.resolution}, expected ${actualResolution}`);
        }
        const trimmed = skipNewest > 0 ? bars.slice(0, -skipNewest) : bars;
        sets.push({ symbol, bars: trimmed, resolution: series.resolution });
        process.stderr.write(`  ${symbol}: ${trimmed.length} bars @ ${series.resolution}\n`);
      } catch (err) {
        failures.push({ symbol, error: err.message });
        process.stderr.write(`  ${symbol}: ${err.message}\n`);
      }
    }
  } finally {
    if (restoreSymbol) { try { await chart.setSymbol({ symbol: restoreSymbol }); } catch {} }
    if (restoreResolution) { try { await chart.setTimeframe({ timeframe: String(restoreResolution) }); } catch {} }
  }

  return {
    sets,
    failures,
    requested_timeframe: timeframe,
    actual_resolution: actualResolution,
    restored: { symbol: restoreSymbol, resolution: restoreResolution },
  };
}

/** Sanity-check a loaded batch before any number is computed from it. */
export function describeBatch(batch, label) {
  const bars = batch.sets.reduce((a, s) => a + s.bars.length, 0);
  return `${label}: ${batch.sets.length} symbols, ${bars} bars, resolution ${batch.actual_resolution}`
    + `${batch.failures.length ? ` (${batch.failures.length} failed)` : ''}`;
}
