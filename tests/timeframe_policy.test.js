import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  TIER_TIMEFRAMES, timeframeFor, barMinutes, isDailyOrHigher,
  barWindowNote, horizonApplies, SESSION_MINUTES,
  executionWindowStatus, tierForResolution, WINDOW_NOT_A_GATE,
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

/**
 * The window has been data on the intraday tier since this file was written, and
 * nothing read it — so an intraday entry plan produced at 06:55 ET, before there is
 * a VWAP or an opening range to measure anything against, came out looking exactly
 * like one produced at 11:00.
 *
 * Every timestamp below is an ISO instant in UTC with its ET wall clock named, so a
 * reader can check the arithmetic without trusting the implementation's own clock.
 */
describe('the intraday execution window', () => {
  //  ET wall clock          UTC instant                 offset
  const WED_0655_EDT = Date.parse('2026-07-15T10:55:00Z');   // -4
  const WED_0955_EDT = Date.parse('2026-07-15T13:55:00Z');   // -4, session open, window not
  const WED_1020_EDT = Date.parse('2026-07-15T14:20:00Z');   // -4
  const WED_1550_EDT = Date.parse('2026-07-15T19:50:00Z');   // -4
  const WED_1020_EST = Date.parse('2026-01-14T15:20:00Z');   // -5
  const WED_1014_EST = Date.parse('2026-01-14T15:14:00Z');   // -5
  const WED_1015_EST = Date.parse('2026-01-14T15:15:00Z');   // -5
  const WED_1430_EST = Date.parse('2026-01-14T19:30:00Z');   // -5
  const WED_1431_EST = Date.parse('2026-01-14T19:31:00Z');   // -5
  const SAT_1120_EDT = Date.parse('2026-07-18T15:20:00Z');   // -4

  test('the boundaries: 10:14 is out, 10:15 is in', () => {
    assert.equal(executionWindowStatus('intraday', WED_1014_EST).in_window, false);
    assert.equal(executionWindowStatus('intraday', WED_1014_EST).opens_in_minutes, 1);
    assert.equal(executionWindowStatus('intraday', WED_1015_EST).in_window, true);
  });

  test('the boundaries: 14:30 is the last minute IN, 14:31 is out', () => {
    /**
     * BOTH ends inclusive, deliberately, and different from `sessionState` where
     * 16:00 is already closed. The tier states its window as a RANGE — "10:15-14:30"
     * — and a timestamp stamped 14:30 is inside a range written that way. A session
     * end is a moment; a trading window is a stated range.
     */
    const at = executionWindowStatus('intraday', WED_1430_EST);
    assert.equal(at.in_window, true);
    assert.equal(at.closes_in_minutes, 0);
    const after = executionWindowStatus('intraday', WED_1431_EST);
    assert.equal(after.in_window, false);
    assert.equal(after.closed_since_minutes, 1);
  });

  test('the pre-open case carries the reason, not just the flag', () => {
    const r = executionWindowStatus('intraday', WED_0655_EDT);
    assert.equal(r.status, 'out_of_window');
    assert.equal(r.opens_in_minutes, 200, '06:55 to 10:15 is 3h20m');
    assert.equal(r.session_state, 'premarket');
    assert.match(r.note, /Generated 06:55 ET/);
    assert.match(r.note, /opens at 10:15 ET, in 200 minutes/);
    assert.match(r.note, /do not exist yet/, 'the flag without the reason teaches nothing');
    assert.match(r.note, /no VWAP, no opening range/);
  });

  test('open-but-not-yet-in-window is a DIFFERENT reason from pre-open', () => {
    // At 09:55 the conditions exist — there is a VWAP and an opening range. What is
    // not open is the owner's window. Reusing the pre-open sentence here would be
    // false.
    const r = executionWindowStatus('intraday', WED_0955_EDT);
    assert.equal(r.session_state, 'open');
    assert.equal(r.opens_in_minutes, 20);
    assert.ok(!/do not exist yet/.test(r.note));
    assert.match(r.note, /opening range is still forming/);
  });

  test('after the window it says how long ago, and why late matters', () => {
    const r = executionWindowStatus('intraday', WED_1550_EDT);
    assert.equal(r.closed_since_minutes, 80);
    assert.equal(r.opens_in_minutes, undefined, 'a closed window does not also report an opening');
    assert.match(r.note, /closed at 14:30 ET, 80 minutes ago/);
    assert.match(r.note, /into the close/);
  });

  test('in-window says so, and how much of it is left', () => {
    const r = executionWindowStatus('intraday', WED_1020_EDT);
    assert.equal(r.in_window, true);
    assert.equal(r.status, 'in_window');
    assert.equal(r.closes_in_minutes, 250);
    assert.equal(r.window, '10:15-14:30 ET');
  });
});

describe('the window is DST-correct, which a fixed offset is not', () => {
  test('the same ET wall clock is in-window in January AND in July', () => {
    /**
     * 10:20 ET is 15:20 UTC in winter and 14:20 UTC in summer. A hardcoded UTC-5
     * would read the July instant as 09:20 and report a mid-morning plan as
     * pre-window — for two-thirds of the year, silently. `sessionState` formats
     * through Intl in America/New_York, which is the mechanism this repo already
     * uses precisely because Windows ignores TZ and reports UTC.
     */
    const winter = executionWindowStatus('intraday', Date.parse('2026-01-14T15:20:00Z'));
    const summer = executionWindowStatus('intraday', Date.parse('2026-07-15T14:20:00Z'));
    assert.equal(winter.at, '10:20 ET');
    assert.equal(summer.at, '10:20 ET');
    assert.equal(winter.in_window, true);
    assert.equal(summer.in_window, true, 'a fixed UTC-5 fails exactly here');
  });

  test('and the fixed-offset reading of the summer instant would be out of window', () => {
    // The discriminating half: prove the two instants are genuinely different UTC
    // times, so the test above is not passing by accident.
    const naive = new Date(Date.parse('2026-07-15T14:20:00Z') - 5 * 3600 * 1000).toISOString();
    assert.match(naive, /T09:20/, 'UTC-5 on the July instant is 09:20 — before the window opens');
  });
});

describe('the answers that are NOT "outside the window"', () => {
  test('weekly and monthly are not_applicable, with the reason', () => {
    for (const t of ['weekly', 'monthly']) {
      const r = executionWindowStatus(t, Date.parse('2026-07-15T10:55:00Z'));
      assert.equal(r.status, 'not_applicable', t);
      assert.equal(r.in_window, null, `${t} must not claim false — there is no window to be outside of`);
      assert.match(r.note, /no\s+intraday execution window applies/);
    }
  });

  test('a weekend is out of window, and REFUSES to say how many minutes until it opens', () => {
    /**
     * Counting to the next open needs the next trading day, and market holidays are
     * enumerated nowhere in this repo — session.js says so in its own limitations.
     * A number here would be wrong every Good Friday and every Thanksgiving.
     */
    const r = executionWindowStatus('intraday', Date.parse('2026-07-18T15:20:00Z'));
    assert.equal(r.in_window, false);
    assert.equal(r.session_state, 'weekend');
    assert.equal(r.opens_in_minutes, null, 'null, not a guess');
    assert.match(r.note, /holidays are enumerated nowhere/);
  });

  test('a null timestamp is UNKNOWN, never "fine"', () => {
    const r = executionWindowStatus('intraday', null);
    assert.equal(r.status, 'unknown');
    assert.equal(r.in_window, null);
    assert.match(r.note, /UNKNOWN/);
    assert.match(r.note, /Not assumed to be inside it/);
  });

  test('Number(null) is 0, and 0 is a valid epoch — the guard must be explicit', () => {
    /**
     * The coercion that has already conjured a finding from missing data here, in
     * the equal-weight breadth spread. Without an explicit null check this returns a
     * confident verdict about 1 January 1970.
     */
    assert.equal(Number(null), 0, 'the trap itself');
    for (const bad of [null, undefined, NaN, 0, -1, 'soon', {}]) {
      assert.equal(executionWindowStatus('intraday', bad).status, 'unknown', `${String(bad)} must not verdict`);
    }
  });

  test('the timestamp is NOT defaulted to now, so the function never reads the clock', () => {
    /**
     * A `= Date.now()` default would make the one-argument call impure — and
     * `entryHypothesis` calls this, which is documented pure and tested as such.
     * Omitting the timestamp is the unknown case, not a measurement of now.
     */
    assert.equal(executionWindowStatus('intraday').status, 'unknown');
  });

  test('an unrecognised tier is unknown — it does NOT fall back to weekly', () => {
    /**
     * `timeframeFor` defaults an unknown tier to weekly, which is right for choosing
     * a chart resolution and wrong here: it would turn "nobody said what this is"
     * into the positive claim "no window applies".
     */
    assert.equal(timeframeFor('nonsense').analysis, '1D', 'the contrast this is about');
    for (const t of [null, undefined, '', 'nonsense', 'swing']) {
      const r = executionWindowStatus(t, Date.parse('2026-07-15T10:55:00Z'));
      assert.equal(r.status, 'unknown', `${String(t)} must not resolve to a tier`);
      assert.notEqual(r.status, 'not_applicable');
    }
  });

  test('every answer carries the it-is-not-a-gate line', () => {
    // Three market-alignment gates have been forward-tested here and all three
    // failed. This is the fourth thing that looks like one, so it disclaims itself.
    const at = Date.parse('2026-07-15T10:55:00Z');
    for (const t of ['intraday', 'weekly', null]) {
      assert.equal(executionWindowStatus(t, at).not_a_gate, WINDOW_NOT_A_GATE, String(t));
    }
    assert.equal(executionWindowStatus('intraday', null).not_a_gate, WINDOW_NOT_A_GATE);
    assert.match(WINDOW_NOT_A_GATE, /never a filter/);
  });
});

describe('tierForResolution only claims what a resolution could ONLY mean', () => {
  test('5 and 15 minute are the intraday policy\'s own two resolutions', () => {
    assert.equal(tierForResolution('5'), 'intraday');
    assert.equal(tierForResolution('15'), 'intraday');
    assert.equal(tierForResolution(TIER_TIMEFRAMES.intraday.analysis), 'intraday');
    assert.equal(tierForResolution(TIER_TIMEFRAMES.intraday.context), 'intraday');
  });

  test('everything else is null, including 60-minute and daily', () => {
    /**
     * Daily cannot distinguish weekly from monthly, and 60-minute is a resolution a
     * swing trader legitimately uses to fine-tune an entry. Guessing either way
     * would attach an execution window to a trade that has none, or deny one that
     * does.
     */
    for (const r of ['60', '240', '1D', 'D', '1W', '', null, undefined, 'garbage']) {
      assert.equal(tierForResolution(r), null, `${String(r)} must not imply a tier`);
    }
  });
});

describe('the wiring', () => {
  const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

  test('the routine picks the timeframe from the tier, not a constant', () => {
    const m = src('scripts/morning-screen.js');
    // P3.5 integration (2026-07-30): the tier expression is hoisted to
    // `tierKey` so the same value feeds BOTH the timeframe policy and
    // analyzeTicker's execution-window annotation — one derivation, two
    // consumers, no way for them to disagree.
    assert.match(m, /const tierKey = String\(tierOf\(sym\) \|\| ''\)\.toLowerCase\(\)/,
      'the tier must be derived from the section the symbol landed in');
    assert.match(m, /timeframeFor\(tierKey\)/,
      'the analysis timeframe must come from that tier');
    assert.match(m, /tier: tierKey \|\| null/,
      'and the SAME tier must reach analyzeTicker, so the execution-window annotation fires on the 05:30 run');
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

  test('the entry_hypothesis TOOL supplies the clock, since the core refuses to read it', () => {
    /**
     * `entryHypothesis` is pure and `executionWindowStatus` has no `Date.now()`
     * default, so if the tool does not pass a timestamp the annotation can never
     * appear on a live call — the feature would be code nobody reaches. This is the
     * repo's own rule about a step you have to remember, applied to a parameter.
     */
    const p = src('src/tools/playbook.js');
    assert.match(p, /tier: resolved,\s*\n\s*now: Date\.now\(\),/,
      'the tool must pass both the tier and the moment into entryHypothesis');
    assert.match(p, /tierForResolution\(raw\?\.resolution/,
      'and derive the tier from the chart when the caller did not state one');
  });

  test('assess() cannot carry this annotation, and the reason is its signature', () => {
    /**
     * `trade_plans` is built inside `assess(bars, spy)`. There is no tier and no
     * timestamp in that call — not hidden, absent — so annotating trade_plans would
     * mean inventing a tier at the layer that measures. Plumbing a guess there is
     * worse than the gap: it would put a confident window verdict on every swing
     * plan in the book. The annotation lives on entry_hypothesis, where the caller
     * knows what it asked for.
     */
    const a = src('src/core/assessment.js');
    assert.match(a, /export function assess\(bars, spy\)/,
      'if assess() ever takes a tier or a clock, revisit trade_plans');
    assert.ok(!/executionWindowStatus/.test(a), 'assess() must not acquire a window verdict it cannot ground');
  });
});
