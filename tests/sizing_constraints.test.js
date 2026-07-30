import { test, describe } from 'node:test';
import assert from 'node:assert';
import { sizeWithConstraints, SIZING_CAPS } from '../src/core/risk.js';

/**
 * Shannon's two worked examples from ch. 16, used as the fixtures — they are
 * the reason this function exists, and each one binds on a different
 * constraint.
 */
const EX1 = { account_size: 100000, risk_percent: 1, entry: 50, stop: 49.25 };
const EX2 = { account_size: 100000, risk_percent: 1, entry: 2.5, stop: 2.35, adv: 300000 };

describe('sizeWithConstraints — Shannon example 1, the 65% position', () => {
  test('the risk budget ALONE would buy 1,333 shares, two thirds of the account', () => {
    // The arithmetic that makes the point: 1000/0.75 = 1333.33 shares at $50 is
    // $66,666 on a $100,000 account. Shannon: "would you really want to commit
    // 65% of your trading capital to just one idea?"
    const naive = (100000 * 0.01) / Math.abs(50 - 49.25);
    assert.equal(Math.round(naive), 1333);
    assert.ok((naive * 50) / 100000 > 0.65);
  });

  test('the concentration cap binds instead, and is named', () => {
    const r = sizeWithConstraints(EX1);
    assert.equal(r.available, true);
    assert.equal(r.binding_constraint, 'concentration_cap');
    // 20% of 100000 = 20000 notional at $50 = 400 shares.
    assert.equal(r.shares, 400);
    assert.equal(r.notional, 20000);
    assert.equal(r.notional_pct_of_account, 20);
  });

  test('the suppressed size is REPORTED, not silently applied', () => {
    // Reporting a constraint is not applying it; applying it without saying so
    // is just as bad, because the caller cannot tell a cap from a small edge.
    const r = sizeWithConstraints(EX1);
    assert.equal(r.risk_budget_would_have_bought, 1333.3333);
    assert.ok(r.suppressed_shares > 900);
    assert.match(r.why, /65% of capital/);
  });

  test('actual risk taken falls BELOW the budget when a cap binds', () => {
    // 400 shares x 0.75 = $300, not the $1,000 budgeted. Someone reading only
    // "1% risk" would be wrong about the position in both directions.
    const r = sizeWithConstraints(EX1);
    assert.equal(r.risk_amount, 300);
    assert.equal(r.risk_pct_of_account, 0.3);
  });

  test('names the counterintuitive mechanism: a tighter stop buys MORE shares', () => {
    const r = sizeWithConstraints(EX1);
    assert.match(r.why, /TIGHTER stop buys MORE shares/);
    // And it is true: halving the stop distance doubles the risk-derived size.
    const tight = sizeWithConstraints({ ...EX1, stop: 49.625 });
    const wide = sizeWithConstraints({ ...EX1, stop: 48.5 });
    assert.ok(tight.risk_budget_would_have_bought > wide.risk_budget_would_have_bought * 2.5);
  });
});

describe('sizeWithConstraints — Shannon example 2, where liquidity binds', () => {
  test('the risk budget would buy 6,666 shares of a 300,000-ADV stock', () => {
    const naive = (100000 * 0.01) / Math.abs(2.5 - 2.35);
    assert.equal(Math.round(naive), 6667);
    // ~2.2% of ADV — Shannon: "would you feel comfortable buying 6,000 shares?"
    assert.ok((naive / 300000) * 100 > 2);
  });

  test('liquidity binds, not concentration', () => {
    const r = sizeWithConstraints(EX2);
    assert.equal(r.binding_constraint, 'liquidity');
    // 2% of 300,000 = 6,000 shares.
    assert.equal(r.shares, 6000);
    assert.equal(r.pct_of_adv, 2);
    assert.match(r.why, /average daily volume/);
    assert.match(r.why, /harder to exit than to enter/);
  });

  test('a deep-liquidity version of the same trade binds on risk instead', () => {
    // Same prices, 100x the volume: nothing else changes, and the answer does.
    const r = sizeWithConstraints({ ...EX2, adv: 30000000 });
    assert.equal(r.binding_constraint, 'risk_budget');
    assert.equal(r.risk_amount, 1000);
    assert.match(r.why, /tightest of the three/);
  });
});

describe('the constraint set', () => {
  test('returns every constraint with its own share count, sorted tightest first', () => {
    const r = sizeWithConstraints(EX2);
    assert.equal(r.constraints.length, 3);
    for (let i = 1; i < r.constraints.length; i += 1) {
      assert.ok(r.constraints[i].shares >= r.constraints[i - 1].shares);
    }
    assert.equal(r.constraints[0].binding, true);
    assert.equal(r.constraints.filter((c) => c.binding).length, 1);
  });

  test('every constraint states the limit it applied in words', () => {
    for (const c of sizeWithConstraints(EX2).constraints) {
      assert.ok(c.limit && c.limit.length > 10, `${c.name} has no readable limit`);
      assert.ok(Number.isFinite(c.notional));
    }
  });

  test('WITHOUT adv the liquidity constraint is UNCHECKED, not passed', () => {
    /**
     * The load-bearing honesty case. Dropping an unmeasurable constraint makes
     * the answer look fully validated when one third of it was never tested.
     */
    const r = sizeWithConstraints(EX1);
    assert.equal(r.constraints.length, 2);
    assert.ok(!r.constraints.some((c) => c.name === 'liquidity'));
    assert.match(r.liquidity_constraint, /NOT CHECKED/);
    assert.match(r.liquidity_constraint, /unknown, not satisfied/);
    assert.equal(r.pct_of_adv, undefined);
  });

  test('a zero or negative adv is treated as absent, not as a zero-share cap', () => {
    for (const adv of [0, -5, NaN, null]) {
      const r = sizeWithConstraints({ ...EX1, adv });
      assert.ok(r.shares > 0, `adv=${adv} produced ${r.shares} shares`);
      assert.match(r.liquidity_constraint, /NOT CHECKED/);
    }
  });
});

describe('caps and provenance', () => {
  test('the concentration cap default sits in Shannon\'s stated 15-20 band', () => {
    assert.ok(SIZING_CAPS.max_position_pct_default >= 15 && SIZING_CAPS.max_position_pct_default <= 20);
    assert.equal(SIZING_CAPS.risk_pct_default, 1);
    assert.equal(SIZING_CAPS.risk_pct_max, 2);
  });

  test('the ADV cap is labelled as OURS, because Shannon gives no number', () => {
    // Attributing our own parameter to a source is how an arbitrary choice
    // acquires false authority.
    assert.match(SIZING_CAPS.source, /this repo's choice/);
    assert.equal(sizeWithConstraints(EX2).caps_applied.max_adv_pct, 2);
  });

  test('caps are overridable and the override is echoed back', () => {
    const r = sizeWithConstraints({ ...EX1, max_position_pct: 15 });
    assert.equal(r.caps_applied.max_position_pct, 15);
    assert.equal(r.shares, 300); // 15% of 100k / $50
  });

  test('every result says it is arithmetic, not advice', () => {
    assert.match(sizeWithConstraints(EX1).note, /Not advice/);
    assert.match(sizeWithConstraints(EX1).note, /MINIMUM/);
  });
});

describe('shorts and bad input', () => {
  test('a short reads direction from entry versus stop', () => {
    const r = sizeWithConstraints({ account_size: 100000, entry: 50, stop: 51, risk_percent: 1 });
    assert.equal(r.direction, 'short');
    assert.equal(r.risk_per_share, 1);
  });

  test('entry equal to stop is undefined size, not Infinity shares', () => {
    const r = sizeWithConstraints({ account_size: 100000, entry: 50, stop: 50 });
    assert.equal(r.available, false);
    assert.match(r.note, /risk per share is zero/);
  });

  test('rejects nonsense inputs rather than returning a number', () => {
    for (const bad of [
      { account_size: 0, entry: 50, stop: 49 },
      { account_size: 100000, entry: 0, stop: 49 },
      { account_size: 100000, entry: 50, stop: 0 },
      { account_size: 100000, entry: 50, stop: 49, risk_percent: 0 },
      { account_size: 100000, entry: 50, stop: 49, risk_percent: 101 },
    ]) {
      assert.equal(sizeWithConstraints(bad).available, false, JSON.stringify(bad));
    }
  });

  test('shares_rounded floors, so rounding can never exceed a cap', () => {
    const r = sizeWithConstraints({ account_size: 10000, entry: 33.33, stop: 32, risk_percent: 1 });
    assert.ok(r.shares_rounded <= r.shares);
    assert.equal(r.shares_rounded, Math.floor(r.shares));
  });
});
