/**
 * TradingView's native Long/Short Position tool.
 *
 * This is the drawing traders actually use to plan a trade: a shaded risk box
 * and reward box with entry, stop and target, and a position size TradingView
 * computes itself from account size and risk percent.
 *
 * Two things it gives that draw_trade_plan's horizontal lines cannot:
 *   - the user can drag it, and the sizing recalculates live
 *   - a plan the user drew by hand can be read back and evaluated
 *
 * The awkward part is the encoding. `stopLevel` and `profitLevel` are NOT
 * prices — they are offsets from entry measured in minimum ticks. Verified on a
 * live chart: entry 561.19, stopLevel 6239, minTick 0.01 → stop 498.80, and
 * TradingView's own qty (0.7213) equals (accountSize 150 × risk 30%) /
 * (6239 × 0.01). Everything here converts through that.
 */
import { evaluate, getChartApi, KNOWN_PATHS } from '../connection.js';
import * as registry from './drawing_registry.js';
import { sizeWithConstraints } from './risk.js';

const POSITION_SHAPES = { long: 'long_position', short: 'short_position' };

/** Minimum price increment for the current symbol — the unit stop/profit levels are in. */
export async function getMinTick() {
  const t = await evaluate(`
    (function() {
      try {
        var s = ${KNOWN_PATHS.chartApi}._chartWidget.model().mainSeries().symbolInfo();
        var tick = s.minmov / s.pricescale;
        return (tick && isFinite(tick)) ? tick : null;
      } catch (e) { return null; }
    })()
  `);
  if (!t) throw new Error('Could not read the symbol tick size, so position levels cannot be converted.');
  return t;
}

/**
 * Draw a Long/Short Position tool.
 *
 * Prices in, tick offsets out. Account size and risk are handed to TradingView
 * so it computes the quantity itself, which keeps the displayed size honest if
 * the user later drags the stop.
 */
export async function drawPosition({
  direction,
  entry,
  stop,
  target,
  account_size,
  risk_percent,
  time,
  group,
} = {}) {
  const dir = String(direction || '').toLowerCase();
  const shape = POSITION_SHAPES[dir];
  if (!shape) throw new Error('direction must be "long" or "short".');

  const entryPrice = Number(entry);
  const stopPrice = Number(stop);
  const targetPrice = Number(target);
  if (!Number.isFinite(entryPrice)) throw new Error('entry must be a number.');
  if (!Number.isFinite(stopPrice)) throw new Error('stop must be a number.');
  if (!Number.isFinite(targetPrice)) throw new Error('target must be a number.');

  // Reject a plan that contradicts its own direction before it reaches the
  // chart — the tool will happily render a nonsensical one.
  if (dir === 'long' && stopPrice >= entryPrice) {
    throw new Error(`Long position needs its stop below entry (got stop ${stopPrice}, entry ${entryPrice}).`);
  }
  if (dir === 'long' && targetPrice <= entryPrice) {
    throw new Error(`Long position needs its target above entry (got target ${targetPrice}, entry ${entryPrice}).`);
  }
  if (dir === 'short' && stopPrice <= entryPrice) {
    throw new Error(`Short position needs its stop above entry (got stop ${stopPrice}, entry ${entryPrice}).`);
  }
  if (dir === 'short' && targetPrice >= entryPrice) {
    throw new Error(`Short position needs its target below entry (got target ${targetPrice}, entry ${entryPrice}).`);
  }

  const minTick = await getMinTick();
  const stopTicks = Math.round(Math.abs(entryPrice - stopPrice) / minTick);
  const profitTicks = Math.round(Math.abs(targetPrice - entryPrice) / minTick);
  if (!stopTicks) throw new Error('Stop is the same as entry — risk would be zero.');

  const drawing = await import('./drawing.js');
  const apiPath = await getChartApi();
  const anchorTime = await drawing.resolveTime(time);

  const overrides = {
    stopLevel: stopTicks,
    profitLevel: profitTicks,
    showPriceLabels: true,
    riskDisplayMode: 'percents',
  };
  if (Number.isFinite(Number(account_size)) && Number(account_size) > 0) {
    overrides.accountSize = Number(account_size);
  }
  if (Number.isFinite(Number(risk_percent)) && Number(risk_percent) > 0) {
    overrides.risk = Number(risk_percent);
  }

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
  await evaluate(`
    ${apiPath}.createShape(
      { time: ${anchorTime}, price: ${entryPrice} },
      { shape: ${JSON.stringify(shape)}, overrides: ${JSON.stringify(overrides)} }
    )
  `);
  await new Promise((r) => setTimeout(r, 400));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
  const entity_id = (after || []).find((id) => !(before || []).includes(id)) || null;

  if (!entity_id) {
    throw new Error('Created the position tool but could not identify it on the chart.');
  }

  const groupName = group || `position-${dir}-${entryPrice}`;
  registry.record([{ entity_id, shape, role: 'position' }], { group: groupName });

  // Read back what TradingView actually stored, including the quantity it
  // computed. Reporting the requested values instead would hide a rounding
  // difference or a rejected override.
  const actual = await readPosition({ entity_id }).catch(() => null);

  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);

  return {
    success: true,
    entity_id,
    group: groupName,
    direction: dir,
    entry: entryPrice,
    stop: stopPrice,
    target: targetPrice,
    risk_per_unit: Math.round(risk * 1e8) / 1e8,
    rr: Math.round((reward / risk) * 100) / 100,
    min_tick: minTick,
    ticks: { stop: stopTicks, profit: profitTicks },
    ...(actual ? { as_drawn: { entry: actual.entry, stop: actual.stop, target: actual.target, qty: actual.qty } } : {}),
    ...(overrides.accountSize ? { sizing: { account_size: overrides.accountSize, risk_percent: overrides.risk, qty: actual?.qty ?? null } } : {}),
    note: 'Position size is computed by TradingView from account size and risk, so it stays correct if the tool is dragged. Arithmetic on levels you supplied — not advice.',
    clear_hint: `Remove with draw_clear group="${groupName}".`,
  };
}

/** Convert one position shape into plain prices. */
async function describe(apiPath, id, minTick) {
  const raw = await evaluate(`
    (function() {
      var c = ${apiPath};
      var s = c.getShapeById(${JSON.stringify(id)});
      if (!s) return null;
      var pts = null, p = {};
      try { pts = s.getPoints(); } catch (e) {}
      try { p = s.getProperties() || {}; } catch (e) {}
      var name = null;
      var all = c.getAllShapes();
      for (var i = 0; i < all.length; i++) if (all[i].id === ${JSON.stringify(id)}) { name = all[i].name; break; }
      return {
        name: name,
        entry: pts && pts[0] ? pts[0].price : null,
        time: pts && pts[0] ? pts[0].time : null,
        stopLevel: p.stopLevel, profitLevel: p.profitLevel,
        qty: p.qty, accountSize: p.accountSize, risk: p.risk, lotSize: p.lotSize,
      };
    })()
  `);
  if (!raw || !raw.name) return null;

  const isLong = /long/i.test(raw.name);
  const entry = Number(raw.entry);
  const stopOffset = Number(raw.stopLevel) * minTick;
  const profitOffset = Number(raw.profitLevel) * minTick;

  const stop = isLong ? entry - stopOffset : entry + stopOffset;
  const target = isLong ? entry + profitOffset : entry - profitOffset;
  const round = (n) => Math.round(n * 1e8) / 1e8;

  return {
    entity_id: id,
    direction: isLong ? 'long' : 'short',
    entry: round(entry),
    stop: round(stop),
    target: round(target),
    risk_per_unit: round(Math.abs(entry - stop)),
    rr: stopOffset ? Math.round((profitOffset / stopOffset) * 100) / 100 : null,
    qty: raw.qty ?? null,
    account_size: raw.accountSize ?? null,
    risk_percent: raw.risk ?? null,
    anchor_time: raw.time ?? null,
  };
}

/**
 * Read position tools off the chart as plain prices.
 *
 * This is what makes "look at the trade I drew and tell me what it implies"
 * work — the levels are otherwise stored as tick offsets that mean nothing
 * without the symbol's tick size.
 */
export async function readPosition({ entity_id } = {}) {
  const apiPath = await getChartApi();
  const minTick = await getMinTick();

  if (entity_id) {
    const one = await describe(apiPath, entity_id, minTick);
    if (!one) throw new Error(`No position tool with id ${entity_id} on this chart.`);
    return { success: true, min_tick: minTick, ...one };
  }

  const ids = await evaluate(`
    ${apiPath}.getAllShapes()
      .filter(function(s) { return /position/i.test(s.name); })
      .map(function(s) { return s.id; })
  `);

  const positions = [];
  for (const id of ids || []) {
    const d = await describe(apiPath, id, minTick);
    if (d) positions.push(d);
  }

  const tracked = new Set(registry.list().map((e) => e.entity_id));
  for (const p of positions) p.created_by_mcp = tracked.has(p.entity_id);

  return {
    success: true,
    count: positions.length,
    min_tick: minTick,
    positions,
    ...(positions.length ? {} : { note: 'No Long/Short Position tools on this chart. Draw one, or use draw_position.' }),
  };
}

/**
 * Position size for a trade drawn on the chart.
 *
 * The video-workflow case: the user has drawn a position tool, and wants to
 * know how much to buy for a given account and risk. Reports TradingView's own
 * qty alongside, so a mismatch with the tool's configured account size is
 * visible rather than silently different.
 */
export async function sizePosition({
  entity_id, account_size, risk_percent,
  adv = null, max_position_pct, max_adv_pct,
} = {}) {
  const read = await readPosition({ entity_id });
  const pos = entity_id ? read : (read.positions || [])[0];
  if (!pos) throw new Error('No position tool on the chart to size. Draw one, or pass entity_id.');
  if (read.count > 1 && !entity_id) {
    throw new Error(`${read.count} position tools on the chart — pass entity_id to say which one. Use position_read to list them.`);
  }

  const acct = Number(account_size);
  const pct = Number(risk_percent);
  if (!Number.isFinite(acct) || acct <= 0) throw new Error('account_size must be a positive number.');
  if (!Number.isFinite(pct) || pct <= 0) throw new Error('risk_percent must be a positive number.');

  const riskAmount = acct * (pct / 100);
  const perUnit = pos.risk_per_unit;
  if (!perUnit) throw new Error('The position tool has no distance between entry and stop, so size is undefined.');

  // The risk budget alone is not the answer. A tighter stop buys MORE shares
  // under fixed risk, so a good entry is exactly when the concentration cap
  // binds — Shannon's own example turns a 1% budget into 65% of the account.
  // sizeWithConstraints returns the MINIMUM across constraints and names which.
  const constrained = sizeWithConstraints({
    account_size: acct,
    risk_percent: pct,
    entry: pos.entry,
    stop: pos.stop,
    adv,
    ...(max_position_pct !== undefined ? { max_position_pct } : {}),
    ...(max_adv_pct !== undefined ? { max_adv_pct } : {}),
  });

  const qty = constrained.available ? constrained.shares : riskAmount / perUnit;
  const notional = qty * pos.entry;

  return {
    success: true,
    entity_id: pos.entity_id,
    direction: pos.direction,
    entry: pos.entry,
    stop: pos.stop,
    target: pos.target,
    rr: pos.rr,
    account_size: acct,
    risk_percent: pct,
    risk_amount: Math.round(riskAmount * 100) / 100,
    risk_per_unit: perUnit,
    quantity: Math.round(qty * 1e8) / 1e8,
    notional: Math.round(notional * 100) / 100,
    notional_pct_of_account: Math.round((notional / acct) * 1000) / 10,
    ...(constrained.available
      ? {
          binding_constraint: constrained.binding_constraint,
          constraints: constrained.constraints,
          why: constrained.why,
          ...(constrained.risk_budget_would_have_bought
            ? { risk_budget_would_have_bought: constrained.risk_budget_would_have_bought }
            : {}),
          ...(constrained.liquidity_constraint ? { liquidity_constraint: constrained.liquidity_constraint } : {}),
          ...(constrained.pct_of_adv !== undefined ? { pct_of_adv: constrained.pct_of_adv } : {}),
        }
      : {}),
    tool_qty: pos.qty,
    tool_account_size: pos.account_size,
    ...(pos.account_size && Math.abs(pos.account_size - acct) > 0.01
      ? { mismatch: `The drawing is configured for an account size of ${pos.account_size}, not ${acct}. Its displayed quantity reflects the drawing, not this calculation.` }
      : {}),
    note: 'Arithmetic on the levels drawn and the risk supplied. Not advice, and it places no order.',
  };
}
