/**
 * The native TradingView tools the unified drawer adopted, and the fallbacks
 * that must survive them.
 *
 * Every assertion here exists because the alternative failure is SILENT. A
 * multipoint create returns normally when it has drawn nothing; `drawShape`
 * reports `success: true` with a null entity id; and a shape that lands with no
 * text is invisible to the orphan sweep forever, because `findOrphans`
 * classifies an unlabelled shape as foreign and never touches it.
 *
 * Run: node --test tests/drawing_natives.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

import {
  planLegDrawing, drawPatternGeometry, patternPivots,
  labelPlacements, LABEL_COLLISION, fibDrawPlan, elliottDrawPlan, earningsLinePlan,
  EARNINGS_LINE, VOLUME_PROFILE_WINDOW,
  // P2.4 (2026-07-30) — the max-age cutoff for drawn geometry.
  MAX_PATTERN_AGE_BARS, patternAgePlan,
  // P2.4 review (2026-07-30) — the plan-level gate, extracted pure after a
  // neutered-condition mutation slipped past the source-text contract.
  planGate,
  // P3.2 (2026-07-30) — the hline merge tolerance, ATR-scaled, and the predicate
  // that decides it. Pure for the same reason planGate is.
  MERGE_TOLERANCE, mergeTolerance, sameLevel,
} from '../src/core/assessment_draw.js';
import { NATIVE_PATTERN_SHAPES, MULTIPOINT_SETTLE, drawShape } from '../src/core/drawing.js';
import { accountSettings } from '../src/core/rules.js';
import { isMcpText } from '../src/core/orphans.js';
import { assess } from '../src/core/assessment.js';
// P2.4 (2026-07-30) — the two sources the default is derived from, and the
// selector the cutoff has to run in front of.
import { THROWBACK_STATS } from '../src/core/breakout.js';
import { HORIZON_ZONES } from '../src/core/horizon.js';
import { planPatternDrawings } from '../src/core/patterns_draw.js';

// ── fixtures ────────────────────────────────────────────────────────────────

/** Bars from a price path. Distinct highs and lows, so no pivot ties. */
function barsFrom(path, t0 = 1700000000) {
  return path.map((p, i) => ({
    time: t0 + i * 86400,
    open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1000,
  }));
}

/** A zigzag with `turns` reversals — enough alternating pivots for the 7-point tool. */
function zigzag(turns, legLen = 6, base = 100, amp = 8) {
  const out = [];
  for (let t = 0; t <= turns; t += 1) {
    const from = base + (t % 2 ? amp : 0);
    const to = base + (t % 2 ? 0 : amp);
    for (let i = 0; i < legLen; i += 1) out.push(from + ((to - from) * i) / legLen + t * 0.01 + i * 0.001);
  }
  return out;
}

const HNS = {
  pattern: 'head_and_shoulders',
  status: 'confirmed',
  direction: 'bearish',
  completion_level: null,
  measurements: { left_shoulder: 104, head: 108, right_shoulder: 105, neckline: 100 },
};

/** Records the LABEL each draw was made under — enough to tell the paths apart. */
function recorder() {
  const labels = [];
  return {
    labels,
    put: async (fn, label) => { labels.push(label); return { success: true, entity_id: `id-${labels.length}` }; },
    hline: async (price, opts, label) => { labels.push(label); },
  };
}

// ── P1.1 — the position tool, and the fallback that must remain ─────────────

describe('planLegDrawing — position tool or three lines, and it never guesses', () => {
  const ACCOUNT = { account_size: 20000, risk_percent: 1, rules_path: 'rules.json' };
  const LONG = { entry: 100, stop: 95, target: 115, rr: 3 };

  test('a complete long leg with a configured account draws the position tool', () => {
    const p = planLegDrawing(LONG, 'long', ACCOUNT);
    assert.equal(p.mode, 'position');
    assert.deepEqual(
      { d: p.direction, e: p.entry, s: p.stop, t: p.target, a: p.account_size, r: p.risk_percent },
      { d: 'long', e: 100, s: 95, t: 115, a: 20000, r: 1 },
    );
  });

  test('a complete short leg draws the position tool', () => {
    assert.equal(planLegDrawing({ entry: 100, stop: 105, target: 88 }, 'short', ACCOUNT).mode, 'position');
  });

  test('NO ACCOUNT falls back to lines, and names the file to set it in', () => {
    /**
     * The three-line path is not dead code — it is what runs on any machine whose
     * rules.json has no account block. `account_size` is null in DEFAULT_RULES on
     * purpose: a live analysis once invented $100,000 because there was nowhere to
     * read it, and a size derived from an invented account is indistinguishable
     * from a correct one. So the tool that would display that size is not drawn.
     */
    for (const acct of [null, undefined, {}, { account_size: null, risk_percent: 1 }, { account_size: 20000, risk_percent: 0 }]) {
      const p = planLegDrawing(LONG, 'long', acct);
      assert.equal(p.mode, 'lines', `account ${JSON.stringify(acct)} should fall back`);
      assert.match(p.why, /account size or risk percent/);
    }
    assert.match(planLegDrawing(LONG, 'long', null).why, /rules\.json/);
  });

  test('a MISSING rules.json really does reach the fallback — through accountSettings', () => {
    // The unit above asserts the decision; this asserts the wiring that feeds it,
    // because a `roots` argument that silently fell through to the developer's own
    // rules.json would make the test pass for the wrong reason.
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-rules-'));
    try {
      const empty = accountSettings(null, { roots: [join(dir, 'nope.json')] });
      assert.equal(empty.account_size, null, 'a missing rules.json must not produce an account size');
      assert.equal(planLegDrawing(LONG, 'long', empty).mode, 'lines');

      const path = join(dir, 'rules.json');
      writeFileSync(path, JSON.stringify({ account: { account_size: 20000, risk_percent: 1 } }));
      const real = accountSettings(null, { roots: [path] });
      assert.equal(real.account_size, 20000);
      assert.equal(planLegDrawing(LONG, 'long', real).mode, 'position');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a leg with no TARGET falls back — the tool encodes target as a tick offset', () => {
    const p = planLegDrawing({ entry: 100, stop: 95 }, 'long', ACCOUNT);
    assert.equal(p.mode, 'lines');
    assert.match(p.why, /missing target/);
  });

  test('a leg with no stop falls back and says which price is missing', () => {
    assert.match(planLegDrawing({ entry: 100, target: 115 }, 'long', ACCOUNT).why, /missing stop/);
  });

  test('levels that contradict the direction fall back instead of throwing', () => {
    /**
     * `drawPosition` throws on a long whose stop sits above entry — correct for a
     * tool call, wrong here: a throw would lose the levels entirely. Three honest
     * lines beat nothing.
     */
    const p = planLegDrawing({ entry: 100, stop: 105, target: 115 }, 'long', ACCOUNT);
    assert.equal(p.mode, 'lines');
    assert.match(p.why, /contradict its direction/);
    assert.equal(planLegDrawing({ entry: 100, stop: 95, target: 90 }, 'long', ACCOUNT).mode, 'lines');
    assert.equal(planLegDrawing({ entry: 100, stop: 95, target: 115 }, 'short', ACCOUNT).mode, 'lines');
  });

  test('a side that is neither long nor short falls back', () => {
    assert.equal(planLegDrawing(LONG, 'both', ACCOUNT).mode, 'lines');
  });

  test('an explicit NULL price is MISSING, not a price of zero', () => {
    /**
     * `Number(null)` is 0, and 0 is finite — so a leg carrying `stop: null` was
     * read as a stop AT zero, and the position tool would have been drawn sizing
     * risk against it. An absent key gave `undefined` and refused correctly, which
     * is why this survived: the two spellings of "no value" behaved differently.
     */
    for (const key of ['entry', 'stop', 'target']) {
      const p = planLegDrawing({ ...LONG, [key]: null }, 'long', ACCOUNT);
      assert.equal(p.mode, 'lines', `${key}: null must fall back`);
      assert.match(p.why, new RegExp(`missing ${key}`));
    }
  });
});

// ── P1.3 — the native 7-point head and shoulders, and its pivot floor ───────

describe('head and shoulders — one native entity, never a partial one', () => {
  test('7 real alternating pivots draw ONE native tool, not six leg lines', async () => {
    const bars = barsFrom(zigzag(8));
    const pv = patternPivots(bars, bars[0].time, bars[bars.length - 1].time, 7);
    assert.ok(pv.length >= 7, `fixture must produce 7+ pivots, got ${pv.length}`);

    const r = recorder();
    await drawPatternGeometry(
      { ...HNS, from_time: bars[0].time, to_time: bars[bars.length - 1].time },
      bars, 'g', r.put, r.hline,
    );
    assert.ok(r.labels.includes('pattern head_and_shoulders head and shoulders'),
      `expected the native tool, got ${JSON.stringify(r.labels)}`);
    assert.equal(r.labels.filter((l) => /leg \d/.test(l)).length, 0,
      'the six trend lines must be gone — the native tool landed 7 of 7 points on 2026-07-30');
    assert.ok(r.labels.includes('pattern head_and_shoulders neckline'),
      'the neckline is the TRIGGER and dedupes against other levels, so it stays an hline');
  });

  test('FEWER than 7 pivots falls back to leg lines and never arms the 7-point tool', async () => {
    /**
     * Given fewer points than it declares, a native pattern tool places what it
     * has and stays ARMED — measured on triangle_pattern, 2 of 5, with the drawing
     * cursor still live afterwards. That is the garbage this file spent a release
     * removing, so the floor is a hard one.
     */
    const bars = barsFrom(zigzag(2, 10));
    const pv = patternPivots(bars, bars[0].time, bars[bars.length - 1].time, 7);
    assert.ok(pv.length >= 2 && pv.length < 7, `fixture must produce 2-6 pivots, got ${pv.length}`);

    const r = recorder();
    await drawPatternGeometry(
      { ...HNS, from_time: bars[0].time, to_time: bars[bars.length - 1].time },
      bars, 'g', r.put, r.hline,
    );
    assert.equal(r.labels.filter((l) => l.includes('head and shoulders')).length, 0,
      'a 7-point tool must never be drawn with fewer than 7 real pivots');
    assert.ok(r.labels.some((l) => /leg 1$/.test(l)), `expected leg lines, got ${JSON.stringify(r.labels)}`);
    assert.equal(r.labels.filter((l) => /leg \d/.test(l)).length, pv.length - 1,
      'one leg per real pivot pair — nothing interpolated');
  });

  test('no pivots at all draws no shape, and still draws the neckline', async () => {
    const bars = barsFrom(Array.from({ length: 40 }, (_, i) => 100 + i));   // monotonic: no pivots
    assert.equal(patternPivots(bars, bars[0].time, bars[bars.length - 1].time, 7).length, 0);

    const r = recorder();
    await drawPatternGeometry(
      { ...HNS, from_time: bars[0].time, to_time: bars[bars.length - 1].time },
      bars, 'g', r.put, r.hline,
    );
    assert.deepEqual(r.labels, ['pattern head_and_shoulders neckline']);
  });
});

// ── P1.2 / P1.4 / P1.10 — the shape catalogue and its point counts ──────────

describe('NATIVE_PATTERN_SHAPES — the point counts drawShape validates against', () => {
  test('head_and_shoulders takes 7 and parallel_channel takes 3', () => {
    assert.equal(NATIVE_PATTERN_SHAPES.head_and_shoulders, 7);
    assert.equal(NATIVE_PATTERN_SHAPES.parallel_channel, 3,
      'the channel is one entity now; without a declared count a wrong call draws a flag mark');
  });

  test('a wrong point count is refused BEFORE the chart is touched', async () => {
    // TradingView does not reject a wrong count — it silently draws something
    // else. These rejections happen before `getChartApi`, so they hold with or
    // without a live chart.
    await assert.rejects(
      () => drawShape({ shape: 'parallel_channel', points: [{ price: 1 }, { price: 2 }, { price: 3 }, { price: 4 }] }),
      /needs exactly 3 points, got 4/);
    await assert.rejects(
      () => drawShape({ shape: 'head_and_shoulders', points: [{ price: 1 }, { price: 2 }, { price: 3 }] }),
      /needs exactly 7 points, got 3/);
  });

  test('triangle_pattern is still declared, and still not used', () => {
    // Kept in the map so a caller that reaches for it gets the point-count guard,
    // and recorded in the comment block as BROKEN (2 of 5, reproducibly) so nobody
    // re-adopts it on the strength of head_and_shoulders working.
    assert.equal(NATIVE_PATTERN_SHAPES.triangle_pattern, 5);
  });

  test('the do-not-use shapes are absent from the catalogue', () => {
    // price_label creates nothing at all; curve landed 2 of 3. Listing either
    // would make it look adoptable.
    assert.equal(NATIVE_PATTERN_SHAPES.price_label, undefined);
    assert.equal(NATIVE_PATTERN_SHAPES.curve, undefined);
  });
});

// ── P1.11 — the multipoint settle is bounded, not a guess ───────────────────

describe('MULTIPOINT_SETTLE — polling bounds', () => {
  test('polls often enough to beat the old fixed sleep, and gives up', () => {
    assert.ok(MULTIPOINT_SETTLE.interval_ms > 0 && MULTIPOINT_SETTLE.interval_ms <= 250,
      'a poll slower than the old 500ms sleep would be a regression in both directions');
    assert.ok(MULTIPOINT_SETTLE.budget_ms >= 500,
      'the budget must exceed the sleep it replaced, or late creates still escape id capture');
    assert.ok(MULTIPOINT_SETTLE.budget_ms <= 5000, 'and it must be BOUNDED — an unbounded wait hangs a batch run');
  });
});

// ── signatures: what the natives cost, and what still must match ───────────

describe('label signatures after the native adoption', () => {
  test('the RETIRED channel-boundary labels are still recognised', () => {
    /**
     * The parallel_channel carries no text, so nothing writes "<pattern> upper"
     * any more. The signature stays because signatures are APPEND-ONLY: every
     * chart drawn before today still carries those labels, and deleting the
     * pattern would make exactly the oldest drawings unrecoverable.
     */
    assert.equal(isMcpText('descending_channel upper'), true);
    assert.equal(isMcpText('ascending_channel lower'), true);
  });

  test('the head-and-shoulders FALLBACK label is registered', () => {
    // The native tool is textless, but the leg fallback still writes a label on
    // its first leg — and a label matching no signature leaks a permanent orphan.
    assert.equal(isMcpText('head_and_shoulders confirmed'), true);
    assert.equal(isMcpText('inverse_head_and_shoulders forming'), true);
    assert.equal(isMcpText('head_and_shoulders confirmed — breaks at 100'), true);
  });

  test('the three-line fallback labels are registered', () => {
    // The fallback is the only text-bearing path for a trade plan now, so its
    // labels are the only ones the orphan sweep can ever recover.
    assert.equal(isMcpText('ENTRY long 100 — head_and_shoulders'), true);
    assert.equal(isMcpText('STOP 95 — head_and_shoulders'), true);
    assert.equal(isMcpText('TARGET 115 (R:R 3) — head_and_shoulders'), true);
  });
});

// ── P1.6 — label collision: the line stays, the TEXT moves ──────────────────

describe('labelPlacements — which labels come off the line, and where they go', () => {
  const L = (price, text) => ({ price, text });

  test('a short label at a lonely price stays ON its line', () => {
    const out = labelPlacements([L(100, 'R 100 (1.2%)')], 2);
    assert.equal(out.length, 1);
    assert.equal(out[0].mode, 'line');
    assert.equal(out[0].why, null);
  });

  test('a LONG label comes off the line even with nothing near it', () => {
    /**
     * "S 14.84 (0.07%) - 9 tests, 1.4x vol" is 34 characters and runs left across
     * the bars from the price scale regardless of what else is on the chart. That
     * is the ALM/MTSI overprinting, and the hline dedupe cannot touch it: these are
     * DIFFERENT prices that each deserve a line.
     */
    const text = 'S 14.84 (0.07%) - 9 tests, 1.4x vol';
    assert.ok(text.length > LABEL_COLLISION.max_label_chars);
    const [p] = labelPlacements([L(14.84, text)], 0.5);
    assert.equal(p.mode, 'callout');
    assert.match(p.why, /chars, over 28/);
  });

  test('a PRICE within 0.35 ATR of one already labelled comes off the line', () => {
    // TIGO: primary resistance 100.415 and the supply-zone top 100.08. Two lines,
    // two labels, one patch of price scale.
    const out = labelPlacements([L(100.415, 'R 100.4'), L(100.08, 'supply 99-100.1')], 4);
    assert.equal(out[0].mode, 'line');
    assert.equal(out[1].mode, 'callout');
    assert.match(out[1].why, /within 0\.35 ATR .* of 100\.415/);
  });

  test('the SAME two prices are both fine when ATR is large enough to separate them', () => {
    // The trigger is ATR-relative on purpose: 0.35 ATR is the same visual distance
    // on a quiet large cap and a volatile small cap, which a fixed percentage is not.
    const out = labelPlacements([L(100.415, 'R 100.4'), L(100.08, 'supply 99-100.1')], 0.1);
    assert.deepEqual(out.map((x) => x.mode), ['line', 'line']);
  });

  test('with NO ATR only the length rule fires — proximity is unknown, not zero', () => {
    for (const atr of [null, undefined, 0, NaN, -1]) {
      const out = labelPlacements([L(100, 'R 100'), L(100.0001, 'S 100')], atr);
      assert.deepEqual(out.map((x) => x.mode), ['line', 'line'],
        `atr ${atr}: an unknown ATR must not be treated as a zero gap that collides everything`);
    }
    const out = labelPlacements([L(100, 'a'.repeat(40))], null);
    assert.equal(out[0].mode, 'callout', 'the length rule needs no ATR at all');
  });

  test('proximity is measured against ON-LINE labels only, never against callouts', () => {
    /**
     * A callout's text has already been moved away from the price scale, so a later
     * level next to it does NOT collide there. Measuring against callouts too would
     * cascade: one long label would push every neighbouring level off its line.
     */
    const out = labelPlacements([
      L(100, 'x'.repeat(40)),      // callout, by length
      L(100.1, 'R 100.1'),         // near the callout's price, but nothing is labelled there
    ], 4);
    assert.deepEqual(out.map((x) => x.mode), ['callout', 'line']);
  });

  test('callouts alternate above/below and step further out and further left', () => {
    const out = labelPlacements(
      Array.from({ length: 4 }, (_, i) => L(100 + i * 0.01, `${'y'.repeat(40)}${i}`)), 4,
    ).filter((x) => x.mode === 'callout');
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((x) => Math.sign(x.price_offset)), [1, -1, 1, -1],
      'alternating sides, or every box lands in the same gap');
    assert.ok(Math.abs(out[2].price_offset) > Math.abs(out[0].price_offset),
      'and each pair steps further out, or the third box overlaps the first');
    const lefts = out.map((x) => x.time_offset_bars);
    assert.deepEqual([...lefts].sort((a, b) => b - a), lefts, 'every callout steps further LEFT');
    assert.ok(lefts.every((x) => x < 0),
      'leftwards, into the chart — the space right of the last bar carries TradingView\'s own labels');
  });

  test('it is a LEFT FOLD, so the drawer can decide one level at a time', () => {
    /**
     * `hline` calls `labelPlacements(queueSoFar.concat(next)).at(-1)`, which is only
     * correct if a prefix decides the same way on its own as it does inside the whole
     * list. That makes the tested function and the production path the same function.
     */
    const all = [L(100, 'R 100'), L(100.1, 'z'.repeat(40)), L(100.2, 'supply 100-100.3'), L(80, 'S 80')];
    const whole = labelPlacements(all, 4);
    for (let i = 1; i <= all.length; i += 1) {
      const prefix = labelPlacements(all.slice(0, i), 4);
      assert.deepEqual(prefix, whole.slice(0, i), `prefix of length ${i} must decide identically`);
    }
  });

  test('degenerate input does not throw', () => {
    assert.deepEqual(labelPlacements([], 2), []);
    assert.deepEqual(labelPlacements(null, 2), []);
    assert.equal(labelPlacements([{}], 2)[0].mode, 'line');
    assert.equal(labelPlacements([{ price: NaN, text: 'w'.repeat(40) }], 2)[0].mode, 'callout');
  });
});

// ── P1.5 — the fibonacci gate ───────────────────────────────────────────────

describe('fibDrawPlan — drawn only while a retracement is actually in progress', () => {
  const ANCHOR = { from_time: 1700000000, from_price: 90, to_time: 1700864000, to_price: 110 };

  test('a live retracement draws, anchored to the impulse assess() measured', () => {
    const p = fibDrawPlan({ anchor: ANCHOR, retraced_pct: 45, in_golden_zone: true, direction: 'up' });
    assert.equal(p.draw, true);
    assert.deepEqual(p.points, [{ time: 1700000000, price: 90 }, { time: 1700864000, price: 110 }]);
    assert.match(p.why, /45%/);
  });

  test('a retracement OUTSIDE the golden zone still draws — the zone is not the gate', () => {
    // Gating on in_golden_zone would hide the grid for exactly the shallow and deep
    // pullbacks a reader most wants the levels for.
    assert.equal(fibDrawPlan({ anchor: ANCHOR, retraced_pct: 12.5, in_golden_zone: false }).draw, true);
    assert.equal(fibDrawPlan({ anchor: ANCHOR, retraced_pct: 88, in_golden_zone: false }).draw, true);
  });

  test('CONTINUATION is refused — price beyond the impulse is not a pullback', () => {
    for (const pct of [0, -0.1, -25]) {
      const p = fibDrawPlan({ anchor: ANCHOR, retraced_pct: pct });
      assert.equal(p.draw, false, `retraced ${pct}% must not draw`);
      assert.match(p.why, /extended beyond the impulse/);
    }
  });

  test('a fully retraced impulse is refused — the prior swing is broken, not retracing', () => {
    const p = fibDrawPlan({ anchor: ANCHOR, retraced_pct: 123 });
    assert.equal(p.draw, false);
    assert.match(p.why, /given back/);
  });

  test('no anchor, or a broken one, refuses rather than inventing a point', () => {
    assert.match(fibDrawPlan(null).why, /no anchor/);
    assert.match(fibDrawPlan({ retraced_pct: 45 }).why, /no anchor/);
    assert.match(fibDrawPlan({ anchor: { ...ANCHOR, to_time: null }, retraced_pct: 45 }).why, /missing a time or a price/);
    assert.match(fibDrawPlan({ anchor: ANCHOR, retraced_pct: null }).why, /no retracement was measured/);
  });

  test('assess() carries the anchor, and it matches the impulse it measured', () => {
    // The anchor is only useful if it is provably the SAME impulse retraced_pct
    // describes — otherwise the grid sits on one leg and the percentage on another.
    const bars = barsFrom(zigzag(6, 9));
    const a = assess(bars, null);
    assert.ok(a.fibonacci.anchor, 'assess() must expose the anchor');
    assert.equal(a.fibonacci.anchor.from_price, Math.round(a.fibonacci.impulse.from * 10000) / 10000);
    assert.equal(a.fibonacci.anchor.to_price, Math.round(a.fibonacci.impulse.to * 10000) / 10000);
    assert.ok(bars.some((b) => b.time === a.fibonacci.anchor.from_time), 'anchored to a real bar time');
    assert.ok(bars.some((b) => b.time === a.fibonacci.anchor.to_time));
    // and the keys the Sunday schema already publishes are untouched
    for (const k of ['retraced_pct', 'in_golden_zone', 'targets', 'targets_refused_reason']) {
      assert.ok(k in a.fibonacci, `${k} must survive — the fibonacci block is in the 2.0 schema`);
    }
  });
});

// ── P1.9 — the elliott gate: agreement, or nothing ──────────────────────────

describe('elliottDrawPlan — one count only when every sensitivity agreed', () => {
  const pivots = Array.from({ length: 6 }, (_, i) => ({ time: 1700000000 + i * 86400, price: 100 + i }));
  const AGREED = { distinct_recent_counts: 1, valid_counts: 3, agreeing_count: { direction: 'up', pivots } };

  test('agreement draws exactly six points', () => {
    const p = elliottDrawPlan(AGREED);
    assert.equal(p.draw, true);
    assert.equal(p.points.length, 6);
  });

  test('DISAGREEMENT never draws — the disagreement IS the finding', () => {
    /**
     * The restraint is the feature. A rule-valid count exists on 82% of random
     * walks (ELLIOTT_NOISE_BASELINE — it was 70.5% before the pivot backbone
     * landed and the floor got worse, not better); `surveyCounts` returns every
     * count the rules allow precisely so no single one is presented as THE
     * count, and drawing one on the chart is the strongest presentation there is.
     */
    for (const n of [2, 3, 5]) {
      const p = elliottDrawPlan({ ...AGREED, distinct_recent_counts: n });
      assert.equal(p.draw, false, `${n} distinct counts must not draw`);
      assert.match(p.why, /disagreement IS the finding/);
    }
  });

  test('no count at all, and no survey at all, both refuse', () => {
    assert.match(elliottDrawPlan({ distinct_recent_counts: 0 }).why, /no sensitivity produced/);
    assert.match(elliottDrawPlan(null).why, /no Elliott survey/);
    assert.match(elliottDrawPlan({}).why, /no Elliott survey/);
  });

  test('agreement with unusable pivots refuses rather than drawing a partial tool', () => {
    // A native pattern tool given fewer points than it declares places what it has
    // and leaves the drawing cursor ARMED — measured on triangle_pattern, 2 of 5.
    assert.match(elliottDrawPlan({ distinct_recent_counts: 1 }).why, /no six usable pivots/);
    assert.match(elliottDrawPlan({ distinct_recent_counts: 1, agreeing_count: { pivots: pivots.slice(0, 5) } }).why, /no six usable pivots/);
    assert.match(elliottDrawPlan({
      distinct_recent_counts: 1,
      agreeing_count: { pivots: [...pivots.slice(0, 5), { time: null, price: 1 }] },
    }).why, /no six usable pivots/);
  });

  test('assess() carries the agreeing count ONLY when the sensitivities agree', () => {
    /**
     * A textbook five-wave impulse with a confirmed low before wave 1 — without
     * that leading swing there are five alternating swings and a count needs six.
     */
    const legs = [[112, 100, 12], [100, 110, 14], [110, 104, 10], [104, 128, 20], [128, 120, 10], [120, 136, 16]];
    const path = [112];
    for (const [from, to, n] of legs) for (let i = 1; i <= n; i += 1) path.push(from + ((to - from) * i) / n);
    for (let i = 0; i < 10; i += 1) path.push(path.at(-1) - 0.5);
    const a = assess(barsFrom(path), null);

    assert.equal(a.elliott.distinct_recent_counts, 1, 'fixture must produce agreement');
    assert.ok(a.elliott.agreeing_count, 'and assess() must carry it');
    assert.equal(a.elliott.agreeing_count.pivots.length, 6);
    assert.equal(elliottDrawPlan(a.elliott).draw, true);

    // The same block with the agreement removed must refuse — the gate reads the
    // survey's own verdict, not the presence of a count object.
    assert.equal(elliottDrawPlan({ ...a.elliott, distinct_recent_counts: 2 }).draw, false);

    // A chart with no countable impulse carries no count at all.
    const flat = assess(barsFrom(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 9) * 2)), null);
    if (flat.elliott.distinct_recent_counts !== 1) assert.equal(flat.elliott.agreeing_count, null);
  });
});

// ── P1.7 — the earnings line, and the date it refuses ───────────────────────

describe('earningsLinePlan — a catalyst ahead, never one behind', () => {
  const NOW = Date.parse('2026-07-30T14:00:00Z') / 1000;

  test('a date inside the window draws, with the days on the label', () => {
    const p = earningsLinePlan({ date: '2026-08-26', days_until: 27 }, { now: NOW, last_bar_time: NOW });
    assert.equal(p.draw, true);
    assert.equal(p.days, 27);
    assert.equal(p.text, 'earnings 2026-08-26 (27d)');
    assert.equal(p.beyond_last_bar, true,
      'probed 2026-07-30: a vertical_line beyond the last bar CREATES, and TradingView snaps it to the next session');
  });

  test('a PAST date is refused — it is history, not catalyst risk', () => {
    /**
     * The one guard that matters most. A line behind price reads identically to a
     * live catalyst, and on a chart there is nothing to distinguish them.
     */
    for (const d of ['2026-07-29', '2026-07-01', '2025-11-04']) {
      const p = earningsLinePlan({ date: d }, { now: NOW });
      assert.equal(p.draw, false, `${d} must not draw`);
      assert.match(p.why, /in the PAST/);
    }
  });

  test('a date LATER TODAY still draws — today is not the past', () => {
    const p = earningsLinePlan({ date: '2026-07-30' }, { now: NOW });
    assert.equal(p.draw, true);
    assert.equal(p.days, 0);
    assert.equal(p.text, 'earnings 2026-07-30 (0d)');
  });

  test('beyond the 45-day window it is refused, and says how far out', () => {
    assert.equal(earningsLinePlan({ date: '2026-09-13' }, { now: NOW }).draw, true, '45 days is inside');
    const p = earningsLinePlan({ date: '2026-10-26' }, { now: NOW });
    assert.equal(p.draw, false);
    assert.match(p.why, /88 days out, past the 45-day window/);
    assert.equal(EARNINGS_LINE.max_days_ahead, 45);
  });

  test('"N/A (ETF)" is an ANSWER, not a broken date', () => {
    // TA writes it for every fund. Treating it as a parse failure would report a
    // fault on the most ordinary row in the calendar.
    const p = earningsLinePlan({ date: 'N/A (ETF)' }, { now: NOW });
    assert.equal(p.draw, false);
    assert.match(p.why, /is not a date/);
  });

  test('nothing supplied draws nothing, and never throws', () => {
    for (const e of [null, undefined, {}, { date: null }, { date: '' }]) {
      assert.equal(earningsLinePlan(e, { now: NOW }).draw, false);
    }
  });

  test('the DATE wins when TA\'s own days_until disagrees with it', () => {
    // The line is placed by the date, so the label must count from the date too —
    // a caption that contradicts the position it is captioning is worse than none.
    const p = earningsLinePlan({ date: '2026-08-26', days_until: 3 }, { now: NOW });
    assert.equal(p.days, 27);
    assert.equal(p.reported_days_until, 3);
  });

  test('the label format is REGISTERED — an unregistered label leaks forever', () => {
    // Unlike the textless natives, a vertical_line keeps its text and so IS
    // sweepable. That only helps if orphans.js recognises the format.
    assert.equal(isMcpText('earnings 2026-08-26 (27d)', { sources: ['review'] }), true);
    assert.equal(isMcpText('earnings 2026-07-30 (0d)', { sources: ['review'] }), true);
    assert.equal(isMcpText('earnings soon', { sources: ['review'] }), false);
  });
});

// ── P1.6 — every callout carries a REGISTERED text ──────────────────────────

describe('callout labels are sweepable — every format matches a signature', () => {
  /**
   * A callout carries the level's text UNCHANGED, which is the whole reason the
   * label CONTENT was not touched: the strings below are the orphan sweep's only
   * handle on the horizontal-line path, and rewording one to fit a box would
   * strand every drawing that carries the old wording.
   *
   * So "every callout format matches a signature" is the same assertion as "every
   * label the drawer writes matches a signature" — and one of them did not.
   */
  const EVERY_LABEL = [
    'S 14.84 (0.07%)',
    'R 100.415 (5.5%)',
    // WITH the evidence suffix — the format that was NOT registered. Measured live
    // on 2026-07-30: isMcpText returned false, so every primary level drawn with a
    // reason has been invisible to the sweep.
    'S 14.84 (0.07%) - 9 tests, 1.4x vol',
    'R 36.99 (5.5%) - 3 tests',
    'S 14.84 (0.07%) - ',                    // shortReason can compose an empty suffix
    'demand 33.16-34.2',
    'supply 1411.5-1573.09',
    'ENTRY long 30.77 — double_bottom',
    'STOP 26.11 — double_bottom',
    'TARGET 34.76 (R:R 0.86) — double_bottom',
    'VCP pivot 34.2',
    'TA stop 1862.51 (exit)',
    'head_and_shoulders confirmed — breaks at 100',
    'falling_wedge forming — completes 22.3',
    'earnings 2026-08-26 (27d)',
  ];

  test('every label the drawer can put on a line — or in a callout — is recognised', () => {
    for (const text of EVERY_LABEL) {
      assert.equal(isMcpText(text, { sources: ['review'] }), true,
        `"${text}" matches no review signature — a callout carrying it leaks a permanent orphan`);
    }
  });

  test('and the signatures still refuse text we do not write', () => {
    // The cost of a missed orphan is a stale line; the cost of a false match is
    // deleting the user's own analysis. They are not symmetric.
    for (const text of ['my support', 'S', 'buy here', 'S 14.84', 'earnings', 'Support 14.84 (0.07%) - notes']) {
      assert.equal(isMcpText(text, { sources: ['review'] }), false, `"${text}" must NOT match`);
    }
  });
});

// ── P1.8 — the opt-in volume profile window ─────────────────────────────────

describe('the fixed-range volume profile spans assess()\'s own window', () => {
  test('the window is 90 bars, the same slice assess() measures the value area over', () => {
    /**
     * Two windows would drift silently — the shading would describe one profile and
     * the reported VAH/VAL another, with nothing in the output saying so. That is
     * this repo's most-repeated failure, so the constant is exported and asserted
     * against the measurement's own source.
     */
    assert.equal(VOLUME_PROFILE_WINDOW, 90);
    const a = readFileSync(`${process.cwd()}/src/core/assessment.js`, 'utf8');
    assert.match(a, /C\.volumeProfile\(bars\.slice\(-90\)\)/,
      'assess() must still measure over 90 bars, or VOLUME_PROFILE_WINDOW is now a lie');
  });
});

// ── P2.4 (2026-07-30) — the max-age cutoff: old geometry is REPORTED, not drawn ──

describe('patternAgePlan — a pattern past its measured window is reported, not drawn', () => {
  /** A structural pattern, the only family whose `bars_ago` is ever non-zero. */
  const hns = (bars_ago, over = {}) => ({
    pattern: 'head_and_shoulders', direction: 'bearish', status: 'confirmed',
    completion_level: 100, meeting_target_pct: 55,
    measurements: { left_shoulder: 104, head: 108, right_shoulder: 105, neckline: 100 },
    bars_ago, ...over,
  });

  test('the default is 21 bars, and every term of it is DERIVED', () => {
    /**
     * Not taste, and not a round number. Two independent sources land on the same
     * window, and the constant has to keep agreeing with both of them.
     */
    assert.equal(MAX_PATTERN_AGE_BARS, 21);

    // BULKOWSKI. Every base rate a drawn pattern carries is measured from the
    // breakout onward, and his own convention bounds that measurement at 30
    // CALENDAR days — ~21 trading bars. Taking the 30 literally as 30 BARS is the
    // error readThrowback calls out beside its own window.
    assert.equal(THROWBACK_STATS.window_days, 30);
    assert.match(THROWBACK_STATS.window_quote, /within 30 calendar days/);
    assert.equal(THROWBACK_STATS.measured_on, 'daily bars');
    assert.equal(Math.round(THROWBACK_STATS.window_days * (5 / 7)), MAX_PATTERN_AGE_BARS,
      '30 calendar days in trading bars IS the cutoff — if these stop agreeing, one of them moved');

    // THIS REPO'S OWN HORIZON BOUNDARY, measured in trading days.
    assert.equal(HORIZON_ZONES.reversal.max_days, MAX_PATTERN_AGE_BARS,
      'below ~21 trading days the documented effect is REVERSAL — a shape older than a full '
      + 'reversal window is being drawn into the stretch its own logic is weakest in');

    // And it must sit INSIDE the detector's own age filter, or it is dead code:
    // nothing older than 60 bars is ever returned to be excluded.
    const p = readFileSync(`${process.cwd()}/src/core/patterns.js`, 'utf8');
    assert.match(p, /max_age_bars = 60/, "detectPatterns' own filter must still be the outer bound");
    assert.ok(MAX_PATTERN_AGE_BARS < 60, 'a cutoff at or beyond the detector\'s could never fire');
  });

  test('a STALE CONFIRMED pattern is excluded, with the age AND the threshold in the reason', () => {
    /**
     * The GRMN case, in the owner's own numbers: a confirmed head-and-shoulders
     * whose structure completed 41 bars ago still drew its seven shapes at full
     * weight. `patternRank` never excluded it — recency is its THIRD key, so age
     * only ever broke a tie.
     */
    const r = patternAgePlan([hns(41)]);
    assert.equal(r.fresh.length, 0);
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0].pattern, 'head_and_shoulders');
    assert.equal(r.stale[0].bars_ago, 41);
    assert.equal(r.stale[0].max_age_bars, 21);
    assert.equal(r.stale[0].stale, true);
    assert.match(r.stale[0].why, /confirmed 41 bars ago/, 'the reason must carry the AGE');
    assert.match(r.stale[0].why, /21-bar max age/, 'and the THRESHOLD it failed');
    assert.match(r.stale[0].why, /moved on/);
  });

  test('a FRESH confirmed pattern is drawn, untouched', () => {
    const r = patternAgePlan([hns(3)]);
    assert.equal(r.stale.length, 0);
    assert.deepEqual(r.fresh, [hns(3)], 'the pattern object must pass through whole — the geometry '
      + 'is reconstructed from its measurements');
  });

  test('the boundary is EXACTLY N: N is drawn, N+1 is not', () => {
    // `>` rather than `>=`. A pattern at exactly the cutoff is inside the window
    // its statistics were measured over.
    assert.equal(patternAgePlan([hns(21)]).stale.length, 0, '21 bars is inside a 21-bar window');
    assert.equal(patternAgePlan([hns(22)]).stale.length, 1, 'and 22 is past it');
    assert.equal(patternAgePlan([hns(7)], 7).stale.length, 0, 'the same boundary on an override');
    assert.equal(patternAgePlan([hns(8)], 7).stale.length, 1);
  });

  test('NULL and INFINITY disable the cutoff — and null must not become a ZERO-bar one', () => {
    /**
     * `Number(null)` is 0, and 0 is finite: the obvious implementation turns "no
     * cutoff" into the harshest cutoff possible, silently. Three live bites in this
     * repo already — the fibonacci `retraced_pct` read, a position leg's null stop,
     * the breadth spread computed from a missing field.
     */
    for (const off of [null, Infinity, '', NaN, -1]) {
      const r = patternAgePlan([hns(0), hns(45), hns(400)], off);
      assert.equal(r.stale.length, 0, `${String(off)} must disable the cutoff, not tighten it`);
      assert.equal(r.fresh.length, 3);
      assert.equal(r.cutoff_applied, false);
      assert.equal(r.max_age_bars, Infinity);
    }
    // UNDEFINED is different and must stay so: it is the JS default-parameter
    // spelling of "I did not pass one", which means the DEFAULT, not "disabled".
    assert.equal(patternAgePlan([hns(45)], undefined).stale.length, 1);
    assert.equal(patternAgePlan([hns(45)]).stale.length, 1);
    // 0 is a real window — only the patterns ending on the current bar survive it.
    const zero = patternAgePlan([hns(0), hns(1)], 0);
    assert.deepEqual([zero.fresh.length, zero.stale.length], [1, 1]);
    assert.equal(zero.cutoff_applied, true);
  });

  test('an UNMEASURABLE age is not a large one — unknown never excludes', () => {
    /**
     * `detectPatterns` writes `bars_ago: null` when it cannot locate `to_time`
     * among the bars. Unknown is not evidence: the same rule `prune` follows when
     * `currentSymbol()` returns null, and the liquidity constraint follows when
     * `adv` is absent.
     */
    for (const missing of [null, undefined, '']) {
      const r = patternAgePlan([hns(missing)]);
      assert.equal(r.stale.length, 0, `bars_ago ${String(missing)} must not read as stale`);
      assert.equal(r.fresh.length, 1);
    }
    const noKey = { pattern: 'double_top', status: 'forming', completion_level: 10 };
    assert.equal(patternAgePlan([noKey]).fresh.length, 1);
  });

  test('FORMING patterns are covered too, because bars_ago is their last structural progress', () => {
    /**
     * The original complaint was a bearish head-and-shoulders "that had stopped
     * forming 45 bars earlier". For structural patterns `to_time` is the last
     * defining PIVOT, so `bars_ago` measures exactly that: a shape whose last swing
     * was 45 bars back has made no progress since, whatever price has done to its
     * neckline meanwhile.
     */
    const r = patternAgePlan([hns(45, { status: 'forming' })]);
    assert.equal(r.stale.length, 1);
    assert.match(r.stale[0].why, /^forming 45 bars ago/, 'the reason must name the status it excluded');
    assert.equal(r.stale[0].status, 'forming');
  });

  test('a wedge or a flag can never be stale — their windows end at the current bar', () => {
    /**
     * Stated as a test rather than as a comment because it is the honest scope of
     * this cutoff. `trendlinePatterns`, `flagPatterns` and `pennantPatterns` all set
     * `to_time` to the LAST BAR of the series, so `bars_ago` is 0 by construction
     * and nothing in that family can ever trip the threshold. Correct: a wedge
     * fitted through the bars up to today is not old.
     */
    const p = readFileSync(`${process.cwd()}/src/core/patterns.js`, 'utf8');
    assert.match(p, /p\.bars_ago = endIdx >= 0 \? lastIndex - endIdx : null;/,
      'bars_ago must still be measured from to_time, or this cutoff keys on something else');
    assert.equal(patternAgePlan([{ pattern: 'rising_wedge', status: 'confirmed', bars_ago: 0 }]).stale.length, 0);
  });

  test('the report says the cutoff RAN even when it excluded nothing', () => {
    // "Excluded nothing" and "did not run" are different answers, and a reader who
    // cannot tell them apart cannot trust either.
    const r = patternAgePlan([hns(2)]);
    assert.equal(r.cutoff_applied, true);
    assert.equal(r.max_age_bars, 21);
  });

  test('degenerate input does not throw', () => {
    for (const input of [null, undefined, []]) {
      assert.deepEqual(patternAgePlan(input).stale, []);
      assert.deepEqual(patternAgePlan(input).fresh, []);
    }
  });
});

describe('the age cutoff runs BEFORE the NEUTRAL selection, never after', () => {
  const P = (pattern, bars_ago, over = {}) => ({
    pattern, direction: 'bearish', status: 'confirmed', completion_level: 100,
    measurements: { resistance_now: 102, support_now: 97 }, bars_ago, ...over,
  });

  test('NEUTRAL picks the best of the NON-stale, not the best overall', () => {
    /**
     * `patternRank` is [confirmed first, then meeting-target rate, then recency], so
     * a STALE CONFIRMED pattern outranks a FRESH FORMING one on the first key alone.
     * Filtering after the selection would therefore hand NEUTRAL a stale winner and
     * then delete it, drawing nothing while a live shape sat unused.
     */
    const staleConfirmed = P('head_and_shoulders', 45);
    const freshForming = P('double_top', 2, { status: 'forming' });

    const unfiltered = planPatternDrawings([staleConfirmed, freshForming], { bias: 'NEUTRAL' });
    assert.deepEqual(unfiltered.patterns.map((x) => x.pattern), ['head_and_shoulders'],
      'without the age filter the stale confirmed pattern is the one NEUTRAL draws');

    const { fresh } = patternAgePlan([staleConfirmed, freshForming]);
    const filtered = planPatternDrawings(fresh, { bias: 'NEUTRAL' });
    assert.deepEqual(filtered.patterns.map((x) => x.pattern), ['double_top'],
      'with it, the live shape is drawn instead');
  });

  test('when EVERY candidate is stale, NEUTRAL draws NOTHING', () => {
    /**
     * Drawing the least-stale would repaint exactly what this cutoff exists to
     * stop. Nothing is lost — every one of them comes back in `stale`, which the
     * drawer concatenates into `patterns_skipped`.
     */
    const all = [P('head_and_shoulders', 45), P('double_top', 51), P('triple_bottom', 33)];
    const { fresh, stale } = patternAgePlan(all);
    assert.equal(stale.length, 3);
    const plan = planPatternDrawings(fresh, { bias: 'NEUTRAL' });
    assert.deepEqual(plan.patterns, [], 'a stale-only chart draws no geometry at all');
    assert.deepEqual(plan.skipped, [], 'and the selector reports nothing, because the age filter already did');
  });

  test('a BULLISH/BEARISH verdict is unaffected in kind — age removes, bias filters', () => {
    // The two gates are independent and both report. A pattern can fail either.
    const staleOnSide = P('head_and_shoulders', 45);
    const freshOffSide = P('double_bottom', 3, { direction: 'bullish' });
    const { fresh, stale } = patternAgePlan([staleOnSide, freshOffSide]);
    assert.deepEqual(stale.map((s) => s.pattern), ['head_and_shoulders']);
    const plan = planPatternDrawings(fresh, { bias: 'BEARISH' });
    assert.deepEqual(plan.patterns, []);
    assert.match(plan.skipped[0].why, /contradicts the BEARISH verdict/);
  });
});

describe('patterns_draw stays UNGATED — it is the tool for SEEING patterns', () => {
  test('it never goes through drawFindings, so no cutoff can reach it', () => {
    /**
     * The same principle `bias` follows: an explicit verdict narrows what the
     * WORKFLOW puts on the chart, while `patterns_draw` answers the question the
     * owner actually asked — show me the patterns. It calls `planPatternDrawings`
     * and `drawPatternGeometry` directly, so it is ungated by construction rather
     * than by an opt-out somebody has to remember to pass.
     */
    const t = readFileSync(`${process.cwd()}/src/tools/patterns.js`, 'utf8');
    assert.match(t, /import \{ planPatternDrawings \} from '\.\.\/core\/patterns_draw\.js'/);
    assert.match(t, /import \{ drawPatternGeometry \} from '\.\.\/core\/assessment_draw\.js'/);
    assert.ok(!/drawFindings/.test(t),
      'patterns_draw must not route through the workflow drawer — that is where the cutoff lives');
    assert.ok(!/max_pattern_age_bars|patternAgePlan/.test(t),
      'and it must not acquire its own copy of the cutoff either');
  });

  test('the selector itself is age-blind, so the tool draws a 200-bar-old shape', () => {
    const old = {
      pattern: 'head_and_shoulders', direction: 'bearish', status: 'confirmed',
      completion_level: 100, bars_ago: 200,
      measurements: { left_shoulder: 104, head: 108, right_shoulder: 105, neckline: 100 },
    };
    assert.equal(planPatternDrawings([old]).patterns.length, 1,
      'planPatternDrawings must stay the SELECTOR; the age cutoff belongs to the caller that draws '
      + 'a verdict, not to the one that answers "show me what is there"');
  });
});

// ---------------------------------------------------------------------------
// P2.4 review (2026-07-30). The original plan-suppression contract was a
// source-text regex, and a neutered condition — `if (false && ...)` — passed
// all 97 tests while letting a stale pattern's ENTRY, STOP and TARGET back
// onto the chart. These are calls, not greps: they fail when the BEHAVIOUR
// dies, whatever the source looks like.
// ---------------------------------------------------------------------------
describe('planGate — the plan-level gate, behaviourally', () => {
  const staleMap = new Map([['inverse_head_and_shoulders', {
    pattern: 'inverse_head_and_shoulders', bars_ago: 41, max_age_bars: 21,
  }]]);

  test('a stale pattern\'s plan is suppressed with the age AND the threshold in the reason', () => {
    const g = planGate({ pattern: 'inverse_head_and_shoulders', tradeable_now: true }, staleMap, new Set());
    assert.equal(g.keep, false);
    assert.equal(g.entry.stale, true);
    assert.equal(g.entry.bars_ago, 41);
    assert.match(g.entry.why, /41 bars old/);
    assert.match(g.entry.why, /21-bar max age/);
  });

  test('the fails-open case: EMPTY drawn set still suppresses a stale plan', () => {
    /**
     * "Every candidate was stale" empties drawnPatterns, and the drawn-set rule
     * reads `drawnPatterns.size && ...` — open when empty. The stale rule must
     * fire FIRST or the all-stale chart keeps three bright lines and no shape.
     */
    const g = planGate({ pattern: 'inverse_head_and_shoulders' }, staleMap, new Set());
    assert.equal(g.keep, false, 'an empty drawn set must not admit a stale plan');
    assert.equal(g.entry.stale, true);
  });

  test('a fresh, drawn pattern keeps its plan', () => {
    const g = planGate({ pattern: 'double_bottom' }, staleMap, new Set(['double_bottom']));
    assert.equal(g.keep, true);
  });

  test('a fresh pattern NOT in a non-empty drawn set is suppressed by the second rule', () => {
    const g = planGate({ pattern: 'double_bottom' }, staleMap, new Set(['flag']));
    assert.equal(g.keep, false);
    assert.equal(g.entry.stale, undefined);
    assert.match(g.entry.why, /was not drawn/);
  });

  test('a plan with no pattern passes both rules', () => {
    const g = planGate({ pattern: null }, staleMap, new Set(['flag']));
    assert.equal(g.keep, true);
  });

  test('drawFindings actually CALLS it — the wiring is a call, not a copy', () => {
    const d = readFileSync(new URL('../src/core/assessment_draw.js', import.meta.url), 'utf8');
    const inBody = d.slice(d.indexOf('const stalePatterns = new Map'));
    assert.match(inBody, /const gate = planGate\(tp, stalePatterns, drawnPatterns\)/);
    assert.match(inBody, /if \(!gate\.keep\) \{ suppressedPlans\.push\(gate\.entry\); continue; \}/);
  });
});

// ── P3.2 (2026-07-30) — the merge tolerance, ATR-scaled ─────────────────────

describe('mergeTolerance — a percentage is not a distance a chart can read', () => {
  /**
   * Measured on this repo's own output, 79 daily analyses across
   * reports/sunday-review-2026-07-30.json and reports/morning-screen-latest.json:
   * atr_pct p10 1.65, median 3.64, p90 7.51. Five-minute median 0.33.
   *
   * Those are the numbers the multiple is derived from, so they are the numbers
   * the tests are written at.
   */
  const QUIET = { price: 100, atr: 1.65 };      // p10 daily — a quiet large cap
  const TYPICAL = { price: 100, atr: 3.64 };    // the median
  const VOLATILE = { price: 100, atr: 6.0 };    // upper decile, still under the cap
  const WILD = { price: 100, atr: 17.57 };      // the sample max — the cap must bite
  const FIVE_MIN = { price: 100, atr: 0.33 };   // 5-minute median, the intraday tier

  test('the multiple is DERIVED from the fixed rule it replaces, not chosen', () => {
    // 0.4% / 3.64% = 0.110, rounded DOWN. Down because too wide DELETES a level and
    // says so only in a list, too narrow draws one extra line the reader can see.
    const implied = MERGE_TOLERANCE.fallback_pct / 3.64;
    assert.ok(MERGE_TOLERANCE.atr_multiple <= implied,
      `k=${MERGE_TOLERANCE.atr_multiple} is wider than the ${implied.toFixed(3)} the old rule implies at the `
      + 'median — the rounding must go DOWN, because the two errors are not symmetric');
    assert.ok(MERGE_TOLERANCE.atr_multiple > implied * 0.8,
      'and it must stay close to it, or this is a re-tuning rather than a re-scaling');
  });

  test('at the median it reproduces the old fixed rule — a re-scaling, not a re-tuning', () => {
    const t = mergeTolerance(TYPICAL.atr, TYPICAL.price);
    assert.equal(t.basis, 'atr');
    assert.ok(Math.abs(t.tolerance_pct - MERGE_TOLERANCE.fallback_pct) < 0.05,
      `median tolerance ${t.tolerance_pct}% should sit beside the old ${MERGE_TOLERANCE.fallback_pct}%`);
  });

  test('a QUIET symbol merges LESS than the old rule, at the same two prices', () => {
    /**
     * The behavioural half. Two levels 0.3% apart: the fixed 0.4% called them one
     * level and deleted the second line. On a 1.65% ATR name that is a fifth of an
     * ATR — a real distance on that chart.
     */
    const t = mergeTolerance(QUIET.atr, QUIET.price);
    assert.ok(t.tolerance_pct < MERGE_TOLERANCE.fallback_pct,
      `quiet tolerance ${t.tolerance_pct}% must be tighter than the fixed ${MERGE_TOLERANCE.fallback_pct}%`);
    assert.equal(sameLevel(100.3, 100, MERGE_TOLERANCE.fallback_pct), true, 'the OLD rule merged these');
    assert.equal(sameLevel(100.3, 100, t.tolerance_pct), false,
      'the new rule must keep them as two lines on a quiet chart');
  });

  test('a VOLATILE symbol merges MORE, at those same two prices', () => {
    const t = mergeTolerance(VOLATILE.atr, VOLATILE.price);
    assert.ok(t.tolerance_pct > MERGE_TOLERANCE.fallback_pct);
    assert.equal(sameLevel(100.5, 100, MERGE_TOLERANCE.fallback_pct), false, 'the OLD rule drew two lines');
    assert.equal(sameLevel(100.5, 100, t.tolerance_pct), true,
      'half a percent is a tenth of an ATR here — one level, one line');
  });

  test('NO ATR falls back to the old fixed 0.4%, and says which rule ran', () => {
    for (const bad of [null, undefined, 0, NaN, '', -1]) {
      const t = mergeTolerance(bad, 100);
      assert.equal(t.tolerance_pct, MERGE_TOLERANCE.fallback_pct, `atr=${bad} must fall back`);
      assert.equal(t.basis, 'fallback');
      assert.equal(t.atr, null);
      assert.match(t.why, /fixed/, 'the fallback must name itself — a silent fallback is a different rule');
    }
    // Unknown degrades to the shipped behaviour: NOT "no dedupe" (seven overlapping
    // lines) and NOT "merge everything" (levels silently deleted).
    assert.ok(mergeTolerance(null, 100).tolerance_pct > 0);
    assert.ok(mergeTolerance(null, 100).tolerance_pct < MERGE_TOLERANCE.max_pct);
  });

  test('a missing ATR is not a ZERO one — the Number(null) trap', () => {
    // Number(null) is 0 and 0 is finite, so the obvious guard computes a tolerance
    // of zero and it reads as a deliberate no-merge.
    assert.notEqual(mergeTolerance(null, 100).tolerance_pct, 0);
    assert.equal(mergeTolerance(null, 100).basis, 'fallback');
  });

  test('the ceiling is findKeyLevels OWN clustering tolerance, not a third number', () => {
    const structure = readFileSync(`${process.cwd()}/src/core/structure.js`, 'utf8');
    assert.match(structure, new RegExp(`tolerance_pct = ${MERGE_TOLERANCE.max_pct}`),
      'the cap must equal the price tolerance at which findKeyLevels declares two swings the SAME '
      + 'level — merging past it makes the display contradict the detector');
    const t = mergeTolerance(WILD.atr, WILD.price);
    assert.equal(t.capped, true);
    assert.equal(t.tolerance_pct, MERGE_TOLERANCE.max_pct);
    assert.ok(t.uncapped_pct > MERGE_TOLERANCE.max_pct, 'what it WOULD have been is kept, not discarded');
    assert.match(t.why, /ceiling/);
  });

  test('k stays BELOW the label-collision gap, or the callout arm is dead code', () => {
    /**
     * The two mechanisms hand off: under k ATR is one level (merge), k..0.35 ATR is
     * two lines with one label displaced, beyond 0.35 ATR is two labels. Set k at or
     * above min_atr_gap and the middle band vanishes — which is exactly what the
     * fixed rule did on a 5-minute chart.
     */
    assert.ok(MERGE_TOLERANCE.atr_multiple < LABEL_COLLISION.min_atr_gap,
      `k=${MERGE_TOLERANCE.atr_multiple} must be under min_atr_gap=${LABEL_COLLISION.min_atr_gap}`);

    const oldInAtr = MERGE_TOLERANCE.fallback_pct / FIVE_MIN.atr;
    assert.ok(oldInAtr > LABEL_COLLISION.min_atr_gap,
      `the defect, in one number: the fixed rule was ${oldInAtr.toFixed(2)}x ATR on a 5-minute chart, past `
      + 'the label gap — every colliding price had already been merged away');
    const now = mergeTolerance(FIVE_MIN.atr, FIVE_MIN.price);
    assert.ok(now.tolerance_pct / FIVE_MIN.atr < LABEL_COLLISION.min_atr_gap,
      'the ATR rule must leave the callout arm reachable at every timeframe');
  });

  test('identity is the only floor, and it holds at a tolerance of zero', () => {
    // A flat series computes a legitimate zero. Two prices that round to the same
    // drawn price are one line whatever the tolerance says.
    assert.equal(sameLevel(100.12341, 100.12344, 0), true, '4dp identity must merge at tol 0');
    assert.equal(sameLevel(100.13, 100.12, 0), false, 'and nothing else may');
    assert.equal(sameLevel(0, 0, 0), true, 'a zero price must not divide its way to NaN and draw twice');
    assert.equal(sameLevel(null, 100, 5), false);
    assert.equal(sameLevel(100, undefined, 5), false);
  });

  test('the drawer USES it — one tolerance for the chart, reported with its basis', () => {
    const d = readFileSync(new URL('../src/core/assessment_draw.js', import.meta.url), 'utf8');
    assert.match(d, /const merge = mergeTolerance\(atr, a\?\.price/,
      'computed once per chart, from the same ATR the label placement uses');
    assert.match(d, /const hline = async \(price, opts, label, \{ tol = merge\.tolerance_pct \}/,
      'the hline default must BE the computed tolerance, or the tested function is not the shipped one');
    assert.match(d, /sameLevel\(p4, d\.price, tol\)/, 'and the comparison must be the exported predicate');
    assert.match(d, /tolerance_pct: tol,\r?\n\s*basis: merge\.basis/,
      'every merged level must carry the tolerance that merged it and which rule produced it');
    assert.match(d, /drawn\.merge_tolerance = \{/,
      'reported even when nothing merged — "ran and merged nothing" and "did not run" are different '
      + 'answers, and an empty merged_levels cannot tell them apart');
  });
});
