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
import { selectPrimary } from './level_display.js';
import { planPatternDrawings } from './patterns_draw.js';
import { accountSettings } from './rules.js';

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

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
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
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
 * Alternating swing pivots inside a pattern's own window.
 *
 * TradingView's native pattern tools take N alternating points and render the
 * shape themselves. Feeding them REAL pivots is the whole point — it is what
 * stops a drawn boundary from floating away from the price, which is exactly
 * how the CQTM wedge ended up with a lower edge at 22.25 on a bar trading ~29.
 */
export function windowPivots(bars, fromTime, toTime, want) {
  const s = Math.max(0, bars.findIndex((b) => b.time >= fromTime));
  let e = bars.findIndex((b) => b.time >= toTime);
  if (e < 0) e = bars.length - 1;
  const out = [];
  for (const lb of [3, 2, 1]) {          // loosen until enough pivots are found
    out.length = 0;
    for (let i = Math.max(s, lb); i <= Math.min(e, bars.length - 1 - lb); i++) {
      const w = bars.slice(i - lb, i + lb + 1);
      const isHigh = bars[i].high === Math.max(...w.map((b) => b.high));
      const isLow = bars[i].low === Math.min(...w.map((b) => b.low));
      if (!isHigh && !isLow) continue;
      const kind = isHigh ? 'high' : 'low';
      const price = isHigh ? bars[i].high : bars[i].low;
      const last = out[out.length - 1];
      if (last && last.kind === kind) {   // keep the more extreme of a run
        if (kind === 'high' ? price > last.price : price < last.price) out[out.length - 1] = { time: bars[i].time, price, kind };
        continue;
      }
      out.push({ time: bars[i].time, price, kind });
    }
    if (out.length >= want) break;
  }
  return out.map(({ time, price, kind }) => ({ time, price: r2(price, 4), kind }));
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
    const pv = windowPivots(bars, p.from_time, p.to_time, 5);
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
    const pv = windowPivots(bars, p.from_time, p.to_time, 7);
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

  const drawnPrices = [];
  drawn.merged_levels = [];
  const hline = async (price, opts, label, { tol = 0.4 } = {}) => {
    if (!Number.isFinite(price)) return;
    const clash = drawnPrices.find((d) => Math.abs((d.price - price) / price) * 100 <= tol);
    if (clash) {
      drawn.merged_levels.push({ price: r2(price, 4), merged_into: clash.price, kept_label: clash.label, skipped: label });
      return;
    }
    drawnPrices.push({ price: r2(price, 4), label });
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(price, 4) }, ...opts, group }), label);
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
  return drawn;
}
