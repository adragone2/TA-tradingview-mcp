/**
 * Morning screen — the day's candidates, gated by our own detectors.
 *
 * ── What changed in 3.0, and why ──
 *
 * 2.x ran every scanner, merged the results into 15 continuation and 5 reversal
 * slots, and only THEN ran this repo's detectors on the twenty names the merge
 * had already picked. The scanner chose the list; our measurements described it
 * afterwards. That inverts `docs/screening.md`'s own stated design — "TV scanner
 * as coarse filter, our detectors as verdict" — and it let one strategy family
 * take most of the slots.
 *
 * The owner's instruction: the detectors run BEFORE the per-scanner cut, so the
 * five that reach the watchlist are five that SURVIVED.
 *
 *   1  every session-eligible scanner                             <1s
 *   2  top 15 per scanner into the detector gate                  ~3 min
 *   3  top 5 SURVIVORS per scanner
 *   4  classify each into INTRADAY / WEEKLY / MONTHLY
 *   5  rewrite those three sections; KEEP* untouched
 *   6  the FULL unified analysis on every name written            ~8 min
 *   7  report
 *
 * The buckets are gone, and so is their clock. Weeks/Months were a CADENCE split;
 * INTRADAY/WEEKLY/MONTHLY is an EXECUTION split — how long a trade is held. Every
 * managed section is rebuilt every run. A watchlist is a list of candidates: adding
 * a name to it places no trade, so the turnover arithmetic that justified a monthly
 * clock never applied to it.
 *
 * PRE-OPEN IS THE RIGHT TIME, not a compromise. Measured after a session close,
 * the daily series ends on the PRIOR COMPLETED session — no partial bar — so
 * every detector reads finished data. Run it after the open and today's
 * unfinished bar is in the series, which corrupts every one of them.
 *
 * The one thing that cannot be seen: a company reporting after yesterday's
 * close. The veto catches SCHEDULED earnings, but an overnight move on news is
 * invisible to every detector here, because all of them read a bar that closed
 * before it happened. `moved_since_bar` reports it per name.
 *
 * Run:  node scripts/morning-screen.js [--pre-gate 15] [--per-scanner 5]
 *                                      [--no-draw] [--no-watchlist] [--no-analysis]
 *                                      [--dry-run] [--out-dir reports]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as S from '../src/core/structure.js';
import { scan, tickerQuote, FACTOR_COLUMNS, LIQUIDITY_FILTER, DEFAULT_UNIVERSE, UNIVERSES, movedSinceBar, offHighPct, daysToEarnings } from '../src/core/scanner.js';
import { SCREENS, INTRADAY_SCREENS } from '../src/core/screens.js';
import { eligibleScreens, runScreen, gateAndSelect, assignTiers, strategiesForScreen, PRE_GATE, PER_SCANNER } from '../src/core/morning_routine.js';
import { SECTION_FOR, MANAGED_SECTIONS, KEEP_PREFIX } from '../src/core/tier_classify.js';
import { timeframeFor } from '../src/core/timeframe_policy.js';
import { analyzeTicker } from '../src/core/ticker_analyze.js';
import { rewrite, listContents, refreshPanel, buildSectioned, parseSections } from '../src/core/watchlist_rewrite.js';
import { removeOrphans } from '../src/core/orphans.js';
import * as drawing from '../src/core/drawing.js';
import { scannerTrust } from '../src/core/session.js';
import { allFactors } from '../src/core/factors.js';
import { requiredColumns } from '../src/core/screen_check.js';
import { fetchGroupRows } from '../src/core/groups.js';
import * as ta from '../src/core/ta_api.js';
import { acquireChartLock } from '../src/core/chart_lock.js';

export const SCHEMA_VERSION = '3.0';   // 2.x merged first and measured after; 1.x had one flat section
const WATCHLIST_NAME = 'Swing Opportunities';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const PRE = Number(argVal('--pre-gate', String(PRE_GATE)));
const PER = Number(argVal('--per-scanner', String(PER_SCANNER)));
const DRAW = !args.includes('--no-draw');
const ANALYSE = !args.includes('--no-analysis');
const WRITE_LIST = !args.includes('--no-watchlist');
const DRY = args.includes('--dry-run');
const OUT_DIR = argVal('--out-dir', 'reports');
const MIN_BARS = 60;

/** What the last run wrote, for diffing. NOT a rebalance stamp — see the write. */
const STATE_PATH = join(OUT_DIR, '.screen-state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const bare = (s) => String(s).replace(/^.*:/, '');

/** How many symbols still had a forming bar when we read them. */
let partialsDropped = 0;

/**
 * Only ONE process may drive the chart at a time — see `src/core/chart_lock.js`
 * for the two runs that interleaved and what it cost.
 *
 * The lock used to live here, keyed on `--out-dir`, which meant two runs invoked
 * with different output directories each took their own and interleaved anyway.
 * It is now shared and its path is fixed, so the Sunday review, clear-orphans and
 * the six measurement scripts behind `_real_bars.js` exclude this run too.
 */
mkdirSync(OUT_DIR, { recursive: true });
acquireChartLock({ label: 'morning-screen' });

log(`Morning screen — schema ${SCHEMA_VERSION}`);
log(`  universe: ${DEFAULT_UNIVERSE.map((u) => UNIVERSES[u].name).join(' + ')}`);
log(`  gate: top ${PRE} per scanner in, top ${PER} survivors out`);

// ── stage 1: the scanners ───────────────────────────────────────────────────
const { eligible, skipped: skippedScreens, trust: screenTrust } = eligibleScreens();
for (const s of skippedScreens) log(`  ${s.key.padEnd(24)} SKIPPED — ${s.why}`);

const screenResults = [];
for (const s of eligible) {
  const r = await runScreen(s);
  screenResults.push(r);
  log(`  ${r.key.padEnd(24)} ${String(r.raw).padStart(5)} raw -> ${String(r.refined).padStart(4)} refined`
    + (s.post ? ` -> ${String(r.rows.length).padStart(4)} after cross-row step` : ''));
}

// ── stage 2: OUR detectors, before anything is selected ─────────────────────
//
// The chart is driven here, one symbol at a time, so the lock above is already
// held. Bars are cached: a symbol appearing in four screens is loaded once, and
// the same series is handed to the full analysis later rather than re-fetched.
const seriesCache = new Map();
async function loadBars(symbol) {
  if (seriesCache.has(symbol)) return seriesCache.get(symbol).bars;
  await chart.setSymbol({ symbol });
  await sleep(350);
  const st = await chart.getState();
  if (String(st.resolution) !== '1D') { await chart.setTimeframe({ timeframe: '1D' }); await sleep(350); }
  const series = await data.getOhlcv({ count: 400, summary: false });
  /**
   * Drop the forming bar. This runs 05:30 PT — an hour before the open — so
   * "today" is an extended-hours stub carrying perhaps 15% of its eventual
   * volume. Every detector below reads highs, lows and ranges.
   */
  const { bars, partial_bar } = S.completeSeries(series);
  if (partial_bar) partialsDropped += 1;
  if (!bars.length) throw new Error('no bars returned');
  if (bars.length < MIN_BARS) throw new Error(`only ${bars.length} bars (need ${MIN_BARS})`);
  const ranged = bars.filter((b) => b.high > b.low).length;
  if (ranged / bars.length < 0.5) throw new Error('no intraday range — not a tradable chart');
  seriesCache.set(symbol, { series, bars });
  return bars;
}

const before = await chart.getState();
const original = before?.symbol || null;

const uniqueIn = new Set(screenResults.flatMap((r) => r.rows.slice(0, PRE).map((x) => x.symbol)));
log(`\n  gating ${uniqueIn.size} unique symbol(s) with assess() + ourAssessment()...`);
const { perScreen, gated } = await gateAndSelect(screenResults, loadBars, {
  pre_gate: PRE,
  per_scanner: PER,
  onProgress: ({ done, total, symbol, passed }) => {
    if (done % 10 === 0 || done === total) process.stdout.write(`    ${done}/${total}\r`);
    if (!passed && done <= 0) log(`    ${symbol} rejected`);
  },
});
log(`    ${gated.size}/${gated.size} gated          `);
for (const r of screenResults) {
  const p = perScreen[r.key];
  log(`  ${r.key.padEnd(24)} ${String(p.gated).padStart(3)} gated -> ${String(p.passed).padStart(3)} passed`
    + ` -> ${p.selected.length} selected: ${p.selected.map((x) => bare(x.symbol)).join(' ') || '—'}`);
}

// ── stage 3: one execution tier per survivor ────────────────────────────────
const { tiers, unclassified } = assignTiers(perScreen);
log('');
for (const t of ['intraday', 'weekly', 'monthly']) {
  log(`  ${SECTION_FOR[t].padEnd(9)} ${tiers[t].length}: ${tiers[t].map((x) => bare(x.symbol)).join(' ') || '—'}`);
}
if (unclassified.length) {
  log(`  UNCLASSIFIED ${unclassified.length}: ${unclassified.map((u) => bare(u.symbol)).join(' ')}`);
  for (const u of unclassified) log(`      ${bare(u.symbol)}: ${u.why}`);
}

// ── tier A factors ──────────────────────────────────────────────────────────
//
// ── There is NO rebalance clock on the watchlist. This is deliberate. ──
//
// There used to be one, inherited from the Weeks/Months design, and it was wrong
// twice over. It made MONTHLY carry forward on days it was "not due", holding the
// twelve names the DELETED 2.x merge had chosen, on a timestamp that run had
// stamped — so the section refused to update and cited its own predecessor as the
// reason.
//
// The deeper error is the concept. INTRADAY / WEEKLY / MONTHLY is an EXECUTION
// split: how long a trade in that name is expected to be held. It is not a
// refresh cadence. And this is a WATCHLIST — a list of candidates to look at.
// Putting a name on it places no trade and costs nothing. The turnover arithmetic
// that justifies a monthly clock (252 round trips a year, 50.4% drag at 20bps
// against MAD's ~9% gross) is about HOLDING POSITIONS, and it still applies to
// holding them. It never applied to refreshing a list of things to look at.
//
// So all three managed sections are rebuilt every run, which is what the owner
// asked for.
const currentList = await listContents(WATCHLIST_NAME).catch((e) => {
  log(`\n  could not read "${WATCHLIST_NAME}": ${e.message}`);
  return [];
});

/**
 * The factors are still a MONTHLY cross-sectional sort — that is how each was
 * measured — but computing one costs a single scan and changes nothing about
 * turnover. They are used to ORDER the monthly tier, never to select it, and
 * ordering a list produces no trades.
 *
 * The scan is deliberately broad and barely filtered: a decile taken over a
 * screen's survivors is a decile of an already-selected population, which is not
 * the cross-section any of these papers sorted.
 */
let factors = null;
try {
  const fs = await scan({ filter: LIQUIDITY_FILTER, columns: FACTOR_COLUMNS, range: [0, 2000] });
  const vixQuote = await tickerQuote('CBOE:VIX');
  factors = allFactors(fs.rows, { vix: vixQuote });
  log(`\n  Tier A factors over ${fs.rows.length} names (VIX ${vixQuote ?? 'unknown'})`);
  const mad = factors.months.moving_average_distance;
  log(`    MAD top decile ${mad.long_side.length} names, bottom ${mad.short_side.length}`);
  if (!screenTrust.volume_fields_usable) {
    // The premium ranks on relative_volume_10d_calc, which reflects a fraction of
    // a day until the close. Ranking on it now inverts the sort.
    log(`    high-volume premium SUPPRESSED — ${screenTrust.reason}`);
    factors.months.high_volume_premium.suppressed = true;
    factors.months.high_volume_premium.suppressed_reason = screenTrust.reason;
  }
  // ORDERING ONLY: top-decile MAD names first, the rest behind them in gate order.
  const madTop = new Set(mad.long_side.map((r) => r.symbol ?? r.name));
  const inTop = (s) => madTop.has(s) || madTop.has(bare(s));
  tiers.monthly.sort((a, b) => (inTop(b.symbol) ? 1 : 0) - (inTop(a.symbol) ? 1 : 0));
} catch (e) {
  log(`  factors FAILED: ${e.message}`);
}

// ── stage 4: the watchlist ──────────────────────────────────────────────────
//
// Written BEFORE the analysis, because the analysis is defined as "every ticker
// in each managed section" — the list decides what gets analysed, not the other
// way round. Symbols under a KEEP* section are never touched: not rewritten, not
// analysed, not cleared.
// All three are rebuilt from today's survivors. `buildSectioned` still supports
// `null` for "carry this section forward untouched" and it is still tested, but
// nothing here passes it — see the tier-A block above for why the clock is gone.
const sectionsToWrite = [
  { name: SECTION_FOR.intraday, symbols: tiers.intraday.map((x) => x.symbol) },
  { name: SECTION_FOR.weekly, symbols: tiers.weekly.map((x) => x.symbol) },
  { name: SECTION_FOR.monthly, symbols: tiers.monthly.map((x) => x.symbol) },
];
const built = buildSectioned(currentList, { sections: sectionsToWrite, keep_prefix: KEEP_PREFIX });
for (const name of MANAGED_SECTIONS) log(`  ${name.padEnd(9)} -> ${built.sections[name].length} name(s)`);
if (built.carried_forward.length) log(`  carried forward untouched: ${built.carried_forward.join(', ')}`);
if (built.preserved_sections.length) {
  log(`  preserving ${built.preserved_sections.map((s) => `${s.name}(${s.count})`).join(', ')} — never rewritten, never analysed`);
}
if (built.dropped_sections.length) {
  log(`  WARNING dropping section(s): ${built.dropped_sections.map((s) => `${s.name}(${s.count})`).join(', ')}`);
}
if (built.orphaned_default.length) {
  log(`  WARNING ${built.orphaned_default.length} symbol(s) sat above the first header and will be dropped: `
    + built.orphaned_default.map(bare).join(' '));
}

let writeResult = null;
if (WRITE_LIST) {
  try {
    writeResult = await rewrite({ name: WATCHLIST_NAME, symbols: built.entries, dry_run: DRY });
    log(`  watchlist "${WATCHLIST_NAME}": ${writeResult.dry_run
      ? `DRY RUN — would write ${writeResult.would_write} (currently ${writeResult.currently})`
      : `wrote ${writeResult.entries_after} (was ${writeResult.entries_before}), backup ${writeResult.backup}`}`);

    // The panel caches and nothing invalidates it on a REST write. The app is
    // open during EVERY run — the MCP writes by running JS inside the page — so
    // without this the list reads stale every single morning.
    if (!writeResult.dry_run) {
      const p = await refreshPanel({ expect: writeResult.entries_after });
      log(`  panel refresh: ${p.success ? `${p.rows} rows after ${Math.round(p.waited_ms / 1000)}s` : p.note}`);
      /**
       * What was written, so a later run can diff it. NOT a rebalance stamp — the
       * previous version wrote `months_last_rebalance` here and then read it back
       * the next morning to decide whether MONTHLY was allowed to change, which is
       * how a section came to hold twelve names chosen by a pipeline that no longer
       * exists and to cite its own stale timestamp as the reason.
       */
      writeFileSync(STATE_PATH, JSON.stringify({
        last_run: new Date().toISOString(),
        sections: built.sections,
        schema_version: SCHEMA_VERSION,
      }, null, 2), 'utf8');
    }
  } catch (e) {
    log(`  watchlist FAILED: ${e.message}`);
    writeResult = { error: e.message };
  }
} else {
  log('  watchlist skipped (--no-watchlist)');
}

// ── clear the charts of names that dropped OUT of the list ──────────────────
//
// The watchlist is rewritten every morning, so names drop off it. Their charts
// still carry yesterday's drawings and nothing would ever clean them: the run
// only clears charts it is about to draw on, and tomorrow it will not visit a
// name that fell out. A name that appears once keeps its drawings forever.
//
// Cleared by TEXT SIGNATURE, never by entity id: ids die with the TradingView
// session and this runs daily, which is exactly how 545 stale shapes
// accumulated across 45 charts before.
const analysisSet = MANAGED_SECTIONS.flatMap((name) => built.sections[name] || []);
if (DRAW) {
  const parsed = parseSections(currentList);
  const keptSyms = new Set(parsed.sections
    .filter((s) => s.name.toUpperCase().startsWith(KEEP_PREFIX))
    .flatMap((s) => s.symbols));
  if (keptSyms.size) log(`\n  ${keptSyms.size} symbol(s) in ${KEEP_PREFIX}* — left untouched`);

  const previousHeld = [
    ...parsed.default,
    ...parsed.sections.filter((s) => !s.name.toUpperCase().startsWith(KEEP_PREFIX)).flatMap((s) => s.symbols),
  ];
  const todays = new Set(analysisSet);
  const dropped = previousHeld.filter((s) => !todays.has(s) && !keptSyms.has(s));
  if (dropped.length) {
    log(`  clearing ${dropped.length} chart(s) dropping out of the list...`);
    let tracked = 0;
    let orphaned = 0;
    for (const sym of dropped) {
      try {
        await chart.setSymbol({ symbol: sym }); await sleep(300);
        /**
         * TWO passes, and the second alone was doing nothing.
         *
         * This called `removeOrphans` only — which by definition removes shapes that
         * are NOT in the registry. Yesterday's drawings ARE in it (the registry
         * persists across processes), so every one of them was classified `tracked`,
         * skipped, and the run logged "removed 0 stale shape(s)" while leaving them
         * all in place. Verified on ALM: dropped out of the list, still carrying all
         * 22 shapes from the previous run, cleanup reported success.
         *
         * That is precisely the unbounded leak this block exists to prevent — the
         * next run will not visit a name that fell off the list, so its drawings
         * would survive forever.
         *
         * `clearAll({scope:'mcp'})` takes the tracked ones; `removeOrphans` still
         * takes anything whose registry entry died with an old TradingView session.
         * Neither touches a drawing made by hand.
         */
        const c = await drawing.clearAll({ scope: 'mcp' });
        tracked += c.removed || 0;
        const r = await removeOrphans({ dry_run: false, sources: ['review'] });
        orphaned += r.removed || 0;
      } catch (e) { log(`    ${sym}: ${e.message}`); }
    }
    log(`  removed ${tracked} tracked + ${orphaned} orphaned shape(s) from dropped names`);
  } else if (previousHeld.length) {
    log(`  no names dropped out of "${WATCHLIST_NAME}"`);
  }
}

// ── stage 5: the FULL unified analysis, on everything written ───────────────
//
// `analyzeTicker` is the ONE analysis workflow — the same call the interactive
// path makes. It clears the chart, runs all 44 contract sections and draws the
// geometry. Anything it skips comes back in `completeness.missing` with a reason.
//
// `shared` carries what is identical across the batch. Without it each symbol
// would repeat two 2000-row scanner round trips and a TA call, and reload bars
// this run already has in `seriesCache`.
const tickers = [];
let sharedCtx = null;
if (ANALYSE && analysisSet.length) {
  log(`\n  fetching the batch-shared data once (scanner, groups, TA, SPY)...`);
  const shared = {};
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
    shared.ta_context = await ta.tradingContext({ symbols: analysisSet.map(bare) });
    log(`    TA context: ${shared.ta_context?.held?.length ?? 0} held, ${shared.ta_context?.earnings?.length ?? 0} earnings`);
  } catch (e) { log(`    TA context FAILED: ${e.message}`); }
  try {
    // The WHOLE book, separately from the per-symbol context. `tradingContext`
    // filters `held` to the symbols asked for, which is right for "do I own this"
    // and wrong for portfolio heat — a cross-position quantity computed from one
    // position is not a smaller answer, it is a wrong one.
    shared.portfolio_response = await ta.portfolio();
    const n = shared.portfolio_response?.data?.positions?.length ?? 0;
    const eq = shared.portfolio_response?.data?.summary?.total_value_usd;
    log(`    TA portfolio ${n} positions, equity ${eq ? `$${Math.round(eq).toLocaleString()}` : 'unknown'} (for heat across the book)`);
  } catch (e) { log(`    TA portfolio FAILED: ${e.message}`); }
  try {
    // Relative strength needs a compared-to-what. Fetched once for the batch;
    // without it assess() returns a relative_strength block with every field null.
    await chart.setSymbol({ symbol: 'AMEX:SPY' }); await sleep(600);
    shared.benchmark_bars = S.completeSeries(await data.getOhlcv({ count: 400, summary: false })).bars;
    shared.benchmark_symbol = 'AMEX:SPY';
    log(`    SPY ${shared.benchmark_bars.length} bars`);
  } catch (e) { log(`    SPY FAILED: ${e.message}`); }
  sharedCtx = {
    scanner_rows: !!shared.scanner_rows, group_rows: !!shared.group_rows,
    ta_context: !!shared.ta_context, benchmark_bars: !!shared.benchmark_bars,
  };

  const tierOf = (sym) => MANAGED_SECTIONS.find((n) => (built.sections[n] || []).includes(sym)) || null;
  const gatedBySymbol = gated;
  let n = 0;
  for (const sym of analysisSet) {
    n += 1;
    const g = gatedBySymbol.get(sym) || null;
    const cached = seriesCache.get(sym) || null;
    process.stdout.write(`  [${n}/${analysisSet.length}] ${String(tierOf(sym)).padEnd(9)} ${bare(sym).padEnd(6)} ... `);
    const row = {
      symbol: sym,
      section: tierOf(sym),
      /**
       * A carried-forward MONTHLY name has no gate result from today. Its fields
       * are null rather than invented — it is here because of a ranking taken at
       * the last rebalance, and saying otherwise would be a fiction.
       */
      carried_forward: !g,
      screens: g?.screens ?? null,
      confluence: g?.screens?.length ?? null,
      gate: g ? { passed: g.stage2.passed, why: g.stage2.why, score: g.stage2.score, bias: g.stage2.bias, conviction: g.stage2.conviction } : null,
      tier_basis: [...tiers.intraday, ...tiers.weekly, ...tiers.monthly].find((x) => x.symbol === sym)?.tier_basis ?? null,
      scanner: g?.row ? {
        close: g.row.close, perf_1m: g.row['Perf.1M'], perf_3m: g.row['Perf.3M'],
        perf_6m: g.row['Perf.6M'], perf_y: g.row['Perf.Y'], rsi: g.row.RSI,
        volatility_d: g.row['Volatility.D'], sector: g.row.sector,
        off_52w_high_pct: offHighPct(g.row), days_to_earnings: daysToEarnings(g.row),
        dollar_volume: r2((g.row.close ?? 0) * (g.row.average_volume_10d_calc ?? 0), 0),
      } : null,
      status: 'ok', error: null, analysis: null, moved_since_bar: null,
    };
    try {
      // The chart must be on the symbol: analyzeTicker reads the CURRENT chart to
      // learn which symbol it is analysing, and drawFindings draws on it.
      await chart.setSymbol({ symbol: sym }); await sleep(400);

      /**
       * ── The analysis timeframe follows the TIER ──
       *
       * Everything used to be analysed on the daily, intraday candidates included.
       * An intraday setup is a shape inside a session, and on a daily chart the
       * whole session is one bar — so it was not merely hard to see, it was not
       * representable, and every level and pattern drawn for an INTRADAY name
       * described a horizon that name would never be held for.
       *
       * The gate above stays on DAILY on purpose: the screens are daily, so "is this
       * name worth looking at" is a daily question. Only the per-ticker analysis
       * moves to the tier's own chart.
       */
      const policy = timeframeFor(String(tierOf(sym) || '').toLowerCase());
      let bars = cached?.bars;
      let series = seriesCache.get(sym)?.series ?? null;
      const onDaily = policy.analysis === '1D';

      if (!onDaily) {
        await chart.setTimeframe({ timeframe: policy.analysis }); await sleep(900);
        /**
         * A fresh 5-minute chart holds 300 bars — TWO SESSIONS. Without this the
         * intraday analysis would read less history than the daily one it replaced,
         * which is a worse answer wearing a better label.
         */
        const hist = await chart.loadHistory({ min_bars: policy.bars });
        const s = await data.getOhlcv({ count: policy.bars, max: policy.bars, summary: false });
        const trimmed = S.completeSeries(s);
        bars = trimmed.bars;
        series = s;
        row.timeframe_history = { loaded: hist.bars, requested: policy.bars, exhausted: !!hist.exhausted };
      }
      if (!bars) { bars = await loadBars(sym); series = seriesCache.get(sym)?.series ?? null; }
      row.timeframe = { analysis: policy.analysis, label: policy.analysis_label, context: policy.context, bars: bars.length };

      const r = await analyzeTicker({
        draw: DRAW,
        shared: { ...shared, series, bars },
        /**
         * NARROWER than the interactive default, deliberately.
         *
         * `analyzeTicker` defaults to `scope: 'all'` — the owner's rule for an
         * analysis, and right when somebody is watching one chart. This run is
         * unattended at 05:30 and walks twenty machine-selected charts; 'all' would
         * delete a walls overlay or anything hand-drawn there with nobody present to
         * be asked. 'mcp' still clears this script's own work, by TEXT signature,
         * which survives the session restart that kills every entity id — that is
         * what the second pass in drawFindings is for. Charts the owner wants left
         * entirely alone go in a KEEP* section, which is never analysed.
         */
        clear_scope: 'mcp',
      });
      row.analysis = r;
      // Back to daily before the next symbol. loadBars() checks the resolution and
      // would fix it anyway, but leaving the chart on 5-minute makes any failure in
      // between read as a daily measurement of intraday bars.
      if (!onDaily) { await chart.setTimeframe({ timeframe: '1D' }); await sleep(600); }
      // The scanner's `close` and the chart's last bar should agree pre-open. When
      // they do not, price has already left the bar every detector read.
      row.moved_since_bar = g?.row
        ? movedSinceBar({ close: bars.at(-1).close }, g.row.close, r.atr ?? null)
        : null;
      const c = r.completeness;
      log(`${r.verdict?.bias ?? '?'} ${c.required_done}/${c.required_total}`
        + `${r.drawings?.shapes != null ? ` (${r.drawings.shapes} drawn)` : ''}`
        + `${c.complete ? '' : ` MISSING: ${c.missing.map((m) => m.section).join(',')}`}`);
    } catch (e) {
      row.status = 'failed'; row.error = e.message;
      log(`FAILED (${e.message})`);
    }
    tickers.push(row);
  }
} else if (!ANALYSE) {
  log('\n  analysis skipped (--no-analysis)');
}

if (original) { try { await chart.setSymbol({ symbol: original }); await sleep(400); } catch { /* leave */ } }

// ── output ──────────────────────────────────────────────────────────────────
const ok = tickers.filter((t) => t.status === 'ok');
const stamp = new Date().toISOString().slice(0, 10);

const allScreens = [...SCREENS, ...INTRADAY_SCREENS];
const byKey = Object.fromEntries(screenResults.map((r) => [r.key, r]));

const report = {
  schema_version: SCHEMA_VERSION,
  generated_at: new Date().toISOString(),
  kind: 'morning-screen',
  universe: DEFAULT_UNIVERSE.map((u) => UNIVERSES[u].name),
  pipeline: {
    order: ['scanners', 'our detectors', 'top N survivors per scanner', 'tier classification',
      'watchlist rewrite (KEEP untouched)', 'full unified analysis', 'report'],
    pre_gate: PRE,
    per_scanner: PER,
    why: 'The detectors run BEFORE the per-scanner cut. In 2.x the merge chose the twenty names and '
      + 'the detectors described them afterwards, which inverts "TV scanner as coarse filter, our '
      + 'detectors as verdict".',
  },
  ...(skippedScreens.length ? { screens_skipped: skippedScreens } : {}),
  screens: allScreens.map((s) => {
    const r = byKey[s.key];
    const p = perScreen[s.key];
    return {
      key: s.key, name: s.name, direction: s.direction, bet: s.bet,
      horizon_side: s.horizon_side, evidence: s.evidence,
      strategies: strategiesForScreen(s.key),
      // A screen skipped for its session never ran, so it has no result.
      // `candidates: 0` would read as "ran and found nothing" — null means NOT RUN.
      candidates: r ? r.rows.length : null,
      ...(r ? {} : { skipped: true }),
      ...(p ? {
        gated: p.gated,
        passed_gate: p.passed,
        selected: p.selected.map((x) => x.symbol),
        rejected: p.rejected,
      } : {}),
    };
  }),
  gate: {
    unique_symbols_gated: gated.size,
    passed: [...gated.values()].filter((g) => g.stage2.passed).length,
    what_can_reject: ['market_regime.tradeable (efficiency vs the random-walk baseline)',
      'ourAssessment().tradeable', 'bars that will not load or are too short'],
    what_deliberately_does_not: [
      'pattern presence — 68% of random walks contain one, and the screens already select for shape',
      'stage_plan alignment — forward-tested NEGATIVE as a gate, long 33.5% vs a 36.4% baseline',
      'two-leader group agreement — measured to cost 9.3 points of win rate',
    ],
  },
  tiers: {
    rule: 'The tier comes from the STRATEGY, not the screen. Best evidence tier wins; a tie takes the '
      + 'LONGER horizon, because below ~21 trading days the documented effect is reversal and these are '
      + 'continuation bets. REJECTED strategies never decide a tier.',
    intraday: tiers.intraday.map((x) => ({ symbol: x.symbol, from: x.tier_from, screens: x.from_screens })),
    weekly: tiers.weekly.map((x) => ({ symbol: x.symbol, from: x.tier_from, screens: x.from_screens })),
    monthly: tiers.monthly.map((x) => ({ symbol: x.symbol, from: x.tier_from, screens: x.from_screens })),
    unclassified,
  },
  watchlist: {
    name: WATCHLIST_NAME,
    sections: built.sections,
    carried_forward: built.carried_forward,
    preserved: built.preserved_sections,
    dropped: built.dropped_sections,
    orphaned_default: built.orphaned_default,
    write: writeResult,
    keep_rule: `Any section whose name begins with ${KEEP_PREFIX} is carried through untouched — not `
      + 'rewritten, not analysed, and its charts are not cleared. Moving a ticker into a KEEP section in '
      + 'TradingView is how you tell this run to leave it alone.',
  },
  cadence: {
    watchlist: 'EVERY managed section is rebuilt every run. There is no rebalance clock on the '
      + 'watchlist, and the one that used to be here was wrong twice: it made MONTHLY carry forward '
      + 'the names a now-deleted pipeline had chosen and cite that pipeline\'s own timestamp as the '
      + 'reason, and the concept did not apply in the first place. INTRADAY/WEEKLY/MONTHLY is an '
      + 'EXECUTION split — how long a trade is held — not a refresh rate.',
    where_turnover_actually_applies: 'HOLDING a position. Daily reranking of a monthly factor is 252 '
      + "round trips a year, 50.4% drag at 20bps against MAD's ~9% gross — that is an argument about "
      + 'the portfolio, not about how often to refresh a list of names to look at. Adding a name to a '
      + 'watchlist places no trade and costs nothing. See turnover_cost.',
    factors: 'Tier A factors are a monthly cross-sectional sort and are computed every run because '
      + 'computing one is a single scan. They ORDER the monthly tier; they never select it.',
  },
  counts: { in_watchlist: analysisSet.length, analysed: ok.length, failed: tickers.length - ok.length },
  /**
   * Two different defects, two different remedies.
   *
   * The bar series we fetch per symbol CAN be trimmed, and is — `partials_dropped`
   * counts it. The scanner fields TradingView computes server-side CANNOT be:
   * there is no bar array to cut, so all that is left is to say which fields are
   * unsafe and let the reader discount them.
   */
  bar_hygiene: {
    partials_dropped: partialsDropped,
    note: partialsDropped
      ? `Dropped a still-forming daily bar on ${partialsDropped} of ${seriesCache.size} symbols.`
      : 'No forming bars — every symbol read a finished session.',
    scanner: screenTrust,
  },
  batch_shared: sharedCtx,
  tier_a_factors: factors
    ? { computed_at_rebalance: true, ...factors }
    : { computed_at_rebalance: false, why: 'Factors are monthly sorts and are computed only when MONTHLY rebalances.' },
  completeness_summary: ok.reduce((m, t) => {
    const c = t.analysis?.completeness;
    if (!c) return m;
    return { ...m, [c.complete ? 'complete' : 'incomplete']: (m[c.complete ? 'complete' : 'incomplete'] || 0) + 1 };
  }, {}),
  our_bias_summary: ok.reduce((m, t) => {
    const b = t.analysis?.verdict?.bias;
    return b ? { ...m, [b]: (m[b] || 0) + 1 } : m;
  }, {}),
  tickers,
  not_advice: 'Arithmetic on measured values. Nothing here is trade advice.',
};

const jsonPath = join(OUT_DIR, `morning-screen-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
/**
 * A stable path alongside the dated one, so "the latest screen" can be read
 * without globbing the directory and parsing dates — which gets it wrong on the
 * first holiday, when the newest file is not yesterday's.
 *
 * Local only. The morning report is NOT sent to TA; TA is the master system for
 * investing and this is the trading layer reading it, not writing to it.
 */
const latestPath = join(OUT_DIR, 'morning-screen-latest.json');
writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');
log(`\n  ${jsonPath}`);
log(`  ${latestPath} (stable path for consumers)`);
log(`  analysed ${ok.length}/${tickers.length}`);
log(`  completeness: ${JSON.stringify(report.completeness_summary)}`);
log(`  our bias: ${JSON.stringify(report.our_bias_summary)}`);

process.exit(0);
