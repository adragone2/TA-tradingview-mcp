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

/** Create one shape and return its new entity id (null if it could not be identified). */
async function createOne({ apiPath, shape, point, point2, overrides, text }) {
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  if (point2) {
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
  return (after || []).find(id => !(before || []).includes(id)) || null;
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, group }) {
  // Validate before connecting, so bad input fails the same way with or
  // without a live chart.
  const overrides = styleFor(shape, parseOverrides(overridesRaw));
  if (!point || point.price === undefined || point.price === null || Number.isNaN(Number(point.price))) {
    throw new Error('point.price is required and must be a number.');
  }

  const apiPath = await getChartApi();

  const resolvedPoint = { price: Number(point.price), time: await resolveTime(point.time) };
  let resolvedPoint2;
  if (point2 && point2.price !== undefined && point2.price !== null) {
    resolvedPoint2 = { price: Number(point2.price), time: await resolveTime(point2.time) };
  }

  const entity_id = await createOne({
    apiPath, shape, point: resolvedPoint, point2: resolvedPoint2, overrides, text,
  });

  if (entity_id) {
    registry.record([{ entity_id, shape, role: null }], { group: group || null });
  }

  return {
    success: true,
    shape,
    entity_id,
    point: resolvedPoint,
    ...(resolvedPoint2 ? { point2: resolvedPoint2 } : {}),
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

  const liveIds = (await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`)) || [];
  registry.prune(liveIds);

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
  registry.forget(candidates.map(c => c.entity_id));

  const remaining = await evaluate(`${apiPath}.getAllShapes().length`);
  return {
    success: true,
    scope: 'mcp',
    group: group || null,
    removed: removed.length,
    entity_ids: removed,
    remaining_shapes: remaining || 0,
    note: 'Only drawings created by this tool were removed.',
  };
}

/** Tracked groups, for "clear the ALGO plan"-style requests. */
export function listGroups() {
  return { success: true, groups: registry.groups(), store: registry.STORE_LOCATION };
}
