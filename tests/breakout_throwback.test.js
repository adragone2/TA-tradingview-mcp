/**
 * Throwback tests — no TradingView connection needed.
 *
 * A throwback is the return to the breakout price after an upward breakout (a
 * PULLBACK after a downward one). Bulkowski measures it on 10,305 upward and
 * 8,765 downward chart-pattern breakouts, and 58% of them do it — so the thing
 * worth testing is not "does it fire" but whether each of the four statuses is
 * reachable, whether the boundaries between them are where the code says they
 * are, and whether the reading can contradict check 5.
 *
 * That last one gets a generated arm rather than an argument: 600 series, both
 * directions, asserting the derived reclaim test still equals the expression it
 * replaced. An equivalence claimed in a comment is an equivalence nobody has
 * measured.
 *
 * Run: node --test tests/breakout_throwback.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreBreakout,
  readThrowback,
  THROWBACK_STATS,
  THROWBACK_TOLERANCE_PCT,
} from '../src/core/breakout.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });
const reset = () => { t = 1_700_000_000; };

/** Quiet bars oscillating just under `level` — the same shape breakout.test.js uses. */
function approach(level, n = 25, { vol = 1000 } = {}) {
  reset();
  const out = [];
  for (let i = 0; i < n; i++) {
    const near = i % 5 === 0;
    const c = near ? level - 0.2 : level - 4 + (i % 3);
    out.push(bar(c - 0.5, near ? level - 0.05 : c + 0.5, c - 1, c, vol));
  }
  return out;
}

/** The breakout bar every scenario below shares: big body, heavy volume, closes at 103.5. */
const BREAK = () => bar(99.5, 104, 99.4, 103.5, 4000);

/** Every numeric leaf, so a NaN cannot hide inside a nested object. */
function nanPaths(value, path = '') {
  if (typeof value === 'number') return Number.isNaN(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => nanPaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => nanPaths(v, `${path}.${k}`));
  }
  return [];
}

/* ────────────────────────── the four statuses ────────────────────────── */

describe('throwback status', () => {
  it('reports none_yet with the window still OPEN when price runs away', () => {
    const bars = [
      ...approach(100),
      BREAK(),
      bar(103.5, 106, 103, 105.5, 3000),
      bar(105.5, 108, 105, 107, 3000),
    ];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.status, 'none_yet');
    assert.equal(tb.held, null);
    assert.equal(tb.bars_to_touch, null);
    assert.equal(tb.window.open, true);
    assert.match(tb.summary, /not yet.*not "did not"/i);
  });

  it('reports none_yet with the window CLOSED once 30 days pass with no return', () => {
    const bars = [...approach(100), BREAK()];
    for (let i = 0; i < 40; i++) bars.push(bar(104 + i, 106 + i, 103.5 + i, 105 + i, 2000));
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.status, 'none_yet');
    assert.equal(tb.window.open, false);
    // The window bounds what is looked at: 30 days of daily bars, not all 40.
    assert.equal(tb.window.bars_considered, 30);
    assert.equal(tb.bars_since_breakout, 40);
    assert.match(tb.summary, /did not return/i);
    assert.match(tb.summary, /42% of his 10305 breakouts/);
  });

  it('reports in_progress while price sits in the zone unresolved', () => {
    const bars = [
      ...approach(100),
      BREAK(),
      bar(103.5, 104, 102, 102.5, 2000),
      bar(102.5, 102.6, 100.2, 100.3, 2000),   // low inside the zone, close inside it too
    ];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.status, 'in_progress');
    assert.equal(tb.held, null);
    assert.equal(tb.bars_to_touch, 2);
    assert.equal(tb.bars_to_resolution, null);
    assert.match(tb.summary, /resolved neither way/i);
  });

  it('reports completed_held when price touches the level and closes clear again', () => {
    const bars = [
      ...approach(100),
      BREAK(),
      bar(103.5, 104, 102, 102.5, 2000),
      bar(102.5, 102.6, 100.2, 100.3, 2000),   // touch
      bar(100.3, 102, 100.1, 101.8, 2500),     // closes above the top of the zone
    ];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.status, 'completed_held');
    assert.equal(tb.held, true);
    assert.equal(tb.bars_to_touch, 2);
    assert.equal(tb.bars_to_resolution, 3);
    assert.match(tb.held_detail, /Resumed/i);
  });

  it('reports completed_failed when price touches the level and closes back through it', () => {
    const bars = [
      ...approach(100),
      BREAK(),
      bar(103.5, 104, 102, 102.5, 2000),
      bar(102.5, 102.6, 100.2, 100.3, 2000),   // touch
      bar(100.3, 100.4, 97, 97.5, 2500),       // closes below the level
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.throwback.status, 'completed_failed');
    assert.equal(r.throwback.held, false);
    assert.equal(r.throwback.bars_to_resolution, 3);
    assert.match(r.throwback.held_detail, /Sliced through/i);
  });

  it('completes in ONE bar when a single bar dips into the zone and closes clear', () => {
    const bars = [
      ...approach(100),
      BREAK(),
      bar(103.5, 104, 100.2, 103, 3000),       // low in the zone, close well above it
    ];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.status, 'completed_held');
    assert.equal(tb.bars_to_touch, 1);
    assert.equal(tb.bars_to_resolution, 1);
  });

  it('does NOT downgrade the verdict for a throwback that fails later than the next bar', () => {
    // The design decision, pinned: "failed" means immediately reclaimed. A
    // throwback that slices through on bar 3 is Bulkowski's lower-performing
    // ARM, which he reports as a smaller average move, not as a failure.
    const bars = [
      ...approach(100),
      BREAK(),
      bar(103.5, 104, 102, 102.5, 2000),
      bar(102.5, 102.6, 100.2, 100.3, 2000),
      bar(100.3, 100.4, 97, 97.5, 2500),
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.throwback.status, 'completed_failed');
    assert.notEqual(r.verdict, 'failed');
    assert.equal(r.failed_reason, undefined);
    assert.match(r.throwback_note, /not downgraded/i);
  });
});

/* ────────────────────── check 5 and the throwback agree ────────────────────── */

describe('throwback reconciles with the immediate-reclaim check', () => {
  it('an immediate reclaim is a throwback that completed and failed on bar 1', () => {
    const bars = [...approach(100), BREAK(), bar(103.5, 104, 97, 98, 3000)];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.verdict, 'failed');
    assert.match(r.failed_reason, /reclaimed/i);
    assert.equal(r.throwback.status, 'completed_failed');
    assert.equal(r.throwback.bars_to_touch, 1);
    assert.equal(r.throwback.bars_to_resolution, 1);
  });

  it('agrees with the expression it replaced over 600 generated series', () => {
    // mulberry32 — deterministic, so a failure is reproducible.
    const rng = (seed) => () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };

    function walk(seed) {
      const rand = rng(seed);
      reset();
      const out = [];
      let px = 100;
      for (let i = 0; i < 60; i++) {
        const o = px;
        px += (rand() - 0.5) * 4;
        const c = px;
        out.push(bar(o, Math.max(o, c) + rand() * 2, Math.min(o, c) - rand() * 2, c, 500 + rand() * 3000));
      }
      return out;
    }

    let broken = 0;
    let reclaims = 0;
    for (let seed = 1; seed <= 300; seed++) {
      for (const dir of ['up', 'down']) {
        const bars = walk(dir === 'up' ? seed : seed + 10_000);
        const first40 = bars.slice(0, 40);
        const level = dir === 'up'
          ? Math.max(...first40.map((x) => x.high))
          : Math.min(...first40.map((x) => x.low));
        const r = scoreBreakout(bars, { level, direction: dir });
        if (!r.broken) continue;
        broken += 1;

        // The expression this module used before the throwback existed.
        const next = bars[r.breakout_bar.index + 1] || null;
        const naive = next ? (dir === 'up' ? next.close < level : next.close > level) : null;

        assert.equal(
          r.verdict === 'failed', naive === true,
          `seed ${seed} ${dir}: verdict "${r.verdict}" disagrees with the naive reclaim test (${naive})`,
        );
        assert.equal(Boolean(r.failed_reason), naive === true, `seed ${seed} ${dir}: failed_reason disagrees`);
        if (naive === true) {
          reclaims += 1;
          assert.equal(r.throwback.status, 'completed_failed', `seed ${seed} ${dir}: status must be completed_failed`);
          assert.equal(r.throwback.bars_to_resolution, 1, `seed ${seed} ${dir}: resolution must be bar 1`);
        }
      }
    }

    // Guard against the test passing because nothing happened. Both arms have
    // to be exercised or the equivalence above is untested.
    assert.ok(broken >= 100, `expected plenty of breakouts to compare; got ${broken}`);
    assert.ok(reclaims >= 10, `expected some immediate reclaims among them; got ${reclaims}`);
  });
});

/* ──────────────────────────── volume context ──────────────────────────── */

describe('breakout_volume_context', () => {
  it('reads elevated when the breakout bar beat its average', () => {
    const bars = [...approach(100, 25, { vol: 1000 }), BREAK(), bar(103.5, 106, 103, 105.5, 3000)];
    const vc = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback.breakout_volume_context;
    assert.equal(vc.elevated, true);
    assert.equal(vc.ratio, 4);
    assert.equal(vc.base_rate.high_volume_breakouts_pct, 70);
    assert.match(vc.base_rate.quote, /throws back 70% of the time/);
    assert.match(vc.base_rate.url, /thepatternsite\.com/);
  });

  it('reads not-elevated when it did not, without changing the citation', () => {
    const bars = [
      ...approach(100, 25, { vol: 1000 }),
      bar(99.5, 104, 99.4, 103.5, 800),
      bar(103.5, 106, 103, 105.5, 900),
    ];
    const vc = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback.breakout_volume_context;
    assert.equal(vc.elevated, false);
    assert.equal(vc.ratio, 0.8);
    assert.equal(vc.base_rate.all_breakouts_pct, 58);
  });

  it('says UNKNOWN rather than "not elevated" when the breakout bar has no volume', () => {
    // Number(null) is 0 and 0 is finite, so this used to score a hard FAIL on
    // the volume check and would have read as "not elevated" here.
    const bars = [...approach(100, 25, { vol: 1000 }), BREAK(), bar(103.5, 106, 103, 105.5, 3000)];
    bars[25].volume = null;
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.throwback.breakout_volume_context.elevated, null);
    assert.equal(r.throwback.breakout_volume_context.ratio, null);
    assert.match(r.throwback.breakout_volume_context.detail, /UNKNOWN/);
    // and the check itself goes UNSCORED rather than failing
    assert.equal(r.checks.find((c) => c.name === 'volume').pass, null);
    assert.equal(r.score, '4 of 4');   // denominator drops; the numerator is untouched
    assert.equal(r.unscored, 1);
  });

  it('states both thresholds, so the 1.2x check failing is not read as a bug', () => {
    const bars = [
      ...approach(100, 25, { vol: 1000 }),
      bar(99.5, 104, 99.4, 103.5, 1100),   // above average, below the 1.2x check
      bar(103.5, 106, 103, 105.5, 1000),
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.throwback.breakout_volume_context.elevated, true);
    assert.equal(r.checks.find((c) => c.name === 'volume').pass, false);
    assert.match(r.throwback.breakout_volume_context.threshold, /1\.2x/);
  });
});

/* ──────────────────────────── null safety ──────────────────────────── */

describe('throwback null safety', () => {
  it('falls back to a BAR window and says so when the bars carry no timestamps', () => {
    const bars = [...approach(100), BREAK(), bar(103.5, 106, 103, 105.5, 3000)]
      .map((b) => ({ ...b, time: null }));
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.days_since_breakout, null);
    assert.equal(tb.window.days_elapsed, null);
    assert.match(tb.window.basis, /BARS/);
    assert.match(tb.window.basis, /no usable timestamps/i);
    assert.equal(tb.status, 'none_yet');
  });

  it('reports null distances rather than zeros when nothing has happened', () => {
    const bars = [...approach(100), BREAK()];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.bars_to_touch, null);
    assert.equal(tb.days_to_touch, null);
    assert.equal(tb.bars_to_resolution, null);
    assert.equal(tb.days_to_resolution, null);
    assert.equal(tb.held, null);
  });

  it('produces no NaN anywhere, on bars missing volume, time and a whole OHLC leg', () => {
    const bars = [...approach(100), BREAK(), bar(103.5, 106, 103, 105.5, 3000), bar(105.5, 108, 100.2, 100.4, 2000)];
    bars[26].volume = null;
    bars[26].time = null;
    bars[27].low = null;         // a broken bar in the middle of the return leg
    bars[25].volume = undefined;
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.deepEqual(nanPaths(r.throwback, 'throwback'), []);
    assert.deepEqual(nanPaths(r.checks, 'checks'), []);
  });

  it('leaves MOMENTUM unscored too when there is nothing to compare against', () => {
    // The same collapse as the volume check: `avgBody === 0` used to score a
    // hard FAIL whose own detail read "no prior bodies to compare".
    reset();
    const flat = Array.from({ length: 25 }, () => bar(99, 99.4, 98.6, 99, 1000));   // every body is zero
    const r = scoreBreakout([...flat, BREAK(), bar(103.5, 106, 103, 105.5, 3000)], { level: 100, direction: 'up' });
    const m = r.checks.find((c) => c.name === 'momentum');
    assert.equal(m.pass, null);
    assert.match(m.detail, /no prior bodies to compare/);
    assert.equal(r.unscored, 1);
    // The numerator — which is what the verdict and scripts/detector-noise.js
    // both read — counts only true passes, so a null cannot move it.
    assert.equal(r.score, '3 of 4');
    assert.equal(r.checks.filter((c) => c.pass === true).length, 3);
  });

  it('validates its own inputs', () => {
    const bars = [...approach(100), BREAK()];
    assert.throws(() => readThrowback([], { index: 0, level: 100, direction: 'up' }), /needs the bar array/);
    assert.throws(() => readThrowback(bars, { index: 999, level: 100, direction: 'up' }), /index must be/);
    assert.throws(() => readThrowback(bars, { index: 1.5, level: 100, direction: 'up' }), /index must be/);
    assert.throws(() => readThrowback(bars, { index: 25, level: null, direction: 'up' }), /level must be a number/);
    assert.throws(() => readThrowback(bars, { index: 25, level: 100, direction: 'sideways' }), /direction must be/);
  });

  it('ignores a nonsense tolerance or window rather than producing a zero-width zone', () => {
    const bars = [...approach(100), BREAK()];
    const tb = readThrowback(bars, {
      index: 25, level: 100, direction: 'up', tolerance_pct: 0, window_days: -5,
    });
    assert.equal(tb.tolerance_pct, THROWBACK_TOLERANCE_PCT);
    assert.equal(tb.window.days, THROWBACK_STATS.window_days);
  });
});

/* ──────────────────────── the tolerance is a real number ──────────────────────── */

describe('throwback tolerance', () => {
  it('states the zone as prices, at 0.5% of the level by default', () => {
    const bars = [...approach(100), BREAK()];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.tolerance_pct, 0.5);
    assert.equal(tb.tolerance_price, 0.5);
    assert.deepEqual(tb.level_zone, [99.5, 100.5]);
    assert.match(tb.tolerance_basis, /same 0\.5% band the level_was_established check uses/);
  });

  it('actually widens the touch test when the tolerance is raised', () => {
    const bars = [
      ...approach(100),
      BREAK(),
      bar(103.5, 104, 101.4, 102.5, 2000),   // low 101.4 — outside 0.5%, inside 2%
    ];
    const tight = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    const loose = scoreBreakout(bars, { level: 100, direction: 'up', throwback_tolerance_pct: 2 }).throwback;
    assert.equal(tight.status, 'none_yet');
    assert.equal(loose.status, 'completed_held');
    assert.deepEqual(loose.level_zone, [98, 102]);
  });
});

/* ─────────────────────────── the downward mirror ─────────────────────────── */

describe('pullback — the downward mirror', () => {
  const flip = (b) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close });

  it('names it a PULLBACK and carries the downward-breakout figures', () => {
    const bars = [
      ...approach(100).map(flip),
      bar(100.5, 100.6, 96, 96.5, 4000),
      bar(96.5, 97, 94, 94.5, 3000),
    ];
    const tb = scoreBreakout(bars, { level: 100, direction: 'down' }).throwback;
    assert.equal(tb.kind, 'pullback');
    assert.equal(tb.status, 'none_yet');
    assert.equal(tb.base_rate.sample, 8765);
    assert.equal(tb.breakout_volume_context.base_rate.high_volume_breakouts_pct, 66);
    assert.match(tb.base_rate.rate_quote, /downward breakouts had pullbacks/);
  });

  it('completes held when price returns to the level and closes clear below it', () => {
    const bars = [
      ...approach(100).map(flip),
      bar(100.5, 100.6, 96, 96.5, 4000),
      bar(96.5, 99.7, 96.4, 97, 3000),       // high 99.7 — inside the zone, close clear below
    ];
    const tb = scoreBreakout(bars, { level: 100, direction: 'down' }).throwback;
    assert.equal(tb.status, 'completed_held');
    assert.equal(tb.held, true);
  });

  it('completes failed when price closes back above the level', () => {
    const bars = [
      ...approach(100).map(flip),
      bar(100.5, 100.6, 96, 96.5, 4000),
      bar(96.5, 97, 96, 96.8, 3000),
      bar(96.8, 101.5, 96.7, 101, 3000),     // back through the level
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'down' });
    assert.equal(r.throwback.status, 'completed_failed');
    assert.equal(r.throwback.held, false);
    assert.notEqual(r.verdict, 'failed');    // not the NEXT bar, so not a reclaim
  });
});

/* ──────────────────── the numbers are his, and only his ──────────────────── */

describe('THROWBACK_STATS', () => {
  it('carries the figures read off thepatternsite.com, with their URLs', () => {
    assert.equal(THROWBACK_STATS.window_days, 30);
    assert.equal(THROWBACK_STATS.better_without_pct, 97);
    assert.equal(THROWBACK_STATS.better_without_url, 'https://thepatternsite.com/studystudy.html');

    assert.equal(THROWBACK_STATS.up.rate_pct, 58);
    assert.equal(THROWBACK_STATS.up.sample, 10305);
    assert.equal(THROWBACK_STATS.up.high_volume_rate_pct, 70);
    assert.equal(THROWBACK_STATS.up.held_move_pct, 40);
    assert.equal(THROWBACK_STATS.up.through_move_pct, 29);
    assert.equal(THROWBACK_STATS.up.url, 'https://thepatternsite.com/throwbacks.html');

    assert.equal(THROWBACK_STATS.down.rate_pct, 58);
    assert.equal(THROWBACK_STATS.down.sample, 8765);
    assert.equal(THROWBACK_STATS.down.high_volume_rate_pct, 66);
    assert.equal(THROWBACK_STATS.down.held_move_pct, 25);
    assert.equal(THROWBACK_STATS.down.through_move_pct, 20);
    assert.equal(THROWBACK_STATS.down.url, 'https://www.thepatternsite.com/pullbacks.html');
  });

  it('reports the missing noise floor rather than omitting it', () => {
    assert.equal(THROWBACK_STATS.noise_floor, null);
    assert.match(THROWBACK_STATS.noise_floor_note, /UNMEASURED/);
    const bars = [...approach(100), BREAK()];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.base_rate.noise_floor, null);
    assert.match(tb.base_rate.noise_floor_note, /random\s+walk/i);
  });

  it('quotes only percentages that appear in the stats constant', () => {
    // No invented probabilities: every number the reading reports as a base
    // rate has to come from THROWBACK_STATS, so this pins the wiring.
    const bars = [...approach(100), BREAK(), bar(103.5, 104, 97, 98, 3000)];
    const tb = scoreBreakout(bars, { level: 100, direction: 'up' }).throwback;
    assert.equal(tb.base_rate.rate_pct, THROWBACK_STATS.up.rate_pct);
    assert.equal(tb.base_rate.better_without_pct, THROWBACK_STATS.better_without_pct);
    assert.equal(tb.base_rate.rate_quote, THROWBACK_STATS.up.rate_quote);
    assert.equal(tb.base_rate.arms_quote, THROWBACK_STATS.up.arms_quote);
    assert.deepEqual(tb.base_rate.urls, [THROWBACK_STATS.up.url, THROWBACK_STATS.better_without_url]);
    assert.match(tb.note, /not a forecast/i);
  });
});

/* ─────────────────────── the addition stays additive ─────────────────────── */

describe('the five checks are untouched', () => {
  it('still scores exactly five named checks in the same order', () => {
    const bars = [...approach(100), BREAK(), bar(103.5, 106, 103, 105.5, 3000)];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.deepEqual(r.checks.map((c) => c.name), [
      'momentum', 'close_beyond_level', 'volume', 'level_was_established', 'follow_through',
    ]);
    assert.equal(r.score, '5 of 5');
    assert.equal(r.verdict, 'strong');
  });

  it('reports no throwback at all when there was no breakout', () => {
    const r = scoreBreakout(approach(100), { level: 100, direction: 'up' });
    assert.equal(r.broken, false);
    assert.equal(r.throwback, undefined);
  });
});
