/**
 * Entry, stop and target for every pattern we detect.
 *
 * A detected pattern without its levels is trivia. This turns each one into
 * the three numbers that make it actionable, following the standard
 * constructions:
 *
 *   REVERSAL      entry on the break of the neckline / boundary,
 *                 stop beyond the last shoulder or peak,
 *                 target the pattern height projected from the break.
 *
 *   CONTINUATION  entry on the break in the direction of the prior trend,
 *                 stop the far side of the consolidation,
 *                 target the pole (flags, pennants) or the height (rectangles).
 *
 *   BILATERAL     TWO entries. A symmetrical triangle does not know which way
 *                 it breaks, and a plan that only names the upside is not a
 *                 plan — it is a hope with a stop attached.
 *
 * ── What this deliberately does not do ──
 *
 * It does not say the trade is good. Every plan carries the pattern's measured
 * base rate where one exists, and the honest ones are unflattering: an NR7 up
 * breakout fails to move 5% **46%** of the time; a broadening formation fails
 * 26-27%. R:R is arithmetic on the levels, not evidence.
 *
 * All pure.
 */

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Which family a pattern belongs to, which decides how its levels are built. */
export const PATTERN_FAMILY = {
  double_top: 'reversal_bear',
  triple_top: 'reversal_bear',
  head_and_shoulders: 'reversal_bear',
  double_bottom: 'reversal_bull',
  triple_bottom: 'reversal_bull',
  inverse_head_and_shoulders: 'reversal_bull',
  rising_wedge: 'bear_boundary',
  falling_wedge: 'bull_boundary',
  bull_flag: 'continuation_bull',
  high_tight_flag: 'continuation_bull',
  bear_flag: 'continuation_bear',
  bullish_pennant: 'continuation_bull',
  bearish_pennant: 'continuation_bear',
  ascending_triangle: 'bilateral',
  descending_triangle: 'bilateral',
  symmetrical_triangle: 'bilateral',
  rectangle: 'bilateral',
  bullish_rectangle: 'bilateral',
  bearish_rectangle: 'bilateral',
  // P2.1 review (2026-07-30). Without a family the cup was silently filtered
  // out of tradePlans — detected, drawn, and planless. Not 'continuation_bull':
  // that case reads m.flag_high/m.flag_low, which the cup correctly does not
  // emit, and would have produced an empty plan instead of a filtered one.
  cup_with_handle: 'cup_bull',
  broadening_formation: 'bilateral',
  ascending_channel: 'channel',
  descending_channel: 'channel',
  horizontal_channel: 'channel',
};

const leg = (side, entry, stop, target, note) => {
  if (entry == null || stop == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = target == null ? null : Math.abs(target - entry);
  return {
    side, entry: round(entry), stop: round(stop), target: round(target),
    risk: round(risk), reward: round(reward),
    rr: risk > 0 && reward != null ? round(reward / risk, 2) : null,
    note,
  };
};

/**
 * Build the trade plan for one detected pattern.
 *
 * `atr` is used only to pad a stop beyond a boundary — without it the stop
 * sits exactly on the level, which is where it will be taken out by noise.
 */
export function tradePlan(p, { atr = null } = {}) {
  const m = p.measurements || {};
  const family = PATTERN_FAMILY[p.pattern] || 'unknown';
  const pad = atr ? atr * 0.5 : 0;
  const legs = {};

  switch (family) {
    case 'reversal_bear': {
      // Entry on a close below the neckline; stop above the last peak.
      const neck = m.trough ?? m.neckline ?? p.completion_level;
      const peak = m.right_shoulder ?? m.peak_2 ?? m.peak_3 ?? m.head;
      const height = m.height ?? (peak != null && neck != null ? peak - neck : null);
      legs.short = leg('short', neck, peak != null ? peak + pad : null,
        (neck != null && height != null) ? neck - height : null,
        'Completes only on a CLOSE below the neckline. Above it this is not a pattern yet.');
      break;
    }
    case 'reversal_bull': {
      const neck = m.peak ?? m.neckline ?? p.completion_level;
      const trough = m.right_shoulder ?? m.trough_2 ?? m.trough_3 ?? m.head;
      const height = m.height ?? (neck != null && trough != null ? neck - trough : null);
      legs.long = leg('long', neck, trough != null ? trough - pad : null,
        (neck != null && height != null) ? neck + height : null,
        'Completes only on a CLOSE above the neckline.');
      break;
    }
    case 'bear_boundary': {
      // Rising wedge — breaks DOWN through its lower boundary.
      const entry = m.support_now ?? p.completion_level;
      const stop = m.resistance_now ?? null;
      legs.short = leg('short', entry, stop != null ? stop + pad : null, p.target ?? null,
        'Rising wedge breaks DOWN. Entry on a close below the lower boundary, stop above the upper.');
      break;
    }
    case 'bull_boundary': {
      const entry = m.resistance_now ?? p.completion_level;
      const stop = m.support_now ?? null;
      legs.long = leg('long', entry, stop != null ? stop - pad : null, p.target ?? null,
        'Falling wedge breaks UP. Entry on a close above the upper boundary, stop below the lower.');
      break;
    }
    case 'continuation_bull': {
      const entry = m.flag_high ?? p.completion_level;
      const stop = m.flag_low ?? null;
      legs.long = leg('long', entry, stop != null ? stop - pad : null, p.target ?? null,
        'Entry on a close above the consolidation high. Target is the pole projected from the break.');
      break;
    }
    case 'cup_bull': {
      /**
       * P2.1 review (2026-07-30). Entry and stop are Bulkowski's own: a CLOSE
       * above the right cup lip, stop under the handle low. The target is HALF
       * the cup height — his recommendation, reached 76% in a bull market
       * against 50% for the full height (CUP_TARGET_STATS carries both and the
       * 61% site figure). The full-height target is what every other pattern
       * here projects, so the note says which construction this is.
       */
      const lip = m.right_rim ?? p.completion_level;
      const low = m.handle_low ?? null;
      const height = (lip != null && m.cup_low != null) ? lip - m.cup_low : null;
      legs.long = leg('long', lip, low != null ? low - pad : null,
        (lip != null && height != null) ? lip + height / 2 : null,
        'Completes only on a CLOSE above the right cup lip. Target is HALF the cup height — Bulkowski\'s own '
        + 'recommendation, reached 76% in a bull market; the full height is met 61% (thepatternsite.com/cup.html).');
      break;
    }
    case 'continuation_bear': {
      const entry = m.flag_low ?? p.completion_level;
      const stop = m.flag_high ?? null;
      legs.short = leg('short', entry, stop != null ? stop + pad : null, p.target ?? null,
        'Entry on a close below the consolidation low. Target is the pole projected from the break.');
      break;
    }
    case 'bilateral': {
      // TWO plans. The pattern does not know which way it resolves, and a
      // one-sided plan for a bilateral shape is the commonest way to be
      // caught on the wrong side of a triangle.
      const upper = m.resistance_now ?? m.upper ?? null;
      const lower = m.support_now ?? m.lower ?? null;
      const height = m.height ?? (upper != null && lower != null ? upper - lower : null);
      legs.long = leg('long', upper, lower != null ? lower - pad : null,
        (upper != null && height != null) ? upper + height : null,
        'Upside break. Bilateral — this leg is only live once a bar CLOSES above the upper boundary.');
      legs.short = leg('short', lower, upper != null ? upper + pad : null,
        (lower != null && height != null) ? lower - height : null,
        'Downside break. Bilateral — only live once a bar CLOSES below the lower boundary.');
      break;
    }
    case 'channel': {
      // Channels carry their own plan, built by channels.js.
      return p.entry ? { family, ...p.entry, source: 'channels.js' } : { family, legs: {}, note: 'No channel entry block.' };
    }
    default:
      return { family: 'unknown', legs: {}, note: `No trade construction defined for "${p.pattern}".` };
  }

  const live = Object.fromEntries(Object.entries(legs).filter(([, v]) => v));
  const measured = p.measured || null;

  // A typed rectangle names the trend it interrupts, so one of its two legs is
  // the continuation and the other is the reversal. Both stay planned — the
  // pattern still breaks either way — but saying which is which is the whole
  // point of typing it.
  const primaryLeg = p.pattern === 'bullish_rectangle' ? 'long'
    : p.pattern === 'bearish_rectangle' ? 'short'
    : null;

  return {
    family,
    bilateral: family === 'bilateral',
    legs: live,
    ...(primaryLeg && live[primaryLeg] ? {
      primary_leg: primaryLeg,
      primary_note: `${primaryLeg === 'long' ? 'Upward' : 'Downward'} break continues the trend the range interrupted. `
        + 'The other leg is the reversal and is still planned — a typed rectangle is not a one-way pattern.',
    } : {}),
    status: p.status ?? null,
    tradeable_now: p.status === 'confirmed',
    status_note: p.status === 'forming'
      ? 'FORMING — none of these levels are live yet. A forming pattern is a hypothesis; the entry is what would confirm it.'
      : null,
    ...(measured ? {
      base_rate: {
        break_even_failure_pct: measured.break_even_failure_pct ?? measured.break_even_failure_pct_range ?? null,
        meeting_target_pct: measured.meeting_target_pct ?? measured.meeting_target_pct_range ?? null,
        note: 'Bulkowski\'s measured figures. Quote the failure rate next to any target — R:R is arithmetic on the levels, not evidence the trade works.',
      },
    } : {}),
  };
}

/** Plans for a whole detection set, skipping anything with no construction. */
export function tradePlans(patterns, { atr = null } = {}) {
  return (patterns || []).map((p) => ({
    pattern: p.pattern,
    status: p.status ?? null,
    plan: tradePlan(p, { atr }),
  })).filter((x) => x.plan.family !== 'unknown');
}
