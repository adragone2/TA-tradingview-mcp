#!/usr/bin/env node
/**
 * Generate docs/strategies.md from strategies.json.
 *
 * The doc is generated rather than written so it cannot drift from the data the
 * tools actually evaluate. Same reason gen-tools-doc.js and gen-screens-doc.js
 * exist: a catalogue that disagrees with the code is worse than no catalogue.
 *
 *   node scripts/gen-strategies-doc.js
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, byExecution, scannable, catalogueSummary } from '../src/core/catalogue.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'strategies.md');

const cat = loadCatalogue({ fresh: true });
if (!cat.available) { console.error('No strategies.json found.'); process.exit(1); }

const groups = byExecution(cat.strategies, cat.execution_tiers);
const sum = catalogueSummary(cat.strategies);
const L = [];
const p = (s = '') => L.push(s);

const TIER_BADGE = { A: '**A**', B: 'B', C: 'C', REJECTED: '~~REJECTED~~' };
const list = (a) => (a && a.length ? a.map((x) => `\`${x}\``).join(', ') : '—');

p('# Strategy catalogue');
p();
p('**Generated** — `node scripts/gen-strategies-doc.js`. Source of truth: [strategies.json](../strategies.json).');
p();
p('Every strategy the toolchain can express, grouped by **execution tier** (when the trade is closed out) and');
p('tagged with an **evidence tier** (how much to believe it). Each row names its screener, entry and exit rules,');
p('TradingView indicators, and the skills, tools and risk rules to invoke.');
p();
p(`${sum.total} strategies — ${sum.scannable} machine-scannable, ${sum.by_evidence_tier.REJECTED || 0} tiered REJECTED.`);
p();
p('| | |');
p('|---|---|');
p(`| By execution | ${Object.entries(sum.by_execution).map(([k, v]) => `${k} ${v}`).join(' · ')} |`);
p(`| By evidence | ${Object.entries(sum.by_evidence_tier).map(([k, v]) => `${k} ${v}`).join(' · ')} |`);
p();

p('## How to read this');
p();
p('| Evidence tier | Means |');
p('|---|---|');
for (const [k, v] of Object.entries(cat.evidence_tiers)) p(`| ${TIER_BADGE[k] || k} | ${v} |`);
p();
p('**REJECTED entries are listed on purpose.** Each has been measured here and found to have no edge over its own');
p('null. Deleting them would mean the next session rediscovers a candlestick reversal or a touch-count level rule');
p('and believes it is new. They carry no criteria, and `strategy_check` refuses them *with the reason*.');
p();
p('Two things this catalogue will not do: it does not rank strategies against each other, and it does not say which');
p('to trade. A tier is a statement about evidence, not about expected return on your account.');
p();

p('## Run any of these');
p();
p('```bash');
p('# what is defined, with tiers');
p('strategy_list');
p('strategy_list execution="monthly" scannable_only=true');
p();
p('# evaluate one against the chart, criterion by criterion');
p('strategy_check strategy_name="momentum_pullback"');
p();
p('# across a watchlist (restores the chart afterwards)');
p('strategy_scan strategy_name="vcp_base_breakout"');
p('```');
p();
p('`rules.json` wins a name clash — it holds your own criteria and a shared catalogue must not override them.');
p();

for (const [key, tier] of Object.entries(cat.execution_tiers)) {
  const rows = groups[key] || [];
  if (!rows.length) continue;
  const [lo, hi] = tier.horizon_days || [];
  p('---');
  p();
  p(`## ${tier.label} — ${lo === 0 ? 'same session' : `${lo}–${hi} trading days`}`);
  p();
  p(`Closed out by **${tier.closes_by}**.`);
  p();
  p(`> **Horizon evidence.** ${tier.horizon_evidence}`);
  p();

  for (const s of rows) {
    const can = scannable(s);
    p(`### ${s.label}  ·  ${TIER_BADGE[s.evidence_tier] || s.evidence_tier}`);
    p();
    p(`\`${s.name}\`${s.direction ? ` · ${s.direction}` : ''}${can.ok ? '' : ' · **not scannable**'}`);
    p();
    p(`**Evidence.** ${s.evidence}`);
    p();
    if (s.evidence_caveat) { p(`**Caveat.** ${s.evidence_caveat}`); p(); }
    p('| | |');
    p('|---|---|');
    p(`| **Screener** | ${s.screener && s.screener !== 'none' && !String(s.screener).startsWith('none') ? `\`${s.screener}\`` : `_${s.screener}_`} |`);
    p(`| **Entry** | ${s.entry} |`);
    p(`| **Exit** | ${s.exit} |`);
    if (s.exit_reason_keys?.length) p(`| **Exit reason keys** | ${list(s.exit_reason_keys)} — log these, \`exit_mix\` reads them |`);
    p(`| **TradingView indicators** | ${list(s.indicators)} |`);
    p(`| **Skills** | ${s.skills?.length ? s.skills.map((k) => `[${k}](../skills/${k}/SKILL.md)`).join(', ') : '—'} |`);
    p(`| **Tools** | ${list(s.tools)} |`);
    p(`| **Risk rules** | ${list(s.risk_rules)} |`);
    p();
    if (s.criteria?.length) {
      p('<details><summary>Machine-evaluable criteria</summary>');
      p();
      p('| Left | Op | Right | Note |');
      p('|---|---|---|---|');
      for (const c of s.criteria) p(`| \`${c.left}\` | \`${c.op}\` | \`${c.right}\` | ${c.note || ''} |`);
      p();
      if (s.criteria_note) { p(`${s.criteria_note}`); p(); }
      p('</details>');
      p();
    } else if (can.ok === false) {
      p(`_${can.reason}_`);
      p();
    }
  }
}

p('---');
p();
p('## What is deliberately absent');
p();
p('- **Opening Range Breakout as Crabel defines it** — needs the first thirty seconds of trade. The 5-minute version');
p('  catalogued above is a proxy, not his rule.');
p('- **The 1-2-3 / ignition pattern** — implemented in `src/core/ignition.js`, tested, and deliberately NOT');
p('  registered as a tool, because its noise floor cannot be measured: the ATR gate shifts with any constructed null.');
p('- **Anything requiring the tape or order flow** — several of Bellafiore\'s exits are order-flow judgements');
p('  (`tape_seller`, `pattern_dissipated`). They are in the exit taxonomy, counted as unmodellable, and no strategy');
p('  here depends on them.');
p();
p('## The horizon problem, stated once');
p();
p('Read this before trading anything in the **weekly** tier.');
p();
p('Below ~21 trading days the documented effect is **reversal**. Above ~63 it is **continuation**. Nearly every');
p('structural detector in this repo — breakouts, flags, triangles, wedges, VCP — is a *continuation* bet, and the');
p('weekly tier (2–10 days) places it exactly where continuation is weakest. Momentum\'s skip-month exists because');
p('that boundary falls inside the swing window.');
p();
p('Between 11 and 63 days is the **contested gap**: neither effect is documented there, and it is where the monthly');
p('tier begins. `horizon_prior` reports which side of the boundary a setup sits on. Run it before hunting a setup,');
p('not after.');
p();
p('See [swing-evidence-review.md](swing-evidence-review.md) and [strategy-horizons.md](strategy-horizons.md).');
p();

writeFileSync(OUT, `${L.join('\n')}\n`, 'utf8');
console.log(`docs/strategies.md — ${sum.total} strategies across ${Object.keys(groups).filter((k) => groups[k].length).length} execution tiers`);
