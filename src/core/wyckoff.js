/**
 * Wyckoff: phases, springs and upthrusts, effort vs result, cause and effect.
 *
 * The method is a century old and mostly interpretive — two analysts routinely
 * label the same chart differently, and the course this was built from names
 * the failure mode itself: once you learn the framework you start finding
 * accumulation ranges everywhere. So everything here is built to resist that:
 *
 *   - A phase is only claimed when a RANGE actually exists by measurement,
 *     and the evidence for the label is returned alongside it.
 *   - A spring is not a wick below support. It is a close back INSIDE the
 *     range after trading below it. Unconfirmed candidates are reported
 *     separately and never as setups.
 *   - No performance statistics are attached, because none of the Bulkowski
 *     kind exist for these. Reliability here is unmeasured and says so.
 *
 * Effort vs result is the part that most deserves to be code: volume is
 * "effort", price movement is "result", and the four combinations of the two
 * are a clean 2x2 that people otherwise eyeball.
 *
 * All pure: bars in, findings out.
 */
import { findSwings, alternateSwings } from './structure.js';
import { regime } from './context.js';

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/* --------------------------- effort vs result -------------------------- */

/**
 * Wyckoff's third law, as a 2x2.
 *
 * Effort is volume, result is price movement. When they agree the move is
 * supported; when they diverge somebody is doing a lot of work for very little
 * ground, which is the classic warning.
 *
 *   price up   + volume up    -> bullish  (convergence)
 *   price up   + volume down  -> bearish  (divergence — rally on no participation)
 *   price down + volume down  -> bullish  (divergence — selling is drying up)
 *   price down + volume up    -> bearish  (convergence)
 */
export function effortVsResult(bars, { window = 10, baseline = 30 } = {}) {
  if (bars.length < window + baseline) {
    return { available: false, note: `Need at least ${window + baseline} bars; got ${bars.length}.` };
  }
  const recent = bars.slice(-window);
  const prior = bars.slice(-(window + baseline), -window);

  const priceChange = ((recent[recent.length - 1].close - recent[0].open) / recent[0].open) * 100;
  const recentVol = mean(recent.map((b) => Number(b.volume) || 0));
  const priorVol = mean(prior.map((b) => Number(b.volume) || 0));
  if (!(priorVol > 0)) return { available: false, note: 'No usable volume to compare against.' };

  const volRatio = recentVol / priorVol;
  const priceUp = priceChange > 0;
  const volUp = volRatio > 1.1;
  const volDown = volRatio < 0.9;

  let verdict, kind, meaning;
  if (priceUp && volUp) {
    verdict = 'bullish'; kind = 'convergence';
    meaning = 'Price rising on rising volume — effort and result agree, and the advance is supported.';
  } else if (priceUp && volDown) {
    verdict = 'bearish'; kind = 'divergence';
    meaning = 'Price rising on FALLING volume — a rally that fewer and fewer participants are backing. Classic exhaustion warning.';
  } else if (!priceUp && volDown) {
    verdict = 'bullish'; kind = 'divergence';
    meaning = 'Price falling on FALLING volume — selling pressure is drying up rather than intensifying.';
  } else if (!priceUp && volUp) {
    verdict = 'bearish'; kind = 'convergence';
    meaning = 'Price falling on rising volume — effort and result agree, and the decline is supported.';
  } else {
    verdict = 'neutral'; kind = 'inconclusive';
    meaning = 'Volume is close to its recent average, so it neither confirms nor contradicts the price move.';
  }

  return {
    available: true,
    verdict, kind,
    price_change_pct: round(priceChange, 2),
    volume_vs_prior: round(volRatio, 2),
    window, baseline,
    meaning,
    caveat: 'Effort vs result is a bias, not a signal. It says whether a move is backed by participation — not when to act on it.',
  };
}

/* ------------------------------- phases -------------------------------- */

/**
 * Which Wyckoff phase, if any.
 *
 * A phase is only claimed when the measurements support it. A "range" needs to
 * actually be sideways — checked with the efficiency ratio, not by eye — and
 * accumulation vs distribution is decided by what came BEFORE the range, since
 * that is the only thing separating them.
 *
 * Returns `unclear` freely. Most charts are not in a clean Wyckoff phase, and
 * claiming one anyway is the mistake the method is most often used to make.
 */
export function classifyPhase(bars, { range_window = 40, prior_window = 40, flat_efficiency = 0.3 } = {}) {
  if (bars.length < range_window + prior_window) {
    return { phase: 'unclear', note: `Need at least ${range_window + prior_window} bars to judge a phase; got ${bars.length}.` };
  }

  const recent = bars.slice(-range_window);
  const prior = bars.slice(-(range_window + prior_window), -range_window);

  const recentRegime = regime(recent, { window: range_window });
  const priorFirst = prior[0].close, priorLast = prior[prior.length - 1].close;
  const priorChange = ((priorLast - priorFirst) / priorFirst) * 100;

  const high = Math.max(...recent.map((b) => b.high));
  const low = Math.min(...recent.map((b) => b.low));
  const rangePct = ((high - low) / low) * 100;

  const isRange = recentRegime.efficiency != null && recentRegime.efficiency < flat_efficiency;
  const evidence = {
    recent_efficiency: recentRegime.efficiency,
    recent_regime: recentRegime.regime,
    prior_move_pct: round(priorChange, 2),
    range_high: round(high, 6),
    range_low: round(low, 6),
    range_width_pct: round(rangePct, 2),
  };

  if (isRange) {
    if (priorChange < -5) {
      return {
        phase: 'accumulation', evidence,
        why: 'Price is moving sideways (low efficiency) after a decline. In Wyckoff terms this is where large operators absorb supply at low prices.',
        watch_for: 'A SPRING — a dip below range support that closes back inside. That is the method\'s primary long entry.',
        confidence: 'interpretive',
      };
    }
    if (priorChange > 5) {
      return {
        phase: 'distribution', evidence,
        why: 'Price is moving sideways after an advance — the topping process, where large operators distribute into strength.',
        watch_for: 'An UPTHRUST — a poke above range resistance that closes back inside. That is the method\'s primary short entry.',
        confidence: 'interpretive',
      };
    }
    return {
      phase: 'range', evidence,
      why: 'Sideways, but the prior move was not decisive enough to call it accumulation or distribution. Those two differ ONLY by what preceded them.',
      confidence: 'interpretive',
    };
  }

  const trendUp = recentRegime.direction === 'up';
  return {
    phase: trendUp ? 'markup' : 'markdown',
    evidence,
    why: trendUp
      ? 'Price is trending up with reasonable efficiency — the markup phase.'
      : 'Price is trending down with reasonable efficiency — the markdown phase.',
    confidence: 'interpretive',
    note: 'Trends can contain re-accumulation or re-distribution ranges. A pause inside a trend is not automatically the next phase.',
  };
}

/* ------------------------ springs and upthrusts ------------------------ */

/**
 * Springs and upthrusts: false breaks of a range boundary that get reclaimed.
 *
 * The definition that matters: price must trade BEYOND the boundary and then
 * CLOSE back inside. A wick below support with a close still below is not a
 * spring, it is a breakdown — and treating the two the same is how people buy
 * straight into a decline.
 *
 * Candidates that traded through but did not close back inside are returned
 * separately as `unconfirmed`, never mixed in with the real ones.
 */
export function findSpringsUpthrusts(bars, {
  range_window = 40,
  lookback = 3,
  min_penetration_pct = 0.05,
  confirm_within = 2,
} = {}) {
  if (bars.length < range_window + 5) {
    return { springs: [], upthrusts: [], note: 'Not enough bars to define a range and test it.' };
  }

  // The range is defined from the swing structure of the window, not from the
  // absolute extremes — an absolute high/low set BY the spring itself would
  // make the spring impossible to detect.
  const window = bars.slice(-range_window);
  const swings = alternateSwings(findSwings(window, { lookback }));
  const highs = swings.filter((s) => s.kind === 'high').map((s) => s.price);
  const lows = swings.filter((s) => s.kind === 'low').map((s) => s.price);
  if (highs.length < 2 || lows.length < 2) {
    return { springs: [], upthrusts: [], note: 'Fewer than two swing highs and two swing lows — no range boundaries to test.' };
  }

  // Use the median swing extreme so one outlier does not define the boundary.
  const support = [...lows].sort((a, b) => a - b)[Math.floor(lows.length / 2)];
  const resistance = [...highs].sort((a, b) => a - b)[Math.floor(highs.length / 2)];
  if (!(resistance > support)) {
    return { springs: [], upthrusts: [], note: 'Range boundaries are inverted or identical.' };
  }

  const avgVol = mean(window.map((b) => Number(b.volume) || 0));
  const springs = [], upthrusts = [], unconfirmed = [];

  for (let i = 0; i < window.length; i++) {
    const b = window[i];
    const later = window.slice(i + 1, i + 1 + confirm_within);

    // Spring: traded below support, then a close back inside within a bar or two.
    const belowBy = ((support - b.low) / support) * 100;
    if (belowBy >= min_penetration_pct) {
      const reclaimed = b.close > support || later.some((x) => x.close > support);
      const entry = {
        type: 'spring', index: i, time: b.time,
        support: round(support, 6),
        low: round(b.low, 6),
        penetration_pct: round(belowBy, 3),
        close: round(b.close, 6),
        volume_vs_avg: avgVol > 0 ? round((Number(b.volume) || 0) / avgVol, 2) : null,
      };
      if (reclaimed) {
        springs.push({
          ...entry,
          direction: 'bullish',
          stop_below: round(b.low, 6),
          target_range_high: round(resistance, 6),
          meaning: 'Price traded below range support and closed back inside — a failed breakdown that trapped sellers.',
        });
      } else {
        unconfirmed.push({ ...entry, why_not: 'Price traded below support but did not close back inside. That is a breakdown, not a spring.' });
      }
    }

    // Upthrust: mirror image at the top of the range.
    const aboveBy = ((b.high - resistance) / resistance) * 100;
    if (aboveBy >= min_penetration_pct) {
      const rejected = b.close < resistance || later.some((x) => x.close < resistance);
      const entry = {
        type: 'upthrust', index: i, time: b.time,
        resistance: round(resistance, 6),
        high: round(b.high, 6),
        penetration_pct: round(aboveBy, 3),
        close: round(b.close, 6),
        volume_vs_avg: avgVol > 0 ? round((Number(b.volume) || 0) / avgVol, 2) : null,
      };
      if (rejected) {
        upthrusts.push({
          ...entry,
          direction: 'bearish',
          stop_above: round(b.high, 6),
          target_range_low: round(support, 6),
          meaning: 'Price poked above range resistance and closed back inside — a failed breakout that trapped buyers.',
        });
      } else {
        unconfirmed.push({ ...entry, why_not: 'Price traded above resistance but did not close back inside. That is a breakout, not an upthrust.' });
      }
    }
  }

  const bars_ago = (e) => window.length - 1 - e.index;
  return {
    range: { support: round(support, 6), resistance: round(resistance, 6), width_pct: round(((resistance - support) / support) * 100, 2) },
    springs: springs.map((s) => ({ ...s, bars_ago: bars_ago(s) })),
    upthrusts: upthrusts.map((u) => ({ ...u, bars_ago: bars_ago(u) })),
    ...(unconfirmed.length ? { unconfirmed: unconfirmed.map((u) => ({ ...u, bars_ago: bars_ago(u) })) } : {}),
    method: 'Range boundaries come from the median swing high and low of the window, so a single spike cannot define them. A spring or upthrust requires a CLOSE back inside the range.',
    ...(springs.length || upthrusts.length
      ? { reminder: 'Confirm with something independent before acting — a reversal candle on the reclaim, or volume. The method itself says a spring alone is not the trade.' }
      : {}),
  };
}

/* --------------------------- cause and effect --------------------------- */

/**
 * Wyckoff's second law: the longer the base, the larger the move that follows.
 *
 * Projected as the range width applied from the breakout boundary, scaled by
 * how long the range lasted. This is the least defensible of the three laws —
 * it is a rule of thumb with no measured support here — so the projection is
 * returned as a hypothesis with its own arithmetic exposed, not as a target.
 */
export function causeAndEffect(bars, { range_window = 40, lookback = 3 } = {}) {
  const sp = findSpringsUpthrusts(bars, { range_window, lookback });
  if (!sp.range) return { available: false, note: sp.note || 'No range to measure.' };

  const { support, resistance } = sp.range;
  const width = resistance - support;
  const window = bars.slice(-range_window);

  // How many bars price actually spent inside the boundaries — the "cause".
  const inside = window.filter((b) => b.close >= support && b.close <= resistance).length;
  const durationRatio = inside / window.length;

  return {
    available: true,
    range: sp.range,
    bars_in_range: inside,
    duration_ratio: round(durationRatio, 2),
    projections: {
      upside: round(resistance + width, 6),
      downside: round(support - width, 6),
    },
    basis: 'Range width projected from the boundary that breaks. The "longer base, larger move" idea scales this with duration, but by how much is not defined by the method.',
    caveat: 'Unlike classical chart patterns, this projection has NO measured success rate behind it. Treat it as a hypothesis about scale, not a target.',
  };
}
