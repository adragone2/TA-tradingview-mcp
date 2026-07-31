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
 * The screens.
 *
 * `filter` is what TradingView evaluates. `refine` is a client-side predicate
 * for things the scanner cannot express as a filter — a ratio between two
 * returned columns, for instance. `rank` orders that screen's own candidates.
 *
 * Three optional fields, added when the catalogue outgrew the original five:
 *
 *   `columns`  extra columns this screen needs beyond BASE_COLUMNS. A screen that
 *              reads `industry` or `premarket_change` cannot work without them.
 *   `post`     a CROSS-ROW step, run after refine. A per-row predicate cannot
 *              express "keep only the top two of each industry group", because
 *              that needs the whole result set at once.
 *   `session`  'settled' means the screen must NOT run pre-open, because it ranks
 *              on a field that folds the forming day (see scannerTrust).
 *              'premarket' means the opposite — it is built for pre-open and uses
 *              premarket-specific fields.
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
      + '(19.5% on noise). A lone divergence is 99.5% and worth nothing.',
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

  /**
   * BREAKOUT — added because the catalogue pointed `breakout_continuation` at
   * `momentum_pullback`, which cannot surface a breakout by construction.
   *
   * Verified on a live row: a name at RSI 66.8, +17.9% on the month and 1.85%
   * off its high fails THREE of the pullback screen's clauses — RSI outside
   * [35,55], Perf.1M outside [-15,+5], and too CLOSE to the high for the 2-25%
   * band. A pullback screen selects retracements; a breakout screen selects the
   * opposite. Pointing one strategy at the other's screen means it never fires.
   */
  {
    key: 'breakout',
    direction: 'continuation',
    name: 'Breakout at a new high',
    bet: 'Price pushing through overhead supply, where the sellers who bought the old high are cleared out.',
    horizon_side: 'CONTINUATION — the weak side under 21 days. Run horizon_prior.',
    evidence: 'C for the breakout itself: breakout_check has a 32.5% random-walk rate (17.5% passing 3+ checks), so a '
      + 'bare breakout is close to a coin flip. The SUPPLY mechanism is better evidenced — it is George and Hwang 52-week-high '
      + 'reasoning, which Livermore arrived at independently in the 1920s.',
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
      { left: 'Perf.6M', operation: 'greater', right: 0 },
      { left: 'RSI', operation: 'in_range', right: [55, 80] },
    ],
    // AT the high, not retracing from it — the mirror of the pullback band.
    refine: (r) => { const o = offHighPct(r); return o != null && o <= 3; },
    rank: (r) => -(offHighPct(r) ?? 999),
  },

  /**
   * SHORT-TERM REVERSAL — Nagel's liquidity provision, and the ONE documented
   * effect that belongs in the 2-10 day window rather than fighting it.
   *
   * It had no screen: the catalogue pointed it at tier_a_factors, where it is a
   * factor that stays INACTIVE unless VIX is elevated. That gate is correct and
   * it is not a screen. The shape here is his — the biggest short-horizon losers
   * whose long-term trend is still intact.
   */
  {
    key: 'short_term_reversal',
    direction: 'reversal',
    name: 'Short-term reversal (liquidity provision)',
    bet: 'A sharp short-horizon loser whose long-term trend is intact — paid for providing liquidity, not for being cheap.',
    horizon_side: 'REVERSAL — the side the evidence favours under 21 days, and the only screen here on the strong '
      + 'side of the boundary.',
    evidence: 'B. Nagel (2012). CONDITIONAL: it "earns essentially nothing unconditionally" and is only active when '
      + 'VIX is elevated. The runner must apply that gate — this screen cannot see VIX.',
    session: 'settled',
    requires_vix_gate: true,
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 2e9 },
      // BOUNDED on both sides. An unbounded `less than -8` selects the tail, and
      // the tail is collapses rather than dips — the mistake this module's header
      // is written about. The repo's own invariant test caught this.
      { left: 'Perf.1M', operation: 'in_range', right: [-30, -8] },
      { left: 'Perf.Y', operation: 'greater', right: 0 },
      { left: 'RSI', operation: 'in_range', right: [10, 35] },
    ],
    // Bounded on BOTH sides, for the reason the module header gives: a one-sided
    // threshold on a reversal screen selects collapses, not dips.
    refine: (r) => { const o = offHighPct(r); return o != null && o >= 5 && o <= 30; },
    rank: (r) => r['Perf.1M'] ?? Infinity,
  },

  /**
   * GROUP LEADERSHIP — Livermore's Discovery 1 and 2, and the first screen here
   * that needs a CROSS-ROW step.
   *
   * "Trade the leading stocks in the leading groups." rs_leadership finds names
   * strong against the MARKET, which is a different question from being the
   * biggest name in a group that is moving as a group. Answering it needs the
   * whole result set: group by industry, keep groups whose median is positive,
   * then keep each group's top two by market cap.
   */
  {
    key: 'group_leadership',
    direction: 'continuation',
    name: 'Leading stock in a leading group',
    bet: 'The largest name in an industry group that is moving as a group.',
    horizon_side: 'CONTINUATION',
    evidence: 'C. Livermore core, unmeasured here. Note what WAS measured and failed: requiring the SECOND leader to '
      + 'confirm cost 9.3 points of win rate (21.6% vs 30.9%, z -2.57) and discarded 58% of signals. So this screen '
      + 'deliberately does NOT require tandem agreement — it only prefers a leader over a laggard.',
    columns: ['industry', 'description'],
    filter: [
      ...LIQUIDITY_FILTER,
      { left: 'market_cap_basic', operation: 'greater', right: 2e9 },
      { left: 'Perf.6M', operation: 'greater', right: 0 },
      { left: 'RSI', operation: 'in_range', right: [45, 75] },
    ],
    refine: (r) => !!r.industry,
    rank: (r) => r.market_cap_basic ?? -Infinity,
    post: (rows) => {
      const byGroup = new Map();
      for (const r of rows) {
        if (!byGroup.has(r.industry)) byGroup.set(r.industry, []);
        byGroup.get(r.industry).push(r);
      }
      const out = [];
      for (const [, members] of byGroup) {
        const moves = members.map((m) => Number(m['Perf.1M'])).filter(Number.isFinite);
        if (!moves.length) continue;
        const median = [...moves].sort((a, b) => a - b)[Math.floor(moves.length / 2)];
        if (median <= 0) continue;                     // the GROUP must be moving
        out.push(...[...members]
          .sort((a, b) => Number(b.market_cap_basic || 0) - Number(a.market_cap_basic || 0))
          .slice(0, 2));                               // its two leaders
      }
      return out;
    },
    post_note: 'The cross-row step keeps only the top two by market cap inside each group whose MEDIAN member move is '
      + 'positive. A median rather than a mean, so one runaway name cannot make a group look strong. Dual share classes '
      + 'are NOT deduped here — call dedupeShareClasses from groups.js if that matters, because GOOG and GOOGL are one '
      + 'company and treating them as two leaders is a tautology.',
  },

];

/**
 * INTRADAY screens — a SEPARATE list, deliberately not part of SCREENS.
 *
 * SCREENS feed `mergeByConfluence`, which allocates 15 continuation and 5
 * reversal slots into a SWING watchlist. A pre-market gap list is a different
 * product on a different horizon, and putting it in the same merge would hand
 * swing slots to day-trade gappers. It also cannot declare a `direction`,
 * because a gap screen takes both sides at once, and the merge needs one.
 *
 * So the intraday tier gets its own list, run on its own schedule.
 */
export const INTRADAY_SCREENS = [
/**
   * PRE-MARKET GAP — the intraday tier had NO screener at all, which was wrong.
   *
   * The catalogue said "intraday setups are not screened from daily bars". The
   * scanner returns `gap`, `premarket_change` and `premarket_volume`, so a
   * pre-open watchlist is entirely buildable, and it is how day traders build one.
   *
   * The session field matters here: `relative_volume_10d_calc` is UNSAFE pre-open
   * because it folds the forming day, but the premarket_* fields are the RIGHT
   * ones then — they are ABOUT the pre-market rather than a partial day
   * masquerading as a whole one.
   */
  {
    key: 'premarket_gap',
    direction: 'either',
    name: 'Pre-market gap with volume',
    bet: 'A name gapping on real pre-market volume, which is where an intraday range break can start.',
    horizon_side: 'INTRADAY — no academic evidence in this repo either way. Practitioner sources only.',
    evidence: 'C. Every intraday setup in the catalogue rests on practitioner books. What IS measured and relevant: a '
      + 'gap of 5% or more against a trend is the trend-invalidation threshold Shannon states three separate times, and '
      + 'luld_band gives how far a name can travel before it halts — bands DOUBLE between 09:30 and 09:45.',
    session: 'premarket',
    columns: ['gap', 'premarket_change', 'premarket_volume', 'float_shares_outstanding'],
    filter: [
      { left: 'close', operation: 'in_range', right: [2, 500] },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 500000 },
    ],
    // Gap magnitude AND real participation. A gap on no volume is a quote, not a move.
    refine: (r) => {
      const g = Number(r.premarket_change ?? r.gap);
      const v = Number(r.premarket_volume);
      return Number.isFinite(g) && Math.abs(g) >= 2 && Number.isFinite(v) && v >= 50000;
    },
    rank: (r) => Math.abs(Number(r.premarket_change ?? r.gap) || 0),
    session_note: 'Pre-open ONLY, and deliberately so. It ranks on premarket_change and premarket_volume, which describe '
      + 'the pre-market session. It does NOT rank on relative_volume_10d_calc, which scannerTrust marks unsafe pre-open '
      + 'because a partial day carries a fraction of its eventual volume (SPY measured 6.7M against about 45M). Measured '
      + 'mid-session on 2026-07-30: the premarket fields are still POPULATED (500/500 rows carry premarket_change, 431 '
      + 'carry premarket_volume > 0) and 46 rows still pass refine — they are THIS MORNING\'S values, frozen. Present is '
      + 'not fresh, which is exactly why the gate reads the session state and not whether the field is null.',
  },

  /**
   * INTRADAY EXTENSION — because `parabolic_fade` was pointed at the gap screen,
   * and a gapper and an extended name are different populations.
   *
   * This is the same defect the catalogue already carries a note about:
   * `breakout_continuation` pointed at `momentum_pullback`, measured to share ZERO
   * candidates. Here it was worse in one way — `premarket_gap` is pre-open ONLY, so
   * the entire intraday tier could populate for at most two hours a day, and any run
   * outside that window produced an empty INTRADAY section with no explanation.
   *
   * Unlike the other two intraday strategies, `parabolic_fade` needs NO intraday
   * operand. Its own criteria in strategies.json are `price > ema(9) * 1.05` and
   * `rsi(14) > 75` — both of which the scanner serves from daily bars. So this
   * screen is that definition, and nothing more.
   *
   * TWO SUBSTITUTIONS, stated rather than hidden:
   *   - EMA10 for EMA9. The scanner exposes EMA5/10/20/50/100/200 and no EMA9.
   *     EMA10 is the nearest and is slightly slower, so it selects marginally FEWER
   *     names than the strategy's own clause — the conservative direction.
   *   - DAILY RSI. The strategy executes intraday, but every screen here is a coarse
   *     DAILY filter feeding intraday execution. A name extended on the daily is the
   *     population a fade is hunted in; the trigger is still an intraday event that
   *     strategy_check evaluates.
   *
   * No session gate. Nothing here is volume-derived: `close` is a real quote at any
   * hour and the moving averages and RSI are price-only. Pre-open they read
   * yesterday's finished session, which is precisely what a pre-open candidate list
   * should be built from.
   */
  {
    key: 'intraday_extension',
    direction: 'reversal',
    name: 'Extended from the fast average',
    bet: 'A name stretched far enough above its fast moving average that a reversion toward it is the trade.',
    horizon_side: 'INTRADAY — and the sub-21-day REVERSAL side, which is the one direction the horizon '
      + 'evidence actually supports. Nearly every other screen here is a continuation bet placed where '
      + 'continuation is weakest; this one is not.',
    evidence: 'C. Practitioner sources only, like every intraday entry in the catalogue. The clauses are '
      + "parabolic_fade's OWN criteria from strategies.json rather than anything invented here. What is "
      + 'measured and relevant: luld_band, because a parabolic name is the one most likely to halt, and '
      + 'the bands DOUBLE between 09:30-09:45 and 15:35-16:00; and short_interest, because a crowded '
      + 'short is what turns a fade into a squeeze against you.',
    columns: ['EMA10', 'EMA20', 'ATR'],
    filter: [
      ...LIQUIDITY_FILTER,
      // RSI > 75 is parabolic_fade's own threshold. ONE-SIDED on purpose and safe to
      // be: this screen hunts the upper tail, which is the definition of extended.
      { left: 'RSI', operation: 'greater', right: 75 },
    ],
    // price >= EMA(9) * 1.05, with EMA10 standing in. Computed in refine rather than
    // filtered server-side because the scanner cannot compare two of its own columns.
    refine: (r) => {
      const c = Number(r.close);
      const e = Number(r.EMA10);
      return Number.isFinite(c) && Number.isFinite(e) && e > 0 && c >= e * 1.05;
    },
    // Most extended first — the further from the average, the further to revert.
    rank: (r) => (Number(r.close) / Number(r.EMA10)) - 1,
    session_note: 'Runs at ANY hour. Every field it reads is price-only, so none of them is the '
      + 'partial-day volume trap. Pre-open it reads the finished prior session, which is what a '
      + 'pre-open candidate list wants.',
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
/**
 * ── SUPERSEDED. Nothing in the morning routine calls this any more. ──
 *
 * Schema 3.0 does not merge. The merge was the defect: it pooled every screen into
 * these 20 slots and the detectors then ran on the names it had already chosen, so
 * the scanner selected the list and our measurements described it afterwards —
 * the exact inverse of `docs/screening.md`'s "TV scanner as coarse filter, our
 * detectors as verdict". The routine now gates each screen's own top 15 and keeps
 * its top 5 SURVIVORS, per screen, so no strategy family can take the whole list.
 *
 * Kept, with its tests, because the MEASUREMENTS in it are still true and still
 * cited: `structural_reversal` shares 0% with every other screen by construction,
 * and the continuation screens overlap up to 42%, which is why confluence only ever
 * breaks a tie. Deleting the function would delete the evidence for both.
 *
 * Do not wire it back in without re-reading why it was removed.
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
