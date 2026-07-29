/**
 * The 1-2-3 pattern: igniting bar, resting bar, trigger.
 *
 * From practitioner material, and the only genuinely new detector to come out
 * of ~20 hours of it — everything else was either already here (Wyckoff
 * springs, the 38.2/61.8 retracement band) or falsified (candlestick signals).
 *
 * The shape:
 *
 *   1. an IGNITING bar — wide range, opening near its low and closing near its
 *      high, with no meaningful tail against the move;
 *   2. a RESTING bar — narrow, and confined to the TOP THIRD of the igniting
 *      bar;
 *   3. a TRIGGER — price takes out the higher of the two highs.
 *
 * The top-third clause is the whole reason this was worth measuring. Without
 * it the shape is an ordinary inside bar after a big bar, and the structural
 * pattern family already fires on 68% of random walks. A geometric constraint
 * that tight ought to cut the rate hard, the way NR7's does. Whether it
 * actually does is an empirical question and IGNITION_NOISE_BASELINE is the
 * answer, not this comment.
 *
 * One condition is easy to drop and matters: the igniting bar must START a
 * move. The source is explicit that a big bar five bars into an existing run is
 * NOT a 1-2-3, and without that clause the detector mostly finds continuation
 * bars in trends it is already too late to join.
 *
 * All pure.
 */

const DEFAULTS = {
  atr_lookback: 20,
  /** Igniting bar range, in ATRs. Below this it is just a bar. */
  min_ignite_atr: 1.5,
  /** Tail AGAINST the move, as a share of the igniting bar's range. */
  max_ignite_tail_pct: 25,
  /** Resting bar range as a share of the igniting bar's. */
  max_rest_range_ratio: 0.5,
  /** The resting bar must sit entirely inside this share of the igniting bar. */
  rest_zone_pct: 33,
  /** Same-direction closes allowed in the 3 bars before ignition. */
  max_prior_run: 2,
};

const trueRange = (bar, prev) => (prev
  ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close))
  : bar.high - bar.low);

/** Wilder-free simple ATR — enough to size "is this bar unusually wide". */
function atrAt(bars, i, lookback) {
  const from = Math.max(1, i - lookback);
  if (i - from < 2) return null;
  let sum = 0;
  let n = 0;
  for (let k = from; k < i; k++) { sum += trueRange(bars[k], bars[k - 1]); n++; }
  return n ? sum / n : null;
}

/**
 * Find every complete 1-2-3 in `bars`.
 *
 * A pattern is reported once its TRIGGER bar exists, because an untriggered
 * two-bar shape is a setup and not a signal — the same distinction the repo
 * already draws for forming patterns elsewhere.
 */
export function findOneTwoThree(bars, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  if (!Array.isArray(bars) || bars.length < o.atr_lookback + 5) return out;

  for (let i = o.atr_lookback; i < bars.length - 2; i++) {
    const ignite = bars[i];
    const rest = bars[i + 1];
    const trigger = bars[i + 2];
    const range = ignite.high - ignite.low;
    if (!(range > 0)) continue;

    const atr = atrAt(bars, i, o.atr_lookback);
    if (!atr || range < o.min_ignite_atr * atr) continue;

    for (const dir of ['up', 'down']) {
      const up = dir === 'up';

      // 1. Igniting bar: closes at the far end, with no real tail against it.
      const body = up ? ignite.close - ignite.open : ignite.open - ignite.close;
      if (!(body > 0)) continue;
      const tail = up ? ignite.high - ignite.close : ignite.close - ignite.low;
      if ((tail / range) * 100 > o.max_ignite_tail_pct) continue;

      /**
       * It must IGNITE. A wide bar deep inside an existing run is the move
       * continuing, not starting, and the source rules it out explicitly.
       */
      let priorRun = 0;
      for (let k = i - 3; k < i; k++) {
        if (k < 1) continue;
        const rose = bars[k].close > bars[k - 1].close;
        if (rose === up) priorRun++;
      }
      if (priorRun > o.max_prior_run) continue;

      // 2. Resting bar: narrow, and inside the far third of the igniting bar.
      const restRange = rest.high - rest.low;
      if (restRange > o.max_rest_range_ratio * range) continue;
      const zone = (o.rest_zone_pct / 100) * range;
      const zoneLo = up ? ignite.high - zone : ignite.low;
      const zoneHi = up ? ignite.high : ignite.low + zone;
      if (rest.low < zoneLo || rest.high > zoneHi) continue;

      // 3. Trigger: takes out the higher of the two extremes.
      const level = up ? Math.max(ignite.high, rest.high) : Math.min(ignite.low, rest.low);
      const fired = up ? trigger.high > level : trigger.low < level;
      if (!fired) continue;

      out.push({
        pattern: 'one_two_three',
        direction: up ? 'bullish' : 'bearish',
        ignite_index: i,
        rest_index: i + 1,
        trigger_index: i + 2,
        ignite_range_atr: Math.round((range / atr) * 100) / 100,
        rest_range_ratio: Math.round((restRange / range) * 100) / 100,
        entry: level,
        // The source puts the stop under the lower of the resting and trigger
        // bars, not under the igniting bar — that is the tight-stop claim the
        // whole reward-to-risk argument rests on.
        stop: up ? Math.min(rest.low, trigger.low) : Math.max(rest.high, trigger.high),
        prior_run: priorRun,
      });
      break; // a bar cannot ignite both ways
    }
  }
  return out;
}

/**
 * Measured against 200 random walks by scripts/ignition-noise.js.
 *
 * Populated by that script — an empty baseline here means the detector has not
 * been measured and must not be quoted.
 */
export const IGNITION_NOISE_BASELINE = Object.freeze({
  measured: '2026-07-29',

  /**
   * NOT ESTABLISHED. Every null available here differs from real data in a way
   * that moves the answer several-fold, so there is no number to quote.
   */
  status: 'NOT ESTABLISHED',
  verdict: 'DO NOT USE AS A SIGNAL. The detector is implemented and correct; its noise floor is not '
    + 'measurable with the nulls available, and a detector whose floor is unknown is not evidence.',

  estimates: Object.freeze({
    real_bars_unmodified: { pct: 5.9, detail: '1 of 17 live daily charts, ~200 bars each' },
    synthetic_random_walk: { pct: 22.5, detail: '200 walks x 200 bars via barsFromPath' },
    real_shapes_rebuilt: { pct: 31.3, detail: '16 symbols, bar shapes preserved as ratios, gaps removed' },
    iid_shuffle_of_those: { pct: 39.6, detail: 'sequence destroyed' },
    block_shuffle_b20: { pct: 31.3, detail: 'local volatility clustering preserved' },
  }),

  /**
   * Why they disagree, in the order the investigation found it.
   *
   * 1. Real charts fire FOUR TIMES LESS than random walks (5.9% vs 22.5%). A
   *    detector below its own null cannot be shown to carry information.
   * 2. Wick geometry was the first suspect and was NOT the cause — upper tail
   *    as a share of range is 0.275 real against 0.242 synthetic.
   * 3. The cause is the ATR gate. The rule needs range >= 1.5x ATR, and ATR
   *    includes overnight gaps while bar range does not. Real bars: ATR is
   *    1.070x mean range. Strip the gaps and it falls to 1.001, so far more
   *    bars clear the gate — which is why the SAME bars give 5.9% raw and
   *    31.3% rebuilt.
   *
   * Any null that reconstructs a price path removes gaps and inflates the rate;
   * any null that shuffles whole bars invents gaps and inflates ATR. Both are
   * wrong in opposite directions and neither brackets the real number.
   */
  why_not_established:
    'The rule gates on range >= 1.5x ATR. ATR counts overnight gaps, bar range does not, so any null '
    + 'that rebuilds a continuous path (removing gaps) or shuffles whole bars (inventing them) shifts '
    + 'the gate rather than the pattern. Estimates span 5.9% to 39.6% on the same underlying data.',

  /**
   * One relative result DOES survive, because both arms were measured under
   * the identical generator, so the generator's defects cancel.
   */
  established_relative_finding:
    'The top-third clause is load-bearing: removing it takes the same generator from 22.5% to 63.0%, '
    + 'which is the structural-family rate of 68%. Without that clause the shape is an ordinary inside '
    + 'bar after a wide bar and carries nothing. This is a within-generator comparison and holds.',

  to_establish:
    'Needs a null preserving BOTH overnight gaps and volatility clustering — e.g. a stationary block '
    + 'bootstrap over real bars that keeps each bar with its own prior close. Until then the detector '
    + 'stays unexposed: it is not registered as an MCP tool and nothing consumes it.',

  reproduce: 'node scripts/ignition-noise.js --walks 200',
});
