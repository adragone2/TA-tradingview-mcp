/**
 * Put detected patterns on the chart, from `patterns_detect` output.
 *
 * The last manual step in the ticker workflow. `patterns_detect` returns a
 * pattern's `completion_level` and `target`, and `draw_shape` can draw a line, but
 * nothing joined them — so the wedge and flag on a live DLO analysis were drawn by
 * hand, with hand-written labels. A hand-written label is the specific thing that
 * leaks an orphan: entity IDs die with the TradingView session, so a drawing whose
 * text matches no signature in `MCP_TEXT_SIGNATURES` can never be swept up again.
 *
 * Every label this produces uses a format already registered there.
 *
 * ── What gets drawn, and what deliberately does not ──
 *
 * The COMPLETION LEVEL, always: it is the price at which the pattern stops being a
 * shape and becomes a fact, which makes it the only line on the pattern that is
 * also a trigger. Bullish patterns "complete", bearish ones "break at" — two
 * registered phrasings, and the distinction is real: a rising wedge breaking DOWN
 * through its support is not the same event as a flag completing UP through its high.
 *
 * The TARGET only on request, because a measured move assumes the pattern behaves
 * typically and most do not. Bulkowski measures from the breakout onward, so on a
 * FORMING pattern the target is a projection off a shape that has not happened yet.
 *
 * All pure — the drawing itself is the caller's job.
 */

/**
 * WHICH patterns to draw. The drawing itself is `drawPatternGeometry` in
 * assessment_draw.js, which renders the actual SHAPE — wedge and triangle
 * boundaries through TradingView's native triangle_pattern tool anchored to real
 * pivots, a flag's pole and consolidation box, a head-and-shoulders through the
 * 7-point tool, a rectangle as a box.
 *
 * This module used to draw a single horizontal completion line per pattern and
 * nothing else, which silently removed geometry the charts had been carrying for
 * months. The owner noticed: "yesterday you drew a channel, on other tickers you
 * drew wedges, triangles etc. It seems you are not doing this anymore." Selecting
 * and drawing are different jobs; this one selects.
 */

/**
 * Turn detected patterns into drawable lines.
 *
 * `patterns` is `patterns_detect().structural`. Candlestick patterns are not drawn:
 * they are single bars already visible on the chart, and two independent academic
 * tests found candlestick strategies add no value, so drawing them would give a
 * refuted signal the same visual weight as a measured level.
 */
/**
 * Rank patterns when we have to pick. Confirmed beats forming, then Bulkowski's
 * meeting-target rate, then recency — a pattern that stopped forming 45 bars ago
 * is describing a shape price has since walked away from.
 */
const patternRank = (p) => [
  p.status === 'confirmed' ? 0 : 1,
  -(Number(p.meeting_target_pct) || 0),
  Number(p.bars_ago) ?? 1e9,
];
const byRank = (a, b) => {
  const ra = patternRank(a); const rb = patternRank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return 0;
};

export function planPatternDrawings(patterns = [], {
  include_targets = false,
  forming_only = false,
  max_patterns = 6,
  bias = null,
} = {}) {
  const chosen = [];
  const skipped = [];

  /**
   * ONLY THE VERDICT SIDE.
   *
   * Drawing every detected pattern put contradictory geometry on one chart. On ALM
   * a bullish falling wedge targeting 22.3 and a bearish head-and-shoulders
   * targeting 8.19 were both drawn in full — 22 shapes, labels overprinting into
   * unreadability around the price. On GRMN, whose verdict was BULLISH, a bearish
   * head-and-shoulders that stopped forming 45 bars ago still got its seven shapes.
   *
   * The owner's call: draw only the verdict side. The conflict is not deleted — it
   * comes back in `skipped` with the reason, and it is exactly why a verdict reads
   * NEUTRAL when the sides disagree.
   *
   * With no verdict (NEUTRAL, or a caller that passes none) there is no side to
   * pick, so the best-ranked pattern is drawn ALONE rather than all of them. One
   * shape is readable; the disagreement is still reported.
   */
  const verdict = String(bias || '').toUpperCase();
  const want = { BULLISH: 'bullish', BEARISH: 'bearish' }[verdict] || null;
  let candidates = (patterns || []).filter((x) => x && x.pattern);
  if (want) {
    const off = candidates.filter((p) => p.direction && p.direction !== want);
    for (const p of off) {
      skipped.push({ pattern: p.pattern, why: `direction "${p.direction}" contradicts the ${bias} verdict — drawn geometry would argue against the read` });
    }
    candidates = candidates.filter((p) => !p.direction || p.direction === want);
  } else if (verdict === 'NEUTRAL' && candidates.length > 1) {
    /**
     * NEUTRAL is a verdict, not the absence of one, and it is the case that made
     * ALM unreadable: a bullish wedge and a bearish head-and-shoulders both drawn in
     * full is *why* the read came out undecided.
     *
     * No `bias` AT ALL is different and must stay permissive — `patterns_draw` is a
     * tool the owner calls to see the patterns, and narrowing it to one by default
     * would answer a different question than the one asked.
     */
    const ranked = [...candidates].sort(byRank);
    for (const p of ranked.slice(1)) {
      skipped.push({
        pattern: p.pattern,
        why: `no directional verdict, so only the best-ranked pattern is drawn (${ranked[0].pattern}, `
          + `${ranked[0].status}). This one is ${p.status}${p.bars_ago != null ? `, ${p.bars_ago} bars ago` : ''}.`,
      });
    }
    candidates = ranked.slice(0, 1);
  }

  for (const p of candidates) {
    if (forming_only && p.status !== 'forming') {
      skipped.push({ pattern: p.pattern, why: `status is "${p.status}" and forming_only was set` });
      continue;
    }
    /**
     * A pattern with neither a completion level nor measurements has no geometry
     * and no break price — there is nothing to draw that would mean anything.
     */
    if (!Number.isFinite(p.completion_level) && !p.measurements) {
      skipped.push({
        pattern: p.pattern,
        why: 'no completion_level and no measurements — nothing to anchor a shape or a break level to',
      });
      continue;
    }
    if (chosen.length >= max_patterns) {
      skipped.push({ pattern: p.pattern, why: `beyond the ${max_patterns}-pattern cap` });
      continue;
    }
    chosen.push(p);
  }

  /**
   * Collapse duplicates. A bull_flag and a bullish_pennant are the same shape read
   * two ways, and on TIGO both reported completion 100.75, target 115.24, a 17.32%
   * pole over 25 bars and a 45.9% retrace — identical in every measurement. Drawing
   * both puts two labels on one price and counts one setup twice.
   */
  const seen = new Map();
  const unique = [];
  for (const p of chosen) {
    const key = `${p.direction}|${p.status}|${p.completion_level}|${p.measurements?.pole_pct ?? ''}`;
    if (seen.has(key)) {
      const kept = seen.get(key);
      skipped.push({
        pattern: p.pattern,
        why: `identical geometry to ${kept} — same direction, status, completion level and pole. `
          + 'The same shape read two ways is one setup, not two.',
        duplicate_of: kept,
      });
      continue;
    }
    seen.set(key, p.pattern);
    unique.push(p);
  }

  const forming = unique.filter((p) => p.status === 'forming').length;
  const confirmed = unique.filter((p) => p.status === 'confirmed').length;
  const dirs = new Set(unique.map((p) => p.direction));

  return {
    patterns: unique,
    skipped,
    include_targets,
    counts: { forming, confirmed, total: unique.length },
    ...(dirs.has('bullish') && dirs.has('bearish') ? {
      conflict: 'Bullish AND bearish patterns are on the same bars. That is the finding, not a problem '
        + 'to resolve by picking one — draw both and say the chart does not favour either.',
    } : {}),
    ...(forming ? {
      forming_note: `${forming} pattern(s) are FORMING and have not completed. Their break level is the `
        + 'price at which each would confirm, not a signal now.',
    } : {}),
    ...(skipped.length ? {
      skipped_note: `${skipped.length} pattern(s) were not drawn. Listed rather than silently dropped.`,
    } : {}),
    geometry_note: 'Shapes are drawn by drawPatternGeometry: native triangle_pattern for wedges and '
      + 'triangles anchored to real pivots, pole plus box for flags, the 7-point tool for head and '
      + 'shoulders, a box for rectangles — plus the break level as a dashed line.',
  };
}
