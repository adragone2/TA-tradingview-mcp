/**
 * Rebalance cadence, and the hysteresis that makes a slow bucket possible.
 *
 * ── The defect this fixes ──
 *
 * Moving Average Distance, the trend factor and the high-volume premium are all
 * MONTHLY cross-sectional sorts. That is not incidental to them; it is how they
 * were measured. MAD's ~9% survives institutional trading costs *at monthly
 * rebalance*. The morning screen runs every weekday.
 *
 * Reranking a monthly-horizon factor daily is not a faster version of the same
 * strategy. It is a different strategy with roughly 21x the turnover, and
 * `turnoverDrag` prices that: ~252 round trips a year at 20bps is over 50%
 * annually, against a ~9% gross effect. The edge is gone several times over
 * before the first trade is placed.
 *
 * So the two buckets rebalance on different clocks:
 *
 *   WEEKS   daily.   Short-term reversal decays in days; a stale list is a
 *                    wrong list. Turnover is the price of admission, which is
 *                    why the bucket's centre of gravity belongs at 10-21 days
 *                    rather than 2-5 (turnoverDrag: 5.0% vs 12.6% at 10bps).
 *
 *   MONTHS  monthly, on the first run of a new calendar month, with a
 *                    hysteresis band so a name is not ejected the moment it
 *                    slips one place past the entry cut.
 *
 * All pure. IO belongs to the caller.
 */
import { exchangeParts, US_EQUITY_SESSION } from './session.js';

/**
 * The two buckets, and the watchlist sections they own.
 *
 * `entry_rank_pct` / `exit_rank_pct` are the hysteresis band. Entering the top
 * 20% but only leaving below the top 50% means a name has to genuinely
 * deteriorate to be sold, not merely jitter around the boundary.
 */
export const BUCKETS = Object.freeze({
  WEEKS: Object.freeze({
    key: 'WEEKS',
    section: 'Weeks',
    keep_section: 'KEEP weeks',
    rebalance: 'daily',
    horizon_days: [10, 21],
    exit_multiple: 1,      // no band — the list is rebuilt from scratch each day
    why: 'Reversal-dominant zone. The signal decays in days, so a stale list is a wrong list.',
  }),
  MONTHS: Object.freeze({
    key: 'MONTHS',
    section: 'Months',
    keep_section: 'KEEP months',
    rebalance: 'monthly',
    horizon_days: [63, null],
    // Enter in the top `slots`; leave only past 2.5x that rank. A name has to
    // genuinely deteriorate to be sold, not slip one place.
    exit_multiple: 2.5,
    why: 'Continuation-dominant zone. The factors here were MEASURED at monthly rebalance; '
      + 'reranking daily multiplies turnover by ~21 and costs more than the effect is worth.',
  }),
});

/**
 * How a name LEAVES the Months bucket.
 *
 * Until now there was no exit rule at all — a name simply fell off when the
 * next scan reranked it, which was the cadence bug wearing a different hat.
 *
 * The rule is rank deterioration at the monthly rebalance, and that choice is
 * deliberate: the evidence behind MAD, the trend factor and the volume premium
 * is CROSS-SECTIONAL, so the thing that should end a holding is losing its
 * place in the cross-section — not a price event.
 *
 * A price-trail exit was the obvious alternative and was tested rather than
 * assumed. It failed.
 */
export const MONTHS_EXIT = Object.freeze({
  rule: 'rank deterioration at the monthly rebalance',
  detail: 'A held name leaves when it falls past exit_multiple x slots in the monthly cross-sectional '
    + 'ranking, or drops out of the liquid universe entirely.',
  why_not_a_price_stop:
    'A trailing exit is a bet on positive serial correlation — Kaminski & Lo show the stopping premium '
    + 'is ALWAYS negative under a random walk and rises only with persistence. Measured with '
    + 'stoppingPremium on the 12 names actually held on 2026-07-29 (daily bars, lags 1/5/10/21): '
    + '9 showed no measurable persistence, 1 was significantly mean-reverting, and only 2 were '
    + 'persistent — both at lag 10 alone. On 10 of 12 holdings an 8-EMA trail would have lowered '
    + 'expected return. It is rejected as an EDGE. It remains defensible as a solvency constraint, '
    + 'which is a different argument and should be made in those terms.',
  rejected_alternative: '8 EMA trailing exit (close below the 8 EMA), from practitioner sources',
  measured_on: '2026-07-29',
});

/** Which bucket a screen belongs to. Machine-readable, unlike the prose in `horizon_side`. */
export const SCREEN_BUCKET = Object.freeze({
  momentum_pullback: 'MONTHS',      // ranked on Perf.Y; the pullback is entry timing, not the bet
  near_52w_high: 'MONTHS',
  rs_leadership: 'MONTHS',
  volatility_contraction: 'WEEKS',  // a coil resolves in days; no horizon evidence of its own
  structural_reversal: 'WEEKS',
});

/**
 * Slot split across the two buckets.
 *
 * A CHOICE, not a finding. It leans to Months because that is where the
 * well-replicated material lives — docs/strategy-horizons.md rates the Weeks
 * evidence "thin, conditional, and expensive to trade".
 */
export const DEFAULT_BUCKET_SLOTS = Object.freeze({ MONTHS: 12, WEEKS: 8 });

/* -------------------------------- the clock -------------------------------- */

/** Calendar month at the exchange, as `YYYY-MM`. */
export function exchangeMonth(now = Date.now(), tz = US_EQUITY_SESSION.tz) {
  return exchangeParts(now, tz).date.slice(0, 7);
}

/**
 * Is this bucket due for a rebalance?
 *
 * Months turns on the calendar month CHANGING, not on a day count. That way a
 * missed run does not shift the schedule forward — the next run in the new
 * month picks it up, and two runs in the same month do not both rebalance.
 */
export function rebalanceDue(bucketKey, { now = Date.now(), last_run_iso = null, force = false } = {}) {
  const bucket = BUCKETS[bucketKey];
  if (!bucket) throw new Error(`unknown bucket "${bucketKey}" — expected WEEKS or MONTHS`);

  if (force) return { due: true, reason: 'forced', bucket: bucket.key };
  if (bucket.rebalance === 'daily') {
    return { due: true, reason: 'daily bucket — rebalances every run', bucket: bucket.key };
  }

  if (!last_run_iso) {
    return { due: true, reason: 'no prior rebalance recorded', bucket: bucket.key };
  }
  const lastMs = Date.parse(last_run_iso);
  if (!Number.isFinite(lastMs)) {
    return { due: true, reason: `unreadable last_run_iso "${last_run_iso}" — rebalancing rather than guessing`, bucket: bucket.key };
  }
  const lastMonth = exchangeMonth(lastMs);
  const thisMonth = exchangeMonth(now);
  return lastMonth === thisMonth
    ? { due: false, reason: `already rebalanced in ${thisMonth}`, bucket: bucket.key, last_month: lastMonth }
    : { due: true, reason: `calendar month advanced ${lastMonth} -> ${thisMonth}`, bucket: bucket.key };
}

/* ------------------------------- hysteresis -------------------------------- */

/**
 * Apply the entry/exit band to a ranked list, given what is already held.
 *
 * `ranked` is best-first. A held name survives while it stays inside
 * `exit_rank_pct`; a new name enters only inside the tighter `entry_rank_pct`.
 * The gap between the two is what stops a list churning on noise.
 *
 * Also returns what a naive rerank WOULD have done, because the whole point is
 * the turnover saved and an unmeasured saving is a claim rather than a result.
 */
export function applyHysteresis({
  ranked = [],
  held = [],
  slots = 12,
  exit_multiple = 2.5,
} = {}) {
  if (!(exit_multiple >= 1)) {
    throw new Error(`exit_multiple (${exit_multiple}) is below 1 — that ejects names faster than it admits `
      + 'them, which raises turnover instead of cutting it.');
  }
  const heldSet = new Set(held);

  /**
   * The band is measured in RANK POSITIONS, not percentiles of `ranked`.
   *
   * Percentiles were the first attempt and they broke on exactly the input
   * this gets: `ranked` is already a top-N selection, so a "top 20%" entry cut
   * applied to 5 survivors admits one name for twelve slots. A live run with
   * --top 6 filled 1 of 12. Positions are invariant to how long the incoming
   * list happens to be, which is the property needed here.
   */
  const entryCutoff = slots;
  const exitCutoff = Math.ceil(slots * exit_multiple);

  const survivors = [];
  const entrants = [];
  ranked.forEach((sym, i) => {
    if (heldSet.has(sym)) {
      if (i < exitCutoff) survivors.push(sym);
    } else if (i < entryCutoff) {
      entrants.push(sym);
    }
  });

  // Held names keep their place first — that IS the hysteresis. Then fill.
  const selected = [...survivors, ...entrants].slice(0, slots);
  const selectedSet = new Set(selected);

  const naive = ranked.slice(0, slots);
  const naiveSet = new Set(naive);
  const naiveTurnover = naive.filter((s) => !heldSet.has(s)).length
    + held.filter((s) => !naiveSet.has(s)).length;
  const actualTurnover = selected.filter((s) => !heldSet.has(s)).length
    + held.filter((s) => !selectedSet.has(s)).length;

  return {
    selected,
    added: selected.filter((s) => !heldSet.has(s)),
    dropped: held.filter((s) => !selectedSet.has(s)),
    survived: survivors.filter((s) => selectedSet.has(s)),
    // A held name that fell past the exit band, or out of the universe entirely.
    ejected: held.filter((s) => !selectedSet.has(s)),
    /**
     * Why each one left. Two different events that look identical in a plain
     * list of dropped tickers: a name ranked 40th of 200 has deteriorated, a
     * name that vanished from the scan may simply have failed the liquidity
     * filter. They deserve different reactions.
     */
    exits: held.filter((s) => !selectedSet.has(s)).map((s) => {
      const i = ranked.indexOf(s);
      return i === -1
        ? { symbol: s, reason: 'left the ranked universe', rank: null, exit_rank: exitCutoff }
        : { symbol: s, reason: 'rank deteriorated past the exit cut', rank: i + 1, exit_rank: exitCutoff };
    }),
    band: {
      entry_rank: entryCutoff,
      exit_rank: exitCutoff,
      exit_multiple,
      // The percentile equivalent, for feeding costs.hysteresisExit — which
      // prices a band but does not select with one.
      implied_pct: ranked.length
        ? { entry: Math.round((entryCutoff / ranked.length) * 100), exit: Math.round((exitCutoff / ranked.length) * 100) }
        : null,
    },
    turnover: {
      with_hysteresis: actualTurnover,
      naive_rerank: naiveTurnover,
      names_saved: naiveTurnover - actualTurnover,
    },
    short_by: Math.max(0, slots - selected.length),
  };
}

/**
 * Route ranked candidates into their buckets.
 *
 * A candidate can be surfaced by screens in both buckets. It goes to MONTHS,
 * because the slower bucket is the one whose evidence is stronger and whose
 * costs are lower — and holding a name in both would double the position
 * without saying so.
 */
export function routeToBuckets(candidates, { screenBucket = SCREEN_BUCKET } = {}) {
  const out = { MONTHS: [], WEEKS: [], unrouted: [] };
  for (const c of candidates) {
    const keys = Array.isArray(c.screens) ? c.screens : (c.screen ? [c.screen] : []);
    const buckets = new Set(keys.map((k) => screenBucket[k]).filter(Boolean));
    if (buckets.has('MONTHS')) out.MONTHS.push(c);
    else if (buckets.has('WEEKS')) out.WEEKS.push(c);
    else out.unrouted.push(c);
  }
  return out;
}
