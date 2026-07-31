/**
 * Core drawing logic.
 *
 * Three things this module deliberately owns, rather than leaving to callers:
 *
 * 1. Colors. Passing empty overrides makes TradingView reuse whatever style
 *    was last used interactively — which is how you end up with white text on
 *    a white chart, invisible until someone takes a screenshot. Every shape
 *    gets an explicit, theme-visible default; caller overrides always win.
 * 2. Timestamps. createShape needs a unix bar time. Callers can pass "now",
 *    "last_bar", an ISO date, or nothing at all for price-only shapes.
 * 3. Provenance. Created IDs are recorded so draw_clear can remove only what
 *    this tool drew, instead of destroying the user's own drawings.
 */
import { evaluate, getChartApi, KNOWN_PATHS } from '../connection.js';
import * as registry from './drawing_registry.js';
// A REAL key event via CDP. A synthetic KeyboardEvent is ignored by TradingView's
// handler (isTrusted === false), which is why the pattern tool stayed armed.
import { keyboard } from './ui.js';

/** linestyle: 0 solid, 1 dotted, 2 dashed. */
const SOLID = 0, DOTTED = 1, DASHED = 2;

// Palette chosen to read on both light and dark TradingView themes.
export const COLORS = {
  entry: '#2962FF',   // blue
  stop: '#F23645',    // red
  target: '#089981',  // green
  breakeven: '#787B86', // grey
  neutral: '#2962FF',
  text: '#FFFFFF',
};

/**
 * Per-shape defaults. Merged UNDER caller overrides, so anything explicitly
 * passed still wins. Keys differ by shape — TradingView uses `linecolor` for
 * line shapes and `color` for text/rectangle.
 */
export const DEFAULT_STYLE = {
  horizontal_line: { linecolor: COLORS.neutral, linewidth: 2, linestyle: SOLID, showLabel: true, textcolor: COLORS.neutral, fontsize: 12, horzLabelsAlign: 'right', vertLabelsAlign: 'top' },
  horizontal_ray: { linecolor: COLORS.neutral, linewidth: 2, linestyle: SOLID, showLabel: true, textcolor: COLORS.neutral, fontsize: 12 },
  vertical_line: { linecolor: COLORS.neutral, linewidth: 1, linestyle: DASHED, showLabel: true, textcolor: COLORS.neutral, fontsize: 12 },
  trend_line: { linecolor: COLORS.neutral, linewidth: 2, linestyle: SOLID, showLabel: true, textcolor: COLORS.neutral, fontsize: 12 },
  rectangle: { color: COLORS.neutral, linewidth: 1, backgroundColor: 'rgba(41, 98, 255, 0.12)', fillBackground: true, transparency: 85 },
  text: { color: COLORS.neutral, fontsize: 14, bold: false },
};

function styleFor(shape, overrides) {
  return { ...(DEFAULT_STYLE[shape] || {}), ...(overrides || {}) };
}

function parseOverrides(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`overrides is not valid JSON: ${e.message}. Example: {"linecolor":"#ff0000","linewidth":2}`);
  }
}

/** Time of the most recent bar on the chart, in unix seconds. */
export async function getLastBarTime() {
  const t = await evaluate(`
    (function() {
      try {
        var bars = ${KNOWN_PATHS.mainSeriesBars};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var v = bars.valueAt(bars.lastIndex());
        return v ? v[0] : null;
      } catch(e) { return null; }
    })()
  `);
  return typeof t === 'number' ? t : null;
}

/**
 * Accept a unix timestamp, "now", "last_bar", or an ISO date.
 * Falls back to the last bar time, then wall clock, so a price-only call
 * never fails for want of a timestamp.
 */
export async function resolveTime(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.floor(input);

  if (typeof input === 'string' && input.trim() !== '') {
    const raw = input.trim();

    if (/^\d+$/.test(raw)) return Math.floor(Number(raw));
    if (raw === 'now') return Math.floor(Date.now() / 1000);
    if (raw === 'last_bar') {
      const t = await getLastBarTime();
      if (t) return t;
      return Math.floor(Date.now() / 1000);
    }

    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);

    throw new Error(`Could not read time "${raw}". Use a unix timestamp, "now", "last_bar", or an ISO date like 2026-07-26.`);
  }

  const t = await getLastBarTime();
  return t || Math.floor(Date.now() / 1000);
}

/**
 * TradingView's native multipoint tools, and how many points each one takes.
 *
 * Verified against the live chart by creating each and reading back its
 * internal toolname. The important discovery: an UNKNOWN shape name does NOT
 * throw — it silently creates a LineToolFlagMark. So a "successful" call
 * proves nothing about which tool you got, and drawShape validates the point
 * count up front rather than letting a flag marker appear where a wedge was
 * expected.
 *
 * ── Live probe, 2026-07-30 (AMEX:SPY and NASDAQ:AAPL, CDP, all cleaned up) ──
 *
 * The probe asked each tool for its declared point count and read back how many
 * points actually landed. Three results are load-bearing:
 *
 *   head_and_shoulders   7 asked, **7 landed** — ADOPTED (assessment_draw.js)
 *   elliott_impulse_wave 6 asked, **6 landed** — available
 *   parallel_channel     3 asked, **3 landed** — ADOPTED (assessment_draw.js)
 *   triangle_pattern     5 asked, **2 landed**, and the tool was left ARMED —
 *                        reproducibly, on the same chart, in the same session as
 *                        the two successes above.
 *
 * So the old conclusion — "TradingView's native multipoint tools place their
 * first two points and stay armed" — was **triangle_pattern-specific, not
 * multipoint-general**. Wedges and triangles keep the two-trend-line
 * reconstruction in `drawPatternGeometry`; head-and-shoulders does not.
 * Do not re-try triangle_pattern (improvements.md P1.4).
 *
 * ── DO NOT USE, same probe date (P1.10) ──
 *
 *   price_label   1 point asked, **NOTHING created**. Silent, exactly like an
 *                 unknown shape name — except an unknown name at least leaves a
 *                 flag mark behind to notice.
 *   curve         3 points asked, **2 landed**. The third point's encoding is
 *                 not the {time, price} the other tools take, and guessing at it
 *                 is how a drawn boundary ends up describing nothing.
 *
 * ── `text` does not survive a multipoint create, on ANY of them ──
 *
 * Probed 2026-07-30 on parallel_channel: 3 points and no text creates the
 * channel (3/3); the identical call with a non-empty `text` creates **nothing at
 * all** and returns normally. Setting it afterwards does not work either —
 * `shape.setProperties({ text })` returns without throwing and the text reads
 * back null. That is a third silent success in the same code path.
 *
 * The consequence is not cosmetic: `orphans.js` recognises our drawings by their
 * TEXT, because entity ids die with the TradingView session. A shape with no
 * text is classified `foreign` by `findOrphans` and is NEVER swept. So every
 * multipoint shape here is recoverable ONLY through the registry and its group —
 * see the comment on the position tool in assessment_draw.js.
 *
 * ── TWO-POINT shapes are the opposite case, re-probed 2026-07-30 ──
 *
 * The no-text rule above is about creates with MORE than two points, which take
 * the `createMultipointShape` branch below. A two-point create goes through the
 * `point2` branch, which passes `text` — and it lands:
 *
 *   callout                     2/2 points, text READ BACK VERBATIM — adopted
 *                               for the off-line level labels (P1.6). Because it
 *                               carries text it IS sweepable by orphans.js, and
 *                               its format is registered there.
 *   fib_retracement             2/2 points — adopted (P1.5). Passed NO text
 *                               deliberately: it draws its own level labels.
 *   fixed_range_volume_profile  2/2 points — adopted, opt-in (P1.8). Textless.
 *
 * ── vertical_line BEYOND the last bar: it works (P1.7) ──
 *
 * The open question for the earnings line was whether a one-point shape can be
 * placed at a time past the end of the series. Asked at 2026-09-06 on
 * NASDAQ:AAPL — ~38 days past the last bar — it CREATED, landed 1/1 points, and
 * kept its text. TradingView SNAPPED the requested time to the next session:
 * 2026-09-06 was a Sunday and the shape read back at 2026-09-08. So nothing
 * needs clamping to the last bar, and the line lands on a trading day rather
 * than in a weekend gap.
 */
export const NATIVE_PATTERN_SHAPES = {
  head_and_shoulders: 7,        // LineToolHeadAndShoulders
  triangle_pattern: 5,          // LineToolTrianglePattern — BROKEN, see above
  xabcd_pattern: 5,             // LineTool5PointsPattern
  cypher_pattern: 5,            // LineToolCypherPattern
  abcd_pattern: 4,              // LineToolABCD
  elliott_impulse_wave: 6,      // LineToolElliottImpulse
  elliott_correction_wave: 4,   // LineToolElliottCorrection
  elliott_triangle_wave: 6,     // LineToolElliottTriangle
  elliott_double_combo: 4,      // LineToolElliottDoubleCombo
  elliott_triple_combo: 6,      // LineToolElliottTripleCombo
  flat_bottom: 3,               // LineToolFlatBottom
  // Not a pattern tool, but multipoint and worth the same up-front point-count
  // check: asked with the wrong count it does not throw, it draws a flag mark.
  parallel_channel: 3,          // LineToolParallelChannel
};

/** The symbol currently loaded, used to tag drawings so pruning stays scoped. */
export async function currentSymbol() {
  try {
    const s = await evaluate(`(function(){try{return window.TradingViewApi._activeChartWidgetWV.value().symbol();}catch(e){return null;}})()`);
    return typeof s === 'string' ? s : null;
  } catch { return null; }
}

/**
 * How long to wait for a multipoint create to resolve, and how often to look.
 *
 * Exported so the settle policy is testable and so a change to it is a visible
 * change rather than a magic number moving.
 */
export const MULTIPOINT_SETTLE = { interval_ms: 150, budget_ms: 1500 };

/**
 * Wait until a NEW shape id appears, or the budget runs out.
 *
 * This replaced a fixed 500ms sleep. The sleep was empirically tight: a probe
 * watched shapes resolve after the capture window had already closed, and a
 * create whose id escapes capture is never recorded in the registry — which
 * means `draw_clear scope:'mcp'` can never remove it, and (for the multipoint
 * tools, which cannot carry text at all) neither can the orphan sweep. That is
 * the 545-stale-shapes failure, one drawing at a time.
 *
 * Polling instead of sleeping also makes the common case FASTER: a shape that
 * lands in 150ms no longer costs 500.
 *
 * Returns the new id, or null if nothing appeared within the budget. Null is a
 * real answer — the create may have silently produced nothing, which is what
 * `text` on a multipoint shape and `price_label` both do.
 */
async function settleForNewId(apiPath, beforeIds, { interval_ms, budget_ms } = MULTIPOINT_SETTLE) {
  const before = new Set(beforeIds || []);
  const deadline = Date.now() + budget_ms;
  for (;;) {
    await new Promise((r) => setTimeout(r, interval_ms));
    let after = null;
    try { after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`); }
    catch { /* a read that failed is not evidence the shape is absent — keep polling */ }
    const fresh = (after || []).find((id) => !before.has(id));
    if (fresh) return fresh;
    if (Date.now() >= deadline) return null;
  }
}

/** Create one shape and return its new entity id (null if it could not be identified). */
async function createOne({ apiPath, shape, point, point2, points, overrides, text }) {
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  // Captured during the settle poll below, so a shape that resolves late is
  // still identified even if something later removes or replaces it.
  let settledId = null;

  if (points && points.length > 2) {
    // TradingView's native pattern tools are N-point multipoint shapes:
    // head_and_shoulders (7), triangle_pattern (5), xabcd_pattern (5),
    // cypher_pattern (5), abcd_pattern (4), elliott_* (4-6).
    //
    // Two silent failure modes, both found by probing the live chart:
    //
    //   1. An UNKNOWN shape name does not throw — it creates a
    //      LineToolFlagMark instead. drawShape validates the name up front.
    //   2. A NON-EMPTY `text` makes the create fail silently and return
    //      normally. `text:""` works, `text:"label"` produces nothing at all.
    //      So text is omitted here — these tools draw their own point labels
    //      anyway (the shoulders and head, the triangle's A-E).
    //
    // Neither throws, which is precisely why the caller must verify what
    // landed rather than trusting the absence of an error.
    await evaluate(`
      ${apiPath}.createMultipointShape(
        ${JSON.stringify(points)},
        { shape: ${JSON.stringify(shape)}, overrides: ${overridesStr} }
      )
    `);
    /**
     * SETTLE-VERIFY, not a fixed sleep.
     *
     * These resolve more slowly than the two-point shapes, and the old fixed
     * 500ms was a guess that a probe caught being wrong — see settleForNewId.
     * The id is captured HERE, before the Escape, so a late-resolving create can
     * no longer escape the registry.
     */
    settledId = await settleForNewId(apiPath, before);
    /**
     * Disarm the drawing tool with a REAL key event.
     *
     * `createMultipointShape` leaves TradingView's pattern tool ARMED — the ABCD /
     * triangle cursor stays selected waiting for clicks that never come, so the
     * next thing the user clicks starts a drawing instead of doing what they meant.
     * The owner had to press ESC by hand after every analysis.
     *
     * A synthetic `new KeyboardEvent('keydown')` does NOT work: it was tried and
     * the tool stayed armed, because the handler ignores events with
     * `isTrusted === false`. It has to go through CDP's Input domain, which is what
     * `ui.keyboard` already does — the same path the ui_keyboard tool uses.
     *
     * There is no `selectLineTool` on the exposed API; the chart widget and the
     * widget collection were both checked and neither has one.
     */
    try { await keyboard({ key: 'Escape' }); } catch { /* the shape is drawn either way */ }
  } else if (point2) {
    await evaluate(`
      ${apiPath}.createMultipointShape(
        [{ time: ${point.time}, price: ${point.price} }, { time: ${point2.time}, price: ${point2.price} }],
        { shape: ${JSON.stringify(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${point.time}, price: ${point.price} },
        { shape: ${JSON.stringify(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  // The post-Escape read is the authority when it sees the shape. When it does
  // not, an id the settle poll DID see still beats returning null: an
  // unidentified shape is an untrackable one.
  return (after || []).find(id => !(before || []).includes(id)) || settledId || null;
}

/**
 * `points` (3 or more) uses TradingView's own N-point pattern tools — see
 * NATIVE_PATTERN_SHAPES. Otherwise `point` / `point2` behave as before.
 */
export async function drawShape({ shape, point, point2, points, overrides: overridesRaw, text, group }) {
  // Validate before connecting, so bad input fails the same way with or
  // without a live chart.
  const overrides = styleFor(shape, parseOverrides(overridesRaw));

  const multi = Array.isArray(points) && points.length > 2;
  if (multi) {
    const need = NATIVE_PATTERN_SHAPES[shape];
    if (need && points.length !== need) {
      throw new Error(`Shape "${shape}" needs exactly ${need} points, got ${points.length}. `
        + 'TradingView does NOT reject a wrong shape name or point count — it silently draws a flag marker instead.');
    }
    for (const p of points) {
      if (!p || p.price === undefined || p.price === null || Number.isNaN(Number(p.price))) {
        throw new Error('Every entry in `points` needs a numeric price.');
      }
    }
  } else if (!point || point.price === undefined || point.price === null || Number.isNaN(Number(point.price))) {
    throw new Error('point.price is required and must be a number.');
  }

  const apiPath = await getChartApi();

  const resolvedPoints = multi
    ? await Promise.all(points.map(async (p) => ({ price: Number(p.price), time: await resolveTime(p.time) })))
    : null;
  const resolvedPoint = multi
    ? resolvedPoints[0]
    : { price: Number(point.price), time: await resolveTime(point.time) };
  let resolvedPoint2;
  if (!multi && point2 && point2.price !== undefined && point2.price !== null) {
    resolvedPoint2 = { price: Number(point2.price), time: await resolveTime(point2.time) };
  }

  const entity_id = await createOne({
    apiPath, shape, point: resolvedPoint, point2: resolvedPoint2, points: resolvedPoints, overrides, text,
  });

  if (entity_id) {
    registry.record([{ entity_id, shape, role: null }], { group: group || null, symbol: await currentSymbol() });
  }

  return {
    success: true,
    shape,
    entity_id,
    point: resolvedPoint,
    ...(resolvedPoint2 ? { point2: resolvedPoint2 } : {}),
    ...(resolvedPoints ? { points: resolvedPoints } : {}),
    group: group || null,
    style_applied: overrides,
  };
}

function round(n, dp = 8) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  return targets.map((t, i) => {
    if (typeof t === 'number') return { price: t, label: `TP${i + 1}`, partial_pct: null };
    if (t && typeof t === 'object' && t.price !== undefined) {
      return {
        price: Number(t.price),
        label: t.label || `TP${i + 1}`,
        partial_pct: t.partial_pct === undefined || t.partial_pct === null ? null : Number(t.partial_pct),
      };
    }
    throw new Error(`targets[${i}] must be a number or an object with a price.`);
  });
}

/**
 * Validate a trade plan and compute its levels, R:R, and sizing.
 *
 * Pure: no chart access. Every input error surfaces here, before anything is
 * drawn — a plan that fails validation must never leave half its lines behind.
 * Exported so the arithmetic can be tested without a live chart.
 */
export function buildTradePlan({
  direction,
  entry,
  stop,
  targets,
  breakeven,
  group,
  account_size,
  risk_percent,
} = {}) {
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'long' && dir !== 'short') {
    throw new Error('direction must be "long" or "short".');
  }

  const entryPrice = Number(entry);
  const stopPrice = Number(stop);
  if (!Number.isFinite(entryPrice)) throw new Error('entry must be a number.');
  if (!Number.isFinite(stopPrice)) throw new Error('stop must be a number.');
  if (entryPrice === stopPrice) throw new Error('entry and stop cannot be equal — risk would be zero.');

  const tps = normalizeTargets(targets);

  // Catch a plan that contradicts its own direction before it reaches the chart.
  if (dir === 'long' && stopPrice > entryPrice) {
    throw new Error(`Long plan has its stop (${stopPrice}) above entry (${entryPrice}). Check the direction or swap the levels.`);
  }
  if (dir === 'short' && stopPrice < entryPrice) {
    throw new Error(`Short plan has its stop (${stopPrice}) below entry (${entryPrice}). Check the direction or swap the levels.`);
  }
  for (const t of tps) {
    if (!Number.isFinite(t.price)) throw new Error(`Target "${t.label}" is not a number.`);
    if (dir === 'long' && t.price <= entryPrice) {
      throw new Error(`Long target "${t.label}" (${t.price}) is at or below entry (${entryPrice}).`);
    }
    if (dir === 'short' && t.price >= entryPrice) {
      throw new Error(`Short target "${t.label}" (${t.price}) is at or above entry (${entryPrice}).`);
    }
  }

  const riskPerUnit = Math.abs(entryPrice - stopPrice);

  const levels = [
    { role: 'entry', price: entryPrice, label: 'Entry', color: COLORS.entry, linestyle: SOLID, linewidth: 2 },
    { role: 'stop', price: stopPrice, label: 'Stop', color: COLORS.stop, linestyle: SOLID, linewidth: 2 },
  ];

  if (breakeven !== undefined && breakeven !== null && breakeven !== '') {
    const bePrice = Number(breakeven);
    if (!Number.isFinite(bePrice)) throw new Error('breakeven must be a number when provided.');
    levels.push({ role: 'breakeven', price: bePrice, label: 'BE', color: COLORS.breakeven, linestyle: DOTTED, linewidth: 1 });
  }

  tps.forEach((t) => {
    const rr = round(Math.abs(t.price - entryPrice) / riskPerUnit, 2);
    const partial = t.partial_pct ? ` ${t.partial_pct}%` : '';
    levels.push({
      role: 'target',
      price: t.price,
      label: `${t.label}${partial} (${rr}R)`,
      color: COLORS.target,
      linestyle: DASHED,
      linewidth: 1,
      rr,
      partial_pct: t.partial_pct,
      target_label: t.label,
    });
  });

  // Sizing is validated here, up front — not after the lines are drawn.
  let sizing = null;
  if (account_size !== undefined && account_size !== null && risk_percent !== undefined && risk_percent !== null) {
    const acct = Number(account_size);
    const pct = Number(risk_percent);
    if (!Number.isFinite(acct) || acct <= 0) throw new Error('account_size must be a positive number.');
    if (!Number.isFinite(pct) || pct <= 0) throw new Error('risk_percent must be a positive number.');
    const riskAmount = acct * (pct / 100);
    sizing = {
      account_size: acct,
      risk_percent: pct,
      risk_amount: round(riskAmount, 2),
      risk_per_unit: round(riskPerUnit),
      position_size: round(riskAmount / riskPerUnit, 8),
      note: 'Arithmetic from the levels and risk you supplied. Not advice; verify against your own rules and instrument contract size.',
    };
  }

  const rrs = levels.filter(l => l.rr !== undefined).map(l => l.rr);

  return {
    direction: dir,
    entry: entryPrice,
    stop: stopPrice,
    risk_per_unit: round(riskPerUnit),
    levels,
    sizing,
    best_rr: rrs.length ? Math.max(...rrs) : null,
    worst_rr: rrs.length ? Math.min(...rrs) : null,
    group: group || `${dir}-${entryPrice}`,
  };
}

/**
 * Draw a complete trade plan: entry, stop, targets, optional break-even.
 *
 * Each level is its own labelled horizontal line, so labels ride on the line
 * they describe instead of colliding as free-floating text. Label alignment
 * is staggered so adjacent levels stay readable when prices are close.
 */
export async function drawTradePlan({ label_prefix, time, ...planArgs } = {}) {
  const plan = buildTradePlan(planArgs);
  const { levels, sizing, group: groupName } = plan;

  const apiPath = await getChartApi();
  const baseTime = await resolveTime(time);
  const prefix = label_prefix ? `${label_prefix} ` : '';

  // Label placement, verified against a live chart.
  //
  // Slots are assigned by PRICE RANK, not by the order levels happen to be
  // built in, so that staggering separates the levels that are actually
  // adjacent on screen. Every consecutive rank differs on at least one axis,
  // and alternating vertical alignment makes even-numbered neighbours point
  // their labels away from each other instead of into the same gap.
  //
  // 'right' is excluded — it puts the label under the price scale, clipped.
  // Wide labels at 'left' clip against the chart edge, so 'center' leads.
  const LABEL_SLOTS = [
    { horzLabelsAlign: 'center', vertLabelsAlign: 'bottom' },
    { horzLabelsAlign: 'center', vertLabelsAlign: 'top' },
    { horzLabelsAlign: 'left', vertLabelsAlign: 'bottom' },
    { horzLabelsAlign: 'left', vertLabelsAlign: 'top' },
  ];

  const priceRank = new Map(
    [...levels].sort((a, b) => a.price - b.price).map((lvl, rank) => [lvl, rank]),
  );

  const drawn = [];
  const failed = [];

  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    const overrides = {
      linecolor: lvl.color,
      linewidth: lvl.linewidth,
      linestyle: lvl.linestyle,
      showLabel: true,
      textcolor: lvl.color,
      fontsize: 12,
      ...LABEL_SLOTS[priceRank.get(lvl) % LABEL_SLOTS.length],
    };
    const text = `${prefix}${lvl.label} ${lvl.price}`;

    try {
      const entity_id = await createOne({
        apiPath,
        shape: 'horizontal_line',
        point: { time: baseTime, price: lvl.price },
        overrides,
        text,
      });
      if (entity_id) {
        drawn.push({ entity_id, shape: 'horizontal_line', role: lvl.role, price: lvl.price, label: text, ...(lvl.rr !== undefined ? { rr: lvl.rr } : {}) });
      } else {
        failed.push({ role: lvl.role, price: lvl.price, reason: 'created but could not be identified' });
      }
    } catch (err) {
      failed.push({ role: lvl.role, price: lvl.price, reason: err.message });
    }
  }

  if (drawn.length) {
    registry.record(drawn.map(d => ({ entity_id: d.entity_id, shape: d.shape, role: d.role })), { group: groupName });
  }

  return {
    success: failed.length === 0,
    direction: plan.direction,
    group: groupName,
    entry: plan.entry,
    stop: plan.stop,
    risk_per_unit: plan.risk_per_unit,
    targets: drawn.filter(d => d.role === 'target').map(d => ({ price: d.price, rr: d.rr })),
    best_rr: plan.best_rr,
    worst_rr: plan.worst_rr,
    ...(sizing ? { sizing } : {}),
    levels_drawn: drawn.length,
    entity_ids: drawn.map(d => d.entity_id),
    drawings: drawn,
    ...(failed.length ? { failed, warning: `${failed.length} of ${levels.length} levels could not be drawn.` } : {}),
    clear_hint: `Remove just this plan with draw_clear group="${groupName}".`,
  };
}

export async function listDrawings({ include_points = false } = {}) {
  const apiPath = await getChartApi();
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      var withPoints = ${include_points ? 'true' : 'false'};
      return all.map(function(s) {
        var out = { id: s.id, name: s.name };
        if (withPoints) {
          try {
            var shape = api.getShapeById(s.id);
            if (shape && typeof shape.getPoints === 'function') {
              var pts = shape.getPoints();
              if (pts) out.points = pts;
            }
          } catch(e) { out.points_error = e.message; }
        }
        return out;
      });
    })()
  `);

  const all = shapes || [];
  // Reconcile the registry against reality so stale session IDs disappear.
  registry.prune(all.map(s => s.id));
  const tracked = new Map(registry.list().map(e => [e.entity_id, e]));

  const annotated = all.map(s => {
    const t = tracked.get(s.id);
    return { ...s, created_by_mcp: !!t, ...(t ? { group: t.group, role: t.role } : {}) };
  });

  return {
    success: true,
    count: annotated.length,
    mcp_count: annotated.filter(s => s.created_by_mcp).length,
    groups: registry.groups(),
    shapes: annotated,
  };
}

export async function getProperties({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${JSON.stringify(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);

  const tracked = registry.list().find(e => e.entity_id === entity_id);
  return { success: true, ...result, created_by_mcp: !!tracked, ...(tracked ? { group: tracked.group, role: tracked.role } : {}) };
}

export async function removeOne({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${JSON.stringify(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.removed) registry.forget([entity_id]);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

/**
 * Remove drawings.
 *
 * Defaults to scope 'mcp' — only drawings this tool created. Wiping the user's
 * own drawings now requires an explicit scope: 'all', because that is not
 * recoverable and was previously the silent default.
 */
export async function clearAll({ scope = 'mcp', group = null } = {}) {
  const requested = String(scope || 'mcp').toLowerCase();
  if (!['mcp', 'all'].includes(requested)) {
    throw new Error(`Unknown scope "${scope}". Use "mcp" (only drawings this tool created) or "all" (every drawing on the chart).`);
  }
  if (requested === 'all' && group) {
    throw new Error('group cannot be combined with scope "all" — "all" ignores grouping. Use scope "mcp" with a group.');
  }

  const apiPath = await getChartApi();

  if (requested === 'all') {
    const before = await evaluate(`${apiPath}.getAllShapes().length`);
    await evaluate(`${apiPath}.removeAllShapes()`);
    registry.clear();
    return { success: true, scope: 'all', removed: before || 0, action: 'all_shapes_removed', note: 'Every drawing was removed, including any the user placed by hand.' };
  }

  // getAllShapes() only sees the CURRENT symbol, so the prune must be scoped
  // to it — otherwise every other symbol's tracked drawings get untracked and
  // can never be cleared again. See drawing_registry.prune.
  const liveIds = (await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`)) || [];
  /**
   * `currentSymbol()` returns null on ANY failure — it swallows the error. The prune
   * below now refuses rather than wiping the store when that happens, but a refusal
   * has to be visible: a run that silently stopped pruning would accumulate stale
   * entries with nothing saying why.
   */
  const sym = await currentSymbol();
  const pruned = registry.prune(liveIds, { symbol: sym });

  const candidates = registry.list({ group });
  if (!candidates.length) {
    return {
      success: true,
      scope: 'mcp',
      group: group || null,
      removed: 0,
      note: group
        ? `No tracked drawings in group "${group}". Check draw_list for available groups.`
        : 'No tracked drawings to remove. Drawings made by hand are left alone — pass scope "all" to remove everything.',
    };
  }

  const ids = [...new Set(candidates.map(c => c.entity_id))].filter(id => liveIds.includes(id));

  const removed = [];
  for (const id of ids) {
    try {
      await evaluate(`${apiPath}.removeEntity(${JSON.stringify(id)})`);
      removed.push(id);
    } catch { /* already gone; prune below handles it */ }
  }
  /**
   * FORGET ONLY WHAT WAS REMOVED.
   *
   * This forgot `candidates` — and with no `group`, `candidates` is every entry for
   * every SYMBOL, while `ids` is only the handful live on the chart in front of us.
   * So one `draw_clear scope:"mcp"` untracked the entire store: it deleted 22 shapes
   * on the loaded symbol and quietly orphaned every drawing on every other chart.
   *
   * They stayed on those charts and became unclearable by `scope: "mcp"` forever
   * after, because the registry no longer knew they were ours. Measured straight
   * afterwards: FTAI still carried its 8 shapes, all reading `created_by_mcp: false`,
   * minutes after this toolchain had drawn them.
   *
   * The bound is `ids`, not `removed` — an entity that was live but whose removal
   * threw is gone from the chart or unreachable either way, and keeping a record of
   * it would resurrect a phantom on every later clear.
   */
  registry.forget(ids);

  const remaining = await evaluate(`${apiPath}.getAllShapes().length`);
  return {
    success: true,
    scope: 'mcp',
    group: group || null,
    removed: removed.length,
    entity_ids: removed,
    remaining_shapes: remaining || 0,
    // A refusal here means the store kept stale entries rather than losing good ones.
    ...(pruned?.refused ? { prune_refused: pruned.why } : {}),
    note: 'Only drawings created by this tool were removed. Tracking for other symbols is untouched.',
  };
}

/** Tracked groups, for "clear the ALGO plan"-style requests. */
export function listGroups() {
  return { success: true, groups: registry.groups(), store: registry.STORE_LOCATION };
}
