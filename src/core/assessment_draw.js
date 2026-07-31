/**
 * Drawing the assessment on the chart.
 *
 * Extracted from scripts/sunday-review.js for the same reason assess() was: the
 * morning screen draws the SAME findings, and a second copy would drift. The
 * drift is never loud — the review spent a whole run reporting zeros because it
 * read module keys that did not exist.
 *
 * The drawing GROUP is a parameter rather than a constant, because the Sunday
 * run and the morning run must not clear each other's work.
 */
import * as drawing from './drawing.js';
import { drawPosition } from './position_tool.js';
import { removeOrphans } from './orphans.js';
import { selectPrimary, atrFromBars } from './level_display.js';
import { planPatternDrawings } from './patterns_draw.js';
import { accountSettings } from './rules.js';
import { findPivots } from './pivots.js';

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * A number, or NaN — and `null` is NaN.
 *
 * `Number(null)` is **0**, and 0 is finite. So the obvious
 * `Number.isFinite(Number(v))` reads a MISSING value as a real zero: a fibonacci
 * block with `retraced_pct: null` was described as "retraced 0% — price has
 * extended beyond the impulse", which is a confident statement about a
 * measurement that did not happen. Same trap as `Number('')`, also 0.
 *
 * Caught by a test asserting the refusal REASON rather than just the refusal —
 * both paths refuse, and only the message distinguishes "no measurement" from
 * "measured, and it says continuation".
 */
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * When a level's label must come OFF the line, and where it goes instead.
 *
 * ── The failure this fixes ──
 *
 * Every horizontal line prints its label at the RIGHT price scale, at the price.
 * Two levels a fraction of an ATR apart print two labels in the same few pixels,
 * and on ALM and MTSI they overprinted into unreadable mush. `hline`'s dedupe
 * cannot fix it: the dedupe merges levels at the SAME price, and these are
 * different prices that deserve different lines — it is the TEXT that collides,
 * not the level.
 *
 * So the line stays and the text moves. A `callout` (probed 2026-07-30: 2 points
 * asked, 2 landed, and its text READ BACK verbatim) anchors at the level and puts
 * its box in clear space.
 *
 * ── The two triggers ──
 *
 *   LENGTH.    A label over `max_label_chars` runs left across the bars from the
 *              price scale regardless of what else is on the chart. "S 14.84
 *              (0.07%) - 9 tests, 1.4x vol" is 34 characters.
 *   PROXIMITY. A price within `min_atr_gap` ATR of one that ALREADY carries a
 *              label on its line. ATR-relative because 0.35 ATR is the same
 *              visual distance on a quiet large cap and a volatile small cap,
 *              which a percentage is not (see improvements.md P3.2 for the same
 *              argument applied to the merge tolerance).
 *
 * Proximity is measured only against labels that print ON their line, because
 * those are the ones occupying the price scale. A callout's text has already
 * been moved away and cannot be collided with there.
 *
 * PURE, and a left fold, so `labelPlacements(list.concat(next)).at(-1)` decides
 * one level without the drawer having to collect every level first — the
 * production path and the tested path are then the same function.
 */
export const LABEL_COLLISION = { max_label_chars: 28, min_atr_gap: 0.35 };

export function labelPlacements(levels, atr, { max_label_chars, min_atr_gap } = LABEL_COLLISION) {
  const gap = Number.isFinite(atr) && atr > 0 ? atr * min_atr_gap : null;
  const onLine = [];
  const out = [];
  let slot = 0;
  for (let i = 0; i < (levels || []).length; i += 1) {
    const lvl = levels[i] || {};
    const price = Number(lvl.price);
    const text = String(lvl.text ?? '');
    const why = [];

    if (text.length > max_label_chars) why.push(`label is ${text.length} chars, over ${max_label_chars}`);
    if (gap != null && Number.isFinite(price)) {
      const near = onLine.find((p) => Math.abs(p.price - price) <= gap);
      if (near) why.push(`within ${min_atr_gap} ATR (${r2(gap, 4)}) of ${near.price}, which is already labelled on its line`);
    }

    if (!why.length) {
      onLine.push({ price, text });
      out.push({ index: i, price, text, mode: 'line', why: null });
      continue;
    }

    /**
     * Alternate ABOVE and BELOW, then step further out every second callout, and
     * step further LEFT every time. Both axes move, because two callouts that
     * differ on one axis alone still overlap when their boxes are wider than the
     * step — which is the collision this whole function exists to end.
     *
     * Leftwards, not rightwards: the space to the right of the last bar is where
     * TradingView draws its own price/countdown labels, and a box there sits on
     * top of them.
     */
    const unit = gap != null ? gap : Math.abs(price) * 0.0035 || 0.01;
    const tier = Math.floor(slot / 2);
    out.push({
      index: i, price, text, mode: 'callout', why: why.join('; '), slot,
      price_offset: (slot % 2 === 0 ? 1 : -1) * unit * (3 + 2 * tier),
      time_offset_bars: -(8 + 5 * slot),
    });
    slot += 1;
  }
  return out;
}

/**
 * Should the fibonacci block be drawn, and between which two points?
 *
 * `assess()` has computed this block since the module existed and NOTHING drew
 * it. The native `fib_retracement` (probed 2026-07-30: 2 asked, 2 landed) draws
 * its own level labels, so it is passed no text and is therefore cleared by
 * GROUP rather than by the orphan sweep — same trade as the channel and the
 * position tool.
 *
 * ── The gate, and why it is this one ──
 *
 * A retracement is worth drawing while one is IN PROGRESS. `fibLevels` states
 * the two ways that is false in its own `interpretation`, and both are read
 * straight off `retraced_pct`:
 *
 *   ≤ 0%   price has extended BEYOND the impulse. That is continuation, not a
 *          pullback, and a retracement grid over it measures nothing.
 *   > 100% the entire impulse has been given back. The prior swing is broken,
 *          so the anchor is describing a structure that no longer holds.
 *
 * `in_golden_zone` is a SUBSET of the drawn range, not the gate — gating on it
 * would hide the grid for exactly the shallow and deep pullbacks a reader most
 * wants the levels for.
 */
export function fibDrawPlan(fib) {
  const anchor = fib?.anchor;
  const pct = num(fib?.retraced_pct);
  if (!anchor) {
    return { draw: false, why: 'the fibonacci block carries no anchor — assess() could not tie the retracement to two confirmed swings' };
  }
  const pts = [
    { time: num(anchor.from_time), price: num(anchor.from_price) },
    { time: num(anchor.to_time), price: num(anchor.to_price) },
  ];
  if (pts.some((p) => !Number.isFinite(p.time) || !Number.isFinite(p.price))) {
    return { draw: false, why: 'the fibonacci anchor is missing a time or a price' };
  }
  if (!Number.isFinite(pct)) return { draw: false, why: 'no retracement was measured' };
  if (pct <= 0) {
    return { draw: false, why: `retraced ${pct}% — price has extended beyond the impulse, so this is continuation rather than a pullback` };
  }
  if (pct > 100) {
    return { draw: false, why: `retraced ${pct}% — the whole impulse has been given back, so the prior swing is broken rather than retracing` };
  }
  return {
    draw: true,
    why: fib.in_golden_zone
      ? `retraced ${pct}%, inside the 38.2-61.8% zone`
      : `retracement in progress at ${pct}%`,
    in_golden_zone: !!fib.in_golden_zone,
    direction: fib.direction ?? null,
    points: pts,
  };
}

/**
 * The agreeing Elliott count, or nothing.
 *
 * `elliott_impulse_wave` probed 6 of 6 points on 2026-07-30, so the shape works.
 * The restraint is the point: a rule-valid count exists on **82% of random
 * walks**, and `surveyCounts` returns every count the rules allow precisely so
 * that no single one is presented as THE count. Drawing one on a chart is the
 * strongest possible presentation of it.
 *
 * So the only count that gets drawn is the one every sensitivity that found a
 * count agreed on — `distinct_recent_counts === 1`, the module's own strongest
 * statement. Two or more distinct counts is DISAGREEMENT, and the disagreement
 * is the finding rather than something to render; zero means no count exists.
 * Neither draws.
 */
export function elliottDrawPlan(ell) {
  const distinct = ell?.distinct_recent_counts;
  if (distinct == null) return { draw: false, why: 'no Elliott survey ran' };
  if (distinct === 0) return { draw: false, why: 'no sensitivity produced a rule-valid count' };
  if (distinct > 1) {
    return {
      draw: false,
      why: `${distinct} different most-recent counts across sensitivities — the disagreement IS the finding, `
        + 'and drawing one of them would present a choice of swing lookback as a reading of the market',
    };
  }
  const c = ell.agreeing_count;
  const pivots = (c?.pivots || []).map((p) => ({ time: num(p?.time), price: num(p?.price) }));
  if (pivots.length !== 6 || pivots.some((p) => !Number.isFinite(p.time) || !Number.isFinite(p.price))) {
    return { draw: false, why: 'the sensitivities agree but the count carries no six usable pivots' };
  }
  return {
    draw: true,
    why: 'every sensitivity that found a count found the SAME one',
    direction: c.direction ?? null,
    points: pivots,
  };
}

/** Days apart by CALENDAR day, so an event later today is 0 rather than -1. */
const dayIndex = (unixSeconds) => Math.floor(unixSeconds / 86400);

/**
 * The earnings `vertical_line` — where the catalyst is, drawn where the stop is.
 *
 * ── The live probe that decided the implementation (2026-07-30, NASDAQ:AAPL) ──
 *
 * The open question was whether a vertical line can be placed at a time BEYOND
 * the last bar, since earnings are by definition in the future. It can: asked at
 * 2026-09-06, ~38 days past the last bar (2026-07-30), it **created**, landed
 * 1/1 points, and its text read back verbatim. TradingView SNAPPED the requested
 * time to the next session — 2026-09-06 was a Sunday and the shape read back at
 * 2026-09-08 — so the line lands on a trading day rather than in the weekend
 * gap. Nothing is clamped to the last bar; the earlier worry was unfounded.
 *
 * A vertical_line takes ONE point and carries its text, so unlike the natives
 * above it IS recoverable by the orphan sweep. Its format is registered in
 * `SIGNATURES_BY_SOURCE.review`.
 *
 * ── The guards ──
 *
 *   A PAST date is never drawn. An earnings line behind price is not risk, it is
 *   history, and it reads identically to a live catalyst on a chart.
 *   Beyond `max_days_ahead` is not drawn either: a line 200 days out compresses
 *   the visible bars to nothing when the chart is fitted to its content.
 */
export const EARNINGS_LINE = { max_days_ahead: 45 };

export function earningsLinePlan(earnings, {
  now = Date.now() / 1000, last_bar_time = null, max_days_ahead = EARNINGS_LINE.max_days_ahead,
} = {}) {
  if (!earnings) return { draw: false, why: 'no earnings date was supplied' };
  const raw = earnings.date ?? earnings.earnings_date ?? null;
  if (raw == null || raw === '') return { draw: false, why: 'the earnings row carries no date' };
  const parsed = Date.parse(String(raw));
  if (Number.isNaN(parsed)) {
    // TA writes "N/A (ETF)" for a fund. That is an ANSWER — no earnings exist —
    // and must not read as a broken date.
    return { draw: false, why: `"${raw}" is not a date — nothing to place on the time axis` };
  }
  const time = Math.floor(parsed / 1000);
  const days = dayIndex(time) - dayIndex(now);
  if (days < 0) {
    return { draw: false, why: `${String(raw).slice(0, 10)} is ${Math.abs(days)} days in the PAST — a past earnings date is history, not catalyst risk` };
  }
  if (days > max_days_ahead) {
    return { draw: false, why: `${String(raw).slice(0, 10)} is ${days} days out, past the ${max_days_ahead}-day window` };
  }
  const date = new Date(time * 1000).toISOString().slice(0, 10);
  return {
    draw: true,
    why: `${days} days away`,
    time,
    date,
    days,
    beyond_last_bar: Number.isFinite(last_bar_time) ? time > last_bar_time : null,
    /** Registered in SIGNATURES_BY_SOURCE.review — a label matching nothing leaks a permanent orphan. */
    text: `earnings ${date} (${days}d)`,
    reported_days_until: Number.isFinite(earnings.days_until) ? earnings.days_until : null,
  };
}

/**
 * The window `assess().volume_analysis` measures over — `C.volumeProfile(bars.slice(-90))`.
 *
 * Drawn from the same slice or the shaded area describes a different profile
 * from the VAH/VAL numbers beside it, which is the silent-drift failure this
 * repo keeps paying for. Change one and the other must change with it.
 */
export const VOLUME_PROFILE_WINDOW = 90;

/**
 * Should this plan leg be drawn as a native position tool, or as three lines?
 *
 * Pure, and separate from the drawing so the DECISION is testable without a
 * chart. The position tool is the drawing traders actually use — a shaded risk
 * box and reward box, draggable, with the size TradingView recomputes itself —
 * and `position_tool.js` has existed, worked and been registered the whole time
 * while the unified drawer drew three horizontal lines instead.
 *
 * Three things must hold, and each failure falls back rather than guessing:
 *
 *   1. All three prices. The tool encodes stop and target as tick OFFSETS from
 *      entry, so a leg with no target has no box to draw. Lines can show two
 *      levels; the position tool cannot.
 *   2. An account size and a risk percent, from rules.json. Passing them lets
 *      TradingView compute and re-compute the quantity when the tool is dragged.
 *      Inventing them is the failure `position_size_constrained` was fixed for:
 *      a live analysis once made up $100,000 because there was nowhere to read
 *      it, and a share count from an invented account is indistinguishable from
 *      a correct one.
 *   3. Geometry that agrees with the direction. `drawPosition` throws on a long
 *      whose stop sits above entry — correct, but a throw here would lose the
 *      levels entirely, and three honest lines are better than nothing.
 */
export function planLegDrawing(leg, side, account) {
  const dir = String(side || '').toLowerCase();
  /** `num`, not `Number`: an explicit `stop: null` would otherwise size a box against a stop of 0. */
  const n = (v) => (Number.isFinite(num(v)) ? num(v) : null);
  const entry = n(leg?.entry), stop = n(leg?.stop), target = n(leg?.target);

  if (dir !== 'long' && dir !== 'short') {
    return { mode: 'lines', why: `leg side "${side}" is neither long nor short` };
  }
  const missing = [['entry', entry], ['stop', stop], ['target', target]].filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) {
    return { mode: 'lines', why: `the position tool needs entry, stop and target; missing ${missing.join(', ')}` };
  }

  const size = n(account?.account_size), risk = n(account?.risk_percent);
  if (!size || size <= 0 || !risk || risk <= 0) {
    return {
      mode: 'lines',
      why: 'no account size or risk percent configured, so TradingView cannot size the position — '
        + `set account.account_size and account.risk_percent in ${account?.rules_path || 'rules.json'}`,
    };
  }

  const ok = dir === 'long' ? (stop < entry && target > entry) : (stop > entry && target < entry);
  if (!ok) {
    return {
      mode: 'lines',
      why: `the ${dir} leg's levels contradict its direction (entry ${entry}, stop ${stop}, target ${target})`,
    };
  }

  return { mode: 'position', direction: dir, entry, stop, target, account_size: size, risk_percent: risk };
}

/**
 * Alternating swing pivots inside a pattern's own window, for the native tools.
 *
 * ── `windowPivots` used to live here, and it is GONE ──
 *
 * It was a third implementation of "what is a swing", beside
 * `structure.findSwings` and the kernel. Three answers to one question about
 * one chart: a wedge could be drawn through pivots the structure block never
 * saw, and neither of them would look wrong on its own. It is
 * `pivots.findPivots` now — the same backbone every detector reads — and the
 * two behaviours that mattered are parameters rather than a private loop:
 *
 *   - the WINDOW  — `from_time` / `to_time`. Better than the original, which
 *     restricted the scan range but still read its comparison window out of the
 *     full array; the backbone smooths the whole series and then filters, so a
 *     pattern near the edge of its window gets real context on both sides.
 *   - the FLOOR   — `want`. The old 3/2/1 lookback ladder is a bandwidth ladder
 *     now. The reason for it is unchanged and is not cosmetic: a native pattern
 *     tool handed fewer points than it declares places what it has and STAYS
 *     ARMED, leaving a stray diagonal and a live drawing cursor on the chart.
 *
 * `lookback: 3` is the base density because that is what the old ladder started
 * at; `pivots.js` carries the measured lookback -> bandwidth mapping. Prices
 * are rounded here rather than in the backbone — a pivot is a measurement, and
 * only the drawing needs it short.
 */
export function patternPivots(bars, fromTime, toTime, want) {
  return findPivots(bars, { lookback: 3, from_time: fromTime, to_time: toTime, want })
    .map(({ time, price, kind }) => ({ time, price: r2(price, 4), kind }));
}

/**
 * Draw a pattern's actual SHAPE.
 *
 * Three families, three geometries:
 *
 *   - trendline patterns (wedges, triangles, broadening, rectangle) — two
 *     boundary lines, reconstructed backwards from the reported slopes
 *   - flags — the pole as a line, the consolidation as a box
 *   - structural (double/triple tops and bottoms, head and shoulders) — the
 *     peaks connected, plus the neckline
 *
 * The completion level is drawn too, but as the *break* level rather than as
 * the pattern.
 */
export async function drawPatternGeometry(p, bars, group, put, hline = null) {
  /**
   * `hline` is the caller's deduping horizontal-line writer. Without it every level
   * this function draws bypasses the one-line-per-price rule, and they collide: on
   * DLO the wedge's break level (14.2756) and the trade plan's ENTRY landed at the
   * same price from two different blocks, overprinting into
   * "rising ENT wedge conf...breaks at". Falls back to a direct draw so the
   * function still works standalone.
   */
  const hl = hline || (async (price, opts, label) => put(
    () => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(price, 4) }, ...opts, group }),
    label,
  ));
  const m = p.measurements || {};
  const label = `${p.pattern} ${p.status}`;
  const COL = p.direction === 'bearish' ? '#ef5350' : p.direction === 'bullish' ? '#26a69a' : '#42a5f5';
  const idxOf = (t) => { const i = bars.findIndex((b) => b.time >= t); return i < 0 ? bars.length - 1 : i; };

  /**
   * The COMPLETION LEVEL, always — drawn alongside the shape rather than instead
   * of it.
   *
   * Each branch below used to `return` straight after drawing its geometry, so the
   * break level at the end of this function was only ever reached by the
   * head-and-shoulders path. Wedges and flags got a shape and no trigger. That
   * level is the most actionable price on a pattern: it is where the shape stops
   * being a shape. Bullish patterns "complete" upward, bearish ones "break at" —
   * both phrasings are registered in MCP_TEXT_SIGNATURES.
   */
  const verb = p.direction === 'bearish' ? 'breaks at' : 'completes';
  if (Number.isFinite(p.completion_level)) {
    await hl(p.completion_level, {
      overrides: JSON.stringify({ linecolor: COL, linewidth: 2, linestyle: 2 }),
      text: `${label} — ${verb} ${r2(p.completion_level, 2)}`,
    }, `pattern ${p.pattern} ${verb}`);
  }

  // ── rectangles: a box, not a triangle ────────────────────────────────────
  //
  // Rectangles reach the trendline branch below because they report
  // resistance_now and support_now like every other two-line pattern — and
  // were being drawn with TradingView's CONVERGING triangle tool, which is the
  // one shape a rectangle is definitionally not. A range gets a box.
  if (/rectangle/.test(p.pattern) && m.resistance_now != null && m.support_now != null) {
    // A typed rectangle carries its bias in its name while its `direction`
    // stays bilateral, so the colour comes from the name here.
    const rectCol = p.pattern.startsWith('bullish') ? '#26a69a'
      : p.pattern.startsWith('bearish') ? '#ef5350' : '#42a5f5';
    await put(() => drawing.drawShape({ shape: 'rectangle',
      point: { price: r2(m.support_now, 4), time: p.from_time },
      point2: { price: r2(m.resistance_now, 4), time: p.to_time },
      // Outline only — a fill over the range hides the bars that define it.
      overrides: JSON.stringify({
        color: rectCol, linewidth: 2, fillBackground: false, transparency: 100,
        showLabel: true, textcolor: rectCol, fontsize: 11, vertLabelsAlign: 'top',
      }),
      text: label, group }), `pattern ${p.pattern} range`);
    return;
  }

  // ── trendline family: TradingView's native triangle_pattern tool ─────────
  //
  // Anchored to the REAL alternating pivots inside the window, not to a slope
  // extrapolation. Extrapolating a 0.93%/bar slope backwards over 46 bars put
  // CQTM's lower boundary at 22.25 on a date when price was ~29 — a line that
  // touched nothing. The native tool takes 5 alternating pivots and renders
  // the converging/diverging shape itself.
  if (m.resistance_now != null && m.support_now != null) {
    /**
     * TWO BOUNDARY LINES, not TradingView's native triangle tool.
     *
     * `createMultipointShape('triangle_pattern', ...)` does NOT draw a triangle. It
     * places the first two of the tool's five points and leaves the tool ARMED for
     * the rest — so the chart gets a stray diagonal labelled A-B running clean
     * across it, the ABCD cursor stays selected, and the user has to press ESC.
     * The owner spotted it: "the ABCD tool is still there... nothing gets drawn by
     * that". It was invoked, it produced garbage, and it was never usable.
     *
     * Two trend lines fitted through the REAL pivot highs and the REAL pivot lows
     * give the converging shape directly, with no tool state left behind. Anchoring
     * to pivots rather than extrapolating the reported slope also keeps the old
     * CQTM fix: running a 0.93%/bar slope back 46 bars once put a lower edge at
     * 22.25 on a bar trading near 29 — a line touching nothing.
     */
    const pv = patternPivots(bars, p.from_time, p.to_time, 5);
    const highs = pv.filter((x) => x.kind === 'high');
    const lows = pv.filter((x) => x.kind === 'low');
    let drew = 0;
    if (highs.length >= 2) {
      await put(() => drawing.drawShape({ shape: 'trend_line',
        point: { price: highs[0].price, time: highs[0].time },
        point2: { price: highs[highs.length - 1].price, time: highs[highs.length - 1].time },
        overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
        text: `${label} upper`, group }), `pattern ${p.pattern} upper`);
      drew += 1;
    }
    if (lows.length >= 2) {
      await put(() => drawing.drawShape({ shape: 'trend_line',
        point: { price: lows[0].price, time: lows[0].time },
        point2: { price: lows[lows.length - 1].price, time: lows[lows.length - 1].time },
        overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
        text: `${label} lower`, group }), `pattern ${p.pattern} lower`);
      drew += 1;
    }
    if (!drew) {
      // Not enough pivots to fit either boundary — say so rather than guessing.
      await hl(m.resistance_now, {
        overrides: JSON.stringify({ linecolor: COL, linewidth: 1, linestyle: 2 }),
        text: `${label} — only ${pv.length} pivots, too few to draw`,
      }, `pattern ${p.pattern} unanchored`);
    }
    return;
  }

  // ── flags: pole as a line, consolidation as a box ─────────────────────────
  // Pennants share this construction — they are a pole plus a pause — but
  // name the pause `pennant_bars`, so both keys are accepted here.
  const pauseBars = m.flag_bars ?? m.pennant_bars ?? null;
  if (m.pole_pct != null && pauseBars != null) {
    const endIdx = idxOf(p.to_time);
    const flagStartIdx = Math.max(0, endIdx - pauseBars);
    const poleStartIdx = Math.max(0, flagStartIdx - (m.pole_bars || 0));
    const poleStart = p.direction === 'bullish' ? bars[poleStartIdx].low : bars[poleStartIdx].high;
    const poleEnd = p.direction === 'bullish' ? (m.flag_high ?? bars[flagStartIdx].high) : (m.flag_low ?? bars[flagStartIdx].low);
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: r2(poleStart, 4), time: bars[poleStartIdx].time },
      point2: { price: r2(poleEnd, 4), time: bars[flagStartIdx].time },
      overrides: JSON.stringify({ linecolor: COL, linewidth: 3 }),
      text: `${label} pole +${m.pole_pct}%`, group }), `pattern ${p.pattern} pole`);
    if (m.flag_high != null && m.flag_low != null) {
      await put(() => drawing.drawShape({ shape: 'rectangle',
        point: { price: r2(m.flag_low, 4), time: bars[flagStartIdx].time },
        point2: { price: r2(m.flag_high, 4), time: p.to_time },
        /**
         * NO FILL, and the label above the box.
         *
         * A filled rectangle over the consolidation hides the very candles the
         * pattern is made of, and TradingView renders the text INSIDE the box —
         * behind the price bars, unreadable. The owner asked what the unreadable
         * square was: it is this. An outline frames the pause without obscuring it.
         */
        overrides: JSON.stringify({
          color: COL, linewidth: 1, fillBackground: false, transparency: 100,
          showLabel: true, textcolor: COL, fontsize: 11, vertLabelsAlign: 'top',
        }),
        text: `${label} — ${pauseBars} bars, ${m.retrace_pct}% retrace`, group }), `pattern ${p.pattern} pause`);
    }
    return;
  }

  // ── structural: connect the peaks, then the neckline ──────────────────────
  const pair = m.peak_1 != null ? [m.peak_1, m.peak_2]
    : m.trough_1 != null && m.trough_2 != null && m.left_shoulder == null ? [m.trough_1, m.trough_2]
    : null;
  if (pair) {
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: r2(pair[0], 4), time: p.from_time }, point2: { price: r2(pair[1], 4), time: p.to_time },
      overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
      text: `${label}`, group }), `pattern ${p.pattern} peaks`);
  }
  // Head and shoulders — TradingView's own 7-point tool, which draws the
  // shoulders, the head and the neckline in the standard visual language.
  if (m.left_shoulder != null && m.head != null && m.right_shoulder != null) {
    const pv = patternPivots(bars, p.from_time, p.to_time, 7);
    if (pv.length >= 7) {
      /**
       * ONE NATIVE ENTITY, not six trend lines.
       *
       * This was six hand-drawn legs on the belief that "the native multipoint
       * tools place only their first two points and stay armed". That was measured
       * again on 2026-07-30 and it is **triangle_pattern-specific**:
       * `head_and_shoulders` asked for 7 points landed **7 of 7** in the same
       * session in which `triangle_pattern` landed 2 of 5. So the triangles keep
       * their reconstruction above and this one does not.
       *
       * The Escape disarm in `createOne` stays regardless — it costs nothing and
       * the failure it guards against (a live drawing cursor the owner has to
       * clear by hand after every analysis) is invisible until someone clicks.
       *
       * The tool carries NO text: a non-empty `text` makes a multipoint create
       * silently produce nothing, and setting it afterwards reads back null. So
       * this shape is recoverable through the registry and its GROUP only, never
       * through the orphan sweep. The neckline below is a normal hline and does
       * carry its registered label.
       */
      const seven = pv.slice(-7).map(({ time, price }) => ({ time, price }));
      const res = await put(() => drawing.drawShape({ shape: 'head_and_shoulders',
        points: seven,
        overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
        group }), `pattern ${p.pattern} head and shoulders`);
      /**
       * `drawShape` returns success even when the create silently produced
       * nothing — `entity_id` is the only honest evidence, and an unidentified
       * shape is an untrackable one. Say so rather than counting it as drawn.
       */
      if (res && !res.entity_id) {
        await put(() => { throw new Error('the native 7-point create returned no entity id — either it silently drew nothing, or it is on the chart untracked'); },
          `pattern ${p.pattern} head and shoulders`);
      }
    } else if (pv.length >= 2) {
      /**
       * FALLBACK: the leg lines, through the real pivots that exist.
       *
       * Never a 7-point tool with fewer than 7 real pivots. Given short, the tool
       * places the points it has and stays ARMED — measured on triangle_pattern,
       * which is exactly the garbage this file spent a release removing. Legs
       * through real pivots show the structure with no tool state left behind.
       */
      for (let i = 0; i < pv.length - 1; i += 1) {
        await put(() => drawing.drawShape({ shape: 'trend_line',
          point: { price: pv[i].price, time: pv[i].time },
          point2: { price: pv[i + 1].price, time: pv[i + 1].time },
          overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
          text: i === 0 ? label : '', group }), `pattern ${p.pattern} leg ${i + 1}`);
      }
    }
  }
  // The break level, drawn as what it is rather than as the pattern.
  const neck = m.neckline ?? m.trough ?? m.peak ?? p.completion_level;
  if (neck != null) {
    await hl(neck, {
      overrides: JSON.stringify({ linecolor: COL, linewidth: 2, linestyle: 2 }),
      text: `${label} — breaks at ${r2(neck, 2)}`,
    }, `pattern ${p.pattern} neckline`);
  }
}

/** Draw the report's own findings on the chart, so the two can be read together. */
export async function drawFindings(ticker, a, taRow, side, rawPatterns, bars, channel, groupName = null, {
  clear_scope = 'mcp',
  /**
   * The verdict from `ourAssessment` — 'BULLISH' | 'BEARISH' | 'NEUTRAL'.
   *
   * Distinct from `side`, which is 'long'/'short' and describes the POSITION being
   * reviewed (the Sunday run passes the side TA holds). `side` cannot express "no
   * direction": the caller that derived it collapsed NEUTRAL to 'long', so filtering
   * on it would silently delete every bearish finding on an undecided chart.
   */
  bias = null,
  /**
   * Sizing inputs for the native position tool, `{ account_size, risk_percent }`.
   *
   * Read from rules.json when omitted, which is what every real caller wants.
   * The parameter exists so the two paths — position tool and the three-line
   * fallback — can both be exercised deliberately, including on a live chart:
   * passing `null` forces the fallback without editing the owner's rules file.
   */
  account = undefined,
  /**
   * `{ date, days_until }` for the next earnings report, from TA's calendar.
   *
   * Additive and optional: a caller with no portfolio context passes nothing and
   * no line is drawn. `earningsLinePlan` owns every guard — a past date is never
   * drawn, and "N/A (ETF)" is an ANSWER rather than a broken input.
   */
  earnings = null,
  /**
   * The fixed-range volume profile — OFF by default, on request.
   *
   * It is a pane-wide overlay rather than a level, so it goes on when someone
   * asks for it rather than on every chart the batch walks. Nothing enables it
   * from `ticker_analyze` yet; the acceptance is "rendered natively on request".
   */
  volume_profile = false,
} = {}) {
  const group = groupName || `sunday-${String(ticker).replace(/^.*:/, '')}`;
  const drawn = { group, shapes: 0, items: [], errors: [], cleared: { tracked: 0, stale: 0 } };
  /**
   * `accountSettings` does not throw for a MISSING rules.json — it returns the
   * built-in defaults, whose `account_size` is null on purpose. It does throw for
   * an unparseable one, and a broken rules file must not take the whole drawing
   * step down; the plan simply falls back to lines and says why.
   */
  let acct = account;
  if (acct === undefined) {
    try { acct = accountSettings(); }
    catch (e) { acct = null; drawn.errors.push(`account settings: ${e.message}`); }
  }

  // CLEAR LAST WEEK BEFORE DRAWING THIS WEEK — in two passes, because one is
  // not enough and the gap is exactly a week wide.
  //
  // clearAll only removes what the registry still tracks. TradingView entity
  // IDs are SESSION-scoped, so by the next Sunday the app has restarted, every
  // ID from the previous run is dead, prune has dropped them, and this call
  // silently removes nothing while the drawings remain. That is how 545 stale
  // shapes accumulated across 45 charts — SNDK carrying the same level set six
  // times over.
  //
  // The second pass matches by TEXT, which survives a restart. It is scoped to
  // `review` signatures so it clears what this script drew and leaves a walls
  // overlay or a ta_draw_decision the user placed deliberately alone — and it
  // never touches a shape whose label we do not generate.
  /**
   * `clear_scope` is 'mcp' for the batch scripts and 'all' for an interactive
   * analysis, and the difference is load-bearing.
   *
   * 'mcp' removes only what the registry still tracks in THIS group — correct for
   * the morning screen and the Sunday review, which walk many symbols and must not
   * touch a walls overlay or a KEEP chart. But it leaves behind anything written by
   * older code, by a scan, or by TradingView's own pattern tools, and the owner's
   * instruction for an analysis is explicit: "you need to clear all drawings from a
   * chart before an analysis." A stale level is indistinguishable from one the
   * current analysis just proved. On a live DLO chart 'mcp' left a Head / Left
   * Shoulder / Right Shoulder annotation behind that was then nearly reported as
   * the owner's own work.
   *
   * So the analysis path passes 'all'; the batch scripts keep 'mcp' by default.
   */
  try {
    const r = clear_scope === 'all'
      ? await drawing.clearAll({ scope: 'all' })
      : await drawing.clearAll({ scope: 'mcp', group });
    drawn.cleared.tracked = r?.removed || 0;
    drawn.cleared.scope = clear_scope;
  } catch { /* first run, or nothing tracked */ }
  try {
    const r = await removeOrphans({ dry_run: false, sources: ['review'] });
    drawn.cleared.stale = r?.removed || 0;
  } catch (e) { drawn.errors.push(`clear stale: ${e.message}`); }

  /**
   * Returns the drawer's own result, so a caller can check `entity_id` rather
   * than trusting `success`. `drawShape` reports success even when the create
   * silently produced nothing — the exact failure mode this repo has been bitten
   * by eight times — and the entity id is the only evidence that distinguishes
   * them. Callers that ignore the return value are unaffected.
   */
  const put = async (fn, label) => {
    try { const r = await fn(); if (r?.success) { drawn.shapes++; drawn.items.push(label); return r; } }
    catch (e) { drawn.errors.push(`${label}: ${e.message}`); }
    return null;
  };

  /**
   * One horizontal line per PRICE.
   *
   * The blocks below each draw their own levels — primaries, zone boundaries, the
   * TA stop, every leg of every trade plan — and they land on top of each other. On
   * TIGO the primary resistance (100.415) and the supply-zone top (100.08) sat
   * 0.33% apart: two lines, two labels, one level. Seven horizontal lines ended up
   * on a chart the primary-level work had reduced to two, which reads exactly like
   * the clear-first step having failed even though it ran.
   *
   * First writer wins, because the blocks are ordered by how much the label says:
   * a primary level carries its anchor, a zone carries its band, a plan leg carries
   * its R:R. Anything within `tol` of a line already drawn is skipped and reported.
   */
  /** "9 tests + 1 swing high + 1.4x average volume + 55 bars..." -> "9 tests, 1.4x vol" */
  const shortReason = (reason) => {
    const parts = String(reason || '').split(' + ');
    const tests = parts.find((x) => /\d+ tests?/.test(x));
    const vol = parts.find((x) => /x average volume/.test(x));
    const flipped = parts.find((x) => /flipped/.test(x));
    return [tests, vol && vol.replace(' average volume', ' vol'), flipped && 'flipped']
      .filter(Boolean).join(', ');
  };

  /**
   * The time axis, for every shape that needs one. A callout's text box and the
   * earnings line are both placed in BAR units, which only means anything once
   * the median spacing is known — and it is not 86400 on an intraday chart, nor
   * on a daily one across a weekend (measured 120,960s median on AAPL daily).
   */
  const lastBarTime = Number.isFinite(bars?.at(-1)?.time) ? bars.at(-1).time : null;
  const barSeconds = (bars?.length ?? 0) > 11
    ? Math.max(1, Math.round((bars.at(-1).time - bars.at(-11).time) / 10))
    : 86400;
  /** ATR sets the collision distance. `assess()` already measured it; the bars are the fallback. */
  const atr = Number.isFinite(a?.risk?.atr_14) ? a.risk.atr_14 : atrFromBars(bars, 14);

  const drawnPrices = [];
  drawn.merged_levels = [];
  /** Every level actually drawn, in order — the input to `labelPlacements`. */
  const labelQueue = [];
  drawn.labels_offset = [];

  /** Merge extra overrides into a caller's JSON-string `overrides` without losing theirs. */
  const withOverrides = (opts, extra) => {
    let o = {};
    try { o = typeof opts?.overrides === 'string' ? JSON.parse(opts.overrides) : (opts?.overrides || {}); }
    catch { o = {}; }
    return { ...opts, overrides: JSON.stringify({ ...o, ...extra }) };
  };

  const hline = async (price, opts, label, { tol = 0.4 } = {}) => {
    if (!Number.isFinite(price)) return;
    const clash = drawnPrices.find((d) => Math.abs((d.price - price) / price) * 100 <= tol);
    if (clash) {
      drawn.merged_levels.push({ price: r2(price, 4), merged_into: clash.price, kept_label: clash.label, skipped: label });
      return;
    }
    drawnPrices.push({ price: r2(price, 4), label });

    /**
     * THE LINE IS ALWAYS THE LINE. Only the TEXT moves.
     *
     * The dedupe above handles two blocks claiming the same PRICE. This handles
     * two labels claiming the same few pixels of price scale, which is a different
     * problem with a different fix — merging them would delete a level that
     * deserves its own line.
     *
     * The text is passed to the callout UNCHANGED. Every one of these strings is
     * registered in `SIGNATURES_BY_SOURCE.review`, and rewording one to fit a box
     * would strand every drawing that carries the old wording.
     */
    labelQueue.push({ price: r2(price, 4), text: String(opts?.text ?? '') });
    const place = labelPlacements(labelQueue, atr).at(-1);

    if (place.mode !== 'callout' || !Number.isFinite(lastBarTime)) {
      await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(price, 4) }, ...opts, group }), label);
      return;
    }

    /**
     * The line keeps its `text` with `showLabel: false`: hidden, but still
     * readable by `findOrphans`, which matches on the text PROPERTY rather than
     * on what is rendered. A line stripped of its text would be as unsweepable as
     * the textless natives, and for no gain.
     */
    let lineColor = null;
    try { lineColor = JSON.parse(opts?.overrides || '{}').linecolor || null; } catch { /* default style */ }
    await put(() => drawing.drawShape({
      shape: 'horizontal_line', point: { price: r2(price, 4) },
      ...withOverrides(opts, { showLabel: false }), group,
    }), label);
    await put(() => drawing.drawShape({
      shape: 'callout',
      point: { price: r2(price, 4), time: lastBarTime },
      point2: {
        price: r2(price + place.price_offset, 4),
        time: lastBarTime + place.time_offset_bars * barSeconds,
      },
      overrides: JSON.stringify({
        color: lineColor || '#787B86', bordercolor: lineColor || '#787B86', textcolor: lineColor || '#787B86',
        backgroundColor: 'rgba(0,0,0,0)', fontsize: 11, linewidth: 1, transparency: 100,
      }),
      text: opts?.text ?? '',
      group,
    }), `${label} callout`);
    drawn.labels_offset.push({
      price: r2(price, 4), label, why: place.why,
      offset: { price: r2(place.price_offset, 4), bars: place.time_offset_bars },
    });
  };

  /**
   * Key levels — the PRIMARY support and resistance only, anchored to the last
   * confirmed swing extremes.
   *
   * This used to draw the top three per side by score, which put six lines on the
   * chart and buried the two that bound the range. Two selection rules have been
   * measured and dropped: `score` is driven by TEST COUNT, and touch count carries
   * no measured information about whether a level holds; and PROXIMITY is worse
   * still when price sits mid-range, because the nearest levels are then the
   * congestion price is inside — on DLO the three nearest were traded through
   * 16.7%, 16.7% and 21.7% of the last 60 bars, the worst three on the chart,
   * while the swing-anchored resistance was traded through 0.0%.
   *
   * Replicated out of sample on 20 large caps, none of them DLO: the anchored
   * level is crossed less in 15 of 19 comparisons, mean edge +7.98 points, sign
   * test p = 0.0116. Four of nineteen reverse, so it is a display convention with
   * a holdout arm, not a law. See PRIMARY_LEVEL_HOLDOUT in level_display.js.
   */
  const allLevels = (a.key_levels.all_supports || []).concat(a.key_levels.all_resistances || []);
  /**
   * `last_high` / `last_low` — NOT `recent_swings`, which does not exist. Reading a
   * key the module never returns is the failure this file's own header warns about:
   * it would land as undefined, selectPrimary would fall back to the nearest level,
   * and the output would look anchored while being the thing anchoring replaced.
   */
  const primary = allLevels.length ? selectPrimary(allLevels, {
    price: a.price,
    swing_high: a.market_structure?.last_high ?? null,
    swing_low: a.market_structure?.last_low ?? null,
  }) : { shown: [], interior: [], beyond: [] };

  for (const l of primary.shown) {
    const isSup = l.side === 'support';
    await hline(l.price, {
      overrides: JSON.stringify({ linecolor: isSup ? '#26a69a' : '#ef5350', linewidth: 2 }),
      /**
       * The EVIDENCE goes in the label, not just the distance. "R 14.84 (0.07%)"
       * says where it is; "14.84 - 9 tests - 1.4x vol" says why it earned a line.
       * The morning chart carried the evidence and the rewrite dropped it for a
       * percentage, which is the one thing the reader can already see.
       */
      text: `${isSup ? 'S' : 'R'} ${l.price} (${l.distance_pct}%)${l.reason ? ` - ${shortReason(l.reason)}` : ''}`,
    }, `${l.side} ${l.price} (primary)`);
  }
  drawn.levels = {
    drawn: primary.shown.length,
    anchors: primary.shown.map((l) => ({ side: l.side, price: l.price, anchor: l.anchor })),
    interior_not_drawn: primary.interior?.length ?? 0,
    beyond_not_drawn: primary.beyond?.length ?? 0,
    ...(primary.anchor_warning ? { anchor_warning: primary.anchor_warning } : {}),
    note: 'The primary support and resistance only — the levels that BOUND the range. Everything '
      + 'between them is interior congestion and is reported, not drawn.',
  };
  // Zones.
  if (a.supply_demand_zones.nearest_demand) {
    const z = a.supply_demand_zones.nearest_demand;
    await hline(z.bottom, {
      overrides: JSON.stringify({ linecolor: '#00897b', linewidth: 1, linestyle: 2 }),
      text: `demand ${z.bottom}-${z.top}`,
    }, 'demand zone');
  }
  if (a.supply_demand_zones.nearest_supply) {
    const z = a.supply_demand_zones.nearest_supply;
    await hline(z.top, {
      overrides: JSON.stringify({ linecolor: '#c62828', linewidth: 1, linestyle: 2 }),
      text: `supply ${z.bottom}-${z.top}`,
    }, 'supply zone');
  }
  // Pattern GEOMETRY, not just the completion level. A wedge is two trendlines;
  // drawing a horizontal line at the neckline tells you where it completes but
  // shows nothing of the shape the report is claiming.
  /**
   * Stable patterns only, and each SHAPE only once. A bull_flag and a
   * bullish_pennant are the same formation read two ways — on TIGO both reported
   * completion 100.75, target 115.24, a 17.32% pole over 25 bars and a 45.9%
   * retrace, and both were drawn, putting two poles and two boxes on one
   * consolidation and counting one setup as two.
   */
  const stable = (rawPatterns || []).filter((p) => a.chart_patterns.stable_across_sensitivities.includes(p.pattern));
  const plan = planPatternDrawings(stable, { max_patterns: 6, bias });
  for (const p of plan.patterns) await drawPatternGeometry(p, bars, group, put, hline);
  if (plan.skipped.length) drawn.patterns_skipped = plan.skipped;

  /**
   * The CHANNEL, as ONE native parallel_channel anchored to the same geometry.
   *
   * This was two independent `trend_line`s. They described a channel but were not
   * one: dragging either edge broke the parallelism the measurement asserts, and
   * clearing one left the other. TradingView's own tool takes three points — the
   * upper boundary's two ends, then any point on the lower boundary — and keeps
   * the pair parallel itself. Probed 2026-07-30: 3 asked, 3 landed.
   *
   * The three points are computed from the SAME fields the two lines used, so the
   * geometry is unchanged: `upper_start` and `lower_start` are the fitted
   * intercepts at the window's first bar and `slope_used` is the shared slope, so
   * the upper end is `slope_used × n + upper_start` over the window's n bars.
   *
   * ── What is lost, deliberately ──
   *
   * The on-chart label. A multipoint create silently produces NOTHING when given
   * a non-empty `text`, and `setProperties({ text })` afterwards returns without
   * throwing and reads back null — both probed the same day. So this shape, like
   * the position tool below, is recoverable ONLY through the registry and its
   * group, never through the text-signature orphan sweep. The retired
   * "<pattern> upper" / "<pattern> lower" signatures stay registered in
   * orphans.js: signatures are append-only, and every chart drawn before today
   * still carries those labels.
   */
  if (channel) {
    const seg = bars.slice(-channel.window);
    const t0 = seg[0].time, t1 = seg[seg.length - 1].time, n = seg.length - 1;
    const col = channel.direction === 'descending' ? '#ef5350' : channel.direction === 'ascending' ? '#26a69a' : '#78909c';
    const upperEnd = r2(channel.slope_used * n + channel.upper_start, 4);
    await put(() => drawing.drawShape({ shape: 'parallel_channel',
      points: [
        { price: channel.upper_start, time: t0 },
        { price: upperEnd, time: t1 },
        { price: channel.lower_start, time: t0 },
      ],
      overrides: JSON.stringify({ linecolor: col, linewidth: 2, showMidline: false, fillBackground: false, transparency: 100 }),
      group }), `channel ${channel.direction}`);
    drawn.channel = {
      pattern: channel.pattern,
      shape: 'parallel_channel',
      upper: [channel.upper_start, upperEnd],
      lower_start: channel.lower_start,
      note: 'One native entity, so the two boundaries stay parallel and clear together. It carries no '
        + 'text — a multipoint create rejects a label silently — so it is cleared by GROUP, not by the '
        + 'orphan sweep.',
    };
  }

  /**
   * FIBONACCI — one native `fib_retracement` on the impulse the block measured.
   *
   * `assess()` has computed this block from the start and nothing drew it, so a
   * reader got "retraced 45%, in the golden zone" with no way to see WHERE. The
   * anchor comes from `assessment.js`, which ties it to the same two swings
   * `fibLevels` measured and refuses to claim one when they do not match.
   *
   * No text: the tool draws its own level labels, and a duplicate caption on top
   * of them is noise. Textless means GROUP-cleared, never swept.
   */
  const fibPlan = fibDrawPlan(a.fibonacci);
  if (fibPlan.draw) {
    const col = fibPlan.direction === 'down' ? '#ef5350' : '#26a69a';
    await put(() => drawing.drawShape({
      shape: 'fib_retracement',
      point: fibPlan.points[0], point2: fibPlan.points[1],
      overrides: JSON.stringify({ linecolor: col, linewidth: 1, showCoeffs: true, showPrices: true }),
      group,
    }), 'fibonacci retracement');
    drawn.fibonacci = {
      shape: 'fib_retracement',
      why: fibPlan.why,
      direction: fibPlan.direction,
      in_golden_zone: fibPlan.in_golden_zone,
      from: fibPlan.points[0], to: fibPlan.points[1],
      note: 'Anchored to the SAME impulse assess() measured retraced_pct over. Textless — the tool draws '
        + 'its own level labels — so it is cleared by GROUP, not by the orphan sweep.',
    };
  } else {
    drawn.fibonacci = { drawn: false, why: fibPlan.why };
  }

  /**
   * ELLIOTT — only when every sensitivity found the SAME count.
   *
   * The gate is the whole feature. A rule-valid count exists on 82% of random
   * walks, so drawing one is a strong claim on weak evidence; drawing the ONE
   * every sensitivity agreed on at least removes the choice of swing lookback
   * from the answer. Disagreement is reported and never rendered.
   */
  const ellPlan = elliottDrawPlan(a.elliott);
  if (ellPlan.draw) {
    await put(() => drawing.drawShape({
      shape: 'elliott_impulse_wave',
      points: ellPlan.points,
      overrides: JSON.stringify({ linecolor: ellPlan.direction === 'down' ? '#ef5350' : '#26a69a', linewidth: 1 }),
      group,
    }), 'elliott impulse count');
    drawn.elliott = {
      shape: 'elliott_impulse_wave', why: ellPlan.why, direction: ellPlan.direction,
      pivots: ellPlan.points,
      note: 'Drawn ONLY because every sensitivity that produced a count produced this one. Textless, so '
        + 'it is cleared by GROUP. 82% of random walks admit a rule-valid count — agreement narrows the '
        + 'subjectivity, it does not make the count evidence.',
    };
  } else {
    drawn.elliott = { drawn: false, why: ellPlan.why };
  }

  /**
   * FIXED-RANGE VOLUME PROFILE — opt-in, over assess()'s own 90-bar window.
   *
   * Off by default because it is a pane-wide overlay rather than a level, and the
   * batch runs walk twenty charts. Drawn over `bars.slice(-VOLUME_PROFILE_WINDOW)`
   * so the shading and the reported VAH/VAL describe the same bars — two windows
   * would drift silently, which is this repo's most-repeated failure.
   */
  if (volume_profile) {
    const va = a.volume_analysis || {};
    if (va.value_area_low == null || va.value_area_high == null) {
      drawn.volume_profile = { drawn: false, why: 'volume_analysis has no value area — a profile with no volume has nothing to shade' };
    } else if ((bars?.length ?? 0) < 2) {
      drawn.volume_profile = { drawn: false, why: 'too few bars to span a range' };
    } else {
      const w = bars.slice(-VOLUME_PROFILE_WINDOW);
      await put(() => drawing.drawShape({
        shape: 'fixed_range_volume_profile',
        point: { price: r2(Math.min(...w.map((b) => b.low)), 4), time: w[0].time },
        point2: { price: r2(Math.max(...w.map((b) => b.high)), 4), time: w.at(-1).time },
        overrides: JSON.stringify({ transparency: 70 }),
        group,
      }), 'fixed range volume profile');
      drawn.volume_profile = {
        shape: 'fixed_range_volume_profile',
        window_bars: w.length,
        from: w[0].time, to: w.at(-1).time,
        value_area: [va.value_area_low, va.value_area_high],
        poc: va.poc ?? null,
        note: `The SAME ${VOLUME_PROFILE_WINDOW}-bar window assess() measured the value area over. Textless, `
          + 'so it is cleared by GROUP, not by the orphan sweep.',
      };
    }
  }

  // ENTRY / STOP / TARGET for whichever plan is actually live.
  //
  // Only CONFIRMED patterns get their levels drawn. A forming pattern's entry
  // is a hypothesis, and putting three bright lines on a chart for a shape
  // that has not completed is how a hypothesis starts looking like a plan.
  /**
   * Only the verdict side, same rule as the geometry above.
   *
   * A bilateral plan carries a `long` and a `short` leg, and drawing both put an
   * ENTRY, a STOP and a TARGET on each side of the price at once — six bright lines
   * describing two opposite trades. On ALM that produced a stop at 22.99 and a
   * target at 8.19 on a stock at 11.67, both correct for their own pattern and
   * useless together.
   */
  const wantLeg = { BULLISH: 'long', BEARISH: 'short' }[String(bias || '').toUpperCase()] || null;
  const drawnPatterns = new Set(plan.patterns.map((p) => p.pattern));
  const suppressedPlans = [];
  for (const tp of (a.trade_plans || [])) {
    if (!tp.tradeable_now) continue;
    /**
     * A plan whose pattern was not drawn must not draw its levels either. Otherwise
     * the suppressed head-and-shoulders is invisible as a shape but still puts a
     * stop and a target on the chart, which is the confusing half of both options.
     */
    if (drawnPatterns.size && tp.pattern && !drawnPatterns.has(tp.pattern)) {
      suppressedPlans.push({ pattern: tp.pattern, why: 'its pattern was not drawn — see patterns_skipped' });
      continue;
    }
    for (const [side, l] of Object.entries(tp.legs || {})) {
      if (wantLeg && side !== wantLeg) {
        suppressedPlans.push({ pattern: tp.pattern, side, why: `${side} leg contradicts the ${bias} verdict` });
        continue;
      }
      if (!l || l.entry == null) continue;
      const tag = tp.bilateral ? `${tp.pattern} ${side}` : tp.pattern;

      /**
       * ONE POSITION TOOL, when the plan is complete enough to size.
       *
       * `drawPosition` has existed, worked and been registered the whole time
       * while this drawer put three horizontal lines on the chart instead. The
       * native tool shades the risk and the reward, is draggable, and recomputes
       * the quantity itself — which keeps the displayed size honest if the owner
       * moves the stop, something three static lines cannot do.
       *
       * The gate stays exactly where it was: `tradeable_now`, past the
       * pattern-was-drawn check, and past the `wantLeg` verdict filter, so a plan
       * that would not have been drawn as lines is not drawn as a box either.
       *
       * ── The recoverability cost, stated ──
       *
       * A position tool carries no text. `findOrphans` classifies a shape with no
       * text as FOREIGN and never touches it — correct, since most hand-drawn
       * shapes are unlabelled and the cost of a false match is deleting the
       * owner's analysis. But it means a position tool whose registry entry has
       * died with the TradingView session is NOT recoverable by signature: it can
       * only be removed by hand or by `scope: 'all'`.
       *
       * The mitigation is that the GROUP clear is already the primary path here —
       * `drawFindings` clears its own group before drawing, and `drawPosition` is
       * passed that same group, so within a live session it is cleared with
       * everything else. The three-line fallback below is the text-bearing path,
       * and it is what runs whenever the account is not configured.
       */
      const legPlan = planLegDrawing(l, side, acct);
      if (legPlan.mode === 'position') {
        const res = await put(() => drawPosition({
          direction: legPlan.direction,
          entry: legPlan.entry, stop: legPlan.stop, target: legPlan.target,
          account_size: legPlan.account_size, risk_percent: legPlan.risk_percent,
          time: bars?.[bars.length - 1]?.time,
          group,
        }), `position ${side} ${tag}`);
        if (res) {
          /**
           * The three prices are claimed in `drawnPrices` even though no line was
           * drawn for them. The box already depicts them, and without this the VCP
           * pivot or TA's stop would put a second mark on a price the position tool
           * is already showing — the collision the dedupe exists to prevent.
           */
          for (const [role, price] of [['entry', legPlan.entry], ['stop', legPlan.stop], ['target', legPlan.target]]) {
            drawnPrices.push({ price: r2(price, 4), label: `${role} ${tag} (position tool)` });
          }
          (drawn.positions ||= []).push({
            side, pattern: tp.pattern, entry: legPlan.entry, stop: legPlan.stop, target: legPlan.target,
            rr: res.rr ?? null, qty: res.as_drawn?.qty ?? null, entity_id: res.entity_id ?? null,
            note: 'Drawn as TradingView\'s native position tool. It carries no text, so it is cleared by '
              + 'GROUP — the orphan sweep cannot see it.',
          });
          continue;
        }
        // The create failed and `put` has already recorded why. Fall through to
        // the lines rather than leaving the plan undrawn.
        (drawn.position_fallbacks ||= []).push({ side, pattern: tp.pattern, why: 'the position tool could not be drawn — see errors' });
      } else {
        (drawn.position_fallbacks ||= []).push({ side, pattern: tp.pattern, why: legPlan.why });
      }

      await hline(l.entry, {
        overrides: JSON.stringify({ linecolor: '#ffb300', linewidth: 3 }),
        text: `ENTRY ${side} ${l.entry} — ${tag}`,
      }, `entry ${tag}`);
      if (l.stop != null) {
        await hline(l.stop, {
          overrides: JSON.stringify({ linecolor: '#d50000', linewidth: 1, linestyle: 2 }),
          text: `STOP ${l.stop} — ${tag}`,
        }, `stop ${tag}`);
      }
      if (l.target != null) {
        await hline(l.target, {
          overrides: JSON.stringify({ linecolor: '#00c853', linewidth: 1, linestyle: 2 }),
          text: `TARGET ${l.target} (R:R ${l.rr}) — ${tag}`,
        }, `target ${tag}`);
      }
    }
  }
  if (suppressedPlans.length) drawn.plans_suppressed = suppressedPlans;
  // VCP pivot.
  if (a.volatility_contraction.vcp_qualifies && a.volatility_contraction.pivot) {
    await hline(a.volatility_contraction.pivot, {
      overrides: JSON.stringify({ linecolor: '#7e57c2', linewidth: 2 }),
      text: `VCP pivot ${a.volatility_contraction.pivot}`,
    }, 'vcp pivot');
  }
  // TA's own stop, so the report and TA can be compared visually.
  /**
   * `taRow` is null when the analysis is run standalone rather than from the Sunday
   * review or the morning screen, both of which always have a portfolio row. The
   * unguarded read threw and took the WHOLE drawing step down with it — geometry,
   * channel and levels included — for want of one optional line.
   */
  if (taRow && taRow.stop != null && Number.isFinite(taRow.stop)) {
    await hline(r2(taRow.stop, 4), {
      overrides: JSON.stringify({ linecolor: '#ff9800', linewidth: 2, linestyle: 1 }),
      text: `TA stop ${r2(taRow.stop, 2)} (${side})`,
    }, 'TA stop');
  }

  /**
   * THE EARNINGS DATE, on the time axis — the catalyst drawn where the stop is.
   *
   * Every guard lives in `earningsLinePlan`, including the one that matters most:
   * a PAST date is never drawn. Probed 2026-07-30 — a vertical_line placed beyond
   * the last bar creates normally and TradingView snaps it to the next session,
   * so no clamping is needed and none is done.
   *
   * Unlike the natives above this is a ONE-point shape, so its text survives and
   * it IS recoverable by the orphan sweep. The format is registered.
   */
  const earnPlan = earningsLinePlan(earnings, { last_bar_time: lastBarTime });
  if (earnPlan.draw) {
    await put(() => drawing.drawShape({
      shape: 'vertical_line',
      point: { price: a.price ?? bars?.at(-1)?.close ?? 0, time: earnPlan.time },
      overrides: JSON.stringify({ linecolor: '#ffa726', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#ffa726', fontsize: 11 }),
      text: earnPlan.text,
      group,
    }), 'earnings date');
    drawn.earnings = {
      shape: 'vertical_line', date: earnPlan.date, days: earnPlan.days, time: earnPlan.time,
      beyond_last_bar: earnPlan.beyond_last_bar,
      ...(earnPlan.reported_days_until != null && earnPlan.reported_days_until !== earnPlan.days
        ? { ta_days_until: earnPlan.reported_days_until, note_days: "TA's own days_until differs from the date; the DATE is what is drawn" }
        : {}),
      note: 'Carries text, so this one IS recoverable by the orphan sweep. TradingView snaps a future '
        + 'time to the next session (probed 2026-07-30).',
    };
  } else if (earnings) {
    drawn.earnings = { drawn: false, why: earnPlan.why };
  }
  return drawn;
}
