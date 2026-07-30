/**
 * WHICH levels to draw, once you already know which levels exist.
 *
 * `levels_find` answers "where has price reacted before". This answers the
 * separate question "which of those belong on the chart right now", and the two
 * were conflated: the tool ranked by `score` and took the top N, which produced
 * **six supports and no resistance** on a name sitting under overhead supply —
 * hiding the only levels that mattered for a position held at a loss.
 *
 * ── Why not rank by score ──
 *
 * `score` is driven by TEST COUNT, and this repo measured that touch count carries
 * no information about whether a level holds: the break hazard rises 4.5-21.2
 * points across real arms where a random walk rises 40.3. Ranking the display by it
 * is ranking by a known non-signal. Distance and side make no predictive claim at
 * all — they only say what is near and what is on each side of you.
 *
 * ── Why not filter by recency ──
 *
 * The obvious idea is "show only levels tested in the last quarter". Measured on
 * DLO: of 19 levels, **17 had been tested within 36 bars**, so a 63-bar cut removed
 * exactly 2 — and both were resistances, leaving 14 supports against 3. It made the
 * asymmetry worse. `bars_since_last_test` records when price last traded in the
 * band, and an active name revisits most of its range constantly. Recency is kept
 * here as an OPTIONAL cut, defaulted off, because it does discriminate on a name
 * that has trended away from an old range — just not on a rangebound one.
 *
 * ── The two filters that do work ──
 *
 * 1. A band scaled to ATR, not a fixed percentage. DLO runs 54% annualised vol;
 *    6% there is not the same market distance as 6% on a utility.
 * 2. A per-side quota, so resistance can never be drowned out by supports.
 *
 * Plus PINS: a level within a whisker of your stop, entry or target is always shown,
 * however far away it is. A filter that hides your own stop hides the decision.
 *
 * All pure.
 */

/**
 * The out-of-sample arm. `scripts/level-primary-holdout.js` re-measures it.
 *
 * The rule was derived from ONE chart on ONE day, which is exactly the mistake this
 * repo has made twice before — `level_pressure` went +39.1 to +4.6 on a holdout and
 * `stage_plan`'s gate forward-tested negative. So it was re-run on 20 large caps
 * across sectors, none of them DLO.
 *
 * It replicates, but read the reversals: 4 of 19 comparisons go the OTHER way, and
 * the mean is lifted by two large wins (SBUX +31.7/+28.3, PG +25.0). The sign test
 * is the number to quote, not the mean.
 *
 * This measures whether a level ACTS as a barrier — it is a description of what
 * price already did to it. It is NOT evidence the level will hold next time; that
 * is the touch-count claim, and touch count is dead here.
 */
export const PRIMARY_LEVEL_HOLDOUT = Object.freeze({
  claim: 'A level on the last confirmed swing extreme is traded through less often than the level '
    + 'nearest to price.',
  window_bars: 60,
  universe: '20 large caps across sectors, none of them DLO',
  comparisons: 19,
  symbols: 16,
  mean_edge_points: 7.98,
  favour_anchored: 15,
  favour_nearest: 4,
  sign_test_p: 0.0116,
  in_sample: 'DLO: three nearest levels traded through 16.7%, 16.7%, 21.7%; swing-anchored 0.0%',
  verdict: 'REPLICATES — the sign is consistent (p = 0.0116). But 4 of 19 reverse, so it is a display '
    + 'convention with an out-of-sample arm, not a law.',
  caveat: 'Describes what price did to the level. Says nothing about whether it holds next time.',
  script: 'scripts/level-primary-holdout.js',
});

/** Widening ladder for "show me the next ones". */
export const ATR_LADDER = Object.freeze([1.5, 3, 6]);

/**
 * Wilder's ATR, scalar, from normalised bars.
 *
 * A duplicate of `strategy.js`'s `atr` and deliberately so: `strategy.js` already
 * imports `structure.js`, and `structure.js` is the caller here, so importing it
 * back would close a cycle. Twelve lines of arithmetic is the cheaper price.
 */
export function atrFromBars(bars, length = 14) {
  if (!Array.isArray(bars) || bars.length < length + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i]; const p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  if (tr.length < length) return null;
  let a = tr.slice(0, length).reduce((x, y) => x + y, 0) / length;
  for (let i = length; i < tr.length; i += 1) a = (a * (length - 1) + tr[i]) / length;
  return a;
}

/** Defaults. The ATR multiple is the one knob worth turning. */
export const DISPLAY_DEFAULTS = Object.freeze({
  atr_multiple: 1.5,
  per_side: 3,
  pin_tolerance_pct: 1,
  fallback_band_pct: 6,
});

/** The next multiple out, for progressive disclosure. Returns null at the end. */
export function nextAtrMultiple(current) {
  const next = ATR_LADDER.find((m) => m > Number(current) + 1e-9);
  return next ?? null;
}

const pct = (from, to) => ((to - from) / from) * 100;

/**
 * Choose the levels to draw.
 *
 * `levels` is `levels_find().levels`. `pins` are prices that must survive the
 * filter — a stop, an entry, a target.
 *
 * Side is derived from the CURRENT price rather than taken from the level, because
 * a level flips as price crosses it: DLO's 14.68 was resistance at 14.59 and support
 * at 14.78, same line and same evidence. Where the stored side disagrees, the level
 * is flagged `side_flipped` rather than silently relabelled.
 */
/**
 * THE PRIMARY support and resistance: one each, anchored to the swing extremes.
 *
 * This replaced "nearest N per side", which has a defect that only shows when price
 * sits mid-range — and then shows badly. On DLO at 14.78 the three nearest levels
 * were 14.475, 14.68 and 14.84, and measured over the last 60 bars price traded
 * THROUGH them 16.7%, 16.7% and 21.7% of the time: the three worst on the chart.
 * They are not barriers, they are the congestion price is sitting inside. Proximity
 * selects chop by construction whenever spot is mid-range.
 *
 * What reads as primary are the RANGE BOUNDARIES — the levels sitting on the last
 * confirmed swing high and swing low. On DLO: 15.543 on the 15.51 swing high (0.0%
 * traded through in 60 bars, containment 1.000, nothing else on the chart matches
 * it) and 13.83 on the 13.83 swing low.
 *
 * So: anchor to structure, not to spot. Everything between price and the two
 * boundaries is INTERIOR and is not drawn — it is reported, so the omission is
 * visible rather than silent.
 *
 * `tier` walks OUTWARD: tier 1 is the boundaries, tier 2 the next level beyond each.
 * "Show me the next one" is tier + 1.
 */
export function selectPrimary(levels = [], {
  price, swing_high = null, swing_low = null, tier = 1, anchor_tolerance_pct = 3,
} = {}) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('selectPrimary needs the current price.');

  const finite = (levels || []).filter((l) => l && Number.isFinite(l.price));
  const above = finite.filter((l) => l.price >= price).sort((a, b) => a.price - b.price);
  const below = finite.filter((l) => l.price < price).sort((a, b) => b.price - a.price);

  /**
   * The level sitting ON a swing extreme, falling back to the nearest on that side —
   * and SAYING which. "Anchored to the swing high" and "nearest thing above price"
   * are very different claims and only one of them is structural.
   */
  const anchorTo = (candidates, swing, side) => {
    const word = side === 'resistance' ? 'high' : 'low';
    if (!candidates.length) return { level: null, basis: `no ${side} levels on this chart`, anchored: false };
    if (Number.isFinite(swing)) {
      const near = candidates
        .map((l) => ({ l, gap: Math.abs((l.price - swing) / swing) * 100 }))
        .filter((x) => x.gap <= anchor_tolerance_pct)
        .sort((a, b) => a.gap - b.gap)[0];
      if (near) {
        return {
          level: near.l, anchored: true,
          basis: `sits on the last swing ${word} (${swing}), ${near.gap.toFixed(2)}% away`,
        };
      }
    }
    return {
      level: candidates[0], anchored: false,
      basis: Number.isFinite(swing)
        ? `NOT anchored — nothing within ${anchor_tolerance_pct}% of the last swing ${word} (${swing}). `
          + `Fell back to the nearest ${side}, which is a weaker claim.`
        : `no swing ${word} available; using the nearest ${side}`,
    };
  };

  const r = anchorTo(above, swing_high, 'resistance');
  const s = anchorTo(below, swing_low, 'support');

  const outwardR = r.level ? above.filter((l) => l.price > r.level.price) : [];
  const outwardS = s.level ? below.filter((l) => l.price < s.level.price) : [];
  const step = Math.max(1, Math.floor(tier)) - 1;
  const pickR = step === 0 ? r.level : (outwardR[step - 1] ?? null);
  const pickS = step === 0 ? s.level : (outwardS[step - 1] ?? null);

  const shown = [];
  const add = (lvl, side, meta) => {
    if (!lvl) return;
    shown.push({
      ...lvl, side, role: step === 0 ? 'primary' : `tier ${tier}`,
      distance_pct: Number((((lvl.price - price) / price) * 100).toFixed(2)),
      ...(step === 0 ? { anchor: meta.basis, anchored: meta.anchored } : {}),
    });
  };
  add(pickR, 'resistance', r);
  add(pickS, 'support', s);

  const chosen = new Set(shown.map((l) => l.price));
  const isInterior = (l) => !chosen.has(l.price)
    && ((r.level && l.price >= price && l.price < r.level.price)
      || (s.level && l.price < price && l.price > s.level.price));

  const interior = finite.filter(isInterior).map((l) => ({
    price: l.price,
    distance_pct: Number((((l.price - price) / price) * 100).toFixed(2)),
    ...(Number.isFinite(l.through_pct) ? { traded_through_pct: l.through_pct } : {}),
    why: 'INTERIOR — between price and the boundary, so it sits inside the range rather than '
      + 'containing it. These are the levels price cuts through most.',
  }));

  const beyond = finite
    .filter((l) => !chosen.has(l.price) && !isInterior(l))
    .map((l) => ({
      price: l.price,
      distance_pct: Number((((l.price - price) / price) * 100).toFixed(2)),
      why: 'beyond the current tier — raise `tier` to walk out to it',
    }));

  return {
    shown,
    tier,
    interior,
    beyond,
    next_tier: (outwardR.length > step || outwardS.length > step) ? tier + 1 : null,
    tiers_available: { resistance: outwardR.length + 1, support: outwardS.length + 1 },
    swing_high,
    swing_low,
    ...(shown.some((l) => l.anchored === false) ? {
      anchor_warning: 'At least one side is NOT anchored to a swing extreme — read `anchor`. '
        + 'That is the nearest level, not a structural boundary.',
    } : {}),
    suppressed_note: `${interior.length} interior and ${beyond.length} further-out level(s) were found `
      + 'and NOT drawn. Listed rather than silently dropped.',
    method: 'Primary = the level sitting on the last confirmed swing extreme, because those bound the '
      + 'range. NOT the nearest level to price: when spot is mid-range the nearest levels are the '
      + 'congestion it sits in — on DLO those were traded through 17-22% of recent bars, the worst '
      + 'three on the chart.',
  };
}

export function selectForDisplay(levels = [], {
  price,
  atr = null,
  atr_multiple = DISPLAY_DEFAULTS.atr_multiple,
  per_side = DISPLAY_DEFAULTS.per_side,
  pins = [],
  pin_tolerance_pct = DISPLAY_DEFAULTS.pin_tolerance_pct,
  max_bars_since_test = null,
  fallback_band_pct = DISPLAY_DEFAULTS.fallback_band_pct,
} = {}) {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('selectForDisplay needs the current price to decide what is near it.');
  }

  // The band. ATR is preferred; without it, say which rule was actually used
  // rather than quietly applying a different one.
  const usingAtr = Number.isFinite(atr) && atr > 0;
  const bandAbs = usingAtr ? atr * atr_multiple : price * (fallback_band_pct / 100);
  const bandPct = (bandAbs / price) * 100;

  const pinList = (pins || [])
    .map((p) => (typeof p === 'object' ? p : { price: p }))
    .filter((p) => Number.isFinite(p.price));

  const annotated = (levels || [])
    .filter((l) => l && Number.isFinite(l.price))
    .map((l) => {
      const distance_pct = pct(price, l.price);
      const side = l.price >= price ? 'resistance' : 'support';
      const pinnedBy = pinList.filter(
        (p) => Math.abs(pct(p.price, l.price)) <= pin_tolerance_pct,
      );
      return {
        ...l,
        distance_pct: Number(distance_pct.toFixed(2)),
        distance_abs: Math.abs(l.price - price),
        side,
        ...(l.side && l.side !== side ? {
          side_flipped: true,
          side_was: l.side,
          flip_note: `Was ${l.side} when found; price has since crossed it.`,
        } : {}),
        ...(pinnedBy.length ? {
          pinned: true,
          pinned_by: pinnedBy.map((p) => p.label || `${p.price}`),
        } : {}),
      };
    });

  const staleCut = Number.isFinite(max_bars_since_test) && max_bars_since_test > 0;
  const isStale = (l) => staleCut
    && Number.isFinite(l.bars_since_last_test)
    && l.bars_since_last_test > max_bars_since_test;

  const shown = [];
  const suppressed = [];
  const shortfalls = [];

  for (const side of ['resistance', 'support']) {
    const onSide = annotated
      .filter((l) => l.side === side)
      .sort((a, b) => a.distance_abs - b.distance_abs);

    const eligible = onSide.filter((l) => l.distance_abs <= bandAbs && !isStale(l));
    const take = eligible.slice(0, per_side);
    shown.push(...take);

    for (const l of onSide) {
      if (take.includes(l)) continue;
      if (l.pinned) { shown.push(l); continue; }         // a pin beats every filter
      suppressed.push({
        price: l.price,
        side,
        distance_pct: l.distance_pct,
        why: isStale(l)
          ? `last tested ${l.bars_since_last_test} bars ago, beyond the ${max_bars_since_test}-bar cut`
          : l.distance_abs > bandAbs
            ? `${Math.abs(l.distance_pct).toFixed(2)}% away, outside the ${bandPct.toFixed(2)}% band`
            : `beyond the ${per_side}-per-side quota`,
      });
    }

    /**
     * A side with fewer than the quota is reported. "2 resistances shown" could
     * mean "filtered to 2" or "only 2 exist within reach", and those are
     * different facts about the chart.
     */
    if (eligible.length < per_side) {
      shortfalls.push({
        side,
        found: eligible.length,
        quota: per_side,
        note: onSide.length === 0
          ? `No ${side} levels at all on this chart.`
          : `Only ${eligible.length} ${side} level(s) inside the band — the quota of ${per_side} was not `
            + `a limit here. ${onSide.length - eligible.length} more exist further out.`,
      });
    }
  }

  shown.sort((a, b) => b.price - a.price);

  const counts = {
    resistance: shown.filter((l) => l.side === 'resistance').length,
    support: shown.filter((l) => l.side === 'support').length,
  };

  return {
    shown,
    suppressed,
    counts,
    pinned_count: shown.filter((l) => l.pinned).length,
    band: {
      atr: usingAtr ? atr : null,
      atr_multiple: usingAtr ? atr_multiple : null,
      band_abs: Number(bandAbs.toFixed(4)),
      band_pct: Number(bandPct.toFixed(2)),
      basis: usingAtr
        ? `${atr_multiple}x ATR (${atr}) = ${bandPct.toFixed(2)}% at ${price}`
        : `NO ATR SUPPLIED — fell back to a fixed ${fallback_band_pct}% band. `
          + 'A fixed percentage does not adjust for how volatile this symbol is.',
      atr_used: usingAtr,
    },
    ...(shortfalls.length ? { shortfalls } : {}),
    ...(suppressed.length ? {
      suppressed_note: `${suppressed.length} level(s) were found but NOT drawn. They are listed rather `
        + 'than silently dropped. Widen with a larger atr_multiple to see the next ones out.',
    } : {}),
    next_atr_multiple: nextAtrMultiple(atr_multiple),
    method: 'Nearest N per side inside an ATR-scaled band, with position-relevant levels pinned. '
      + 'Deliberately NOT ranked by score: score is driven by test count, and touch count was '
      + 'measured here to carry no information about whether a level holds.',
  };
}
