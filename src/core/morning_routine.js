/**
 * The morning routine, as a pipeline.
 *
 * ── What changed, and why ──
 *
 * The old shape ran every scanner, merged the results into 15 continuation and 5
 * reversal slots, and only THEN ran this repo's detectors on the twenty names the
 * merge had already picked. So the scanner chose the list and our measurements
 * described it afterwards — which inverts `docs/screening.md`'s own design, "TV
 * scanner as coarse filter, our detectors as verdict". It also let one strategy
 * family take most of the slots.
 *
 * The owner's instruction: run the detectors BEFORE the per-scanner cut, so the
 * five that reach the watchlist are five that SURVIVED.
 *
 *   1. every session-eligible scanner            ->  7-8 screens
 *   2. top PRE_GATE per scanner by its own rank  ->  bounded, see below
 *   3. our detectors on the union                ->  pass / reject, with reasons
 *   4. top 5 SURVIVORS per scanner               ->  the watchlist
 *   5. classify each into intraday/weekly/monthly
 *   6. rewrite the managed sections; KEEP untouched
 *   7. full ticker_analyze on everything written
 *
 * ── Why stage 2 is bounded ──
 *
 * Measured on the 2026-07-30 run, the scanners refine to 182, 97, 207, 44, 193,
 * 45 and 123 candidates — 891 slots, 415 unique symbols. Detectors need BARS, so
 * running them on everything means 415 symbol loads at roughly two seconds each:
 * fifteen minutes before any analysis starts, in a window that has to finish
 * before the 06:30 open. PRE_GATE caps the oversample instead.
 *
 * Fifteen rather than five because the gate genuinely rejects — a choppy regime
 * reading alone knocked out most of the 2026-07-30 sample — so five in would
 * rarely yield five out.
 *
 * Everything here is orchestration. The measuring is `stageTwo`, the classifying
 * is `classifyTier`, the analysis is `analyzeTicker`, the watchlist write is
 * `buildSectioned`. This file must not re-implement any of them.
 */
import { SCREENS, INTRADAY_SCREENS } from './screens.js';
import { scan, BASE_COLUMNS } from './scanner.js';
import { scannerTrust } from './session.js';
import { stageTwo, topSurvivors } from './stage_two.js';
import { classifyTier, SECTION_FOR, MANAGED_SECTIONS, KEEP_PREFIX } from './tier_classify.js';
import { mergedStrategies } from './catalogue.js';
import { resolveRules } from './rules.js';

/** How many per scanner enter the detector gate. See the header. */
export const PRE_GATE = 15;
/** How many survivors per scanner reach the watchlist. */
export const PER_SCANNER = 5;

/**
 * Which screens may run right now.
 *
 * `session` is not advisory. `short_term_reversal` ranks on fields that fold the
 * forming day and must not run pre-open; `premarket_gap` reads premarket fields
 * that are stale once the session is over. A skipped screen is REPORTED, never
 * silently absent — "ran and found nothing" and "never ran" are different facts.
 */
export function eligibleScreens({ trust = scannerTrust() } = {}) {
  const all = [...SCREENS, ...(INTRADAY_SCREENS || [])];
  const eligible = [];
  const skipped = [];
  for (const s of all) {
    if (s.session === 'settled' && !trust.volume_fields_usable) {
      skipped.push({ key: s.key, why: `needs a settled session; ${trust.reason}` });
    } else if (s.session === 'premarket' && trust.session_state !== 'premarket') {
      /**
       * Gate on the STATE, not on `volume_fields_usable`.
       *
       * The inherited check was `session === 'premarket' && volume_fields_usable`,
       * which reads as "skip once the session has settled". But volume fields are
       * unusable pre-open AND intraday, so mid-session the flag is false and the
       * premarket screen RAN — ranking on premarket_change hours after the open,
       * when it describes a move that finished at 09:30. Only `premarket` is
       * premarket.
       */
      skipped.push({
        key: s.key,
        why: `pre-open only; the session state is "${trust.session_state}" so premarket fields are stale`,
      });
    } else {
      eligible.push(s);
    }
  }
  return { eligible, skipped, trust };
}

/** Stage 1: run one screen and return its refined, ranked rows. */
export async function runScreen(s, { limit = 500 } = {}) {
  const columns = s.columns ? [...BASE_COLUMNS, ...s.columns] : BASE_COLUMNS;
  const r = await scan({ filter: s.filter, columns, range: [0, limit] });
  let kept = (r.rows || []).filter(s.refine).sort((a, b) => s.rank(b) - s.rank(a));
  const beforePost = kept.length;
  if (typeof s.post === 'function') kept = s.post(kept);
  return { key: s.key, raw: r.total ?? (r.rows || []).length, refined: beforePost, rows: kept };
}

/**
 * Which strategies a screen implies, from the catalogue.
 *
 * The tier comes from the STRATEGY's `execution`, so a screen that names no
 * strategy cannot classify anything — that is reported rather than defaulted.
 */
export function strategiesForScreen(screenKey, { rules_path = null } = {}) {
  const { rules } = resolveRules(rules_path);
  const all = mergedStrategies(rules);
  return Object.entries(all)
    .filter(([, v]) => screenerKeys(v.screener).includes(screenKey))
    .map(([name, v]) => ({ name, execution: v.execution, evidence_tier: v.evidence_tier }));
}

/**
 * Every `prefix:key` a catalogue `screener` field names.
 *
 * The field is prose as often as it is an identifier — `short_term_reversal`
 * reads "screens:short_term_reversal (+ morning-screen:tier_a_factors for the VIX
 * gate)", and a naive `split(':').pop()` returned "tier_a_factors for the VIX
 * gate)". The strategy then matched no screen, its survivors classified as null,
 * and they would have been dropped from the watchlist without a word — a Tier B
 * strategy silently unreachable. Six entries say "none" or "none as a standalone",
 * which must match nothing and do.
 */
export function screenerKeys(screener) {
  // DIGITS are part of a key: `screens:near_52w_high` truncated to "near_" without
  // them, which turned a Tier A screen into a second silent gap while fixing the first.
  return [...String(screener || '').matchAll(/[a-z0-9_-]+:([a-z0-9_]+)/g)].map((m) => m[1]);
}

/**
 * Stage 2 + 4: gate the oversample, then take the top survivors per screen.
 *
 * `loadBars(symbol)` is injected so this stays testable without a chart, and so
 * the caller can cache — the same symbol appears in several screens and must be
 * loaded once, not once per screen.
 */
export async function gateAndSelect(screenResults, loadBars, {
  pre_gate = PRE_GATE, per_scanner = PER_SCANNER, onProgress = null,
} = {}) {
  // Which screens wanted each symbol — confluence, kept because it is information.
  const wantedBy = new Map();
  for (const sr of screenResults) {
    for (const row of sr.rows.slice(0, pre_gate)) {
      const sym = row.symbol;
      if (!wantedBy.has(sym)) wantedBy.set(sym, { symbol: sym, row, screens: [] });
      wantedBy.get(sym).screens.push(sr.key);
    }
  }

  const gated = new Map();
  let done = 0;
  for (const [sym, entry] of wantedBy) {
    let bars = null;
    let err = null;
    try { bars = await loadBars(sym); } catch (e) { err = e.message; }
    const stage2 = bars
      ? stageTwo(bars)
      : { passed: false, why: `could not load bars: ${err || 'no bars returned'}`, score: 0 };
    gated.set(sym, { ...entry, bars, stage2 });
    done += 1;
    if (onProgress) onProgress({ done, total: wantedBy.size, symbol: sym, passed: stage2.passed });
  }

  const perScreen = {};
  for (const sr of screenResults) {
    const mine = sr.rows.slice(0, pre_gate)
      .map((r) => gated.get(r.symbol))
      .filter(Boolean);
    perScreen[sr.key] = {
      gated: mine.length,
      passed: mine.filter((m) => m.stage2.passed).length,
      selected: topSurvivors(mine, per_scanner),
      rejected: mine.filter((m) => !m.stage2.passed)
        .map((m) => ({ symbol: m.symbol, why: m.stage2.why })),
    };
  }
  return { perScreen, gated };
}

/**
 * Stage 5: one tier per selected symbol.
 *
 * A symbol selected by several screens can imply several tiers; `classifyTier`
 * resolves that by evidence tier, longer horizon winning a tie.
 */
export function assignTiers(perScreen, { rules_path = null } = {}) {
  const byScreen = new Map();
  for (const key of Object.keys(perScreen)) {
    byScreen.set(key, strategiesForScreen(key, { rules_path }));
  }

  const bySymbol = new Map();
  for (const [key, res] of Object.entries(perScreen)) {
    for (const sel of res.selected) {
      if (!bySymbol.has(sel.symbol)) bySymbol.set(sel.symbol, { ...sel, strategies: [], from_screens: [] });
      const e = bySymbol.get(sel.symbol);
      e.from_screens.push(key);
      e.strategies.push(...(byScreen.get(key) || []));
    }
  }

  const tiers = { intraday: [], weekly: [], monthly: [] };
  const unclassified = [];
  for (const [sym, e] of bySymbol) {
    const c = classifyTier(e.strategies);
    if (!c.tier) { unclassified.push({ symbol: sym, why: c.basis }); continue; }
    tiers[c.tier].push({ ...e, tier: c.tier, tier_basis: c.basis, tier_from: c.from });
  }
  for (const t of Object.keys(tiers)) tiers[t].sort((a, b) => b.stage2.score - a.stage2.score);
  return { tiers, unclassified, symbols: bySymbol };
}

export { SECTION_FOR, MANAGED_SECTIONS, KEEP_PREFIX };
