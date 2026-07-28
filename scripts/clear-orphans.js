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
 */
import * as chart from '../src/core/chart.js';
import * as ta from '../src/core/ta_decisions.js';
import * as taApi from '../src/core/ta_api.js';
import { findOrphans, removeOrphans } from '../src/core/orphans.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
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
  tickers = [...new Set([
    ...(act.exits || []).map((r) => r.ticker),
    ...(act.entries || []).map((r) => r.ticker),
    ...((pf?.data?.positions) || []).map((p) => p.ticker),
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
    totals.tracked += found.tracked.length;
    totals.foreign += found.foreign.length;
    totals.orphans += found.orphans.length;
    if (!found.orphans.length) continue;
    totals.touched += 1;
    if (samples.length < 6) samples.push(...found.orphans.slice(0, 2).map((s) => `${t}: ${s.text}`));

    if (APPLY) {
      const res = await removeOrphans({ dry_run: false });
      totals.removed += res.removed;
      log(`  ${String(t).padEnd(8)} removed ${String(res.removed).padStart(3)}  kept ${res.kept_foreign} foreign, ${res.kept_tracked} tracked`);
    } else {
      log(`  ${String(t).padEnd(8)} would remove ${String(found.orphans.length).padStart(3)}  keep ${found.foreign.length} foreign, ${found.tracked.length} tracked`);
    }
  } catch (e) {
    log(`  ${String(t).padEnd(8)} ERROR ${e.message}`);
  }
}

log(`\n${'-'.repeat(60)}`);
log(`symbols carrying orphans : ${totals.touched}`);
log(`orphans ${APPLY ? 'removed' : 'found'}         : ${APPLY ? totals.removed : totals.orphans}`);
log(`left alone (not ours)    : ${totals.foreign}`);
log(`left alone (tracked)     : ${totals.tracked}`);
if (samples.length) log(`\nexamples:\n  ${samples.join('\n  ')}`);
if (!APPLY) log('\nNothing was changed. Re-run with --apply to remove them.');

if (original) { try { await chart.setSymbol({ symbol: original }); } catch { /* leave */ } }
process.exit(0);
