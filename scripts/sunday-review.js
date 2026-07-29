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
// assess() and ourAssessment() live in src/core/assessment.js so the morning
// screen shares ONE copy with this script. Two copies drift silently — see
// the module header for the run this already cost.
import { assess, ourAssessment, CATALYST_EVIDENCE } from '../src/core/assessment.js';
// Drawing lives in src/core/assessment_draw.js so the morning screen draws
// the same findings from ONE implementation.
import { drawFindings } from '../src/core/assessment_draw.js';

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
