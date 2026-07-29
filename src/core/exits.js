/**
 * Why a position was closed — as a taxonomy, so exits become countable.
 *
 * The journal already records WHICH BARRIER was hit: target, stop, or time.
 * Three categories is enough to label an outcome and not enough to learn
 * anything from it, because it cannot tell apart:
 *
 *   - an exit the PLAN called for (target reached, stop hit, time elapsed), and
 *   - an exit the trader DECIDED on while the position was open (the tape
 *     turned, the index hit resistance, news broke).
 *
 * That distinction is the one that matters here, and not for discipline
 * reasons. A backtest can only ever model plan exits. So if most real exits are
 * discretionary, the backtest does not describe the trading — it describes a
 * different strategy that shares an entry signal. Every honesty rule in this
 * repo about benchmarks and trial counts is defeated at a stroke if the exit
 * rule in the test is not the exit rule in the account.
 *
 * The taxonomy is Bellafiore's Reasons2Sell (The PlayBook, ch. 3), which
 * enumerates ten and — usefully — includes several driven by the INDEX rather
 * than the position. Nothing here judges an exit. It counts them, splits them,
 * and says what the split means for whether a backtest can be believed.
 *
 * All pure.
 */

/**
 * `planned: true` means the condition was specifiable BEFORE entry, so a
 * backtest can represent it. `false` means it required a judgement made while
 * the position was live.
 *
 * `driver` says what the exit was actually watching — the position, the wider
 * market, the order flow, or the clock. Market-driven exits are the ones a
 * single-symbol backtest cannot see at all.
 */
export const EXIT_REASONS = Object.freeze({
  target_hit: {
    label: 'Stock hit your price target', driver: 'position', planned: true,
    note: 'The only exit a naive backtest models correctly.',
  },
  stop_hit: {
    label: 'Stop was hit', driver: 'position', planned: true,
    note: 'Modelled, but fills at the stop price in most backtests — see gap_risk and luld_band for why that flatters.',
  },
  time_elapsed: {
    label: 'Time clock went off', driver: 'clock', planned: true,
    note: 'The third barrier in triple-barrier labelling, and the Months bucket exit. Specifiable in advance.',
  },
  trend_broken: {
    label: 'Trend on your chosen timeframe broke', driver: 'position', planned: true,
    note: 'Planned ONLY if the timeframe was fixed before entry. Bellafiore: "just be consistent." '
      + 'Choosing the timeframe after the fact is the timeframe-justification trap mtf_analyze warns about.',
  },
  level_reached: {
    label: 'Ran into an important technical level', driver: 'position', planned: true,
    note: 'Planned if the level was drawn before entry; discretionary if found afterwards.',
  },
  market_at_level: {
    label: 'The INDEX hit an important level', driver: 'market', planned: false,
    note: 'A single-symbol backtest cannot see this at all.',
  },
  market_news: {
    label: 'Breaking news in the market', driver: 'market', planned: false,
    note: 'Unmodellable. Also the honest reason behind many exits attributed to something else.',
  },
  stock_news: {
    label: 'Breaking news about the stock', driver: 'market', planned: false,
    note: 'The prior price action may simply no longer apply.',
  },
  tape_seller: {
    label: 'Unusual size on the tape against you', driver: 'tape', planned: false,
    note: 'Order-flow judgement. Invisible to bar data, so invisible to every backtest here.',
  },
  pattern_dissipated: {
    label: 'The pattern that justified the trade stopped working', driver: 'tape', planned: false,
    note: 'Defensible and unmodellable. Worth counting precisely because it feels like discipline.',
  },
  too_steep: {
    label: 'Move went parabolic — took it off', driver: 'position', planned: false,
    note: 'A judgement about extension. Could be made planned by defining it in ATRs beforehand.',
  },
  too_much_pullback: {
    label: 'Gave back too much of the move', driver: 'position', planned: false,
    note: 'Could be made planned as a trailing rule — but see stopping_premium first, since a trail is a bet on persistence.',
  },
  discretionary_other: {
    label: 'Something else, decided while live', driver: 'unknown', planned: false,
    note: 'Use this rather than forcing a fit. An honest unknown counts; a wrong label corrupts the distribution.',
  },
});

/** Reason keys, for validation and for the journal's dropdown. */
export const EXIT_KEYS = Object.freeze(Object.keys(EXIT_REASONS));

/**
 * Summarise a set of journalled exits.
 *
 * `exits` is an array of reason keys, or of objects with a `reason` field.
 * Unknown keys are collected rather than dropped — a silent drop would make the
 * distribution look cleaner than the journal actually is.
 */
export function exitMix(exits = []) {
  const keys = exits.map((e) => (typeof e === 'string' ? e : e?.reason)).filter(Boolean);
  const known = keys.filter((k) => EXIT_REASONS[k]);
  const unknown = keys.filter((k) => !EXIT_REASONS[k]);

  if (!known.length) {
    return {
      available: false,
      note: keys.length
        ? `None of the ${keys.length} reason(s) given are in the taxonomy. Unrecognised: ${[...new Set(unknown)].join(', ')}.`
        : 'No exits to summarise.',
      unrecognised: [...new Set(unknown)],
    };
  }

  const count = (pred) => known.filter((k) => pred(EXIT_REASONS[k])).length;
  const byReason = {};
  for (const k of known) byReason[k] = (byReason[k] || 0) + 1;
  const byDriver = {};
  for (const k of known) {
    const d = EXIT_REASONS[k].driver;
    byDriver[d] = (byDriver[d] || 0) + 1;
  }

  const n = known.length;
  const planned = count((r) => r.planned);
  const discretionary = n - planned;
  const marketDriven = count((r) => r.driver === 'market');
  const pct = (x) => Math.round((x / n) * 1000) / 10;

  /**
   * The threshold is a CHOICE, not a finding. It is set where the backtest
   * stops describing the trading in any useful sense rather than at a level
   * anyone has measured.
   */
  const discretionaryPct = pct(discretionary);
  const verdict = discretionaryPct >= 50
    ? 'A BACKTEST CANNOT REPRESENT THIS TRADING. Most exits were decided while the position was live, so any '
      + 'backtest is measuring a different strategy that happens to share an entry signal.'
    : discretionaryPct >= 25
      ? 'Backtest results are indicative only. A quarter or more of exits were discretionary, so the modelled '
        + 'exit is not the one being used.'
      : 'Exits are mostly plan-following, so a backtest of this entry with these exits is a fair test of it.';

  return {
    available: true,
    exits_counted: n,
    by_reason: byReason,
    by_driver: byDriver,
    planned, discretionary,
    planned_pct: pct(planned),
    discretionary_pct: discretionaryPct,
    market_driven: marketDriven,
    market_driven_pct: pct(marketDriven),
    verdict,
    why_it_matters:
      'A backtest can only model an exit that was specifiable before entry. Discretionary exits are not worse '
      + 'trading — they may well be better — but they break the link between a backtest and the account. '
      + `${marketDriven} of these exits were driven by the INDEX rather than the position, and a single-symbol `
      + 'backtest cannot see those at all.',
    ...(unknown.length ? { unrecognised: [...new Set(unknown)], unrecognised_count: unknown.length } : {}),
    source: 'Taxonomy from Bellafiore, The PlayBook (2013), ch. 3 "Reasons2Sell".',
  };
}

/**
 * Whether a named reason can be represented in a backtest.
 * Returns null for an unknown key rather than guessing either way.
 */
export function isModellable(reason) {
  const r = EXIT_REASONS[reason];
  return r ? r.planned : null;
}
