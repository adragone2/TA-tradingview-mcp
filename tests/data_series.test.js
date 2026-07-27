/**
 * Series-settling tests for the shared OHLCV read.
 *
 * These payloads are not invented. Each one was captured from the live chart
 * (BATS:AAPL 1D -> BATS:CSCO 1D, and BATS:CSCO 1D -> 60) by sampling
 * mainSeries() every 25ms across a symbol and a timeframe change. They are the
 * states the old fetch read straight through and reported as analysis.
 *
 * The failure that motivated this: two patterns_detect calls seconds apart
 * returned last_price 281.97 and 184.38 with an IDENTICAL last bar timestamp.
 * Identical timestamps prove nothing — every US equity on 1D shares the same
 * daily bar time — so a stale series is invisible from the bars alone.
 *
 * Run: node --test tests/data_series.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assessSeriesRead } from '../src/core/data.js';

const bars = (n, close) =>
  Array.from({ length: n }, (_, i) => ({
    time: 1785159000 - (n - 1 - i) * 86400,
    open: close, high: close, low: close, close, volume: 1,
  }));

/** t=581ms after the symbol change: everything agrees, data has arrived. */
const settled = () => ({
  settled: true, symbol: 'BATS:CSCO', resolution: '1D',
  isLoading: false, seriesLoaded: true, status: 3,
  bars: bars(300, 113.51), total_bars: 300, waited_ms: 581,
});

describe('assessSeriesRead', () => {
  it('accepts a settled series and hands the payload back', () => {
    const p = settled();
    assert.equal(assessSeriesRead(p), p);
  });

  it('rejects the stale window where the API symbol has flipped but the bars have not', () => {
    // Live capture, t=61ms: chart.symbol() already says CSCO, symbolInfo() is
    // still null, and bars still hold AAPL's 336.255 close.
    assert.throws(() => assessSeriesRead({
      settled: false, symbol: null, resolution: '1D',
      isLoading: true, seriesLoaded: false, status: 2,
      bars: bars(300, 336.255), total_bars: 300, waited_ms: 61,
    }), /still loading|not settled/i);
  });

  it('rejects the window where symbolInfo ALSO reports the new symbol but the bars are still the old one', () => {
    // Live capture, t=193ms. This is the dangerous one: chart.symbol() AND
    // symbolInfo().full_name both say CSCO, bar count is a full 300, and the
    // last bar timestamp is correct — yet every price is AAPL's. A symbol
    // check alone would pass this. Only isLoading/seriesLoaded catch it.
    assert.throws(() => assessSeriesRead({
      settled: false, symbol: 'BATS:CSCO', resolution: '1D',
      isLoading: true, seriesLoaded: false, status: 2,
      bars: bars(300, 336.255), total_bars: 300, waited_ms: 193,
    }), /still loading|not settled/i);
  });

  it('rejects a half-filled series that seriesLoaded already calls loaded', () => {
    // Live capture, t=301ms of a 1D -> 60 change: seriesLoaded had flipped to
    // true and size was a plausible 300, but the series was still filling and
    // settled at 303 bars 165ms later. seriesLoaded alone is not enough.
    assert.throws(() => assessSeriesRead({
      settled: false, symbol: 'BATS:CSCO', resolution: '60',
      isLoading: true, seriesLoaded: true, status: 2,
      bars: bars(300, 113.48), total_bars: 300, waited_ms: 301,
    }), /still loading|not settled/i);
  });

  it('rejects the emptied series mid-timeframe-change', () => {
    // Live capture, t=143ms of a 1D -> 60 change: size dropped to 0.
    assert.throws(() => assessSeriesRead({
      settled: false, symbol: 'BATS:CSCO', resolution: '60',
      isLoading: true, seriesLoaded: false, status: 2,
      bars: [], total_bars: 0, waited_ms: 143,
    }), /still loading|not settled/i);
  });

  it('names the symbol, the timeframe and the loading flags in the error', () => {
    // "Explicitly report that the series was not settled" means the caller can
    // see WHICH series was in flight, not just that something went wrong.
    assert.throws(() => assessSeriesRead({
      settled: false, symbol: 'BATS:CSCO', resolution: '60',
      isLoading: true, seriesLoaded: false, status: 2,
      bars: bars(300, 336.255), total_bars: 300, waited_ms: 8000,
    }), (err) => {
      assert.match(err.message, /BATS:CSCO/);
      assert.match(err.message, /60/);
      assert.match(err.message, /isLoading=true/);
      assert.match(err.message, /seriesLoaded=false/);
      assert.match(err.message, /8000/);
      return true;
    });
  });

  it('refuses a settled series that came back empty rather than calling it success', () => {
    assert.throws(() => assessSeriesRead({
      settled: true, symbol: 'BATS:CSCO', resolution: '1D',
      isLoading: false, seriesLoaded: true, status: 3,
      bars: [], total_bars: 0, waited_ms: 20,
    }), /no bars|held no bars/i);
  });

  it('reports a page-side error instead of swallowing it', () => {
    assert.throws(
      () => assessSeriesRead({ error: 'mainSeries is not a function' }),
      /mainSeries is not a function/,
    );
  });

  it('reports a missing response instead of returning undefined', () => {
    assert.throws(() => assessSeriesRead(null), /no response|could not read/i);
  });
});
