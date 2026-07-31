import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { assess } from '../src/core/assessment.js';
import { selectPrimary } from '../src/core/level_display.js';
import { findSwings, alternateSwings, findKeyLevels } from '../src/core/structure.js';

/**
 * WHAT THE ANALYSIS MUST PRODUCE — not how it is wired.
 *
 * `workflow_union.test.js` checks the plumbing: that ticker_analyze calls
 * drawFindings, passes clear_scope, re-implements nothing. Every one of those
 * assertions passed while the chart quietly got WORSE, three separate ways:
 *
 *   1. the primary resistance stopped being anchored to the swing high, because
 *      assess() offered only ONE resistance candidate and selectPrimary fell back
 *      to "nearest" — the ranking the out-of-sample work exists to replace;
 *   2. level labels lost their evidence, because drawFindings' label was written
 *      for the Sunday review and says distance instead of tests and volume;
 *   3. pattern completion levels stopped being drawn, because
 *      drawPatternGeometry returns after each shape and the break-level line at
 *      the end is reached only by the head-and-shoulders path.
 *
 * The owner caught all three by looking at the chart. The common cause was
 * unifying by ADOPTION rather than by UNION: a shared function's defaults were
 * tuned for its original caller, and were taken wholesale for a new one.
 *
 * So these assertions are about OUTPUT. A wiring test cannot see any of it.
 */

/**
 * Bars with MORE distinct levels than findKeyLevels' default cap of 12.
 *
 * That cap is the mechanism. On DLO it kept the top 12 candidates by score and cut
 * 15.5433 — the level sitting on the swing high — so `selectPrimary` had nothing to
 * anchor to and silently fell back to "nearest". A fixture with fewer than 12
 * candidates cannot reproduce it, which is exactly why the first version of this
 * test passed with the fix reverted and was worthless. The guard on that count is
 * in the test itself and must stay.
 *
 * ── Why each price is now held for TWO bars ──
 *
 * The shelves used to be one bar each: lvl, lvl-0.3, lvl, lvl-0.25. Under the
 * fractal swing detector that produced 17 swings and 16 candidate levels. Under
 * the pivot backbone (kernel extrema, src/core/pivots.js) it produced FOUR, and
 * the fixture stopped exercising the cap it exists to exercise.
 *
 * That is not the backbone getting it wrong — it is a property of smoothing, and
 * worth stating because it will surprise the next person to write a fixture here.
 * The old shelf oscillated with a period of TWO bars on a series stepping 0.45
 * every twelve, and a Gaussian smooth at the bandwidth `lookback: 5` maps to
 * (2.0 bars) treats a two-bar wiggle as noise on a rising line — correctly. The
 * fractal rule is a rank filter and degrades gently; the kernel has a cutoff.
 *
 * Holding each price for two bars doubles the oscillation's period and it
 * resolves again: 66 swings, 16 candidates against the default's 12. The SHAPE
 * of the fixture is unchanged — sixteen shelves 0.45 apart, each visited three
 * times, then a decline and a chop. Only the dwell changed.
 */
function fixtureBars() {
  const out = [];
  let t = 1700000000;
  const push = (p, vol = 1e6) => {
    out.push({ time: t, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: vol });
    t += 86400;
  };
  const hold = (p, vol) => { push(p, vol); push(p, vol); };
  for (let s = 0; s < 16; s += 1) {
    const lvl = 10 + s * 0.45;
    for (let k = 0; k < 3; k += 1) { hold(lvl, 1.5e6); hold(lvl - 0.3); hold(lvl, 1.4e6); hold(lvl - 0.25); }
  }
  for (let i = 0; i < 25; i += 1) push(16.5 - i * 0.14);
  for (let i = 0; i < 15; i += 1) push(13.1 + Math.sin(i / 3) * 0.2);
  return out;
}

describe('the analysis output, not its wiring', () => {
  const bars = fixtureBars();
  const a = assess(bars, null);
  const alt = alternateSwings(findSwings(bars, { lookback: 5 }));
  const lastHigh = [...alt].reverse().find((s) => s.kind === 'high');
  const lastLow = [...alt].reverse().find((s) => s.kind === 'low');
  const levels = (a.key_levels?.all_supports || []).concat(a.key_levels?.all_resistances || []);

  test('assess() uses the WIDE level parameters, not findKeyLevels defaults', () => {
    /**
     * The regression, encoded so it cannot depend on fixture luck.
     *
     * `findKeyLevels` defaults to `max_levels: 12` and keeps the top 12 by SCORE.
     * On DLO that cut 15.5433 — the level on the swing high — and everything
     * downstream that anchors to the swing extremes degraded silently to
     * "nearest". assess() must therefore ask for the wide set, and this compares
     * its output against both calls rather than asserting a magic number.
     */
    const def = findKeyLevels(bars, { lookback: 5 });
    const wide = findKeyLevels(bars, { lookback: 5, max_levels: 40, max_distance_pct: 25 });
    assert.ok(wide.levels.length > def.levels.length,
      'the fixture does not exercise the default cap, so this test proves nothing — it needs more '
      + `than ${def.levels.length} candidate levels`);
    assert.equal(a.key_levels.count, wide.levels.length,
      `assess() returned ${a.key_levels.count} levels; the wide call returns ${wide.levels.length} and `
      + `the truncating default returns ${def.levels.length}. assess() is using the default again, `
      + 'which is what hid the swing-high level and broke anchoring.');
  });

  test('if an anchorable level EXISTS, the primary must anchor to it', () => {
    /**
     * The precise invariant, and the one the regression broke.
     *
     * Not "both sides are always anchored" — sometimes nothing sits near a swing
     * extreme, and falling back with `anchored: false` is the honest answer. What
     * must never happen is a candidate existing within tolerance and the selection
     * failing to use it, which is what truncation caused: 15.5433 sat 0.21% from
     * DLO's swing high and was cut from the candidate list, so the resistance
     * silently became "nearest to price".
     */
    const price = bars.at(-1).close;
    const p = selectPrimary(levels, {
      price, swing_high: lastHigh?.price ?? null, swing_low: lastLow?.price ?? null,
    });
    assert.ok(p.shown.length >= 1, 'no primary level was selected at all');

    for (const [side, swing] of [['resistance', lastHigh?.price], ['support', lastLow?.price]]) {
      if (!Number.isFinite(swing)) continue;
      const onSide = levels.filter((l) => (side === 'resistance' ? l.price >= price : l.price < price));
      const anchorable = onSide.some((l) => Math.abs((l.price - swing) / swing) * 100 <= 3);
      const chosen = p.shown.find((l) => l.side === side);
      if (!anchorable || !chosen) continue;
      assert.equal(chosen.anchored, true,
        `a ${side} candidate sits within 3% of the swing (${swing}) but ${chosen.price} was chosen `
        + `unanchored — ${chosen.anchor}. That is truncation hiding an anchorable level.`);
    }
  });

  test('the resistance side anchors on a chart shaped like the one that regressed', () => {
    const p = selectPrimary(levels, {
      price: bars.at(-1).close,
      swing_high: lastHigh?.price ?? null,
      swing_low: lastLow?.price ?? null,
    });
    const r = p.shown.find((l) => l.side === 'resistance');
    assert.ok(r, 'no resistance was selected');
    assert.equal(r.anchored, true, `resistance ${r.price} unanchored: ${r.anchor}`);
    assert.match(r.anchor, /sits on the last swing high/);
  });

  test('every level candidate carries the evidence its label needs', () => {
    // Loss 2: the label can only show evidence the level actually carries.
    for (const l of levels) {
      assert.ok(l.reason, `level ${l.price} has no reason — its label cannot show why it earned a line`);
      assert.match(l.reason, /tests?/, `level ${l.price} reason has no test count: ${l.reason}`);
    }
  });
});

describe('what gets drawn, asserted at the source', () => {
  const draw = readFileSync('src/core/assessment_draw.js', 'utf8');

  test('the level label shows EVIDENCE, not only distance', () => {
    assert.match(draw, /shortReason\(l\.reason\)/,
      'the primary-level label dropped its evidence for a distance percentage — the one thing the '
      + 'reader can already see on the axis');
  });

  test('a pattern completion level is drawn BEFORE any geometry branch returns', () => {
    /**
     * Loss 3. Each branch of drawPatternGeometry returns after its shape, so a line
     * at the end of the function is unreachable for wedges, flags and triangles.
     * The completion level is the most actionable price on a pattern — it is where
     * the shape stops being a shape — so it must be drawn up front.
     */
    const fn = draw.slice(draw.indexOf('export async function drawPatternGeometry'));
    const completionAt = fn.indexOf('Number.isFinite(p.completion_level)');
    const firstReturn = fn.indexOf('\n    return;');
    assert.ok(completionAt > -1, 'drawPatternGeometry never draws the completion level');
    assert.ok(completionAt < firstReturn,
      'the completion level is drawn after a branch that returns — wedges and flags would get a '
      + 'shape and no trigger');
  });

  test('both completion phrasings stay registered as orphan signatures', () => {
    const orphans = readFileSync('src/core/orphans.js', 'utf8');
    for (const phrase of ['breaks at', 'completes']) {
      assert.ok(orphans.includes(phrase),
        `"${phrase}" is written onto charts but has no signature — those drawings leak forever`);
    }
  });
});
