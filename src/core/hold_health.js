/**
 * HOLD HEALTH — Minervini's "violations" checklist as measurable clauses.
 *
 * The MPA practitioners run their platform on exactly this idea: while a
 * position is on, a BUILD-UP of rule violations is the reason to lighten or
 * leave, and "without having any reason to sell, there's no reason to get
 * out" (podcast, read 2026-08-03). The published violation vocabulary is
 * Minervini's (Think & Trade Like a Champion); the operationalisation — every
 * clause a number, every threshold stated — is this repo's, and any threshold
 * the books leave unquantified is marked `source: 'ours'` in the clause note.
 *
 * WHAT THIS IS NOT: an exit signal. The floor below is the reason — random
 * walks rack up violations constantly, because these clauses DESCRIBE
 * pullbacks and every walk pulls back. A tally describes deterioration the
 * way candle_read describes a bar; the measured exit machinery stays the
 * stop, pivot_trail, and the owner's DISTRIBUTION state. If this tally is
 * ever to GATE anything, it needs the full campaign treatment first
 * (sweep + holdout, the level_pressure lesson).
 */

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function sma(closes, period, endIdx) {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += closes[i];
  return s / period;
}

/**
 * Measured 2026-08-03 over 200 random walks (lognormal volume, 300 bars,
 * anchor 20 bars back): see HOLD_HEALTH_NOISE_BASELINE below, and
 * `node scripts/hold-health-noise.js` to re-measure. Quote it beside any tally.
 */
export function holdHealth(bars, { entry_bars_ago = 20, entry_price = null, pre_window = 63 } = {}) {
  const n = bars?.length ?? 0;
  const anchor = n - 1 - Math.floor(entry_bars_ago);
  if (n < 30 || anchor < 5) {
    return {
      available: false,
      why: `needs the anchor at least 5 bars into a series of 30+ (got ${n} bars, anchor index ${anchor}). `
        + 'Too little history is NOT a clean bill of health.',
    };
  }

  const closes = bars.map((b) => b.close);
  const last = n - 1;
  const since = bars.slice(anchor + 1); // bars after entry
  const pre = bars.slice(Math.max(0, anchor - pre_window), anchor + 1);

  const pctChange = (b, i, arr) => {
    const prev = i === 0 ? null : arr[i - 1].close;
    return prev ? ((b.close - prev) / prev) * 100 : null;
  };
  const sinceChanges = since.map((b, i) => pctChange(b, i, since)).filter((x) => x != null);
  const preChanges = pre.map((b, i) => pctChange(b, i, pre)).filter((x) => x != null);

  const downSince = sinceChanges.filter((c) => c < 0);
  const upSince = sinceChanges.filter((c) => c > 0);
  const worstSince = downSince.length ? Math.min(...downSince) : null;
  const worstPre = preChanges.filter((c) => c < 0).length ? Math.min(...preChanges.filter((c) => c < 0)) : null;

  const volOnDown = since.reduce((s, b, i) => s + ((sinceChanges[i - 1] ?? 0) < 0 ? (b.volume ?? 0) : 0), 0);
  const volOnUp = since.reduce((s, b, i) => s + ((sinceChanges[i - 1] ?? 0) > 0 ? (b.volume ?? 0) : 0), 0);
  const maxDownVolSince = Math.max(0, ...since.map((b, i) => ((sinceChanges[i - 1] ?? 0) < 0 ? (b.volume ?? 0) : 0)));
  const maxDownVolPre = Math.max(0, ...pre.map((b, i) => ((preChanges[i - 1] ?? 0) < 0 ? (b.volume ?? 0) : 0)));

  let lowerLows = 0;
  for (let i = last; i > 0; i--) {
    if (bars[i].low < bars[i - 1].low) lowerLows++; else break;
  }

  const ma20 = sma(closes, 20, last);
  const ma50 = sma(closes, 50, last);

  const violations = [
    {
      key: 'biggest_down_day_since_entry',
      fired: worstSince != null && worstPre != null && worstSince < worstPre,
      value: r2(worstSince), requirement: `worse than the pre-entry ${pre_window}-bar worst (${r2(worstPre)}%)`,
      note: 'Minervini: the largest single-day decline since the move began. Comparison window is ours.',
    },
    {
      key: 'biggest_down_volume_since_entry',
      fired: maxDownVolPre > 0 && maxDownVolSince > maxDownVolPre,
      value: maxDownVolSince || null, requirement: `above the pre-entry max down-day volume (${maxDownVolPre || 'n/a'})`,
      note: 'Minervini: the heaviest selling volume since the move began. Comparison window is ours.',
    },
    {
      key: 'more_down_days_than_up',
      fired: sinceChanges.length >= 5 && downSince.length > upSince.length,
      value: `${downSince.length} down vs ${upSince.length} up`, requirement: 'down > up since entry (min 5 bars)',
      note: 'Minervini: more down days than up days in the holding period.',
    },
    {
      key: 'more_volume_down_than_up',
      fired: sinceChanges.length >= 5 && volOnDown > volOnUp,
      value: `${Math.round(volOnDown / 1e3)}k down vs ${Math.round(volOnUp / 1e3)}k up`,
      requirement: 'down-day volume > up-day volume since entry',
      note: 'Minervini: volume concentrating on the down days — distribution while you hold.',
    },
    {
      key: 'three_plus_lower_lows',
      fired: lowerLows >= 3,
      value: lowerLows, requirement: '>= 3 consecutive lower lows into the last bar',
      note: 'Minervini: consecutive lower lows without supportive action.',
    },
    {
      key: 'close_below_ma20',
      fired: ma20 != null && closes[last] < ma20,
      value: r2(closes[last]), requirement: `close >= 20-bar average (${r2(ma20)})`,
      note: 'The short-term line in the sand for a fresh swing position.',
    },
    {
      key: 'close_below_ma50',
      fired: ma50 != null && closes[last] < ma50,
      value: r2(closes[last]), requirement: `close >= 50-bar average (${r2(ma50)})`,
      note: 'Minervini/MPA backstop: their last piece leaves on a close below the 50.',
    },
    {
      key: 'close_below_entry',
      fired: entry_price != null && closes[last] < Number(entry_price),
      value: r2(closes[last]), requirement: entry_price != null ? `close >= entry (${r2(Number(entry_price))})` : 'entry_price not supplied — NOT CHECKED',
      note: 'A breakout trading back below the price paid — the free-roll is gone.',
    },
  ];

  const confirmations = [
    {
      key: 'more_up_days_than_down',
      fired: sinceChanges.length >= 5 && upSince.length > downSince.length,
      value: `${upSince.length} up vs ${downSince.length} down`,
    },
    {
      key: 'more_volume_up_than_down',
      fired: sinceChanges.length >= 5 && volOnUp > volOnDown,
      value: `${Math.round(volOnUp / 1e3)}k up vs ${Math.round(volOnDown / 1e3)}k down`,
    },
    {
      key: 'above_ma20',
      fired: ma20 != null && closes[last] >= ma20,
      value: r2(closes[last]),
    },
    {
      key: 'new_high_since_entry',
      fired: since.length > 0 && bars[last].high >= Math.max(...since.map((b) => b.high)),
      value: r2(bars[last].high),
    },
  ];

  const fired = violations.filter((v) => v.fired);
  const unchecked = violations.filter((v) => String(v.requirement).includes('NOT CHECKED'));
  return {
    available: true,
    anchor: { index: anchor, bars_ago: last - anchor, price: r2(bars[anchor].close), time: bars[anchor].time ?? null },
    bars_since_entry: since.length,
    violation_count: fired.length,
    violations,
    confirmation_count: confirmations.filter((c) => c.fired).length,
    confirmations,
    ...(unchecked.length ? { not_checked: unchecked.map((v) => v.key) } : {}),
    noise_baseline: HOLD_HEALTH_NOISE_BASELINE,
    reading: 'A tally DESCRIBES deterioration — it is not a measured exit signal. Random walks fire these '
      + 'clauses constantly (see noise_baseline), because pullbacks fire them and every walk pulls back. '
      + 'The measured exit machinery stays the stop, pivot_trail, and the owner\'s DISTRIBUTION state.',
  };
}

/**
 * Measured 2026-08-03, `node scripts/hold-health-noise.js` re-measures.
 * The shape of the result IS the finding: the majority clauses are coin
 * flips on noise (~50% — down-vs-up days, volume balance, either MA), so a
 * tally of 2-3 is the RESTING STATE of a random position, not a warning.
 * The selective clauses are three_plus_lower_lows (12.5%) and the two
 * biggest-since-entry records (~23%) — weight those, not the count.
 */
export const HOLD_HEALTH_NOISE_BASELINE = {
  walks: 200,
  bars: 300,
  entry_bars_ago: 20,
  mean_violations: 2.6,
  mean_confirmations: 1.59,
  walks_with_1plus_pct: 79,
  walks_with_3plus_pct: 51,
  walks_with_5plus_pct: 21,
  per_clause_pct: {
    more_volume_down_than_up: 52.5,
    close_below_ma20: 52,
    more_down_days_than_up: 50.5,
    close_below_ma50: 46,
    biggest_down_day_since_entry: 23.5,
    biggest_down_volume_since_entry: 23,
    three_plus_lower_lows: 12.5,
  },
  reading: 'Half of random walks show 3+ violations at 20 bars in. Quote the SELECTIVE clauses '
    + '(lower lows, biggest-since-entry records), never the bare count.',
};
