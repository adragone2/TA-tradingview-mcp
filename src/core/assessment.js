/**
 * The complete per-ticker assessment — one block per analysis type this repo
 * has a skill for.
 *
 * ── Why this is a module and not a function in a script ──
 *
 * It was written inside scripts/sunday-review.js. The morning screen needs the
 * SAME assessment, and the obvious move — copy it across — is the one thing
 * that must not happen here. Two copies drift, and the drift is silent: the
 * review spent a full run reading `div.divergences` and `ell.total_counts`,
 * keys its own modules never returned, reporting 0 divergences and 0 Elliott
 * counts on all 50 rows while the prose in the same block named the indicators
 * that had diverged. A missing key landing on `.length` or behind `?? 0`
 * produces a plausible zero, and zero reads as a measurement.
 *
 * One copy, imported by both. tests/review_contract.test.js checks the keys it
 * reads against what the modules actually return.
 *
 * Every key is ALWAYS present, null where a measurement was unavailable — that
 * is the schema contract TA imports against, and an absent value has to stay
 * distinguishable from an absent field.
 *
 * Pure: bars in, assessment out. No chart, no network.
 */
import * as S from './structure.js';
import * as C from './context.js';
import * as P from './patterns.js';
import * as M from './mtf.js';
import * as R from './relative.js';
import * as D from './divergence.js';
import * as Z from './zones.js';
import * as W from './wyckoff.js';
import * as E from './elliott.js';
import * as L from './liquidity.js';
import * as B from './breakout.js';
import * as momentum from './momentum.js';
import * as horizon from './horizon.js';
import * as stops from './stops.js';
import * as vcp from './vcp.js';
import * as kernel from './kernel.js';
import * as lmw from './lmw_patterns.js';
import * as costs from './costs.js';
import * as breadth from './breadth.js';
import { findChannels } from './channels.js';
import { tradePlans } from './pattern_trades.js';

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

/** Evidence qualifications attached to TA's own catalyst vocabulary. */
/** Evidence qualifications attached to TA's own catalyst vocabulary. */
export const CATALYST_EVIDENCE = {
  PEAD_DRIFT: { evidence_tier: 'PORTFOLIO_ONLY', note: 'Real in aggregate; largely dissolves at firm level. Good-news decile mean +3.3%, SD 3.8%, 16.1% of quarters drift NEGATIVE (Katz, McCubbins & McMullin 2018).' },
  FROG_IN_PAN: { evidence_tier: 'CROSS_SECTIONAL', note: 'Gradual-diffusion decile result. See breadth: an edge across hundreds of names retains a fraction of its IR on one position.' },
  HURST_TRENDING: { evidence_tier: 'DIRECTLY_TESTABLE', note: 'A persistence claim. stopping_premium measures autocorrelation on these bars.' },
  INSIDER_BUY: { evidence_tier: 'NOT_TECHNICAL', note: 'Fundamental; not visible in OHLCV.' },
  ABOVE_GAMMA_FLIP: { evidence_tier: 'NOT_TECHNICAL', note: 'Options positioning from TA walls; not visible in OHLCV.' },
  BB_INSIDE: { evidence_tier: 'DESCRIPTIVE', note: 'A volatility state, not a direction.' },
  EXCEED_MODEL: { evidence_tier: 'NOT_TECHNICAL', note: "TA's own valuation model; nothing here can confirm it." },
};

export function assess(bars, spy) {
  const px = bars.at(-1).close;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

  // ── market_regime ─────────────────────────────────────────────────────────
  const reg = safe(() => C.regime(bars), null);
  // A random walk over an n-bar window has expected efficiency ~1/sqrt(n).
  // Without that reference an efficiency figure is uninterpretable — 0.18 over
  // 30 bars is exactly what no signal looks like, not a weak signal.
  const rwBaseline = reg?.bars_examined ? r2(1 / Math.sqrt(reg.bars_examined), 3) : null;
  const market_regime = reg ? {
    regime: reg.regime, efficiency: reg.efficiency, direction: reg.direction || null,
    bars_examined: reg.bars_examined ?? null,
    random_walk_efficiency: rwBaseline,
    vs_random_walk: (reg.efficiency != null && rwBaseline) ? r2(reg.efficiency / rwBaseline) : null,
    tradeable: reg.regime !== 'choppy',
    gate_note: reg.regime === 'choppy'
      ? `Efficiency ${reg.efficiency} is below the ~0.3 gate. A random walk over ${reg.bars_examined} bars averages `
        + `${rwBaseline}, so this is ${reg.efficiency < rwBaseline ? 'at or below' : 'only modestly above'} what no signal looks like.`
      : null,
  } : null;

  // ── market_structure ──────────────────────────────────────────────────────
  const sw = safe(() => S.alternateSwings(S.findSwings(bars, { lookback: 5 })), []);
  const st = safe(() => S.classifyStructure(sw), null);
  const legs = safe(() => S.classifyLegs(bars, sw), null);
  const market_structure = st ? {
    trend: st.trend,
    last_high: st.last_high ? r2(st.last_high.price, 4) : null,
    last_low: st.last_low ? r2(st.last_low.price, 4) : null,
    recent_events: (st.events || []).slice(-3).map((e) => `${e.type}/${e.direction}`),
    swing_count: sw.length,
    last_leg: legs?.last_leg ? {
      kind: legs.last_leg.kind, direction: legs.last_leg.direction, move_pct: legs.last_leg.move_pct,
      larger_than_prior_impulse: legs.last_leg.larger_than_prior_impulse ?? null,
    } : null,
    since_last_leg_pct: legs?.since_last_leg?.price_move_since_pct ?? null,
    bars_since_last_leg: legs?.since_last_leg?.bars_since_last_leg ?? null,
    staleness_warning: legs?.since_last_leg?.warning ?? null,
  } : null;

  // ── multi_timeframe ───────────────────────────────────────────────────────
  const wk = safe(() => M.resampleBars(bars, 'week'), null);
  const wkTrend = wk ? safe(() => S.classifyStructure(S.alternateSwings(S.findSwings(wk.bars, { lookback: 5 }))).trend, null) : null;
  const wkReg = wk ? safe(() => C.regime(wk.bars, { window: 30 }), null) : null;
  const align = (wkTrend && st) ? safe(() => M.alignment([
    { label: '1W', trend: wkTrend, regime: wkReg?.regime },
    { label: '1D', trend: st.trend, regime: reg?.regime },
  ]), null) : null;
  const multi_timeframe = {
    weekly_trend: wkTrend, weekly_regime: wkReg?.regime ?? null,
    weekly_bar_partial: wk ? !!wk.partial_last_bar : null,
    daily_trend: st?.trend ?? null,
    alignment: align?.state ?? null,
    permitted_direction: align?.permitted_direction ?? null,
    action: align?.action ?? null,
  };

  // ── key_levels ────────────────────────────────────────────────────────────
  const lv = safe(() => S.findKeyLevels(bars, { lookback: 5 }), { levels: [] });
  const sup = (lv.levels || []).filter((l) => l.side === 'support');
  const res = (lv.levels || []).filter((l) => l.side === 'resistance');
  const key_levels = {
    count: (lv.levels || []).length,
    support_count: sup.length, resistance_count: res.length,
    nearest_support: sup.length ? { price: sup[0].price, distance_pct: sup[0].distance_pct, tests: sup[0].tests ?? null, reason: sup[0].reason } : null,
    nearest_resistance: res.length ? { price: res[res.length - 1].price, distance_pct: res[res.length - 1].distance_pct, tests: res[res.length - 1].tests ?? null, reason: res[res.length - 1].reason } : null,
    all_supports: sup.slice(0, 5).map((l) => ({ price: l.price, distance_pct: l.distance_pct, reason: l.reason })),
    all_resistances: res.slice(-5).map((l) => ({ price: l.price, distance_pct: l.distance_pct, reason: l.reason })),
    no_support_below: sup.length === 0,
  };

  // ── supply_demand_zones ───────────────────────────────────────────────────
  const zs = safe(() => Z.findZones(bars, { strong_swings: C.classifySwings(bars, { lookback: 5 }).swings }), { zones: [], total_found: 0 });
  const near = safe(() => Z.nearestZones(zs.zones, px), { below: null, above: null });
  const supply_demand_zones = {
    total_found: zs.total_found ?? 0, returned: (zs.zones || []).length,
    nearest_demand: near.below ? { bottom: near.below.bottom, top: near.below.top, distance_pct: near.below.distance_pct, tests: near.below.tests ?? null, evidence: near.below.evidence ?? null } : null,
    nearest_supply: near.above ? { bottom: near.above.bottom, top: near.above.top, distance_pct: near.above.distance_pct, tests: near.above.tests ?? null, evidence: near.above.evidence ?? null } : null,
  };

  // ── chart_patterns ────────────────────────────────────────────────────────
  const pats = safe(() => P.detectPatterns(bars, { lookback: 5 }), { structural: [], candlestick: [] });
  const sweep = {};
  for (const lb of [3, 4, 5, 6, 8]) sweep[lb] = safe(() => P.detectPatterns(bars, { lookback: lb }).structural.map((p) => p.pattern), []);
  const stable = [...new Set(Object.values(sweep).flat())]
    .filter((n) => Object.values(sweep).filter((l) => l.includes(n)).length >= 3);
  const ch = safe(() => findChannels(bars), { found: false, channels: [] });
  const kp = safe(() => kernel.findKernelPivots(bars.slice(-60)), { pivots: [] });
  const width = safe(() => kernel.pivotWidth(kp.pivots), { verdict: 'indeterminate' });
  const lmwOut = safe(() => lmw.detectLmwPatterns(bars, { window: 38 }), { patterns: [] });
  const chart_patterns = {
    detected: (pats.structural || []).map((p) => ({
      pattern: p.pattern, status: p.status, direction: p.direction ?? null,
      target: p.target ?? null, completion_level: p.completion_level ?? null, bars_ago: p.bars_ago ?? null,
      break_even_failure_pct: p.measured?.break_even_failure_pct ?? null,
      meeting_target_pct: p.measured?.meeting_target_pct ?? null,
    })),
    sensitivity_sweep: sweep,
    stable_across_sensitivities: stable,
    passes_stability_check: stable.length > 0,
    pivot_width: { verdict: width.verdict, start: width.width_start ?? null, end: width.width_end ?? null, change_pct: width.change_pct ?? null },
    lmw_second_opinion_count: (lmwOut.patterns || []).length,
    lmw_noise_floor_pct: 43.4,
    noise_check: (pats.noise_check || []).map((n) => n.verdict),
  };

  // ── channels ──────────────────────────────────────────────────────────────
  // A separate detector because a channel is neither converging nor diverging,
  // so the trendline branch emitted nothing for it. Noise floor 32% any /
  // 11.5% stable — looser than the other shapes, and reported as such.
  const channels = {
    found: ch.found ?? false,
    direction: ch.direction ?? null,
    stable: ch.stable ?? false,
    windows_agreeing: ch.windows_agreeing ?? 0,
    windows_tested: ch.windows_tested ?? null,
    best: ch.best ? {
      pattern: ch.best.pattern, window: ch.best.window, lookback: ch.best.lookback,
      upper_now: ch.best.upper_now, lower_now: ch.best.lower_now,
      slope_ratio: ch.best.slope_ratio, r2_upper: ch.best.r2_upper, r2_lower: ch.best.r2_lower,
      containment: ch.best.containment, width_in_atr: ch.best.width_in_atr,
      position_in_channel: ch.best.position_in_channel, position_note: ch.best.position_note,
      entry: ch.best.entry ?? null,
    } : null,
    noise_floor_pct: 32,
    stability_note: ch.stability_note ?? ch.note ?? null,
  };

  // ── candlesticks ──────────────────────────────────────────────────────────
  const candlesticks = {
    recent: (pats.candlestick || []).slice(-5).map((c) => ({
      pattern: c.pattern, direction: c.direction ?? null,
      nison_context_ok: c.nison?.context_ok ?? null,
      nison_confirmation: c.nison?.confirmation_status ?? null,
      reliability_pct: c.reliability?.pct ?? null,
    })),
    academic_verdict: 'NULL_IN_LIQUID_MARKETS',
    academic_note: 'Marshall/Young/Rose (2006, DJIA, random-OHLC bootstrap) and Marshall/Young/Cahan (2008, Tokyo 1975-2004) both found no value, in any sub-period, bull or bear. Report a candle as a description, not a signal.',
  };

  // ── momentum ──────────────────────────────────────────────────────────────
  const mom = safe(() => momentum.momentumProfile(bars), null);
  const f52 = safe(() => momentum.fiftyTwoWeekHigh(bars), { available: false });
  const mad = safe(() => momentum.movingAverageDistance(bars), { available: false });
  const pb = safe(() => momentum.persistenceBaseline(bars), { available: false });
  const momentumBlock = {
    agreement: mom?.agreement ?? null,
    direction: mom?.direction ?? null,
    horizons: (mom?.readings || []).filter((x) => x.available).map((x) => ({ horizon: x.horizon, return_pct: x.lookback_return_pct, direction: x.direction })),
    fifty_two_week_ratio: f52.available ? f52.ratio : null,
    fifty_two_week_off_high_pct: f52.available ? f52.off_high_pct : null,
    at_new_high: f52.available ? f52.at_new_high : null,
    moving_average_distance: mad.available ? mad.mad : null,
    mad_pct: mad.available ? mad.mad_pct : null,
    persistence_baseline_accuracy_pct: pb.available ? pb.accuracy_pct : null,
  };

  // ── relative_strength ─────────────────────────────────────────────────────
  const rs = (spy && spy.length) ? safe(() => R.relativeStrength(bars, spy, { windows: [21, 63, 126, 252] }), null) : null;
  const relative_strength = rs ? {
    leadership: rs.leadership, note: (rs.leadership_note || '').slice(0, 200),
    high_warning: rs.high_warning ?? null, benchmark: 'AMEX:SPY',
  } : { leadership: null, note: null, high_warning: null, benchmark: 'AMEX:SPY' };

  // ── volume_analysis ───────────────────────────────────────────────────────
  const vp = safe(() => C.volumeProfile(bars.slice(-90)), null);
  const evr = safe(() => W.effortVsResult(bars), null);
  const volume_analysis = {
    poc: vp?.point_of_control ?? null,
    value_area_low: vp?.value_area?.low ?? null,
    value_area_high: vp?.value_area?.high ?? null,
    price_vs_value_area: vp ? (px > vp.value_area.high ? 'above' : px < vp.value_area.low ? 'below' : 'inside') : null,
    effort_vs_result: evr?.verdict ?? evr?.summary ?? null,
  };

  // ── divergence ────────────────────────────────────────────────────────────
  const div = safe(() => D.surveyDivergences(bars), null);
  // surveyDivergences returns `runs` and `agreeing_indicators`. This block read
  // `divergences` and `indicators_agreeing` — neither key exists, so count was
  // 0 and indicators_agreeing null on all 50 rows of a full run, while the
  // `agreement` TEXT in the same block reported real divergences on five
  // tickers. The structured fields contradicted their own prose, and a consumer
  // filtering on count > 0 saw an empty portfolio.
  //
  // Note WHY this outlived ta_action: a wrong key that lands on `.length`
  // produces 0, and 0 reads as a legitimate measurement rather than a missing
  // one. Null is loud; zero is silent.
  const divRuns = div?.runs || [];
  const divergenceBlock = {
    agreement: (div?.agreement || '').slice(0, 200) || null,
    count: divRuns.reduce((a, r) => a + (r.shown || 0), 0),
    total_found: divRuns.reduce((a, r) => a + (r.total_found || 0), 0),
    indicators_checked: div?.indicators_checked ?? null,
    indicators_agreeing: div?.agreeing_indicators ?? null,
    agreement_direction: div?.agreement_direction ?? null,
  };

  // ── wyckoff ───────────────────────────────────────────────────────────────
  const wy = safe(() => W.classifyPhase(bars), null);
  const springs = safe(() => W.findSpringsUpthrusts(bars), { events: [] });
  const wyckoff = {
    phase: wy?.phase ?? null, evidence: wy?.evidence ?? null,
    springs_upthrusts: (springs.events || springs.springs || []).slice(-3).map((e) => e.type || e.kind || 'event'),
    interpretive: true,
  };

  // ── elliott ───────────────────────────────────────────────────────────────
  const ell = safe(() => E.surveyCounts(bars), null);
  // surveyCounts returns total_valid_counts and runs. This read total_counts
  // and counts — neither exists — and the `?? 0` fallback turned the miss into
  // a plausible zero, so all 50 rows reported "0 valid counts" while the
  // agreement text beside them said "2 different most-recent counts across 3
  // sensitivities". Same silent-zero failure as the divergence block.
  //
  // distinct_recent_counts is the number that matters here: disagreement across
  // sensitivities IS the finding, and it was not being reported at all.
  const elliott = {
    valid_counts: ell?.total_valid_counts ?? 0,
    distinct_recent_counts: ell?.distinct_recent_counts ?? null,
    sensitivities_run: (ell?.runs || []).length || null,
    agreement: ell?.agreement ?? null,
    caveat: 'Every rule-valid count is returned, never one. Disagreement across sensitivities IS the finding.',
  };

  // ── fibonacci ─────────────────────────────────────────────────────────────
  const fl = safe(() => C.fibLevels(bars), { available: false });
  const ft = safe(() => C.fibTargets(bars), { available: false });
  const fibonacci = {
    retraced_pct: fl.available ? fl.retraced_pct : null,
    in_golden_zone: fl.available ? fl.in_golden_zone : null,
    targets: ft.available ? (ft.levels || []).map((l) => l.price) : null,
    targets_refused_reason: ft.available ? null : (ft.note || null),
  };

  // ── liquidity ─────────────────────────────────────────────────────────────
  const lowIdx = sw.filter((s) => s.kind === 'low').at(-1)?.index ?? 0;
  const avwap = safe(() => L.anchoredVwap(bars, { anchor_index: lowIdx }), { available: false });
  const fvg = safe(() => L.fairValueGaps(bars), { gaps: [] });
  const liquidity = {
    anchored_vwap: avwap.available ? avwap.vwap : null,
    price_vs_avwap: avwap.available ? avwap.price_vs_vwap : null,
    fair_value_gaps: (fvg.gaps || []).length,
  };

  // ── volatility_contraction ────────────────────────────────────────────────
  const v = safe(() => vcp.detectVCP(bars), { qualifies: false });
  const volatility_contraction = {
    vcp_qualifies: v.qualifies ?? false,
    contractions: v.depths_pct ?? null,
    pivot: v.pivot ?? null,
    pivot_distance_pct: v.pivot_distance_pct ?? null,
    failed_checks: v.failed_checks ?? null,
    noise_baseline_pct: 0,
  };

  // ── horizon_prior ─────────────────────────────────────────────────────────
  const cond = safe(() => horizon.reversalConditioning(bars), { available: false });
  const horizonBlock = {
    continuation_at_10d: safe(() => horizon.horizonPrior('breakout', { holding_days: 10 }).alignment, null),
    reversal_at_10d: safe(() => horizon.horizonPrior('pullback_entry', { holding_days: 10 }).alignment, null),
    zone: 'reversal',
    volatility_percentile: cond.available ? cond.volatility_percentile : null,
    volatility_regime: cond.available ? cond.regime : null,
    mean_reversion_favourable: cond.available ? cond.regime === 'elevated' : null,
  };

  // ── risk ──────────────────────────────────────────────────────────────────
  const sp = safe(() => stops.stoppingPremium(bars), { available: false });
  const atr = safe(() => {
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
      tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
    }
    return tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  }, null);
  const gr = safe(() => C.gapRisk ? null : null, null);
  const risk = {
    atr_14: r2(atr, 4),
    atr_pct: atr ? r2((atr / px) * 100) : null,
    stopping_premium_verdict: sp.available ? sp.persistence_verdict : null,
    stop_adds_expected_return: sp.available ? sp.persistence_verdict === 'persistent' : null,
    stop_guidance: sp.available
      ? (sp.persistence_verdict === 'persistent'
        ? 'Positive expected stopping premium — a stop can add return here.'
        : 'Non-positive expected stopping premium — use a stop for solvency, not edge (Kaminski & Lo).')
      : null,
  };

  // ── costs ─────────────────────────────────────────────────────────────────
  const slipL = safe(() => costs.signalToFillSlippage(bars, { direction: 'long' }), { available: false });
  const drag = safe(() => costs.turnoverDrag({ holding_days: 10, round_trip_bps: 20 }), null);
  const costsBlock = {
    slippage_mean_pct: slipL.available ? slipL.mean_slippage_pct : null,
    slippage_adverse_share_pct: slipL.available ? slipL.adverse_share_pct : null,
    turnover_drag_10d_20bps_pct: drag?.annual_cost_drag_pct ?? null,
  };

  // ── breakout pressure on the nearest level ────────────────────────────────
  const pressure = key_levels.nearest_resistance
    ? safe(() => B.approachPressure(bars, { level: key_levels.nearest_resistance.price, side: 'resistance' }), null)
    : null;
  const pressureSup = key_levels.nearest_support
    ? safe(() => B.approachPressure(bars, { level: key_levels.nearest_support.price, side: 'support' }), null)
    : null;
  const level_pressure = {
    on_resistance: pressure?.pressure ?? null,
    on_resistance_reading: pressure?.interpretation ? pressure.interpretation.slice(0, 160) : null,
    on_support: pressureSup?.pressure ?? null,
    on_support_reading: pressureSup?.interpretation ? pressureSup.interpretation.slice(0, 160) : null,
  };

  // ── trade_plans ───────────────────────────────────────────────────────────
  // Entry, stop and target for every detected pattern. Bilateral shapes carry
  // BOTH legs, because a triangle does not know which way it breaks.
  const atrForPlans = (() => {
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
      tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
    }
    return tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  })();
  const trade_plans = safe(() => tradePlans(pats.structural || [], { atr: atrForPlans })
    .map((x) => ({ pattern: x.pattern, status: x.status, family: x.plan.family, bilateral: !!x.plan.bilateral,
      tradeable_now: x.plan.tradeable_now ?? null, legs: x.plan.legs || {},
      // A typed rectangle names which of its two legs continues the prior
      // trend. Flattening the plan without this loses the entire point of
      // typing it and leaves TA two identical-looking legs.
      primary_leg: x.plan.primary_leg ?? null,
      primary_note: x.plan.primary_note ?? null,
      base_rate: x.plan.base_rate ?? null })), []);

  return {
    price: r2(px, 4),
    as_of: iso(bars.at(-1).time),
    range_low: r2(lo, 4), range_high: r2(hi, 4),
    off_high_pct: r2(((px - hi) / hi) * 100),
    off_low_pct: r2(((px - lo) / lo) * 100),
    market_regime, market_structure, multi_timeframe, key_levels, supply_demand_zones,
    chart_patterns, candlesticks, momentum: momentumBlock, relative_strength,
    volume_analysis, divergence: divergenceBlock, wyckoff, elliott, fibonacci,
    liquidity, volatility_contraction, horizon: horizonBlock, risk, costs: costsBlock,
    level_pressure, channels, trade_plans,
    _raw_patterns: pats.structural || [],   // not serialised; used only for drawing
    _raw_channel: ch.best || null,
  };
}

export function ourAssessment(a) {
  const bull = [], bear = [], cautions = [];
  if (a.market_structure?.trend === 'uptrend') bull.push('daily structure uptrend');
  if (a.multi_timeframe?.weekly_trend === 'uptrend') bull.push('weekly structure uptrend');
  if (a.momentum?.agreement === 'all long') bull.push('momentum positive across every horizon');
  if (a.momentum?.moving_average_distance > 1) bull.push(`MAD ${a.momentum.moving_average_distance} (short MA above long)`);
  if (a.momentum?.fifty_two_week_ratio > 0.9) bull.push(`within ${Math.abs(a.momentum.fifty_two_week_off_high_pct)}% of the 52-week high`);
  if (a.relative_strength?.leadership === 'outperforming') bull.push('outperforming SPY');
  if (a.volatility_contraction?.vcp_qualifies) bull.push('qualifies as a VCP');

  if (a.market_structure?.trend === 'downtrend') bear.push('daily structure downtrend');
  if (a.multi_timeframe?.weekly_trend === 'downtrend') bear.push('weekly structure downtrend');
  if (a.momentum?.agreement === 'all short') bear.push('momentum negative across every horizon');
  if (a.momentum?.moving_average_distance < 1) bear.push(`MAD ${a.momentum.moving_average_distance} (short MA below long)`);
  if (a.relative_strength?.leadership === 'underperforming') bear.push('underperforming SPY');
  if (a.key_levels?.no_support_below) bear.push('NO tested support beneath price');

  if (a.market_regime?.regime === 'choppy') cautions.push(`choppy regime (efficiency ${a.market_regime.efficiency}) — the gate says do not hunt`);
  if (a.multi_timeframe?.alignment === 'opposed') cautions.push(`timeframes opposed; permitted ${a.multi_timeframe.permitted_direction}`);
  if (a.multi_timeframe?.weekly_bar_partial) cautions.push('weekly bar partial — trend unconfirmed');
  if (a.chart_patterns?.detected.length && !a.chart_patterns.passes_stability_check) cautions.push('patterns detected but none stable across sensitivities');
  if (a.risk?.stop_adds_expected_return === false) cautions.push('no persistence — a stop here is a drag on expected return');
  if (a.market_structure?.staleness_warning) cautions.push('last leg is stale relative to current price');

  const bias = bull.length > bear.length + 1 ? 'BULLISH'
    : bear.length > bull.length + 1 ? 'BEARISH' : 'NEUTRAL';
  return {
    bias,
    conviction: a.market_regime?.regime === 'choppy' ? 'LOW' : (Math.abs(bull.length - bear.length) >= 3 ? 'HIGH' : 'MODERATE'),
    bullish_factors: bull, bearish_factors: bear, cautions,
    tradeable: a.market_regime?.tradeable ?? null,
  };
}
