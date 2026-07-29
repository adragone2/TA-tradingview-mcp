/**
 * The morning screens — criteria as DATA, not prose.
 *
 * Each is a different bet with a different evidence basis, not six flavours of
 * one idea. The field that matters most on each is `horizon_side`: below ~21
 * trading days the documented effect is REVERSAL, above ~63 it is CONTINUATION,
 * and a screen that does not say which side it is on is hiding its main risk.
 *
 * ── The trap these are all shaped around ──
 *
 * The obvious momentum-pullback screen is "12-month momentum positive, RSI
 * low". Run against the real universe it returns SNDK at -49.5% on the month
 * and -53% off its high, AXTI at -70% off its high. Those are not pullbacks.
 * They are COLLAPSES that still carry a positive twelve-month number, and a low
 * RSI is what a collapse looks like on the way down.
 *
 * Bounding the retracement on BOTH sides inverts the population entirely —
 * RVMD -5.5% off its high, GSAT -6.7%, TVTX -7.0%. So every threshold here is
 * a RANGE. A one-sided threshold on a momentum screen selects the tail, and the
 * tail is where the broken names are.
 *
 * All pure.
 */
import { LIQUIDITY_FILTER, offHighPct, daysToEarnings } from './scanner.js';

/**
 * The six screens.
 *
 * `filter` is what TradingView evaluates. `refine` is a client-side predicate
 * for things the scanner cannot express as a filter — a ratio between two
 * returned columns, for instance. `rank` orders that screen's own candidates.
 */
export const SCREENS = [
  {
    key: 'momentum_pullback',
    direction: 'continuation',
    name: 'Momentum pullback',
    bet: 'A name in a documented uptrend, temporarily paused rather than broken.',
    horizon_side: 'BOTH — 12m continuation, sub-21d reversal. The only screen where the evidence '
      + 'pulls the same way on both legs.',
    evidence: 'A. Time-series momentum replicated on 58/58 futures (Sharpe 1.28). Short-term '
      + 'reversal is the documented effect under 21 days. PORTFOLIO result — see edge_breadth.',
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 2e9 },
      { left: 'Perf.Y', operation: 'greater', right: 0 },
      { left: 'Perf.6M', operation: 'greater', right: 0 },
      { left: 'RSI', operation: 'in_range', right: [35, 55] },
      { left: 'Perf.1M', operation: 'in_range', right: [-15, 5] },
    ],
    // A pullback is shallow. Deeper than a quarter off the high is a downtrend
    // that has not finished being a downtrend yet.
    refine: (r) => { const o = offHighPct(r); return o != null && o >= 2 && o <= 25; },
    rank: (r) => r['Perf.Y'] ?? -Infinity,
  },

  {
    key: 'near_52w_high',
    direction: 'continuation',
    name: '52-week high proximity',
    bet: 'Price near its 52-week high, which is cross-sectionally documented.',
    horizon_side: 'CONTINUATION',
    evidence: 'A, but CROSS-SECTIONAL — measured on 1000+ ranked stocks. edge_breadth gives what '
      + 'one position retains of that.',
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 2e9 },
      { left: 'Perf.6M', operation: 'greater', right: 0 },
      { left: 'RSI', operation: 'in_range', right: [45, 70] },
    ],
    // The scanner has price_52_week_high as a COLUMN, not a ratio it can filter
    // on, so proximity is computed here.
    refine: (r) => { const o = offHighPct(r); return o != null && o <= 5; },
    rank: (r) => -(offHighPct(r) ?? 999),
  },

  {
    key: 'volatility_contraction',
    direction: 'continuation',
    name: 'Volatility contraction',
    bet: 'A coiled market about to expand. Stage 1 narrows; only a 0%-noise detector justifies a trade.',
    horizon_side: 'CONTINUATION — the weak side of the sign change.',
    evidence: 'B. VCP and pennants are the only structural detectors with a 0% random-walk rate. '
      + 'The contraction/expansion principle itself has NO lift over noise (76.4% real vs 80.2% '
      + 'random) — stage 2 must reject anything resting on multi-bar NR alone.',
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
      { left: 'Volatility.D', operation: 'less', right: 3 },
      { left: 'Perf.6M', operation: 'greater', right: 0 },
    ],
    refine: (r) => { const o = offHighPct(r); return o != null && o <= 20; },
    rank: (r) => -(r['Volatility.D'] ?? 999),
  },

  {
    key: 'structural_reversal',
    direction: 'reversal',
    name: 'Structural reversal',
    bet: 'An extended name where a reversal STRUCTURE has formed — not merely a low RSI.',
    horizon_side: 'REVERSAL — the side the evidence favours under 21 days.',
    evidence: 'B. Stage 2 accepts only a Wyckoff spring/upthrust (0% on noise), a confirmed '
      + 'double bottom with its Bulkowski base rate, or 2+ indicators diverging in agreement '
      + '(13.5% on noise). A lone divergence is 99% and worth nothing.',
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
      { left: 'RSI', operation: 'in_range', right: [15, 35] },
      { left: 'Perf.Y', operation: 'greater', right: -25 },
    ],
    refine: () => true,
    rank: (r) => r.RSI ?? 999,
  },

  {
    key: 'rs_leadership',
    direction: 'continuation',
    name: 'Relative strength leadership',
    bet: 'Outperforming its market over a quarter and a year at once.',
    horizon_side: 'CONTINUATION',
    evidence: 'B. Stage 2 runs relative_strength vs SPY. The high_warning case — price at a new '
      + 'high while the RS line is not — DEMOTES rather than promotes.',
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 2e9 },
      { left: 'Perf.3M', operation: 'greater', right: 5 },
      { left: 'Perf.Y', operation: 'greater', right: 10 },
      { left: 'RSI', operation: 'in_range', right: [40, 75] },
    ],
    refine: (r) => { const o = offHighPct(r); return o != null && o <= 15; },
    rank: (r) => r['Perf.3M'] ?? -Infinity,
  },
];

/**
 * The VETO — the only screen that reliably improves results.
 *
 * Screens 1-5 find candidates. This removes the ones that cannot work, and it
 * runs LAST, on the survivors. Returns a list of reasons; empty means allowed.
 */
export const VETO_DEFAULTS = {
  min_days_to_earnings: 5,
  max_off_high_pct: 40,
  min_dollar_volume: 10e6,
};

export function veto(row, opts = {}) {
  const o = { ...VETO_DEFAULTS, ...opts };
  const reasons = [];

  const dte = daysToEarnings(row, o.now);
  if (dte != null && dte >= 0 && dte < o.min_days_to_earnings) {
    reasons.push(`earnings in ${dte} day(s) — a scheduled event inside the hold dominates the setup`);
  }

  const off = offHighPct(row);
  if (off != null && off > o.max_off_high_pct) {
    reasons.push(`${off}% below the 52-week high — too broken to call a pullback`);
  }

  const dv = (row.close ?? 0) * (row['average_volume_10d_calc'] ?? 0);
  if (dv < o.min_dollar_volume) {
    reasons.push(`$${(dv / 1e6).toFixed(1)}M daily dollar volume — costs will exceed the edge`);
  }

  return reasons;
}

/** Pairwise Jaccard overlap between screens. PURE — feed it the merged sets. */
export function overlapMatrix(resultsByScreen) {
  const keys = Object.keys(resultsByScreen);
  const sets = Object.fromEntries(keys.map((k) => [k, new Set(resultsByScreen[k].map((r) => r.symbol))]));
  const out = {};
  for (const a of keys) {
    for (const b of keys) {
      if (a >= b) continue;
      const A = sets[a], B = sets[b];
      const inter = [...A].filter((x) => B.has(x)).length;
      const uni = new Set([...A, ...B]).size;
      out[`${a}|${b}`] = uni ? Math.round((inter / uni) * 100) : 0;
    }
  }
  return out;
}

/**
 * Merge every screen's candidates and rank by CONFLUENCE — WITHIN DIRECTION.
 *
 * ── Why not one global confluence ranking ──
 *
 * The first version ranked every name by how many screens it hit, full stop.
 * Measuring the pairwise overlap showed two things that break it:
 *
 *   near_52w_high    x rs_leadership           42% overlap
 *   near_52w_high    x volatility_contraction  35%
 *   volatility_contr x rs_leadership           30%
 *   structural_reversal x EVERYTHING            0%
 *
 * So "confluence 3" among the continuation screens is largely ONE bet counted
 * three times — they select overlapping populations of large, quiet, rising
 * names. Meanwhile structural_reversal overlaps nothing at 0%, and not by
 * accident: it selects RSI 15-35 while the others select 40-75, so the two
 * groups are MUTUALLY EXCLUSIVE BY CONSTRUCTION.
 *
 * Global confluence therefore does the opposite of what it was meant to. It
 * rewards redundancy and it makes a reversal candidate structurally incapable
 * of scoring above 1 — silently deleting the entire reversal side, which is the
 * side the evidence favours under 21 days.
 *
 * The fix: rank by confluence WITHIN a direction group, and give each group its
 * own slots. Confluence still means "more than one screen agrees", but only
 * among screens that could ever have disagreed. The overlap matrix is returned
 * alongside so a confluence of 3 among 35%-overlapping screens is not read as
 * three independent confirmations.
 */
export const DEFAULT_SLOTS = { continuation: 15, reversal: 5 };

export function mergeByConfluence(resultsByScreen, { top = 20, slots = DEFAULT_SLOTS, vetoOpts = {} } = {}) {
  const dirOf = Object.fromEntries(SCREENS.map((s) => [s.key, s.direction]));

  const bySymbol = new Map();
  for (const [key, rows] of Object.entries(resultsByScreen)) {
    for (const r of rows) {
      const cur = bySymbol.get(r.symbol) || { symbol: r.symbol, row: r, screens: [] };
      cur.screens.push(key);
      bySymbol.set(r.symbol, cur);
    }
  }

  const all = [...bySymbol.values()].map((c) => {
    const dirs = [...new Set(c.screens.map((k) => dirOf[k]).filter(Boolean))];
    return {
      ...c,
      confluence: c.screens.length,
      // A name can in principle hit both groups; it is then whichever side has
      // more screens behind it, because a tie between an uptrend continuation
      // and an oversold reversal is not a finding, it is a contradiction.
      direction: dirs.length === 1 ? dirs[0] : (c.screens.filter((k) => dirOf[k] === 'reversal').length
        > c.screens.filter((k) => dirOf[k] === 'continuation').length ? 'reversal' : 'continuation'),
      mixed_direction: dirs.length > 1,
      perf_y: c.row['Perf.Y'] ?? null,
      veto: veto(c.row, vetoOpts),
    };
  });

  const allowed = all.filter((c) => !c.veto.length);
  const vetoed = all.filter((c) => c.veto.length);

  const byGroup = {};
  for (const g of Object.keys(slots)) {
    byGroup[g] = allowed.filter((c) => c.direction === g)
      .sort((a, b) => b.confluence - a.confluence || (b.perf_y ?? -Infinity) - (a.perf_y ?? -Infinity));
  }

  // SCALE THE SLOTS TO `top` FIRST.
  //
  // The slots are expressed for a 20-name list. Asking for fewer and then
  // slicing the concatenation truncates from the end — which is where the
  // reversal names sit, so a smaller `top` silently re-created the erasure the
  // slots exist to prevent. Caught by running with --top 6 and getting six
  // continuation names.
  const slotTotal = Object.values(slots).reduce((a, b) => a + b, 0);
  const scaled = {};
  if (top >= slotTotal) {
    Object.assign(scaled, slots);
  } else {
    let left = top;
    const keys = Object.keys(slots);
    keys.forEach((g, i) => {
      // Every group keeps at least one seat while any remain; the last group
      // takes the remainder so rounding never loses or invents a slot.
      scaled[g] = i === keys.length - 1 ? left : Math.max(1, Math.round((slots[g] / slotTotal) * top));
      if (i < keys.length - 1) left -= scaled[g];
    });
  }

  // Fill each group's slots; if a group underfills, the spare seats go to the
  // other rather than being wasted.
  const picked = [];
  for (const [g, n] of Object.entries(scaled)) picked.push(...byGroup[g].slice(0, Math.max(0, n)));
  if (picked.length < top) {
    const taken = new Set(picked.map((c) => c.symbol));
    const rest = allowed.filter((c) => !taken.has(c.symbol))
      .sort((a, b) => b.confluence - a.confluence || (b.perf_y ?? -Infinity) - (a.perf_y ?? -Infinity));
    picked.push(...rest.slice(0, top - picked.length));
  }

  const overlap = overlapMatrix(resultsByScreen);
  const redundant = Object.entries(overlap).filter(([, v]) => v >= 30).map(([k, v]) => `${k} ${v}%`);

  return {
    candidates: picked.slice(0, top),
    slots_used: scaled,
    by_direction: Object.fromEntries(Object.keys(slots).map((g) => [g, byGroup[g].length])),
    slots,
    considered: all.length,
    vetoed: vetoed.length,
    vetoed_detail: vetoed.map((v) => ({ symbol: v.symbol, screens: v.screens, reasons: v.veto })),
    overlap_pct: overlap,
    overlap_warning: redundant.length
      ? `These screens overlap heavily and their agreement is NOT independent confirmation: ${redundant.join(', ')}.`
      : null,
    // The trial count. Five screens over a four-thousand-name universe is not
    // five tests, and the best-looking name each morning is a selection
    // artefact unless deflated: the best of 200 no-edge strategies scored an
    // annualised Sharpe of 2.19 in tests/validation.test.js.
    trials: Object.values(resultsByScreen).reduce((n, rows) => n + rows.length, 0),
    trial_note: 'Every symbol x screen is a trial. Deflate before treating the top name as a '
      + 'discovery — see rule_select and deflated_sharpe.',
  };
}
