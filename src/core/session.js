/**
 * Session clock, and the partial-bar guard.
 *
 * The bug this exists for: a daily bar for TODAY exists long before the day is
 * over. Extended-hours trade accumulates into it from 04:00 ET, so at 05:30 PT
 * — when the morning screen runs — every symbol already has a "daily" bar with
 * perhaps 15% of its eventual volume. Measured on SPY: 6.7M against a ~45M
 * typical day. Every detector downstream read that as a finished day.
 *
 * What a partial bar corrupts is NOT uniform, and the distinction matters
 * because it decides what can still be used:
 *
 *   close   — a real, live quote. Fine as a price.
 *   open    — real. The session did open there.
 *   high    — the extremes SO FAR. Understates the day's range.
 *   low     — same.
 *   volume  — a fraction of the day. The worst of them, and the one that feeds
 *             `relative_volume_10d_calc`, which the high-volume premium factor
 *             ranks on. Pre-open that factor is ranking noise.
 *
 * So `corrupts` is returned alongside the verdict rather than leaving callers
 * to assume the whole bar is either good or garbage.
 */

/** US equities regular session, in exchange-local time. */
export const US_EQUITY_SESSION = Object.freeze({
  tz: 'America/New_York',
  open_minutes: 9 * 60 + 30,   // 09:30 ET
  close_minutes: 16 * 60,      // 16:00 ET
  label: 'US equities regular session 09:30-16:00 ET',
});

/**
 * Early closes (13:00 ET, the day after Thanksgiving and similar) are NOT
 * modelled. On those days this calls the bar partial until 16:00 when it was
 * actually finished at 13:00. That is the safe direction of the error: it
 * discards a complete bar rather than admitting an incomplete one.
 */
export const KNOWN_LIMITATIONS = Object.freeze([
  'early-close days treated as full sessions (conservative — drops a good bar, never admits a bad one)',
  'market holidays are not enumerated; a holiday simply has no bar dated today, which the date test handles',
  'weekly and monthly completeness is not modelled — a bar whose period contains today is called partial',
]);

/* ------------------------------ exchange clock ------------------------------ */

/**
 * Wall-clock fields at the exchange, from an epoch. Uses Intl rather than any
 * TZ environment variable — on Windows the shell ignores TZ and reports UTC,
 * which is how a schedule once landed 8 hours from where it was meant to.
 */
export function exchangeParts(ms, tz = US_EQUITY_SESSION.tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  // Some ICU builds render midnight as "24" under hour12:false.
  const hour = Number(p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + Number(p.minute),
    weekday: p.weekday,
    is_weekend: p.weekday === 'Sat' || p.weekday === 'Sun',
  };
}

/** Where we are in the trading day, at the exchange. */
export function sessionState(now = Date.now(), session = US_EQUITY_SESSION) {
  const at = exchangeParts(now, session.tz);
  if (at.is_weekend) return { state: 'weekend', ...at };
  if (at.minutes < session.open_minutes) return { state: 'premarket', ...at };
  if (at.minutes < session.close_minutes) return { state: 'open', ...at };
  return { state: 'closed', ...at };
}

/* ----------------------------- resolution parsing ---------------------------- */

/** Seconds per bar, or null for daily and above (which are session-based). */
export function resolutionSeconds(resolution) {
  const r = String(resolution ?? '').trim().toUpperCase();
  if (r === '') return null;
  if (/^\d+$/.test(r)) return Number(r) * 60;          // bare number = minutes
  const m = r.match(/^(\d*)\s*([SDWM])$/);
  if (!m) return null;
  const n = m[1] === '' ? 1 : Number(m[1]);
  if (m[2] === 'S') return n;
  return null;                                          // D / W / M are session-based
}

export function isIntraday(resolution) {
  return resolutionSeconds(resolution) !== null;
}

/** 'D' | 'W' | 'M' for session-based resolutions, else null. */
export function periodUnit(resolution) {
  const r = String(resolution ?? '').trim().toUpperCase();
  const m = r.match(/^\d*\s*([DWM])$/);
  return m ? m[1] : null;
}

/* ------------------------------ the guard itself ----------------------------- */

/** TradingView hands out seconds; anything past this magnitude is milliseconds. */
function toMs(time) {
  const n = Number(time);
  if (!Number.isFinite(n)) return NaN;
  return n > 1e11 ? n : n * 1000;
}

const CORRUPTS_WHEN_PARTIAL = Object.freeze(['high', 'low', 'volume']);

/**
 * Is the last bar of `bars` still forming?
 *
 * Intraday: the bar is done once its own duration has elapsed from its open.
 * Daily:    the bar is done once the session that produced it has closed. A bar
 *           dated before today is finished by definition, which is also what
 *           makes weekends and holidays fall out for free — on those days the
 *           newest bar is simply not dated today.
 */
export function lastBarState(bars, { resolution = '1D', now = Date.now(), session = US_EQUITY_SESSION } = {}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { complete: null, reason: 'no bars', corrupts: [], bar_time: null };
  }
  const last = bars[bars.length - 1];
  const startMs = toMs(last.time);
  if (!Number.isFinite(startMs)) {
    return { complete: null, reason: 'last bar has no usable timestamp', corrupts: [], bar_time: last.time ?? null };
  }

  const secs = resolutionSeconds(resolution);
  if (secs !== null) {
    const endsMs = startMs + secs * 1000;
    const complete = now >= endsMs;
    return {
      complete,
      reason: complete
        ? `intraday bar closed ${Math.round((now - endsMs) / 1000)}s ago`
        : `intraday bar still forming, ${Math.round((endsMs - now) / 1000)}s to go`,
      corrupts: complete ? [] : CORRUPTS_WHEN_PARTIAL.slice(),
      bar_time: last.time,
      resolution_seconds: secs,
    };
  }

  const unit = periodUnit(resolution);
  const barAt = exchangeParts(startMs, session.tz);
  const nowAt = sessionState(now, session);

  if (unit === 'W' || unit === 'M') {
    // Not modelled. Only claim completeness when the bar is plainly historic.
    const stale = barAt.date < nowAt.date;
    return {
      complete: stale ? null : false,
      reason: stale
        ? `${unit} bar completeness is not modelled; bar predates today so it is treated as usable`
        : `${unit} bar covers a period containing today — treated as partial`,
      corrupts: stale ? [] : CORRUPTS_WHEN_PARTIAL.slice(),
      bar_time: last.time,
      not_modelled: true,
    };
  }

  // Daily.
  if (barAt.date < nowAt.date) {
    return { complete: true, reason: `bar dated ${barAt.date}, today is ${nowAt.date}`, corrupts: [], bar_time: last.time };
  }
  if (nowAt.state === 'closed') {
    return { complete: true, reason: `session closed at the exchange (${nowAt.date})`, corrupts: [], bar_time: last.time };
  }
  return {
    complete: false,
    reason: `bar is dated today (${barAt.date}) and the session is ${nowAt.state} at the exchange`,
    corrupts: CORRUPTS_WHEN_PARTIAL.slice(),
    bar_time: last.time,
    session_state: nowAt.state,
  };
}

/**
 * Bars with the still-forming one removed.
 *
 * Returns the partial bar rather than discarding it silently, so a caller that
 * legitimately wants the live price (a quote, a stop check) can still reach it
 * while everything range- or volume-based reads only finished bars.
 */
export function completeBars(bars, opts = {}) {
  const state = lastBarState(bars, opts);
  if (state.complete === false) {
    return {
      bars: bars.slice(0, -1),
      dropped: bars[bars.length - 1],
      dropped_count: 1,
      state,
      note: `Dropped the forming bar — ${state.reason}. Its ${state.corrupts.join(', ')} are incomplete.`,
    };
  }
  return { bars, dropped: null, dropped_count: 0, state, note: null };
}

/**
 * Scanner fields carry the same defect and CANNOT be repaired from here.
 *
 * TradingView computes SMA20, relative_volume_10d_calc and the rest server-side
 * with today's partial bar folded in. There is no bar array to trim. The only
 * honest response is to say which fields are unsafe and how badly, so a caller
 * can decline to rank on them.
 */
export const SCANNER_FIELD_RISK = Object.freeze({
  safe: ['close', 'open', 'market_cap_basic', 'earnings_release_next_date'],
  degraded: ['SMA10', 'SMA20', 'SMA50', 'SMA100', 'SMA200', 'EMA20'],
  unsafe: ['volume', 'relative_volume_10d_calc', 'average_volume_10d_calc', 'change', 'Perf.W'],
  note:
    'Pre-open and intraday, TradingView folds the forming day into every computed field. '
    + 'A moving average is DEGRADED but usable — its newest input is a real quote, diluted 1/N. '
    + 'Volume fields are UNSAFE: a partial day carries a fraction of its eventual volume '
    + '(SPY measured 6.7M against ~45M), so relative-volume rankings invert. '
    + 'The high-volume premium factor ranks on exactly that field and must not run pre-open.',
});

/**
 * Whether scanner-derived factors can be trusted right now.
 * Returns the verdict plus the reason, for printing beside any ranking.
 */
export function scannerTrust(now = Date.now(), session = US_EQUITY_SESSION) {
  const at = sessionState(now, session);
  const settled = at.state === 'closed' || at.state === 'weekend';
  return {
    session_state: at.state,
    exchange_date: at.date,
    volume_fields_usable: settled,
    reason: settled
      ? 'session is over at the exchange; computed fields reflect a finished day'
      : `session is ${at.state}; volume-derived fields reflect a partial day and must not be ranked on`,
    ...SCANNER_FIELD_RISK,
  };
}
