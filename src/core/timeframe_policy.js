/**
 * WHICH TIMEFRAME EACH EXECUTION TIER IS ANALYSED ON.
 *
 * The morning routine analysed every candidate on the DAILY chart, including the
 * intraday ones. The owner's objection: *"You are analyzing everything on the day
 * timeframe chart. That doesn't work for intraday."*
 *
 * It does not, and not merely as a matter of taste. An intraday setup is a shape in
 * a session — an opening range, a VWAP reclaim, a fade off the 9 EMA. On a daily
 * chart the whole session is ONE BAR, so the setup is not merely hard to see, it is
 * not representable. Every level, swing and pattern the analysis drew for an
 * INTRADAY name described a horizon that name would never be held for.
 *
 * ── The owner's own configuration ──
 *
 *   INTRADAY  5-minute to identify setups, 15-minute to confirm the broader trend,
 *             traded in the 10:15–14:30 ET window.
 *   WEEKLY    Daily, supported by the Weekly for macro trend and the 4-Hour for
 *   MONTHLY   fine-tuning entries.
 *
 * ── The constraint that decides `bars` ──
 *
 * A session is **390 minutes**, so 5-minute gives 78 bars a session. TradingView
 * loads only a viewport's worth up front — measured on AAPL, a fresh 5-minute chart
 * holds **300 bars, two sessions** — and `data.getOhlcv` caps a read at 500 for
 * context reasons, which is three. Neither number is enough for a level to mean
 * anything, and on daily bars the problem is invisible because 300 daily bars is
 * fifteen months. `chart.loadHistory` extends the chart and `getOhlcv({max})` reads
 * past the cap; the pair is why `bars` below can be 800.
 *
 * ── The trap this file also has to carry ──
 *
 * `assess()` is calibrated in BAR COUNTS — its momentum windows are 252/126/63/21
 * bars, labelled 12m/6m/3m/1m, and `horizon_prior` is a statement about ~21 TRADING
 * DAYS. On 5-minute bars 252 bars is 3.2 sessions. The numbers stay arithmetically
 * correct and every LABEL on them becomes false, which is precisely the failure this
 * repo already records as "pin the timeframe, or the measurement is of something
 * else". `barWindowNote` states what the windows actually span, and
 * `horizonApplies` says when the reversal/continuation prior may be quoted at all.
 *
 * ── The window the tier already carried, and nothing read ──
 *
 * `execution_window` has been data here since the tier policy was written, and no
 * caller looked at it. So an INTRADAY entry plan produced at 06:55 ET — before the
 * bell, when there is no VWAP, no opening range and no session volume — read
 * exactly like one produced at 11:00, and an intraday plan formed at 15:50 read the
 * same again. `executionWindowStatus` says which. It ANNOTATES and never gates:
 * three market-alignment gates have been forward-tested in this repo and all three
 * failed, so nothing here suppresses a plan for being early or late.
 *
 * Pure — every clock reading is passed in, never taken.
 */
import { sessionState, US_EQUITY_SESSION } from './session.js';

/** A regular US session, in minutes. NOT 1440 — that error is 3.7x. */
export const SESSION_MINUTES = 390;

export const TIER_TIMEFRAMES = Object.freeze({
  intraday: Object.freeze({
    analysis: '5',
    analysis_label: '5-minute',
    context: '15',
    macro: '1D',
    bars: 800,
    why: 'The 5-minute is where an intraday setup is identified; the 15-minute confirms the broader '
      + 'trend. 800 five-minute bars is ~10 sessions, against the 300 (two sessions) a fresh chart '
      + 'holds and the 500 (three) a default read returns.',
    /**
     * The owner's trading window. Not an analysis filter — the bars outside it are
     * still structure — but the hours an intraday plan should be executed in.
     *
     * It also happens to avoid both LULD widenings: bands DOUBLE 09:30–09:45 and
     * 15:35–16:00 ET, and 10:15–14:30 sits clear of both. That is corroboration
     * from a measured rule, not the reason for the window.
     */
    execution_window: Object.freeze({ start: '10:15', end: '14:30', tz: 'America/New_York' }),
  }),
  weekly: Object.freeze({
    analysis: '1D',
    analysis_label: 'daily',
    context: '1W',
    trigger: '240',
    bars: 400,
    why: 'The screens, the strategy criteria and the setups themselves are daily. The weekly carries '
      + 'the macro trend; the 4-hour fine-tunes the entry.',
  }),
  monthly: Object.freeze({
    analysis: '1D',
    analysis_label: 'daily',
    context: '1W',
    trigger: '240',
    bars: 400,
    why: 'Every Tier A result in this repo was measured on daily bars. The weekly carries the macro '
      + 'trend; the 4-hour fine-tunes the entry.',
  }),
});

/** The policy for a tier, or the weekly default for anything unrecognised. */
export function timeframeFor(tier) {
  return TIER_TIMEFRAMES[String(tier || '').toLowerCase()] || TIER_TIMEFRAMES.weekly;
}

/** Minutes per bar for a TradingView resolution string. Null for non-time bars. */
export function barMinutes(resolution) {
  const r = String(resolution ?? '').trim().toUpperCase();
  if (!r) return null;
  if (/^\d+$/.test(r)) return Number(r);                    // bare minutes: "5", "240"
  const m = r.match(/^(\d*)([SDWM])$/);
  if (!m) return null;
  const n = m[1] === '' ? 1 : Number(m[1]);
  switch (m[2]) {
    case 'S': return n / 60;
    case 'D': return n * SESSION_MINUTES;
    case 'W': return n * SESSION_MINUTES * 5;
    case 'M': return n * SESSION_MINUTES * 21;
    default: return null;
  }
}

/** Is this resolution a daily bar or longer? */
export const isDailyOrHigher = (resolution) => (barMinutes(resolution) ?? 0) >= SESSION_MINUTES;

/**
 * What `assess()`'s fixed bar windows actually SPAN at this resolution.
 *
 * On daily bars 252/126/63/21 are 12m/6m/3m/1m and the labels are true. On
 * 5-minute bars they are 3.2/1.6/0.8/0.3 SESSIONS, and a block still captioned
 * "12-month momentum" is describing three days.
 */
export function barWindowNote(resolution, windows = [252, 126, 63, 21]) {
  const mins = barMinutes(resolution);
  if (!mins) return null;
  const spans = windows.map((w) => {
    const sessions = (w * mins) / SESSION_MINUTES;
    return {
      bars: w,
      sessions: Math.round(sessions * 10) / 10,
      label: sessions >= 21 ? `${Math.round(sessions / 21)}m` : `${Math.round(sessions * 10) / 10} sessions`,
    };
  });
  return {
    resolution,
    bar_minutes: mins,
    windows: spans,
    labels_are_calendar_accurate: isDailyOrHigher(resolution),
    note: isDailyOrHigher(resolution)
      ? 'Daily bars or longer: the 12m/6m/3m/1m labels on the momentum windows are accurate.'
      : `NOT daily bars. assess() measures fixed BAR COUNTS, so its "12m/6m/3m/1m" windows here span `
        + `${spans.map((s) => `${s.bars} bars = ${s.sessions} sessions`).join(', ')}. The numbers are `
        + 'correct; the calendar labels on them are not. Quote the bar counts.',
  };
}

/**
 * May the horizon prior be quoted at this resolution?
 *
 * The reversal-below-~21-days / continuation-above-~63-days boundary is measured in
 * TRADING DAYS. It says nothing about where a 5-minute swing sits, and reporting it
 * beside an intraday setup would attach daily-horizon evidence to a position closed
 * before the session ends.
 */
export function horizonApplies(resolution) {
  return isDailyOrHigher(resolution)
    ? { applies: true }
    : {
      applies: false,
      why: 'The horizon prior is measured in TRADING DAYS (reversal below ~21, continuation above '
        + `~63). At ${resolution}-minute bars a position is closed inside one session, so the `
        + 'boundary does not describe it either way. NOT APPLICABLE is the honest reading, not a '
        + 'neutral one.',
    };
}

/* ------------------------- the intraday execution window ------------------------- */

/**
 * Said on every annotation, because it is the thing most likely to be forgotten.
 *
 * `level_pressure` collapsed out of sample, `stage_plan`'s Stage 2 gate made forward
 * outcomes WORSE, and Livermore's two-leader confirmation cost 9.3 points of win
 * rate. Three market-alignment gates measured here, three failures. This is the
 * fourth thing that LOOKS like a gate, so it says in its own output that it is not
 * one.
 */
export const WINDOW_NOT_A_GATE = 'An ANNOTATION, never a filter. Nothing here suppresses, downgrades or '
  + 're-ranks a plan for being early or late — three market-alignment gates have been forward-tested in '
  + 'this repo and all three failed. It reports WHEN the plan was formed and leaves the decision where it was.';

/** "10:15" -> 615. Minutes from local midnight at the exchange. */
const clockMinutes = (hhmm) => {
  const m = String(hhmm ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 615 -> "10:15". */
const clockLabel = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * Was this plan formed inside the hours its tier is meant to be traded in?
 *
 * @param {string|null} tier      'intraday' | 'weekly' | 'monthly'
 * @param {number|null} at_ms     Epoch milliseconds. REQUIRED, and deliberately not
 *                                defaulted to `Date.now()`: a default would make the
 *                                one-argument call read the clock, and this function
 *                                is used inside `entryHypothesis`, which is pure. A
 *                                caller with no timestamp is in the unknown case,
 *                                which must not be dressed up as a measurement of
 *                                now. The tool layer passes `Date.now()`.
 *
 * Three answers, and they are deliberately different things:
 *
 *   in_window / out_of_window   the tier HAS a window and we know which side of it
 *                               this timestamp sits on.
 *   not_applicable              the tier has no window. Weekly and monthly plans are
 *                               formed on daily bars and held for days; any hour is
 *                               as good as any other.
 *   unknown                     no tier, an unrecognised tier, or no usable
 *                               timestamp. NOT the same as "fine" — the same
 *                               distinction the liquidity constraint makes when it
 *                               reports NOT CHECKED rather than satisfied.
 *
 * `timeframeFor` defaults an unrecognised tier to weekly, which is right for picking
 * a chart resolution and wrong here: it would turn "nobody said what this is" into
 * the positive claim "no window applies".
 *
 * DST is handled by `exchangeParts` (via `sessionState`), which formats through Intl
 * in `America/New_York`. A hardcoded UTC-5 would read 10:20 EDT as 09:20 and report
 * a mid-morning plan as pre-window for two-thirds of the year.
 */
export function executionWindowStatus(tier, at_ms = null) {
  const key = String(tier ?? '').trim().toLowerCase();
  const policy = TIER_TIMEFRAMES[key];

  if (!policy) {
    return {
      status: 'unknown',
      in_window: null,
      tier: tier ?? null,
      note: `No execution tier was supplied${tier ? ` ("${tier}" is not one of `
        + `${Object.keys(TIER_TIMEFRAMES).join(', ')})` : ''}, so whether this plan was formed inside its `
        + 'trading window is UNKNOWN — which is not the same as fine. Pass the tier the name was '
        + 'classified into.',
      not_a_gate: WINDOW_NOT_A_GATE,
    };
  }

  const w = policy.execution_window;
  if (!w) {
    return {
      status: 'not_applicable',
      in_window: null,
      tier: key,
      note: `The ${key} tier is analysed on ${policy.analysis_label} bars and held for days or longer, so no `
        + 'intraday execution window applies. The hour a swing plan is written at carries no information '
        + 'about the trade.',
      not_a_gate: WINDOW_NOT_A_GATE,
    };
  }

  const start = clockMinutes(w.start);
  const end = clockMinutes(w.end);
  const label = `${w.start}-${w.end} ${w.tz === 'America/New_York' ? 'ET' : w.tz}`;

  /**
   * `Number(null)` is 0 — a valid finite epoch (1970) that would be reported as a
   * Thursday out of window. That exact coercion has already conjured a finding from
   * missing data here once, in the equal-weight breadth spread. Reject the absent
   * timestamp explicitly rather than letting it become a number.
   */
  const ms = at_ms == null ? NaN : Number(at_ms);
  if (!Number.isFinite(ms) || ms <= 0 || start == null || end == null) {
    return {
      status: 'unknown',
      in_window: null,
      tier: key,
      window: label,
      note: `The ${key} tier is traded ${label}, but no usable timestamp was given (${JSON.stringify(at_ms ?? null)}), `
        + 'so which side of the window this plan was formed on is UNKNOWN. Not assumed to be inside it.',
      not_a_gate: WINDOW_NOT_A_GATE,
    };
  }

  // ONE clock reading, in the window's own zone, giving both the wall clock and
  // where the session is. Two readings could straddle a minute boundary.
  const at = sessionState(ms, { ...US_EQUITY_SESSION, tz: w.tz });
  const now = clockLabel(at.minutes);
  // Spread in the MIDDLE of each return, so the answer — status, in_window — leads
  // and the context follows it. A verdict buried under six context fields gets read
  // as context.
  const base = {
    tier: key, window: label, at: `${now} ET`, at_date: at.date, weekday: at.weekday,
    session_state: at.state,
  };

  if (at.is_weekend) {
    return {
      status: 'out_of_window',
      in_window: false,
      ...base,
      opens_in_minutes: null,
      closed_since_minutes: null,
      note: `Generated ${at.weekday} ${now} ET — the market is shut. The ${label} window does not open again `
        + 'until the next trading session, and how many minutes away that is is NOT stated here because '
        + 'market holidays are enumerated nowhere in this repo. An intraday plan formed at the weekend '
        + 'describes a session that has not happened.',
      not_a_gate: WINDOW_NOT_A_GATE,
    };
  }

  /**
   * BOTH ends inclusive. The tier states its window as "10:15-14:30", and a
   * timestamp stamped 14:30 is inside a range written that way. Note this differs
   * from `sessionState`, where 16:00 is already `closed` — a session END is a moment,
   * a trading window is a stated range.
   */
  if (at.minutes >= start && at.minutes <= end) {
    return {
      status: 'in_window',
      in_window: true,
      ...base,
      closes_in_minutes: end - at.minutes,
      note: `Generated ${now} ET, inside the ${label} execution window — ${end - at.minutes} minute(s) of it left.`,
      not_a_gate: WINDOW_NOT_A_GATE,
    };
  }

  if (at.minutes < start) {
    const mins = start - at.minutes;
    return {
      status: 'out_of_window',
      in_window: false,
      ...base,
      opens_in_minutes: mins,
      note: `Generated ${now} ET — the ${label} window opens at ${w.start} ET, in ${mins} minutes. `
        + (at.state === 'premarket'
          ? 'A pre-open intraday plan describes conditions that do not exist yet: there is no VWAP, no '
            + 'opening range and no session volume for the setup to be measured against, and today\'s daily '
            + 'bar holds a fraction of its eventual volume.'
          : 'The session is open but this tier\'s window is not — the opening range is still forming and '
            + 'LULD bands stay doubled until 09:45 ET.'),
      not_a_gate: WINDOW_NOT_A_GATE,
    };
  }

  const mins = at.minutes - end;
  return {
    status: 'out_of_window',
    in_window: false,
    ...base,
    closed_since_minutes: mins,
    note: `Generated ${now} ET — the ${label} window closed at ${w.end} ET, ${mins} minutes ago. `
      + (at.state === 'open'
        ? 'Acting on it now means entering into the close, where stop-driven exits cluster and LULD bands '
          + 'double again from 15:35 ET.'
        : 'The session is over. By the time the window next opens these levels are a session old, and an '
          + 'intraday setup does not survive a gap.'),
    not_a_gate: WINDOW_NOT_A_GATE,
  };
}

/**
 * The execution tier a chart RESOLUTION implies — and only when it implies one.
 *
 * Deliberately narrow. It returns `intraday` for the two resolutions the intraday
 * policy itself prescribes (its `analysis` and `context`), and null for everything
 * else — including daily, where weekly and monthly are indistinguishable, and
 * including 60-minute, which a swing trader may perfectly well be using to fine-tune
 * an entry. A tier is an EXECUTION decision that comes from the strategy; this only
 * recognises the case where the resolution could not mean anything else, so that the
 * annotation is reachable without a caller having to remember to pass a tier.
 */
export function tierForResolution(resolution) {
  const r = String(resolution ?? '').trim().toUpperCase();
  if (!r) return null;
  const intra = TIER_TIMEFRAMES.intraday;
  return (r === intra.analysis || r === intra.context) ? 'intraday' : null;
}
