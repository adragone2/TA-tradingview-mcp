import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  stretch, multiBarNR, multiBarNRs, MULTI_NR_SPECS, wideSpread, hooks,
  threeDayHighReversal, crabelPatterns, CRABEL_NOISE_BASELINE, HORIZON_WARNING,
} from '../src/core/crabel.js';
import { barsFromPath, randomWalk } from '../src/core/synthetic.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: 100 });
const walkBars = (seed, n = 300) =>
  barsFromPath(randomWalk({ n, vol: 0.015, seed }), { noise: 0.006, seed: seed + 1 });

/** n bars of a given range, centred on 100. */
const flat = (n, range) => Array.from({ length: n }, () => bar(100, 100 + range / 2, 100 - range / 2, 100));

describe('stretch — the ORB entry distance', () => {
  test('is the mean distance from open to the NEAREST extreme', () => {
    // open 100, high 104, low 99 -> nearest extreme is the low, distance 1.
    const bars = Array.from({ length: 10 }, () => bar(100, 104, 99, 102));
    assert.equal(stretch(bars).stretch, 1);
  });

  test('uses the nearer side, not the range', () => {
    const bars = Array.from({ length: 10 }, () => bar(100, 110, 99.5, 105));
    assert.equal(stretch(bars).stretch, 0.5);   // not 10, and not the 10.5 range
  });

  test('needs its full lookback', () => {
    assert.equal(stretch(Array.from({ length: 5 }, () => bar(100, 101, 99, 100))), null);
  });

  test('says outright that it is not a trigger on daily bars', () => {
    const s = stretch(Array.from({ length: 10 }, () => bar(100, 101, 99, 100)));
    assert.match(s.not_a_trigger, /INTRADAY|thirty seconds/);
  });
});

describe('multiBarNR — the family NR4 and NR7 cannot see', () => {
  /**
   * The distinction that justifies the module: NR4/NR7 compare ONE day against
   * preceding single days. A market can coil over a week with no single day
   * being unusually quiet, and only the multi-bar measure catches it.
   */
  test('a 2-day coil inside wide single days qualifies as 2BNR', () => {
    const bars = [...flat(25, 4), bar(100, 101, 99, 100), bar(100, 101, 99, 100)];
    const r = multiBarNR(bars, bars.length - 1, { span: 2, lookback: 20 });
    assert.equal(r.qualifies, true);
    assert.equal(r.span, 2);
  });

  test('does NOT qualify when an earlier period was as narrow', () => {
    const bars = [...flat(10, 4), bar(100, 100.5, 99.5, 100), bar(100, 100.5, 99.5, 100),
      ...flat(10, 4), bar(100, 101, 99, 100), bar(100, 101, 99, 100)];
    assert.equal(multiBarNR(bars, bars.length - 1, { span: 2, lookback: 20 }).qualifies, false);
  });

  test('returns null — not false — when history is too short AND no counterexample was found', () => {
    // Insufficient history only matters when nothing contradicted the claim.
    // A period that IS as narrow is a counterexample, and "not narrowest" is
    // then a correct answer however short the history.
    const bars = [...flat(4, 4), bar(100, 100.5, 99.5, 100), bar(100, 100.5, 99.5, 100)];
    assert.equal(multiBarNR(bars, bars.length - 1, { span: 2, lookback: 20 }), null);
  });

  test('a counterexample beats short history — that is a real false, not unknown', () => {
    const bars = flat(6, 3);   // every period equally narrow
    assert.equal(multiBarNR(bars, bars.length - 1, { span: 2, lookback: 20 }).qualifies, false);
  });

  test('the four specs are Crabel\'s own pairings', () => {
    assert.deepEqual(MULTI_NR_SPECS.map((s) => [s.name, s.span, s.lookback]), [
      ['2BNR', 2, 20], ['3BNR', 3, 20], ['4BNR', 4, 30], ['8BNR', 8, 40],
    ]);
  });

  test('every qualifying result carries a direction warning, not a direction', () => {
    const bars = [...flat(25, 4), bar(100, 101, 99, 100), bar(100, 101, 99, 100)];
    for (const p of multiBarNRs(bars)) {
      assert.equal(p.direction, 'neutral');
      assert.match(p.direction_warning, /says nothing about which/i);
    }
  });
});

describe('wideSpread — the expansion half', () => {
  test('true when today ranges wider than yesterday', () => {
    const bars = [bar(100, 101, 99, 100), bar(100, 105, 95, 100)];
    assert.equal(wideSpread(bars).wide_spread, true);
  });
  test('false when it does not', () => {
    const bars = [bar(100, 105, 95, 100), bar(100, 101, 99, 100)];
    assert.equal(wideSpread(bars).wide_spread, false);
  });
});

describe('hooks — named for the OPEN, not the outcome', () => {
  /**
   * The commonest way to invert this signal is to read "bull hook" as bullish.
   * It is not: it opens above the prior high and closes DOWN through the prior
   * close. The direction field states the resolution so the name cannot
   * mislead.
   */
  test('a bear hook opens below the prior low and closes above the prior close', () => {
    const bars = [bar(100, 105, 95, 100), bar(94, 101.5, 93.5, 101)];
    const h = hooks(bars);
    assert.equal(h.pattern, 'bear_hook');
    assert.equal(h.direction, 'bullish_resolution');
  });

  test('a bull hook opens above the prior high and closes below the prior close', () => {
    const bars = [bar(100, 105, 95, 100), bar(106, 106.5, 98.5, 99)];
    const h = hooks(bars);
    assert.equal(h.pattern, 'bull_hook');
    assert.equal(h.direction, 'bearish_resolution');
  });

  test('a WIDE range is not a hook — the narrow range is part of the definition', () => {
    const bars = [bar(100, 101, 99, 100), bar(94, 120, 80, 101)];
    assert.equal(hooks(bars), null);
  });

  test('opening inside the prior range is not a hook', () => {
    const bars = [bar(100, 105, 95, 100), bar(100, 101, 99, 101)];
    assert.equal(hooks(bars), null);
  });
});

describe('3DHR — the principle as one pattern', () => {
  test('three contracting days then a wide close beyond the range', () => {
    const bars = [bar(100, 110, 90, 100), bar(100, 106, 94, 100), bar(100, 104, 96, 100),
      bar(100, 102, 98, 100), bar(100, 112, 99, 111)];
    const r = threeDayHighReversal(bars);
    assert.ok(r, 'constructed 3DHR not detected');
    assert.equal(r.direction, 'bullish');
  });

  test('rejects when the days are not contracting', () => {
    const bars = [bar(100, 110, 90, 100), bar(100, 102, 98, 100), bar(100, 106, 94, 100),
      bar(100, 108, 92, 100), bar(100, 112, 99, 111)];
    assert.equal(threeDayHighReversal(bars), null);
  });

  test('rejects when the close does not clear the three-day range', () => {
    const bars = [bar(100, 110, 90, 100), bar(100, 106, 94, 100), bar(100, 104, 96, 100),
      bar(100, 102, 98, 100), bar(100, 112, 99, 101)];
    assert.equal(threeDayHighReversal(bars), null);
  });
});

describe('the horizon warning travels with every result', () => {
  test('crabelPatterns always carries it, even with nothing detected', () => {
    const out = crabelPatterns(walkBars(1));
    assert.ok(out.horizon);
    assert.match(out.horizon.turnover, /250 round trips/);
    assert.match(out.horizon.reversal_zone, /REVERSAL/);
  });

  test('it states that ORB is out of reach rather than approximating it', () => {
    assert.match(HORIZON_WARNING.unreachable, /thirty seconds/);
    assert.match(HORIZON_WARNING.unreachable, /deliberately absent/);
  });

  test('a contraction is called a volatility statement, not a direction', () => {
    assert.match(HORIZON_WARNING.what_it_says, /VOLATILITY/);
  });
});

describe('CRABEL_NOISE_BASELINE — the reason none of this is a signal', () => {
  test('is measured', () => {
    assert.equal(CRABEL_NOISE_BASELINE.measured, true);
  });

  test('records that every pattern fires on every random walk', () => {
    for (const [k, v] of Object.entries(CRABEL_NOISE_BASELINE.walks_firing_pct)) {
      assert.equal(v, 100, `${k} is no longer at 100% — re-measure and update the note`);
    }
  });

  test('records that the contraction/expansion principle has NO lift over noise', () => {
    const ce = CRABEL_NOISE_BASELINE.contraction_expansion;
    assert.ok(ce.real_data.lift_points <= ce.random_walk.lift_points,
      'real data now shows MORE lift than a random walk — that would be a finding, re-measure');
    assert.match(ce.verdict, /NO EDGE/);
  });

  test('the effect really is large in both — it is the LIFT that is empty', () => {
    // Guards against the opposite misreading: the description is true, and
    // reporting "contraction does not precede expansion" would be wrong.
    assert.ok(CRABEL_NOISE_BASELINE.contraction_expansion.real_data.given_nr4_pct > 70);
  });
});

describe('the numbers still hold on fresh walks', () => {
  test('range mean-reversion reproduces without a market', () => {
    let ncond = 0, hitcond = 0, nall = 0, hitall = 0;
    const rangeOf = (b) => b.high - b.low;
    for (let s = 0; s < 25; s++) {
      const bars = walkBars(9000 + s);
      for (let i = 7; i < bars.length - 1; i++) {
        const r = rangeOf(bars[i]);
        const expands = rangeOf(bars[i + 1]) > r;
        nall++; if (expands) hitall++;
        let nr4 = true;
        for (let k = i - 3; k < i; k++) if (rangeOf(bars[k]) <= r) { nr4 = false; break; }
        if (nr4) { ncond++; if (expands) hitcond++; }
      }
    }
    const lift = (hitcond / ncond) * 100 - (hitall / nall) * 100;
    assert.ok(lift > 15, `lift on random walks fell to ${lift.toFixed(1)} points — the baseline needs re-measuring`);
  });
});
