/**
 * Print the morning screen report as a compact summary.
 *
 * ── Why this exists ──
 *
 * The scheduled 05:30 run told the agent to "read it programmatically (node or
 * python)" and hand-roll the extraction. That is two problems at once.
 *
 * It needs a BROAD permission. `node -e <arbitrary code>` is arbitrary code
 * execution, so pre-approving it for an unattended run grants far more than the
 * routine needs — and without pre-approval the run stops at 05:30 and waits for
 * someone who is asleep.
 *
 * And it is FRAGILE. Extraction code written fresh each morning is written against
 * remembered key names. Schema 3.0 renamed most of them: `selection.trials`,
 * `selection.considered`, `selection.vetoed`, `our_view.bias` all disappeared, and
 * an agent reading a key that no longer exists gets `undefined`, not an error — so
 * the summary silently loses a section instead of failing loudly.
 *
 * One fixed command, one narrow permission, and the key names live in git next to
 * the code that writes them.
 *
 * Run:  node scripts/morning-summary.js [--file reports/morning-screen-latest.json]
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const FILE = argVal('--file', 'reports/morning-screen-latest.json');

let r;
try {
  r = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`Could not read ${FILE}: ${e.message}`);
  console.error('The run may not have completed. Do NOT summarise an older report as if it were today.');
  process.exit(1);
}

const bare = (s) => String(s).replace(/^.*:/, '');
const out = [];
const P = (s = '') => out.push(s);

P(`MORNING SCREEN — schema ${r.schema_version}, generated ${r.generated_at}`);
P(`  universe: ${(r.universe || []).join(' + ')}`);
P(`  analysed ${r.counts.analysed}/${r.counts.in_watchlist}, failed ${r.counts.failed}`);
P(`  bias: ${JSON.stringify(r.our_bias_summary)}   completeness: ${JSON.stringify(r.completeness_summary)}`);

/**
 * The number that makes the list mean anything. The detectors chose it, not the
 * scanner — which is the whole point of schema 3.0 and the first thing to report.
 */
P('');
P(`GATE — ${r.gate.passed}/${r.gate.unique_symbols_gated} unique symbols survived our detectors`);
P(`  pre-gate ${r.pipeline.pre_gate} per scanner in, top ${r.pipeline.per_scanner} survivors out`);

if (r.screens_skipped?.length) {
  P('');
  P('SCREENS THAT DID NOT RUN (never ran — not "ran and found nothing"):');
  for (const s of r.screens_skipped) P(`  ${s.key.padEnd(22)} ${s.why}`);
}

P('');
P('PER SCREEN:');
for (const s of r.screens) {
  if (s.skipped) continue;
  const sel = (s.selected || []).map(bare).join(' ') || '—';
  P(`  ${s.key.padEnd(22)} ${String(s.candidates).padStart(4)} refined -> ${String(s.gated).padStart(3)} gated`
    + ` -> ${String(s.passed_gate).padStart(3)} passed -> ${sel}`);
}
// A screen that gated names and selected none is a fact about today, not a failure.
const barren = r.screens.filter((s) => !s.skipped && s.gated > 0 && !(s.selected || []).length);
if (barren.length) P(`  NOTE: ${barren.map((s) => s.key).join(', ')} gated names and NONE survived.`);

P('');
P('WATCHLIST:');
for (const [name, syms] of Object.entries(r.watchlist.sections)) {
  P(`  ${name.padEnd(9)} ${String(syms.length).padStart(2)}  ${syms.map(bare).join(' ') || '—'}`);
}
P(`  preserved: ${(r.watchlist.preserved || []).map((p) => `${p.name}(${p.count})`).join(', ') || 'none'}`);
if (r.watchlist.dropped?.length) {
  P(`  WARNING dropped section(s): ${r.watchlist.dropped.map((d) => `${d.name}(${d.count})`).join(', ')}`);
}
const w = r.watchlist.write;
P(`  write: ${w?.applied ? `${w.entries_after} entries (was ${w.entries_before})` : JSON.stringify(w)}`);

/**
 * Should be empty. A non-empty list means a screen points at no strategy, so its
 * survivors classified as null and were thrown away without a word.
 */
if (r.tiers?.unclassified?.length) {
  P('');
  P(`  UNCLASSIFIED ${r.tiers.unclassified.length} — a screen points at NO strategy and its results were discarded:`);
  for (const u of r.tiers.unclassified) P(`    ${bare(u.symbol)}: ${u.why}`);
}

P('');
P('TICKERS:');
P(`  ${'SYMBOL'.padEnd(7)}${'SECTION'.padEnd(10)}${'TF'.padEnd(5)}${'BIAS'.padEnd(9)}${'CONF'.padEnd(5)}SCREENS / COMPLETENESS`);
for (const t of r.tickers) {
  if (t.status !== 'ok') { P(`  ${bare(t.symbol).padEnd(7)}FAILED — ${t.error}`); continue; }
  const a = t.analysis;
  const c = a.completeness;
  const flag = c.complete ? '' : `  INCOMPLETE: ${c.missing.map((m) => m.section).join(',')}`;
  const na = c.not_applicable?.length ? ` (n/a: ${c.not_applicable.map((n) => n.section).join(',')})` : '';
  P(`  ${bare(t.symbol).padEnd(7)}${String(t.section).padEnd(10)}${String(a.timeframe).padEnd(5)}`
    + `${String(a.verdict?.bias ?? '?').padEnd(9)}${String(t.confluence ?? '-').padEnd(5)}`
    + `${(t.screens || []).join(',')}${na}${flag}`);
}

/**
 * The ones that matter most. Every detector read a bar that closed before this
 * move happened, so nothing in the analysis can see it.
 */
const moved = r.tickers.filter((t) => t.moved_since_bar?.material);
P('');
if (moved.length) {
  P('MOVED SINCE THE BAR — the analysis cannot see these moves:');
  for (const t of moved) {
    const m = t.moved_since_bar;
    P(`  ${bare(t.symbol).padEnd(7)} ${m.pct != null ? `${m.pct}%` : ''} ${m.atr_multiple != null ? `(${m.atr_multiple}x ATR)` : ''} ${m.note || ''}`);
  }
} else {
  P('MOVED SINCE THE BAR: none material.');
}

P('');
P('LIVE TRADE PLANS (tradeable_now — a forming pattern is NOT one):');
let plans = 0;
for (const t of r.tickers) {
  for (const tp of (t.analysis?.assessment?.trade_plans || [])) {
    if (!tp.tradeable_now) continue;
    for (const [side, l] of Object.entries(tp.legs || {})) {
      if (!l || l.entry == null) continue;
      plans += 1;
      // base_rate beside R:R, always. R:R is arithmetic on the levels, not evidence.
      const rate = tp.break_even_failure_pct != null ? `fails ${tp.break_even_failure_pct}%` : 'no base rate';
      P(`  ${bare(t.symbol).padEnd(7)} ${tp.pattern} ${side}: entry ${l.entry} stop ${l.stop} target ${l.target}`
        + ` R:R ${l.rr} — ${rate}${tp.bilateral ? ' [BILATERAL — both legs are real]' : ''}`);
    }
  }
}
if (!plans) P('  none.');

P('');
P(`TRIALS: ${r.gate.unique_symbols_gated} symbols measured across ${r.screens.filter((s) => !s.skipped).length} screens.`);
P('  The best-looking name beat that many candidates. Undeflated it is a selection artefact —');
P('  the best of 200 no-edge strategies scored an annualised Sharpe of 2.19 (tests/validation.test.js).');
P('');
P(`bar hygiene: ${r.bar_hygiene.note}`);
P(`scanner trust: ${r.bar_hygiene.scanner.reason}`);
P('');
P('NOT ADVICE. A candidate list rendering the owner\'s own criteria against their own charts.');

console.log(out.join('\n'));
