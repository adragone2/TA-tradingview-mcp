/**
 * THE OWNER'S CYCLE MACHINE — base / accumulation / distribution / declining.
 *
 * Their own four-state cycle, stated 2026-07-31, implemented as data rather than
 * prose so it can be swept, drawn and — when the validation campaign runs —
 * forward-tested. `rules.json`-class authority: these are the owner's criteria,
 * and this file renders them.
 *
 *   BASE          sideways — Bollinger-bandwidth PERCENTILE <= 33.
 *   ACCUMULATION  the ENTRY signal: a buying volume spike (>= 1.5x) AND a
 *                 breakout AND a positive 150-SMA slope.
 *   DISTRIBUTION  the EXIT signal: volume fading (recent mean < 0.8x the
 *                 trailing 120-day mean) AND the 150-SMA flattens.
 *   DECLINING     150-SMA slope negative AND a selling volume spike (>= 1.5x).
 *   back to BASE  volume fading AND the 150-SMA flat AND sideways.
 *
 * ── THIS IS NOT `classifyStage`, AND THE TWO MUST NOT BE MERGED ──
 *
 * `stages.js` holds Shannon's stage: price against three moving averages, read
 * through position, slope and stacking clauses that can disagree. It is FROZEN,
 * it is what `stage_plan` uses, and it was FORWARD-TESTED AS A GATE AND FAILED —
 * triple-barrier over 90 symbols with no lookahead, against a direction-matched
 * baseline on the same bars: long 33.5% vs 36.4%, short 21.2% vs 28.9%, four
 * configurations and none favouring the gate (`STAGE_FORWARD_TEST`).
 *
 * The owner's machine is a DIFFERENT CONSTRUCT. It reads volume and volatility,
 * which Shannon's reads not at all, and it is sequential where his is pointwise.
 * Nothing here sweeps `classifyStage` and nothing here redefines it: it is called
 * ONCE, at the last bar, and reported in its own `shannon_cross_reference` block
 * so the two readings can be compared and never confused. They will often
 * disagree, and the disagreement is information about the chart rather than a
 * fault in either.
 *
 * ── A VOCABULARY CLASH WORTH STATING OUT LOUD ──
 *
 * The owner's ACCUMULATION is the ADVANCE — their entry signal, Weinstein's
 * Stage 2. Wyckoff and Weinstein both use "accumulation" for the BASE that comes
 * before it (Weinstein's Stage 1). So `weinstein_equivalent` is carried on every
 * state, and reading "accumulation" here as "the base" is the one misreading this
 * module can cause.
 *
 * ── WHAT A CYCLE LABEL IS, AND IS NOT ──
 *
 * It is a DESCRIPTION of what price, volume and the 150-day average have already
 * done. It forecasts nothing. The ENTRY signal belongs to the STRATEGY
 * (`weinstein_stage_2` in strategies.json), not to this detector — a detector
 * that emitted trades would be a strategy hiding in a tool, which this repo
 * separates on purpose. `CYCLE_NOISE_BASELINE` carries how often each state and
 * each transition appears on random walks, which is the number that says how much
 * any of it means. Read it before quoting a state.
 *
 * ── EVERY THRESHOLD IS AN OPTION ──
 *
 * The owner's numbers are DEFAULTS, not settled: a validation campaign will sweep
 * them. So nothing is a literal inside a condition. `CYCLE_PARAMS` names every
 * knob, its default, whether it came from the owner / from us / from the house
 * convention, and — for a sweep script — whether changing it invalidates the
 * precomputed columns. See `cycleColumns` + `runCycle` for the split that makes a
 * grid cheap.
 *
 * All pure.
 */
import { classifyStage, STAGES, STAGE_FORWARD_TEST } from './stages.js';
import { resampleBars } from './mtf.js';
// ONE definition of each indicator. `bb_bandwidth_pctile` and `volume_ratio` are
// DSL operands built on these same functions, so a criterion and this machine
// cannot disagree about what they measure.
import { bbBandwidthPercentileSeries, volumeRatioSeries } from './strategy.js';

const r2 = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** UTC calendar day of a bar time, the same form `earningsLinePlan` writes. */
export const isoDay = (unixSeconds) => (Number.isFinite(unixSeconds)
  ? new Date(unixSeconds * 1000).toISOString().slice(0, 10)
  : null);

/* ------------------------------ the states ------------------------------ */

export const UNDETERMINED = 'undetermined';

/**
 * The owner's four states, with the Weinstein numeral each corresponds to.
 *
 * `stage` is the CROSS-REFERENCE numeral, not a second name for the state — it is
 * what a reader of Weinstein would call the same part of the cycle, and it is the
 * only thing in this file that speaks his numbering.
 */
export const CYCLE_STATES = Object.freeze({
  base: {
    state: 'base', stage: 1, weinstein_equivalent: 'stage 1',
    what: 'Sideways. The bands have compressed into the bottom third of their own trailing range.',
    note: 'Weinstein and Wyckoff both call this phase ACCUMULATION. The owner does not — their '
      + '"accumulation" is the advance out of it. Read the name, not the tradition.',
  },
  accumulation: {
    state: 'accumulation', stage: 2, weinstein_equivalent: 'stage 2',
    what: 'The advance. A buying volume spike carried price above the base\'s own high with the 150-day average rising.',
    note: 'THE ENTRY SIGNAL, and it belongs to the strategy rather than to this detector. A state '
      + 'label is a description of bars that have already printed.',
  },
  distribution: {
    state: 'distribution', stage: 3, weinstein_equivalent: 'stage 3',
    what: 'Volume fading while the 150-day average flattens.',
    note: 'THE EXIT SIGNAL. Weinstein: a top forms faster than a bottom, so this state is usually short.',
  },
  declining: {
    state: 'declining', stage: 4, weinstein_equivalent: 'stage 4',
    what: 'The 150-day average sloping down, confirmed by a selling volume spike.',
    note: 'Reachable from accumulation, from distribution, and as an opening state — a chart can be '
      + 'handed to this machine already falling.',
  },
});

export const STATE_NAMES = Object.freeze(Object.keys(CYCLE_STATES));
export const stateStage = (state) => CYCLE_STATES[state]?.stage ?? null;

/* ------------------------------ the knobs ------------------------------- */

/**
 * Every threshold and every window, named, with where the number came from.
 *
 * `source`:
 *   'owner'  the owner's own number (2026-07-31). Defaults, explicitly not settled.
 *   'ours'   an operationalisation they left open. Stated so a sweep can move it.
 *   'house'  an existing convention in this repo, reused rather than reinvented.
 *
 * `affects`:
 *   'columns'     changing it invalidates the precomputed series — `cycleColumns`
 *                 must be re-run. These are the expensive ones.
 *   'thresholds'  a comparison only. `runCycle` re-evaluates in O(bars) over
 *                 columns already computed, which is what makes a grid cheap.
 */
export const CYCLE_PARAMS = Object.freeze({
  bb_length: { value: 20, source: 'ours', affects: 'columns',
    note: 'Standard Bollinger length. The owner said "Bollinger-bandwidth" and left the parameters open.' },
  bb_mult: { value: 2, source: 'ours', affects: 'columns',
    note: 'Standard Bollinger multiple. bandwidth = (upper - lower) / middle = 2 * mult * sd / mid.' },
  pctile_window: { value: 252, source: 'ours', affects: 'columns',
    note: 'Trailing bars the bandwidth is ranked against — one trading year. The owner gave the threshold, not the lookback.' },
  pctile_min_samples: { value: 60, source: 'ours', affects: 'columns',
    note: 'Below this many readings in the window the percentile is NULL rather than a rank over a handful of points.' },
  spike_avg_window: { value: 20, source: 'ours', affects: 'columns',
    note: 'Bars the spike baseline averages. EXCLUDES the current bar — including it lets a spike lift its own baseline.' },
  fade_recent_window: { value: 20, source: 'ours', affects: 'columns',
    note: 'The "recent mean" window in the fade test. The owner gave 0.8x and the 120-day trailing side.' },
  fade_trailing_window: { value: 120, source: 'owner', affects: 'columns',
    note: 'The owner\'s "trailing 120d mean". Inclusive of the recent window, which is the ordinary recent-vs-trailing form.' },
  sma_period: { value: 150, source: 'owner', affects: 'columns',
    note: 'The owner\'s 150-day average — Weinstein\'s 30-week backbone in daily bars.' },
  slope_lookback: { value: 20, source: 'ours', affects: 'columns',
    note: 'Bars back the SMA slope is measured over, expressed as percent per bar. The owner said "slope", not over what.' },

  base_pctile_max: { value: 33, source: 'owner', affects: 'thresholds',
    note: 'The owner\'s "bandwidth PERCENTILE <= 33" — the sideways clause, and the whole BASE state definition.' },
  spike_mult: { value: 1.5, source: 'owner', affects: 'thresholds',
    note: 'The owner\'s ">= 1.5x". BUYING when the bar closes up on the prior close, SELLING when it closes down.' },
  fade_ratio: { value: 0.8, source: 'owner', affects: 'thresholds',
    note: 'The owner\'s "recent mean < 0.8x the trailing mean".' },
  flat_slope_pct: { value: 0.05, source: 'house', affects: 'thresholds',
    note: 'Percent of price per bar. The SAME number patterns.js uses for trendline and neckline flatness '
      + '(necklineSlope flat_slope_pct = 0.05), reused so "flat" means one thing across the repo.' },
  allow_base_to_declining: { value: false, source: 'ours', affects: 'thresholds',
    note: 'THE DEAD END IN THE LITERAL CYCLE, exposed rather than patched. The owner\'s sequence is '
      + 'base -> accumulation -> distribution/declining -> base, so the only way out of BASE is the entry signal. '
      + 'Combined with the hysteresis rule (a bar matching no transition keeps its state), a base that breaks DOWN '
      + 'is never recognised: measured on a constructed fixture, a 200-bar decline with a selling spike out of a '
      + 'base left the machine reading "base" throughout. Their DECLINING clause is written as a STATE definition '
      + '("150-SMA slope negative AND selling volume spike"), not as a transition, which is also why '
      + 'undetermined -> declining is allowed. Default FALSE because the arrow list is theirs and this is not; set '
      + 'true to admit base -> declining on exactly the same clauses.' },
  distribution_requires_sideways: { value: false, source: 'ours', affects: 'thresholds',
    note: 'THE ONE AMBIGUITY IN THE OWNER\'S TEXT, exposed rather than decided silently. They wrote DISTRIBUTION as '
      + '"volume fading AND the 150-SMA flattens (bandwidth percentile <= 33 again)", and the return to BASE as '
      + '"volume fading AND 150-SMA flat AND sideways". Read literally the two clause sets are the same, and only the '
      + 'SEQUENCE separates them. Default false: "flattens" is the SLOPE clause (the operationalisation this repo was '
      + 'given), and the extra sideways requirement is what keeps the return to BASE strictly stronger than the entry '
      + 'to DISTRIBUTION. Set true to read the parenthetical as the definition instead.' },
});

/** Defaults as a flat object, plus any caller overrides. */
export function resolveParams(opts = {}) {
  const out = {};
  for (const [k, v] of Object.entries(CYCLE_PARAMS)) {
    out[k] = Object.prototype.hasOwnProperty.call(opts, k) && opts[k] != null ? opts[k] : v.value;
  }
  return out;
}

/** Which knobs a sweep can move without recomputing columns. Enumerable, for a grid script. */
export const COLUMN_PARAMS = Object.freeze(
  Object.entries(CYCLE_PARAMS).filter(([, v]) => v.affects === 'columns').map(([k]) => k),
);
export const THRESHOLD_PARAMS = Object.freeze(
  Object.entries(CYCLE_PARAMS).filter(([, v]) => v.affects === 'thresholds').map(([k]) => k),
);

/* ----------------------------- the columns ------------------------------ */

/** Rolling mean over the `len` bars ending at i, inclusive. Null before warm-up. */
function rollingMean(values, len) {
  const out = new Array(values.length).fill(null);
  if (len < 1 || values.length < len) return out;
  let sum = 0; let n = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (Number.isFinite(v)) { sum += v; n += 1; }
    if (i >= len) {
      const drop = Number(values[i - len]);
      if (Number.isFinite(drop)) { sum -= drop; n -= 1; }
    }
    if (i >= len - 1 && n === len) out[i] = sum / len;
  }
  return out;
}

/**
 * The EXPENSIVE half, computed ONCE per bar series.
 *
 * Everything here is a NUMBER, never a verdict: `bandwidth_pctile` rather than
 * "sideways", `vol_ratio` rather than "spike", `fade_ratio` rather than "fading".
 * The thresholds are applied in `runCycle`, which is what lets a parameter sweep
 * hold these fixed and re-run only the comparisons. Depends solely on the
 * `affects: 'columns'` knobs.
 */
export function cycleColumns(bars, opts = {}) {
  const p = resolveParams(opts);
  const n = Array.isArray(bars) ? bars.length : 0;
  const closes = new Array(n);
  const volumes = new Array(n);
  for (let i = 0; i < n; i += 1) { closes[i] = Number(bars[i]?.close); volumes[i] = Number(bars[i]?.volume); }

  const bandwidth_pctile = bbBandwidthPercentileSeries(closes, {
    length: p.bb_length, mult: p.bb_mult, window: p.pctile_window, min_samples: p.pctile_min_samples,
  });
  const vol_ratio = volumeRatioSeries(bars, p.spike_avg_window);

  const recent = rollingMean(volumes, p.fade_recent_window);
  const trailing = rollingMean(volumes, p.fade_trailing_window);
  const fade_ratio = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (recent[i] != null && trailing[i] != null && trailing[i] > 0) fade_ratio[i] = recent[i] / trailing[i];
  }

  const sma = rollingMean(closes, p.sma_period);
  /**
   * Slope in PERCENT OF PRICE PER BAR, so the flat threshold means the same thing
   * on a $6 stock and a $600 one, and so it can share patterns.js's number.
   */
  const slope_pct = new Array(n).fill(null);
  for (let i = p.slope_lookback; i < n; i += 1) {
    const now = sma[i]; const back = sma[i - p.slope_lookback];
    if (now == null || back == null || !(Math.abs(back) > 0)) continue;
    slope_pct[i] = ((now - back) / Math.abs(back)) * 100 / p.slope_lookback;
  }

  /**
   * The spike's SIGN convention: a spike is BUYING when the bar closed above the
   * previous close and SELLING when below. An unchanged close is NEITHER — it is
   * a real volume event with no direction, and calling it one would invent the
   * half of the clause the machine actually keys on.
   */
  const closed_up = new Array(n).fill(null);
  for (let i = 1; i < n; i += 1) {
    if (!Number.isFinite(closes[i]) || !Number.isFinite(closes[i - 1])) continue;
    closed_up[i] = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0;
  }

  return {
    bars: n,
    bandwidth_pctile,
    vol_ratio,
    fade_ratio,
    sma,
    slope_pct,
    closed_up,
    params: Object.fromEntries(COLUMN_PARAMS.map((k) => [k, p[k]])),
    note: 'Numbers, not verdicts. Thresholds are applied by runCycle, so a sweep over base_pctile_max / '
      + 'spike_mult / fade_ratio / flat_slope_pct re-runs only the state machine.',
  };
}

/* --------------------------- the state machine --------------------------- */

/**
 * THE TRANSITION TABLE, as data.
 *
 * Read top to bottom within each `from`: the FIRST matching row wins, and the
 * order is load-bearing where two rows can fire on the same bar. Out of
 * ACCUMULATION and DISTRIBUTION, `declining` is checked before the softer exit
 * because "fading and flat" and "falling with a selling spike" are NOT exclusive
 * — a single heavy down bar inside a quiet stretch satisfies both — and a
 * confirmed decline is the more specific statement.
 *
 * `undetermined` is the OPENING state only. It is left as soon as either the BASE
 * state definition (sideways) or the DECLINING definition holds. It is never
 * re-entered: once the machine knows where in the cycle it is, a bar matching
 * nothing keeps the prior state rather than resetting to ignorance.
 *
 * ACCUMULATION and DISTRIBUTION are deliberately NOT reachable from
 * `undetermined`. Both are defined relative to something the machine has to have
 * SEEN: accumulation needs a breakout above the base's own high, and there is no
 * base yet; distribution is an exit from an advance that was never observed.
 */
export const CYCLE_TRANSITIONS = Object.freeze({
  undetermined: [
    { to: 'base', clauses: ['sideways'],
      why: 'the owner\'s BASE state definition — bandwidth percentile at or under the threshold' },
    { to: 'declining', clauses: ['falling', 'sell_spike'],
      why: 'the owner\'s DECLINING definition — a chart can be handed to the machine already falling' },
  ],
  base: [
    { to: 'accumulation', clauses: ['buy_spike', 'breakout', 'rising'],
      why: 'the owner\'s ENTRY signal — a buying spike through the base\'s own high with the 150-SMA rising' },
    // OFF by default. See CYCLE_PARAMS.allow_base_to_declining: without it a base
    // that breaks DOWN is never left, which is what the owner's literal arrow list
    // says and is almost certainly not what they mean.
    { to: 'declining', clauses: ['falling', 'sell_spike'], requires_option: 'allow_base_to_declining',
      why: 'the owner\'s DECLINING definition, applied out of BASE — OPT-IN, because their stated sequence does not include this arrow' },
  ],
  accumulation: [
    { to: 'declining', clauses: ['falling', 'sell_spike'], why: 'the owner\'s DECLINING definition' },
    { to: 'distribution', clauses: ['fading', 'flat'], why: 'the owner\'s EXIT signal — volume fading as the 150-SMA flattens' },
  ],
  distribution: [
    { to: 'declining', clauses: ['falling', 'sell_spike'], why: 'the owner\'s DECLINING definition' },
    { to: 'base', clauses: ['fading', 'flat', 'sideways'], why: 'the owner\'s return to BASE' },
  ],
  declining: [
    { to: 'base', clauses: ['fading', 'flat', 'sideways'], why: 'the owner\'s return to BASE' },
  ],
});

/** Every clause the table can name, evaluated for one bar from the columns. */
function clausesAt(cols, i, p, baseHigh, close) {
  const bw = cols.bandwidth_pctile[i];
  const vr = cols.vol_ratio[i];
  const fr = cols.fade_ratio[i];
  const sl = cols.slope_pct[i];
  const dir = cols.closed_up[i];
  const spike = vr != null && vr >= p.spike_mult;
  return {
    sideways: bw != null && bw <= p.base_pctile_max,
    buy_spike: spike && dir === 1,
    sell_spike: spike && dir === -1,
    fading: fr != null && fr < p.fade_ratio,
    rising: sl != null && sl > 0,
    falling: sl != null && sl < 0,
    flat: sl != null && Math.abs(sl) < p.flat_slope_pct,
    // The base's OWN high, from the machine's own base segment, up to the PREVIOUS
    // bar — a close cannot exceed a high that includes it.
    breakout: baseHigh != null && Number.isFinite(close) && close > baseHigh,
  };
}

/**
 * Run the machine over precomputed columns. CHEAP — O(bars), no indicator work.
 *
 * A bar that takes no transition KEEPS its state. That is the hysteresis: without
 * it a machine defined by instantaneous clauses flaps on every quiet bar, and the
 * owner's states are meant to describe stretches. Such a bar is marked
 * `weakening` when AT LEAST ONE but NOT ALL of the clauses of some allowed exit
 * are satisfied, with `weakening_toward` naming the exit closest to firing — the
 * state is under pressure and has not flipped, which is a different fact from
 * either "holding" or "gone".
 */
export function runCycle(bars, cols, opts = {}) {
  const p = resolveParams(opts);
  const n = Math.min(Array.isArray(bars) ? bars.length : 0, cols?.bars ?? 0);

  const readings = [];
  let state = UNDETERMINED;
  /** Highest high of the CURRENT base segment, up to the PREVIOUS bar. */
  let baseHigh = null;

  for (let i = 0; i < n; i += 1) {
    const close = Number(bars[i]?.close);
    const cl = clausesAt(cols, i, p, baseHigh, close);

    let took = null;
    let weakening = false;
    let weakeningToward = null;
    let bestFrac = 0;

    for (const row of CYCLE_TRANSITIONS[state] || []) {
      // An opt-in row is absent from BOTH the transition and the weakening test
      // when its option is off — a state cannot be "weakening toward" an exit the
      // machine is not allowed to take.
      if (row.requires_option && !p[row.requires_option]) continue;
      // `distribution_requires_sideways` ADDS a clause; it never removes one, so
      // turning it on can only make DISTRIBUTION harder to reach.
      const need = (row.to === 'distribution' && p.distribution_requires_sideways)
        ? [...row.clauses, 'sideways']
        : row.clauses;
      const hit = need.filter((c) => cl[c]).length;
      if (hit === need.length) { took = { ...row, clauses: need }; break; }
      const frac = need.length ? hit / need.length : 0;
      if (hit > 0 && frac > bestFrac) { bestFrac = frac; weakening = true; weakeningToward = row.to; }
    }

    const brokeAbove = took?.to === 'accumulation' ? baseHigh : null;
    if (took) {
      state = took.to;
      weakening = false;
      weakeningToward = null;
      // A new base starts a new high. Reset BEFORE the running max below, so the
      // first bar of a base cannot inherit the previous base's level.
      if (state === 'base') baseHigh = null;
    }

    readings.push({
      index: i,
      time: bars[i]?.time ?? null,
      price: r2(close, 6),
      state,
      ...(weakening ? { weakening: true, weakening_toward: weakeningToward } : {}),
      ...(took ? { entered: true, entered_clauses: took.clauses, entered_why: took.why } : {}),
      ...(brokeAbove != null ? { broke_above: r2(brokeAbove, 4) } : {}),
    });

    /**
     * Advance the base's running high AFTER the bar is classified, so the breakout
     * test at bar i+1 compares against bars up to i. A close cannot exceed a high
     * that includes it, so an inclusive running max would make `breakout`
     * unreachable — the machine would never leave BASE.
     */
    if (state === 'base') {
      const h = Number(bars[i]?.high);
      if (Number.isFinite(h)) baseHigh = baseHigh == null ? h : Math.max(baseHigh, h);
    }
  }

  return { readings, params: p, thresholds: Object.fromEntries(THRESHOLD_PARAMS.map((k) => [k, p[k]])) };
}

/* ------------------------- segments and transitions ---------------------- */

/** Consecutive equal states collapsed into one segment. `undetermined` segments like any other. */
export function segmentsFrom(readings = []) {
  const segments = [];
  for (const r of readings) {
    const last = segments[segments.length - 1];
    if (last && last.state === r.state) {
      last.to_index = r.index;
      last.to_time = r.time;
      last.to_price = r.price;
      last.bars += 1;
      if (r.weakening) last.weakening_bars += 1;
      continue;
    }
    segments.push({
      state: r.state,
      stage: stateStage(r.state),
      weinstein_equivalent: CYCLE_STATES[r.state]?.weinstein_equivalent ?? null,
      from_index: r.index,
      from_time: r.time,
      from_price: r.price,
      to_index: r.index,
      to_time: r.time,
      to_price: r.price,
      bars: 1,
      weakening_bars: r.weakening ? 1 : 0,
      // The base's OWN high that the advance cleared — the machine's own level,
      // not one borrowed from levels_find.
      ...(r.broke_above != null ? { broke_above: r.broke_above } : {}),
      ...(r.entered_clauses ? { entered_clauses: r.entered_clauses, entered_why: r.entered_why } : {}),
    });
  }
  return segments;
}

/**
 * The boundaries between segments.
 *
 * The FIRST segment's start is not a transition and is deliberately not reported
 * as one: nothing was observed before it. Every series opens in `undetermined`,
 * so the first real transition is the one that establishes the cycle.
 */
export function transitionsFrom(segments = []) {
  const out = [];
  for (let i = 1; i < segments.length; i += 1) {
    const to = segments[i];
    const from = segments[i - 1];
    const t = {
      index: to.from_index,
      time: to.from_time,
      price: to.from_price,
      from: from.state,
      to: to.state,
      from_stage: from.stage,
      to_stage: to.stage,
      prior_segment_bars: from.bars,
      ...(to.broke_above != null ? { broke_above: to.broke_above } : {}),
      ...(to.entered_clauses ? { clauses: to.entered_clauses, why: to.entered_why } : {}),
    };
    t.text = transitionText(t);
    out.push(t);
  }
  return out;
}

/* ------------------------------ the labels ------------------------------ */

/**
 * ── THE LABEL GRAMMAR, and why it cannot be confused with a person's own text ──
 *
 * Two formats, both registered in `SIGNATURES_BY_SOURCE.stage` (orphans.js). An
 * unregistered label is not cosmetic: TradingView entity ids are SESSION-scoped,
 * so once the desktop app restarts the registry can no longer prove a shape is
 * ours and the TEXT is the only handle left. A label matching no signature leaks
 * an orphan that can never be cleaned up.
 *
 *   transition  "cycle base>accumulation 2026-05-14"
 *   current     "cycle accumulation since 2026-05-14 (34 bars)"
 *
 * The discrimination is the SHAPE rather than any one token, and both signatures
 * are anchored end to end:
 *
 *   - lowercase `cycle`, then a word from a CLOSED five-word vocabulary;
 *   - a bare `>` with NO spaces around it. People write "base -> accumulation",
 *     "base to accumulation", "Base > Accumulation" — none of them this;
 *   - an ISO date, and then the END of the string. A hand-typed note carries a
 *     word, a price or a ticker somewhere, and the anchors refuse all of them:
 *     "cycle base>accumulation 2026-05-14 watch" does not match, and neither does
 *     "note: cycle base>accumulation 2026-05-14".
 *
 * The two cannot collide with each other: one carries `>` and no " since ", the
 * other the reverse. `undetermined` is admitted on both sides of the arrow even
 * though the machine never transitions INTO it — the vocabulary stays closed
 * either way, and a signature narrower than the emitter is how an orphan becomes
 * permanent.
 */
export const CYCLE_LABEL_GRAMMAR = Object.freeze({
  transition: 'cycle <from>><to> YYYY-MM-DD, each side one of: ' + [UNDETERMINED, ...STATE_NAMES].join(' | '),
  current: 'cycle <state> since YYYY-MM-DD (<n> bar/bars)',
  registered_in: 'src/core/orphans.js — SIGNATURES_BY_SOURCE.stage',
  examples: [
    'cycle base>accumulation 2026-05-14',
    'cycle undetermined>declining 2026-01-09',
    'cycle accumulation since 2026-05-14 (34 bars)',
    'cycle base since 2026-06-02 (1 bar)',
  ],
});

export function transitionText(t) {
  return `cycle ${t?.from ?? UNDETERMINED}>${t?.to ?? UNDETERMINED} ${isoDay(t?.time)}`;
}

export function currentText(c) {
  const n = Number(c?.bars);
  return `cycle ${c?.state ?? UNDETERMINED} since ${isoDay(c?.since)} (${n} bar${n === 1 ? '' : 's'})`;
}

/* ------------------------------- the history ----------------------------- */

/** One series' worth: segments, transitions, the current segment, occupancy. */
function historyOf(bars, opts) {
  const cols = cycleColumns(bars, opts);
  const run = runCycle(bars, cols, opts);
  const segments = segmentsFrom(run.readings);
  const transitions = transitionsFrom(segments);
  const last = segments[segments.length - 1] || null;
  const lastReading = run.readings[run.readings.length - 1] || null;

  const total = run.readings.length;
  const occupancy = {};
  for (const s of [UNDETERMINED, ...STATE_NAMES]) {
    const n = run.readings.filter((r) => r.state === s).length;
    occupancy[s] = { bars: n, pct: total ? r2((n / total) * 100, 1) : null };
  }

  const current = last
    ? {
        state: last.state,
        stage: last.stage,
        weinstein_equivalent: last.weinstein_equivalent,
        since: last.from_time,
        since_date: isoDay(last.from_time),
        since_index: last.from_index,
        bars: last.bars,
        price: last.to_price,
        weakening: !!lastReading?.weakening,
        ...(lastReading?.weakening_toward ? { weakening_toward: lastReading.weakening_toward } : {}),
        what: CYCLE_STATES[last.state]?.what ?? 'The machine has not established a state yet.',
      }
    : null;
  if (current) current.text = currentText(current);

  return {
    bars: Array.isArray(bars) ? bars.length : 0,
    segments,
    transitions,
    current,
    occupancy,
    /**
     * Bars before the machine could establish ANY state. Not an abstention about
     * the cycle — the clauses simply had nothing to fire on yet, usually because
     * the 150-bar average or the bandwidth percentile had not warmed up.
     */
    undetermined_bars: occupancy[UNDETERMINED].bars,
    weakening_bars: run.readings.filter((r) => r.weakening).length,
    /** One-bar segments. Reported, never smoothed — a one-bar state is a real reading. */
    flicker_segments: segments.filter((s) => s.bars === 1).length,
    thresholds: run.thresholds,
    columns_params: cols.params,
  };
}

/**
 * The whole thing: the loaded (TRIGGER) series, the aggregated GATE series, and
 * the Shannon cross-reference.
 *
 * `gate` is 'week', 'month', or a bar multiple — the same argument `stage_plan`
 * takes, passed to the same `resampleBars`, with the partial newest aggregated bar
 * DROPPED exactly as `stage_plan` drops it. A stage read off a bar that has not
 * finished happening is read off a price that has not finished happening.
 *
 * On a weekly gate the owner's own windows are in WEEKS, not days — a 150-period
 * average of weekly bars is ~3 years and will rarely warm up on a chart's history.
 * That is reported as `gate_too_short` rather than returned as an empty finding.
 */
export function stageHistory(bars, { gate = 'week', ...opts } = {}) {
  if (!Array.isArray(bars) || !bars.length) {
    return { available: false, why: 'No bars supplied — there is nothing to classify.' };
  }

  const trigger = historyOf(bars, opts);

  const step = /^\d+$/.test(String(gate)) ? Number(gate) : String(gate);
  const agg = resampleBars(bars, step);
  const gateBars = agg.partial_last_bar ? agg.bars.slice(0, -1) : agg.bars;
  const gateHistory = historyOf(gateBars, opts);

  const p = resolveParams(opts);
  const established = (h) => h.bars - h.undetermined_bars > 0;
  const available = established(trigger) || established(gateHistory);

  /**
   * ── THE CROSS-REFERENCE, NOT A MERGE ──
   *
   * Shannon's stage, read ONCE at the last bar by the frozen `classifyStage`. It
   * is a different construct — three moving averages and no volume — and it is
   * reported beside the cycle so the two can be compared and never conflated. A
   * disagreement is information about the chart, not a fault in either.
   */
  const shannon = classifyStage(bars);
  const shannonStage = shannon.available ? shannon.stage : null;

  return {
    available,
    ...(available ? {} : {
      why: `The machine never established a state. The loaded series has ${bars.length} bar(s) and the aggregated `
        + `gate ${gateBars.length}; the ${p.sma_period}-period average needs ${p.sma_period + p.slope_lookback} and `
        + `the bandwidth percentile needs ${p.bb_length + p.pctile_min_samples - 1}. Too few bars is NOT a verdict `
        + 'about the cycle — no clause was ever evaluable.',
    }),
    ...trigger,
    gate: {
      grouped_by: typeof step === 'number' ? `loaded x${step}` : String(step),
      partial_bar_dropped: !!agg.partial_last_bar,
      ...(agg.partial_warning ? { partial_warning: agg.partial_warning } : {}),
      ...gateHistory,
    },
    ...(established(gateHistory) ? {} : {
      gate_too_short: `The ${gate} gate produced ${gateBars.length} bar(s) and the machine's windows are in BARS OF `
        + `THAT SERIES — a ${p.sma_period}-period average of weekly bars is about ${Math.round(p.sma_period / 52)} `
        + 'years. On a daily chart the cycle is meant to be read on the LOADED series; the gate is carried for '
        + 'comparison and will usually be empty unless a very long history is loaded.',
    }),
    shannon_cross_reference: {
      construct: 'Shannon\'s stage from stages.js — price against three moving averages, via position, slope and '
        + 'stacking clauses. A DIFFERENT machine from the owner\'s: it reads no volume and no volatility, and it is '
        + 'pointwise rather than sequential.',
      available: shannon.available,
      stage: shannonStage,
      stage_name: shannonStage ? STAGES[shannonStage].name : null,
      why: shannon.why ?? shannon.note ?? null,
      cycle_state: trigger.current?.state ?? null,
      cycle_stage: trigger.current?.stage ?? null,
      agrees: shannonStage != null && trigger.current?.stage != null
        ? shannonStage === trigger.current.stage
        : null,
      how_to_read: 'Not swept, and not merged — read once at the last bar. Where the two disagree, that is a fact '
        + 'about the chart: the owner\'s machine can sit in ACCUMULATION on rising volume while Shannon\'s clauses '
        + 'abstain because the averages are crossed. Neither reading corrects the other.',
      forward_tested_negative: 'Shannon\'s stage as a GATE was forward-tested here and made outcomes WORSE — long '
        + '33.5% vs a 36.4% direction-matched baseline, short 21.2% vs 28.9%, four configurations, none favouring it. '
        + 'That measurement is about HIS construct used as an entry filter. It is not a measurement of the owner\'s '
        + 'machine, which is UNTESTED.',
    },
    method: 'The owner\'s four-state cycle, evaluated bar by bar over precomputed columns. cycleColumns computes the '
      + 'numbers (bandwidth percentile, volume ratio, fade ratio, SMA slope) once; runCycle applies the thresholds and '
      + 'walks the transition table. Sequential: a bar matching no transition KEEPS its state, and is flagged '
      + 'weakening when an exit is partly satisfied.',
    descriptive_only: 'A cycle label DESCRIBES what price, volume and the 150-day average have already done. It '
      + 'forecasts nothing, and the ENTRY signal belongs to the strategy (weinstein_stage_2), not to this detector. '
      + 'Read CYCLE_NOISE_BASELINE before quoting a state: every clause here fires on random walks at a measured rate.',
    transition_rules: CYCLE_TRANSITIONS,
    params: CYCLE_PARAMS,
    noise_baseline: CYCLE_NOISE_BASELINE,
    shannon_forward_test: STAGE_FORWARD_TEST,
  };
}

/* ------------------------------ the drawing ------------------------------ */

/**
 * How many transitions may go on the chart at once.
 *
 * Not a measurement — a legibility bound. Everything over it is REPORTED in
 * `skipped`, never dropped silently, and the ones kept are the most RECENT.
 */
export const MAX_TRANSITIONS_DRAWN = 12;

/** Colour per destination state. Grey for undetermined, which must not look like a verdict. */
export const CYCLE_COLORS = Object.freeze({
  base: '#2962FF',            // compression — blue, the drawing module's neutral
  accumulation: '#089981',    // the advance — green
  distribution: '#ff9800',    // the exit warning — amber
  declining: '#F23645',       // red
  undetermined: '#787B86',
});
const colorFor = (state) => CYCLE_COLORS[state] || CYCLE_COLORS.undetermined;

/**
 * Turn a history into the exact shapes to draw. PURE — no chart, no `put`.
 *
 * `series` picks WHICH history to draw and admits only one at a time: two sets of
 * vertical lines through the same bars is overprinting, which this repo has
 * already paid for once.
 *
 * The callout offset is ATR-scaled when an ATR is supplied and falls back to a
 * percentage of price when it is not, saying which it used — a fixed percentage
 * is 0.11 ATR on a median daily chart and 1.21 ATR on a 5-minute one.
 */
export function stageDrawPlan(history, {
  series = 'trigger',
  max_transitions = MAX_TRANSITIONS_DRAWN,
  price = null,
  last_bar_time = null,
  bar_seconds = 86400,
  atr = null,
  callout_bars_left = 8,
  draw_current = true,
} = {}) {
  if (!history || history.available === false) {
    return { shapes: [], drawn: 0, skipped: [], why: history?.why || 'no cycle history to draw' };
  }
  /**
   * Only two names are valid, and an unrecognised one REFUSES rather than falling
   * through to the trigger. A silent fallback would draw the loaded timeframe's
   * boundaries while the caller believed it had asked for the gate's — the same
   * shape of error as reading a chart without checking the symbol it came from.
   */
  if (series !== 'trigger' && series !== 'gate') {
    return { shapes: [], drawn: 0, skipped: [], why: `no "${series}" series in this history — use "trigger" or "gate"` };
  }
  const src = series === 'gate' ? history.gate : history;
  if (!src || !Array.isArray(src.transitions)) {
    return { shapes: [], drawn: 0, skipped: [], why: `the "${series}" series is missing from this history` };
  }

  const all = src.transitions.filter((t) => Number.isFinite(t.time));
  const cut = Math.max(0, all.length - Math.max(0, max_transitions));
  const kept = all.slice(cut);
  const skipped = all.slice(0, cut).map((t) => ({
    text: t.text,
    time: t.time,
    why: `older than the ${max_transitions} most recent transitions — a bound on legibility, not on evidence`,
  }));

  /**
   * A vertical_line takes ONE point and KEEPS its text (probed 2026-07-30), which
   * is what makes it sweepable at all — the multipoint natives lose theirs and are
   * recoverable only through the registry and their group.
   */
  const shapes = kept.map((t) => ({
    kind: 'transition',
    shape: 'vertical_line',
    label: `cycle transition ${t.from}>${t.to}`,
    text: t.text,
    point: { price: r2(t.price ?? price, 4), time: t.time },
    overrides: {
      linecolor: colorFor(t.to), linewidth: 1, linestyle: 2,
      showLabel: true, textcolor: colorFor(t.to), fontsize: 11,
    },
    from: t.from,
    to: t.to,
  }));

  const usable = (v) => Number.isFinite(v) && v > 0;
  const spot = usable(price) ? price : src.current?.price ?? null;
  const offset = usable(atr)
    ? { value: 2 * atr, basis: 'atr', note: '2x ATR above spot — the same volatility scaling the level callouts use.' }
    : { value: usable(spot) ? spot * 0.03 : 0, basis: 'fallback_pct', note: 'No ATR supplied, so the callout sits 3% above spot. A percentage is not a distance a chart can read — pass atr when you have one.' };

  let current = null;
  if (draw_current && src.current && Number.isFinite(last_bar_time) && usable(spot)) {
    current = {
      kind: 'current',
      shape: 'callout',
      label: 'cycle current segment',
      text: src.current.text,
      point: { price: r2(spot, 4), time: last_bar_time },
      point2: {
        price: r2(spot + offset.value, 4),
        time: last_bar_time - callout_bars_left * bar_seconds,
      },
      overrides: {
        color: colorFor(src.current.state), bordercolor: colorFor(src.current.state),
        textcolor: colorFor(src.current.state), backgroundColor: 'rgba(0,0,0,0)',
        fontsize: 11, linewidth: 1, transparency: 100,
      },
      state: src.current.state,
    };
    shapes.push(current);
  }

  return {
    series,
    shapes,
    drawn: shapes.length,
    transitions_available: all.length,
    transitions_drawn: kept.length,
    skipped,
    current,
    ...(draw_current && !current
      ? {
          current_not_drawn: !src.current
            ? 'no current segment — the machine classified nothing'
            : 'the callout needs a last bar time and a positive price; one of them was missing',
        }
      : {}),
    callout_offset: offset,
    max_transitions,
    label_grammar: CYCLE_LABEL_GRAMMAR,
    what_this_is_not: 'Boundaries, not signals. Each line marks the bar on which the owner\'s clauses changed state — '
      + 'volume, volatility and a 150-day average that have already moved. The ENTRY belongs to the strategy, and the '
      + 'machine is UNTESTED at any horizon.',
  };
}

/**
 * Draw a plan. `put` and `drawShape` are INJECTED — the recorder pattern — so the
 * wiring is testable without a chart and the plan above stays completely pure.
 *
 * Deliberately thin: one shape spec, one `drawShape` call, no selecting or
 * formatting of its own. Anything it decided would be a decision the pure planner
 * could not be tested for.
 */
export async function drawStageHistory(plan, group, put, drawShape) {
  const attempted = [];
  for (const s of plan?.shapes || []) {
    attempted.push({ kind: s.kind, shape: s.shape, text: s.text });
    // eslint-disable-next-line no-await-in-loop
    await put(() => drawShape({
      shape: s.shape,
      point: s.point,
      ...(s.point2 ? { point2: s.point2 } : {}),
      overrides: JSON.stringify(s.overrides),
      text: s.text,
      group,
    }), s.label);
  }
  return { attempted, count: attempted.length };
}

/* ------------------------------ the noise floor -------------------------- */

/**
 * How often does the owner's machine fire on a random walk?
 * `node scripts/stage-cycle-noise.js` re-measures.
 *
 * ── WHY THE VOLUME MODE IS PART OF THE ANSWER ──
 *
 * The machine reads VOLUME, and the plain harness (`barsFromPath`) emits
 * near-constant volume: 1000 + a uniform draw under 500. A spike clause of
 * "1.5x the 20-bar average" can essentially never fire on that, and a fade clause
 * of "recent < 0.8x trailing" can never fire either — so a floor measured against
 * it would report 0% for every volume-gated state and the number would be about
 * the GENERATOR, not the detector. That is the ignition.js failure exactly: the
 * null moved the gate instead of the pattern.
 *
 * So the floor is measured with `randomWalkWithGaps`, whose `volume_mode` is
 * exposed for this reason, and ALL THREE modes are reported. Read the one that
 * matches the clause you are quoting.
 */
export const CYCLE_NOISE_BASELINE = Object.freeze({
  status: 'MEASURED',
  walks: 200,
  bars: 600,
  generator: 'randomWalkWithGaps (gap_rate 0.06, gap_median_atr 0.35) at the machine\'s DEFAULT parameters.',

  /**
   * THE HEADLINE, and it is not comfortable: the ENTRY signal fires on roughly
   * half of pure noise. Quote this beside any ACCUMULATION reading.
   */
  entry_signal_walks_reaching_pct: { lognormal: 43.0, gap_elevated: 52.5, flat: 0 },

  by_volume_mode: Object.freeze({
    flat: {
      note: 'DEGENERATE, and reported so the degeneracy is visible rather than merely asserted. The plain harness '
        + 'emits near-constant volume, so buy_spike, sell_spike and fading fire on 0% of bars — and every state whose '
        + 'entry needs one is unreachable BY CONSTRUCTION. A floor read off this arm would be a number about the '
        + 'generator, which is the ignition.js failure. Do not quote it for any volume-gated clause.',
      occupancy_pct: { undetermined: 15.2, base: 84.8, accumulation: 0, distribution: 0, declining: 0 },
      walks_reaching_pct: { base: 100, accumulation: 0, distribution: 0, declining: 0 },
      transitions_per_walk: 1.0,
      clause_fire_pct: { sideways: 29.9, buy_spike: 0, sell_spike: 0, fading: 0, rising: 35.4, falling: 38.9, flat: 36.3 },
    },
    lognormal: {
      note: 'Dispersed volume, gap bars NOT elevated. The conservative arm for a spike clause.',
      occupancy_pct: { undetermined: 15.2, base: 65.3, accumulation: 11.8, distribution: 0.1, declining: 7.6 },
      walks_reaching_pct: { base: 99.5, accumulation: 43.0, distribution: 1.5, declining: 26.5 },
      transitions_per_walk: 1.72,
      transition_counts: { 'undetermined>base': 199, 'base>accumulation': 86, 'accumulation>declining': 50, 'accumulation>distribution': 3, 'distribution>declining': 2, 'declining>base': 2, 'undetermined>declining': 1 },
      clause_fire_pct: { sideways: 29.9, buy_spike: 4.9, sell_spike: 4.9, fading: 0.2, rising: 35.4, falling: 38.9, flat: 36.3 },
    },
    gap_elevated: {
      note: 'Dispersed volume with gap bars multiplied — the generator default, and the arm with the most spikes.',
      occupancy_pct: { undetermined: 15.2, base: 61.2, accumulation: 14.9, distribution: 0.3, declining: 8.5 },
      walks_reaching_pct: { base: 99.5, accumulation: 52.5, distribution: 3.5, declining: 33.0 },
      transitions_per_walk: 1.98,
      transition_counts: { 'undetermined>base': 199, 'base>accumulation': 110, 'accumulation>declining': 63, 'declining>base': 10, 'accumulation>distribution': 7, 'distribution>base': 4, 'distribution>declining': 2, 'undetermined>declining': 1 },
      clause_fire_pct: { sideways: 29.9, buy_spike: 5.6, sell_spike: 5.6, fading: 0.5, rising: 35.4, falling: 38.9, flat: 36.3 },
    },
  }),

  verdict:
    'ACCUMULATION — the owner\'s ENTRY signal — is reached by 43.0% of random walks on dispersed volume and 52.5% '
    + 'with gap bars elevated. That is a HIGH floor: it is not in the class of springs/upthrusts, VCP or pennants '
    + '(0%), it is nearer breakouts of a prior high (32.5%) and worse. A cycle reading ACCUMULATION is therefore a '
    + 'DESCRIPTION of what volume and the 150-day average have done, and on its own it is close to a coin flip. '
    + 'DISTRIBUTION is the opposite case at 1.5-3.5% of walks — not because it is selective about structure, but '
    + 'because its `fading` clause fires on only 0.2-0.5% of noise bars: a random walk\'s volume has no persistent '
    + 'drift, so a 20-bar mean rarely sits below 0.8x a 120-bar one. A near-zero floor earned by a clause that '
    + 'almost never fires is not the same finding as a near-zero floor earned by selectivity, and the two must not '
    + 'be quoted the same way.',

  what_the_occupancy_does_not_mean:
    'BASE occupies 61-85% of bars while its own `sideways` clause fires on only 29.9% of them. The gap is the '
    + 'HYSTERESIS plus the dead end: a bar matching no transition keeps its state, and under the owner\'s literal '
    + 'arrow list the only exit from BASE is the entry signal (see CYCLE_PARAMS.allow_base_to_declining). So BASE '
    + 'occupancy measures how long the machine STAYS somewhere, not how often the chart is actually sideways.',

  caveats: [
    'Measured at the DEFAULT parameters only. Every threshold is a knob and the owner has said they are not settled; '
      + 're-run this for any configuration a sweep favours, because a floor is a property of the parameters as much '
      + 'as of the machine.',
    'This is an OCCURRENCE floor — how often the machine fires on noise. It says nothing about whether a state '
      + 'predicts anything, which needs a forward test with a direction-matched baseline (scripts/stage-forward-test.js '
      + 'is the template). The machine is UNTESTED in that sense.',
    'randomWalkWithGaps\' gap and volume parameters are stated assumptions about real markets, not measurements from '
      + 'them. Re-estimate from real bars before treating any of these numbers as tight.',
  ],
  script: 'scripts/stage-cycle-noise.js',
});
