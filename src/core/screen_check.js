/**
 * Reverse the screener: given ONE ticker, which screens does it pass?
 *
 * Every screen in `screens.js` runs universe-first — hand TradingView a filter,
 * get back the names that match. That is the right shape for building a morning
 * watchlist and the wrong shape for the question a person actually asks about a
 * symbol they are already looking at: *what is this, and how would I trade it?*
 *
 * Nothing answered that. `SCREENS` was not imported by a single tool file, so
 * the only way to learn whether AAPL passes `momentum_pullback` was to scan the
 * whole universe and look for it in the results.
 *
 * This evaluates the same filters CLIENT-SIDE against one symbol's row, clause by
 * clause, and reports which clause failed and by how much. A near miss is the
 * useful case — "fails RSI by 2 points" tells you what to wait for, where a bare
 * "no match" tells you nothing.
 *
 * ── Why this is not a strategy recommendation ──
 *
 * A screen is a COARSE FILTER. `docs/screening.md` is explicit that stage 1 is
 * TradingView narrowing the universe and stage 2 is this repo's detectors
 * returning a verdict. Passing a screen means "worth looking at", never "trade
 * it" — and several of the strategies a screen points to are Tier C or worse.
 * `strategies` on each result carries the evidence tier so the two never get
 * confused.
 *
 * All pure — the caller supplies the row.
 */
import { SCREENS, INTRADAY_SCREENS } from './screens.js';
import { offHighPct } from './scanner.js';
import { loadCatalogue } from './catalogue.js';

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Every column any screen's filter or refine reads. */
export function requiredColumns() {
  const cols = new Set([
    'name', 'description', 'close', 'RSI', 'sector', 'industry', 'market_cap_basic',
    'price_52_week_high', 'Volatility.D',
    'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y',
    'average_volume_10d_calc', 'relative_volume_10d_calc', 'earnings_release_next_date',
  ]);
  for (const s of [...SCREENS, ...INTRADAY_SCREENS]) {
    for (const f of s.filter || []) cols.add(f.left);
    for (const c of s.columns || []) cols.add(c);
  }
  return [...cols];
}

/**
 * Evaluate one TradingView filter clause against a row.
 *
 * Returns `pass: null` — UNKNOWN — when the column is absent, never false. A
 * missing column silently reading as a fail is how a screener quietly stops
 * matching anything, which is the failure mode `evaluateCriteria` was also
 * written to avoid.
 */
export function evalClause(clause, row) {
  const raw = row?.[clause.left];
  const v = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const base = { field: clause.left, operation: clause.operation, required: clause.right, actual: round(v, 4) };

  if (!Number.isFinite(v)) {
    return { ...base, pass: null, reason: `${clause.left} was not returned, so this clause is UNKNOWN, not failed.` };
  }

  let pass = null; let distance = null;
  if (clause.operation === 'greater') {
    pass = v > clause.right;
    distance = round(v - clause.right, 4);
  } else if (clause.operation === 'less') {
    pass = v < clause.right;
    distance = round(clause.right - v, 4);
  } else if (clause.operation === 'in_range' && Array.isArray(clause.right)) {
    const [lo, hi] = clause.right;
    pass = v >= lo && v <= hi;
    // Signed distance to whichever edge was missed, so a near miss is readable.
    distance = pass ? round(Math.min(v - lo, hi - v), 4) : round(v < lo ? v - lo : hi - v, 4);
  } else {
    return { ...base, pass: null, reason: `Unsupported operation "${clause.operation}".` };
  }

  return {
    ...base,
    pass,
    margin: distance,
    ...(pass ? {} : {
      reason: clause.operation === 'in_range'
        ? `${clause.left} is ${round(v, 2)}, outside [${clause.right[0]}, ${clause.right[1]}] by ${Math.abs(distance)}.`
        : `${clause.left} is ${round(v, 2)}, needs ${clause.operation} than ${clause.right}.`,
    }),
  };
}

/** Evaluate one screen against one row: every filter clause, then refine. */
export function checkScreen(screen, row) {
  const clauses = (screen.filter || []).map((f) => evalClause(f, row));
  const failed = clauses.filter((c) => c.pass === false);
  const unknown = clauses.filter((c) => c.pass === null);

  // `refine` is a predicate rather than data, so it can only be run, not
  // explained. Report what it is looking at when it is the sole failure.
  let refinePass = null;
  let refineError = null;
  if (!failed.length) {
    try { refinePass = screen.refine ? !!screen.refine(row) : true; }
    catch (e) { refineError = e.message; }
  }

  const passes = !failed.length && refinePass === true;
  const nearMiss = !passes && failed.length === 1;

  return {
    screen: screen.key,
    name: screen.name,
    direction: screen.direction,
    horizon_side: screen.horizon_side,
    evidence: screen.evidence,
    ...(screen.session ? { session: screen.session } : {}),
    passes,
    clauses,
    clauses_passed: clauses.filter((c) => c.pass === true).length,
    clauses_total: clauses.length,
    ...(failed.length ? { failed_clauses: failed.map((c) => c.reason) } : {}),
    ...(unknown.length ? { unknown_clauses: unknown.map((c) => c.reason) } : {}),
    refine: failed.length
      ? 'not evaluated — a filter clause already failed'
      : refineError ? `errored: ${refineError}` : refinePass,
    ...(!failed.length && refinePass === false
      ? {
          refine_note: 'Every filter clause passed and the client-side refine rejected it. That step is where the '
            + 'off-high band lives, so this is usually about how far price sits from its 52-week high.',
          off_high_pct: round(offHighPct(row), 2),
        }
      : {}),
    ...(nearMiss ? { near_miss: `One clause away: ${failed[0].reason}` } : {}),
    ...(screen.post ? { cross_row_step: 'This screen also has a CROSS-ROW step that a single symbol cannot satisfy '
      + 'alone — group_leadership keeps only the top two of each group. Passing here means the symbol qualifies '
      + 'individually; run group_context to see whether it is actually a leader.' } : {}),
  };
}

/**
 * The whole reverse screen, plus the strategies each passing screen implies.
 *
 * `session_state` comes from `scannerTrust()`. It decides whether the
 * session-restricted screens are evaluated at all, because ranking
 * `short_term_reversal` on fields that fold the forming day would be wrong, and
 * `premarket_gap` after the close reads stale data.
 */
export function screenCheck(row, { volume_fields_usable = true, include_intraday = true } = {}) {
  if (!row) return { available: false, note: 'No scanner row supplied for this symbol.' };

  const cat = loadCatalogue();
  const strategiesFor = (screenKey) => Object.entries(cat.strategies || {})
    .filter(([, s]) => String(s.screener || '').includes(screenKey))
    .map(([name, s]) => ({
      name,
      label: s.label,
      execution: s.execution,
      evidence_tier: s.evidence_tier,
      entry: s.entry,
      exit: s.exit,
      indicators: s.indicators || [],
      skills: s.skills || [],
      tools: s.tools || [],
    }));

  const evaluate = (list) => list.map((s) => {
    if (s.session === 'settled' && !volume_fields_usable) {
      return { screen: s.key, name: s.name, passes: null,
        skipped: 'Needs a settled session — it ranks on fields that fold the forming day.' };
    }
    if (s.session === 'premarket' && volume_fields_usable) {
      return { screen: s.key, name: s.name, passes: null,
        skipped: 'Pre-open only — after the close its premarket fields are stale.' };
    }
    const r = checkScreen(s, row);
    return { ...r, strategies: r.passes ? strategiesFor(s.key) : undefined };
  });

  const swing = evaluate(SCREENS);
  const intraday = include_intraday ? evaluate(INTRADAY_SCREENS) : [];
  const all = [...swing, ...intraday];
  const passing = all.filter((r) => r.passes === true);
  const near = all.filter((r) => r.passes === false && r.near_miss);

  const strategies = [];
  const seen = new Set();
  for (const r of passing) {
    for (const st of r.strategies || []) {
      if (seen.has(st.name)) continue;
      seen.add(st.name);
      strategies.push({ ...st, via_screen: r.screen });
    }
  }
  const rank = { A: 0, B: 1, C: 2, REJECTED: 9 };
  strategies.sort((a, b) => (rank[a.evidence_tier] ?? 5) - (rank[b.evidence_tier] ?? 5));

  return {
    available: true,
    screens_evaluated: all.filter((r) => !r.skipped).length,
    screens_skipped: all.filter((r) => r.skipped).map((r) => ({ screen: r.screen, why: r.skipped })),
    passing: passing.map((r) => r.screen),
    passing_count: passing.length,
    near_misses: near.map((r) => ({ screen: r.screen, one_clause_away: r.near_miss })),
    results: all,
    strategies,
    verdict: passing.length
      ? `Passes ${passing.length} screen(s): ${passing.map((r) => r.screen).join(', ')}. `
        + `${strategies.length} candidate strateg${strategies.length === 1 ? 'y' : 'ies'}, best evidence tier `
        + `${strategies[0]?.evidence_tier || 'n/a'}.`
      : near.length
        ? `Passes NO screen. ${near.length} near miss(es) — the closest is worth watching rather than trading.`
        : 'Passes no screen and is not close to any. On this evidence there is no setup here; cash is a position.',
    what_this_is_not:
      'A screen is a COARSE FILTER. Passing one means WORTH LOOKING AT, not worth trading — stage 2 of the design in '
      + 'docs/screening.md is this repo\'s own detectors returning a verdict, and several strategies a screen points to '
      + 'are Tier C. Read every strategy\'s evidence_tier before acting, and note that six catalogue entries are '
      + 'REJECTED outright.',
  };
}
