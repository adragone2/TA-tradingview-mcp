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
 * Run:  node scripts/sunday-review.js [--limit N] [--no-holdings] [--no-draw]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as chart from '../src/core/chart.js';
import { acquireChartLock } from '../src/core/chart_lock.js';
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
/**
 * `assess`, `ourAssessment` and `drawFindings` are NO LONGER imported here.
 *
 * They were called directly, which is how this script ended up with the 28
 * measurement blocks and none of the 23 context sections. `analyzeTicker` calls all
 * three in the right order and scores the result — so importing them again would be
 * a second path to the same place, which is the drift this repo keeps paying for.
 *
 * `CATALYST_EVIDENCE` stays: `validateTa` below is Sunday-specific and grades TA's
 * stated catalysts, which no other caller does.
 */
import { CATALYST_EVIDENCE } from '../src/core/assessment.js';
import { analyzeTicker } from '../src/core/ticker_analyze.js';
import { resolveTaSymbol } from '../src/core/ta_symbols.js';
import { scan } from '../src/core/scanner.js';
import { requiredColumns } from '../src/core/screen_check.js';
import { fetchGroupRows } from '../src/core/groups.js';

// 2.0 — every ticker now carries the FULL unified analysis (analyzeTicker) under
// `analysis`, replacing the flat `assessment` / `our_view` / `drawings` keys.
export const SCHEMA_VERSION = '2.0';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const LIMIT = Number(argVal('--limit', '999'));
// Specific names on demand. TA's actionable list is live and re-orders by
// urgency, so `--limit N` does NOT give a stable set of tickers between runs —
// use this when you want a particular symbol analysed and drawn.
const ONLY = (argVal('--tickers', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
/**
 * HOLDINGS ARE INCLUDED BY DEFAULT.
 *
 * This was opt-in via `--holdings`, and the scheduled task does not pass it — so the
 * weekly review of the portfolio silently skipped every position TA was not flagging
 * for action. Measured on 2026-07-30: TA's book held **73 positions**, the actionable
 * list was 53, and **35 holdings were never queued** — ANET, AVGO, VOO, VXUS, ICVT,
 * COPX, HYDR, ILIT, RING, SLVP and 25 crypto lines among them.
 *
 * The owner's rule: *"The sunday routine analyzes all TA tickers period. no
 * exclusions."* An opt-in flag on a scheduled job is an exclusion by default.
 */
const INCLUDE_HOLDINGS = !args.includes('--no-holdings');
const DRAW = !args.includes('--no-draw');
const OUT_DIR = argVal('--out-dir', 'reports');
// Below this, the structural detectors have nothing to work with — swing
// detection alone needs a multiple of its lookback.
const MIN_BARS = 60;

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const log = (...a) => console.log(...a);
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };


/** Load 1D bars, verifying the series identity actually matches. */
async function loadSymbol(ticker) {
  /**
   * Resolve BEFORE touching the chart.
   *
   * TA holds crypto as `BTC-USD`, and TradingView reads the hyphen as a SPREAD
   * operator — `BTC-USD` silently becomes `CRYPTOCAP:BTC-BATS:USD`, returns 300 bars,
   * and every detector runs happily on a synthetic series that is not the price of
   * Bitcoin. It does not fail; it lies. See src/core/ta_symbols.js.
   */
  const resolved = resolveTaSymbol(ticker);
  await chart.setSymbol({ symbol: resolved.symbol });
  await sleep(350);
  const st = await chart.getState();
  if (String(st.resolution) !== '1D') { await chart.setTimeframe({ timeframe: '1D' }); await sleep(350); }
  const series = await data.getOhlcv({ count: 400, summary: false });
  /**
   * A no-op on the scheduled Sunday run — the newest bar is Friday's and long
   * finished. It matters when this is run by hand mid-week, which happens.
   */
  const { bars } = S.completeSeries(series);
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
  /**
   * Verify against the RESOLVED form, not TA's raw ticker.
   *
   * `BTC-USD` maps to `CRYPTO:BTCUSD`, so comparing the loaded series to TA's own
   * string would reject a correct load. Comparing to `resolved.expect` still catches
   * the thing this guard exists for — the chart handing back a different instrument
   * than the one asked for, which is how another company's bars reached a report.
   */
  const got = String(series.symbol || '').replace(/^.*:/, '').toUpperCase();
  const want = resolved.expect.toUpperCase();
  if (got !== want) {
    throw new Error(`chart returned ${series.symbol}, expected ${resolved.symbol}`
      + (resolved.mapped ? ` (mapped from TA's "${ticker}")` : ''));
  }
  // `series` goes out too: analyzeTicker reads `symbol` and `resolution` off the RAW
  // series to know what it is analysing, and handing it the trimmed bars alone would
  // make it re-fetch what this function just read.
  return { bars, symbol: series.symbol, resolution: series.resolution, series, resolved };
}

/**
 * The complete assessment. One block per analysis type this repo has a skill
 * for. Every key is always present.
 */

/** Our own independent call, before TA is consulted. */

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


// ── run ──────────────────────────────────────────────────────────────────────

log(`Sunday review — schema ${SCHEMA_VERSION}`);
const act = await ta.actionable({ limit: 200 });
const exits = (act.exits || []).slice(0, LIMIT);
const entries = (act.entries || []).slice(0, LIMIT);
log(`  ${exits.length} exits, ${entries.length} entries`);

let holdings = [];
if (INCLUDE_HOLDINGS) {
  const pf = await taApi.portfolio().catch(() => null);
  const acted = new Set([...exits, ...entries].map((r) => r.ticker));
  holdings = (pf?.data?.positions || [])
    .filter((p) => !acted.has(p.ticker))
    .map((p) => ({ ticker: p.ticker, action: p.status || 'HOLD', urgency: p.exit_urgency || null,
      price: p.current_price, stop: p.stop_price, return_pct: p.pl_percent, signals: p.signals, archetype: p.archetype }));
  log(`  ${holdings.length} additional holdings`);
}

/**
 * Take the chart lock before the first chart write.
 *
 * This walks ~60 tickers symbol by symbol, and until now it announced itself to
 * nobody: the lock existed only inside `morning-screen.js`. A Sunday review and a
 * forced morning screen overlapping would interleave exactly as two morning runs
 * once did, each restoring the chart to the other's working symbol. Placed AFTER
 * the TA calls above so a run that cannot reach TA fails without ever claiming
 * the chart.
 */
acquireChartLock({ label: 'sunday-review' });

const before = await chart.getState();
const original = before?.symbol || null;

log('  fetching SPY benchmark once...');
let spy = null;
try {
  await chart.setSymbol({ symbol: 'AMEX:SPY' }); await sleep(600);
  spy = S.completeSeries(await data.getOhlcv({ count: 400, summary: false })).bars;
  log(`  SPY ${spy.length} bars`);
} catch (e) { log(`  SPY unavailable: ${e.message}`); }

/**
 * Everything identical across the batch, fetched ONCE.
 *
 * `analyzeTicker` will otherwise repeat two 2,000-row scanner round trips, a TA
 * context call and a portfolio read for every one of ~48 tickers. A failure here
 * degrades the sections that need it rather than the run: each is wrapped, and
 * `analyzeTicker` scores a section it could not compute rather than omitting it.
 */
const shared = { benchmark_bars: spy, benchmark_symbol: 'AMEX:SPY' };
log('  fetching the batch-shared data once (scanner, groups, TA, portfolio)...');
try {
  shared.scanner_rows = (await scan({
    columns: requiredColumns(), universe: ['sp500', 'nasdaq', 'russell2000'],
    range: [0, 2000], sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
  })).rows || [];
  log(`    scanner ${shared.scanner_rows.length} rows`);
} catch (e) { log(`    scanner FAILED: ${e.message}`); }
try {
  shared.group_rows = (await fetchGroupRows({ universe: ['sp500', 'nasdaq', 'russell2000'], limit: 2000 })).rows;
  log(`    group rows ${shared.group_rows.length}`);
} catch (e) { log(`    group rows FAILED: ${e.message}`); }
try {
  // Every ticker in the queue at once, so "do I hold it, does it report soon" is
  // one call rather than 48.
  shared.ta_context = await taApi.tradingContext({
    symbols: [...exits, ...entries, ...holdings].map((r) => String(r.ticker).replace(/^.*:/, '')),
  });
  log(`    TA context: ${shared.ta_context?.held?.length ?? 0} held, ${shared.ta_context?.earnings?.length ?? 0} earnings`);
} catch (e) { log(`    TA context FAILED: ${e.message}`); }
try {
  // The WHOLE book, for portfolio heat. `tradingContext.held` is filtered to the
  // symbols asked for, and heat computed from a subset is not a smaller answer.
  shared.portfolio_response = await taApi.portfolio();
  const eq = shared.portfolio_response?.data?.summary?.total_value_usd;
  log(`    TA portfolio ${shared.portfolio_response?.data?.positions?.length ?? 0} positions`
    + `, equity ${eq ? `$${Math.round(eq).toLocaleString()}` : 'unknown'}`);
} catch (e) { log(`    TA portfolio FAILED: ${e.message}`); }

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
/**
 * Split off what this layer does not chart, BEFORE anything is analysed.
 *
 * Crypto is TA's book on the investing layer; this is the equity trading layer.
 * Excluding it is the owner's call, and it is also the safe one — `BTC-USD` handed
 * to TradingView silently becomes the spread `CRYPTOCAP:BTC-BATS:USD`, which returns
 * bars that are not the price of Bitcoin.
 *
 * EXCLUDED IS NOT FAILED, and both are reported. A name missing from the review with
 * a stated reason is a fact; a silently shorter list is a bug — which is exactly what
 * the opt-in `--holdings` flag was producing until now.
 */
const excluded = [];
queue = queue.filter((q) => {
  const r = resolveTaSymbol(q.taRow.ticker);
  if (r.chartable) return true;
  excluded.push({ ticker: String(q.taRow.ticker).replace(/^.*:/, ''), side: q.side, kind: r.kind, why: r.why });
  return false;
});
if (excluded.length) {
  const byKind = excluded.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {});
  log(`  ${excluded.length} not charted here: ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}`);
}

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
    analysis: null, ta_validation: null,
  };
  try {
    /**
     * ── ONE analysis workflow, and this is now on it ──
     *
     * This used to call `assess()` + `ourAssessment()` + `drawFindings()` directly,
     * which gave it the 28 measurement blocks and NONE of the 23 context sections
     * `analyzeTicker` adds. So the review of the owner's actual money was thinner
     * than the morning candidate screen — missing portfolio_heat, the earnings
     * calendar, pivot_trail, short_interest, luld_band, entry_hypothesis, sizing,
     * and the completeness score that makes a skipped section impossible to miss.
     *
     * TWO ARGUMENTS BELOW EXIST SO THIS SWAP DOES NOT LOSE ANYTHING, and both were
     * found by looking rather than by a test failing:
     *
     *   ta_row      analyzeTicker passed `null` here, so TA's own stop line would
     *               have silently stopped being drawn on all 48 charts.
     *   draw_group  it defaults to `analysis-<SYMBOL>`; the Sunday run has drawn
     *               into `sunday-<TICKER>` for months, and `clear_scope: 'mcp'`
     *               clears the NAMED group — so the default would have left every
     *               previous week's shapes uncleared and untouchable.
     *
     * `clear_scope: 'mcp'` for the same reason the morning batch uses it: this is
     * unattended, walks ~48 charts of the owner's own positions, and 'all' would
     * delete a walls overlay or anything hand-drawn with nobody present to be asked.
     */
    const { bars, symbol, resolution, series } = await loadSymbol(t);
    row.symbol = symbol; row.resolution = resolution; row.bars = bars.length;

    const r = await analyzeTicker({
      draw: DRAW,
      shared: { ...shared, series, bars },
      ta_row: item.taRow,
      draw_group: `sunday-${String(t).replace(/^.*:/, '')}`,
      clear_scope: 'mcp',
    });
    row.analysis = r;

    /**
     * `analyzeTicker` returns a DEGRADED shape when assess() itself fails — no
     * `verdict`, no `assessment`, just the completeness score and an error. Handing
     * that to `validateTa` crashed on `ours.bias`, turning one failed block into an
     * exception that read like a chart problem.
     *
     * A run that could not measure the chart cannot validate TA against it. Say so.
     */
    if (!r.verdict || !r.assessment) {
      row.status = 'failed';
      row.error = r.error || 'the analysis produced no verdict — assess() failed on this series';
      log(`FAILED (${row.error})`);
      tickers.push(row);
      continue;
    }
    row.status = 'ok';

    /**
     * The Sunday-specific half, which `analyzeTicker` does not and should not do:
     * whether OUR independent read supports what TA wants done.
     */
    row.ta_validation = validateTa(r.assessment, r.verdict, { side: item.side, taRow: item.taRow });
    if (item.also_listed_as) row.ta_validation.also_listed_as = item.also_listed_as;

    const c = r.completeness;
    log(`${r.verdict?.bias}/${row.ta_validation.agreement} ${c.required_done}/${c.required_total}`
      + `${r.drawings ? ` (${r.drawings.shapes} drawn)` : ''}`
      + `${c.complete ? '' : ` MISSING: ${c.missing.map((m) => m.section).join(',')}`}`);
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
  /**
   * How complete each analysis was. `analyzeTicker` scores every run against
   * src/core/analysis_contract.js, so a section that did not run is reported
   * rather than silently absent — the property the flat 1.0 schema lacked.
   */
  completeness_summary: ok.reduce((m, t) => {
    const c = t.analysis?.completeness;
    if (!c) return m;
    const k = c.complete ? 'complete' : 'incomplete';
    return { ...m, [k]: (m[k] || 0) + 1 };
  }, {}),
  counts: {
    requested: queue.length, analysed: ok.length, failed: tickers.length - ok.length,
    /**
     * EXCLUDED is not FAILED. A failed ticker was attempted and could not be read;
     * an excluded one is not charted on this layer at all. Collapsing them would
     * make a deliberate scope boundary look like breakage.
     */
    excluded: excluded.length,
    exits: exits.length, entries: entries.length, holdings: holdings.length,
  },
  /** Everything TA holds that this layer does not chart, each with its reason. */
  excluded_from_review: excluded,
  ta_validation_summary: {
    CONFIRMED: ok.filter((t) => t.ta_validation?.agreement === 'CONFIRMED').length,
    MIXED: ok.filter((t) => t.ta_validation?.agreement === 'MIXED').length,
    DISPUTED: ok.filter((t) => t.ta_validation?.agreement === 'DISPUTED').length,
    CONTRADICTED: ok.filter((t) => t.ta_validation?.agreement === 'CONTRADICTED').length,
    NO_SIGNAL: ok.filter((t) => t.ta_validation?.agreement === 'NO_SIGNAL').length,
  },
  our_bias_summary: {
    BULLISH: ok.filter((t) => t.analysis?.verdict?.bias === 'BULLISH').length,
    NEUTRAL: ok.filter((t) => t.analysis?.verdict?.bias === 'NEUTRAL').length,
    BEARISH: ok.filter((t) => t.analysis?.verdict?.bias === 'BEARISH').length,
  },
  /**
   * A market-wide condition belongs here, not repeated on every row.
   *
   * Every read below is `t.analysis.assessment.market_regime`, and the `analysis.`
   * was MISSING until this was fixed: the block kept the flat 1.0 paths through the
   * 2.0 move, when per-ticker data went under `analysis`. **A dead optional-chain
   * path yields `undefined`, not an error**, so the block assembled itself out of
   * nothing and emitted `{regime_counts:{}, choppy_share_pct:null,
   * median_efficiency:null, broad_chop:false}` on every real 2.0 report. On
   * 2026-07-30 the truth was 50 choppy / 6 mixed / 3 trending — 84.7%, median
   * efficiency 0.174 against the 0.183 random-walk baseline. `broad_chop: false`
   * there was not a finding that the market was fine; it was the block failing to
   * read anything. Same defect class as the stale scheduled prompt (P0.1), one
   * layer down — which is why tests/sunday_prompt.test.js now asserts as a source
   * contract that no 1.0 `t.assessment?.` read survives in this file.
   */
  market_condition: (() => {
    const regs = ok.map((t) => t.analysis?.assessment?.market_regime?.regime).filter(Boolean);
    const choppy = regs.filter((r) => r === 'choppy').length;
    const share = regs.length ? choppy / regs.length : null;
    const effs = ok.map((t) => t.analysis?.assessment?.market_regime?.efficiency)
      .filter((e) => e != null).sort((a, b) => a - b);
    return {
      regime_counts: regs.reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {}),
      choppy_share_pct: share == null ? null : r2(share * 100, 1),
      median_efficiency: effs.length ? effs[Math.floor(effs.length / 2)] : null,
      random_walk_efficiency: ok[0]?.analysis?.assessment?.market_regime?.random_walk_efficiency ?? null,
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
