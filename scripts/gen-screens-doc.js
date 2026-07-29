/**
 * Generate docs/screening-parameters.md from src/core/screens.js.
 *
 * The screens are DATA, so their reference should be generated rather than
 * transcribed. A hand-written parameter table drifts from the code, and drift
 * in this repo is never loud — the schema doc documented `ta_action` for weeks
 * while the script never emitted it, and every test written from the doc
 * passed.
 *
 *   node scripts/gen-screens-doc.js
 */
import { writeFileSync } from 'node:fs';
import { SCREENS, VETO_DEFAULTS, DEFAULT_SLOTS } from '../src/core/screens.js';
import { UNIVERSES, DEFAULT_UNIVERSE, LIQUIDITY_FILTER, BASE_COLUMNS } from '../src/core/scanner.js';

const OPS = { greater: '>', less: '<', equal: '=', in_range: 'in', egreater: '>=', eless: '<=' };
const fmt = (v) => (Array.isArray(v) ? `${v[0]} … ${v[1]}` : typeof v === 'number' && Math.abs(v) >= 1e6
  ? `${v / 1e6}M` : JSON.stringify(v));

const line = (f) => `| \`${f.left}\` | ${OPS[f.operation] || f.operation} | ${fmt(f.right)} |`;

/** Pull the bounds out of a refine predicate so the doc states them numerically. */
function describeRefine(fn) {
  const src = String(fn).replace(/\s+/g, ' ');
  if (/return true/.test(src)) return 'none';
  const m = src.match(/o >= (\d+(?:\.\d+)?) && o <= (\d+(?:\.\d+)?)/);
  if (m) return `${m[1]}–${m[2]}% below the 52-week high`;
  const le = src.match(/o <= (\d+(?:\.\d+)?)/);
  if (le) return `within ${le[1]}% of the 52-week high`;
  return src.slice(0, 90);
}

const out = [];
out.push('# Morning screen — parameters');
out.push('');
out.push('**Generated from `src/core/screens.js` — do not edit by hand.**');
out.push('Regenerate with `node scripts/gen-screens-doc.js`.');
out.push('');
out.push('The design and the reasoning are in [screening.md](screening.md). This is');
out.push('the exact configuration the morning run executes.');
out.push('');

out.push('## Universe');
out.push('');
out.push('| Index | `symbolset` | Approx |');
out.push('|---|---|---|');
for (const k of DEFAULT_UNIVERSE) {
  const u = UNIVERSES[k];
  out.push(`| ${u.name} | \`${u.id}\` | ${u.approx} |`);
}
out.push('');
out.push('Deduplicated union is about **4,505** symbols. Index membership is a top-level');
out.push('`symbols.symbolset`, not a filter — `indexes` rejects every operation with HTTP');
out.push('400 and `index_id` silently matches nothing.');
out.push('');

out.push('## Applied to every screen');
out.push('');
out.push('| Field | Op | Value |');
out.push('|---|---|---|');
for (const f of LIQUIDITY_FILTER) out.push(line(f));
out.push('');
out.push('A name that cannot be traded at size is excluded at stage 1 rather than found');
out.push('and then vetoed — `trade_cost` would eat the edge before it exists.');
out.push('');

for (const s of SCREENS) {
  out.push(`## ${s.name} — \`${s.key}\``);
  out.push('');
  out.push(`**Direction:** ${s.direction}  `);
  out.push(`**Horizon:** ${s.horizon_side}  `);
  out.push(`**Bet:** ${s.bet}  `);
  out.push(`**Evidence:** ${s.evidence}`);
  out.push('');
  out.push('| Field | Op | Value |');
  out.push('|---|---|---|');
  for (const f of s.filter) {
    if (LIQUIDITY_FILTER.some((l) => l.left === f.left && l.operation === f.operation)) continue;
    out.push(line(f));
  }
  out.push('');
  out.push(`**Client-side refine:** ${describeRefine(s.refine)}`);
  out.push('');
}

out.push('## Veto — runs last, on the survivors');
out.push('');
out.push('| Threshold | Value | Why |');
out.push('|---|---|---|');
out.push(`| \`min_days_to_earnings\` | ${VETO_DEFAULTS.min_days_to_earnings} | A scheduled event inside the hold dominates the setup |`);
out.push(`| \`max_off_high_pct\` | ${VETO_DEFAULTS.max_off_high_pct} | Below this it is a downtrend, not a pullback |`);
out.push(`| \`min_dollar_volume\` | $${VETO_DEFAULTS.min_dollar_volume / 1e6}M | Costs would exceed the edge |`);
out.push('');
out.push('The veto is the only screen that reliably improves results. The other five find');
out.push('candidates; this removes the ones that cannot work.');
out.push('');

out.push('## Ranking');
out.push('');
out.push(`Slots: ${Object.entries(DEFAULT_SLOTS).map(([k, v]) => `**${k} ${v}**`).join(', ')} — scaled proportionally when fewer than ${Object.values(DEFAULT_SLOTS).reduce((a, b) => a + b, 0)} are requested.`);
out.push('');
out.push('Ranked by **confluence within direction**, tie-broken by 12-month performance.');
out.push('Not a weighted composite: weighting the screens would invent coefficients nobody');
out.push('measured. And not global confluence either — the overlap was measured, and');
out.push('`structural_reversal` shares 0% with every other screen by construction (RSI');
out.push('15–35 against their 40–75), so a global ranking made it structurally incapable');
out.push('of scoring above 1 and deleted the reversal side outright.');
out.push('');
out.push('The continuation screens overlap heavily — `near_52w_high` × `rs_leadership`');
out.push('**42%** — so their agreement is *not* independent confirmation. The pairwise');
out.push('matrix ships in every report.');
out.push('');

out.push('## Columns returned by stage 1');
out.push('');
out.push('```');
out.push(BASE_COLUMNS.join(', '));
out.push('```');
out.push('');

writeFileSync('docs/screening-parameters.md', `${out.join('\n')}\n`, 'utf8');
console.log(`docs/screening-parameters.md — ${SCREENS.length} screens, ${out.length} lines`);
