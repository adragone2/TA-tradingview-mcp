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
 * than the position. Two more come from Shannon's seven exit events (Technical
 * Analysis Using Multiple Timeframes, ch. 16): a gap against the trend, and a
 * moving-average crossover. Both are PLANNED, so omitting them was pushing
 * modellable exits into `discretionary_other` and understating the share of
 * trading a backtest can represent.
 *
 * Nothing here judges an exit. It counts them, splits them, and says what the
 * split means for whether a backtest can be believed.
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
  /**
   * Shannon's seven exit events (ch. 16) overlap Bellafiore's ten almost
   * exactly, except for these two — and both are PLANNED, so leaving them out
   * pushed real modellable exits into `discretionary_other` and made the
   * planned share look worse than it was.
   */
  gap_against_trend: {
    label: 'Gapped against the trend by 5% or more', driver: 'position', planned: true,
    note: 'Shannon ch. 16: dramatic gaps "normally more than five percent (versus more common gaps of one to two '
      + 'percent)" against a position, where "it is often best to sell the entire position." Specifiable in advance '
      + 'as a threshold, so a backtest can model it — but see gap_risk and luld_band, because the FILL is not the '
      + 'gap price. The reasoning is informational rather than technical: a move that size means fundamentals '
      + 'changed, so a chart-based thesis no longer has standing.',
  },
  ma_crossover: {
    label: 'Moving averages crossed — indecision', driver: 'position', planned: true,
    note: 'The TIME-correction exit. Shannon treats a crossover as a sign of INDECISION rather than direction '
      + '(ch. 10), which is why it appears here as an exit and nowhere as an entry. Fully specifiable, and it fires '
      + 'on the correction a depth-based rule cannot see — see legs_classify\'s time_correction.',
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
    source: 'Taxonomy from Bellafiore, The PlayBook (2013), ch. 3 "Reasons2Sell", plus the two planned exits from '
      + 'Shannon, Technical Analysis Using Multiple Timeframes (2008), ch. 16: gap_against_trend and ma_crossover.',
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

/* ------------------------- slicing a trade journal ---------------------- */

/**
 * Slice a set of closed trades and report P&L per bucket.
 *
 * The reason to bother is Shannon's Figure 16.2, which is his own broker's
 * report over three weeks of real trading. Two of its buckets were net
 * NEGATIVE inside a profitable book:
 *
 *   stocks over $100        159 trades, 47.2% winners, average −3.82
 *   trades held 16–30 min    44 trades, 50.0% winners, average −17.93
 *
 * Both are invisible in an aggregate win rate, and both are actionable in a way
 * "improve your discipline" is not. His short trades also won MORE often than
 * his longs (56.4% vs 52.0%), which is the opposite of what most traders
 * assume about themselves.
 *
 * So the default slices are his: direction, share size, share price, and
 * holding time. `exitMix` already answers "can a backtest represent this book";
 * this answers "which parts of the book actually make the money".
 *
 * ── The honesty problem, and how this handles it ──
 *
 * Slicing invites the exact error the rest of this repo guards against. Cut 40
 * trades four ways and some bucket will look terrible by chance; act on it and
 * you have fitted noise. So every bucket reports its own `n`, buckets under
 * `min_n` are marked `underpowered` rather than ranked, and the result carries
 * the number of buckets examined so the multiple-comparison problem is visible.
 * A slice finding is a HYPOTHESIS about where to look, never a conclusion.
 *
 * `trades` is an array of objects. Recognised fields, all optional:
 *   pnl (required), direction, shares, price (entry), minutes_held or bars_held,
 *   reason (an EXIT_REASONS key), setup_tier.
 *
 * Pure.
 */
export const DEFAULT_BUCKETS = Object.freeze({
  shares: [200, 500, 750, 1000],
  price: [10, 25, 50, 100],
  minutes_held: [5, 15, 30, 60, 120],
});

/** Which bucket does `value` fall in, given ascending edges? */
function bucketOf(value, edges, unit = '') {
  if (!Number.isFinite(value)) return null;
  for (let i = 0; i < edges.length; i += 1) {
    if (value <= edges[i]) {
      return i === 0 ? `<= ${edges[0]}${unit}` : `${edges[i - 1]}-${edges[i]}${unit}`;
    }
  }
  return `> ${edges[edges.length - 1]}${unit}`;
}

export function sliceTrades(trades = [], { min_n = 10, buckets = DEFAULT_BUCKETS } = {}) {
  const clean = (Array.isArray(trades) ? trades : []).filter((t) => t && Number.isFinite(Number(t.pnl)));
  if (!clean.length) {
    return {
      available: false,
      note: (Array.isArray(trades) ? trades : []).length
        ? 'No trades had a numeric pnl. Nothing here can be computed without it.'
        : 'No trades to slice.',
    };
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const summarise = (set) => {
    const pnls = set.map((t) => Number(t.pnl));
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);
    const total = pnls.reduce((a, b) => a + b, 0);
    return {
      n: set.length,
      total_pnl: round2(total),
      avg_pnl: round2(total / set.length),
      win_rate_pct: Math.round((wins.length / set.length) * 1000) / 10,
      avg_win: wins.length ? round2(wins.reduce((a, b) => a + b, 0) / wins.length) : null,
      avg_loss: losses.length ? round2(losses.reduce((a, b) => a + b, 0) / losses.length) : null,
      // Underpowered buckets are reported but never ranked. A losing bucket of
      // six trades is a coin landing tails six times.
      ...(set.length < min_n ? { underpowered: true } : {}),
    };
  };

  const dimensions = {};
  const add = (dim, key, trade) => {
    if (key === null || key === undefined) return;
    dimensions[dim] = dimensions[dim] || {};
    (dimensions[dim][key] = dimensions[dim][key] || []).push(trade);
  };

  for (const t of clean) {
    if (t.direction) add('direction', String(t.direction).toLowerCase(), t);
    add('shares', bucketOf(Number(t.shares), buckets.shares), t);
    add('price', bucketOf(Number(t.price), buckets.price, ''), t);
    const mins = Number.isFinite(Number(t.minutes_held)) ? Number(t.minutes_held) : null;
    if (mins !== null) add('minutes_held', bucketOf(mins, buckets.minutes_held, 'm'), t);
    if (t.reason && EXIT_REASONS[t.reason]) {
      add('exit_reason', t.reason, t);
      add('exit_planned', EXIT_REASONS[t.reason].planned ? 'planned' : 'discretionary', t);
    }
    if (t.setup_tier) add('setup_tier', String(t.setup_tier), t);
  }

  const sliced = {};
  let bucketCount = 0;
  for (const [dim, groups] of Object.entries(dimensions)) {
    sliced[dim] = {};
    for (const [key, set] of Object.entries(groups)) {
      sliced[dim][key] = summarise(set);
      bucketCount += 1;
    }
  }

  // The buckets that lose money on an adequate sample. These are the finding
  // Shannon's report surfaced, and they are hypotheses about where to look.
  const negative = [];
  for (const [dim, groups] of Object.entries(sliced)) {
    for (const [key, s] of Object.entries(groups)) {
      if (s.total_pnl < 0 && !s.underpowered) negative.push({ dimension: dim, bucket: key, ...s });
    }
  }
  negative.sort((a, b) => a.total_pnl - b.total_pnl);

  const overall = summarise(clean);

  return {
    available: true,
    overall,
    slices: sliced,
    buckets_examined: bucketCount,
    min_n,
    net_negative_buckets: negative,
    ...(negative.length && overall.total_pnl > 0
      ? {
          headline: `The book is net positive (${overall.total_pnl}) but ${negative.length} bucket(s) lose money on an `
            + `adequate sample. Shannon's own report had exactly this shape: stocks over $100 averaged −3.82 across 159 `
            + 'trades, and trades held 16–30 minutes averaged −17.93 across 44, inside a profitable three weeks.',
        }
      : {}),
    multiple_comparisons_warning:
      `${bucketCount} buckets were examined across ${Object.keys(sliced).length} dimensions on ${clean.length} trades. `
      + 'Cut a small book enough ways and some bucket looks terrible by chance. A losing bucket here is a HYPOTHESIS '
      + `about where to look, not a conclusion — buckets under ${min_n} trades are flagged underpowered and not ranked. `
      + 'Before acting, ask whether the bucket has a mechanism, and check whether it survives on later trades.',
    why_slice_at_all:
      'An aggregate win rate hides the two things worth knowing: which parts of the book pay, and which quietly do not. '
      + 'Shannon\'s short trades won MORE often than his longs (56.4% vs 52.0%), which is the opposite of what most '
      + 'traders assume. exitMix answers whether a backtest can represent this book; this answers where the money is.',
    source: 'Slice dimensions from Shannon, Technical Analysis Using Multiple Timeframes (2008), Figure 16.2 — his own '
      + 'broker\'s Trade Evaluator report.',
  };
}
