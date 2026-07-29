/**
 * Morning screen — find the day's candidates across the whole US market.
 *
 * Two stages. TradingView's scanner has BREADTH: 3,771 fields over 4,505
 * index-member symbols, filtered server-side in under a second. This repo has
 * the EVIDENCE DISCIPLINE: noise floors, horizon priors, trade plans,
 * deflation. Neither does the other's job.
 *
 *   stage 1   one POST, ~4500 symbols -> ~400 candidates -> top 20   <1s
 *   stage 2   assess() + drawings on the 20                          ~4 min
 *   output    rewrite the Swing Opportunities watchlist + a report
 *
 * PRE-OPEN IS THE RIGHT TIME, not a compromise. Measured after a session close,
 * the daily series ends on the PRIOR COMPLETED session — no partial bar — so
 * every detector reads finished data. Run it AFTER the open and today's
 * unfinished bar is in the series, which corrupts every one of them.
 *
 * Scheduled 05:30 PT, an hour before the 06:30 PT open.
 *
 * The one thing that cannot be seen: a company reporting after yesterday's
 * close. The veto catches SCHEDULED earnings, but an overnight move on news is
 * invisible to every detector here, because all of them read a bar that closed
 * before it happened. `moved_since_bar` reports it per name.
 *
 * Run:  node scripts/morning-screen.js [--top 20] [--no-draw] [--no-watchlist]
 *                                      [--dry-run] [--out-dir reports]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as S from '../src/core/structure.js';
import { scan, BASE_COLUMNS, DEFAULT_UNIVERSE, UNIVERSES, movedSinceBar, offHighPct, daysToEarnings } from '../src/core/scanner.js';
import { SCREENS, mergeByConfluence, DEFAULT_SLOTS } from '../src/core/screens.js';
import { assess, ourAssessment } from '../src/core/assessment.js';
import { drawFindings } from '../src/core/assessment_draw.js';
import { rewrite, listContents, refreshPanel, buildWithPreserved, parseSections } from '../src/core/watchlist_rewrite.js';
import { removeOrphans } from '../src/core/orphans.js';

export const SCHEMA_VERSION = '1.0';
const WATCHLIST_NAME = 'Swing Opportunities';
// Sections whose contents survive the daily rewrite untouched — not removed
// from the list, and their charts are not cleared. Moving a ticker into KEEP in
// TradingView is how you tell this run to leave it alone.
const PRESERVE_SECTIONS = ['KEEP'];

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const TOP = Number(argVal('--top', '20'));
const DRAW = !args.includes('--no-draw');
const WRITE_LIST = !args.includes('--no-watchlist');
const DRY = args.includes('--dry-run');
const OUT_DIR = argVal('--out-dir', 'reports');
const MIN_BARS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Same guards as the Sunday review: not every symbol is a chart. */
async function loadSymbol(symbol) {
  await chart.setSymbol({ symbol });
  await sleep(350);
  const st = await chart.getState();
  if (String(st.resolution) !== '1D') { await chart.setTimeframe({ timeframe: '1D' }); await sleep(350); }
  const series = await data.getOhlcv({ count: 400, summary: false });
  const bars = S.normalizeBars(series);
  if (!bars.length) throw new Error('no bars returned');
  if (bars.length < MIN_BARS) throw new Error(`only ${bars.length} bars (need ${MIN_BARS})`);
  const ranged = bars.filter((b) => b.high > b.low).length;
  if (ranged / bars.length < 0.5) throw new Error('no intraday range — not a tradable chart');
  return { bars, symbol: series.symbol };
}

log(`Morning screen — schema ${SCHEMA_VERSION}`);
log(`  universe: ${DEFAULT_UNIVERSE.map((u) => UNIVERSES[u].name).join(' + ')}`);

// ── stage 1 ─────────────────────────────────────────────────────────────────
const byScreen = {};
for (const s of SCREENS) {
  const r = await scan({ filter: s.filter, columns: BASE_COLUMNS, range: [0, 500] });
  const kept = r.rows.filter(s.refine).sort((a, b) => s.rank(b) - s.rank(a));
  byScreen[s.key] = kept;
  log(`  ${s.key.padEnd(24)} ${String(r.total).padStart(5)} raw -> ${String(kept.length).padStart(4)} refined`);
}

const merged = mergeByConfluence(byScreen, { top: TOP, slots: DEFAULT_SLOTS });
log(`\n  considered ${merged.considered}, vetoed ${merged.vetoed}, trials ${merged.trials}`);
log(`  by direction: ${JSON.stringify(merged.by_direction)} into slots ${JSON.stringify(merged.slots)}`);
if (merged.overlap_warning) log(`  ${merged.overlap_warning}`);

// ── clear yesterday's charts BEFORE drawing today's ─────────────────────────
//
// The watchlist is rewritten every morning, so names DROP OFF it. Their charts
// still carry yesterday's drawings, and nothing would ever clean them: the run
// only clears charts it is about to draw on, and tomorrow it will not visit a
// name that fell out of the list. A name that appears once keeps its drawings
// forever — a slow leak with no upper bound.
//
// So the charts to clean are LAST list MINUS today's selection. Names in both
// are skipped here because drawFindings clears each one immediately before it
// redraws.
//
// Cleared by TEXT SIGNATURE, never by entity id: ids die with the TradingView
// session and this runs daily, which is exactly how 545 stale shapes
// accumulated across 45 charts before.
const before = await chart.getState();
const original = before?.symbol || null;

if (DRAW) {
  let previous = [];
  try { previous = await listContents(WATCHLIST_NAME); }
  catch (e) { log(`  could not read "${WATCHLIST_NAME}": ${e.message}`); }

  // Symbols in a preserved section are OFF LIMITS: they stay in the list and
  // their drawings stay on the chart. Section headers ("###KEEP") are entries
  // in the same flat array and are never symbols.
  const parsed = parseSections(previous || []);
  const keptSyms = new Set(parsed.sections
    .filter((s) => PRESERVE_SECTIONS.some((p) => p.toUpperCase() === s.name.toUpperCase()))
    .flatMap((s) => s.symbols));
  if (keptSyms.size) log(`  ${keptSyms.size} symbol(s) in ${PRESERVE_SECTIONS.join('/')} — left untouched`);

  const todays = new Set(merged.candidates.map((c) => c.symbol));
  const dropped = parsed.default.filter((s) => !todays.has(s) && !keptSyms.has(s));
  if (dropped.length) {
    log(`\n  clearing ${dropped.length} chart(s) dropping out of the list...`);
    let cleared = 0;
    for (const sym of dropped) {
      try {
        await chart.setSymbol({ symbol: sym }); await sleep(300);
        const r = await removeOrphans({ dry_run: false, sources: ['review'] });
        cleared += r.removed || 0;
      } catch (e) { log(`    ${sym}: ${e.message}`); }
    }
    log(`  removed ${cleared} stale shape(s) from dropped names`);
  } else if (previous?.length) {
    log(`\n  no names dropped out of "${WATCHLIST_NAME}"`);
  }
}

log(`\n  fetching SPY benchmark once...`);
let spy = null;
try {
  await chart.setSymbol({ symbol: 'AMEX:SPY' }); await sleep(600);
  spy = S.normalizeBars(await data.getOhlcv({ count: 400, summary: false }));
} catch (e) { log(`  SPY unavailable: ${e.message}`); }

const tickers = [];
let n = 0;
for (const c of merged.candidates) {
  n++;
  const sym = c.symbol;
  process.stdout.write(`  [${n}/${merged.candidates.length}] ${sym.replace(/^.*:/, '')} ... `);
  const row = {
    symbol: sym,
    screens: c.screens,
    confluence: c.confluence,
    direction: c.direction,
    mixed_direction: c.mixed_direction,
    scanner: {
      close: c.row.close, perf_1m: c.row['Perf.1M'], perf_3m: c.row['Perf.3M'],
      perf_6m: c.row['Perf.6M'], perf_y: c.row['Perf.Y'], rsi: c.row.RSI,
      volatility_d: c.row['Volatility.D'], sector: c.row.sector,
      off_52w_high_pct: offHighPct(c.row), days_to_earnings: daysToEarnings(c.row),
      dollar_volume: r2((c.row.close ?? 0) * (c.row['average_volume_10d_calc'] ?? 0), 0),
    },
    status: 'ok', error: null, assessment: null, our_view: null, drawings: null,
    moved_since_bar: null,
  };
  try {
    const { bars } = await loadSymbol(sym);
    const a = assess(bars, spy);
    row.assessment = a;
    row.our_view = ourAssessment(a);
    // The scanner's `close` and the chart's last bar should agree pre-open.
    // When they do not, price has already left the bar every detector read.
    row.moved_since_bar = movedSinceBar(
      { close: bars.at(-1).close }, c.row.close, a.risk?.atr_14 ?? null,
    );
    if (DRAW) {
      row.drawings = await drawFindings(
        sym, a, {}, 'screen', a._raw_patterns || [], bars, a._raw_channel || null,
        `morning-${sym.replace(/^.*:/, '')}`,
      );
    }
    log(`${row.our_view.bias}${row.drawings ? ` (${row.drawings.shapes} drawn)` : ''}`);
  } catch (e) {
    row.status = 'failed'; row.error = e.message;
    log(`FAILED (${e.message})`);
  }
  tickers.push(row);
}

if (original) { try { await chart.setSymbol({ symbol: original }); await sleep(400); } catch { /* leave */ } }

// ── output ──────────────────────────────────────────────────────────────────
const ok = tickers.filter((t) => t.status === 'ok');
const stamp = new Date().toISOString().slice(0, 10);
mkdirSync(OUT_DIR, { recursive: true });

const report = {
  schema_version: SCHEMA_VERSION,
  generated_at: new Date().toISOString(),
  kind: 'morning-screen',
  universe: DEFAULT_UNIVERSE.map((u) => UNIVERSES[u].name),
  screens: SCREENS.map((s) => ({
    key: s.key, name: s.name, direction: s.direction, bet: s.bet,
    horizon_side: s.horizon_side, evidence: s.evidence, candidates: byScreen[s.key].length,
  })),
  selection: {
    considered: merged.considered,
    vetoed: merged.vetoed,
    vetoed_detail: merged.vetoed_detail.slice(0, 40),
    by_direction: merged.by_direction,
    slots: merged.slots,
    overlap_pct: merged.overlap_pct,
    overlap_warning: merged.overlap_warning,
    trials: merged.trials,
    trial_note: merged.trial_note,
    ranking: 'Confluence WITHIN direction. Global confluence was measured to erase the reversal side '
      + 'entirely — structural_reversal overlaps every other screen at 0% by construction.',
  },
  counts: { requested: merged.candidates.length, analysed: ok.length, failed: tickers.length - ok.length },
  our_bias_summary: ok.reduce((m, t) => ({ ...m, [t.our_view.bias]: (m[t.our_view.bias] || 0) + 1 }), {}),
  tickers,
};

const jsonPath = join(OUT_DIR, `morning-screen-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
log(`\n  ${jsonPath}`);
log(`  analysed ${ok.length}/${tickers.length}`);
log(`  our bias: ${JSON.stringify(report.our_bias_summary)}`);

// ── watchlist ───────────────────────────────────────────────────────────────
if (WRITE_LIST && ok.length) {
  try {
    const current = await listContents(WATCHLIST_NAME);
    const built = buildWithPreserved(current, ok.map((t) => t.symbol), PRESERVE_SECTIONS);
    if (built.preserved_sections.length) {
      log(`  preserving ${built.preserved_sections.map((s) => `${s.name}(${s.count})`).join(', ')}`);
    }
    const res = await rewrite({
      name: WATCHLIST_NAME,
      symbols: built.entries,
      dry_run: DRY,
    });
    log(`  watchlist "${WATCHLIST_NAME}": ${res.dry_run
      ? `DRY RUN — would write ${res.would_write} (currently ${res.currently})`
      : `wrote ${res.entries_after} (was ${res.entries_before}), backup ${res.backup}`}`);

    // The panel caches and nothing invalidates it on a REST write. The app is
    // open during EVERY run — the MCP writes by running JS inside the page —
    // so without this the list reads empty or stale every single morning.
    if (!res.dry_run) {
      const p = await refreshPanel({ expect: res.entries_after });
      log(`  panel refresh: ${p.success ? `${p.rows} rows after ${Math.round(p.waited_ms / 1000)}s` : p.note}`);
    }
  } catch (e) {
    log(`  watchlist FAILED: ${e.message}`);
  }
} else if (!WRITE_LIST) {
  log('  watchlist skipped (--no-watchlist)');
}

process.exit(0);
