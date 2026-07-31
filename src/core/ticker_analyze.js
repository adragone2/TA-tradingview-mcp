/**
 * The whole ticker analysis in ONE call, scored against the contract.
 *
 * Twenty-nine tools in order is a workflow only if something makes it happen.
 * Described in a skill it is a checklist, and a checklist depends on being read and
 * not skipped — which is how the first live run shipped with no pattern detection,
 * no forward entry price, and drawings stacked on stale shapes.
 *
 * ── This module is an ORCHESTRATOR. It must not re-implement anything. ──
 *
 * The first version of this file did exactly that, and it was the mistake
 * `assessment.js` opens by warning against:
 *
 *   "The morning screen needs the SAME assessment, and the obvious move — copy it
 *    across — is the one thing that must not happen here. Two copies drift, and
 *    the drift is silent."
 *
 * It hand-rolled structure, levels, patterns, momentum, divergence, VCP and the
 * horizon prior beside `assess()`, which already returns THIRTY blocks — including
 * multi_timeframe, supply_demand_zones, wyckoff, elliott, fibonacci, liquidity,
 * costs, channels and trade_plans, every one of which the copy silently dropped.
 * It also drew a lone horizontal line per pattern instead of calling
 * `drawFindings`, which renders the actual geometry: channel boundaries, wedge and
 * triangle edges anchored to real pivots, flag poles, head-and-shoulders. The owner
 * noticed the drawings had degraded before any code review did.
 *
 * So: `assess()` measures, `ourAssessment()` judges, `drawFindings()` draws. What
 * is genuinely new here is the SCORING — anything that did not run comes back in
 * `completeness.missing` with a reason, so an incomplete analysis cannot read as a
 * complete one.
 */
import * as data from './data.js';
import * as chart from './chart.js';
import { normalizeBars, findSwings, alternateSwings, completeSeries } from './structure.js';
import { assess, ourAssessment } from './assessment.js';
import { drawFindings } from './assessment_draw.js';
import { entryHypothesis } from './entry_hypothesis.js';
import { atrFromBars, selectPrimary } from './level_display.js';
import { scoreAnalysis } from './analysis_contract.js';
import { barWindowNote, horizonApplies, timeframeFor } from './timeframe_policy.js';
// Everything the workflow used to declare and skip. All of it runs now.
import * as stops from './stops.js';
import * as breadth from './breadth.js';
import * as stages from './stages.js';
// Imported as `tf`: a local `const timeframe` (the chart resolution) would shadow it,
// and the shadow reads as "not a function" rather than as a name collision.
import * as tf from './timeframe.js';
import * as costs from './costs.js';
import { scoreBreakout } from './breakout.js';
import { levelTestStudy } from './level_tests.js';
import * as portfolio from './portfolio.js';
import * as finra from './finra.js';
import { sizeWithConstraints } from './risk.js';
import { accountSettings } from './rules.js';
import { screenCheck, requiredColumns } from './screen_check.js';
import { scan } from './scanner.js';
import { scannerTrust } from './session.js';
import { fetchGroupRows, groupMembers, groupLeaders, laggards } from './groups.js';
import * as ta from './ta_api.js';
import { loadWalls } from './ta_walls.js';

/** Run one section, never letting its failure take down the rest. */
async function section(results, key, fn) {
  try {
    const value = await fn();
    results[key] = { ok: true, value };
    return value;
  } catch (err) {
    /**
     * `err.notApplicable` marks a definite negative ANSWER, not a breakdown — the
     * symbol is outside the scanned universe, the prior does not apply at this
     * resolution. The score counts those as neither a pass nor a failure.
     *
     * It has to be set deliberately on the error. Anything that merely throws is a
     * failure, so this cannot become a way to quietly silence a required section.
     */
    results[key] = err.notApplicable
      ? { ok: false, not_applicable: true, reason: err.message }
      : { ok: false, error: err.message };
    return null;
  }
}

/**
 * @param {object} [shared] Pre-fetched data, for batch callers.
 *
 * The morning routine runs this over ~30 symbols. Without `shared` each one would
 * repeat the same two 2000-row scanner round trips — 60 scans for data that is
 * identical across the whole batch — and reload bars the caller already has. The
 * single-symbol path is unchanged: omit `shared` and everything is fetched here.
 */
export async function analyzeTicker({
  count = 300, lookback = 5, holding_days = 10, days_to_catalyst = null,
  // Execution tier ('intraday' | 'weekly' | 'monthly'), for the entry
  // hypothesis's execution-window annotation (P3.5). Null means unknown, and
  // unknown carries no annotation — never a guessed one.
  tier = null,
  draw = true, shared = null, clear_scope = 'all',
  /**
   * TA's own row for this symbol, and the drawing group. BOTH exist for the Sunday
   * review, and both are the kind of term a unification silently drops.
   *
   * `ta_row` carries TA's stop, which `drawFindings` renders as its own line so the
   * report and TA can be read against each other. This function passed `null` — fine
   * for a standalone analysis, which has no portfolio row, and a silent regression
   * the moment a caller that HAS one adopts this function.
   *
   * `draw_group` matters because `clear_scope: 'mcp'` clears the named group. The
   * Sunday run has drawn into `sunday-<TICKER>` for months; switching it to this
   * function's default `analysis-<SYMBOL>` would leave every previous week's shapes
   * uncleared, tracked, and invisible to the group clear that was supposed to remove
   * them.
   */
  ta_row = null, draw_group = null,
  /**
   * CREATE REAL PRICE ALERTS at the confirmed patterns' completion levels. OFF by
   * default and it stays off unless a human passes `true` in this call.
   *
   * **Created alerts are permanent until manually deleted.** They are made on the
   * live TradingView account, they fire and notify, and nothing in this toolchain
   * sweeps them — `draw_clear` and the orphan sweep are drawing machinery. Find
   * them again with `alert_list` (every message this creates starts with `[MCP]`)
   * and remove them with `alert_delete`.
   *
   * Only confirmed, fresh (not age-excluded), verdict-side patterns whose
   * completion level is on the correct side of spot are eligible, deduped against
   * the alerts already on the account and capped at three per run. `alert_plan.js`
   * owns the rules; everything refused is reported in `drawings.alerts.skipped`.
   *
   * The scheduled scripts do not pass it, and a test asserts they never mention
   * it: an opt-in that an unattended job can set is not opt-in.
   */
  auto_alerts = false,
} = {}) {
  const results = {};

  const raw = shared?.series || await data.getOhlcv({ count, summary: false });
  const bars = shared?.bars || normalizeBars(raw);
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  const symbol = raw?.symbol ?? null;
  const timeframe = raw?.resolution ?? null;
  const timeframe_label = timeframe || '1D';
  const price = bars.at(-1).close;
  const atr = atrFromBars(bars, 14);

  const bare = String(symbol || '').split(':').pop().toUpperCase();

  /**
   * WHAT THIS RESOLUTION DOES TO THE LABELS.
   *
   * `assess()` measures fixed BAR COUNTS — 252/126/63/21, captioned 12m/6m/3m/1m —
   * and `horizon_prior` is a statement about ~21 TRADING DAYS. Run on 5-minute bars
   * every number stays arithmetically correct and every calendar label on it becomes
   * false: 252 five-minute bars is 3.2 sessions, not twelve months.
   *
   * This repo already has the rule ("pin the timeframe, or the measurement is of
   * something else") and the scar: three scripts inherited a 60-minute chart and
   * recorded their results as daily, with nothing in the output revealing it.
   */
  const tf_calibration = barWindowNote(timeframe_label);
  const horizon_validity = horizonApplies(timeframe_label);

  /**
   * The benchmark, WITHOUT which relative strength returns nothing.
   *
   * `assess(bars, spy)` takes a second argument, and this called it with `null` —
   * so `relative_strength.leadership` came back null on every unified analysis,
   * `ourAssessment` never saw "outperforming SPY" as a factor, and the contract
   * scored the section OK because the block object exists with null fields inside
   * it. CLAUDE.md calls relative_strength "the only tool that answers compared to
   * what", and it was answering nothing.
   *
   * Fetching it costs one symbol switch and a switch back. Done HERE, before any
   * drawing, so the chart is on the analysed symbol by the time drawFindings runs.
   * A batch caller passes `shared.benchmark_bars` and pays nothing.
   */
  const benchmark = await section(results, 'benchmark', async () => {
    if (shared?.benchmark_bars) return { bars: shared.benchmark_bars, symbol: shared.benchmark_symbol || 'AMEX:SPY', reused: true };
    if (!symbol) throw new Error('the chart did not report a symbol, so it cannot be restored after the switch');
    await chart.setSymbol({ symbol: 'AMEX:SPY' });
    await new Promise((r) => setTimeout(r, 600));
    // Trimmed the same way the symbol's own bars are: a partial SPY bar against
    // complete symbol bars tilts every reading in the same direction.
    const b = completeSeries(await data.getOhlcv({ count, summary: false })).bars;
    await chart.setSymbol({ symbol });
    await new Promise((r) => setTimeout(r, 600));
    if (!b?.length) throw new Error('SPY returned no bars');
    return { bars: b, symbol: 'AMEX:SPY', reused: false };
  });

  // ── the one assessment, shared with the morning screen and the Sunday review ──
  const a = await section(results, 'assessment', async () => assess(bars, benchmark?.bars || null));
  if (!a) {
    return {
      symbol,
      timeframe,
      price,
      bars: bars.length,
      completeness: scoreAnalysis(results),
      error: 'assess() failed — every downstream section depends on it.',
      sections: results,
    };
  }

  /**
   * The contract's section keys map onto assess()'s blocks. EVERY block it produces
   * is scored — not just the handful the first version checked. A block that comes
   * back null is a measurement that did not happen, and unscored it would read as a
   * measurement that found nothing.
   */
  for (const [key, block] of [
    ['market_regime', a.market_regime], ['structure', a.market_structure], ['levels', a.key_levels],
    ['patterns', a.chart_patterns], ['momentum', a.momentum], ['trade_plans', a.trade_plans],
    ['legs', a.market_structure?.last_leg],
    ['multi_timeframe', a.multi_timeframe], ['volatility', a.volatility_contraction],
    ['vcp', a.volatility_contraction], ['divergence', a.divergence], ['zones', a.supply_demand_zones],
    ['wyckoff', a.wyckoff], ['elliott', a.elliott], ['fibonacci', a.fibonacci],
    ['liquidity', a.liquidity], ['gaps', a.gaps], ['candlesticks', a.candlesticks], ['volume_analysis', a.volume_analysis],
    ['level_pressure', a.level_pressure], ['channels', a.channels], ['costs', a.costs],
    ['risk', a.risk],
  ]) results[key] = block ? { ok: true } : { ok: false, error: 'assess() returned null for this block' };

  /**
   * The horizon prior is measured in TRADING DAYS. Off daily bars it does not
   * describe the position at all, and reporting it would attach daily-horizon
   * evidence to a trade closed before the session ends. NOT APPLICABLE is the
   * honest reading, and it is not the same as neutral.
   */
  results.horizon = horizon_validity.applies
    ? (a.horizon ? { ok: true } : { ok: false, error: 'assess() returned null for this block' })
    : { ok: false, not_applicable: true, reason: horizon_validity.why };

  /**
   * Scored on its CONTENT, not on the block existing.
   *
   * With no benchmark `assess` still returns `{ leadership: null, benchmark: 'AMEX:SPY' }`
   * — an object, so the loop above marked it OK for every analysis that had no SPY.
   * A section that reports "ran fine" while measuring nothing is the exact failure
   * the completeness score exists to catch.
   */
  results.relative_strength = a.relative_strength?.leadership
    ? { ok: true }
    : { ok: false, error: `no benchmark comparison: ${results.benchmark?.error || 'assess() produced no leadership reading'}` };

  const verdict = await section(results, 'verdict', async () => ourAssessment(a));

  /**
   * The forward hypothesis. `assess().trade_plans` already gives a plan PER PATTERN
   * with Bulkowski's base rates attached — it is the primary source and is reported
   * as such. This adds three guards it does not carry: a stop checked against 1x
   * ATR, Livermore's chase limit, and a catalyst landing inside the intended hold.
   */
  const alt = alternateSwings(findSwings(bars, { lookback }));
  const lastHigh = [...alt].reverse().find((s) => s.kind === 'high');
  const lastLow = [...alt].reverse().find((s) => s.kind === 'low');
  const allLevels = (a.key_levels?.all_supports || []).concat(a.key_levels?.all_resistances || []);

  const hypothesis = await section(results, 'entry_hypothesis', async () => entryHypothesis({
    price,
    atr,
    patterns: a._raw_patterns?.structural || [],
    levels: allLevels,
    swing_high: lastHigh?.price ?? null,
    swing_low: lastLow?.price ?? null,
    holding_days,
    days_to_catalyst: days_to_catalyst ?? null,
    tier,
    now: Date.now(), // the core is pure and will not read the clock itself
  }));

  const primary = await section(results, 'primary_levels', async () => selectPrimary(allLevels, {
    price, swing_high: lastHigh?.price ?? null, swing_low: lastLow?.price ?? null,
  }));

  /**
   * ── Everything that used to be "declared and skipped" ──────────────────────
   *
   * Thirteen tools were listed as NOT in the workflow, each with a reason that was
   * true and useless: a reason is still a step the user has to remember. Every one
   * of them either takes bars, takes a price, or takes an input this function
   * already has — the strategy names come from the screens, the levels come from
   * the primaries, the account size comes from rules.json.
   *
   * Each runs inside `section()`, so a network failure degrades one block instead
   * of the analysis.
   */
  const px = price;

  // Position, calendar and regime — one TA call carries all three.
  const taCtx = await section(results, 'position_and_calendar', async () => (
    shared?.ta_context || ta.tradingContext({ symbols: [bare] })
  ));
  if (taCtx) {
    results.regime = taCtx.regime ? { ok: true } : { ok: false, error: 'TA returned no regime block' };
  }
  const held = taCtx?.held?.find((h) => String(h.ticker).toUpperCase() === bare) || null;
  const earnings = taCtx?.earnings?.find((e) => String(e.ticker).toUpperCase() === bare) || null;
  const daysToEarnings = Number.isFinite(earnings?.days_until) ? earnings.days_until : days_to_catalyst;
  /**
   * The earnings DATE, not just the distance to it.
   *
   * `days_to_earnings` answers "does it report inside my hold"; a line on the
   * chart needs a point on the TIME AXIS, and only the date gives one. TA writes
   * `earnings_date` as an ISO day, or "N/A (ETF)" for a fund — which is an ANSWER
   * rather than a missing value, and `earningsLinePlan` treats it as one. Every
   * other guard (past dates, dates past the 45-day window) lives there too, so
   * this end only has to pass through what TA said.
   */
  const earningsForDraw = earnings?.earnings_date
    ? { date: earnings.earnings_date, days_until: daysToEarnings ?? null }
    : null;

  // Screens — the scanner round trip, done here rather than left to the caller.
  const screens = await section(results, 'screens', async () => {
    const rows = shared?.scanner_rows || (await scan({
      columns: requiredColumns(),
      universe: ['sp500', 'nasdaq', 'russell2000'],
      range: [0, 2000],
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    })).rows || [];
    /**
     * A scan that returned NOTHING is a failure. A scan that returned rows without
     * this symbol is a fact about the INSTRUMENT — the universe is sp500 + nasdaq +
     * russell2000, so an ETF, an ADR or a small cap outside those indices is simply
     * not covered. The two must not read the same.
     */
    if (!rows.length) throw new Error('the scanner returned no rows at all — the scan itself failed');
    let row = rows.find((x) => String(x.symbol).split(':').pop().toUpperCase() === bare);

    /**
     * NOT IN THE POOL IS NOT THE SAME AS NOT EXISTING.
     *
     * `rows` is the morning screen's CANDIDATE universe — sp500 + nasdaq +
     * russell2000. That restriction is right for hunting candidates and wrong for
     * analysing a named symbol: the Sunday review takes whatever TA holds, with no
     * exclusions, and a held position outside the index pool still has a scanner row.
     *
     * Measured on the 2026-07-30 review, three of the 22 "not covered" names were
     * ordinary stocks — BE at $61.0B, FTI at $27.5B, MLI at $14.8B — whose screens
     * could have been evaluated the whole time. NYSE names between the S&P 500 and
     * the Russell 2000 fall in the gap; the Nasdaq Composite has no such hole.
     *
     * So: one targeted lookup, no universe. Only reached when the pool misses.
     */
    if (!row) {
      const direct = await scan({
        universe: [],
        filter: [{ left: 'name', operation: 'equal', right: bare }],
        columns: requiredColumns(),
        range: [0, 5],
      });
      row = (direct.rows || []).find((x) => String(x.symbol).split(':').pop().toUpperCase() === bare) || null;
    }

    if (!row) {
      const e = new Error(`${bare} has no scanner row at all — not a US-listed equity or fund the `
        + 'scanner covers. "Not covered", not "no setup".');
      e.notApplicable = true;
      throw e;
    }
    const trust = scannerTrust();
    return { row, ...screenCheck(row, { volume_fields_usable: trust.volume_fields_usable, include_intraday: true }) };
  });

  // Group context — which industry group, who leads it. DESCRIPTION only.
  await section(results, 'group', async () => {
    const industry = screens?.row?.industry;
    if (!industry) throw new Error('no industry on the scanner row');
    /**
     * `fetchGroupRows` pulls the columns the group functions need — the screens scan
     * uses a different column set, so reusing its rows would leave market cap and
     * the performance windows undefined and every leader would rank at zero.
     */
    const rows = shared?.group_rows
      || (await fetchGroupRows({ universe: ['sp500', 'nasdaq', 'russell2000'], limit: 2000 })).rows;
    const members = groupMembers(rows, industry);
    return {
      industry,
      member_count: members.length,
      ...groupLeaders(members),
      laggards: laggards(members),
      note: 'DESCRIPTION only. Two-leader agreement was measured and cost 9.3 points of win rate.',
    };
  });

  // Strategy criteria, evaluated for every strategy the screens named.
  await section(results, 'strategy_check', async () => {
    /**
     * "Passes no screen" is a RESULT, not a failure to run.
     *
     * This threw, so a held position matching none of our setups scored as an
     * INCOMPLETE analysis. On the morning screen that never showed, because every
     * candidate arrives BY passing a screen. On the Sunday review it fires constantly
     * — the list is whatever TA holds — and "TA holds this and it matches none of our
     * strategies" is one of the more useful things the review can say.
     *
     * A score that cries wolf on a correct answer is a score nobody reads.
     */
    if (!screens) {
      const e = new Error('the screens section did not run, so no strategy could be named');
      e.notApplicable = true;
      throw e;
    }
    const named = (screens.strategies || []).filter((x) => x.evidence_tier !== 'REJECTED');
    if (!named.length) {
      return {
        matched: 0,
        strategies: [],
        verdict: 'passes no screen, so no catalogue strategy applies here',
        note: 'A real answer, not a gap. For a held position it means the chart matches none of '
          + 'the 14 non-REJECTED setups in strategies.json.',
      };
    }
    const { evaluateCriteria, buildContext } = await import('./strategy.js');
    const ctx = buildContext(bars, {});
    return named.map((st) => ({
      name: st.name, tier: st.evidence_tier, execution: st.execution,
      ...(st.criteria ? evaluateCriteria(st, ctx) : { verdict: 'no criteria in the catalogue entry' }),
    }));
  });

  // Bars-only measurements — nothing here needs an input we do not have.
  await section(results, 'stopping_premium', async () => stops.stoppingPremium(bars, { lags: [1, 5, 10, 20] }));
  await section(results, 'pivot_trail', async () => stops.pivotTrail(bars, { direction: verdict?.bias === 'BEARISH' ? 'short' : 'long' }));
  await section(results, 'scaling_exponent', async () => tf.scalingExponent(bars));
  await section(results, 'stage_plan', async () => stages.stagePlan(bars));
  await section(results, 'level_test_history', async () => levelTestStudy(bars, { lookback: 5 }));
  await section(results, 'edge_breadth', async () => breadth.singleNameExpectation('time_series_momentum', { your_positions: 1 }));
  await section(results, 'timeframe_plan', async () => tf.scaleTimeframe({
    from: timeframe_label, to: '1W', lookback_bars: 20, price_distance: atr,
  }));

  // Price-anchored: the halt band, and a breakout scored at the PRIMARY levels.
  await section(results, 'luld_band', async () => costs.luldBand({ price: px, tier: 2 }));
  await section(results, 'breakout_check', async () => {
    const shown = primary?.shown || [];
    if (!shown.length) throw new Error('no primary level to score a breakout against');
    return shown.map((l) => ({
      level: l.price, side: l.side,
      ...scoreBreakout(bars, { level: l.price, direction: l.side === 'resistance' ? 'up' : 'down' }),
    }));
  });

  // Short interest — FINRA, twice a month. Network, so it may legitimately fail.
  await section(results, 'short_interest', async () => finra.buildSeries(bare, { periods: 6 }));

  // Options walls — needs the TA-Trading layout to DRAW, but the data reads anywhere.
  await section(results, 'walls', async () => loadWalls({ symbol: bare }));

  /**
   * Portfolio heat — total risk across the WHOLE book.
   *
   * This read `taCtx.held`, which `tradingContext` filters to the symbols asked
   * for. So "how much risk am I carrying" was computed from at most ONE position:
   * the one being analysed, if it happened to be held, and otherwise it failed with
   * "TA returned no holdings" against a live 73-position book. Heat is a
   * cross-position quantity — six 1% positions are not 6% if they move together —
   * so a single-symbol slice of it is not a smaller answer, it is a wrong one.
   */
  await section(results, 'portfolio_heat', async () => {
    const p = shared?.portfolio_response || await ta.portfolio();
    const book = p?.data?.positions || [];
    if (!book.length) throw new Error('TA returned an empty portfolio');
    /**
     * Sized against the BOOK's own equity, not against rules.json.
     *
     * These are two different layers. `account.account_size` in rules.json is the
     * TRADING account the sizing block below spends; TA's positions are the
     * INVESTING book, and on this account they are ~79x larger. Dividing one book's
     * risk by the other's equity produces a heat percentage that is wrong by that
     * factor and reads as a catastrophic breach every single run.
     */
    const equity = p?.data?.summary?.total_value_usd ?? null;
    if (equity == null) throw new Error('TA returned positions but no total_value_usd to size the heat against');
    const priced = book.filter((h) => h.stop_price != null && h.entry_price != null && h.shares);
    const heat = portfolio.portfolioHeat(
      priced.map((h) => ({ symbol: h.ticker, entry: h.entry_price, stop: h.stop_price, shares: h.shares })),
      { account_size: equity },
    );
    return {
      ...heat,
      positions_in_book: book.length,
      positions_priced: priced.length,
      equity_basis: equity,
      equity_source: "TA portfolio summary.total_value_usd — the INVESTING book's own equity",
      note: "TA's whole book, not just this symbol: heat is a cross-position quantity, and reading it "
        + `from the analysed symbol alone made it meaningless. Sized against the book's own equity, `
        + `NOT the ${accountSettings().account_size ?? 'configured'} trading account in rules.json — `
        + 'those are the investing and trading layers and must not be divided into each other.',
    };
  });

  // Sizing — the account comes from rules.json, the entry from the hypothesis.
  await section(results, 'sizing', async () => {
    const cfg = accountSettings();
    if (cfg.account_size == null) {
      throw new Error(`no account.account_size in ${cfg.rules_path} — set it and sizing runs automatically`);
    }
    const leg = hypothesis?.long?.available ? hypothesis.long : hypothesis?.short;
    if (!leg?.available) throw new Error('no tradeable entry hypothesis to size');
    return sizeWithConstraints({
      account_size: cfg.account_size, entry: leg.trigger, stop: leg.stop,
      risk_percent: cfg.risk_percent ?? 1,
    });
  });

  // ── drawing: the complete drawer, geometry and all ──────────────────────────
  let drawings = null;
  if (draw) {
    drawings = await section(results, 'drawings', async () => drawFindings(
      symbol, a, ta_row, verdict?.bias === 'BEARISH' ? 'short' : 'long',
      a._raw_patterns, bars, a._raw_channel,
      draw_group || `analysis-${String(symbol || '').replace(/^.*:/, '')}`,
      /**
       * Clear EVERYTHING first — the DEFAULT, and the owner's rule for an analysis.
       * 'mcp' is not enough interactively: it leaves drawings from older code, from
       * a scan, or from TradingView's own pattern tools sitting under the new ones.
       *
       * The parameter exists for ONE caller. An unattended 05:30 batch walks twenty
       * machine-selected charts, and `scope: 'all'` there would delete a walls
       * overlay or anything hand-drawn without anyone present to be asked. The batch
       * passes 'mcp', which still clears its own work by text signature — a signature
       * survives the session restart that kills every entity id. The KEEP* sections
       * are the owner's "leave this chart alone" marker and are never analysed at all.
       */
      // Only the verdict side is drawn. `side` above collapses NEUTRAL to 'long',
      // so the bias is passed separately — filtering on `side` would delete every
      // bearish finding on an undecided chart and call it a clean-up.
      //
      // `earnings` is the catalyst on the TIME axis. The fixed-range volume
      // profile is deliberately NOT enabled here: it is a pane-wide overlay, and
      // its acceptance is "rendered natively on request".
      //
      // `auto_alerts` is passed THROUGH, never defaulted on. It creates real
      // alerts on the live account that nothing here can delete, so the caller's
      // false — which is every caller that does not say otherwise — must reach
      // the drawer unchanged.
      { clear_scope, bias: verdict?.bias ?? null, earnings: earningsForDraw, auto_alerts },
    ));
  } else {
    results.drawings = { ok: false, skipped: true, reason: 'draw was false' };
  }

  return {
    symbol,
    timeframe,
    /**
     * What the fixed bar windows actually span here, and whether the horizon prior
     * may be quoted. Always present, so a reader never has to know the convention.
     */
    timeframe_calibration: tf_calibration,
    horizon_applicable: horizon_validity,
    price,
    atr,
    bars: bars.length,
    completeness: scoreAnalysis(results),
    verdict,
    /** Every block assess() produced, minus the two raw payloads meant for the drawer. */
    assessment: Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_'))),
    primary_levels: primary?.shown || null,
    /**
     * Everything that used to be declared-and-skipped, now measured.
     *
     * ── Two things are deliberately NOT dumped here ──
     *
     * This mapped every section's raw value straight out, which duplicated the whole
     * batch's SHARED objects onto every single ticker. Measured on a 49-ticker Sunday
     * review: `position_and_calendar` carried the entire TA context (every holding,
     * every earnings row) at **52KB per ticker**, and `benchmark` carried the SPY bar
     * ARRAY at **28KB per ticker** — about 4MB of the 13.8MB file was the same two
     * objects written 49 times. `assessment`, `verdict`, `drawings`,
     * `entry_hypothesis` and `primary_levels` were duplicated too, since each is
     * already a top-level key on this same object.
     *
     * So: promoted keys are excluded, and the two shared blobs are reduced to THIS
     * symbol's slice. Nothing measured is lost — `held`, `earnings` and `regime` are
     * what any reader wants per ticker, and a benchmark's own bars are not a finding.
     */
    context: (() => {
      const PROMOTED = new Set(['assessment', 'verdict', 'drawings', 'entry_hypothesis', 'primary_levels']);
      const out = {};
      for (const [k, v] of Object.entries(results)) {
        if (!v.ok || v.value === undefined || PROMOTED.has(k)) continue;
        out[k] = v.value;
      }
      if (out.benchmark) {
        out.benchmark = {
          symbol: out.benchmark.symbol,
          bars: out.benchmark.bars?.length ?? null,
          reused: !!out.benchmark.reused,
          note: 'The benchmark SERIES is not carried per ticker — relative_strength is the finding.',
        };
      }
      if (out.position_and_calendar) {
        const ctx = out.position_and_calendar;
        out.position_and_calendar = {
          held: held || null,
          earnings: earnings || null,
          days_to_earnings: daysToEarnings ?? null,
          /**
           * The STAGE only, not TA's whole macro view.
           *
           * `regime` carries TA's geopolitical read, crypto crash templates, the
           * recession playbook, Exter's pyramid — 22KB, identical on every ticker,
           * and it CAME FROM TA, which is the consumer of this report. Sending it
           * back 49 times is round-tripping. The stage is what a per-ticker analysis
           * actually uses (it carries the position sizing); the rest is one
           * `ta_regime` call away for anyone who wants it.
           */
          regime_stage: ctx.regime?.stage ?? null,
          sources: ctx.sources ?? null,
          note: "This symbol's slice. TA's full context and macro regime are identical across the "
            + 'batch and are not repeated per ticker — call ta_regime for the full block.',
        };
      }
      return out;
    })(),
    entry_hypothesis: hypothesis,
    drawings,
    sections: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
      ok: !!v.ok,
      ...(v.error ? { error: v.error } : {}),
      ...(v.skipped ? { skipped: true, reason: v.reason } : {}),
    }])),
    sources: {
      measurement: 'assess() in core/assessment.js — the SAME assessment the morning screen and the '
        + 'Sunday review use. One copy, imported by all three.',
      drawing: 'drawFindings() in core/assessment_draw.js — channel boundaries, pattern geometry via '
        + 'the native triangle_pattern and head_and_shoulders tools anchored to real pivots, flag '
        + 'poles, key levels and trade plans.',
      plans: 'assessment.trade_plans is the primary plan source and carries Bulkowski base rates. '
        + 'entry_hypothesis adds the 1x ATR stop check, the chase limit and the catalyst conflict.',
    },
    not_advice: 'Arithmetic on measured values. Nothing here is trade advice.',
  };
}
