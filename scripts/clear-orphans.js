/**
 * Remove drawings this toolchain left behind on charts it can no longer track.
 *
 * TradingView entity IDs are session-scoped, so every drawing made before the
 * desktop app last restarted is invisible to `draw_clear scope:"mcp"` and
 * survives forever. This finds them by their TEXT instead and removes only
 * those — see src/core/orphans.js for the reasoning and the safety rule.
 *
 * DRY RUN BY DEFAULT. Pass --apply to actually delete.
 *
 *   node scripts/clear-orphans.js                 # report only
 *   node scripts/clear-orphans.js --apply         # remove them
 *   node scripts/clear-orphans.js --tickers A,B   # limit the sweep
 *   node scripts/clear-orphans.js --all-mcp       # tracked drawings too
 *
 * `--all-mcp` also removes drawings the registry still tracks — the ones
 * `draw_clear` can already reach. Without it this sweep leaves them, which is
 * correct for "recover what was lost" and wrong for "clear the charts": after
 * the first sweep the charts still carried 62 tracked shapes from that day's
 * runs, and reporting them as clean was wrong.
 *
 * Hand-drawn shapes are never touched under either flag.
 */
import * as chart from '../src/core/chart.js';
import * as ta from '../src/core/ta_decisions.js';
import * as taApi from '../src/core/ta_api.js';
import * as drawing from '../src/core/drawing.js';
import * as registry from '../src/core/drawing_registry.js';
import * as watchlist from '../src/core/watchlist.js';
import { findOrphans, removeOrphans } from '../src/core/orphans.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL_MCP = args.includes('--all-mcp');
const only = (() => {
  const i = args.indexOf('--tickers');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(`${s}\n`);

const before = await chart.getState().catch(() => null);
const original = before?.symbol || null;

let tickers = only;
if (!tickers) {
  const act = await ta.actionable({ limit: 200 }).catch(() => ({}));
  const pf = await taApi.get('/api/portfolio').catch(() => null);
  // TA's list is what we WILL draw on. `drawnSymbols` is what we HAVE drawn
  // on, and the two diverge: a symbol analysed last week that has since
  // dropped off TA's list keeps its drawings forever if the sweep only follows
  // TA. CARG kept 17 shapes through a full sweep for exactly this reason.
  //
  // It reads the append-only symbol list rather than deriving symbols from the
  // live entries, because the entries are exactly what gets emptied when the
  // TradingView session ends — the moment the sweep is most needed.
  const drawn = registry.drawnSymbols();
  // The TradingView watchlist is the third source, and the only one that
  // covers a symbol drawn on before this store existed.
  const wl = await watchlist.get().catch(() => null);
  const wlSyms = (wl?.symbols || wl?.watchlist || [])
    .map((x) => (typeof x === 'string' ? x : x?.symbol)).filter(Boolean);
  tickers = [...new Set([
    ...wlSyms,
    ...(act.exits || []).map((r) => r.ticker),
    ...(act.entries || []).map((r) => r.ticker),
    ...((pf?.data?.positions) || []).map((p) => p.ticker),
    ...drawn,
  ].filter(Boolean))];
}

log(`${APPLY ? 'REMOVING' : 'DRY RUN'} across ${tickers.length} symbols\n`);

let totals = { orphans: 0, removed: 0, tracked: 0, foreign: 0, touched: 0 };
const samples = [];

for (const t of tickers) {
  try {
    await chart.setSymbol({ symbol: t });
    await sleep(450);
    const found = await findOrphans();
    totals.foreign += found.foreign.length;
    totals.orphans += found.orphans.length;
    totals.tracked += found.tracked.length;
    const work = found.orphans.length + (ALL_MCP ? found.tracked.length : 0);
    if (!work) continue;
    totals.touched += 1;
    if (samples.length < 6) samples.push(...found.orphans.slice(0, 2).map((s) => `${t}: ${s.text}`));

    if (APPLY) {
      let n = (await removeOrphans({ dry_run: false })).removed;
      // Tracked drawings go through the normal path, which knows how to
      // untrack them as well as remove them.
      if (ALL_MCP) n += (await drawing.clearAll({ scope: 'mcp' })).removed || 0;
      totals.removed += n;
      log(`  ${String(t).padEnd(8)} removed ${String(n).padStart(3)}  kept ${found.foreign.length} hand-drawn`);
    } else {
      log(`  ${String(t).padEnd(8)} would remove ${String(work).padStart(3)}`
        + ` (${found.orphans.length} orphan${ALL_MCP ? `, ${found.tracked.length} tracked` : ''})`
        + `  keep ${found.foreign.length} hand-drawn`);
    }
  } catch (e) {
    log(`  ${String(t).padEnd(8)} ERROR ${e.message}`);
  }
}

log(`\n${'-'.repeat(60)}`);
log(`symbols carrying orphans : ${totals.touched}`);
log(`${APPLY ? 'removed' : 'would remove'}${' '.repeat(APPLY ? 18 : 14)}: ${APPLY ? totals.removed : totals.orphans + (ALL_MCP ? totals.tracked : 0)}`);
log(`  of which orphans       : ${totals.orphans}`);
log(`  of which tracked       : ${ALL_MCP ? totals.tracked : 0}${ALL_MCP ? '' : ` (left — pass --all-mcp to include ${totals.tracked})`}`);
log(`left alone (hand-drawn)  : ${totals.foreign}`);
if (samples.length) log(`\nexamples:\n  ${samples.join('\n  ')}`);
if (!APPLY) log('\nNothing was changed. Re-run with --apply to remove them.');

if (original) { try { await chart.setSymbol({ symbol: original }); } catch { /* leave */ } }
process.exit(0);
