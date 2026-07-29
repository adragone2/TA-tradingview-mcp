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
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as S from '../src/core/structure.js';
import { scan, tickerQuote, BASE_COLUMNS, FACTOR_COLUMNS, LIQUIDITY_FILTER, DEFAULT_UNIVERSE, UNIVERSES, movedSinceBar, offHighPct, daysToEarnings } from '../src/core/scanner.js';
import { SCREENS, mergeByConfluence, DEFAULT_SLOTS } from '../src/core/screens.js';
import { assess, ourAssessment } from '../src/core/assessment.js';
import { drawFindings } from '../src/core/assessment_draw.js';
import { rewrite, listContents, refreshPanel, buildBucketed, sectionSymbols, parseSections } from '../src/core/watchlist_rewrite.js';
import { removeOrphans } from '../src/core/orphans.js';
import { scannerTrust } from '../src/core/session.js';
import { BUCKETS, DEFAULT_BUCKET_SLOTS, rebalanceDue, applyHysteresis, routeToBuckets } from '../src/core/cadence.js';
import { allFactors } from '../src/core/factors.js';

export const SCHEMA_VERSION = '2.0';   // 1.x had one flat section and a daily rerank of everything
const WATCHLIST_NAME = 'Swing Opportunities';
// Any section whose name starts with KEEP survives untouched — not removed from
// the list, and its charts are not cleared. Moving a ticker into KEEP in
// TradingView is how you tell this run to leave it alone. Prefix rather than an
// exact name so the existing plain "KEEP" and a later "KEEP weeks" both work.
const KEEP_PREFIX = 'KEEP';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const TOP = Number(argVal('--top', '20'));
const DRAW = !args.includes('--no-draw');
const WRITE_LIST = !args.includes('--no-watchlist');
const DRY = args.includes('--dry-run');
const OUT_DIR = argVal('--out-dir', 'reports');
const MIN_BARS = 60;
/** Rebalance the Months bucket even if the calendar says it is not due. */
const FORCE_MONTHS = args.includes('--force-months');

/**
 * Where the last Months rebalance is recorded.
 *
 * The Months bucket turns over monthly, so the run has to remember when it last
 * did. Without this every morning would look like "no prior rebalance" and the
 * cadence fix would do nothing at all.
 */
const STATE_PATH = join(OUT_DIR, '.screen-state.json');
const loadState = () => {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { return {}; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** How many symbols still had a forming bar when we read them. */
let partialsDropped = 0;

/** Same guards as the Sunday review: not every symbol is a chart. */
async function loadSymbol(symbol) {
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

// ── horizon buckets and their two different clocks ──────────────────────────
//
// MAD, the trend factor and the high-volume premium are MONTHLY cross-sectional
// sorts — that is how they were measured, and MAD's ~9% survives costs at that
// cadence. Reranking them every weekday is ~252 round trips a year: 50.4% drag
// at 20bps, or 5.6x the entire effect. So Months moves once a month, with a
// hysteresis band, and Weeks rebuilds daily because reversal decays in days.
const state = loadState();
const currentList = await listContents(WATCHLIST_NAME).catch((e) => {
  log(`  could not read "${WATCHLIST_NAME}": ${e.message}`);
  return [];
});
const heldMonths = sectionSymbols(currentList, BUCKETS.MONTHS.section);

const routed = routeToBuckets(merged.candidates);
if (routed.unrouted.length) {
  log(`  WARNING ${routed.unrouted.length} candidate(s) matched no bucketed screen and were dropped`);
}

const monthsDue = rebalanceDue('MONTHS', {
  now: Date.now(), last_run_iso: state.months_last_rebalance ?? null, force: FORCE_MONTHS,
});

/**
 * Tier A factors — computed ONLY at the monthly rebalance, because that is the
 * cadence every one of them was measured at.
 *
 * The scan is deliberately broad and barely filtered: a decile taken over a
 * screen's survivors is a decile of an already-selected population, which is
 * not the cross-section any of these papers sorted.
 */
let factors = null;
const trust = scannerTrust();
if (monthsDue.due) {
  const fs = await scan({ filter: LIQUIDITY_FILTER, columns: FACTOR_COLUMNS, range: [0, 2000] });
  const vixQuote = await tickerQuote('CBOE:VIX');
  factors = allFactors(fs.rows, { vix: vixQuote });
  log(`\n  Tier A factors over ${fs.rows.length} names (VIX ${vixQuote ?? 'unknown'})`);

  const mad = factors.months.moving_average_distance;
  log(`    MAD top decile ${mad.long_side.length} names, bottom ${mad.short_side.length}`);
  if (!trust.volume_fields_usable) {
    // The premium ranks on relative_volume_10d_calc, which reflects a fraction
    // of a day until the close. Ranking on it now inverts the sort.
    log(`    high-volume premium SUPPRESSED — ${trust.reason}`);
    factors.months.high_volume_premium.suppressed = true;
    factors.months.high_volume_premium.suppressed_reason = trust.reason;
  }

  // MAD is the strongest Months signal we have, so it reorders the bucket's
  // ranking before hysteresis: top-decile names first, the rest behind them in
  // their existing screen order.
  const madTop = new Set(mad.long_side.map((r) => r.symbol ?? r.name));
  routed.MONTHS.sort((a, b) => {
    const av = madTop.has(a.symbol) || madTop.has(a.symbol.replace(/^.*:/, '')) ? 1 : 0;
    const bv = madTop.has(b.symbol) || madTop.has(b.symbol.replace(/^.*:/, '')) ? 1 : 0;
    return bv - av;
  });
}

let hysteresis = null;
let monthsSel;
if (monthsDue.due) {
  hysteresis = applyHysteresis({
    ranked: routed.MONTHS.map((c) => c.symbol),
    held: heldMonths,
    slots: DEFAULT_BUCKET_SLOTS.MONTHS,
    exit_multiple: BUCKETS.MONTHS.exit_multiple,
  });
  monthsSel = hysteresis.selected;
  log(`\n  MONTHS rebalancing — ${monthsDue.reason}`);
  log(`    kept ${hysteresis.survived.length}, added ${hysteresis.added.length}, ejected ${hysteresis.ejected.length}`
    + ` (enter top ${hysteresis.band.entry_rank}, exit past ${hysteresis.band.exit_rank},`
    + ` ${hysteresis.turnover.names_saved} name(s) saved vs a naive rerank)`);
} else {
  // Untouched. This is the point of the fix, not an error path.
  monthsSel = heldMonths;
  log(`\n  MONTHS held — ${monthsDue.reason} (${monthsSel.length} name(s) carried forward)`);
}

const weeksSel = routed.WEEKS.map((c) => c.symbol).slice(0, DEFAULT_BUCKET_SLOTS.WEEKS);
log(`  WEEKS rebuilt daily — ${weeksSel.length} name(s)`);

/**
 * Everything analysed this run: the Weeks selection plus whatever Months holds.
 * Carried-forward Months names have no scanner row from today, so they analyse
 * on bars alone — which is the honest thing, since the reason they are here is
 * a ranking taken at the last rebalance, not this morning's numbers.
 */
const bySymbol = new Map(merged.candidates.map((c) => [c.symbol, c]));
const selection = [...monthsSel, ...weeksSel].map((sym) => ({
  symbol: sym,
  bucket: monthsSel.includes(sym) ? 'MONTHS' : 'WEEKS',
  candidate: bySymbol.get(sym) || null,
}));

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
  // Symbols in a KEEP section are OFF LIMITS: they stay in the list and their
  // drawings stay on the chart. Section headers ("###KEEP") are entries in the
  // same flat array and are never symbols.
  const parsed = parseSections(currentList);
  const keptSyms = new Set(parsed.sections
    .filter((s) => s.name.toUpperCase().startsWith(KEEP_PREFIX))
    .flatMap((s) => s.symbols));
  if (keptSyms.size) log(`  ${keptSyms.size} symbol(s) in ${KEEP_PREFIX}* — left untouched`);

  /**
   * Everything the list held yesterday, from EVERY non-KEEP section plus the
   * old flat default — that last one matters on the first run after this
   * change, when the entire previous list lives in the default section and
   * would otherwise keep its drawings forever.
   */
  const previousHeld = [
    ...parsed.default,
    ...parsed.sections.filter((s) => !s.name.toUpperCase().startsWith(KEEP_PREFIX)).flatMap((s) => s.symbols),
  ];
  const todays = new Set(selection.map((c) => c.symbol));
  const dropped = previousHeld.filter((s) => !todays.has(s) && !keptSyms.has(s));
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
  // Relative strength compares like with like — a partial SPY bar against
  // complete symbol bars would tilt every reading in the same direction.
  spy = S.completeSeries(await data.getOhlcv({ count: 400, summary: false })).bars;
} catch (e) { log(`  SPY unavailable: ${e.message}`); }

const tickers = [];
let n = 0;
for (const sel of selection) {
  n++;
  const sym = sel.symbol;
  const c = sel.candidate;
  process.stdout.write(`  [${n}/${selection.length}] ${sel.bucket.padEnd(6)} ${sym.replace(/^.*:/, '')} ... `);
  const row = {
    symbol: sym,
    bucket: sel.bucket,
    // A carried-forward Months name has no candidate from today's scan. Its
    // fields are null rather than invented — it is here because of a ranking
    // taken at the last rebalance, and saying otherwise would be a fiction.
    carried_forward: c === null,
    screens: c?.screens ?? null,
    confluence: c?.confluence ?? null,
    direction: c?.direction ?? null,
    mixed_direction: c?.mixed_direction ?? null,
    scanner: c ? {
      close: c.row.close, perf_1m: c.row['Perf.1M'], perf_3m: c.row['Perf.3M'],
      perf_6m: c.row['Perf.6M'], perf_y: c.row['Perf.Y'], rsi: c.row.RSI,
      volatility_d: c.row['Volatility.D'], sector: c.row.sector,
      off_52w_high_pct: offHighPct(c.row), days_to_earnings: daysToEarnings(c.row),
      dollar_volume: r2((c.row.close ?? 0) * (c.row['average_volume_10d_calc'] ?? 0), 0),
    } : null,
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
    // Only meaningful when there IS a scanner close from this morning to
    // compare the last bar against.
    row.moved_since_bar = c
      ? movedSinceBar({ close: bars.at(-1).close }, c.row.close, a.risk?.atr_14 ?? null)
      : null;
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
  /**
   * Two different defects, two different remedies.
   *
   * The bar series we fetch per symbol CAN be trimmed, and is — `partials_dropped`
   * counts it. The scanner fields TradingView computes server-side CANNOT be:
   * there is no bar array to cut, so all that is left is to say which fields
   * are unsafe and let the reader discount them.
   */
  bar_hygiene: {
    partials_dropped: partialsDropped,
    note: partialsDropped
      ? `Dropped a still-forming daily bar on ${partialsDropped} of ${tickers.length} symbols.`
      : 'No forming bars — every symbol read a finished session.',
    scanner: scannerTrust(),
  },
  /**
   * The two horizon buckets and their separate clocks.
   *
   * `months.rebalanced` false is the normal case, not a failure — it is what
   * the cadence fix looks like on 20 of every 21 weekdays.
   */
  buckets: {
    months: {
      ...BUCKETS.MONTHS,
      rebalanced: monthsDue.due,
      rebalance_reason: monthsDue.reason,
      selected: monthsSel,
      hysteresis,
      last_rebalance: monthsDue.due ? new Date().toISOString() : (state.months_last_rebalance ?? null),
    },
    weeks: { ...BUCKETS.WEEKS, rebalanced: true, selected: weeksSel },
    unrouted: routed.unrouted.map((c) => c.symbol),
    cost_basis: 'Daily rerank of a monthly factor is 252 round trips/yr = 50.4% drag at 20bps, against '
      + "MAD's ~9% gross. Monthly with a 20/50 band is ~0.96%. See turnover_cost.",
  },
  tier_a_factors: factors
    ? { computed_at_rebalance: true, ...factors }
    : { computed_at_rebalance: false, why: 'Factors are monthly sorts and are computed only when the Months bucket rebalances.' },
  our_bias_summary: ok.reduce((m, t) => ({ ...m, [t.our_view.bias]: (m[t.our_view.bias] || 0) + 1 }), {}),
  tickers,
};

const jsonPath = join(OUT_DIR, `morning-screen-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
/**
 * A stable path alongside the dated one.
 *
 * Anything downstream — TA, a skill, a dashboard — otherwise has to glob the
 * directory and parse dates to find the newest file, and gets it wrong on the
 * first holiday. This is the local half of publishing; nothing here transmits
 * anywhere.
 */
const latestPath = join(OUT_DIR, 'morning-screen-latest.json');
writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');
log(`\n  ${jsonPath}`);
log(`  ${latestPath} (stable path for consumers)`);
log(`  analysed ${ok.length}/${tickers.length}`);
log(`  our bias: ${JSON.stringify(report.our_bias_summary)}`);

// ── watchlist ───────────────────────────────────────────────────────────────
if (WRITE_LIST && ok.length) {
  try {
    const current = await listContents(WATCHLIST_NAME);
    const okSet = new Set(ok.map((t) => t.symbol));
    const built = buildBucketed(current, {
      weeks: weeksSel.filter((s) => okSet.has(s)),
      // null means "not due — carry the section forward untouched". An empty
      // array would mean "the rebalance ran and chose nothing", which would
      // wipe the section. The distinction matters every single non-due day.
      months: monthsDue.due ? monthsSel.filter((s) => okSet.has(s)) : null,
      keep_prefix: KEEP_PREFIX,
      months_section: BUCKETS.MONTHS.section,
      weeks_section: BUCKETS.WEEKS.section,
    });
    log(`  Months ${built.months.length}${built.months_carried_forward ? ' (carried forward)' : ' (rebalanced)'}`
      + `, Weeks ${built.weeks.length}`);
    if (built.preserved_sections.length) {
      log(`  preserving ${built.preserved_sections.map((s) => `${s.name}(${s.count})`).join(', ')}`);
    }
    if (built.dropped_sections.length) {
      log(`  WARNING dropping section(s): ${built.dropped_sections.map((s) => `${s.name}(${s.count})`).join(', ')}`);
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

      /**
       * Record the rebalance only after the write actually landed.
       *
       * Stamping it earlier would mark the month done on a run whose watchlist
       * write then failed, and the Months bucket would sit stale until the
       * next calendar month with nothing saying why.
       */
      if (monthsDue.due) {
        writeFileSync(STATE_PATH, JSON.stringify({
          ...state,
          months_last_rebalance: new Date().toISOString(),
          months_selection: built.months,
          schema_version: SCHEMA_VERSION,
        }, null, 2), 'utf8');
        log(`  recorded Months rebalance in ${STATE_PATH}`);
      }
    }
  } catch (e) {
    log(`  watchlist FAILED: ${e.message}`);
  }
} else if (!WRITE_LIST) {
  log('  watchlist skipped (--no-watchlist)');
}

process.exit(0);
