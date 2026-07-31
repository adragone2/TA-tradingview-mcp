/**
 * Recovering drawings this tool created but can no longer prove it created.
 *
 * ── Why this exists ──
 *
 * `draw_clear` removes only what the registry tracks, which is the right
 * default: it is what stops us deleting the user's own work. But TradingView
 * entity IDs are SESSION-scoped. When the desktop app restarts, every ID in
 * the registry stops matching a live shape, `prune` drops it, and the drawings
 * themselves stay on the chart forever — untrackable by the one tool that
 * would clean them up.
 *
 * Measured across the holdings on 2026-07-28: 670 shapes on 48 charts, of
 * which the registry could account for 69. SNDK alone carried the same level
 * set stacked six times over. Every one of those was ours.
 *
 * The safe scope could not remove them and the unsafe scope would have taken
 * the user's own drawings with them. Neither is acceptable, so identity comes
 * from a third source: the TEXT. Every label this toolchain writes follows a
 * generated format, and those formats are specific enough to recognise.
 *
 * ── The rule this follows ──
 *
 * A shape is ours only if its text matches a format we GENERATE. Anything that
 * does not match is left alone, including anything ambiguous. The cost of
 * missing an orphan is a stale line on a chart; the cost of a false match is
 * deleting the user's analysis. Those are not symmetric, and the patterns below
 * are anchored end-to-end rather than substring-matched for that reason.
 *
 * All pure except `findOrphans`/`removeOrphans`, which read and write the chart.
 */
import { evaluate, getChartApi } from '../connection.js';
import * as registry from './drawing_registry.js';
import { STRUCTURAL_PATTERNS } from './patterns.js';

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const PAT = [...STRUCTURAL_PATTERNS, 'ascending_channel', 'descending_channel', 'horizontal_channel'].join('|');

/**
 * The text formats this toolchain writes, grouped by WHICH TOOL WROTE THEM.
 *
 * Kept beside the code that writes them — if a drawing label changes format
 * and its signature is not updated here, the orphan it leaves behind becomes
 * permanent. The tests assert that round trip across every file that draws.
 *
 * The grouping exists so a caller can clear its own prior output without
 * touching another tool's. The Sunday review must wipe last week's levels and
 * patterns before redrawing — otherwise they stack, which is how 545 stale
 * shapes accumulated across 45 charts — but a walls overlay the user applied
 * deliberately is not the review's to delete.
 *
 * `MCP_TEXT_SIGNATURES` is the flat union, because the full sweep should still
 * reach everything.
 */
export const SIGNATURES_BY_SOURCE = {
  /** levels, zones, patterns, trade plans, channels, VCP — what the review draws. */
  review: [],
  /** ta_draw_decision. */
  ta_decision: [],
  /** walls_draw / walls_apply. */
  walls: [],
};

// ── the Sunday review's own vocabulary ──────────────────────────────────────
SIGNATURES_BY_SOURCE.review.push(
  // levels_draw / the review's key levels: "S 1277.33 (-0.07%)", "R 36.99 (5.5%)"
  new RegExp(`^[SR] ${NUM} \\(${NUM}%\\)$`),
  // zones: "demand 33.16-34.2", "supply 1411.5-1573.09"
  new RegExp(`^(?:demand|supply) ${NUM}-${NUM}$`),
  // zones_draw, the TOOL — a different format from the review's range form:
  // "demand fresh · 2.1x", "supply tested · aggressive · 1.4x". Found by
  // draw-smoke's label audit (P3.3, 2026-07-30): this was never registered, so
  // every rectangle zones_draw had ever drawn was invisible to the sweep and
  // leaked as a permanent orphan at session end. `momentum_x` can round to
  // null and String(null) is "null", hence the `null` alternation — the
  // wording the emitter used until later that same day, still on live charts.
  //
  // Registered as-is rather than re-pointing the emitter at the range form
  // above, for two reasons. The status/grade/momentum suffix is the zone's
  // measured evidence — the label's whole job — and the range form drops it.
  // And rectangles with THIS wording are already on live charts, so this
  // signature would be required even if the emitter changed: an orphan is by
  // definition written by old code, and signatures are append-only.
  new RegExp(`^(?:demand|supply) (?:fresh|tested|broken)(?: · aggressive)? · (?:${NUM}|null)x$`),
  // What replaced "nullx" (2026-07-30): an unmeasurable multiple — a zero-body
  // base, where mBody/avgBody is undefined — prints "n/a" in the momentum
  // slot: "demand fresh · n/a". The slot stays FILLED on purpose. Omitting the
  // suffix would emit a bare "demand fresh", which the negative tests pin as a
  // plausible hand-typed label — a form the sweep must never claim.
  new RegExp(`^(?:demand|supply) (?:fresh|tested|broken)(?: · aggressive)? · n/a$`),
  // trade plan legs: "ENTRY long 30.77 — double_bottom", "STOP 26.11 — …", "TARGET 34.76 (R:R 0.86) — …"
  new RegExp(`^ENTRY (?:long|short) ${NUM} — .+$`),
  new RegExp(`^STOP ${NUM} — .+$`),
  new RegExp(`^TARGET ${NUM} \\(R:R ${NUM}\\) — .+$`),
  // TA's own stop: "TA stop 1862.51 (exit)".
  // The parenthesised word is whichever `side` is in scope at the call site —
  // the review's queue side (exit/entry/holding), not the trade side. Matching
  // any lowercase word rather than enumerating them means a future change of
  // that vocabulary cannot silently strand orphans, and "TA stop <price>
  // (<word>)" is not something a person types by hand.
  new RegExp(`^TA stop ${NUM} \\([a-z_]+\\)$`),
  // pattern geometry: "<pattern> <status>" plus its suffixed variants
  new RegExp(`^(?:${PAT}) (?:forming|confirmed)$`),
  new RegExp(`^(?:${PAT}) (?:forming|confirmed) pole \\+${NUM}%$`),
  new RegExp(`^(?:${PAT}) (?:forming|confirmed) — \\d+ bars, ${NUM}% retrace$`),
  new RegExp(`^(?:${PAT}) (?:forming|confirmed) — breaks at ${NUM}$`),
  new RegExp(`^(?:${PAT}) (?:forming|confirmed) — completes ${NUM}$`),
  new RegExp(`^(?:${PAT}) (?:forming|confirmed) — only \\d+ pivots, too few to draw$`),
  // channel boundaries: "descending_channel upper"
  new RegExp(`^(?:${PAT}) (?:upper|lower)$`),
  // RETIRED FORMAT, still on charts: "rising_wedge confirmed upper".
  //
  // Worth stating plainly, because it is the whole nature of this module: an
  // orphan was written by OLD code. Matching only the formats currently
  // emitted guarantees the oldest drawings — the ones most likely to be stale
  // — are the ones never cleaned up. Signatures are append-only; delete one
  // and its drawings become permanent.
  new RegExp(`^(?:${PAT}) (?:forming|confirmed) (?:upper|lower)$`),
  // patterns_draw target lines: "bull_flag forming target 19.32".
  // Added when pattern drawing stopped being a manual draw_shape call — a label
  // written by hand matches nothing here and leaks an orphan that survives forever.
  new RegExp(`^(?:${PAT}) (?:forming|confirmed) target ${NUM}$`),
  // VCP: "VCP pivot 34.2"
  new RegExp(`^VCP pivot ${NUM}$`),
  /**
   * The primary level WITH its evidence: "S 14.84 (0.07%) - 9 tests, 1.4x vol".
   *
   * A gap, found by probing rather than by reading: the level label above is
   * anchored end-to-end, and the drawer has been appending ` - <reason>` to it
   * since the evidence was put back in the label. So every primary level drawn
   * with a reason has been INVISIBLE to the sweep — `isMcpText` returned false on
   * a live example, measured 2026-07-30.
   *
   * The suffix is deliberately loose because `shortReason` composes it from
   * whichever clauses matched, and can produce an empty one (leaving a trailing
   * " - "). The PREFIX carries the discrimination: a price and a signed
   * percentage in parentheses after a bare S or R is not something typed by hand.
   */
  // `-(?: .*)?` rather than `- .*`: isMcpText TRIMS before matching, so the
  // empty-suffix form arrives as "S 14.84 (0.07%) -" with no trailing space.
  new RegExp(`^[SR] ${NUM} \\(${NUM}%\\) -(?: .*)?$`),
);

/**
 * ── The CALLOUT labels, and the earnings line (assessment_draw.js) ──────────
 *
 * Two of the shapes adopted on 2026-07-30 carry TEXT, which makes them the
 * opposite case from the textless natives: `parallel_channel`, the position
 * tool, `fib_retracement`, `fixed_range_volume_profile` and
 * `elliott_impulse_wave` can only ever be cleared by GROUP, while these two are
 * sweepable — and therefore MUST be registered here or they leak forever.
 *
 * A callout carries the level's text UNCHANGED — the same string the horizontal
 * line would have printed — so every signature above already covers it, and the
 * test asserts exactly that round trip. Nothing new is needed for the callout
 * itself; what IS new is the earnings line's own format.
 *
 * Probed live the same day: a callout's `text` reads back verbatim through
 * `getProperties()`, which is the property `findOrphans` matches on.
 */
SIGNATURES_BY_SOURCE.review.push(
  // the earnings vertical_line: "earnings 2026-08-26 (27d)".
  // Days are never negative — earningsLinePlan refuses a past date outright.
  new RegExp(`^earnings \\d{4}-\\d{2}-\\d{2} \\(\\d+d\\)$`),
);

// ── ta_draw_decision (src/core/ta_decisions.js) ────────────────────────────
// "TA Call Wall 143.24", "TA Stop (CRITICAL) 598.37".
// These were leaking: every level ta_draw_decision has ever drawn was
// unrecognisable to the sweep and could never be cleaned up.
SIGNATURES_BY_SOURCE.ta_decision.push(
  new RegExp(`^TA (?:Call Wall|Put Wall|BB Upper|BB Lower|PIF Resistance|PIF Support) ${NUM}$`),
  new RegExp(`^TA Stop \\([A-Za-z_]+\\) ${NUM}$`),
);

// ── walls_draw / walls_apply (src/core/ta_walls.js) ────────────────────────
// Tags joined with " / " and suffixed with the price: "D Call Wall 1250",
// "W Put GEX / M Call Wall 1180", "Gamma Flip 1195".
SIGNATURES_BY_SOURCE.walls.push(
  new RegExp(`^(?:(?:[DWM] (?:Call Wall|Put Wall|Call GEX|Put GEX)|Gamma Flip)(?: / )?)+ ${NUM}$`),
);

/** The flat union. The full sweep should still reach everything. */
export const MCP_TEXT_SIGNATURES = Object.values(SIGNATURES_BY_SOURCE).flat();

/**
 * Does this text match something we generate?
 *
 * `sources` narrows it to particular writers — `['review']` matches only what
 * the Sunday review draws, leaving a deliberate walls overlay alone. Omitted,
 * it matches everything, which is what the full sweep wants.
 */
export function isMcpText(text, { sources = null } = {}) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;                       // an empty label proves nothing
  const list = sources
    ? sources.flatMap((s) => SIGNATURES_BY_SOURCE[s] || [])
    : MCP_TEXT_SIGNATURES;
  return list.some((re) => re.test(t));
}

/**
 * Classify every shape on the CURRENT chart.
 *
 * Returns three groups. `tracked` is what draw_clear already handles;
 * `orphans` is ours by text but lost from the registry; `foreign` is
 * everything else and is never touched.
 */
export async function findOrphans({ sources = null } = {}) {
  const api = await getChartApi();
  const shapes = (await evaluate(`
    (function(){
      var api = ${api};
      return api.getAllShapes().map(function(s){
        var out = { id: s.id, name: s.name, text: null };
        try {
          var sh = api.getShapeById(s.id);
          var p = sh && sh.getProperties ? sh.getProperties() : null;
          if (p) out.text = p.text || p.title || null;
        } catch (e) { out.error = e.message; }
        return out;
      });
    })()
  `)) || [];

  const trackedIds = new Set(registry.list().map((e) => e.entity_id));
  const tracked = [], orphans = [], foreign = [];
  for (const s of shapes) {
    if (trackedIds.has(s.id)) tracked.push(s);
    else if (isMcpText(s.text, { sources })) orphans.push(s);
    else foreign.push(s);
  }
  return { total: shapes.length, tracked, orphans, foreign };
}

/**
 * Remove the orphans on the CURRENT chart.
 *
 * `dry_run` defaults to TRUE. This deletes things on a live chart, and a tool
 * that deletes by default is a tool that deletes by accident.
 */
export async function removeOrphans({ dry_run = true, sources = null } = {}) {
  const api = await getChartApi();
  const found = await findOrphans({ sources });

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_remove: found.orphans.length,
      kept_tracked: found.tracked.length,
      kept_foreign: found.foreign.length,
      sample: found.orphans.slice(0, 8).map((s) => s.text),
      note: 'Nothing was removed. Pass dry_run: false to apply.',
    };
  }

  const removed = [];
  for (const s of found.orphans) {
    try {
      await evaluate(`${api}.removeEntity(${JSON.stringify(s.id)})`);
      removed.push(s.id);
    } catch { /* already gone */ }
  }
  const remaining = (await evaluate(`${api}.getAllShapes().length`)) || 0;
  return {
    success: true,
    dry_run: false,
    removed: removed.length,
    kept_tracked: found.tracked.length,
    kept_foreign: found.foreign.length,
    remaining_shapes: remaining,
    note: 'Only shapes whose text matches a format this toolchain generates were removed. '
      + 'Anything unrecognised was left alone.',
  };
}
