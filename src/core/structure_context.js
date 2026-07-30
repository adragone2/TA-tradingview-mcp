/**
 * The structure operands `strategy.js` declares but cannot derive itself.
 *
 * `buildContext` accepts a `structure` object and leaves `pullback_pct`,
 * `nearest_level_tests`, `nearest_level_distance_pct`, `in_demand_zone`,
 * `in_supply_zone` and `nearest_zone_distance_pct` null when it is absent —
 * correctly, since those come from level and zone detection rather than from a
 * moving average.
 *
 * The problem was that nothing ever built it. `strategy_check` and
 * `strategy_scan` never passed one, so any criterion using those operands came
 * back UNKNOWN forever, and a strategy containing one could never pass. Five of
 * the catalogue's strategies use them.
 *
 * This computes them from the same bars, using the same detectors the rest of
 * the toolchain uses, so a criterion says the same thing here as `levels_find`
 * and `zones_find` would say on their own.
 *
 * Pure — bars in, operand values out.
 */
import { findSwings, alternateSwings, findKeyLevels } from './structure.js';
import { findZones } from './zones.js';

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * @param {Array} bars normalised OHLCV
 * @param {object} opts
 * @param {number} opts.lookback swing sensitivity, matched to levels_find's default
 */
export function buildStructureContext(bars, { lookback = 5, tolerance_pct = 0.75 } = {}) {
  if (!Array.isArray(bars) || bars.length < lookback * 2 + 10) {
    return {
      available: false,
      note: `Need at least ${lookback * 2 + 10} bars for structure operands; got ${bars?.length || 0}. `
        + 'Criteria using them will be UNKNOWN, which is correct — not a fail.',
    };
  }

  const price = bars[bars.length - 1].close;

  /**
   * pullback_pct — how far price has retraced from the most recent swing HIGH,
   * as a positive percentage. This is the definition a pullback entry means:
   * "how deep is the dip", not "how far from any extreme".
   */
  const swings = alternateSwings(findSwings(bars, { lookback }));
  const lastHigh = [...swings].reverse().find((s) => s.kind === 'high');
  const pullbackPct = lastHigh && lastHigh.price > 0
    ? round(((lastHigh.price - price) / lastHigh.price) * 100, 3)
    : null;

  // Levels, then the nearest one on either side of price.
  let levels = [];
  try {
    const found = findKeyLevels(bars, { lookback, tolerance_pct, min_touches: 2, max_levels: 20 });
    levels = found?.levels || [];
  } catch { levels = []; }

  let nearest = null;
  for (const lvl of levels) {
    const at = Number(lvl.price ?? ((Number(lvl.high) + Number(lvl.low)) / 2));
    if (!Number.isFinite(at)) continue;
    const distPct = Math.abs((at - price) / price) * 100;
    if (!nearest || distPct < nearest.distance_pct) {
      nearest = { price: at, distance_pct: distPct, tests: Number(lvl.tests ?? lvl.touches ?? 0) };
    }
  }

  // Zones, and whether price is inside one right now.
  let zones = [];
  try {
    const z = findZones(bars, { lookback });
    zones = z?.zones || [];
  } catch { zones = []; }

  let inDemand = 0; let inSupply = 0; let nearestZonePct = null;
  for (const z of zones) {
    const top = Number(z.top); const bottom = Number(z.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
    const inside = price <= top && price >= bottom;
    if (inside) {
      if (z.kind === 'demand') inDemand = 1;
      if (z.kind === 'supply') inSupply = 1;
    }
    const dist = inside ? 0 : Math.min(Math.abs(top - price), Math.abs(bottom - price)) / price * 100;
    if (nearestZonePct === null || dist < nearestZonePct) nearestZonePct = dist;
  }

  return {
    available: true,
    // The six operand values, named exactly as buildContext reads them.
    pullback_pct: pullbackPct,
    nearest_level_tests: nearest ? nearest.tests : null,
    nearest_level_distance_pct: nearest ? round(nearest.distance_pct, 3) : null,
    in_demand_zone: inDemand,
    in_supply_zone: inSupply,
    nearest_zone_distance_pct: round(nearestZonePct, 3),
    // Provenance, so a caller can see where each number came from.
    derived_from: {
      swings: swings.length,
      last_swing_high: lastHigh ? round(lastHigh.price, 6) : null,
      levels_found: levels.length,
      nearest_level: nearest ? round(nearest.price, 6) : null,
      zones_found: zones.length,
      lookback,
    },
    note: 'in_demand_zone and in_supply_zone are 1/0 rather than true/false, because criteria compare numbers. '
      + 'A zone alone has a 99.5% noise floor — use it for confluence, never on its own.',
  };
}
