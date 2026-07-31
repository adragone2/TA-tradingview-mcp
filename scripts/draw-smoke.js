#!/usr/bin/env node
/**
 * The 2026-07-30 shape probe, kept RUNNABLE.
 *
 * ── Why this exists ──
 *
 * `triangle_pattern` asked TradingView for five points and got two. It did not
 * throw. It returned normally, drew a stray diagonal, left the drawing cursor
 * ARMED, and every analysis that used it reported success. The defect was found
 * by a human noticing an ABCD cursor on the chart, months later — and the fix
 * (reconstruct the boundaries from two trend lines) is only safe for as long as
 * nobody re-adopts the native tool on the strength of `head_and_shoulders`
 * working.
 *
 * The audit that found this probed eighteen shapes by hand and wrote the results
 * into a table in `docs/improvements.md`. A table is a record of one afternoon.
 * This is the same probe as a command, so the NEXT silent point-count regression
 * is caught by `node scripts/draw-smoke.js` rather than rediscovered by an audit.
 *
 * ── What it asserts, per adopted shape ──
 *
 *   created   an entity id came back. `drawShape` reports success: true with a
 *             NULL id when the create silently produced nothing, so the id is
 *             the only honest evidence.
 *   exists    the entity is on a fresh `getAllShapes()` read. A create that
 *             resolves after the capture window closes is a different failure.
 *   points    `getPoints().length` equals the count that was ASKED for. This is
 *             the triangle_pattern check, verbatim: asked 5, landed 2.
 *   text      the text passed to a create reads back VERBATIM. A multipoint
 *             create silently produces nothing when given a non-empty text, and
 *             `setProperties({ text })` afterwards reads back null — so the
 *             shapes that CAN carry text are the only ones the orphan sweep can
 *             ever recover, and a silent text failure would be invisible.
 *   props     the position tool's stop/profit TICK OFFSETS round-trip. That
 *             shape's contract is its properties, not its point count — see the
 *             row's own note.
 *   removed   the entity is gone afterwards, and the chart holds exactly the
 *             shapes it held before.
 *
 * ── Two safety properties, both deliberate ──
 *
 * EVERY TEXT IT WRITES IS AN ALREADY-REGISTERED FORMAT. Nothing new is invented:
 * each label below is a string `assessment_draw.js` already writes, and all of
 * them are checked against `isMcpText` BEFORE the first shape is drawn. So even
 * if this script is killed mid-run, everything it left behind that carries text
 * is sweepable by `scripts/clear-orphans.js`, and the textless natives are
 * recoverable by their fixed GROUP. A label with no signature leaks an orphan
 * that can never be cleaned up; this script must never be the thing that leaks one.
 *
 * IT TAKES THE CHART LOCK. It drives the one shared chart, and a morning screen
 * walking symbols underneath it would both corrupt this measurement and be
 * corrupted by it. `on_conflict: 'throw'` rather than 'exit': a smoke test that
 * exits 0 without measuring anything is worse than one that fails.
 *
 * It does NOT change the symbol or the timeframe — it draws on whatever is
 * loaded, and verifies both are unchanged at the end.
 *
 *   node scripts/draw-smoke.js           draw, verify, clean up   (needs a chart)
 *   node scripts/draw-smoke.js --list    print the tables only    (no chart)
 *
 * Exit code 0 only if every check passed and the chart was left as found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, getChartApi } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as drawing from '../src/core/drawing.js';
import { NATIVE_PATTERN_SHAPES } from '../src/core/drawing.js';
import { drawPosition } from '../src/core/position_tool.js';
import { isMcpText } from '../src/core/orphans.js';
import { acquireChartLock } from '../src/core/chart_lock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A FIXED group, not a timestamped one.
 *
 * The recovery instruction has to be the same every run, and a run killed
 * half-way has to be cleanable by the next one. `draw_clear group="draw-smoke"`
 * is the whole recovery path for the textless natives, which carry no text and
 * so can never be reached by the orphan sweep.
 */
export const SMOKE_GROUP = 'draw-smoke';

/**
 * Where on the chart it draws.
 *
 * Near price, not off in a corner. Some tools render differently at absurd
 * prices and a probe that avoids the normal case measures the wrong thing; the
 * shapes exist for a few seconds under a held lock and are removed by id.
 */
export const SAFE_AREA = {
  price_band_pct: 3,
  window_bars: 40,
  note: 'Within ±3% of the last close, anchored to real bar times from the last 40 bars, '
    + 'on whatever symbol and timeframe are already loaded. Nothing is drawn outside that band.',
};

/** Where the earnings line goes: beyond the last bar, which is the case P1.7 probed. */
const EARNINGS_DAYS_AHEAD = 21;

// ───────────────────────────────────────────────────────────────────────────
// The adopted shapes.
//
// "Adopted" means PRODUCTION CODE CREATES IT — not "TradingView supports it".
// `adoptedShapesInSource` below derives the same list from src/ and the test
// asserts the two agree, so a shape adopted tomorrow without a row here is a
// test failure rather than an untested drawing.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `points_source` records WHERE the expected count comes from, because the three
 * sources have different strengths and a reader deserves to know which one a
 * failure is contradicting:
 *
 *   probe-2026-07-30    measured live on AMEX:SPY / NASDAQ:AAPL that day. A
 *                       mismatch here is a REGRESSION against a recorded number.
 *   NATIVE_PATTERN_SHAPES  the declared count `drawShape` validates against, and
 *                       the probe agreed with it. Same strength.
 *   create-contract     never in the probe table. These go through
 *                       `createShape` (one point) or the `point2` branch (two),
 *                       so "asked" is unambiguous — but "landed" was never
 *                       recorded, and the first live run is what pins it.
 */
export const SMOKE_SHAPES = [
  {
    id: 'horizontal_line',
    shape: 'horizontal_line',
    via: 'drawShape',
    points: 1,
    points_source: 'create-contract',
    text_key: 'level',
    used_for: 'levels, zones, completion levels, VCP pivot, TA stop, trade-plan legs',
    build: (c) => ({
      shape: 'horizontal_line',
      point: { price: c.price(0), time: c.time(1) },
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 2 }),
    }),
  },
  {
    id: 'vertical_line',
    shape: 'vertical_line',
    via: 'drawShape',
    points: 1,
    points_source: 'probe-2026-07-30',
    text_key: 'earnings',
    used_for: 'the earnings date (P1.7)',
    /**
     * Deliberately placed BEYOND the last bar — that is what production does and
     * what the probe measured. TradingView SNAPS the time to the next session
     * (2026-09-06 Sunday read back as 09-08), so the snapped time is REPORTED
     * rather than asserted: the snap target depends on the exchange calendar,
     * and pinning it here would make this fail every time a holiday moved.
     */
    build: (c) => ({
      shape: 'vertical_line',
      point: { price: c.price(0), time: c.lastBarTime + EARNINGS_DAYS_AHEAD * 86400 },
      overrides: JSON.stringify({ linecolor: '#ffa726', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#ffa726', fontsize: 11 }),
    }),
    report_time_snap: true,
  },
  {
    id: 'trend_line',
    shape: 'trend_line',
    via: 'drawShape',
    points: 2,
    points_source: 'create-contract',
    text_key: 'boundary',
    used_for: 'pattern boundaries, flag poles, the head-and-shoulders leg fallback',
    build: (c) => ({
      shape: 'trend_line',
      point: { price: c.price(1), time: c.time(0) },
      point2: { price: c.price(-1), time: c.time(1) },
      overrides: JSON.stringify({ linecolor: '#42a5f5', linewidth: 2 }),
    }),
  },
  {
    id: 'rectangle',
    shape: 'rectangle',
    via: 'drawShape',
    points: 2,
    points_source: 'create-contract',
    text_key: 'range',
    used_for: 'flag consolidations, rectangle patterns, zones_draw',
    build: (c) => ({
      shape: 'rectangle',
      point: { price: c.price(-1.5), time: c.time(0.1) },
      point2: { price: c.price(1.5), time: c.time(0.9) },
      overrides: JSON.stringify({
        color: '#42a5f5', linewidth: 1, fillBackground: false, transparency: 100,
        showLabel: true, textcolor: '#42a5f5', fontsize: 11, vertLabelsAlign: 'top',
      }),
    }),
  },
  {
    id: 'callout',
    shape: 'callout',
    via: 'drawShape',
    points: 2,
    points_source: 'probe-2026-07-30',
    text_key: 'offset_level',
    used_for: 'the off-line level labels that fix text-on-hline collision (P1.6)',
    build: (c) => ({
      shape: 'callout',
      point: { price: c.price(0), time: c.lastBarTime },
      point2: { price: c.price(2), time: c.lastBarTime - 6 * c.barSeconds },
      overrides: JSON.stringify({
        color: '#787B86', bordercolor: '#787B86', textcolor: '#787B86',
        backgroundColor: 'rgba(0,0,0,0)', fontsize: 11, linewidth: 1, transparency: 100,
      }),
    }),
  },
  {
    id: 'fib_retracement',
    shape: 'fib_retracement',
    via: 'drawShape',
    points: 2,
    points_source: 'probe-2026-07-30',
    text_key: null,
    used_for: 'the fibonacci grid on the impulse assess() measured (P1.5)',
    textless_why: 'the tool draws its own level labels; a duplicate caption on top of them is noise',
    build: (c) => ({
      shape: 'fib_retracement',
      point: { price: c.price(-2), time: c.time(0.05) },
      point2: { price: c.price(2), time: c.time(0.95) },
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 1, showCoeffs: true, showPrices: true }),
    }),
  },
  {
    id: 'fixed_range_volume_profile',
    shape: 'fixed_range_volume_profile',
    via: 'drawShape',
    points: 2,
    points_source: 'probe-2026-07-30',
    text_key: null,
    used_for: 'the value area over assess()\'s own 90-bar window (P1.8, opt-in)',
    textless_why: 'a pane-wide overlay with no label slot',
    build: (c) => ({
      shape: 'fixed_range_volume_profile',
      point: { price: c.price(-3), time: c.time(0) },
      point2: { price: c.price(3), time: c.time(1) },
      overrides: JSON.stringify({ transparency: 70 }),
    }),
  },
  {
    id: 'parallel_channel',
    shape: 'parallel_channel',
    via: 'drawShape',
    points: 3,
    points_source: 'NATIVE_PATTERN_SHAPES',
    text_key: null,
    used_for: 'the channel, as one entity instead of two trend lines (P1.2)',
    textless_why: 'a multipoint create given a non-empty text silently produces NOTHING',
    build: (c) => ({
      shape: 'parallel_channel',
      points: [
        { price: c.price(1), time: c.time(0) },
        { price: c.price(2), time: c.time(1) },
        { price: c.price(-1), time: c.time(0) },
      ],
      overrides: JSON.stringify({ linecolor: '#78909c', linewidth: 2, showMidline: false, fillBackground: false, transparency: 100 }),
    }),
  },
  {
    id: 'elliott_impulse_wave',
    shape: 'elliott_impulse_wave',
    via: 'drawShape',
    points: 6,
    points_source: 'NATIVE_PATTERN_SHAPES',
    text_key: null,
    used_for: 'the agreeing Elliott count, when every sensitivity found the same one (P1.9)',
    textless_why: 'a multipoint create given a non-empty text silently produces NOTHING',
    build: (c) => ({
      shape: 'elliott_impulse_wave',
      points: c.zigzag(6, [-2, 1, -1, 2, 0.5, 2.5]),
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 1 }),
    }),
  },
  {
    id: 'head_and_shoulders',
    shape: 'head_and_shoulders',
    via: 'drawShape',
    points: 7,
    points_source: 'NATIVE_PATTERN_SHAPES',
    text_key: null,
    used_for: 'head and shoulders, as one entity instead of six leg lines (P1.3)',
    textless_why: 'a multipoint create given a non-empty text silently produces NOTHING',
    build: (c) => ({
      shape: 'head_and_shoulders',
      points: c.zigzag(7, [-1, 1.5, -1, 3, -1, 1.5, -1]),
      overrides: JSON.stringify({ linecolor: '#ef5350', linewidth: 2 }),
    }),
  },
  {
    id: 'long_position',
    shape: 'long_position',
    via: 'drawPosition',
    points: null,
    points_source: 'not-asserted',
    text_key: null,
    used_for: 'the verdict-side trade plan, as one draggable R:R box (P1.1)',
    textless_why: 'the tool has no text slot — it is cleared by GROUP only',
    /**
     * The point count is NOT this shape's contract and is deliberately not
     * asserted. TradingView stores the stop and target as OFFSETS FROM ENTRY IN
     * MINIMUM TICKS, not as points: `position_tool.js` reads `pts[0]` for entry
     * and derives the rest from `stopLevel`/`profitLevel`. So the round trip that
     * would actually catch a regression is the TICK OFFSETS, and that is what is
     * checked. Asserting a point count nobody has measured would be inventing a
     * number, which is the failure mode this whole file exists to catch.
     */
    position: (c) => ({ direction: 'long', entry: c.price(0), stop: c.price(-1.5), target: c.price(3) }),
  },
  {
    id: 'short_position',
    shape: 'short_position',
    via: 'drawPosition',
    points: null,
    points_source: 'not-asserted',
    text_key: null,
    used_for: 'the verdict-side trade plan, short side (P1.1)',
    textless_why: 'the tool has no text slot — it is cleared by GROUP only',
    position: (c) => ({ direction: 'short', entry: c.price(0), stop: c.price(1.5), target: c.price(-3) }),
  },
];

/**
 * The shapes that are probed ONLY to confirm they are still refused.
 *
 * Re-drawing them would be the mistake: `triangle_pattern` leaves the drawing
 * cursor armed, and `price_label` creates nothing at all, so a "probe" of either
 * measures nothing and can leave state behind. What is checked instead is that
 * production still does not create them — which is the regression that matters.
 */
export const DO_NOT_USE = [
  {
    shape: 'triangle_pattern',
    asked: 5,
    landed: 2,
    still_declared: true,
    short: 'broken — keep the trend-line reconstruction',
    why: 'BROKEN, reproducibly — 2 of 5 points, and the tool was left ARMED, in the same session '
      + 'in which head_and_shoulders landed 7 of 7. Kept in NATIVE_PATTERN_SHAPES so a caller that '
      + 'reaches for it still gets the point-count guard. Wedges and triangles keep the two-trend-line '
      + 'reconstruction (improvements.md P1.4).',
  },
  {
    shape: 'price_label',
    asked: 1,
    landed: 0,
    still_declared: false,
    short: 'creates nothing at all',
    why: 'creates NOTHING. Silent, exactly like an unknown shape name — except an unknown name at '
      + 'least leaves a flag mark behind to notice (P1.10).',
  },
  {
    shape: 'curve',
    asked: 3,
    landed: 2,
    still_declared: false,
    short: "third point's encoding unclear",
    why: "landed 2 of 3. The third point's encoding is not the {time, price} the other tools take, "
      + 'and guessing at it is how a drawn boundary ends up describing nothing (P1.10).',
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — everything below is testable with no chart.
// ───────────────────────────────────────────────────────────────────────────

/** 4dp, never in exponent form — the signature regexes match `-?\d+(\.\d+)?`. */
export function fmt(n) {
  return Number(n).toFixed(4);
}

/**
 * Every label this script writes, keyed by `text_key`.
 *
 * EVERY ONE IS A FORMAT `assessment_draw.js` ALREADY WRITES. Nothing new is
 * invented, because a label matching no `MCP_TEXT_SIGNATURES` entry leaks an
 * orphan that survives every sweep forever — and the one thing a smoke test must
 * not do is leave permanent litter when it is interrupted.
 *
 * @param {number} base   the price the band is built around
 * @param {Date}   now    fixed by callers that need determinism
 */
export function smokeTexts({ base = 100, now = new Date() } = {}) {
  const at = (pct) => fmt(base * (1 + pct / 100));
  const earnDate = new Date(now.getTime() + EARNINGS_DAYS_AHEAD * 86400 * 1000)
    .toISOString().slice(0, 10);
  return {
    // levels_draw / the review's key levels — "S 14.84 (0.07%)"
    level: `S ${at(0)} (0.0%)`,
    // the same string a callout carries, unchanged, when a label comes off its line
    offset_level: `R ${at(0)} (0.0%)`,
    // drawPatternGeometry's boundary lines — "<pattern> <status> upper"
    boundary: 'symmetrical_triangle forming upper',
    // drawPatternGeometry's rectangle branch — "<pattern> <status>"
    range: 'bullish_rectangle confirmed',
    // the earnings vertical_line — "earnings 2026-08-26 (27d)"
    earnings: `earnings ${earnDate} (${EARNINGS_DAYS_AHEAD}d)`,
  };
}

/**
 * Labels this script would write that no signature recognises.
 *
 * Run BEFORE anything is drawn. A failure here refuses the whole run rather than
 * drawing eleven safe shapes and one permanent orphan.
 */
export function unregisteredTexts(texts = smokeTexts()) {
  return Object.entries(texts)
    .filter(([, text]) => !isMcpText(text))
    .map(([key, text]) => ({ key, text }));
}

/** Every `.js` file under `src/core` and `src/tools`, as `{ path, text }`. */
export function srcSources(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.js')) out.push({ path: relative(root, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
    }
  };
  for (const d of ['src/core', 'src/tools']) walk(join(root, d));
  return out;
}

/**
 * The shapes production actually creates, read out of the source.
 *
 * Two patterns, because there are two ways a shape name reaches TradingView:
 *
 *   `shape: 'name'`   the literal every `drawShape` call site writes.
 *   `'long_position'` / `'short_position'` — dispatched through
 *                     `POSITION_SHAPES` in position_tool.js, so the name never
 *                     appears next to a `shape:` key and a single-pattern scan
 *                     misses the one drawing that carries real money on it.
 *
 * Prose is not matched: `pip.js` has `shape: 'upward trend in columns 1-5, …'`,
 * which fails `[a-z0-9_]+` at the first space.
 */
export function adoptedShapesInSource(sources = srcSources()) {
  const found = new Map();
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/shape:\s*'([a-z0-9_]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(path);
    }
    for (const m of text.matchAll(/'(long_position|short_position)'/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(path);
    }
  }
  return new Map([...found].sort().map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Has anything re-adopted a shape the probe killed?
 *
 * Pure, so the test can feed it a positive control. A do-not-use shape that
 * reappears in a `shape: '...'` literal is the exact regression this script is
 * named after — `triangle_pattern` looked adoptable once too.
 */
export function doNotUseCheck(sources = srcSources()) {
  const adopted = adoptedShapesInSource(sources);
  const violations = [];
  for (const row of DO_NOT_USE) {
    if (adopted.has(row.shape)) {
      violations.push({
        shape: row.shape,
        kind: 're-adopted',
        where: adopted.get(row.shape),
        why: row.why,
      });
    }
    const declared = Object.prototype.hasOwnProperty.call(NATIVE_PATTERN_SHAPES, row.shape);
    if (declared !== row.still_declared) {
      violations.push({
        shape: row.shape,
        kind: declared ? 'newly-declared' : 'no-longer-declared',
        where: ['src/core/drawing.js NATIVE_PATTERN_SHAPES'],
        why: row.still_declared
          ? 'it must STAY declared so a caller that reaches for it still gets the point-count guard'
          : 'listing it in the catalogue makes it look adoptable',
      });
    }
  }
  return violations;
}

/** Column-aligned rows. Trailing whitespace trimmed so the output diffs cleanly. */
export function table(headers, rows) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
  return all.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

/** The `--list` output. No chart, no network, deterministic given `now`. */
export function formatListing({ now = new Date(), sources = null } = {}) {
  const texts = smokeTexts({ base: 100, now });
  const lines = [];

  lines.push(`draw-smoke — ${SMOKE_SHAPES.length} adopted shapes, ${DO_NOT_USE.length} kept do-not-use`);
  lines.push(`group: ${SMOKE_GROUP}   safe area: ${SAFE_AREA.note}`);
  lines.push('');
  lines.push('ADOPTED — drawn, verified, removed');
  lines.push(table(
    ['shape', 'via', 'points', 'count from', 'text it writes', 'used for'],
    SMOKE_SHAPES.map((s) => [
      s.shape,
      s.via,
      s.points === null ? 'n/a' : s.points,
      s.points_source,
      s.text_key ? texts[s.text_key] : '— textless',
      s.used_for,
    ]),
  ));
  lines.push('');
  for (const s of SMOKE_SHAPES.filter((x) => !x.text_key)) {
    lines.push(`  ${s.shape} carries no text: ${s.textless_why}.`);
  }
  lines.push('  A textless shape is classified `foreign` by findOrphans and is NEVER swept —');
  lines.push(`  it is recoverable only through the registry and the "${SMOKE_GROUP}" group.`);

  lines.push('');
  lines.push('DO NOT USE — asserted absent from production, never re-drawn');
  lines.push(table(
    ['shape', 'asked', 'landed', 'in catalogue', 'verdict'],
    DO_NOT_USE.map((d) => [d.shape, d.asked, d.landed, d.still_declared ? 'yes (guard)' : 'no', d.short]),
  ));
  lines.push('');
  for (const d of DO_NOT_USE) lines.push(`  ${d.shape}: ${d.why}`);

  const bad = unregisteredTexts(texts);
  const violations = doNotUseCheck(sources || srcSources());

  lines.push('');
  lines.push(bad.length
    ? `FAIL  ${bad.length} label(s) match no MCP_TEXT_SIGNATURES entry — drawing one would leak a permanent orphan:\n`
      + bad.map((b) => `        ${b.key}: ${JSON.stringify(b.text)}`).join('\n')
    : `ok    every label matches a registered signature (${Object.keys(texts).length} checked)`);
  lines.push(violations.length
    ? `FAIL  ${violations.length} do-not-use violation(s):\n`
      + violations.map((v) => `        ${v.shape} (${v.kind}) in ${v.where.join(', ')}\n          ${v.why}`).join('\n')
    : `ok    no do-not-use shape is created by src/core or src/tools`);
  lines.push('');
  lines.push('Nothing was drawn. Run without --list to probe the live chart.');

  return { text: lines.join('\n'), failed: bad.length + violations.length };
}

/**
 * Times and prices for the probe, built from the loaded series.
 *
 * `time(0)` is the oldest bar in the window and `time(1)` the newest, so a row
 * asks for a fraction of the window rather than a bar index it would have to
 * keep in step with `SAFE_AREA.window_bars`.
 */
export function makeContext(bars, { band_pct = SAFE_AREA.price_band_pct, window_bars = SAFE_AREA.window_bars } = {}) {
  const win = bars.slice(-Math.max(8, window_bars));
  if (win.length < 8) {
    throw new Error(`Only ${win.length} bars on the chart. The 7-point head_and_shoulders needs 7 distinct bar `
      + 'times and there are not enough — load more history and re-run.');
  }
  const last = win[win.length - 1];
  const base = Number(last.close);
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`The last bar has no usable close (${last.close}), so no price band can be built.`);
  }

  const time = (frac) => win[Math.min(win.length - 1, Math.max(0, Math.round(frac * (win.length - 1))))].time;
  const price = (pct) => {
    if (Math.abs(pct) > band_pct) throw new Error(`${pct}% is outside the ±${band_pct}% safe band.`);
    return Number((base * (1 + pct / 100)).toFixed(4));
  };
  /** n points across the window at the given percentage offsets — times strictly increasing. */
  const zigzag = (n, pcts) => {
    const times = Array.from({ length: n }, (_, i) => time(i / (n - 1)));
    if (new Set(times).size !== n) {
      throw new Error(`Could not find ${n} distinct bar times in a ${win.length}-bar window — a native `
        + 'pattern tool given duplicate points places what it can and stays ARMED.');
    }
    return times.map((t, i) => ({ time: t, price: price(pcts[i]) }));
  };

  const barSeconds = win.length > 1
    ? Math.max(1, Math.round((last.time - win[0].time) / (win.length - 1)))
    : 86400;

  return { base, price, time, zigzag, barSeconds, lastBarTime: last.time, window: win.length };
}

// ───────────────────────────────────────────────────────────────────────────
// The live run.
// ───────────────────────────────────────────────────────────────────────────

const log = (s = '') => process.stdout.write(`${s}\n`);

/**
 * One shape by id — `{ id, name }`, or null if it is not on the chart.
 *
 * Targeted rather than a full re-read per shape: the full read pulls every
 * shape's properties, and on a chart carrying a week of analysis that is twelve
 * passes over the lot.
 */
async function findShape(id) {
  const api = await getChartApi();
  return await evaluate(`
    (function(){
      var all = ${api}.getAllShapes();
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === ${JSON.stringify(id)}) return { id: all[i].id, name: all[i].name };
      }
      return null;
    })()
  `);
}

/** Every shape on the chart right now, with its id, name and text. */
async function readChartShapes() {
  const api = await getChartApi();
  return (await evaluate(`
    (function(){
      var api = ${api};
      return api.getAllShapes().map(function(s){
        var out = { id: s.id, name: s.name, text: null };
        try {
          var sh = api.getShapeById(s.id);
          var p = sh && sh.getProperties ? sh.getProperties() : null;
          if (p) out.text = (p.text != null ? p.text : (p.title != null ? p.title : null));
        } catch (e) { out.error = e.message; }
        return out;
      });
    })()
  `)) || [];
}

async function run() {
  const state = await chart.getState();
  const before = {
    symbol: state.symbol,
    resolution: state.resolution,
  };

  /**
   * Sweep OUR OWN group first, in case a previous run was killed mid-probe.
   *
   * This is a repair of this script's own litter, not a cleanup of the chart:
   * `clearAll` scoped to a group touches nothing outside it. It happens BEFORE
   * the baseline snapshot so leftovers do not count as "shapes the chart had".
   */
  const stale = await drawing.clearAll({ scope: 'mcp', group: SMOKE_GROUP }).catch(() => ({ removed: 0 }));
  if (stale.removed) log(`Cleared ${stale.removed} shape(s) left by a previous run in group "${SMOKE_GROUP}".\n`);

  const baseline = await readChartShapes();
  const baselineIds = new Set(baseline.map((s) => s.id));

  const series = await data.getOhlcv({ count: 200 });
  /**
   * The symbol stamp. Every chart read in this repo carries the symbol it read
   * and the rule is to COMPARE it on every call — another company's bars once
   * reached a written report exactly this way.
   */
  if (series.symbol && before.symbol && series.symbol !== before.symbol) {
    throw new Error(`The bars came back stamped ${series.symbol} but the chart reports ${before.symbol}. `
      + 'Refusing to probe a series that cannot be attributed.');
  }

  const ctx = makeContext(series.bars);
  const texts = smokeTexts({ base: ctx.base });

  /**
   * REFUSE BEFORE DRAWING if any label is unregistered.
   *
   * The check has to happen here rather than per shape: eleven safe shapes and
   * one permanent orphan is a worse outcome than not running at all.
   */
  const bad = unregisteredTexts(texts);
  if (bad.length) {
    throw new Error(`${bad.length} label(s) match no MCP_TEXT_SIGNATURES entry, so drawing them would leak `
      + `orphans that can never be swept: ${bad.map((b) => `${b.key}=${JSON.stringify(b.text)}`).join(', ')}. `
      + 'Register the format in src/core/orphans.js, or use one that is already registered.');
  }

  log(`draw-smoke on ${before.symbol} (${before.resolution}) — ${SMOKE_SHAPES.length} shapes, group "${SMOKE_GROUP}"`);
  log(`  chart holds ${baseline.length} shape(s) before; base price ${ctx.base}, window ${ctx.window} bars`);
  log(`  if this is killed mid-run: draw_clear scope:"mcp" group:"${SMOKE_GROUP}", then node scripts/clear-orphans.js --apply`);
  log('');

  // ── draw + verify ────────────────────────────────────────────────────────
  const results = [];
  for (const row of SMOKE_SHAPES) {
    const r = {
      id: row.id, shape: row.shape, via: row.via, expected: row.points,
      entity_id: null, tool: null, landed: null, text_ok: null, props_ok: null,
      exists: null, removed: null, failures: [], notes: [],
    };
    const text = row.text_key ? texts[row.text_key] : null;
    r.text = text;

    try {
      if (row.via === 'drawPosition') {
        const args = row.position(ctx);
        const res = await drawPosition({ ...args, group: SMOKE_GROUP });
        r.entity_id = res.entity_id || null;
        r.asked_props = { stopLevel: res.ticks.stop, profitLevel: res.ticks.profit };
      } else {
        const res = await drawing.drawShape({ ...row.build(ctx), ...(text ? { text } : {}), group: SMOKE_GROUP });
        r.entity_id = res.entity_id || null;
        if (row.report_time_snap) r.asked_time = res.point.time;
      }
    } catch (err) {
      r.failures.push(`create threw: ${err.message}`);
      results.push(r);
      continue;
    }

    if (!r.entity_id) {
      /**
       * `drawShape` returns `success: true` with a null id when the create
       * silently produced nothing — `price_label` and any multipoint create
       * given a non-empty text both do exactly this. The id is the only honest
       * evidence, and a shape with no id is also one this script cannot remove.
       */
      r.failures.push('no entity id came back — the create either drew nothing, or drew something untrackable');
      results.push(r);
      continue;
    }

    const found = await findShape(r.entity_id);
    r.exists = !!found;
    if (!found) {
      r.failures.push(`entity ${r.entity_id} is not on the chart on re-read`);
      results.push(r);
      continue;
    }
    r.tool = found.name || null;
    /**
     * AN UNKNOWN SHAPE NAME DOES NOT THROW — it silently creates a
     * LineToolFlagMark. So a create that "succeeded" with an id and the right
     * point count can still be the wrong tool entirely, and this is the only
     * place that can tell: `drawShape` validates the name against its own
     * catalogue, not against TradingView's.
     */
    if (/flagmark/i.test(r.tool || '')) {
      r.failures.push(`TradingView drew a ${r.tool} — it did not recognise the shape name "${row.shape}" `
        + 'and substituted a flag marker rather than failing');
    }

    let props = null;
    try { props = await drawing.getProperties({ entity_id: r.entity_id }); }
    catch (err) { r.failures.push(`getProperties failed: ${err.message}`); }

    if (props) {
      r.landed = Array.isArray(props.points) ? props.points.length : null;
      if (row.points !== null) {
        if (r.landed !== row.points) {
          r.failures.push(`points: asked ${row.points}, landed ${r.landed === null ? 'unreadable' : r.landed}`
            + ` (count from ${row.points_source}`
            + (row.points_source === 'create-contract'
              ? ' — never in the 2026-07-30 probe table; if the live chart reports this consistently,'
                + ` pin points: ${r.landed} on the ${row.id} row and record it as measured)`
              : ` — this shape landed ${row.points} of ${row.points} on 2026-07-30, so this is a REGRESSION)`));
        }
      } else {
        r.notes.push(`points ${r.landed} (not asserted — see the row's note)`);
      }

      if (text !== null) {
        const back = props.properties?.text ?? props.properties?.title ?? null;
        r.text_ok = back === text;
        if (!r.text_ok) {
          r.failures.push(`text: passed ${JSON.stringify(text)}, read back ${JSON.stringify(back)}`
            + ' — a shape whose text does not survive is invisible to the orphan sweep');
        }
      }

      if (r.asked_props) {
        const got = { stopLevel: props.properties?.stopLevel, profitLevel: props.properties?.profitLevel };
        r.props_ok = got.stopLevel === r.asked_props.stopLevel && got.profitLevel === r.asked_props.profitLevel;
        if (!r.props_ok) {
          r.failures.push(`tick offsets: asked ${JSON.stringify(r.asked_props)}, read back ${JSON.stringify(got)}`
            + ' — stopLevel/profitLevel ARE this tool\'s contract; the position size is computed from them');
        }
      }

      if (row.report_time_snap && Array.isArray(props.points) && props.points[0]) {
        const landedTime = props.points[0].time;
        const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
        r.notes.push(`asked ${iso(r.asked_time)}, TradingView placed it at ${iso(landedTime)}`
          + `${landedTime === r.asked_time ? ' (no snap)' : ' (snapped to the next session)'}`);
      }
    }

    results.push(r);
  }

  // ── remove everything, then prove the chart is as it was ─────────────────
  for (const r of results) {
    if (!r.entity_id) continue;
    try {
      const out = await drawing.removeOne({ entity_id: r.entity_id });
      r.removed = !!out.removed;
      if (!r.removed) r.failures.push(`removeOne reported the shape still on the chart (${r.entity_id})`);
    } catch (err) {
      r.failures.push(`remove failed: ${err.message}`);
      r.removed = false;
    }
  }
  // Belt and braces: anything tracked under our group that individual removal missed.
  const groupClear = await drawing.clearAll({ scope: 'mcp', group: SMOKE_GROUP }).catch(() => ({ removed: 0 }));

  const after = await readChartShapes();
  const leftovers = after.filter((s) => !baselineIds.has(s.id));
  const ourTexts = new Set(Object.values(texts));
  const reconciliation = { removed_extra: [], left_behind: [] };
  for (const s of leftovers) {
    /**
     * UNKNOWN IS NOT SAFE TO DELETE.
     *
     * A new shape carrying one of OUR exact labels is attributable and is
     * removed. Anything else appeared during the run and cannot be attributed —
     * the lock keeps other scripts out but not the owner's own hand — so it is
     * REPORTED and the run fails. The same rule `registry.prune` follows when
     * the symbol is unreadable.
     */
    if (s.text && ourTexts.has(s.text)) {
      try {
        await drawing.removeOne({ entity_id: s.id });
        reconciliation.removed_extra.push({ id: s.id, text: s.text });
      } catch { reconciliation.left_behind.push(s); }
    } else {
      reconciliation.left_behind.push(s);
    }
  }

  const finalShapes = await readChartShapes();
  const finalState = await chart.getState();

  // ── report ───────────────────────────────────────────────────────────────
  const cell = (v) => (v === null ? '-' : v === true ? 'ok' : v === false ? 'FAIL' : v);
  /**
   * The TradingView tool name, which nothing in this repo records outside a
   * comment block. Printing it makes the run a re-measurement of the mapping as
   * well as of the point counts — and it is how a silent LineToolFlagMark
   * substitution becomes visible at a glance.
   */
  log(table(
    ['shape', 'tool', 'asked', 'landed', 'entity', 'exists', 'text', 'props', 'removed', 'verdict'],
    results.map((r) => [
      r.shape,
      (r.tool || '-').replace(/^LineTool/, ''),
      r.expected === null ? 'n/a' : r.expected,
      r.landed === null ? '-' : r.landed,
      r.entity_id ? 'ok' : 'FAIL',
      cell(r.exists),
      cell(r.text_ok),
      cell(r.props_ok),
      cell(r.removed),
      r.failures.length ? 'FAIL' : 'PASS',
    ]),
  ));

  const notes = results.filter((r) => r.notes.length);
  if (notes.length) {
    log('');
    for (const r of notes) for (const n of r.notes) log(`note  ${r.shape}: ${n}`);
  }

  const failed = results.filter((r) => r.failures.length);
  if (failed.length) {
    log('');
    log('='.repeat(78));
    for (const r of failed) {
      log(`FAIL  ${r.shape}  (${r.via}, used for ${SMOKE_SHAPES.find((s) => s.id === r.id)?.used_for})`);
      for (const f of r.failures) log(`        ${f}`);
    }
    log('='.repeat(78));
  }

  // Chart restoration is its own verdict — a probe that leaves litter has failed
  // even if every shape passed.
  const restore = [];
  if (finalState.symbol !== before.symbol) restore.push(`symbol changed: ${before.symbol} -> ${finalState.symbol}`);
  if (finalState.resolution !== before.resolution) restore.push(`timeframe changed: ${before.resolution} -> ${finalState.resolution}`);
  if (finalShapes.length !== baseline.length) {
    restore.push(`shape count: ${baseline.length} before, ${finalShapes.length} after`);
  }
  for (const s of reconciliation.left_behind) {
    restore.push(`unattributable shape left on the chart: id ${s.id}, name ${s.name}, text ${JSON.stringify(s.text)} `
      + '— it appeared during the run but carries none of this script\'s labels, so it was NOT deleted');
  }

  log('');
  log('-'.repeat(78));
  log(`shapes   : ${results.filter((r) => !r.failures.length).length} passed, ${failed.length} failed`);
  log(`chart    : ${before.symbol} (${before.resolution}) unchanged; `
    + `${baseline.length} shape(s) before, ${finalShapes.length} after`);
  if (groupClear.removed) log(`group    : ${groupClear.removed} extra shape(s) swept from "${SMOKE_GROUP}"`);
  if (reconciliation.removed_extra.length) {
    log(`recovered: ${reconciliation.removed_extra.length} untracked shape(s) removed by matching this script's own label`);
  }
  if (restore.length) {
    log('');
    for (const r of restore) log(`FAIL  chart not left as found: ${r}`);
  }

  const violations = doNotUseCheck();
  if (violations.length) {
    log('');
    for (const v of violations) log(`FAIL  do-not-use: ${v.shape} (${v.kind}) in ${v.where.join(', ')} — ${v.why}`);
  } else {
    log(`no-use   : ${DO_NOT_USE.map((d) => d.shape).join(', ')} still absent from production`);
  }

  return failed.length + restore.length + violations.length === 0 ? 0 : 1;
}

// ───────────────────────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--list')) {
    const listing = formatListing();
    log(listing.text);
    return listing.failed ? 1 : 0;
  }

  /**
   * `on_conflict: 'throw'`, not 'exit'.
   *
   * The scripts that walk the chart exit 0 on a conflict because skipping a scan
   * is harmless. A smoke test that exits 0 without measuring anything is the
   * opposite: it reports "all clear" for a chart it never touched.
   */
  const lock = acquireChartLock({ label: 'draw-smoke', on_conflict: 'throw' });
  try {
    return await run();
  } finally {
    lock.release();
  }
}

/**
 * RUN ONLY AS THE ENTRY POINT.
 *
 * Without this guard, `import` from a test file would take the chart lock and
 * start drawing on the owner's live chart the moment the suite ran — the tests
 * below import `SMOKE_SHAPES` and `smokeTexts` precisely so the enumeration can
 * be checked headlessly, and a module that draws on import would make that
 * impossible.
 */
const isEntry = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntry) {
  let code = 1;
  try {
    code = await main();
  } catch (err) {
    log(`\nFAIL  ${err.message}`);
    code = 1;
  }
  process.exit(code);
}
