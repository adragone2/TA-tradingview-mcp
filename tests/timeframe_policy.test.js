import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  TIER_TIMEFRAMES, timeframeFor, barMinutes, isDailyOrHigher,
  barWindowNote, horizonApplies, SESSION_MINUTES,
} from '../src/core/timeframe_policy.js';

/**
 * The analysis timeframe follows the EXECUTION TIER.
 *
 * Everything was analysed on the daily, intraday candidates included. On a daily
 * chart a whole session is one bar, so an intraday setup is not merely hard to see
 * — it is not representable, and every level and pattern drawn for an INTRADAY name
 * described a horizon it would never be held for.
 */

describe('the owner\'s configuration', () => {
  test('intraday is 5-minute for setups, 15-minute for the broader trend', () => {
    const p = timeframeFor('intraday');
    assert.equal(p.analysis, '5');
    assert.equal(p.context, '15');
  });

  test('weekly and monthly are daily, with weekly macro and a 4-hour trigger', () => {
    for (const t of ['weekly', 'monthly']) {
      const p = timeframeFor(t);
      assert.equal(p.analysis, '1D', `${t} analysis`);
      assert.equal(p.context, '1W', `${t} macro`);
      assert.equal(p.trigger, '240', `${t} entry tuning`);
    }
  });

  test('the intraday execution window is carried as data', () => {
    const w = timeframeFor('intraday').execution_window;
    assert.deepEqual({ start: w.start, end: w.end }, { start: '10:15', end: '14:30' });
    assert.equal(w.tz, 'America/New_York', 'a bare clock time with no zone is a bug waiting to happen');
  });

  test('an unrecognised tier falls back to a daily policy, never to intraday', () => {
    // Defaulting an unknown tier to 5-minute would put a name nobody classified on
    // the shortest horizon in the book.
    assert.equal(timeframeFor(null).analysis, '1D');
    assert.equal(timeframeFor('nonsense').analysis, '1D');
  });
});

describe('a session is 390 minutes', () => {
  test('not 1440 — that error is 3.7x', () => {
    assert.equal(SESSION_MINUTES, 390);
    assert.equal(barMinutes('1D'), 390);
    assert.equal(barMinutes('1W'), 1950);
  });

  test('bare numbers are minutes', () => {
    assert.equal(barMinutes('5'), 5);
    assert.equal(barMinutes('240'), 240);
  });

  test('D and W parse with or without a leading count', () => {
    assert.equal(barMinutes('D'), 390);
    assert.equal(barMinutes('3W'), 5850);
  });

  test('unparseable resolutions return null rather than a wrong number', () => {
    // A silent 0 or NaN here would make every downstream span read as zero sessions.
    for (const bad of ['', null, undefined, '10R', '1T', 'garbage']) {
      assert.equal(barMinutes(bad), null, `${bad} must not parse`);
    }
  });

  test('the daily boundary is inclusive of daily itself', () => {
    assert.equal(isDailyOrHigher('1D'), true);
    assert.equal(isDailyOrHigher('1W'), true);
    assert.equal(isDailyOrHigher('240'), false, '4-hour is four bars a session, not one');
    assert.equal(isDailyOrHigher('5'), false);
  });
});

describe('the calendar labels on assess()\'s windows', () => {
  test('they are TRUE on daily bars', () => {
    const n = barWindowNote('1D');
    assert.equal(n.labels_are_calendar_accurate, true);
    assert.equal(n.windows[0].sessions, 252, '252 daily bars is 252 sessions');
  });

  test('and FALSE on intraday bars, with the real spans given', () => {
    /**
     * `assess()` measures fixed BAR COUNTS captioned 12m/6m/3m/1m. On 5-minute bars
     * 252 bars is 3.2 SESSIONS. Every number stays arithmetically correct and every
     * label on it becomes false — the exact failure this repo records as "pin the
     * timeframe, or the measurement is of something else", after three scripts
     * inherited a 60-minute chart and recorded their results as daily.
     */
    const n = barWindowNote('5');
    assert.equal(n.labels_are_calendar_accurate, false);
    assert.equal(n.windows[0].sessions, 3.2, '252 five-minute bars is 3.2 sessions, not twelve months');
    assert.match(n.note, /The numbers are correct; the calendar labels on them are not/);
  });

  test('60-minute is caught too, which is where this bit before', () => {
    assert.equal(barWindowNote('60').labels_are_calendar_accurate, false);
    assert.equal(barWindowNote('60').windows[0].sessions, 38.8);
  });
});

describe('the horizon prior is measured in TRADING DAYS', () => {
  test('so it applies on daily bars and above', () => {
    assert.equal(horizonApplies('1D').applies, true);
    assert.equal(horizonApplies('1W').applies, true);
  });

  test('and NOT APPLICABLE below, which is not the same as neutral', () => {
    const h = horizonApplies('5');
    assert.equal(h.applies, false);
    assert.match(h.why, /TRADING DAYS/);
    assert.match(h.why, /NOT APPLICABLE is the honest reading, not a neutral one/);
  });
});

describe('the wiring', () => {
  const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

  test('the routine picks the timeframe from the tier, not a constant', () => {
    const m = src('scripts/morning-screen.js');
    assert.match(m, /timeframeFor\(String\(tierOf\(sym\)/,
      'the analysis timeframe must be derived from the section the symbol landed in');
    assert.match(m, /chart\.setTimeframe\(\{ timeframe: policy\.analysis \}\)/);
  });

  test('the DETECTOR GATE stays on daily on purpose', () => {
    /**
     * The screens are daily, so "is this name worth looking at" is a daily question,
     * and the gate runs before a tier is even assigned. Only the per-ticker analysis
     * moves to the tier's chart.
     */
    const m = src('scripts/morning-screen.js');
    const gate = m.slice(m.indexOf('async function loadBars'), m.indexOf('const before = await chart.getState()'));
    assert.match(gate, /timeframe: '1D'/, 'loadBars must pin daily for the gate');
    assert.ok(!/timeframeFor/.test(gate), 'the gate must not vary its timeframe by tier');
  });

  test('intraday history is loaded before it is read', () => {
    /**
     * A fresh 5-minute chart holds 300 bars — TWO SESSIONS — and a default read caps
     * at 500, which is three. Without loading, the intraday analysis would read LESS
     * history than the daily one it replaced: a worse answer wearing a better label.
     */
    const m = src('scripts/morning-screen.js');
    assert.match(m, /chart\.loadHistory\(\{ min_bars: policy\.bars \}\)/);
    assert.match(m, /max: policy\.bars/, 'the read cap must be raised to match');
    assert.match(src('src/core/chart.js'), /requestMoreData/);
  });

  test('the chart goes back to daily after an intraday symbol', () => {
    // Leaving it on 5-minute makes any later failure read as a daily measurement of
    // intraday bars — silent, and exactly the mislabelling that already happened.
    assert.match(src('scripts/morning-screen.js'), /if \(!onDaily\) \{ await chart\.setTimeframe\(\{ timeframe: '1D' \}\)/);
  });

  test('the analysis reports its own calibration', () => {
    const t = src('src/core/ticker_analyze.js');
    assert.match(t, /timeframe_calibration: tf_calibration/);
    assert.match(t, /horizon_applicable: horizon_validity/);
    assert.match(t, /results\.horizon = horizon_validity\.applies/,
      'the horizon SECTION must report NOT APPLICABLE off daily rather than scoring as run');
  });
});
