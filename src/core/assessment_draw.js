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
import { removeOrphans } from './orphans.js';

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

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
  return out.map(({ time, price }) => ({ time, price: r2(price, 4) }));
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
export async function drawPatternGeometry(p, bars, group, put) {
  const m = p.measurements || {};
  const label = `${p.pattern} ${p.status}`;
  const COL = p.direction === 'bearish' ? '#ef5350' : p.direction === 'bullish' ? '#26a69a' : '#42a5f5';
  const idxOf = (t) => { const i = bars.findIndex((b) => b.time >= t); return i < 0 ? bars.length - 1 : i; };

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
      overrides: JSON.stringify({ color: rectCol, backgroundColor: 'rgba(66,165,245,0.10)', linewidth: 2 }),
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
    const pv = windowPivots(bars, p.from_time, p.to_time, 5);
    if (pv.length >= 5) {
      await put(() => drawing.drawShape({ shape: 'triangle_pattern', points: pv.slice(-5),
        overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
        text: label, group }), `pattern ${p.pattern} (triangle_pattern)`);
    } else {
      // Too few pivots to anchor the native tool — say so rather than guessing.
      await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(m.resistance_now, 4) },
        overrides: JSON.stringify({ linecolor: COL, linewidth: 1, linestyle: 2 }),
        text: `${label} — only ${pv.length} pivots, too few to draw`, group }), `pattern ${p.pattern} unanchored`);
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
        overrides: JSON.stringify({ color: COL, backgroundColor: 'rgba(66,165,245,0.12)', linewidth: 1 }),
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
      await put(() => drawing.drawShape({ shape: 'head_and_shoulders', points: pv.slice(-7),
        overrides: JSON.stringify({ linecolor: COL, linewidth: 2 }),
        text: label, group }), `pattern ${p.pattern} (head_and_shoulders)`);
    }
  }
  // The break level, drawn as what it is rather than as the pattern.
  const neck = m.neckline ?? m.trough ?? m.peak ?? p.completion_level;
  if (neck != null) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(neck, 4) },
      overrides: JSON.stringify({ linecolor: COL, linewidth: 2, linestyle: 2 }),
      text: `${label} — breaks at ${r2(neck, 2)}`, group }), `pattern ${p.pattern} neckline`);
  }
}

/** Draw the report's own findings on the chart, so the two can be read together. */
export async function drawFindings(ticker, a, taRow, side, rawPatterns, bars, channel, groupName = null) {
  const group = groupName || `sunday-${String(ticker).replace(/^.*:/, '')}`;
  const drawn = { group, shapes: 0, items: [], errors: [], cleared: { tracked: 0, stale: 0 } };

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
  try {
    const r = await drawing.clearAll({ scope: 'mcp', group });
    drawn.cleared.tracked = r?.removed || 0;
  } catch { /* first run, or nothing tracked */ }
  try {
    const r = await removeOrphans({ dry_run: false, sources: ['review'] });
    drawn.cleared.stale = r?.removed || 0;
  } catch (e) { drawn.errors.push(`clear stale: ${e.message}`); }

  const put = async (fn, label) => {
    try { const r = await fn(); if (r?.success) { drawn.shapes++; drawn.items.push(label); } }
    catch (e) { drawn.errors.push(`${label}: ${e.message}`); }
  };

  // Key levels — the evidence the report quotes.
  for (const l of (a.key_levels.all_supports || []).slice(0, 3)) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.price },
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 1 }),
      text: `S ${l.price} (${l.distance_pct}%)`, group }), `support ${l.price}`);
  }
  for (const l of (a.key_levels.all_resistances || []).slice(-3)) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.price },
      overrides: JSON.stringify({ linecolor: '#ef5350', linewidth: 1 }),
      text: `R ${l.price} (${l.distance_pct}%)`, group }), `resistance ${l.price}`);
  }
  // Zones.
  if (a.supply_demand_zones.nearest_demand) {
    const z = a.supply_demand_zones.nearest_demand;
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: z.bottom },
      overrides: JSON.stringify({ linecolor: '#00897b', linewidth: 1, linestyle: 2 }),
      text: `demand ${z.bottom}-${z.top}`, group }), 'demand zone');
  }
  if (a.supply_demand_zones.nearest_supply) {
    const z = a.supply_demand_zones.nearest_supply;
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: z.top },
      overrides: JSON.stringify({ linecolor: '#c62828', linewidth: 1, linestyle: 2 }),
      text: `supply ${z.bottom}-${z.top}`, group }), 'supply zone');
  }
  // Pattern GEOMETRY, not just the completion level. A wedge is two trendlines;
  // drawing a horizontal line at the neckline tells you where it completes but
  // shows nothing of the shape the report is claiming.
  for (const p of rawPatterns) {
    if (!a.chart_patterns.stable_across_sensitivities.includes(p.pattern)) continue;
    await drawPatternGeometry(p, bars, group, put);
  }

  // The CHANNEL, as two parallel boundaries anchored to real pivots.
  if (channel) {
    const seg = bars.slice(-channel.window);
    const t0 = seg[0].time, t1 = seg[seg.length - 1].time, n = seg.length - 1;
    const col = channel.direction === 'descending' ? '#ef5350' : channel.direction === 'ascending' ? '#26a69a' : '#78909c';
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: channel.upper_start, time: t0 }, point2: { price: r2(channel.slope_used * n + channel.upper_start, 4), time: t1 },
      overrides: JSON.stringify({ linecolor: col, linewidth: 2 }),
      text: `${channel.pattern} upper`, group }), `channel ${channel.direction} upper`);
    await put(() => drawing.drawShape({ shape: 'trend_line',
      point: { price: channel.lower_start, time: t0 }, point2: { price: r2(channel.slope_used * n + channel.lower_start, 4), time: t1 },
      overrides: JSON.stringify({ linecolor: col, linewidth: 2 }),
      text: `${channel.pattern} lower`, group }), `channel ${channel.direction} lower`);
  }

  // ENTRY / STOP / TARGET for whichever plan is actually live.
  //
  // Only CONFIRMED patterns get their levels drawn. A forming pattern's entry
  // is a hypothesis, and putting three bright lines on a chart for a shape
  // that has not completed is how a hypothesis starts looking like a plan.
  for (const tp of (a.trade_plans || [])) {
    if (!tp.tradeable_now) continue;
    for (const [side, l] of Object.entries(tp.legs || {})) {
      if (!l || l.entry == null) continue;
      const tag = tp.bilateral ? `${tp.pattern} ${side}` : tp.pattern;
      await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.entry },
        overrides: JSON.stringify({ linecolor: '#ffb300', linewidth: 3 }),
        text: `ENTRY ${side} ${l.entry} — ${tag}`, group }), `entry ${tag}`);
      if (l.stop != null) {
        await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.stop },
          overrides: JSON.stringify({ linecolor: '#d50000', linewidth: 1, linestyle: 2 }),
          text: `STOP ${l.stop} — ${tag}`, group }), `stop ${tag}`);
      }
      if (l.target != null) {
        await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: l.target },
          overrides: JSON.stringify({ linecolor: '#00c853', linewidth: 1, linestyle: 2 }),
          text: `TARGET ${l.target} (R:R ${l.rr}) — ${tag}`, group }), `target ${tag}`);
      }
    }
  }
  // VCP pivot.
  if (a.volatility_contraction.vcp_qualifies && a.volatility_contraction.pivot) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: a.volatility_contraction.pivot },
      overrides: JSON.stringify({ linecolor: '#7e57c2', linewidth: 2 }),
      text: `VCP pivot ${a.volatility_contraction.pivot}`, group }), 'vcp pivot');
  }
  // TA's own stop, so the report and TA can be compared visually.
  if (taRow.stop != null && Number.isFinite(taRow.stop)) {
    await put(() => drawing.drawShape({ shape: 'horizontal_line', point: { price: r2(taRow.stop, 4) },
      overrides: JSON.stringify({ linecolor: '#ff9800', linewidth: 2, linestyle: 1 }),
      text: `TA stop ${r2(taRow.stop, 2)} (${side})`, group }), 'TA stop');
  }
  return drawn;
}
