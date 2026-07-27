/**
 * Multi-timeframe analysis.
 *
 * Every other tool here reads ONE timeframe. That is half an analysis: a daily
 * chart that says "range" inside a weekly uptrend is a pullback, and the same
 * daily chart inside a weekly downtrend is a bounce to sell. The daily cannot
 * tell you which.
 *
 * ── The convention ──
 *
 * Timeframes are stepped by a factor of 4-6 — Elder's "factor of five". Three
 * screens, each answering a different question:
 *
 *   CONTEXT  (highest)      which way am I allowed to trade?
 *   STRUCTURE (trading)     where is the setup?
 *   TRIGGER  (lowest)       when exactly do I get in?
 *
 * Elder's rule, and the reason the order matters: the context timeframe grants
 * PERMISSION and the trading timeframe finds the setup against it. A signal on
 * the trading timeframe pointing against the context timeframe is not a signal,
 * it is a countertrend trade being described as one.
 *
 * ── Why resampling rather than switching the chart ──
 *
 * Higher timeframes are built by aggregating the bars already loaded. That
 * touches nothing, is deterministic, and cannot leave the user's chart on the
 * wrong symbol if something throws halfway through. It only works UPWARD —
 * going lower needs the chart, and the caller has to ask for that explicitly.
 *
 * The cost is stated rather than hidden: the newest higher-timeframe bar is
 * usually PARTIAL (a week that has not finished), and a partial bar can look
 * like a reversal that has not happened.
 *
 * All pure.
 */
const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Timeframe plans by trading style.
 *
 * `hold` is what the style actually implies about holding period, which is the
 * thing that should drive the choice — not preference. Someone holding for
 * weeks who executes off a 5-minute chart has picked the wrong trigger.
 */
export const TIMEFRAME_PLANS = {
  position: {
    context: '1M', structure: '1W', trigger: '1D',
    hold: 'months to years',
    note: 'Monthly context, weekly structure, daily trigger.',
  },
  swing: {
    context: '1W', structure: '1D', trigger: '1H',
    hold: 'days to weeks',
    note: 'Weekly context, daily structure, hourly trigger. For US equities the trigger is 1H, not 4H — a 6.5-hour session makes a 4H bar only ~1.6x a daily, which is too close to be a separate screen.',
  },
  swing_24h: {
    context: '1W', structure: '1D', trigger: '4H',
    hold: 'days to weeks',
    note: 'The same plan for instruments that trade around the clock — crypto and FX — where a 4H bar is a genuine 6x step down from daily.',
    session_hours: 24,
  },
  short_swing: {
    context: '1D', structure: '4H', trigger: '1H',
    hold: 'one to several days',
    note: 'For 24-hour instruments. On a 6.5-hour equity session the 1D-to-4H step is too small.',
    session_hours: 24,
  },
  day: {
    context: '1D', structure: '1H', trigger: '15m',
    hold: 'intraday, flat overnight',
    note: 'Daily bias, hourly structure, 15-minute trigger.',
  },
  scalp: {
    context: '1H', structure: '15m', trigger: '5m',
    hold: 'minutes',
    note: 'Costs dominate at this speed — run trade_cost before believing any edge here.',
  },
};

/**
 * Step between adjacent timeframes, in TRADING minutes rather than clock
 * minutes.
 *
 * This matters and getting it wrong makes a standard plan look broken. A US
 * equity session is 6.5 hours, so a daily bar covers 390 trading minutes, not
 * 1440. Using clock minutes rates the ordinary daily/hourly step at 24x —
 * apparently far outside the 4-6x convention — when in session terms it is 6.5x
 * and entirely conventional.
 */
const INTRADAY_MINUTES = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1H': 60, '2H': 120, '4H': 240,
};

/** Trading minutes per bar, given how long a session actually is. */
function tfMinutes(tf, sessionHours) {
  if (INTRADAY_MINUTES[tf]) return INTRADAY_MINUTES[tf];
  const day = sessionHours * 60;
  if (tf === '1D') return day;
  if (tf === '1W') return day * 5;
  if (tf === '1M') return day * 21;
  return null;
}

/**
 * Is a set of timeframes sensibly spaced?
 *
 * Too close and the two charts say the same thing twice; too far apart and the
 * middle of the move is invisible. 4-6x is the convention, and anything outside
 * 3-10x is reported rather than silently accepted.
 */
export function checkSpacing(timeframes, { session_hours = 6.5 } = {}) {
  const mins = timeframes.map((t) => tfMinutes(t, session_hours));
  if (mins.some((m) => m == null)) {
    return { ok: false, note: `Unrecognised timeframe in ${timeframes.join(', ')}. Known: ${[...Object.keys(INTRADAY_MINUTES), '1D', '1W', '1M'].join(', ')}` };
  }
  const steps = [];
  for (let i = 1; i < mins.length; i++) steps.push(round(mins[i - 1] / mins[i], 2));
  const bad = steps.filter((s) => s < 3 || s > 10);
  return {
    ok: bad.length === 0,
    ratios: steps,
    session_hours,
    ...(bad.length
      ? { note: `Step(s) of ${bad.join(', ')}x sit outside the usual 4-6x, measured against a ${session_hours}-hour session. Too close and both charts say the same thing; too far and the middle of the move is invisible. If this is a 24-hour instrument, pass session_hours: 24 — the same timeframes space very differently.` }
      : { note: `Spacing is within the usual 4-6x convention for a ${session_hours}-hour session.` }),
  };
}

/* ------------------------------ resampling ----------------------------- */

const isoWeekKey = (d) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t - start) / 86400000 + 1) / 7)}`;
};

/**
 * Aggregate bars into a higher timeframe.
 *
 * `by` is 'week', 'month', or a positive integer meaning "every N bars".
 * Calendar grouping for daily-and-above; fixed bar counts for intraday, where
 * session lengths differ and a calendar rule would produce uneven bars.
 *
 * The last group is flagged `partial` when it is still forming. That flag is
 * the point — a half-finished weekly bar can show a reversal that has not
 * happened, and it is the commonest way multi-timeframe analysis misleads.
 */
export function resampleBars(bars, by) {
  if (!Array.isArray(bars) || bars.length === 0) return { bars: [], note: 'No bars to resample.' };

  const groups = new Map();
  const order = [];
  const keyOf = (b, i) => {
    if (by === 'week') return isoWeekKey(new Date(b.time * 1000));
    if (by === 'month') return new Date(b.time * 1000).toISOString().slice(0, 7);
    const n = Math.max(2, Math.floor(Number(by)));
    // Count back from the END so the NEWEST groups are complete and any
    // remainder lands at the oldest edge, where a short group is merely the
    // start of the history rather than a bar still forming.
    return Math.floor((bars.length - 1 - i) / n);
  };

  for (let i = 0; i < bars.length; i++) {
    const k = keyOf(bars[i], i);
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(bars[i]);
  }

  const out = order.map((k) => {
    const g = groups.get(k);
    return {
      time: g[0].time,
      open: g[0].open,
      high: Math.max(...g.map((b) => b.high)),
      low: Math.min(...g.map((b) => b.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((s, b) => s + (Number.isFinite(b.volume) ? b.volume : 0), 0),
      source_bars: g.length,
    };
  });

  out.sort((a, b) => a.time - b.time);

  // Partiality is only knowable for CALENDAR grouping, where the period has a
  // defined end and the current week or month plainly has not reached it. With
  // fixed-bar-count grouping the newest group is complete by construction —
  // claiming to detect a partial bar there would be inventing information.
  const last = out[out.length - 1];
  const calendar = by === 'week' || by === 'month';
  const typical = out.length > 2
    ? Math.max(...out.slice(0, -1).map((b) => b.source_bars))
    : last?.source_bars ?? 0;
  const partial = calendar && !!last && last.source_bars < typical;

  return {
    bars: out,
    grouped_by: typeof by === 'number' ? `${by} bars` : by,
    partial_last_bar: partial,
    ...(partial
      ? { partial_warning: `The newest ${by} bar covers only ${last.source_bars} of ~${typical} source bars — it is still forming. A partial higher-timeframe bar can show a reversal that has not happened yet. Do not read it as confirmed.` }
      : {}),
    ...(!calendar
      ? { partial_note: 'Grouped by bar count anchored at the newest bar, so every group is full by construction. Whether the newest group is a finished period cannot be determined from bars alone — that is why calendar grouping is preferred where it applies.' }
      : {}),
  };
}

/* ---------------------------- alignment -------------------------------- */

const DIR = { uptrend: 1, downtrend: -1, up: 1, down: -1, range: 0, undetermined: 0, null: 0 };
const dirOf = (t) => DIR[t] ?? 0;

/**
 * Do the timeframes agree, and what does that permit?
 *
 * `screens` is [{ label, trend, regime, ... }] ordered HIGHEST first.
 *
 * The verdict follows Elder: the context timeframe grants permission, the
 * trading timeframe finds the setup. Agreement is the strongest state; a
 * trading timeframe opposing its context is explicitly named a countertrend
 * trade rather than allowed to read as a signal.
 */
export function alignment(screens) {
  if (!Array.isArray(screens) || screens.length < 2) {
    return { available: false, note: 'Need at least two timeframes to judge alignment.' };
  }
  const [context, structure, trigger] = screens;
  const c = dirOf(context.trend), s = dirOf(structure.trend);

  let state, verdict;
  if (c === 0) {
    state = 'context_unclear';
    verdict = `${context.label} is a range, so it grants no directional permission. A setup on ${structure.label} is a range trade, not a trend trade — size and target it accordingly.`;
  } else if (s === 0) {
    state = 'structure_consolidating';
    verdict = `${context.label} is ${context.trend} and ${structure.label} is consolidating inside it. That is the normal shape of a pullback — it is where continuation setups form, and it is also what a top looks like before it becomes one.`;
  } else if (c === s) {
    state = 'aligned';
    verdict = `${context.label} and ${structure.label} both ${context.trend}. This is the strongest state multi-timeframe analysis offers: the context permits the direction the setup is pointing.`;
  } else if (dirOf(structure.trend) === 0) {
    state = 'structure_consolidating';
  } else {
    state = 'opposed';
    verdict = `${context.label} is ${context.trend} but ${structure.label} is ${structure.trend}. A setup here is COUNTERTREND to its own context. Elder's rule is to take signals only in the direction of the higher timeframe — if you take this, say out loud that it is countertrend and that the higher timeframe is against it.`;
  }

  const choppy = screens.filter((x) => x.regime === 'choppy').map((x) => x.label);

  return {
    available: true,
    state,
    verdict,
    context: { timeframe: context.label, trend: context.trend, regime: context.regime },
    structure: { timeframe: structure.label, trend: structure.trend, regime: structure.regime },
    ...(trigger ? { trigger: { timeframe: trigger.label, trend: trigger.trend, regime: trigger.regime } } : {}),
    permitted_direction: c > 0 ? 'long' : c < 0 ? 'short' : 'neither — context is a range',
    // Timeframes are a FILTER, not a scoring system. Failing a screen is not a
    // weaker trade, it is not a trade yet.
    action: state === 'aligned' ? 'look for a setup on the trigger timeframe'
      : state === 'structure_consolidating' ? 'wait for the structure timeframe to resolve, then look for continuation in the context direction'
      : 'no trade yet — watchlist it until the screens agree',
    ...(choppy.length ? { choppy_timeframes: choppy, choppy_note: `${choppy.join(' and ')} ${choppy.length > 1 ? 'are' : 'is'} choppy by efficiency ratio. Structure breaks there are mostly noise.` } : {}),
    method: 'Elder\'s triple screen: the context timeframe grants permission, the trading timeframe finds the setup, the trigger times it. Trends read from confirmed swings, so each timeframe lags by its own swing lookback.',
  };
}
