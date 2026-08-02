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
import { SCREENS, INTRADAY_SCREENS, VETO_DEFAULTS } from '../src/core/screens.js';
import { strategiesForScreen, PRE_GATE, PER_SCANNER } from '../src/core/morning_routine.js';
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

/**
 * Both families are documented. The intraday screens were omitted entirely, so the
 * generated parameters file described 8 of the 10 screens that actually run and
 * said nothing about the one tier a reader is most likely to find empty.
 */
const emitScreen = (s) => {
  out.push(`## ${s.name} — \`${s.key}\``);
  out.push('');
  out.push(`**Direction:** ${s.direction}  `);
  out.push(`**Horizon:** ${s.horizon_side}  `);
  out.push(`**Bet:** ${s.bet}  `);
  out.push(`**Evidence:** ${s.evidence}  `);
  out.push(`**Strategies:** ${strategiesForScreen(s.key).map((x) => `\`${x.name}\` (${x.execution}, tier ${x.evidence_tier})`).join(', ') || '**NONE — its survivors would classify as null and vanish**'}  `);
  out.push(`**Session:** ${s.session ? `\`${s.session}\` only` : 'any — nothing it reads is session-sensitive'}`);
  if (s.session_note) { out.push(''); out.push(`> ${s.session_note}`); }
  out.push('');
  out.push('| Field | Op | Value |');
  out.push('|---|---|---|');
  for (const f of s.filter) {
    if (LIQUIDITY_FILTER.some((l) => l.left === f.left && l.operation === f.operation)) continue;
    out.push(line(f));
  }
  out.push('');
  out.push(`**Client-side refine:** ${describeRefine(s.refine)}`);
  /**
   * A screen standing in one column for another must SAY SO where the parameters
   * are read. `describeRefine` falls back to a 90-character slice of the source for
   * anything it cannot parse, and a truncated arrow function is exactly where a
   * substitution would go unnoticed — `intraday_extension` reads EMA10 for the
   * unavailable EMA9 and `stage2_onset` brackets the unavailable SMA150 with
   * SMA100/SMA200. An approximation stated is fine; one hidden is not.
   */
  if (s.approximation_note) { out.push(''); out.push(`> **Approximation:** ${s.approximation_note}`); }
  out.push('');
};

out.push('# Swing screens');
out.push('');
out.push('These feed the INTRADAY / WEEKLY / MONTHLY split via the strategy each points at.');
out.push('');
for (const s of SCREENS) emitScreen(s);

out.push('# Intraday screens');
out.push('');
out.push('Held separately from `SCREENS`. Two of the three intraday strategies need operands');
out.push('that do not exist before the open — `minutes_since_open`, `vwap`, `rvol` — so the most');
out.push('a pre-open screen can honestly hand them is a list of names likely to be *in play*.');
out.push('`parabolic_fade` is the exception: its own criteria are price-only and daily-screenable,');
out.push('which is why it has a screen that runs at any hour.');
out.push('');
for (const s of INTRADAY_SCREENS) emitScreen(s);

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

out.push('## Selection');
out.push('');
out.push(`Each screen's own top **${PRE_GATE}** enter the detector gate; its top **${PER_SCANNER}**`);
out.push('**survivors** are selected. Per screen, not pooled — so no single strategy family can');
out.push('take the whole list.');
out.push('');
out.push('There is **no confluence merge and no slot allocation**. Schema 2.x pooled every screen');
out.push('into 15 continuation and 5 reversal slots and ran the detectors on whatever the merge had');
out.push('already chosen, which is the exact inverse of "scanner as coarse filter, our detectors as');
out.push('verdict". Confluence — how many screens wanted a name — is still recorded, and still only');
out.push('breaks a tie: the continuation screens overlap heavily (`near_52w_high` × `rs_leadership`');
out.push('**42%**), so their agreement is *not* independent confirmation.');
out.push('');
out.push('The **tier** comes from the strategy the screen points at, never from the screen. A screen');
out.push('pointing at no strategy would gate and select names that then classify as `null` and vanish');
out.push('from the watchlist in silence, so a contract test asserts every screen above reaches one.');
out.push('');

out.push('## Columns returned by stage 1');
out.push('');
out.push('```');
out.push(BASE_COLUMNS.join(', '));
out.push('```');
out.push('');

writeFileSync('docs/screening-parameters.md', `${out.join('\n')}\n`, 'utf8');
console.log(`docs/screening-parameters.md — ${SCREENS.length} swing + ${INTRADAY_SCREENS.length} intraday screens, ${out.length} lines`);
