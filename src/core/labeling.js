/**
 * Triple-barrier labelling, after Lopez de Prado, "Advances in Financial
 * Machine Learning" (2018), ch. 3.
 *
 * ── The problem it solves ──
 *
 * The obvious way to label a signal is "what was the return h bars later".
 * That is not how any trade in this repo actually ends. `draw_trade_plan`
 * defines a position by an entry, a stop and a target; the position closes
 * when one of those is touched, or when you give up on it. A fixed-horizon
 * return labels an outcome nobody would have experienced — it happily records
 * +8% for a trade that first went -20% through its stop.
 *
 * Triple-barrier labels by which of three barriers is hit FIRST:
 *
 *   +1  the profit target
 *   -1  the stop
 *    0  neither, within the time limit  (the "vertical" barrier)
 *
 * ── The honest part, shared with backtest.js ──
 *
 * When a single bar's range contains BOTH barriers, OHLC data cannot say which
 * was touched first. backtest.js already resolves those as losses and counts
 * them, on the grounds that assuming the target came first is how a backtest
 * talks itself into an edge. This module does the same and reports the count,
 * because a label set where 30% of outcomes rest on that assumption is not the
 * same evidence as one where 2% do.
 *
 * All pure.
 */

const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Rolling volatility in return terms, the usual way to scale the barriers. */
export function rollingVolatility(bars, { window = 20 } = {}) {
  const out = new Array(bars.length).fill(null);
  const rets = [null];
  for (let i = 1; i < bars.length; i++) rets.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  for (let i = window; i < bars.length; i++) {
    const slice = rets.slice(i - window + 1, i + 1).filter((r) => r != null);
    if (slice.length < 2) continue;
    const m = slice.reduce((a, b) => a + b, 0) / slice.length;
    out[i] = Math.sqrt(slice.reduce((a, r) => a + (r - m) ** 2, 0) / (slice.length - 1));
  }
  return out;
}

/**
 * Label one event.
 *
 * `direction` is +1 for a long or -1 for a short — the barriers flip with it,
 * so a short's "profit target" is below entry. Getting this wrong would label
 * every short backwards, so it is explicit rather than inferred.
 */
export function labelEvent(bars, index, {
  direction = 1,
  profit_mult = 2,
  stop_mult = 1,
  max_bars = 20,
  volatility = null,
  vol_window = 20,
} = {}) {
  if (!Array.isArray(bars) || index < 0 || index >= bars.length) {
    throw new Error(`Event index ${index} is outside the ${bars?.length ?? 0} bars supplied.`);
  }
  if (direction !== 1 && direction !== -1) throw new Error('direction must be 1 (long) or -1 (short).');

  const vol = volatility ?? rollingVolatility(bars, { window: vol_window })[index];
  if (!Number.isFinite(vol) || vol <= 0) {
    return { index, label: null, reason: 'no_volatility_estimate',
      note: `Cannot size barriers at bar ${index}: no usable volatility estimate. Needs ${vol_window}+ prior bars.` };
  }

  const entry = bars[index].close;
  const upBarrier = entry * (1 + vol * (direction === 1 ? profit_mult : stop_mult));
  const dnBarrier = entry * (1 - vol * (direction === 1 ? stop_mult : profit_mult));
  const lastBar = Math.min(bars.length - 1, index + max_bars);

  for (let i = index + 1; i <= lastBar; i++) {
    const hitUp = bars[i].high >= upBarrier;
    const hitDn = bars[i].low <= dnBarrier;

    if (hitUp && hitDn) {
      // Ambiguous: this bar's range spans both. Resolve AGAINST the trade.
      return {
        index, label: -1, exit_index: i, exit_price: round(direction === 1 ? dnBarrier : upBarrier),
        bars_held: i - index, direction, entry: round(entry),
        upper_barrier: round(upBarrier), lower_barrier: round(dnBarrier),
        reason: 'ambiguous_bar',
        ambiguous: true,
        note: 'This bar contained BOTH barriers. OHLC cannot say which came first, so it is resolved as a loss. '
          + 'Assuming the target came first is how a label set talks itself into an edge.',
      };
    }
    if (hitUp) {
      return { index, label: direction === 1 ? 1 : -1, exit_index: i, exit_price: round(upBarrier),
        bars_held: i - index, direction, entry: round(entry),
        upper_barrier: round(upBarrier), lower_barrier: round(dnBarrier),
        reason: direction === 1 ? 'profit_target' : 'stop', ambiguous: false };
    }
    if (hitDn) {
      return { index, label: direction === 1 ? -1 : 1, exit_index: i, exit_price: round(dnBarrier),
        bars_held: i - index, direction, entry: round(entry),
        upper_barrier: round(upBarrier), lower_barrier: round(dnBarrier),
        reason: direction === 1 ? 'stop' : 'profit_target', ambiguous: false };
    }
  }

  // Vertical barrier: time ran out. Label 0 — this is a real outcome, not a
  // missing value, and collapsing it into a win or loss by its sign would
  // invent a decision the rules never made.
  const exit = bars[lastBar].close;
  return {
    index, label: 0, exit_index: lastBar, exit_price: round(exit),
    bars_held: lastBar - index, direction, entry: round(entry),
    upper_barrier: round(upBarrier), lower_barrier: round(dnBarrier),
    unrealized_return_pct: round(((exit - entry) / entry) * 100 * direction, 3),
    reason: 'time_limit', ambiguous: false,
    truncated: lastBar < index + max_bars,
    ...(lastBar < index + max_bars
      ? { note: 'The series ended before the time limit. This label is CENSORED — the outcome is unknown, not neutral.' }
      : {}),
  };
}

/**
 * Label many events, and report the shape of the resulting label set.
 *
 * The summary matters as much as the labels. A set that is 70% zeros is mostly
 * telling you the time limit is too short; one where 30% of outcomes came from
 * ambiguous bars rests heavily on a tie-breaking convention.
 */
export function tripleBarrier(bars, events, opts = {}) {
  if (!Array.isArray(events)) throw new Error('events must be an array of bar indices or {index, direction} objects.');
  const vols = rollingVolatility(bars, { window: opts.vol_window ?? 20 });

  const labels = events.map((e) => {
    const index = typeof e === 'number' ? e : e.index;
    const direction = typeof e === 'number' ? (opts.direction ?? 1) : (e.direction ?? opts.direction ?? 1);
    return labelEvent(bars, index, { ...opts, direction, volatility: vols[index] });
  });

  const usable = labels.filter((l) => l.label != null);
  const wins = usable.filter((l) => l.label === 1).length;
  const losses = usable.filter((l) => l.label === -1).length;
  const zeros = usable.filter((l) => l.label === 0).length;
  const ambiguous = usable.filter((l) => l.ambiguous).length;
  const censored = usable.filter((l) => l.truncated).length;

  const warnings = [];
  if (usable.length && ambiguous / usable.length > 0.15) {
    warnings.push(`${Math.round((ambiguous / usable.length) * 100)}% of labels came from bars containing BOTH barriers and `
      + 'were resolved as losses. That share of the label set rests on a tie-breaking convention, not on data. '
      + 'Widen the barriers or use finer bars.');
  }
  if (usable.length && zeros / usable.length > 0.5) {
    warnings.push(`${Math.round((zeros / usable.length) * 100)}% of events hit neither barrier. The time limit is doing most `
      + 'of the labelling — either lengthen max_bars or narrow the barriers.');
  }
  if (censored) {
    warnings.push(`${censored} label(s) are CENSORED: the series ended before their time limit. Their outcome is unknown. `
      + 'Excluding them biases toward events with room to resolve; including them as 0 invents an outcome.');
  }
  if (labels.length !== usable.length) {
    warnings.push(`${labels.length - usable.length} event(s) had no volatility estimate and are unlabelled.`);
  }

  return {
    labels,
    summary: {
      events: labels.length,
      labelled: usable.length,
      wins, losses, zeros,
      win_rate_pct: (wins + losses) ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
      win_rate_basis: 'wins / (wins + losses) — zeros excluded, because a trade that timed out neither won nor lost',
      ambiguous_bars: ambiguous,
      ambiguous_pct: usable.length ? Math.round((ambiguous / usable.length) * 1000) / 10 : null,
      censored,
      avg_bars_held: usable.length ? Math.round((usable.reduce((a, l) => a + l.bars_held, 0) / usable.length) * 10) / 10 : null,
    },
    ...(warnings.length ? { warnings } : {}),
    barriers: {
      profit_mult: opts.profit_mult ?? 2,
      stop_mult: opts.stop_mult ?? 1,
      max_bars: opts.max_bars ?? 20,
      basis: 'Barriers are multiples of rolling return volatility, so they adapt to the instrument rather than assuming a fixed percentage.',
    },
    method: 'Triple-barrier labelling after Lopez de Prado (2018) ch. 3. Each event is labelled by which barrier it reaches '
      + 'FIRST, which is how a real position with a stop and a target actually ends.',
  };
}

/**
 * The label spans each event depends on — feed straight into `purgedKFold`.
 *
 * This is what makes purging possible: an event at bar 100 that resolves at
 * bar 118 has seen prices through 118, so it must not sit in a training set
 * whose test fold covers any of 100..118.
 */
export function labelSpans(labels) {
  return labels.map((l) => [l.index, l.exit_index ?? l.index]);
}
