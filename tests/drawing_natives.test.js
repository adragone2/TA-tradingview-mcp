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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { planLegDrawing, drawPatternGeometry, windowPivots } from '../src/core/assessment_draw.js';
import { NATIVE_PATTERN_SHAPES, MULTIPOINT_SETTLE, drawShape } from '../src/core/drawing.js';
import { accountSettings } from '../src/core/rules.js';
import { isMcpText } from '../src/core/orphans.js';

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
});

// ── P1.3 — the native 7-point head and shoulders, and its pivot floor ───────

describe('head and shoulders — one native entity, never a partial one', () => {
  test('7 real alternating pivots draw ONE native tool, not six leg lines', async () => {
    const bars = barsFrom(zigzag(8));
    const pv = windowPivots(bars, bars[0].time, bars[bars.length - 1].time, 7);
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
    const pv = windowPivots(bars, bars[0].time, bars[bars.length - 1].time, 7);
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
    assert.equal(windowPivots(bars, bars[0].time, bars[bars.length - 1].time, 7).length, 0);

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
