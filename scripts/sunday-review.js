/**
 * Sunday review — a complete, fixed-schema assessment of every ticker TA is
 * suggesting action on, drawn on the chart as it goes.
 *
 * ── What this is ──
 *
 * Two things, in this order:
 *
 *   1. OUR OWN complete assessment of each ticker, one block per analysis type
 *      this repo has a skill for. This is the bulk of the report.
 *   2. A validation of TA's suggestion against that assessment.
 *
 * It is not a TA-validation tool that happens to look at charts. It is a chart
 * assessment that also says whether TA agrees.
 *
 * ── Fixed schema ──
 *
 * SCHEMA_VERSION governs the output. Every ticker carries EVERY block, with
 * nulls where a measurement was unavailable — never a missing key. A consumer
 * (TA) can therefore rely on the shape without defensive parsing, and an
 * absent value is distinguishable from an absent field.
 *
 * ── Drawings ──
 *
 * Everything the report claims about a ticker is drawn on that ticker's chart
 * in the group `sunday-<TICKER>`, so the report and the chart can be read
 * against each other. The prior week's group is cleared first.
 *
 * Run:  node scripts/sunday-review.js [--limit N] [--holdings] [--no-draw]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as ta from '../src/core/ta_decisions.js';
import * as taApi from '../src/core/ta_api.js';
import * as drawing from '../src/core/drawing.js';
import * as S from '../src/core/structure.js';
import * as C from '../src/core/context.js';
import * as P from '../src/core/patterns.js';
import * as M from '../src/core/mtf.js';
import * as R from '../src/core/relative.js';
import * as D from '../src/core/divergence.js';
import * as Z from '../src/core/zones.js';
import * as W from '../src/core/wyckoff.js';
import * as E from '../src/core/elliott.js';
import * as L from '../src/core/liquidity.js';
import * as B from '../src/core/breakout.js';
import * as momentum from '../src/core/momentum.js';
import * as horizon from '../src/core/horizon.js';
import * as stops from '../src/core/stops.js';
import * as vcp from '../src/core/vcp.js';
import * as kernel from '../src/core/kernel.js';
import * as lmw from '../src/core/lmw_patterns.js';
import * as costs from '../src/core/costs.js';
import * as breadth from '../src/core/breadth.js';
import { findChannels } from '../src/core/channels.js';
import { tradePlans } from '../src/core/pattern_trades.js';
import { removeOrphans } from '../src/core/orphans.js';

export const SCHEMA_VERSION = '1.0';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const LIMIT = Number(argVal('--limit', '999'));
// Specific names on demand. TA's actionable list is live and re-orders by
// urgency, so `--limit N` does NOT give a stable set of tickers between runs —
// use this when you want a particular symbol analysed and drawn.
const ONLY = (argVal('--tickers', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const INCLUDE_HOLDINGS = args.includes('--holdings');
const DRAW = !args.includes('--no-draw');
const OUT_DIR = argVal('--out-dir', 'reports');
// Below this, the structural detectors have nothing to work with — swing
// detection alone needs a multiple of its lookback.
const MIN_BARS = 60;

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const log = (...a) => console.log(...a);
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

/** Evidence qualifications attached to TA's own catalyst vocabulary. */
const CATALYST_EVIDENCE = {
  PEAD_DRIFT: { evidence_tier: 'PORTFOLIO_ONLY', note: 'Real in aggregate; largely dissolves at firm level. Good-news decile mean +3.3%, SD 3.8%, 16.1% of quarters drift NEGATIVE (Katz, McCubbins & McMullin 2018).' },
  FROG_IN_PAN: { evidence_tier: 'CROSS_SECTIONAL', note: 'Gradual-diffusion decile result. See breadth: an edge across hundreds of names retains a fraction of its IR on one position.' },
  HURST_TRENDING: { evidence_tier: 'DIRECTLY_TESTABLE', note: 'A persistence claim. stopping_premium measures autocorrelation on these bars.' },
  INSIDER_BUY: { evidence_tier: 'NOT_TECHNICAL', note: 'Fundamental; not visible in OHLCV.' },
  ABOVE_GAMMA_FLIP: { evidence_tier: 'NOT_TECHNICAL', note: 'Options positioning from TA walls; not visible in OHLCV.' },
  BB_INSIDE: { evidence_tier: 'DESCRIPTIVE', note: 'A volatility state, not a direction.' },
  EXCEED_MODEL: { evidence_tier: 'NOT_TECHNICAL', note: "TA's own valuation model; nothing here can confirm it." },
};

/** Load 1D bars, verifying the series identity actually matches. */
async function loadSymbol(ticker) {
  await chart.setSymbol({ symbol: ticker });
  await sleep(350);
  const st = await chart.getState();
  if (String(st.resolution) !== '1D') { await chart.setTimeframe({ timeframe: '1D' }); await sleep(350); }
  const series = await data.getOhlcv({ count: 400, summary: false });
  const bars = S.normalizeBars(series);
  if (!bars.length) throw new Error('no bars returned');

  // NOT EVERY SYMBOL IS A CHART.
  //
  // VIIIX is a NAV-priced institutional fund: 20 bars, open == high == low ==
  // close on every one, volume 0. It crashed the run with "Cannot read
  // properties of undefined (reading 'high')" from somewhere deep in a
  // detector — a cryptic message for a symbol that never had a chart to
  // analyse in the first place.
  //
  // Refusing it up front, with the reason, is both more honest and more useful
  // than a stack trace: a skipped fund is a fact about the instrument, not a
  // failure of the review.
  if (bars.length < MIN_BARS) {
    throw new Error(`only ${bars.length} bars available (need ${MIN_BARS}) — too short to assess`);
  }
  const ranged = bars.filter((b) => b.high > b.low).length;
  if (ranged / bars.length < 0.5) {
    throw new Error(`${bars.length - ranged}/${bars.length} bars have no intraday range `
      + '(open == high == low == close) — NAV-priced fund or a non-traded series, not a chart');
  }
  const got = String(series.symbol || '').replace(/^.*:/, '').toUpperCase();
  const want = String(ticker).replace(/^.*:/, '').toUpperCase();
  if (got !== want) throw new Error(`chart returned ${series.symbol}, expected ${ticker}`);
  return { bars, symbol: series.symbol, resolution: series.resolution };
}

/**
 * The complete assessment. One block per analysis type this repo has a skill
 * for. Every key is always present.
 */
function assess(bars, spy) {
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

/** Our own independent call, before TA is consulted. */
function ourAssessment(a) {
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

/** Validation of TA's suggestion against the assessment above. */
function validateTa(a, ours, { side, taRow }) {
  const cats = String(taRow.catalysts || taRow.signals || '').split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  const catalyst_evidence = cats.map((c) => ({ catalyst: c, ...(CATALYST_EVIDENCE[c] || { evidence_tier: 'UNCLASSIFIED', note: null }) }));

  const supports = [], conflicts = [], contradictions = [];
  const taWantsOut = side === 'exit';

  if (taWantsOut) {
    if (ours.bias === 'BEARISH') supports.push('our independent bias is BEARISH');
    if (a.market_structure?.trend === 'downtrend') supports.push('daily downtrend');
    if (a.momentum?.agreement === 'all short') supports.push('momentum negative on every horizon');
    if (taRow.price != null && taRow.stop != null && taRow.price < taRow.stop) supports.push(`price below TA stop ${r2(taRow.stop, 2)}`);
    if (ours.bias === 'BULLISH') conflicts.push('our independent bias is BULLISH');
    if (a.momentum?.at_new_high) conflicts.push('price is at a new 52-week high');
    if (a.relative_strength?.leadership === 'outperforming') conflicts.push('outperforming SPY');
    if (String(taRow.urgency) === 'CRITICAL' && a.market_structure?.trend === 'uptrend' && a.multi_timeframe?.weekly_trend === 'uptrend') {
      contradictions.push('TA urgency CRITICAL but BOTH daily and weekly structures are uptrends. If the stop was breached while the trend is intact, examine the stop placement rather than the trend.');
    }
  } else {
    if (ours.bias === 'BULLISH') supports.push('our independent bias is BULLISH');
    if (a.momentum?.agreement === 'all long') supports.push('momentum positive on every horizon');
    if (a.market_structure?.trend === 'uptrend') supports.push('daily uptrend');
    if (ours.bias === 'BEARISH') conflicts.push('our independent bias is BEARISH');
    if (a.market_regime?.regime === 'choppy') conflicts.push(`choppy regime (${a.market_regime.efficiency})`);
    if (a.multi_timeframe?.alignment === 'opposed') conflicts.push('timeframes opposed');
    // NOTE: "HIGH conviction into a choppy regime" is deliberately a CONFLICT,
    // not a contradiction. Measured on a full run, 54 of 58 tickers were
    // choppy — a rule that fires on 93% of rows is a market condition, not a
    // per-ticker finding, and promoting it would drown the specific ones.
    // The market-wide share is reported in the header instead.
    if (String(taRow.conviction) === 'HIGH' && a.market_regime?.regime === 'choppy') {
      conflicts.push(`TA conviction HIGH but regime is choppy (efficiency ${a.market_regime.efficiency} against a `
        + `random-walk baseline of ${a.market_regime.random_walk_efficiency})`);
    }
  }
  if (cats.includes('HURST_TRENDING') && a.risk?.stopping_premium_verdict === 'no measurable persistence') {
    contradictions.push('TA cites HURST_TRENDING (a persistence claim) but autocorrelation on these bars shows NO significant persistence at any lag.');
  }
  if (cats.includes('HURST_TRENDING') && a.risk?.stopping_premium_verdict === 'mean-reverting') {
    contradictions.push('TA cites HURST_TRENDING but these bars measure MEAN-REVERTING — the opposite claim.');
  }

  const agreement = contradictions.length ? 'CONTRADICTED'
    : supports.length && !conflicts.length ? 'CONFIRMED'
    : conflicts.length && !supports.length ? 'DISPUTED'
    : supports.length && conflicts.length ? 'MIXED' : 'NO_SIGNAL';

  // TA's own suggestion, echoed back beside the verdict on it.
  //
  // These were absent from the returned object while the schema advertised
  // them, so every one of 51 rows carried ta_action: null while
  // ta_suggestion.action said TRIM. A consumer joining on this field got
  // nothing, silently.
  return {
    ta_side: side,
    ta_action: taRow.action ?? null,
    ta_urgency: taRow.urgency ?? null,
    ta_conviction: taRow.conviction ?? null,
    agreement, supports, conflicts, contradictions, catalyst_evidence,
  };
}

/**
 * Alternating swing pivots inside a pattern's own window.
 *
 * TradingView's native pattern tools take N alternating points and render the
 * shape themselves. Feeding them REAL pivots is the whole point — it is what
 * stops a drawn boundary from floating away from the price, which is exactly
 * how the CQTM wedge ended up with a lower edge at 22.25 on a bar trading ~29.
 */
function windowPivots(bars, fromTime, toTime, want) {
  const s = Math.max(0, bars.findIndex((b) => b.time >= fromTime));
  let e = bars.findIndex((b) => b.time >= toTime);
  if (e < 0) e = bars.length - 1;
  const out = [];
  for (const lb of [3, 2, 1]) {          // loosen until enough pivots are found
    out.length = 0;
    for (let i = Math.max(s, lb); i <= Math.min(e, bars.length - 1 - lb); i++) {
      const w = bars.slice(i - lb, i + lb + 1);
      const isHigh = bars[i].high === Math.max(...w.map((b) => b.high));
      const isLow = bars[i].low === Math.min(...w.map((b) => b.low));
      if (!isHigh && !isLow) continue;
      const kind = isHigh ? 'high' : 'low';
      const price = isHigh ? bars[i].high : bars[i].low;
      const last = out[out.length - 1];
      if (last && last.kind === kind) {   // keep the more extreme of a run
        if (kind === 'high' ? price > last.price : price < last.price) out[out.length - 1] = { time: bars[i].time, price, kind };
        continue;
      }
      out.push({ time: bars[i].time, price, kind });
    }
    if (out.length >= want) break;
  }
  return out.map(({ time, price }) => ({ time, price: r2(price, 4) }));
}

/**
 * Draw a pattern's actual SHAPE.
 *
 * Three families, three geometries:
 *
 *   - trendline patterns (wedges, triangles, broadening, rectangle) — two
 *     boundary lines, reconstructed backwards from the reported slopes
 *   - flags — the pole as a line, the consolidation as a box
 *   - structural (double/triple tops and bottoms, head and shoulders) — the
 *     peaks connected, plus the neckline
 *
 * The completion level is drawn too, but as the *break* level rather than as
 * the pattern.
 */
async function drawPatternGeometry(p, bars, group, put) {
  const m = p.measurements || {};
  const label = `${p.pattern} ${p.status}`;
  const COL = p.direction === 'bearish' ? '#ef5350' : p.direction === 'bullish' ? '#26a69a' : '#42a5f5';
  const idxOf = (t) => { const i = bars.findIndex((b) => b.time >= t); return i < 0 ? bars.length - 1 : i; };

  // ── rectangles: a box, not a triangle ────────────────────────────────────
  //
  // Rectangles reach the trendline branch below because they report
  // resistance_now and support_now like every other two-line pattern — and
  // were being drawn with TradingView's CONVERGING triangle tool, which is the
  // one shape a rectangle is definitionally not. A range gets a box.
  if (/rectangle/.test(p.pattern) && m.resistance_now != null && m.support_now != null) {
    // A typed rectangle carries its bias in its name while its `direction`
    // stays bilateral, so the colour comes from the name here.
    const rectCol = p.pattern.startsWith('bullish') ? '#26a69a'
      : p.pattern.startsWith('bearish') ? '#ef5350' : '#42a5f5';
    await put(() => drawing.drawShape({ shape: 'rectangle',
      point: { price: r2(m.support_now, 4), time: p.from_time },
      point2: { price: r2(m.resistance_now, 4), time: p.to_time },
      overrides: JSON.stringify({ color: rectCol, backgroundColor: 'rgba(66,165,245,0.10)', linewidth: 2 }),
      text: label, group }), `pattern ${p.pattern} range`);
    return;
  }

  // ── trendline family: TradingView's native triangle_pattern tool ─────────
  //
  // Anchored to the REAL alternating pivots inside the window, not to a slope
  // extrapolation. Extrapolating a 0.93%/bar slope backwards over 46 bars put
  // CQTM's lower boundary at 22.25 on a date when price was ~29 — a line that
  // touched nothing. The native tool takes 5 alternating pivots and renders
  // the converging/diverging shape itself.
  if (m.resistance_now != null && m.support_now != null) {
    const pv = windowPivots(bars, p.from_time, p.to_time, 5);
    if (pv.length >= 5) {
      await put(() => drawing.drawShape({ shape: 'triangle_pattern', points: pv.slice(-5),
        overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
        text: label, group }), `pattern ${p.pattern} (triangle_pattern)`);
    } else {
      // Too few pivots to anchor the native tool — say so rather than guessing.
      await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(m.resistance_now, 4) },
        overrides: JSON.stringify({ linecolor: COL, linewidth: 1, linestyle: 2 }),
        text: `${label} — only ${pv.length} pivots, too few to draw`, group }), `pattern ${p.pattern} unanchored`);
    }
    return;
  }

  // ── flags: pole as a line, consolidation as a box ─────────────────────────
  // Pennants share this construction — they are a pole plus a pause — but
  // name the pause `pennant_bars`, so both keys are accepted here.
  const pauseBars = m.flag_bars ?? m.pennant_bars ?? null;
  if (m.pole_pct != null && pauseBars != null) {
    const endIdx = idxOf(p.to_time);
    const flagStartIdx = Math.max(0, endIdx - pauseBars);
    const poleStartIdx = Math.max(0, flagStartIdx - (m.pole_bars || 0));
    const poleStart = p.direction === 'bullish' ? bars[poleStartIdx].low : bars[poleStartIdx].high;
    const poleEnd = p.direction === 'bullish' ? (m.flag_high ?? bars[flagStartIdx].high) : (m.flag_low ?? bars[flagStartIdx].low);
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: r2(poleStart, 4), time: bars[poleStartIdx].time },
      point2: { price: r2(poleEnd, 4), time: bars[flagStartIdx].time },
      overrides: JSON.stringify({ linecolor: COL, linewidth: 3 }),
      text: `${label} pole +${m.pole_pct}%`, group }), `pattern ${p.pattern} pole`);
    if (m.flag_high != null && m.flag_low != null) {
      await put(() => drawing.drawShape({ shape: 'rectangle',
        point: { price: r2(m.flag_low, 4), time: bars[flagStartIdx].time },
        point2: { price: r2(m.flag_high, 4), time: p.to_time },
        overrides: JSON.stringify({ color: COL, backgroundColor: 'rgba(66,165,245,0.12)', linewidth: 1 }),
        text: `${label} — ${pauseBars} bars, ${m.retrace_pct}% retrace`, group }), `pattern ${p.pattern} pause`);
    }
    return;
  }

  // ── structural: connect the peaks, then the neckline ──────────────────────
  const pair = m.peak_1 != null ? [m.peak_1, m.peak_2]
    : m.trough_1 != null && m.trough_2 != null && m.left_shoulder == null ? [m.trough_1, m.trough_2]
    : null;
  if (pair) {
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: r2(pair[0], 4), time: p.from_time }, point2: { price: r2(pair[1], 4), time: p.to_time },
      overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
      text: `${label}`, group }), `pattern ${p.pattern} peaks`);
  }
  // Head and shoulders — TradingView's own 7-point tool, which draws the
  // shoulders, the head and the neckline in the standard visual language.
  if (m.left_shoulder != null && m.head != null && m.right_shoulder != null) {
    const pv = windowPivots(bars, p.from_time, p.to_time, 7);
    if (pv.length >= 7) {
      await put(() => drawing.drawShape({ shape: 'head_and_shoulders', points: pv.slice(-7),
        overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
        text: label, group }), `pattern ${p.pattern} (head_and_shoulders)`);
    }
  }
  // The break level, drawn as what it is rather than as the pattern.
  const neck = m.neckline ?? m.trough ?? m.peak ?? p.completion_level;
  if (neck != null) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(neck, 4) },
      overrides: JSON.stringify({ linecolor: COL, linewidth: 2, linestyle: 2 }),
      text: `${label} — breaks at ${r2(neck, 2)}`, group }), `pattern ${p.pattern} neckline`);
  }
}

/** Draw the report's own findings on the chart, so the two can be read together. */
async function drawFindings(ticker, a, taRow, side, rawPatterns, bars, channel) {
  const group = `sunday-${String(ticker).replace(/^.*:/, '')}`;
  const drawn = { group, shapes: 0, items: [], errors: [], cleared: { tracked: 0, stale: 0 } };

  // CLEAR LAST WEEK BEFORE DRAWING THIS WEEK — in two passes, because one is
  // not enough and the gap is exactly a week wide.
  //
  // clearAll only removes what the registry still tracks. TradingView entity
  // IDs are SESSION-scoped, so by the next Sunday the app has restarted, every
  // ID from the previous run is dead, prune has dropped them, and this call
  // silently removes nothing while the drawings remain. That is how 545 stale
  // shapes accumulated across 45 charts — SNDK carrying the same level set six
  // times over.
  //
  // The second pass matches by TEXT, which survives a restart. It is scoped to
  // `review` signatures so it clears what this script drew and leaves a walls
  // overlay or a ta_draw_decision the user placed deliberately alone — and it
  // never touches a shape whose label we do not generate.
  try {
    const r = await drawing.clearAll({ scope: 'mcp', group });
    drawn.cleared.tracked = r?.removed || 0;
  } catch { /* first run, or nothing tracked */ }
  try {
    const r = await removeOrphans({ dry_run: false, sources: ['review'] });
    drawn.cleared.stale = r?.removed || 0;
  } catch (e) { drawn.errors.push(`clear stale: ${e.message}`); }

  const put = async (fn, label) => {
    try { const r = await fn(); if (r?.success) { drawn.shapes++; drawn.items.push(label); } }
    catch (e) { drawn.errors.push(`${label}: ${e.message}`); }
  };

  // Key levels — the evidence the report quotes.
  for (const l of (a.key_levels.all_supports || []).slice(0, 3)) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.price },
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 1 }),
      text: `S ${l.price} (${l.distance_pct}%)`, group }), `support ${l.price}`);
  }
  for (const l of (a.key_levels.all_resistances || []).slice(-3)) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.price },
      overrides: JSON.stringify({ linecolor: '#ef5350', linewidth: 1 }),
      text: `R ${l.price} (${l.distance_pct}%)`, group }), `resistance ${l.price}`);
  }
  // Zones.
  if (a.supply_demand_zones.nearest_demand) {
    const z = a.supply_demand_zones.nearest_demand;
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: z.bottom },
      overrides: JSON.stringify({ linecolor: '#00897b', linewidth: 1, linestyle: 2 }),
      text: `demand ${z.bottom}-${z.top}`, group }), 'demand zone');
  }
  if (a.supply_demand_zones.nearest_supply) {
    const z = a.supply_demand_zones.nearest_supply;
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: z.top },
      overrides: JSON.stringify({ linecolor: '#c62828', linewidth: 1, linestyle: 2 }),
      text: `supply ${z.bottom}-${z.top}`, group }), 'supply zone');
  }
  // Pattern GEOMETRY, not just the completion level. A wedge is two trendlines;
  // drawing a horizontal line at the neckline tells you where it completes but
  // shows nothing of the shape the report is claiming.
  for (const p of rawPatterns) {
    if (!a.chart_patterns.stable_across_sensitivities.includes(p.pattern)) continue;
    await drawPatternGeometry(p, bars, group, put);
  }

  // The CHANNEL, as two parallel boundaries anchored to real pivots.
  if (channel) {
    const seg = bars.slice(-channel.window);
    const t0 = seg[0].time, t1 = seg[seg.length - 1].time, n = seg.length - 1;
    const col = channel.direction === 'descending' ? '#ef5350' : channel.direction === 'ascending' ? '#26a69a' : '#78909c';
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: channel.upper_start, time: t0 }, point2: { price: r2(channel.slope_used * n + channel.upper_start, 4), time: t1 },
      overrides: JSON.stringify({ linecolor: col, linewidth: 2 }),
      text: `${channel.pattern} upper`, group }), `channel ${channel.direction} upper`);
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: channel.lower_start, time: t0 }, point2: { price: r2(channel.slope_used * n + channel.lower_start, 4), time: t1 },
      overrides: JSON.stringify({ linecolor: col, linewidth: 2 }),
      text: `${channel.pattern} lower`, group }), `channel ${channel.direction} lower`);
  }

  // ENTRY / STOP / TARGET for whichever plan is actually live.
  //
  // Only CONFIRMED patterns get their levels drawn. A forming pattern's entry
  // is a hypothesis, and putting three bright lines on a chart for a shape
  // that has not completed is how a hypothesis starts looking like a plan.
  for (const tp of (a.trade_plans || [])) {
    if (!tp.tradeable_now) continue;
    for (const [side, l] of Object.entries(tp.legs || {})) {
      if (!l || l.entry == null) continue;
      const tag = tp.bilateral ? `${tp.pattern} ${side}` : tp.pattern;
      await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.entry },
        overrides: JSON.stringify({ linecolor: '#ffb300', linewidth: 3 }),
        text: `ENTRY ${side} ${l.entry} — ${tag}`, group }), `entry ${tag}`);
      if (l.stop != null) {
        await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.stop },
          overrides: JSON.stringify({ linecolor: '#d50000', linewidth: 1, linestyle: 2 }),
          text: `STOP ${l.stop} — ${tag}`, group }), `stop ${tag}`);
      }
      if (l.target != null) {
        await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.target },
          overrides: JSON.stringify({ linecolor: '#00c853', linewidth: 1, linestyle: 2 }),
          text: `TARGET ${l.target} (R:R ${l.rr}) — ${tag}`, group }), `target ${tag}`);
      }
    }
  }
  // VCP pivot.
  if (a.volatility_contraction.vcp_qualifies && a.volatility_contraction.pivot) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: a.volatility_contraction.pivot },
      overrides: JSON.stringify({ linecolor: '#7e57c2', linewidth: 2 }),
      text: `VCP pivot ${a.volatility_contraction.pivot}`, group }), 'vcp pivot');
  }
  // TA's own stop, so the report and TA can be compared visually.
  if (taRow.stop != null && Number.isFinite(taRow.stop)) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(taRow.stop, 4) },
      overrides: JSON.stringify({ linecolor: '#ff9800', linewidth: 2, linestyle: 1 }),
      text: `TA stop ${r2(taRow.stop, 2)} (${side})`, group }), 'TA stop');
  }
  return drawn;
}

// ── run ──────────────────────────────────────────────────────────────────────

log(`Sunday review — schema ${SCHEMA_VERSION}`);
const act = await ta.actionable({ limit: 200 });
const exits = (act.exits || []).slice(0, LIMIT);
const entries = (act.entries || []).slice(0, LIMIT);
log(`  ${exits.length} exits, ${entries.length} entries`);

let holdings = [];
if (INCLUDE_HOLDINGS) {
  const pf = await taApi.get('/api/portfolio').catch(() => null);
  const acted = new Set([...exits, ...entries].map((r) => r.ticker));
  holdings = (pf?.data?.positions || [])
    .filter((p) => !acted.has(p.ticker))
    .map((p) => ({ ticker: p.ticker, action: p.status || 'HOLD', urgency: p.exit_urgency || null,
      price: p.current_price, stop: p.stop_price, return_pct: p.pl_percent, signals: p.signals, archetype: p.archetype }));
  log(`  ${holdings.length} additional holdings`);
}

const before = await chart.getState();
const original = before?.symbol || null;

log('  fetching SPY benchmark once...');
let spy = null;
try {
  await chart.setSymbol({ symbol: 'AMEX:SPY' }); await sleep(600);
  spy = S.normalizeBars(await data.getOhlcv({ count: 400, summary: false }));
  log(`  SPY ${spy.length} bars`);
} catch (e) { log(`  SPY unavailable: ${e.message}`); }

let queue = [
  ...exits.map((r) => ({ side: 'exit', taRow: r })),
  ...entries.map((r) => ({ side: 'entry', taRow: r })),
  ...holdings.map((r) => ({ side: 'holding', taRow: r })),
];

// A ticker can appear on more than one TA list — MRVL, DTCR and EUFN each came
// back as an exit AND an entry. Analysing it twice doubles the work and, worse,
// draws the whole finding set onto the chart twice: MRVL carried 23 shapes then
// 22 more. Keep the first occurrence and record the other sides on it, because
// "TA wants both out of and into this name" is itself worth seeing.
{
  const bySymbol = new Map();
  for (const q of queue) {
    const key = String(q.taRow.ticker).replace(/^.*:/, '').toUpperCase();
    const seen = bySymbol.get(key);
    if (!seen) { bySymbol.set(key, q); continue; }
    (seen.also_listed_as ||= []).push({ side: q.side, action: q.taRow.action ?? null, urgency: q.taRow.urgency ?? null });
  }
  const deduped = [...bySymbol.values()];
  const dropped = queue.length - deduped.length;
  if (dropped) log(`  ${dropped} duplicate ticker(s) collapsed — TA listed them on more than one side`);
  queue = deduped;
}
if (ONLY.length) {
  const found = queue.filter((q) => ONLY.includes(String(q.taRow.ticker).replace(/^.*:/, '').toUpperCase()));
  const missing = ONLY.filter((t) => !found.some((q) => String(q.taRow.ticker).replace(/^.*:/, '').toUpperCase() === t));
  // A requested ticker TA has no suggestion for is still worth assessing —
  // our own analysis does not depend on TA having an opinion.
  queue = [...found, ...missing.map((t) => ({ side: 'holding', taRow: { ticker: t, action: 'NONE (not in TA actionable)' } }))];
  log(`  restricted to ${ONLY.join(', ')} — ${found.length} with a TA suggestion, ${missing.length} without`);
}

const tickers = [];
let n = 0;
for (const item of queue) {
  n++;
  const t = item.taRow.ticker;
  process.stdout.write(`  [${n}/${queue.length}] ${t} ... `);
  const row = {
    ticker: String(t).replace(/^.*:/, ''),
    symbol: null, resolution: '1D', bars: null, status: 'failed', error: null,
    side: item.side,
    ta_suggestion: {
      side: item.side,
      action: item.taRow.action ?? item.taRow.status ?? null,
      urgency: item.taRow.urgency ?? null,
      conviction: item.taRow.conviction ?? null,
      score: item.taRow.score ?? null,
      exit_pct: item.taRow.exit_pct ?? null,
      suggested_usd: item.taRow.suggested_usd ?? null,
      ta_price: item.taRow.price ?? null,
      ta_stop: item.taRow.stop ?? null,
      return_pct: item.taRow.return_pct ?? null,
      catalysts: item.taRow.catalysts ?? item.taRow.signals ?? null,
      reason: item.taRow.reason ?? null,
    },
    assessment: null, our_view: null, ta_validation: null, drawings: null,
  };
  try {
    const { bars, symbol, resolution } = await loadSymbol(t);
    const a = assess(bars, spy);
    const ours = ourAssessment(a);
    row.symbol = symbol; row.resolution = resolution; row.bars = bars.length; row.status = 'ok';
    const rawPatterns = a._raw_patterns; delete a._raw_patterns;
    const rawChannel = a._raw_channel; delete a._raw_channel;
    row.assessment = a; row.our_view = ours;
    row.ta_validation = validateTa(a, ours, { side: item.side, taRow: item.taRow });
    if (item.also_listed_as) row.ta_validation.also_listed_as = item.also_listed_as;
    if (DRAW) row.drawings = await drawFindings(t, a, item.taRow, item.side, rawPatterns, bars, rawChannel);
    log(`${ours.bias}/${row.ta_validation.agreement}${row.drawings ? ` (${row.drawings.shapes} drawn)` : ''}`);
  } catch (e) {
    row.error = e.message;
    log(`FAILED (${e.message})`);
  }
  tickers.push(row);
}

if (original) { try { await chart.setSymbol({ symbol: original }); await sleep(500); } catch { /* leave */ } }

const stamp = new Date().toISOString().slice(0, 10);
mkdirSync(OUT_DIR, { recursive: true });
const ok = tickers.filter((t) => t.status === 'ok');
const report = {
  schema_version: SCHEMA_VERSION,
  generated_at: new Date().toISOString(),
  timeframe: '1D',
  benchmark: 'AMEX:SPY',
  drawing_group_pattern: 'sunday-<TICKER>',
  counts: {
    requested: queue.length, analysed: ok.length, failed: tickers.length - ok.length,
    exits: exits.length, entries: entries.length, holdings: holdings.length,
  },
  ta_validation_summary: {
    CONFIRMED: ok.filter((t) => t.ta_validation?.agreement === 'CONFIRMED').length,
    MIXED: ok.filter((t) => t.ta_validation?.agreement === 'MIXED').length,
    DISPUTED: ok.filter((t) => t.ta_validation?.agreement === 'DISPUTED').length,
    CONTRADICTED: ok.filter((t) => t.ta_validation?.agreement === 'CONTRADICTED').length,
    NO_SIGNAL: ok.filter((t) => t.ta_validation?.agreement === 'NO_SIGNAL').length,
  },
  our_bias_summary: {
    BULLISH: ok.filter((t) => t.our_view?.bias === 'BULLISH').length,
    NEUTRAL: ok.filter((t) => t.our_view?.bias === 'NEUTRAL').length,
    BEARISH: ok.filter((t) => t.our_view?.bias === 'BEARISH').length,
  },
  // A market-wide condition belongs here, not repeated on every row.
  market_condition: (() => {
    const regs = ok.map((t) => t.assessment?.market_regime?.regime).filter(Boolean);
    const choppy = regs.filter((r) => r === 'choppy').length;
    const share = regs.length ? choppy / regs.length : null;
    const effs = ok.map((t) => t.assessment?.market_regime?.efficiency).filter((e) => e != null).sort((a, b) => a - b);
    return {
      regime_counts: regs.reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {}),
      choppy_share_pct: share == null ? null : r2(share * 100, 1),
      median_efficiency: effs.length ? effs[Math.floor(effs.length / 2)] : null,
      random_walk_efficiency: ok[0]?.assessment?.market_regime?.random_walk_efficiency ?? null,
      broad_chop: share != null && share >= 0.5,
      note: share != null && share >= 0.5
        ? `${r2(share * 100, 1)}% of names are below the 0.3 efficiency gate. This is a statement about the WEEK'S `
          + 'MARKET, not about the individual names, and it is why "high conviction into chop" is recorded as a '
          + 'conflict rather than a contradiction — a flag that fires on most rows does not discriminate.'
        : null,
    };
  })(),
  tickers,
};
const jsonPath = join(OUT_DIR, `sunday-review-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
log(`\n  ${jsonPath}`);
log(`  analysed ${ok.length}/${queue.length}`);
log(`  TA validation: ${JSON.stringify(report.ta_validation_summary)}`);
log(`  our bias:      ${JSON.stringify(report.our_bias_summary)}`);

// EXIT EXPLICITLY. The CDP connection keeps a socket open, so the process
// finishes all its work, prints this summary and then sits there forever. Run
// by hand that is merely annoying; run by the Sunday scheduler it means the
// task never completes and reports no result despite having done everything.
// clear-orphans.js already does this for the same reason.
process.exit(0);
