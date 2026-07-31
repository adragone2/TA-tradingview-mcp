/**
 * `scripts/draw-smoke.js` — the live probe's own contracts.
 *
 * The live half CANNOT run here: it needs TradingView Desktop on CDP 9222 and it
 * writes to the owner's chart. What can be pinned headlessly is everything that
 * decides WHAT the live half will do — and that is where this script can rot
 * silently:
 *
 *   - a shape adopted by production with no row here is an UNTESTED drawing, and
 *     "we have a smoke test" is then false in exactly the way that matters;
 *   - a label that matches no `MCP_TEXT_SIGNATURES` entry leaks an orphan that
 *     survives every sweep forever, and the script would leak one per run;
 *   - `--list` has to stay usable with no chart, or the headless half is a lie;
 *   - and `main()` must not run on import, or `node --test` starts drawing on a
 *     live account.
 *
 * Run: node --test tests/draw_smoke.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Importing the script is itself the strongest test of the entry guard: if
 * `main()` ran on import, this line would take the chart lock and start drawing.
 * The guard is asserted explicitly below so it cannot be deleted quietly.
 */
import {
  SMOKE_SHAPES, DO_NOT_USE, SMOKE_GROUP, SAFE_AREA,
  smokeTexts, unregisteredTexts, fmt,
  srcSources, adoptedShapesInSource, doNotUseCheck,
  formatListing, makeContext, table,
} from '../scripts/draw-smoke.js';

import { NATIVE_PATTERN_SHAPES } from '../src/core/drawing.js';
import { isMcpText, MCP_TEXT_SIGNATURES } from '../src/core/orphans.js';
import { earningsLinePlan } from '../src/core/assessment_draw.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'draw-smoke.js');
const SCRIPT_SRC = readFileSync(SCRIPT, 'utf8');

/** Deterministic clock, so the earnings label is the same string every run. */
const NOW = new Date('2026-07-30T14:00:00Z');

/** Bars that look like a real tail: distinct times, a usable close. */
function bars(n = 60, base = 100) {
  return Array.from({ length: n }, (_, i) => ({
    time: 1700000000 + i * 86400,
    open: base, high: base + 1, low: base - 1, close: base + i * 0.1, volume: 1000,
  }));
}

// ── the enumeration: adopted means PRODUCTION CREATES IT ────────────────────

describe('the shape table is the set production actually draws', () => {
  test('every shape a src/ drawer creates has a row, and nothing else does', () => {
    /**
     * Both directions, because each catches a different rot.
     *
     * A shape in source with no row is an adoption that was never smoke-tested —
     * `triangle_pattern` was in source for months. A row with no source is a
     * shape this script draws on a live chart for no reason, which is litter it
     * has no business creating.
     */
    const inSource = adoptedShapesInSource(srcSources(ROOT));
    const rows = SMOKE_SHAPES.map((s) => s.shape).sort();
    assert.deepEqual(rows, [...inSource.keys()].sort(),
      'SMOKE_SHAPES must equal the shapes created under src/core and src/tools. '
      + `In source but not in the table: ${[...inSource.keys()].filter((k) => !rows.includes(k))}. `
      + `In the table but not in source: ${rows.filter((r) => !inSource.has(r))}.`);
  });

  test('the scan really does find the drawers — not a regex matching nothing', () => {
    // A contract whose finder returns an empty set passes forever. This pins the
    // two call-site spellings the scan has to cover.
    const inSource = adoptedShapesInSource(srcSources(ROOT));
    assert.ok(inSource.get('head_and_shoulders')?.includes('src/core/assessment_draw.js'));
    assert.ok(inSource.get('rectangle')?.includes('src/tools/zones.js'));
    // long_position never appears next to a `shape:` key — it is dispatched
    // through POSITION_SHAPES, so a single-pattern scan would miss the one
    // drawing that carries a position size on it.
    assert.ok(inSource.get('long_position')?.includes('src/core/position_tool.js'));
    assert.ok(inSource.get('short_position')?.includes('src/core/position_tool.js'));
  });

  test('prose is not mistaken for a shape name', () => {
    // pip.js has `shape: 'upward trend in columns 1-5, …'` — a description, not a
    // TradingView tool. A looser regex would put it in the table and the live run
    // would ask TradingView for it, which draws a flag mark.
    const found = adoptedShapesInSource([{ path: 'x.js', text: "shape: 'upward trend in columns 1-5'," }]);
    assert.equal(found.size, 0);
  });

  test('the multipoint counts come from NATIVE_PATTERN_SHAPES, not from a second copy', () => {
    /**
     * Two catalogues of point counts would drift silently, and the drift would be
     * invisible: `drawShape` validates against NATIVE_PATTERN_SHAPES and this
     * script would assert against its own number.
     */
    const declared = SMOKE_SHAPES.filter((s) => s.points_source === 'NATIVE_PATTERN_SHAPES');
    assert.deepEqual(declared.map((s) => s.shape).sort(),
      ['elliott_impulse_wave', 'head_and_shoulders', 'parallel_channel']);
    for (const s of declared) {
      assert.equal(s.points, NATIVE_PATTERN_SHAPES[s.shape],
        `${s.shape}: the table says ${s.points}, the catalogue drawShape validates against says ${NATIVE_PATTERN_SHAPES[s.shape]}`);
    }
  });

  test('a catalogue entry production never creates gets no row', () => {
    /**
     * NATIVE_PATTERN_SHAPES declares twelve tools; production creates three of
     * them. Probing the other nine would draw shapes nothing depends on — and
     * `xabcd_pattern` and `cypher_pattern` are 5-pointers of exactly the family
     * that landed 2 of 5.
     */
    const rows = new Set(SMOKE_SHAPES.map((s) => s.shape));
    for (const name of ['xabcd_pattern', 'cypher_pattern', 'abcd_pattern', 'flat_bottom',
      'elliott_correction_wave', 'elliott_triangle_wave', 'elliott_double_combo', 'elliott_triple_combo']) {
      assert.ok(NATIVE_PATTERN_SHAPES[name], `${name} should still be in the catalogue`);
      assert.ok(!rows.has(name), `${name} is declared but never created — it must not be probed`);
    }
  });

  test('every row declares where its expected count came from', () => {
    for (const s of SMOKE_SHAPES) {
      assert.ok(['probe-2026-07-30', 'NATIVE_PATTERN_SHAPES', 'create-contract', 'not-asserted'].includes(s.points_source),
        `${s.shape}: unknown points_source ${s.points_source}`);
      if (s.points_source === 'not-asserted') assert.equal(s.points, null);
      else assert.ok(Number.isInteger(s.points) && s.points > 0, `${s.shape}: ${s.points} is not a point count`);
      assert.ok(s.used_for, `${s.shape}: a row with no "used for" cannot justify drawing on a live chart`);
      assert.ok(s.text_key || s.textless_why, `${s.shape}: say either what text it writes or why it cannot carry one`);
    }
  });

  test('the counts the 2026-07-30 probe recorded are the ones asserted', () => {
    // Straight from the appendix table. These are the rows where a mismatch is a
    // REGRESSION rather than a first-run pin.
    const probed = { callout: 2, fib_retracement: 2, fixed_range_volume_profile: 2, vertical_line: 1 };
    for (const [shape, n] of Object.entries(probed)) {
      const row = SMOKE_SHAPES.find((s) => s.shape === shape);
      assert.equal(row.points, n, `${shape} landed ${n} of ${n} on 2026-07-30`);
      assert.equal(row.points_source, 'probe-2026-07-30');
    }
  });
});

// ── geometry: what it would ask TradingView for ────────────────────────────

describe('the geometry each row builds', () => {
  const ctx = makeContext(bars());

  test('every build produces exactly the declared point count', () => {
    /**
     * `drawShape` refuses a wrong multipoint count before touching the chart, so
     * a mismatch here would surface as a create that threw — reported, but as a
     * fault in the chart rather than in this table. Catch it where it is.
     */
    for (const row of SMOKE_SHAPES.filter((s) => s.build)) {
      const a = row.build(ctx);
      const n = a.points ? a.points.length : (a.point2 ? 2 : 1);
      assert.equal(n, row.points, `${row.shape}: builds ${n} points, declares ${row.points}`);
      assert.equal(a.shape, row.shape);
    }
  });

  test('multipoint shapes get DISTINCT, increasing times', () => {
    /**
     * A native pattern tool handed duplicate points places what it can and leaves
     * the drawing cursor ARMED — the triangle_pattern failure. `parallel_channel`
     * is the deliberate exception: its third point is the LOWER boundary at the
     * same time as the first, which is how production anchors it.
     */
    for (const row of SMOKE_SHAPES.filter((s) => s.build && s.points > 2)) {
      const pts = row.build(ctx).points;
      const times = pts.map((p) => p.time);
      if (row.shape === 'parallel_channel') {
        assert.equal(new Set(times).size, 2, 'the channel anchors its lower boundary at the upper start time');
      } else {
        assert.equal(new Set(times).size, pts.length, `${row.shape}: duplicate bar times`);
        assert.deepEqual(times, [...times].sort((a, b) => a - b), `${row.shape}: times must increase`);
      }
    }
  });

  test('nothing is drawn outside the declared safe band', () => {
    const lo = ctx.base * (1 - SAFE_AREA.price_band_pct / 100);
    const hi = ctx.base * (1 + SAFE_AREA.price_band_pct / 100);
    const prices = [];
    for (const row of SMOKE_SHAPES) {
      if (row.build) {
        const a = row.build(ctx);
        prices.push(...(a.points || [a.point, a.point2].filter(Boolean)).map((p) => p.price));
      } else {
        const p = row.position(ctx);
        prices.push(p.entry, p.stop, p.target);
      }
    }
    assert.ok(prices.length > 20);
    for (const p of prices) {
      assert.ok(p >= lo - 1e-6 && p <= hi + 1e-6, `${p} is outside ±${SAFE_AREA.price_band_pct}% of ${ctx.base}`);
    }
  });

  test('the position rows agree with their own direction — drawPosition throws otherwise', () => {
    const long = SMOKE_SHAPES.find((s) => s.shape === 'long_position').position(ctx);
    assert.ok(long.stop < long.entry && long.target > long.entry);
    const short = SMOKE_SHAPES.find((s) => s.shape === 'short_position').position(ctx);
    assert.ok(short.stop > short.entry && short.target < short.entry);
  });

  test('the earnings line is placed BEYOND the last bar, which is the case that was probed', () => {
    const a = SMOKE_SHAPES.find((s) => s.shape === 'vertical_line').build(ctx);
    assert.ok(a.point.time > ctx.lastBarTime,
      'production only ever draws this in the future; probing it on an existing bar would test a different call');
  });

  test('too few bars refuses instead of drawing a partial 7-point tool', () => {
    assert.throws(() => makeContext(bars(4)), /needs 7 distinct bar times|Only 4 bars/);
    assert.throws(() => makeContext([{ time: 1, close: null }]), /Only 1 bars|no usable close/);
    assert.throws(() => makeContext(bars(20).map((b) => ({ ...b, close: 0 }))), /no usable close/);
  });

  test('a price outside the band is refused rather than quietly clamped', () => {
    assert.throws(() => ctx.price(50), /outside the ±3% safe band/);
  });
});

// ── labels: nothing it writes can leak an orphan ───────────────────────────

describe('every text the script would write is already registered', () => {
  test('all of them match a signature', () => {
    /**
     * The whole safety argument for a script that draws on a live chart: if it is
     * killed between the draw and the cleanup, everything it left that carries
     * text is still sweepable by `clear-orphans`. A single unregistered format
     * would make one shape per run permanent.
     */
    const texts = smokeTexts({ base: 123.456, now: NOW });
    assert.ok(Object.keys(texts).length >= 5);
    for (const [key, text] of Object.entries(texts)) {
      assert.equal(isMcpText(text), true, `${key}: ${JSON.stringify(text)} matches no MCP_TEXT_SIGNATURES entry`);
    }
    assert.deepEqual(unregisteredTexts(texts), []);
  });

  test('and the check is not vacuous — near misses are refused', () => {
    // If isMcpText matched everything, the assertion above would prove nothing.
    for (const near of ['S 123.4560', 'R (0.0%)', 'symmetrical_triangle sideways upper', 'bullish_rectangle',
      'earnings 2026-08-20', 'earnings soon (21d)', 'my own note']) {
      assert.equal(isMcpText(near), false, `${JSON.stringify(near)} must NOT match`);
    }
    /**
     * `symmetrical_triangle upper` DOES match — the retired channel-boundary
     * format, kept because signatures are append-only and old charts still carry
     * it. Pinned here so the near-miss list above is not mistaken for a claim
     * that the drawer's own vocabulary is unrecognised.
     */
    assert.equal(isMcpText('symmetrical_triangle upper'), true);
    assert.equal(unregisteredTexts({ a: 'not a registered label' }).length, 1);
  });

  test('every price it writes into a label survives the NUM regex', () => {
    // The signatures match `-?\d+(\.\d+)?`. A price formatted into exponent form
    // ("1.2e-7") matches nothing, and the orphan would be permanent.
    for (const base of [0.5, 7, 123.456789, 45678.9, 1e6]) {
      const t = smokeTexts({ base, now: NOW });
      assert.ok(!/e[+-]/i.test(t.level), `base ${base} produced ${t.level}`);
      assert.equal(isMcpText(t.level), true, `base ${base}: ${t.level}`);
      assert.equal(isMcpText(t.offset_level), true, `base ${base}: ${t.offset_level}`);
    }
    assert.equal(fmt(1 / 3), '0.3333');
  });

  test('the earnings label is byte-identical to the one production writes', () => {
    /**
     * A format that merely LOOKS like production's is the failure this repo keeps
     * paying for. Rather than eyeballing it, ask the producer: `earningsLinePlan`
     * is the function that writes the real one.
     */
    const mine = smokeTexts({ base: 100, now: NOW }).earnings;
    const date = mine.match(/^earnings (\d{4}-\d{2}-\d{2})/)[1];
    const theirs = earningsLinePlan({ date }, { now: NOW.getTime() / 1000 });
    assert.equal(theirs.draw, true, 'the date the script picks must be one production would actually draw');
    assert.equal(mine, theirs.text);
  });

  test('the level and boundary labels are the strings the drawer composes', () => {
    // Source contract on the two formats that have no exported producer. If the
    // drawer's wording changes, this fails rather than the script leaking.
    const d = readFileSync(join(ROOT, 'src/core/assessment_draw.js'), 'utf8');
    assert.match(d, /\$\{isSup \? 'S' : 'R'\} \$\{l\.price\} \(\$\{l\.distance_pct\}%\)/,
      'the S/R level label format moved — smokeTexts().level must move with it');
    assert.match(d, /text: `\$\{label\} upper`/,
      'the trend-line boundary label format moved — smokeTexts().boundary must move with it');
    assert.match(d, /text: label, group \}\), `pattern \$\{p\.pattern\} range`/,
      'the rectangle branch label format moved — smokeTexts().range must move with it');
  });

  test('the signature list is non-empty — a sweep matching nothing passes forever', () => {
    assert.ok(MCP_TEXT_SIGNATURES.length > 10);
  });
});

// ── the do-not-use guard ───────────────────────────────────────────────────

describe('the shapes the probe killed stay killed', () => {
  test('none of them is created anywhere under src/', () => {
    assert.deepEqual(doNotUseCheck(srcSources(ROOT)), []);
  });

  test('a re-adoption is caught — positive control', () => {
    /**
     * The named regression. `triangle_pattern` was adopted once on the belief that
     * the native multipoint tools worked, and the belief was right for
     * head_and_shoulders and wrong for this one.
     */
    const v = doNotUseCheck([{ path: 'src/core/fake.js', text: "drawShape({ shape: 'triangle_pattern', points })" }]);
    assert.equal(v.length, 1);
    assert.equal(v[0].shape, 'triangle_pattern');
    assert.equal(v[0].kind, 're-adopted');
    assert.deepEqual(v[0].where, ['src/core/fake.js']);
  });

  test('price_label and curve are caught too, and each carries its probe result', () => {
    const v = doNotUseCheck([
      { path: 'a.js', text: "shape: 'price_label'" },
      { path: 'b.js', text: "shape: 'curve'" },
    ]);
    assert.deepEqual(v.map((x) => x.shape).sort(), ['curve', 'price_label']);
    for (const row of DO_NOT_USE) {
      assert.ok(/\d/.test(row.why), `${row.shape}: the reason must carry the measured numbers`);
      assert.ok(row.short, `${row.shape}: needs a short form for the table`);
      assert.equal(typeof row.asked, 'number');
      assert.equal(typeof row.landed, 'number');
      assert.ok(row.landed < row.asked, `${row.shape}: a do-not-use shape landed fewer points than it was asked for`);
    }
  });

  test('triangle_pattern must STAY in the catalogue, and the other two must stay out', () => {
    /**
     * Not symmetrical, and the asymmetry is the point. Keeping triangle_pattern
     * declared is what gives a caller who reaches for it the point-count guard;
     * listing price_label or curve would make either look adoptable.
     */
    assert.equal(NATIVE_PATTERN_SHAPES.triangle_pattern, 5);
    assert.equal(NATIVE_PATTERN_SHAPES.price_label, undefined);
    assert.equal(NATIVE_PATTERN_SHAPES.curve, undefined);

    // and the check notices if that changes
    const dropped = doNotUseCheck([]).length;
    assert.equal(dropped, 0, 'the live catalogue currently satisfies the declaration rules');
  });
});

// ── --list: the headless half ──────────────────────────────────────────────

describe('--list runs with no chart', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--list'], { encoding: 'utf8', timeout: 60000 });

  test('it exits 0 and says plainly that nothing was drawn', () => {
    assert.equal(run.status, 0, `exit ${run.status}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Nothing was drawn\./);
    assert.ok(!/FAIL/.test(run.stdout), `--list reported a failure:\n${run.stdout}`);
  });

  test('one row per adopted shape, and one per do-not-use shape', () => {
    for (const s of SMOKE_SHAPES) {
      assert.match(run.stdout, new RegExp(`^${s.shape}\\s`, 'm'), `no row for ${s.shape}`);
    }
    for (const d of DO_NOT_USE) {
      assert.match(run.stdout, new RegExp(`^${d.shape}\\s`, 'm'), `no row for ${d.shape}`);
    }
  });

  test('both tables, both verdict lines, and the group needed to recover a killed run', () => {
    assert.match(run.stdout, /ADOPTED — drawn, verified, removed/);
    assert.match(run.stdout, /DO NOT USE — asserted absent from production/);
    assert.match(run.stdout, /every label matches a registered signature/);
    assert.match(run.stdout, /no do-not-use shape is created by src\/core or src\/tools/);
    assert.match(run.stdout, new RegExp(`group: ${SMOKE_GROUP}`));
  });

  test('the headers name every check the live run reports', () => {
    for (const col of ['shape', 'via', 'points', 'count from', 'text it writes', 'used for']) {
      assert.ok(run.stdout.includes(col), `missing column ${col}`);
    }
  });

  test('formatListing is the same output, and reports its own failure count', () => {
    const listing = formatListing({ now: NOW, sources: srcSources(ROOT) });
    assert.equal(listing.failed, 0);
    assert.match(listing.text, /^draw-smoke — 12 adopted shapes/);

    // and it FAILS when a shape is re-adopted, rather than printing a clean table
    const bad = formatListing({ now: NOW, sources: [{ path: 'src/core/x.js', text: "shape: 'curve'" }] });
    assert.equal(bad.failed, 1);
    assert.match(bad.text, /FAIL {2}1 do-not-use violation/);
  });

  test('table() aligns and leaves no trailing whitespace', () => {
    const t = table(['a', 'bbbb'], [['xx', 'y']]);
    assert.deepEqual(t.split('\n'), ['a   bbbb', 'xx  y']);
  });
});

// ── the entry guard ────────────────────────────────────────────────────────

describe('importing the script never drives the chart', () => {
  test('main() runs only when the script IS the entry point', () => {
    /**
     * This file imports draw-smoke.js at the top. Without the guard, `npm test`
     * would take the chart lock and start drawing on the owner's live account —
     * so the guard is asserted as source text as well as being demonstrated by
     * the fact that this suite completes.
     */
    assert.match(SCRIPT_SRC, /const isEntry = process\.argv\[1\]/);
    assert.match(SCRIPT_SRC, /resolve\(process\.argv\[1\]\) === resolve\(fileURLToPath\(import\.meta\.url\)\)/);
    assert.match(SCRIPT_SRC, /if \(isEntry\) \{/);
  });

  test('the lock is taken with on_conflict throw, and released in a finally', () => {
    /**
     * `on_conflict: 'exit'` is right for a scan — skipping one is harmless. It is
     * wrong here: a smoke test that exits 0 without measuring anything reports
     * "all clear" for a chart it never touched.
     */
    assert.match(SCRIPT_SRC, /acquireChartLock\(\{ label: 'draw-smoke', on_conflict: 'throw' \}\)/);
    assert.match(SCRIPT_SRC, /\} finally \{\s*lock\.release\(\);\s*\}/);
  });

  test('the live half refuses to draw before it has checked every label', () => {
    // Ordering matters: eleven safe shapes and one permanent orphan is a worse
    // outcome than not running.
    const body = SCRIPT_SRC.slice(SCRIPT_SRC.indexOf('async function run()'));
    assert.ok(body.indexOf('unregisteredTexts(texts)') < body.indexOf('for (const row of SMOKE_SHAPES)'),
      'the label check must run before the first draw');
  });

  test('it never changes the symbol or the timeframe', () => {
    // The chart is restored by not moving it. A setSymbol here would need a
    // restore path, and every restore path in this repo has been a bug at least once.
    assert.ok(!/setSymbol|setTimeframe/.test(SCRIPT_SRC),
      'draw-smoke draws on whatever is loaded; it must not move the chart');
  });

  /**
   * The live half cannot run here. What CAN be pinned is that each check it
   * claims to make is actually wired — a smoke test that quietly stopped
   * verifying one thing would still print a table full of PASS.
   */
  test('it checks for the silent LineToolFlagMark substitution', () => {
    // An UNKNOWN shape name does not throw — TradingView draws a flag marker.
    // `drawShape` validates against its own catalogue, not TradingView's, so
    // this is the only place the substitution can be caught.
    assert.match(SCRIPT_SRC, /\/flagmark\/i\.test\(r\.tool/);
  });

  test('it compares landed points against the declared count, and removal is verified', () => {
    assert.match(SCRIPT_SRC, /r\.landed !== row\.points/);
    assert.match(SCRIPT_SRC, /r\.landed = Array\.isArray\(props\.points\) \? props\.points\.length : null/);
    assert.match(SCRIPT_SRC, /r\.removed = !!out\.removed/);
    // and the text round trip is byte equality, not a substring or a truthiness check
    assert.match(SCRIPT_SRC, /r\.text_ok = back === text/);
  });

  test('the chart being left as found is its own verdict, not an assumption', () => {
    // A probe that leaves litter has failed even if every shape passed.
    assert.match(SCRIPT_SRC, /finalShapes\.length !== baseline\.length/);
    assert.match(SCRIPT_SRC, /finalState\.symbol !== before\.symbol/);
    assert.match(SCRIPT_SRC, /finalState\.resolution !== before\.resolution/);
    assert.match(SCRIPT_SRC, /return failed\.length \+ restore\.length \+ violations\.length === 0 \? 0 : 1/);
  });

  test('an unattributable leftover is reported, never deleted', () => {
    // Unknown is not safe to delete — the same rule registry.prune follows when
    // currentSymbol() returns null, and the liquidity constraint follows for adv.
    assert.match(SCRIPT_SRC, /reconciliation\.left_behind\.push\(s\)/);
    assert.match(SCRIPT_SRC, /UNKNOWN IS NOT SAFE TO DELETE/);
  });
});

// ---------------------------------------------------------------------------
// P3.3 review (2026-07-30). The smoke agent's label audit found zones_draw
// writing "demand fresh · 2.1x" — a format no signature matched, so every
// zone rectangle the tool had ever drawn leaked as a permanent orphan at
// session end. Verified against the pre-fix source: isMcpText returned false.
// ---------------------------------------------------------------------------
describe('zones_draw labels are sweepable', () => {
  const cases = [
    'demand fresh · 2.1x',
    'supply tested · aggressive · 1.4x',
    'demand broken · 0.85x',
    'supply fresh · nullx', // momentum_x rounds to null; String(null) is "null"
  ];
  for (const text of cases) {
    test(`"${text}" matches a registered signature`, () => {
      assert.equal(isMcpText(text), true, `${text} would leak as a permanent orphan`);
    });
  }
  test('a hand-typed near miss still does not match', () => {
    assert.equal(isMcpText('demand zone here'), false);
    assert.equal(isMcpText('supply fresh 2.1x'), false); // missing the separator
  });
});
