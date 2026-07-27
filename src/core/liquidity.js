/**
 * Anchored VWAP, fair value gaps, and equal highs/lows.
 *
 * Three things the VWAP and liquidity courses cover that were genuinely
 * missing. Most of the rest of both courses is already here under different
 * names — a "liquidity sweep" or "grab" is a failed break of a level, which is
 * wyckoff_spring and breakout_check; a "liquidity run" is a real breakout,
 * which breakout_check scores. Renaming those would add vocabulary, not
 * capability.
 *
 * What was actually absent:
 *
 *   1. VWAP anchored to an arbitrary bar, with standard-deviation bands.
 *      Session VWAP existed as a strategy operand; anchoring and bands did not.
 *   2. Fair value gaps — a three-bar imbalance, trivially computable.
 *   3. Equal highs and lows — where stops cluster, and the reason a level
 *      tested three times breaks harder than one tested once.
 *
 * The honesty problem specific to this material: fair value gaps occur
 * constantly. A chart has dozens. Reporting them without saying how many were
 * found lets a reader believe the one being shown is special, so the count and
 * the filtering are always returned.
 *
 * All pure.
 */
const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/* ---------------------------- anchored VWAP ---------------------------- */

/**
 * VWAP from an arbitrary starting bar, with standard-deviation bands.
 *
 * The anchor is the point of it. Session VWAP answers "what did today's
 * average buyer pay"; anchored from a major swing low or an earnings gap it
 * answers "what has everyone who bought since THAT moment paid" — which is the
 * question that makes the line behave like support or resistance.
 *
 * Bands are the volume-weighted standard deviation of price around the VWAP,
 * which is what TradingView plots. Roughly 68% of trade sits inside band 1,
 * 95% inside band 2, 99% inside band 3 — useful for spotting extension, and
 * not a rule.
 */
export function anchoredVwap(bars, { anchor_index = 0, bands = [1, 2, 3] } = {}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { available: false, note: 'No bars supplied.' };
  }
  const start = Math.max(0, Math.min(anchor_index, bars.length - 1));
  const slice = bars.slice(start);

  let pv = 0, vol = 0, pv2 = 0;
  const series = [];
  for (const b of slice) {
    const v = Number(b.volume);
    if (!Number.isFinite(v) || v <= 0) continue;
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * v;
    pv2 += typical * typical * v;
    vol += v;
    series.push({ time: b.time, vwap: pv / vol });
  }
  if (!(vol > 0) || !series.length) {
    return { available: false, note: 'No usable volume from the anchor onward — VWAP is undefined without it.' };
  }

  const vwap = pv / vol;
  // Volume-weighted variance, floored at zero against float noise.
  const variance = Math.max(0, pv2 / vol - vwap * vwap);
  const sd = Math.sqrt(variance);

  const last = slice[slice.length - 1];
  const bandLevels = bands.map((m) => ({
    multiple: m,
    upper: round(vwap + sd * m),
    lower: round(vwap - sd * m),
  }));

  // Which band the current price sits in — the extension read.
  let zone = `beyond ${bands[bands.length - 1]} sd`;
  for (const b of bandLevels) {
    if (last.close <= b.upper && last.close >= b.lower) { zone = `within ${b.multiple} sd`; break; }
  }

  return {
    available: true,
    vwap: round(vwap),
    std_dev: round(sd),
    bands: bandLevels,
    anchor_index: start,
    anchor_time: slice[0].time,
    bars_since_anchor: slice.length,
    price: round(last.close),
    price_vs_vwap: last.close > vwap ? 'above' : 'below',
    zone,
    control: last.close > vwap
      ? 'Price is above the anchored VWAP — buyers since the anchor are, on average, in profit and in control.'
      : 'Price is below the anchored VWAP — sellers since the anchor are in control.',
    caveat: 'VWAP is context, not a trigger. It says who is in control and where extension sits; it does not say when to act. A flat VWAP gives the weakest signals of all.',
  };
}

/* --------------------------- fair value gaps --------------------------- */

/**
 * Fair value gaps: a three-bar imbalance where bar 1 and bar 3 do not overlap.
 *
 * Bullish: bar 1's high is below bar 3's low — price moved up so fast it left
 * a band nothing traded in. Bearish is the mirror.
 *
 * These occur constantly, which is the whole problem with them. A `min_size_pct`
 * filter is applied and the number filtered out is reported, so nobody mistakes
 * a returned gap for a rare event. `filled` marks the ones price has already
 * traded back through — those are spent.
 */
export function fairValueGaps(bars, { min_size_pct = 0.1, max_age_bars = 60, include_filled = false } = {}) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return { gaps: [], note: 'Need at least three bars to form a gap.' };
  }

  const all = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], c = bars[i];
    const bullish = a.high < c.low;
    const bearish = a.low > c.high;
    if (!bullish && !bearish) continue;

    const top = bullish ? c.low : a.low;
    const bottom = bullish ? a.high : c.high;
    const sizePct = ((top - bottom) / bottom) * 100;

    // Filled once any LATER bar trades back into the gap.
    const after = bars.slice(i + 1);
    const filled = after.some((b) => b.low <= top && b.high >= bottom);

    all.push({
      direction: bullish ? 'bullish' : 'bearish',
      top: round(top), bottom: round(bottom),
      midpoint: round((top + bottom) / 2),
      size_pct: round(sizePct, 3),
      index: i, time: c.time,
      bars_ago: bars.length - 1 - i,
      filled,
    });
  }

  const bigEnough = all.filter((g) => g.size_pct >= min_size_pct);
  const recent = bigEnough.filter((g) => g.bars_ago <= max_age_bars);
  const open = include_filled ? recent : recent.filter((g) => !g.filled);

  return {
    gaps: open.sort((a, b) => a.bars_ago - b.bars_ago),
    total_found: all.length,
    filtered_too_small: all.length - bigEnough.length,
    filtered_too_old: bigEnough.length - recent.length,
    ...(include_filled ? {} : { filtered_already_filled: recent.length - open.length }),
    reality_check: `Fair value gaps are common — ${all.length} exist in these ${bars.length} bars before filtering. Their frequency is why they mean little on their own; treat one as a reaction zone only when it lines up with a level price has actually tested.`,
  };
}

/* -------------------------- equal highs and lows ------------------------ */

/**
 * Equal highs and equal lows — where stop orders cluster.
 *
 * Two or more swing points at effectively the same price. The mechanism is
 * simple and is the useful part: after the first rejection, traders place
 * stops beyond that high. After the second, more traders see a double top and
 * place stops in the same place. The pool deepens with each touch, which is
 * why a level tested three times breaks harder than one tested once — the
 * break itself triggers the stops that fuel it.
 *
 * Takes swings from the caller so it agrees with structure_analyze rather than
 * detecting its own.
 */
export function equalHighsLows(swings, currentPrice, { tolerance_pct = 0.15, min_touches = 2 } = {}) {
  if (!Array.isArray(swings) || swings.length < 2) {
    return { pools: [], note: 'Fewer than two swings — nothing to cluster.' };
  }

  const cluster = (kind) => {
    const pts = swings.filter((s) => s.kind === kind).sort((a, b) => a.price - b.price);
    const groups = [];
    for (const p of pts) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(p.price - g.mean) / g.mean * 100 <= tolerance_pct) {
        g.points.push(p);
        g.mean = g.points.reduce((s, x) => s + x.price, 0) / g.points.length;
      } else {
        groups.push({ points: [p], mean: p.price });
      }
    }
    return groups.filter((g) => g.points.length >= min_touches);
  };

  const pools = [];
  for (const kind of ['high', 'low']) {
    for (const g of cluster(kind)) {
      const price = g.mean;
      const touches = g.points.length;
      pools.push({
        kind: kind === 'high' ? 'equal_highs' : 'equal_lows',
        price: round(price),
        touches,
        spread_pct: round((Math.max(...g.points.map((p) => p.price)) - Math.min(...g.points.map((p) => p.price))) / price * 100, 3),
        stops_rest: kind === 'high' ? 'above' : 'below',
        side: Number.isFinite(currentPrice) ? (price > currentPrice ? 'above price' : 'below price') : null,
        // Each additional touch adds another cohort of stops in the same place.
        depth: touches >= 4 ? 'deep' : touches === 3 ? 'moderate' : 'shallow',
        meaning: kind === 'high'
          ? `${touches} swing highs at effectively one price. Stops from short positions rest just above, so a break through it triggers buying that fuels the break.`
          : `${touches} swing lows at effectively one price. Stops from long positions rest just below, so a break through it triggers selling that fuels the break.`,
      });
    }
  }

  pools.sort((a, b) => b.touches - a.touches);

  return {
    pools,
    tolerance_pct,
    ...(pools.length ? {} : { note: 'No swing points cluster within the tolerance. Widen tolerance_pct if the chart looks like it should have some.' }),
    caveat: 'Where stops rest is an inference from where traders conventionally place them, not observed order data. It is a plausible mechanism, not a measurement.',
  };
}
