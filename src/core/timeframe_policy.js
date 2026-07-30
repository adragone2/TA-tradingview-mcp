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
 * Pure.
 */

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
